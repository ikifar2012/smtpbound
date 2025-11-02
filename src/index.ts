import 'dotenv/config'
import { SMTPServer } from 'smtp-server'
import type { SMTPServerSession, SMTPServerDataStream, SMTPServerAuthentication } from 'smtp-server'
import { simpleParser } from 'mailparser'
import type { ParsedMail, AddressObject } from 'mailparser'
import { Inbound } from '@inboundemail/sdk'
import { readFileSync } from 'node:fs'

// Config
const SMTP_PORT = Number(process.env.SMTP_PORT ?? 25)
const SMTP_HOST = process.env.SMTP_HOST ?? '0.0.0.0'
const INBOUND_API_KEY = process.env.INBOUND_API_KEY
const DEFAULT_FROM = process.env.DEFAULT_FROM // optional override if envelope lacks From header
const SMTP_SECURE = process.env.SMTP_SECURE === 'true' // if true, SMTPS (implicit TLS)
const TLS_KEY_PATH = process.env.TLS_KEY_PATH
const TLS_CERT_PATH = process.env.TLS_CERT_PATH
const TLS_MIN_VERSION = process.env.TLS_MIN_VERSION // e.g., TLSv1.2

// AUTH configuration
const SMTP_AUTH_ENABLED = process.env.SMTP_AUTH_ENABLED === 'true'
const SMTP_AUTH_USER = process.env.SMTP_AUTH_USER
const SMTP_AUTH_PASS = process.env.SMTP_AUTH_PASS
const SMTP_AUTH_ALLOW_INSECURE = process.env.SMTP_AUTH_ALLOW_INSECURE === 'true'
// If true, treat upstream TLS terminated by a trusted reverse proxy as satisfying the TLS requirement for AUTH
const SMTP_TRUST_PROXY_TLS = process.env.SMTP_TRUST_PROXY_TLS === 'true'

if (!INBOUND_API_KEY) {
  console.error('Missing INBOUND_API_KEY in environment. Set it in .env')
  process.exit(1)
}

const inbound = new Inbound(INBOUND_API_KEY)

// Utility to convert parsed attachments to Inbound SDK format
function mapAttachments(mail: ParsedMail): Array<{
  filename: string
  content: string
  contentType?: string
  content_id?: string
}> | undefined {
  if (!mail.attachments?.length) return undefined
  return mail.attachments.map((att) => ({
    filename: att.filename || 'attachment',
    content: att.content.toString('base64'),
    contentType: att.contentType,
    content_id: att.cid ?? undefined,
  }))
}

// Convert AddressObject | AddressObject[] into array of formatted address strings
function addressList(
  input?: AddressObject | AddressObject[]
): string[] | undefined {
  if (!input) return undefined
  const list: string[] = []
  const objs = Array.isArray(input) ? input : [input]
  for (const obj of objs) {
    for (const v of obj.value) {
      const addr = v.address ?? ''
      const formatted = v.name ? `${v.name} <${addr}>` : addr
      if (formatted) list.push(formatted)
    }
  }
  return list.length ? list : undefined
}

function firstAddress(input?: AddressObject | AddressObject[]): string | undefined {
  const list = addressList(input)
  return list?.[0]
}

// Create SMTP server
const tlsConfigured = Boolean(TLS_KEY_PATH && TLS_CERT_PATH)

// Validate environment and configuration
if (SMTP_AUTH_ENABLED) {
  // When auth is enabled, it is always required
  if (!SMTP_AUTH_USER || !SMTP_AUTH_PASS) {
    console.error('SMTP_AUTH_ENABLED is true, but SMTP_AUTH_USER/SMTP_AUTH_PASS are not set')
    process.exit(1)
  }
  if (!SMTP_AUTH_ALLOW_INSECURE && !SMTP_SECURE && !tlsConfigured && !SMTP_TRUST_PROXY_TLS) {
    console.error(
      'SMTP_AUTH_ENABLED requires TLS when SMTP_AUTH_ALLOW_INSECURE=false. Provide TLS_KEY_PATH/TLS_CERT_PATH for STARTTLS, set SMTP_SECURE=true for SMTPS, or set SMTP_TRUST_PROXY_TLS=true when terminating TLS at a trusted reverse proxy.'
    )
    process.exit(1)
  }
}

// Compute which commands to disable based on config
const disabledCommands: string[] = []
if (!tlsConfigured && !SMTP_SECURE) disabledCommands.push('STARTTLS')
if (!SMTP_AUTH_ENABLED) disabledCommands.push('AUTH')

// Log configuration summary at startup for easier ops/debugging
console.log('[smtpbound] configuration summary:', {
  host: SMTP_HOST,
  port: SMTP_PORT,
  mode: SMTP_SECURE ? 'SMTPS (implicit TLS)' : (tlsConfigured ? 'SMTP with STARTTLS' : 'SMTP plaintext'),
  tlsConfigured,
  tlsMinVersion: TLS_MIN_VERSION || 'default',
  authEnabled: SMTP_AUTH_ENABLED,
  authRequiresTLS: SMTP_AUTH_ENABLED ? !SMTP_AUTH_ALLOW_INSECURE : undefined,
  trustProxyTLS: SMTP_TRUST_PROXY_TLS,
  disabledCommands,
})

const server = new SMTPServer({
  secure: SMTP_SECURE,
  // If certs are provided, enable STARTTLS (when secure=false) or use them for SMTPS (secure=true)
  ...(tlsConfigured
    ? {
        key: readFileSync(TLS_KEY_PATH!),
        cert: readFileSync(TLS_CERT_PATH!),
        tls: TLS_MIN_VERSION ? { minVersion: TLS_MIN_VERSION as any } : undefined,
      }
    : {}),
  disabledCommands,
  // If auth is enabled, require it; otherwise, allow unauthenticated use
  authOptional: !SMTP_AUTH_ENABLED,
  onConnect(session: SMTPServerSession, callback) {
    try {
      console.log('[smtpbound] client connected', {
        id: session.id,
        remoteAddress: session.remoteAddress,
        clientHostname: (session as any).clientHostname,
        secure: session.secure,
      })
    } catch (e) {
      // ignore logging issues
    }
    callback()
  },
  onClose(session: SMTPServerSession) {
    try {
      console.log('[smtpbound] client disconnected', {
        id: session.id,
        remoteAddress: session.remoteAddress,
        secure: session.secure,
      })
    } catch (e) {
      // ignore logging issues
    }
  },
  onAuth(auth: SMTPServerAuthentication, session: SMTPServerSession, callback) {
    if (!SMTP_AUTH_ENABLED) {
      return callback(new Error('Authentication disabled'))
    }
    if (!SMTP_AUTH_ALLOW_INSECURE && !(session.secure || SMTP_TRUST_PROXY_TLS)) {
      return callback(new Error('Must use TLS (STARTTLS/SMTPS) for authentication'))
    }
    if (!SMTP_AUTH_USER || !SMTP_AUTH_PASS) {
      return callback(new Error('Server auth not configured'))
    }
    const { username, password } = auth
    if (username === SMTP_AUTH_USER && password === SMTP_AUTH_PASS) {
      return callback(null, { user: SMTP_AUTH_USER })
    }
    return callback(new Error('Invalid username or password'))
  },
  onData(stream: SMTPServerDataStream, session: SMTPServerSession, callback) {
    const chunks: Buffer[] = []
    stream.on('data', (chunk) => chunks.push(chunk))
    stream.on('end', async () => {
      try {
        const raw = Buffer.concat(chunks)
  const mail = await simpleParser(raw)

        const envelopeFrom = typeof session.envelope.mailFrom === 'object' && session.envelope.mailFrom
          ? session.envelope.mailFrom.address
          : undefined
        const fromHeader = firstAddress(mail.from) || DEFAULT_FROM || envelopeFrom
  const toList = addressList(mail.to) || session.envelope.rcptTo?.map((r) => r.address)

        if (!fromHeader) {
          throw new Error('Missing From header and DEFAULT_FROM not set')
        }
        if (!toList || toList.length === 0) {
          throw new Error('Missing To header and no RCPT TO addresses')
        }

        // Prepare payload for Inbound send API (Resend-compatible)
        const payload = {
          from: fromHeader,
          to: toList,
          subject: mail.subject || '(no subject)',
          html: typeof mail.html === 'string' ? mail.html : undefined,
          text: mail.text || undefined,
          cc: addressList(mail.cc),
          bcc: addressList(mail.bcc),
          replyTo: addressList(mail.replyTo),
          headers: mail.headerLines?.reduce<Record<string, string>>((acc, h) => {
            acc[h.key] = h.line
            return acc
          }, {}),
          attachments: mapAttachments(mail),
        }

        const { data, error } = await inbound.emails.send(payload as any)
        if (error) {
          console.error('Inbound send error:', error)
          callback(new Error('Failed to forward email to Inbound'))
          return
        }

        console.log('Forwarded email to Inbound:', {
          id: data?.id,
          messageId: data?.messageId,
          from: payload.from,
          to: payload.to,
          subject: payload.subject,
        })

        callback()
      } catch (err) {
        console.error('Error processing email:', err)
        callback(new Error('Error processing email'))
      }
    })
  },
})

server.listen(SMTP_PORT, SMTP_HOST, () => {
  console.log(`SMTP bridge listening on ${SMTP_HOST}:${SMTP_PORT}`)
})

import 'dotenv/config'
import { SMTPServer } from 'smtp-server'
import type { SMTPServerSession, SMTPServerDataStream, SMTPServerAuthentication } from 'smtp-server'
import { simpleParser } from 'mailparser'
import type { ParsedMail, AddressObject } from 'mailparser'
import { Inbound } from '@inboundemail/sdk'
import fs from 'node:fs'

// Config
const SMTP_SECURE = process.env.SMTP_SECURE === 'true'
const TLS_CERT_PATH = process.env.TLS_CERT_PATH
const TLS_KEY_PATH = process.env.TLS_KEY_PATH
const TLS_CA_PATH = process.env.TLS_CA_PATH
const DEFAULT_SMTP_PORT = SMTP_SECURE ? 465 : 25
const SMTP_PORT = Number(process.env.SMTP_PORT ?? DEFAULT_SMTP_PORT)
const SMTP_HOST = process.env.SMTP_HOST ?? '0.0.0.0'
const INBOUND_API_KEY = process.env.INBOUND_API_KEY
const DEFAULT_FROM = process.env.DEFAULT_FROM // optional override if envelope lacks From header
const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase()

// AUTH configuration
const SMTP_AUTH_ENABLED = process.env.SMTP_AUTH_ENABLED === 'true'
const SMTP_AUTH_USER = process.env.SMTP_AUTH_USER
const SMTP_AUTH_PASS = process.env.SMTP_AUTH_PASS

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

// Validate environment and configuration
if (SMTP_AUTH_ENABLED) {
  // When auth is enabled, it is always required
  if (!SMTP_AUTH_USER || !SMTP_AUTH_PASS) {
    console.error('SMTP_AUTH_ENABLED is true, but SMTP_AUTH_USER/SMTP_AUTH_PASS are not set')
    process.exit(1)
  }
}

// Compute which commands to disable based on config
const disabledCommands: string[] = []
// We don't support STARTTLS upgrade path in this service; use implicit TLS when SMTP_SECURE=true
disabledCommands.push('STARTTLS')
if (!SMTP_AUTH_ENABLED) disabledCommands.push('AUTH')

// Log configuration summary at startup for easier ops/debugging
console.log('[smtpbound] configuration summary:', {
  host: SMTP_HOST,
  port: SMTP_PORT,
  mode: SMTP_SECURE ? 'SMTPS (implicit TLS)' : 'SMTP plaintext',
  authEnabled: SMTP_AUTH_ENABLED,
  tlsCert: SMTP_SECURE ? (TLS_CERT_PATH || '<missing>') : '<n/a>',
  tlsKey: SMTP_SECURE ? (TLS_KEY_PATH || '<missing>') : '<n/a>',
  defaultFrom: DEFAULT_FROM ? '<set>' : '<unset>',
  disabledCommands,
})

// Helper: create SMTP error with response code (defaults to 451 temporary failure)
function smtpError(message: string, code = 451): Error {
  const err = new Error(message)
  ;(err as any).responseCode = code
  return err
}

function toSafeJSON(obj: unknown) {
  try {
    return JSON.parse(
      JSON.stringify(
        obj,
        (_, v) => (v instanceof Buffer ? `<Buffer:${v.length}>` : v)
      )
    )
  } catch {
    return String(obj)
  }
}

function classifySendFailure(err: any): { code: number; reason: string; meta?: Record<string, any> } {
  const status: number | undefined = err?.status || err?.statusCode || err?.response?.status
  const name: string | undefined = err?.name
  const code: string | number | undefined = err?.code
  const message: string = err?.message || String(err)
  const responseData = err?.data || err?.response?.data || err?.errors || undefined
  const meta = {
    status,
    name,
    code,
    message,
    data: responseData ? toSafeJSON(responseData) : undefined,
  }

  // Map HTTP-ish statuses to SMTP response codes
  // - 5xx => 451 (temporary)
  // - 429 => 451 (rate limit, temporary)
  // - 4xx => 550 (permanent)
  // - fallback => 451
  if (status === 429) return { code: 451, reason: 'Rate limited by upstream', meta }
  if (typeof status === 'number') {
    if (status >= 500) return { code: 451, reason: 'Upstream server error', meta }
    if (status >= 400) return { code: 550, reason: 'Upstream rejected request', meta }
  }
  return { code: 451, reason: 'Unknown upstream failure', meta }
}

// Load TLS materials if secure mode is enabled
let tlsKey: Buffer | undefined
let tlsCert: Buffer | undefined
let tlsCa: Buffer | undefined
if (SMTP_SECURE) {
  if (!TLS_CERT_PATH || !TLS_KEY_PATH) {
    console.error('SMTP_SECURE is true but TLS_CERT_PATH/TLS_KEY_PATH are not set')
    process.exit(1)
  }
  try {
    tlsCert = fs.readFileSync(TLS_CERT_PATH)
    tlsKey = fs.readFileSync(TLS_KEY_PATH)
    if (TLS_CA_PATH) {
      try {
        tlsCa = fs.readFileSync(TLS_CA_PATH)
      } catch (e) {
        console.warn('Could not read TLS_CA_PATH; continuing without custom CA:', TLS_CA_PATH)
      }
    }
  } catch (e) {
    console.error('Failed to read TLS certificate or key:', e)
    process.exit(1)
  }
}

const server = new SMTPServer({
  secure: SMTP_SECURE,
  // Provide TLS materials in secure mode
  ...(SMTP_SECURE ? { key: tlsKey, cert: tlsCert, ca: tlsCa } : {}),
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
          // Build simple string headers object per Inbound API expectations
          // Exclude standard/system headers to avoid duplicates (Date, From, To, Subject, etc.)
          headers: (() => {
            const out: Record<string, string> = {}
            const DISALLOWED = new Set<string>([
              'date',
              'from',
              'to',
              'cc',
              'bcc',
              'subject',
              'reply-to',
              'reply_to',
              'message-id',
              'messageid',
              'mime-version',
              'content-type',
              'content-transfer-encoding',
              'content-disposition',
              'content-id',
              'return-path',
              'sender',
              'delivered-to',
              'received',
              'authentication-results',
              'dkim-signature',
              'arc-seal',
              'arc-message-signature',
              'arc-authentication-results',
            ])
            try {
              for (const [rawKey, value] of mail.headers) {
                const key = String(rawKey)
                const lc = key.toLowerCase()
                if (DISALLOWED.has(lc)) continue
                if (value == null) continue
                // Normalize various header value shapes to string
                const str = Array.isArray(value)
                  ? value.map((v) => (typeof v === 'string' ? v : (v as any)?.text ?? (v as any)?.value ?? String(v))).join(', ')
                  : typeof value === 'string'
                    ? value
                    : (value as any)?.text ?? (value as any)?.value ?? String(value)
                if (str && typeof str === 'string') out[key] = str
              }
            } catch {
              // ignore header mapping issues
            }
            return Object.keys(out).length ? out : undefined
          })(),
          attachments: mapAttachments(mail),
        }

        const { data, error } = await inbound.emails.send(payload as any)
        if (error) {
          const failure = classifySendFailure(error)
          if (LOG_LEVEL !== 'silent') {
            console.error('Inbound send error:', {
              remoteAddress: session.remoteAddress,
              to: payload.to,
              from: payload.from,
              subject: payload.subject,
              failure,
            })
          }
          callback(smtpError(`Failed to send email via Inbound: ${failure.reason}`, failure.code))
          return
        }

        console.log('Forwarded email to Inbound:', {
          remoteAddress: session.remoteAddress,
          id: data?.id,
          messageId: data?.messageId,
          from: payload.from,
          to: payload.to,
          subject: payload.subject,
        })

        callback()
      } catch (err: any) {
        if (LOG_LEVEL !== 'silent') {
          console.error('Error processing email:', toSafeJSON(err))
        }
        callback(smtpError('Error processing email', 451))
      }
    })
  },
})

server.listen(SMTP_PORT, SMTP_HOST, () => {
  console.log(`SMTP bridge listening on ${SMTP_HOST}:${SMTP_PORT}`)
})

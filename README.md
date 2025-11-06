# smtpbound — SMTP to Inbound bridge

Expose a lightweight SMTP server that receives emails and forwards them to Inbound using `@inboundemail/sdk`. Ideal when a system can only send via SMTP but you want to process, route, or fan-out via Inbound.

> Disclaimer: Community-maintained. Not affiliated with Inbound/inbound.new. Code is AI-generated; use at your own risk.

## What it does

- Listens on SMTP (port 25 by default)
- Optionally serves SMTPS (implicit TLS on 465) when provided with a certificate
- Parses MIME (including attachments) and forwards via Inbound Emails API
- Configured entirely via environment variables (`.env`)

Docs reference:
- https://docs.inbound.new/
- https://docs.inbound.new/api-reference/emails/send-email

## Prerequisites

- Inbound API key (required)
- One of:
    - Node.js 20+ and pnpm, for local dev
    - Docker and Docker Compose, for containerized run

## Quick start (local)

1) Install deps

```bash
pnpm install
```

2) Configure environment

```bash
cp .env.example .env
```

Edit `.env` and set at minimum:
- INBOUND_API_KEY=<your key>
- Optionally DEFAULT_FROM, LOG_LEVEL

3) Run

```bash
pnpm dev
```

You should see: `SMTP bridge listening on <host>:<port>`.

4) Test (example with swaks)

```bash
swaks --server 127.0.0.1:25 \
    --from "Tester <agent@inbnd.dev>" \
    --to you@yourdomain.tld \
    --header "Subject: Hello via smtpbound" \
    --body "Hello!"
```

## Docker / Compose

1) Create and edit env

```bash
cp .env.example .env
```

Set `INBOUND_API_KEY` and any optional vars (see below). Then:

```bash
docker compose up --build
```

Defaults expose SMTP on `25`:

```yaml
services:
    smtpbound:
        image: ghcr.io/ikifar2012/smtpbound:main
        env_file:
            - .env
        ports:
            - "25:25"
        cap_add:
            - NET_BIND_SERVICE
        restart: unless-stopped
        volumes:
            - ./secrets/certs:/certs
```

### Enabling TLS (SMTPS on 465)

This service does not support STARTTLS. To use TLS, enable implicit TLS (SMTPS):

1) Provide certs inside the container (e.g. mount `./secrets/certs` to `/certs`).
2) In `.env`, set:
     - `SMTP_SECURE=true`
     - `TLS_CERT_PATH=/certs/fullchain.pem`
     - `TLS_KEY_PATH=/certs/privkey.pem`
     - optionally `SMTP_PORT=465`
3) Expose port 465 in compose:

```yaml
services:
    smtpbound:
        ports:
            - "25:25"
            - "465:465"
```

Quick checks:

```bash
openssl s_client -connect 127.0.0.1:465 -quiet
```

Optional: a Certbot helper service is included in `docker-compose.yml` (profile `certbot`). It persists issued certificates under `./secrets` and can be wired to your web server or DNS provider. Exact issuance steps depend on your environment (HTTP-01 via a web server serving `./secrets/webroot`, or DNS-01 via plugins). Once issued, point `TLS_CERT_PATH`/`TLS_KEY_PATH` at the mounted files and restart.

## SMTP AUTH

- Disabled by default
- Enable by setting `SMTP_AUTH_ENABLED=true`
- Provide credentials via `SMTP_AUTH_USER` and `SMTP_AUTH_PASS`

## Configuration reference

See `.env.example` for all options.

Required:
- `INBOUND_API_KEY`

Common:
- `SMTP_HOST` (default `0.0.0.0`)
- `SMTP_PORT` (25 by default; 465 when `SMTP_SECURE=true`)
- `SMTP_SECURE` (`false` | `true` for implicit TLS)
- `TLS_CERT_PATH`, `TLS_KEY_PATH` (required when `SMTP_SECURE=true`)
- `DEFAULT_FROM` (used if message lacks From)
- `LOG_LEVEL` (`info` | `silent`)
- `SMTP_AUTH_ENABLED`, `SMTP_AUTH_USER`, `SMTP_AUTH_PASS`

## Troubleshooting

- 401 Unauthorized: Invalid or missing `INBOUND_API_KEY`.
- 403 Domain not owned: `from` domain isn’t verified in Inbound. Use a verified domain or `agent@inbnd.dev` for quick tests.
- 429 Rate limited: Temporary failure; the server returns SMTP 451. Retry later.
- 400 Invalid request: Missing required fields or invalid recipients.

On errors, the server logs structured details and maps upstream failures to reasonable SMTP status codes.

## License

MIT

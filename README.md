# smtpbound — SMTP/SMTPS to Inbound bridge

This service exposes a local SMTP server and forwards received messages to [Inbound](https://inbound.new/) using their API/SDK. Use it when your systems only speak SMTP but you want to process or route mail via Inbound.

> Disclaimer: This project is community-maintained and is not affiliated with, endorsed by, or sponsored by Inbound, inbound.new, or their owners. This code is entirely AI-generated and may contain bugs; use at your own risk.

## Features

- Lightweight Node.js SMTP listener
- Optional built-in SMTPS (implicit TLS on 465)
- Parses MIME with attachments and forwards to Inbound `emails.send`
- Simple configuration via environment variables (`.env`)

## Compatibility with Inbound docs

This service uses the official SDK `@inboundemail/sdk` and follows the Send Email API:
- Base docs: https://docs.inbound.new/
- API reference: https://docs.inbound.new/api-reference/emails/send-email

Key points from the docs applied here:
- from must use a verified domain in your Inbound account. 
- to/cc/bcc accept strings or arrays of strings. Combined recipients should not exceed 50.
- Both reply_to (snake_case) and replyTo (camelCase) are supported. We set `replyTo`.
- attachments accept Base64 `content` or a remote `path`, with either `contentType` or `content_type`. We use Base64 `content`, `contentType`, and optional `content_id`.
- Custom headers are provided as a string map.
- Rate limiting (HTTP 429) and domain ownership (HTTP 403) are mapped to appropriate SMTP response codes.

## Quick start (local dev)

1) Install dependencies

```bash
pnpm install
```

2) Create an env file

```bash
cp .env.example .env
```

Edit `.env` and set at least:
- `INBOUND_API_KEY` — your Inbound API key
- Optionally set `DEFAULT_FROM` if incoming mail lacks a From header
- Optionally set `LOG_LEVEL=info` (default) or `silent`

3) Run in dev

```bash
pnpm dev
```

When it starts you should see: `SMTP bridge listening on 0.0.0.0:<port>`.

4) Send a test email via SMTP (example with `swaks`)

```bash
swaks --server 127.0.0.1:25 \
    --from "Tester <agent@inbnd.dev>" \
    --to youremail@inbound.new \
    --header "Subject: Hello via bridge" \
    --body "Hello from smtpbound!"
```

You should see a log with the Inbound `id` and `messageId`.

## TLS (built-in SMTPS)

To enable TLS without a reverse proxy, use implicit TLS mode:

1) Set in `.env`:
     - `SMTP_SECURE=true`
     - `TLS_CERT_PATH=/path/to/fullchain.pem`
     - `TLS_KEY_PATH=/path/to/privkey.pem`
     When `SMTP_SECURE=true`, default port becomes `465` (override with `SMTP_PORT` if needed).

2) Test TLS endpoint locally:
```bash
openssl s_client -connect 127.0.0.1:465 -quiet
```

3) Send with implicit TLS:
```bash
swaks --server 127.0.0.1 --port 465 --tls-on-connect \
    --from "Tester <agent@inbnd.dev>" \
    --to youremail@inbound.new \
    --header "Subject: Hello via SMTPS" \
    --body "Hello from smtpbound with built-in TLS!"
```

## Docker / Compose

1) Create your environment file

```bash
cp .env.example .env
```

Edit `.env`:
- Set `INBOUND_API_KEY`
- If enabling auth, set `SMTP_AUTH_ENABLED=true` and configure `SMTP_AUTH_USER`/`SMTP_AUTH_PASS`

2) Build and run

```bash
docker compose up --build
```

By default, the SMTP server will be available on port `25`.

To expose SMTPS via Docker as well, add a second port mapping:

```yaml
services:
    smtpbound:
        image: ghcr.io/ikifar2012/smtpbound:main
        env_file:
            - .env
        ports:
            - "25:25"
            - "465:465" # expose built-in SMTPS
        cap_add:
            - NET_BIND_SERVICE
        restart: unless-stopped
```

## SMTP AUTH

- Off by default. Enable with `SMTP_AUTH_ENABLED=true`
- When enabled, authentication is required for all clients
- Configure `SMTP_AUTH_USER` and `SMTP_AUTH_PASS`
- When using a reverse proxy for TLS, the connection from the proxy to `smtpbound` is plaintext, but the client-to-proxy connection is secure.

## Configuration

See `.env.example` for all variables and Docker-focused defaults.

Variables:
- INBOUND_API_KEY (required)
- SMTP_HOST, SMTP_PORT
- DEFAULT_FROM (optional)
- LOG_LEVEL (info|silent)
- SMTP_AUTH_ENABLED, SMTP_AUTH_USER, SMTP_AUTH_PASS (optional)

## Troubleshooting

Common causes per Inbound docs:
- 401 Unauthorized: Invalid or missing INBOUND_API_KEY.
- 403 Domain Not Owned: The `from` domain is not verified in your Inbound account. Use a verified domain or `agent@inbnd.dev` for basic testing.
- 429 Rate Limited: You hit plan rate limits. Try again later; the bridge returns temporary SMTP failure (451).
- 400 Invalid Request: Missing required fields (from/to/subject) or invalid recipients.

When a send fails, this service logs structured details (status, message, and upstream data when available) and returns an appropriate SMTP status code to the client.

## License

MIT

# smtpbound — SMTP to Inbound bridge

This service exposes a local SMTP server and forwards received messages to [Inbound](https://inbound.new/) using their API/SDK. Use it when your systems only speak SMTP but you want to process or route mail via Inbound.

> Disclaimer: This project is community-maintained and is not affiliated with, endorsed by, or sponsored by Inbound, inbound.new, or their owners. This code is entirely AI-generated and may contain bugs; use at your own risk.

## Features

- Lightweight Node.js SMTP listener (no TLS/AUTH by default)
- Parses MIME with attachments and forwards to Inbound `emails.send`
- Simple configuration via environment variables (`.env`)

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

## Docker / Compose

1) Create your environment file

```bash
cp .env.example .env
```

Edit `.env`:
- Set `INBOUND_API_KEY`
- Choose TLS mode:
  - STARTTLS: keep `SMTP_SECURE=false` (default) and set `SMTP_PORT` (25 is typical)
  - SMTPS on 465: set `SMTP_SECURE=true`, `SMTP_PORT=465`
- If using TLS, set `TLS_KEY_PATH` and `TLS_CERT_PATH`. The example uses `/certs/...` so mount your certs:

docker-compose.yml (add a volume under the `smtpbound` service):

```yaml
volumes:
  - /local/certs:/certs:ro
```

2) Build and run

```bash
docker compose up --build
```

- For STARTTLS, keep the default port mapping `25:25`.
- For SMTPS, change the service ports to `465:465`.

## TLS and SMTP AUTH

TLS
- Plaintext (no TLS): set `SMTP_SECURE=false` and do not set `TLS_KEY_PATH`/`TLS_CERT_PATH`. In this mode, STARTTLS is not offered and connections are plaintext.
- STARTTLS (when `SMTP_SECURE=false`): on the configured `SMTP_PORT` (default 25). Provide `TLS_KEY_PATH` and `TLS_CERT_PATH` and the server will advertise STARTTLS.
- SMTPS (on 465): set `SMTP_SECURE=true` and keep the same cert envs
- Optional: enforce a minimum TLS version, e.g. `TLS_MIN_VERSION=TLSv1.2`

SMTP AUTH
- Off by default. Enable with `SMTP_AUTH_ENABLED=true`
- When enabled, authentication is required for all clients
- Configure `SMTP_AUTH_USER` and `SMTP_AUTH_PASS`
- If `SMTP_AUTH_ALLOW_INSECURE=false` (recommended), AUTH is only accepted over TLS (after STARTTLS or on SMTPS)

## Configuration

See `.env.example` for all variables and Docker-focused defaults.

## License

MIT

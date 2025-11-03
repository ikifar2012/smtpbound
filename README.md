# smtpbound — SMTP to Inbound bridge

This service exposes a local SMTP server and forwards received messages to [Inbound](https://inbound.new/) using their API/SDK. Use it when your systems only speak SMTP but you want to process or route mail via Inbound.

> Disclaimer: This project is community-maintained and is not affiliated with, endorsed by, or sponsored by Inbound, inbound.new, or their owners. This code is entirely AI-generated and may contain bugs; use at your own risk.

## Features

- Lightweight Node.js SMTP listener (no TLS/AUTH by default)
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

## Reverse Proxy with Nginx (for TLS)

This service is designed to run behind a reverse proxy that handles TLS termination. The recommended approach is to use Nginx with the `ngx_stream_core_module` for simple and efficient TCP proxying.

Here is a simplified example for proxying SMTPS (port 465) traffic.

1.  **Add a `stream` block to your `nginx.conf`:**

    This block should be at the top level of your configuration, alongside the `http` block if you have one.

    ```nginx
    stream {
        # Define an upstream server for the smtpbound service
        upstream smtpbound {
            # Assumes smtpbound is running on the same machine on port 25.
            # If it's in a Docker container, use the container's name and port.
            # example: server smtpbound:25;
            server 127.0.0.1:25;
        }

        # This server handles incoming SMTPS (implicit TLS) connections
        server {
            listen 465 ssl;

            # Proxy the connection to the smtpbound service
            proxy_pass smtpbound;

            # --- SSL/TLS Configuration ---
            # Replace with your certificate paths
            ssl_certificate /path/to/your/fullchain.pem;
            ssl_certificate_key /path/to/your/privkey.pem;

            # Recommended modern SSL settings
            ssl_protocols TLSv1.2 TLSv1.3;
            ssl_ciphers HIGH:!aNULL:!MD5;
        }
    }
    ```

2.  **Ensure `smtpbound` is running** and accessible from Nginx at the address specified in the `upstream` block.

3.  **Configure your DNS** to point an `MX` record to your Nginx server.

This setup allows Nginx to terminate the TLS connection and forward the plaintext SMTP traffic to `smtpbound`.

> **Note on STARTTLS (Port 587):**
>
> Proxying STARTTLS is more complex because the connection starts in plaintext and is upgraded to TLS. This requires Nginx to understand the SMTP protocol, which is handled by the `ngx_mail_core_module` and is more complex to configure. For simplicity, we recommend using SMTPS (port 465).

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

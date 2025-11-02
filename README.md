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

## License

MIT

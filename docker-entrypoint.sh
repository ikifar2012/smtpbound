#!/usr/bin/env bash
set -euo pipefail

# Minimal entrypoint that assumes certificates are managed outside the container
# (for example via acme.sh deploy-hook docker). Certificates are expected to be
# copied into /certs and reloaded by sending SIGHUP to PID 1.

CERT_DIR=${CERT_DIR:-/certs}
TLS_DEFAULT_CERT=${TLS_CERT_PATH:-}
TLS_DEFAULT_KEY=${TLS_KEY_PATH:-}

if [[ "${SMTP_SECURE:-false}" == "true" ]]; then
  mkdir -p "$CERT_DIR"

  if [[ -z "$TLS_DEFAULT_CERT" ]]; then
    TLS_DEFAULT_CERT="$CERT_DIR/fullchain.pem"
    export TLS_CERT_PATH="$TLS_DEFAULT_CERT"
  fi

  if [[ -z "$TLS_DEFAULT_KEY" ]]; then
    TLS_DEFAULT_KEY="$CERT_DIR/privkey.pem"
    export TLS_KEY_PATH="$TLS_DEFAULT_KEY"
  fi

  if [[ ! -f "$TLS_DEFAULT_CERT" || ! -f "$TLS_DEFAULT_KEY" ]]; then
    echo "[entrypoint][warn] SMTP_SECURE=true but TLS cert/key not found yet at $TLS_DEFAULT_CERT / $TLS_DEFAULT_KEY" >&2
    echo "[entrypoint][warn] Waiting up to ${TLS_WAIT_TIMEOUT_SECONDS:-60}s for certificates" >&2
    end_time=$(( $(date +%s) + ${TLS_WAIT_TIMEOUT_SECONDS:-60} ))
    while [[ $(date +%s) -lt $end_time ]]; do
      if [[ -f "$TLS_DEFAULT_CERT" && -f "$TLS_DEFAULT_KEY" ]]; then
        break
      fi
      sleep 2
    done
    if [[ ! -f "$TLS_DEFAULT_CERT" || ! -f "$TLS_DEFAULT_KEY" ]]; then
      echo "[entrypoint][warn] TLS files still missing; the application will exit if it cannot read them" >&2
    fi
  fi
fi

exec node dist/index.js

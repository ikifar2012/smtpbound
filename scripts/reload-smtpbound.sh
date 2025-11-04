#!/usr/bin/env bash
set -euo pipefail

# Reload TLS certificates by sending SIGHUP to the main smtpbound process (PID 1).
# acme.sh deploy-hook docker executes this script inside the container after
# copying new certs. The application listens for SIGHUP and reloads TLS context.

TARGET_PID=${1:-1}

if ! kill -0 "$TARGET_PID" 2>/dev/null; then
  echo "[reload] process $TARGET_PID not running" >&2
  exit 1
fi

kill -HUP "$TARGET_PID"

echo "[reload] sent SIGHUP to PID $TARGET_PID"

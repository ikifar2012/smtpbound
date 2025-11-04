#!/usr/bin/env bash
set -euo pipefail

# Minimal entrypoint to optionally issue/renew TLS certs via acme.sh (DNS validation)
# and then start the app. Certs are written to /certs. acme config lives in /acme.

ACME_ENABLED=${ACME_ENABLED:-false}
ACME_HOME=${ACME_HOME:-/acme}
CERT_DIR=${CERT_DIR:-/certs}
ACME_SERVER=${ACME_SERVER:-letsencrypt}   # letsencrypt | zerossl | buypass | google
ACME_STAGING=${ACME_STAGING:-false}       # only meaningful for letsencrypt
ACME_EMAIL=${ACME_EMAIL:-}
ACME_DNS_PROVIDER=${ACME_DNS_PROVIDER:-}  # e.g., dns_cf, dns_aws, dns_dynu, etc.
ACME_DOMAINS_RAW=${ACME_DOMAINS:-}        # comma or space-separated list
ACME_KEYLENGTH=${ACME_KEYLENGTH:-2048}    # rsa bits or use 'ec-256' with --ecc (not default)
ACME_RENEW_DAYS=${ACME_RENEW_DAYS:-30}
ACME_EAB_KID=${ACME_EAB_KID:-}
ACME_EAB_HMAC_KEY=${ACME_EAB_HMAC_KEY:-}

# Rate limit guards
ACME_MIN_ISSUE_INTERVAL_HOURS=${ACME_MIN_ISSUE_INTERVAL_HOURS:-24}
ACME_COOLDOWN_HOURS_ON_FAILURE=${ACME_COOLDOWN_HOURS_ON_FAILURE:-6}

NODE_CMD=("node" "dist/index.js")

log() { echo "[entrypoint] $*"; }
warn() { echo "[entrypoint][warn] $*" >&2; }
err() { echo "[entrypoint][error] $*" >&2; }

ensure_tools() {
  if ! command -v curl >/dev/null 2>&1; then
    err "curl not found; image is missing required tools"
    exit 1
  fi
  if ! command -v openssl >/dev/null 2>&1; then
    err "openssl not found; image is missing required tools"
    exit 1
  fi
}

acme() {
  # acme.sh interprets LOG_LEVEL as a numeric debug level; our app uses strings like 'info'.
  # Unset LOG_LEVEL for acme.sh calls to avoid numeric comparisons failing.
  env -u LOG_LEVEL acme.sh "$@"
}

now_ts() { date +%s; }
hours_to_seconds() { echo $(( ${1:-0} * 3600 )); }

should_throttle_issue() {
  local primary="$1"
  local dir="$ACME_HOME/.throttle/$primary"
  local attempt_file="$dir/last_issue_attempt"
  local failure_file="$dir/last_issue_failure"
  local now; now=$(now_ts)
  local min_gap; min_gap=$(hours_to_seconds "$ACME_MIN_ISSUE_INTERVAL_HOURS")
  local cooldown; cooldown=$(hours_to_seconds "$ACME_COOLDOWN_HOURS_ON_FAILURE")

  mkdir -p "$dir"

  # Enforce minimum interval between any issue attempts
  if [[ -f "$attempt_file" ]]; then
    local last_attempt; last_attempt=$(cat "$attempt_file" 2>/dev/null || echo 0)
    if [[ "$last_attempt" =~ ^[0-9]+$ ]] && (( now - last_attempt < min_gap )); then
      local wait=$(( (last_attempt + min_gap) - now ))
      warn "Issue throttled for $primary: last attempt was $(( (now - last_attempt)/60 ))m ago; wait ~${wait}s"
      return 1
    fi
  fi

  # If there was a recent failure, apply a shorter cooldown
  if [[ -f "$failure_file" ]]; then
    local last_failure; last_failure=$(cat "$failure_file" 2>/dev/null || echo 0)
    if [[ "$last_failure" =~ ^[0-9]+$ ]] && (( now - last_failure < cooldown )); then
      local wait=$(( (last_failure + cooldown) - now ))
      warn "Issue cooldown active for $primary after failure; wait ~${wait}s"
      return 1
    fi
  fi
  return 0
}

record_issue_attempt() {
  local primary="$1"
  local dir="$ACME_HOME/.throttle/$primary"
  mkdir -p "$dir"
  now_ts > "$dir/last_issue_attempt" || true
}

record_issue_failure() {
  local primary="$1"
  local dir="$ACME_HOME/.throttle/$primary"
  mkdir -p "$dir"
  now_ts > "$dir/last_issue_failure" || true
}

clear_issue_failure() {
  local primary="$1"
  local dir="$ACME_HOME/.throttle/$primary"
  rm -f "$dir/last_issue_failure" 2>/dev/null || true
}

install_acmesh() {
  if command -v acme.sh >/dev/null 2>&1; then
    return
  fi
  log "Installing acme.sh"
  local target="/usr/local/bin/acme.sh"
  curl -fsSL https://raw.githubusercontent.com/acmesh-official/acme.sh/master/acme.sh -o "$target"
  chmod +x "$target"
}

acme_set_ca() {
  local server="$1"; shift || true
  case "$server" in
    letsencrypt|zerossl|buypass|google)
      : ;;
    *)
      warn "Unknown ACME_SERVER '$server', defaulting to letsencrypt"
      server="letsencrypt"
      ;;
  esac
  local args=("--home" "$ACME_HOME" "--set-default-ca" "--server" "$server")
  acme "${args[@]}"
}

acme_register() {
  local args=("--home" "$ACME_HOME" "--register-account")
  if [[ -n "$ACME_EMAIL" ]]; then
    args+=("-m" "$ACME_EMAIL")
  fi
  # EAB (commonly for ZeroSSL account binding)
  if [[ -n "$ACME_EAB_KID" && -n "$ACME_EAB_HMAC_KEY" ]]; then
    args+=("--eab-kid" "$ACME_EAB_KID" "--eab-hmac-key" "$ACME_EAB_HMAC_KEY")
  fi
  # Let's Encrypt staging (only if explicitly requested and server is LE)
  if [[ "${ACME_SERVER}" == "letsencrypt" && "${ACME_STAGING}" == "true" ]]; then
    args+=("--staging")
  fi
  acme "${args[@]}" || true
}

acme_domains_args() {
  local raw="$1"
  # accept comma or space separated
  raw=${raw//,/ }
  local out=()
  for d in $raw; do
    [[ -z "$d" ]] && continue
    out+=("-d" "$d")
  done
  printf '%s\n' "${out[@]}"
}

acme_issue_install() {
  local domains_raw="$1"
  local provider="$2"
  if [[ -z "$domains_raw" || -z "$provider" ]]; then
    err "ACME_DOMAINS and ACME_DNS_PROVIDER are required when ACME_ENABLED=true"
    return 1
  fi

  # Build domain args
  mapfile -t DOMAIN_ARGS < <(acme_domains_args "$domains_raw")
  if [[ ${#DOMAIN_ARGS[@]} -lt 2 ]]; then
    err "No valid domains provided in ACME_DOMAINS"
    return 1
  fi

  # Primary domain is first token after '-d'
  local primary
  primary="${DOMAIN_ARGS[1]}"

  # Try to renew if an existing cert is present; otherwise issue new
  local cert_conf="$ACME_HOME/$primary/$primary.conf"
  if [[ -f "$cert_conf" ]]; then
    log "Existing cert config found for $primary; attempting renew if due (<= ${ACME_RENEW_DAYS}d)"
    if ! acme --home "$ACME_HOME" --renew -d "$primary" --days "$ACME_RENEW_DAYS"; then
      warn "acme.sh --renew failed; will proceed to install existing cert if available"
    fi
  else
    log "No existing cert found; issuing new certificate for: $domains_raw using $provider"
    if ! should_throttle_issue "$primary"; then
      # Throttled
      if [[ -f "$cert_conf" ]]; then
        warn "Throttled but existing config present; proceeding to install existing cert"
      else
        warn "Throttled and no existing cert; skipping issuance to avoid rate limits"
        return 1
      fi
    fi
    # Build issue args, include staging for LE if requested
    local ISSUE_ARGS=(--home "$ACME_HOME" --issue)
    if [[ "${ACME_SERVER}" == "letsencrypt" && "${ACME_STAGING}" == "true" ]]; then
      ISSUE_ARGS+=(--staging)
    fi
    record_issue_attempt "$primary"
    acme \
      "${ISSUE_ARGS[@]}" \
      "${DOMAIN_ARGS[@]}" \
      --dns "$provider" \
      --keylength "$ACME_KEYLENGTH" \
      --days "$ACME_RENEW_DAYS" || {
        warn "acme.sh --issue failed; will check for existing certs"
        record_issue_failure "$primary"
      }
    # If issue succeeded, clear failure flag
    clear_issue_failure "$primary"
  fi

  mkdir -p "$CERT_DIR"
  # Install/Copy certs to fixed paths
  acme --home "$ACME_HOME" \
    --install-cert -d "$primary" \
    --fullchain-file "$CERT_DIR/fullchain.pem" \
    --key-file "$CERT_DIR/privkey.pem" \
    --cert-file "$CERT_DIR/cert.pem" \
    --ca-file "$CERT_DIR/ca.pem" || {
      err "Failed to install certs to $CERT_DIR"
      return 1
    }
  log "Certs installed in $CERT_DIR (primary: $primary)"
}

maybe_run_acme() {
  if [[ "$ACME_ENABLED" != "true" ]]; then
    log "ACME disabled; skipping cert management"
    return 0
  fi
  ensure_tools
  install_acmesh
  mkdir -p "$ACME_HOME" "$CERT_DIR"
  acme_set_ca "$ACME_SERVER"
  acme_register

  if ! acme_issue_install "$ACME_DOMAINS_RAW" "$ACME_DNS_PROVIDER"; then
    if [[ "${SMTP_SECURE:-false}" == "true" ]]; then
      err "ACME failed and SMTP_SECURE=true with no certs; refusing to start"
      exit 1
    else
      warn "ACME failed; continuing without TLS"
    fi
  fi

  # Auto-export cert paths for app if not provided
  if [[ "${SMTP_SECURE:-false}" == "true" ]]; then
    export TLS_CERT_PATH=${TLS_CERT_PATH:-$CERT_DIR/fullchain.pem}
    export TLS_KEY_PATH=${TLS_KEY_PATH:-$CERT_DIR/privkey.pem}
  fi
}

# Run ACME (if enabled) and then exec the app
maybe_run_acme

exec "${NODE_CMD[@]}"

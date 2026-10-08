#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Gifty server-side deploy.
#
# Runs on the REMOTE server as the non-root 'gifty' user (member of the
# docker group). Invoked by .github/workflows/deploy.yml over SSH, after the
# image has been built on a GitHub runner and pushed to GHCR.
#
# The server is a "dumb" docker host: it holds only docker-compose.yml + .env
# (no source, no build). This script pulls the prebuilt image, tags it as the
# name the compose file expects (gifty-app), starts/refreshes the stack, and
# gates on GET /healthz.
#
# Required environment:
#   IMAGE_REF          e.g. ghcr.io/owner/repo/gifty:<sha>
#   GHCR_USER          username for `docker login ghcr.io`
#   GHCR_TOKEN         token for `docker login ghcr.io`
#   JWT_SECRET         strong (>=32 chars) — written to .env
#   POSTGRES_PASSWORD  strong — written to .env
# Optional environment:
#   EMAIL_ENABLED      default: false  (accounts auto-confirm; no live email)
#   RESEND_API_KEY     live email (requires EMAIL_ENABLED=true)
#   RESEND_FROM        live email sender address
#   APP_HOME           default: $HOME/gifty
#   HEALTH_URL         default: http://localhost:8080/healthz
# ---------------------------------------------------------------------------
set -euo pipefail

: "${IMAGE_REF:?IMAGE_REF is required}"
: "${GHCR_USER:?GHCR_USER is required}"
: "${GHCR_TOKEN:?GHCR_TOKEN is required}"
: "${JWT_SECRET:?JWT_SECRET is required}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"

EMAIL_ENABLED="${EMAIL_ENABLED:-true}"
APP_HOME="${APP_HOME:-$HOME/gifty}"
HEALTH_URL="${HEALTH_URL:-http://localhost:8080/healthz}"

echo "==> Gifty server deploy"
echo "    image   = $IMAGE_REF"
echo "    apphome = $APP_HOME"

mkdir -p "$APP_HOME"

# --- .env ------------------------------------------------------------------
# POSTGRES_PASSWORD is baked into the postgres data volume on FIRST init of an
# empty volume. Changing it after that breaks app auth (P1000) unless the
# volume is wiped. So: if a .env already has a POSTGRES_PASSWORD, KEEP it;
# otherwise use the supplied secret. This keeps re-deploys safe and idempotent.
PGPW="$POSTGRES_PASSWORD"
if [ -f "$APP_HOME/.env" ]; then
  EXISTING="$(grep -E '^POSTGRES_PASSWORD=' "$APP_HOME/.env" 2>/dev/null | head -n1 | cut -d= -f2- || true)"
  if [ -n "$EXISTING" ]; then
    PGPW="$EXISTING"
    echo "    .env    = keeping existing POSTGRES_PASSWORD (volume-baked)"
  fi
else
  echo "    .env    = writing POSTGRES_PASSWORD (first run — bakes into volume)"
fi

cat > "$APP_HOME/.env" <<EOF
# Gifty server environment — managed by GitHub Actions (do not edit by hand)
NODE_ENV=production
PORT=8080
JWT_SECRET=${JWT_SECRET}
POSTGRES_PASSWORD=${PGPW}
EMAIL_ENABLED=${EMAIL_ENABLED}
EOF
# Live-email vars + public origin (only appended when actually provided)
[ -n "${RESEND_API_KEY:-}" ]      && echo "RESEND_API_KEY=${RESEND_API_KEY}" >> "$APP_HOME/.env"
[ -n "${RESEND_FROM:-}" ]         && echo "RESEND_FROM=${RESEND_FROM}"     >> "$APP_HOME/.env"
[ -n "${GIFTY_PUBLIC_ORIGIN:-}" ] && echo "GIFTY_PUBLIC_ORIGIN=${GIFTY_PUBLIC_ORIGIN}" >> "$APP_HOME/.env"
chmod 600 "$APP_HOME/.env"

# --- docker login (needed for private repos; a harmless no-op for public) ---
printf '%s' "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin

# --- pull the exact image we built, tag it as the compose image name --------
echo "==> pulling $IMAGE_REF"
docker pull "$IMAGE_REF"
docker tag "$IMAGE_REF" gifty-app

# --- start / refresh the stack (no build — we use the prebuilt image) -------
cd "$APP_HOME"
docker compose up -d --no-build
docker image prune -f >/dev/null 2>&1 || true

# --- readiness gate: GET /healthz -> 200 {"status":"ok"} --------------------
echo "==> waiting for $HEALTH_URL"
ready=0
for i in $(seq 1 120); do
  if curl -fs "$HEALTH_URL" >/dev/null 2>&1; then
    ready=1
    echo "    READY: $(curl -fs "$HEALTH_URL")"
    break
  fi
  sleep 1
done

# --- cleanup + result -------------------------------------------------------
docker logout ghcr.io >/dev/null 2>&1 || true

if [ "$ready" -ne 1 ]; then
  echo "ERROR: app did not report ready within 2 minutes" >&2
  docker compose logs --no-color | tail -n 200 >&2
  exit 1
fi

echo "==> DEPLOY OK"

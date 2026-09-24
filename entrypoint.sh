#!/bin/sh
# Container entrypoint (research D3/D11):
#  1. Apply the committed Prisma migrations (idempotent, auditable — never `db push`).
#     A failed migration must surface as a non-zero startup exit; data is never dropped.
#     We retry with backoff: `app` only starts after postgres is healthy (compose
#     depends_on), but the socket-based healthcheck can pass before the TCP path
#     between containers is routable (notably under Docker-in-Docker, e.g. GitHub
#     Codespaces). A few short retries absorb that warm-up window; a persistent
#     failure still exits non-zero and fails fast (contract §6 — no silent serve).
#  2. Hand off to the Node server via `exec` so it becomes PID 1 and receives signals.
#
# NOTE (C1, verified 2026-09-22): backend/tsconfig.json has rootDir "." and
# includes tests/, so `tsc` emits dist/src/server.js — NOT dist/server.js.
set -euo pipefail

MIGRATE_ATTEMPTS=12
MIGRATE_BACKOFF_S=5

echo "[entrypoint] Applying Prisma migrations (prisma migrate deploy)..."
attempt=1
while [ "$attempt" -le "$MIGRATE_ATTEMPTS" ]; do
    if npx prisma migrate deploy --schema /app/prisma/schema.prisma; then
        break
    fi
    echo "[entrypoint] migration attempt ${attempt}/${MIGRATE_ATTEMPTS} failed — retrying in ${MIGRATE_BACKOFF_S}s..."
    sleep "$MIGRATE_BACKOFF_S"
    attempt=$((attempt + 1))
done

if [ "$attempt" -gt "$MIGRATE_ATTEMPTS" ]; then
    echo "[entrypoint] FATAL: prisma migrate deploy failed after ${MIGRATE_ATTEMPTS} attempts."
    echo "[entrypoint] Check 'docker compose logs postgres' — the database may not be reachable."
    exit 1
fi

echo "[entrypoint] Starting Gifty API..."
exec node dist/src/server.js

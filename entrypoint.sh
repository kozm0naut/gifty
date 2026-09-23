#!/bin/sh
# Container entrypoint (research D3/D11):
#  1. Apply the committed Prisma migrations (idempotent, auditable — never `db push`).
#     A failed migration must surface as a non-zero startup exit; data is never dropped.
#  2. Hand off to the Node server via `exec` so it becomes PID 1 and receives signals.
#
# NOTE (C1, verified 2026-09-22): backend/tsconfig.json has rootDir "." and
# includes tests/, so `tsc` emits dist/src/server.js — NOT dist/server.js.
set -euo pipefail

echo "[entrypoint] Applying Prisma migrations (prisma migrate deploy)..."
npx prisma migrate deploy --schema /app/prisma/schema.prisma

echo "[entrypoint] Starting Gifty API..."
exec node dist/src/server.js

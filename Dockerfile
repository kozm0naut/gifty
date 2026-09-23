# syntax=docker/dockerfile:1
# Gifty — single combined "app" image: React SPA (static) + Express/Prisma API.
# Build context = repository root (so one build reaches ./frontend and ./backend).
# Research decisions: D1/D2 (backend serves static), D3 (multi-stage, non-root),
# D8 (pinned base images), D9 (lean context), H1 (prisma in dependencies).

# ---- Stage 1: frontend build (Vite -> dist/) -------------------------------
FROM node:22.16.0-alpine AS frontend
WORKDIR /app
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ---- Stage 2: backend build (tsc -> dist/src/, prisma generate, prune) -----
FROM node:22.16.0-alpine AS backend
WORKDIR /app
COPY backend/package.json backend/package-lock.json ./
# Full install so the prisma CLI (now a dependency) is available for generate.
RUN npm ci
COPY backend/ ./
# Generate the Prisma client against the in-context schema, then compile.
# tsc emits dist/src/* (rootDir "." + includes tests) — see entrypoint note (C1).
RUN npx prisma generate --schema prisma/schema.prisma \
 && npm run build \
 && npm prune --omit=dev

# ---- Stage 3: runtime (non-root) -------------------------------------------
FROM node:22.16.0-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=4000
# Runtime layout under /app:
#   /app/node_modules   (pruned, retains prisma CLI + generated client)
#   /app/dist/src/*     (compiled API; server at dist/src/server.js)
#   /app/prisma/*       (schema + committed migrations for `migrate deploy`)
#   /app/frontend/dist  (SPA static build served by Express)
COPY --from=backend /app/node_modules ./node_modules
COPY --from=backend /app/dist ./dist
COPY --from=backend /app/prisma ./prisma
COPY --from=backend /app/package.json ./package.json
COPY --from=frontend /app/dist ./frontend/dist
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
# `node` is a non-root user provided by the node:alpine base image (Const. §IV).
USER node
EXPOSE 4000
ENTRYPOINT ["/entrypoint.sh"]

# Gifty

A gift-list sharing web app with a "surprise" element: the list owner adds items and
shares the list, recipients claim or mark items as purchased — and the owner can **never**
see who claimed what or its state, while recipients see the full picture.

## Stack

- **Frontend**: React 18 + Vite 6 + react-router-dom (`frontend/`)
- **Backend**: Node 22 + TypeScript + Express 4 + Prisma 6 + PostgreSQL (`backend/`)
- **Auth**: JWT (bcryptjs password hashing)

## Docker deployment (recommended)

Run the complete application — web UI, API, and database — from a machine with only
Docker installed.

### 1. Create a `.env` (required)

The app **will not start** without a `JWT_SECRET` (there is no default by design — a
known secret would be a security hole). Create a `.env` file in the repo root containing
at minimum a `JWT_SECRET`. Generate a strong random value:

```bash
# Linux / macOS
echo "JWT_SECRET=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')" > .env
```

```powershell
# Windows PowerShell
$secret = -join ((48..57) + (97..122) + (65..90) | Get-Random -Count 48 | ForEach-Object { [char]$_ })
"JWT_SECRET=$secret" | Set-Content .env
```

> `.env` is git-ignored — never commit it. `POSTGRES_PASSWORD` and `PORT` are optional
> (sensible dev defaults are already wired into `docker-compose.yml`).

### 2. Start the stack

```bash
docker compose up --build -d
```

### 3. Check readiness (healthz)

Poll the health endpoint until it reports ready:

```bash
until curl -fs http://localhost:8080/healthz > /dev/null 2>&1; do sleep 2; done
curl -fs http://localhost:8080/healthz     # -> {"status":"ok"}
```

A healthy stack returns HTTP **200** with `{"status":"ok"}`. Once it does, open
**http://localhost:8080**.

> **GitHub Codespaces:** the DinD sidecar blocks inter-container bridge traffic, so use
> the host-networking variant instead — `docker compose -f docker-compose.codespace.yml up --build -d`.
> See [docs/docker.md](docs/docker.md) §3b.

See **[docs/docker.md](docs/docker.md)** for the full operator guide: configuring
`JWT_SECRET`, start/stop/reset commands, failure modes, and volume backup.

## Local development

> The dev flow uses `backend/.env` (which sets a local dev `JWT_SECRET` + `DATABASE_URL`)
> rather than the root `.env` required for the Docker deployment.

```bash
# 1. Install dependencies
npm install
npm --prefix backend install
npm --prefix frontend install

# 2. Run the app (dev Postgres + API on :4000 + Vite on :5173)
npm run dev
```

- API: http://localhost:4000
- Web UI: http://localhost:5173

### Tests

```bash
npm test                                   # backend suite (Vitest + Supertest)
npm --prefix frontend run test             # frontend unit tests (Vitest)
npm --prefix frontend run test:e2e         # Playwright e2e (starts against :5173)
BASE_URL=http://localhost:8080 npm --prefix frontend run test:e2e   # e2e against the containerized app
```

## Repository layout

```text
backend/    Express + Prisma API (src/), tests, prisma schema + migrations
frontend/   React + Vite SPA (src/), Playwright e2e (tests/e2e)
docs/       docker.md — Docker deployment guide
specs/      feature specifications, plans, and tasks
Dockerfile  multi-stage build: frontend build + backend build → non-root runtime
docker-compose.yml           standard stack (local / CI)
docker-compose.codespace.yml GitHub Codespaces variant (host networking)
docker-compose.dev.yml       dev override (re-exposes Postgres 5432)
.env                         required for Docker: JWT_SECRET (git-ignored)
```

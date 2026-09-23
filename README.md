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
Docker installed, using one command:

```bash
docker compose up --build -d
```

Then open **http://localhost:8080** (wait for readiness with
`curl -fs http://localhost:8080/healthz`).

See **[docs/docker.md](docs/docker.md)** for the full operator guide: configuring
`JWT_SECRET`, start/stop/reset commands, failure modes, and volume backup.

## Local development

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
docker-compose.yml / docker-compose.dev.yml
```

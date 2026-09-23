# Implementation Plan: Docker Deployment

**Branch**: `[002-docker-deployment]` | **Date**: 2026-09-22 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/002-docker-deployment/spec.md`

**Note**: This template is filled in by the `/speckit-plan` command; its definition describes the execution workflow.

## Summary

Package the existing Gifty application (React/Vite frontend, Express/Prisma backend, PostgreSQL 16) into a single-command, reproducible Docker deployment. The user runs one documented command from the project root and gets the full application — web UI, API, and data store — running with data that persists across stop/start cycles. A dedicated health/readiness endpoint (FR-013) gives operators and tests an unambiguous "ready" signal. Documented stop and reset commands complete the operational contract.

Technical approach: extend the existing `docker-compose.yml` (currently postgres-only) into a two-container stack (postgres + app). The single `app` image builds the TypeScript API **and** also serves the frontend's static production build, so the user reaches the whole app at one URL (default host port `8080`). Data lives in a named volume; reset = remove volume + recreate. Readiness is achieved via a lightweight `/healthz` endpoint on the app and a Compose healthcheck chain (postgres → app).

## Technical Context

**Language/Version**: Node.js 22 (existing toolchain; `@types/node ^22`), TypeScript 5.7 (backend `tsc` build), Vite 6 (frontend build)

**Primary Dependencies**:
- Backend: Express 4, Prisma 6, `@prisma/client`, bcryptjs, jsonwebtoken, cors, uuid
- Frontend: React 18, react-router-dom 6, Vite 6 + `@vitejs/plugin-react`
- Database: PostgreSQL 16 (image `postgres:16.x-alpine`, minor-pinned for reproducibility; the current `docker-compose.yml` already uses the 16 line)

**Storage**: PostgreSQL 16 via Prisma (`backend/prisma/schema.prisma`), persisted in a Docker named volume `gifty_postgres_data`. No other storage.

**Testing**:
- Backend: Vitest + Supertest (`backend/tests/`, 59 tests) — run from the **host** against the running container per the 2026-09-22 clarification.
- Frontend: Vitest (unit, `frontend/src/**/*.test.tsx`) + Playwright e2e (`frontend/tests/e2e/`, 8 tests) — also host-run.
- Container-level validation: health/readiness endpoint polling + the quickstart scenarios below.

**Target Platform**: Docker Engine / Docker Desktop on major desktop OSes (Windows, macOS, Linux) — no OS-specific instructions (FR-010). Compose file targets the Compose spec supported by Docker Desktop ≥ 4.x.

**Project Type**: Web application (existing `backend/` + `frontend/` split, already in the repo) wrapped by a containerized deployment.

**Performance Goals**: Modest — the target is a developer laptop (Assumptions). Startup-to-ready < 2 minutes on a clean machine (SC-001, US1). Steady-state memory for the whole stack ≤ ~1 GB.

**Constraints**:
- First build may pull images from a registry; cached builds must work offline (FR-009, clarification 2026-09-22).
- Published ports: a single host port for the full app (default `8080`), plus the DB stays **internal-only** (not published to the host by default) — see Constitution Check §IV.
- Container images MUST run as a non-root user (Constitution §IV, Security by Default).
- `JWT_SECRET` MUST NOT be baked into any image (environment-injected only).

**Scale/Scope**: Single-operator, single-replica, local deployment. Multi-replica / HA / managed-cloud topologies are explicitly out of scope (Assumptions).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Constitution: `.specify/memory/constitution.md` (v1.0.0)

| # | Principle | Gate for this feature | Result |
|---|-----------|----------------------|--------|
| I | User Trust & Privacy | Containerization MUST NOT weaken privacy: the owner-privacy filtering in the backend routers is untouched by packaging. DB must not be published to the host by default (data-exposure risk). | ✅ PASS — plan keeps `postgres` internal-only; app code unmodified |
| II | List Integrity & Consent | No changes to claim/purchase state logic. Persistence (FR-004) must not corrupt state across restarts. | ✅ PASS — same Prisma schema & code; volume-backed Postgres gives durable, consistent storage |
| III | Test-First Delivery | Spec + quality checklist done before implementation (✅). Host-run test suites remain available against the container (clarification 2026-09-22). Readiness endpoint (FR-013) makes container-level tests deterministic. | ✅ PASS — `specs/002-docker-deployment/spec.md` + `checklists/requirements.md` (16/16) complete; quickstart defines the runnable validation |
| IV | Security by Default | Images MUST use non-root users; `JWT_SECRET` and DB credentials injected via environment (never baked in); DB not exposed to the host; no secrets in committed files. | ✅ PASS — see Technical Context constraints + data-model.md security notes |
| V | Simple, Explainable Sharing | No changes to sharing behavior. Deployment must be explainable: one start command, one stop command, one reset command, one documented URL. | ✅ PASS — the deployment contract (contracts/deployment.md) defines exactly this |

**Gate result**: ✅ PASS — no violations. No entries required in Complexity Tracking.

## Project Structure

### Documentation (this feature)

```text
specs/002-docker-deployment/
├── plan.md              # This file (/speckit-plan command output)
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── architecture.md      # Illustrative Mermaid diagram of the two-container deployment
├── contracts/
│   └── deployment.md    # Phase 1 output — operational contract (commands, ports, readiness)
└── tasks.md             # Phase 2 output (/speckit-tasks command - NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
.
├── Dockerfile                 # NEW: multi-stage build at repo root (frontend build + backend build → runtime, non-root)
├── .dockerignore              # NEW: node_modules, **/dist, .env*, **/tests, test-results, .git, specs/
├── docker-compose.yml         # EXTEND: add `app` service + healthcheck + depends_on chain; keep `postgres`
├── entrypoint.sh              # NEW: run `prisma migrate deploy`, then `node dist/src/server.js` (tsc emits dist/src/ — see research D3/C1)
├── backend/
│   ├── src/
│   │   └── app.ts             # EXTEND: GET /healthz + serve frontend static build (production only)
│   └── prisma/
│       └── migrations/        # NEW: initial migration generated via `prisma migrate dev --name init`
├── frontend/                  # (unchanged source; built inside the Dockerfile's frontend stage)
├── docs/
│   └── docker.md              # NEW: user-facing deployment documentation (start/stop/reset/readiness)
└── README.md                  # NEW: create (none exists yet) — pointer to docs/docker.md + one-command quickstart
```

**Structure Decision**: Single Compose project at the repo root with **two services** — `postgres` and `app`. One root `Dockerfile` (build context = repo root) produces a combined `app` image that runs the compiled backend API **and** serves the frontend's static production build (research decisions D1/D2), so the user needs only one published port (`8080`). The existing postgres-only `docker-compose.yml` is extended in place (rename `postgres_data` → `gifty_postgres_data`). No new top-level directories; no monorepo restructuring.

## Complexity Tracking

> Not required — Constitution Check passed with no violations.

# Deployment Contract: Gifty (Docker)

**Feature**: `002-docker-deployment` | **Date**: 2026-09-22
**Status**: normative — this is the operator-facing contract the implementation MUST satisfy.

This document defines the **operational contract** for the containerized Gifty deployment: the exact commands, the single URL, the readiness signal, the environment configuration, and the behavioral guarantees (start/stop/reset, persistence, failure modes). It is the "explainable" surface the user interacts with (Constitution §V). The technical rationale lives in `research.md`; the data guarantees live in `data-model.md`.

## 1. The four commands

All commands are run from the **repository root** and assume Docker (with Compose) is installed and running.

| Action | Command | Effect |
|--------|---------|--------|
| **Start** | `docker compose up --build -d` | Builds (if needed) and starts `postgres` + `app` in the background. Blocks until `postgres` is healthy, then `app` runs migrations and starts serving. |
| **Ready check** | `curl -fs http://localhost:8080/healthz` | Returns `200` with `{"status":"ok"}` when the app is ready. (Poll in a loop for scripts — see §4.) |
| **Stop** | `docker compose down` | Stops and removes the containers. **Data is retained** in the `gifty_postgres_data` volume. |
| **Reset** | `docker compose down -v` | Stops and removes the containers **and** deletes the data volume. A subsequent start presents a clean initial state. |

### Convenience (documented, optional)

A `package.json` script `docker:up` may wrap the start command, but the **normative** contract is the raw `docker compose` commands above. The user must never need anything other than Docker.

## 2. The single URL

- **URL**: `http://localhost:8080`
- **Host port**: `8080` (the only published port). Configurable via the `PORT` variable in `docker-compose.yml` / `.env`.
- Serves **both** the SPA (React) and the API (`/auth`, `/lists`, `/items`) from the same origin.
- Deep links (e.g. `/list/:id`) work on hard refresh via the SPA fallback.
- The database port (`5432`) is **not** published to the host by default.

## 3. Environment configuration

Injected at `docker compose up` time. Sourced from a root `.env` (git-ignored) with the documented defaults below.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `JWT_SECRET` | **YES** | *(none)* | Secret for signing JWTs. **No fallback value is permitted** in the containerized build (Constitution §IV). If missing, `docker compose up` / app startup MUST fail fast. |
| `POSTGRES_DB` | no | `gifty` | Database name. |
| `POSTGRES_USER` | no | `gifty` | Database user. |
| `POSTGRES_PASSWORD` | no | `gifty_dev_password` | Database password (dev default; override in any non-local use). |
| `DATABASE_URL` | no | derived | `postgresql://gifty:<POSTGRES_PASSWORD>@postgres:5432/gifty?schema=public` (composed from the above). |
| `NODE_ENV` | no | `production` | In container context. Enables static-serving + strict config validation. |
| `PORT` | no | `8080` | Host port for the app. |
| `CORS_ORIGINS` | no | *(unset)* | Not needed for same-origin serving; retained for dev flexibility. |

**Security rules (normative)**:
- `JWT_SECRET` MUST be required. The legacy `'development-secret'` fallback in the auth code MUST be removed so a missing secret fails fast rather than silently using a known value.
- No secret (JWT or DB) MAY be baked into the image. All are injected via environment.
- The `app` container MUST run as a non-root user.

## 4. Readiness signal (FR-013)

- **Endpoint**: `GET /healthz` on the `app` service → `200 {"status":"ok"}` when the API process is up.
- **Orchestration ordering**: `app` `depends_on` `postgres` with `condition: service_healthy` (healthcheck: `pg_isready -U gifty -d gifty`). So `app` only starts once the DB accepts connections, and `prisma migrate deploy` runs before the server listens.
- **Scriptable wait** (cross-platform, the operator/CI idiom):
  ```bash
  until curl -fs http://localhost:8080/healthz > /dev/null 2>&1; do sleep 1; done
  echo "Gifty is ready at http://localhost:8080"
  ```
  *(Windows PowerShell: `do { Start-Sleep 1 } until (curl.exe -fs http://localhost:8080/healthz | Out-Null)`)*
- **Guarantee**: once containers are starting, `GET /healthz` returns `200` within **2 minutes** (US1 scenario 1). This budget starts at container start and **excludes first-time image builds** — the separate SC-001 budget (fresh clone → working app, under 10 minutes, build included) covers that.

## 5. Behavioral guarantees

| Guarantee | Requirement ref | Contract statement |
|-----------|-----------------|--------------------|
| **Single command, no host deps** | FR-001, FR-002 | `docker compose up --build -d` starts the full app. The user MUST NOT need to install Node, the DB, or any runtime on the host. |
| **Stable URL** | FR-003 | The app is reachable at `http://localhost:8080` (default). |
| **Data persistence** | FR-004 | All user data survives a full stop/start cycle. |
| **Consistent init/reuse** | FR-005 | First start creates + migrates the store; later starts reuse it without reset. |
| **Clear failures** | FR-006 | Port conflict, DB init failure, or missing `JWT_SECRET` produce a clear, human-readable, actionable message — never a silent or data-losing failure. |
| **Stop releases resources** | FR-007 | `docker compose down` stops cleanly and frees the host port. |
| **Reset** | FR-008 | `docker compose down -v` removes all data; next start is clean. |
| **Reproducible** | FR-009 | First build may pull images (network); cached builds work offline. Rebuilding in a clean environment yields an equivalent working app. |
| **Cross-OS** | FR-010 | Works on Windows, macOS, Linux with no OS-specific steps. |
| **Privacy intact** | FR-011 | All authN/Z and owner-privacy behavior is unchanged by packaging. |
| **Full feature parity** | FR-012 | Account, list, sharing, claim, and purchase flows all work end-to-end. |
| **Readiness** | FR-013 | `GET /healthz` is the unambiguous ready signal. |

## 6. Failure modes (normative behavior)

| Scenario | Required behavior |
|----------|-------------------|
| Host port `8080` already in use | `docker compose up` fails with a clear message naming the port conflict. No partial start. |
| `JWT_SECRET` missing | Startup fails fast with a clear message. The app MUST NOT start with a known/default secret. |
| Postgres fails healthcheck | `app` does not start; a clear startup failure is surfaced. The app MUST NOT serve on a broken store. |
| Migration fails | Startup fails with the migration error surfaced. Existing data is NOT dropped. |
| App crash | Only the `app` container is affected; `postgres` and its volume (all data) are unaffected. `docker compose up -d` resumes with data intact. |

## 7. Out of scope (normative exclusions)

- Multi-replica / load-balanced / HA topologies.
- Managed-cloud / production-cluster deployment (this is a local, single-operator deployment).
- Running the automated test suites **inside** the container (tests run from the host against the running app — see `research.md` D13).
- Automatic backup/restore tooling (the volume is the backup unit; a manual dump command is documented as an advanced note in `docs/docker.md`).
- TLS / automatic HTTPS (local deployment, `http://` only).

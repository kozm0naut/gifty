# Quickstart: Docker Deployment Validation

**Feature**: `002-docker-deployment` | **Date**: 2026-09-22

This is a **runnable validation guide** — the concrete steps that prove the containerized deployment satisfies the spec. It is not an implementation guide (that's `tasks.md` + the implementation phase). The normative commands, URL, and guarantees are in [`contracts/deployment.md`](contracts/deployment.md); the data guarantees are in [`data-model.md`](data-model.md).

## Prerequisites

- **Docker** (with Compose) installed and running — e.g. Docker Desktop, or Docker Engine + `docker-compose` v2. Verify with `docker version` and `docker compose version`.
- **A browser** for end-user flow validation.
- **`curl`** (or any HTTP client) for the readiness check. Preinstalled on macOS/Linux and in Windows 10+ PowerShell.
- Network access for the **first** build (to pull base images). Subsequent builds work from cache (FR-009).
- No Node.js, database, or other application runtime required on the host (FR-002).

> **Note**: If a `gifty-postgres` container from the old dev-only `docker-compose.yml` is already running, stop it first (`docker compose down`) so the new stack owns the port and volume cleanly.

## Setup

```bash
# From the repo root
# 1. Provide the required secret (no default is permitted — Constitution §IV)
echo "JWT_SECRET=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')" > .env
#    (On Windows PowerShell, use a generated value, e.g. a random 32+ char string.)

# 2. Start the full stack (builds on first run)
docker compose up --build -d

# 3. Wait for readiness (FR-013)
until curl -fs http://localhost:8080/healthz > /dev/null 2>&1; do sleep 1; done
echo "Gifty is ready at http://localhost:8080"
```

**Expected**: `docker compose up` returns with `postgres` healthy and `app` serving; the readiness loop exits; `curl http://localhost:8080/healthz` returns `200 {"status":"ok"}`. The app is reachable at `http://localhost:8080` within 2 minutes of a clean start (SC-001).

## Validation Scenarios

### V1 — Single command, full app (US1, FR-001/002/003)

1. Open `http://localhost:8080` in a browser.
2. Complete the full flow: **sign up** → **create a list** → **add an item** → **share with a second account** → **claim the item**.

**Expected**: Every step succeeds and behaves identically to the non-containerized dev setup. No host-side dependency installation was needed.

### V2 — Data survives a restart (US2, FR-004/005)

1. With the app running and the V1 data present, stop the stack: `docker compose down`.
2. Confirm data retention: `docker volume ls | Select-String gifty_postgres_data` shows the volume still exists.
3. Start again: `docker compose up -d`, then wait for readiness (see Setup step 3).
4. Log in with the V1 accounts; open the list.

**Expected**: All accounts, lists, items, and claim/purchase state are intact and visible to the correct users. Nothing was reset.

### V3 — Owner privacy intact (Constitution §I/§II, FR-011)

1. As the **list owner**, open the shared list.
2. As a **recipient**, open the same list.

**Expected**: The owner does **not** see claim/purchase state or the claimant identity; the recipient **does** see full state. Packaging did not weaken privacy.

### V4 — Prevent duplicate claims (Constitution §II, FR-012)

1. With two recipient sessions on the same list, attempt to claim the same available item near-simultaneously.

**Expected**: Exactly one claim succeeds; the other is rejected. (Also covered by the backend concurrency test and the Playwright e2e suite.)

### V5 — Clear failure on port conflict (FR-006)

1. With the app running (port `8080` bound), attempt `docker compose up --build -d` in a second compose project bound to the same host port, or occupy port `8080` with another process and start.

**Expected**: A clear, human-readable message identifying the port conflict. No silent or partial start.

### V6 — Fail fast without JWT_SECRET (Constitution §IV, FR-006)

1. Remove `JWT_SECRET` from `.env` (or set it empty), then `docker compose up --build -d` against a fresh volume.

**Expected**: Startup fails fast with a clear message. The app MUST NOT start with a known/default secret.

### V7 — Reset to clean state (FR-008, US3 scenario 4)

1. `docker compose down -v` (removes the `gifty_postgres_data` volume).
2. `docker compose up --build -d`, wait for readiness.
3. Attempt to log in with a V1 account.

**Expected**: Login fails — the data is gone. A fresh signup works. The app presents a clean initial state.

### V8 — Reproducible build (FR-009, SC-004)

1. On a second clean machine (or a fresh CI runner), repeat Setup from a fresh clone.

**Expected**: A working application is reached from documentation alone, in under 15 minutes, with identical behavior for the core flows. First build pulls images; a rebuild from cache works offline.

## Automated validation (host-run, per clarification Q2)

The automated suites run **from the host against the running container** (not inside it):

- **Frontend e2e (Playwright, 8 tests)** — point the suite at the containerized origin and run:
  ```bash
  # baseURL override so the existing suite targets the container instead of :5173
  BASE_URL=http://localhost:8080 npm --prefix frontend run test:e2e
  # (playwright.config.ts should read baseURL from the BASE_URL env var, defaulting to :5173)
  ```
  The 8 existing e2e tests (share & claim, duplicate-claim conflict, owner privacy, lifecycle reverts, permission revoke, persistence) are the acceptance validation for the containerized deployment.
- **Backend unit/integration (Vitest + Supertest, 59 tests)** — continue to run against their existing local-DB setup (`npm run dev:db` + `npm --prefix backend run test`). The containerized deployment does not change how these run (see `research.md` D13).

**Expected**: e2e suite green against `http://localhost:8080`; backend suite green as before.

## Teardown

```bash
# Stop and remove containers (data retained)
docker compose down

# Stop and remove containers AND data (full reset)
docker compose down -v
```

## Success (Definition of Done for this feature)

- [x] `docker compose up --build -d` from a clean machine yields a working app at `http://localhost:8080` in under 10 minutes, with no host dependency installs (SC-001).
- [x] All core flows work end-to-end in the container (SC-002).
- [x] Data persists across stop/start, verified by V2 (SC-003).
- [x] A second clean machine reproduces the working app from docs alone (SC-004).
- [x] All failure scenarios (V5, V6) report clear, actionable messages; no silent/data-losing failures (SC-005).
- [x] `GET /healthz` is the readiness signal and returns `200` within 2 minutes of a clean start (FR-013).
- [x] Privacy and authorization behavior are unchanged (V3; Constitution §I/§II/§IV).
- [x] Playwright e2e (8 tests) passes against `http://localhost:8080`; backend suite (59 tests) still passes.

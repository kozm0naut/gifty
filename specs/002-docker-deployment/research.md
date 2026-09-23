# Research: Docker Deployment

**Feature**: `002-docker-deployment` | **Date**: 2026-09-22
**Purpose**: Resolve technical unknowns, evaluate alternatives, and lock in the design decisions that drive the plan and tasks.

## D1: Service topology — how many containers?

**Decision**: Two containers in one Compose project: `postgres` and `app`. The `app` service runs the backend API **and** serves the frontend's static production build, so the whole application is reached at a single published port.

**Rationale**:
- One published port, one URL, one "is it up?" signal — the simplest possible operator model (Constitution §V, Simple & Explainable; FR-003's "documented, stable URL").
- The frontend is a pure static SPA (Vite build → `dist/`); serving static files from Express is a well-understood, low-risk addition (`express.static` + a SPA fallback). No extra runtime is needed.
- Keeping `postgres` in its own container matches the existing `docker-compose.yml`, the Prisma expectation of a reachable Postgres endpoint, and the durability intuition: a crash of the app must not take the data with it (FR-004/FR-005).
- Alternative considered: **separate nginx/caddy `web` container** — adds a container, a build stage, an nginx config, and a second service to healthcheck, with no user-visible benefit for a single-replica local deployment. Rejected as unnecessary complexity (the static-serving load is trivial for Express at this scale).
- Alternative considered: **single all-in-one container** (backend + static files + DB in one image) — rejected because it couples DB lifecycle to app lifecycle and makes the data store harder to manage independently.

## D2: How is the frontend built and served?

**Decision**: The frontend is built with its existing Vite toolchain (`vite build` → `dist/`) in a dedicated build stage, and the resulting `dist/` directory is copied into the `app` (backend) image. At runtime, Express serves `dist/` as static files with an SPA fallback (`/` → `index.html` for non-API, non-asset routes), and serves the API on its existing routes (`/auth`, `/lists`, `/items`).

**Rationale**:
- Browsers talk to **one origin** (the `app` container's published port). Same-origin API calls avoid CORS entirely in the containerized deployment (the existing CORS config in `app.ts` remains as a safety net for the dev setup).
- A single origin means the existing `VITE_API_URL` default (`http://localhost:4000`) is no longer needed at runtime — the build is served from the same host as the API.
- SPA fallback: Express `app.get('*')` (or middleware) falls back to `index.html` for any route that is not an API path and not a static asset, so React Router deep links (`/list/:id`, `/list/:id/sharing`) work on hard refresh.
- The static-serving change is additive and gated on production mode, so the dev flow (Vite dev server on :5173 + API on :4000) is unaffected.

**Alternatives considered**:
- A separate nginx/caddy static container — rejected in D1 as unnecessary complexity.
- A dedicated Node static-server package (e.g., `serve`) — extra dependency for what `express.static` already does.

## D3: How is the backend built and run?

**Decision**: Multi-stage Node image:
1. **build stage**: `node:22.x-alpine` + `npm ci` (full, so the `prisma` CLI is present) + `npx prisma generate` + `tsc -p tsconfig.json` + `npm prune --omit=dev` → produces `dist/` (see emit-path note) + the generated Prisma client in `node_modules/@prisma/client`, with dev-only packages pruned.
2. **runtime stage**: `node:22.x-alpine`; `COPY --from=build` the pruned `node_modules/` (retains the `prisma` CLI and the generated client), the compiled `dist/` (incl. `dist/src/`), `prisma/`, `entrypoint.sh`, and the frontend `dist/`; create a non-root user, `USER node`; entrypoint runs `node dist/src/server.js`.

**Rationale**:
- Non-root user satisfies Constitution §IV (Security by Default).
- **Emit path (C1, verified 2026-09-22 via `npm --prefix backend run build`):** `backend/tsconfig.json` has `rootDir: "."` and `include: ["src/**/*.ts","tests/**/*.ts"]`, so `tsc` emits `dist/src/server.js` (and compiles tests into `dist/tests/`). The entrypoint and Dockerfile MUST target `dist/src/server.js`. (Alternative: set `rootDir: "src"` and drop `tests` from `include` to get `dist/server.js` — but that changes the existing toolchain and the `start` script; the verified-path approach is lower risk.)
- **Prisma at runtime (H1, verified 2026-09-22):** `prisma` is currently a **devDependency**, but `prisma migrate deploy` runs in the prod entrypoint and needs the CLI. Coherent scheme: **move `prisma` to `dependencies`** in `backend/package.json`, run `prisma generate` in the build stage, then `npm prune --omit=dev`; the pruned `node_modules` (copied into the runtime) retains the `prisma` CLI **and** the generated `@prisma/client`. This replaces the earlier incoherent "`npm ci --omit=dev` in an intermediate layer" + "runtime inherits the generated client" description.
- The `app` image is a **multi-service build**: a frontend build stage produces `dist/`, which is copied into the runtime stage alongside the compiled backend, so the single `app` container serves both the API and the static SPA (see D1/D2).

**Boot-time migrations**: The repo currently has no `prisma/migrations/` directory (development uses `prisma db push`). For the containerized deployment we MUST ensure schema is applied on first boot. Two options:
- **A (recommended)**: Generate migrations now (`npx prisma migrate dev --name init`) and commit them; the runtime entrypoint runs `npx prisma migrate deploy` before starting the server. This is the production-grade path and matches Constitution §IV (no implicit schema drift).
- **B**: Run `npx prisma db push` in the entrypoint. Simpler but non-reproducible and not auditable.

**Decision**: Option A. The tasks will include a one-time `prisma migrate dev` to seed the initial migration, then `migrate deploy` in the entrypoint.

## D4: Environment configuration

**Decision**: All runtime configuration is injected via environment variables at `docker compose up` time, sourced from a `.env` file at the repo root (git-ignored) with documented defaults in `docker-compose.yml`. Required variables:

| Variable | Default (compose) | Notes |
|---|---|---|
| `POSTGRES_DB` | `gifty` | |
| `POSTGRES_USER` | `gifty` | Renamed from `postgres` (principle of least privilege) |
| `POSTGRES_PASSWORD` | generated via `docker secrets` or a local `.env` | **NEVER** baked into the image |
| `DATABASE_URL` | `postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}?schema=public` | Backend service reads this |
| `JWT_SECRET` | **required, no default** | Constitution §IV — must be provided. Compose file sets `required: true` semantics via a startup check. |
| `NODE_ENV` | `production` | In container context |
| `PORT` | `4000` | Internal container port |
| `CORS_ORIGINS` | unset | Not needed when the app is served same-origin; kept for dev |
| `PORT` (host) | `8080` | Single published port for the whole app |

**JWT secret handling — IMPORTANT**: The current code falls back to `'development-secret'` when `JWT_SECRET` is unset (`backend/src/auth/middleware.ts:18`, `router.ts:34,62`). This is a **Constitution §IV violation in a containerized (production-like) deployment**. The plan requires:
- `docker-compose.yml` sets `required: true` on `JWT_SECRET` (Compose spec) so `docker compose up` fails fast if it is missing.
- `backend/src/config/index.ts` `validateConfig()` already throws when `JWT_SECRET === 'development-secret'` and `NODE_ENV === 'production'` — this is the runtime backstop.
- The `development-secret` fallback in `middleware.ts`/`router.ts` should be **removed** (fail-fast instead of silently using a known secret). This is a small code change that is in scope for this feature because it is required to make the containerized deployment safe (Constitution §IV). It does not change behavior for the dev flow if the dev `.env` sets `JWT_SECRET`.

**Alternatives considered**:
- Baking a generated secret into the image — rejected (violates §IV; secret would be recoverable by anyone with the image).
- Requiring a `--secret` CLI flag — rejected (worse UX than a documented `.env`).

## D5: Data persistence & reset

**Decision**:
- **Persistence**: A named volume `gifty_postgres_data` (renamed from the existing `postgres_data` for clarity) is mounted at `/var/lib/postgresql/data` in the `postgres` service. This is the single source of truth for all application data (FR-004, FR-005).
- **Reset**: `docker compose down -v` (removes the volume) + `docker compose up --build` (fresh start). Documented as a single command pair in `docs/docker.md`.
- **Backup**: Out of scope for v1 (Assumptions). The volume is the unit of backup; users can `docker run --rm -v gifty_postgres_data:/data -v $(pwd)/backup:/backup alpine tar czf /backup/gifty-db.tar.gz -C /data .` if they need it — documented as an advanced note.

**Rationale**: Named volumes are Docker's canonical durable storage primitive. They survive `docker compose down` (without `-v`), survive host reboots, and are independent of any container's lifecycle — exactly matching FR-004/FR-005.

## D6: Health/readiness endpoint (FR-013)

**Decision**:
- **Backend**: Add `GET /healthz` to `backend/src/app.ts`. Returns `200 { "status": "ok" }` when the process is up. This is a **liveness** check (process alive), not a readiness check (DB reachable). For local single-replica use, liveness is sufficient for the "is it started" question.
- **Readiness (DB reachable)**: The Compose `depends_on` + `healthcheck` chain guarantees ordering:
  - `postgres` has a healthcheck: `pg_isready -U gifty -d gifty` (already present in the existing compose file, just needs the user/db renamed).
  - `app` has `depends_on: postgres: condition: service_healthy`, so the backend only starts once the DB is accepting connections (and its `migrate deploy` entrypoint can run safely).
- **User-facing readiness signal**: `docker compose up` returns to the shell once all containers report healthy (Compose blocks until `condition: service_healthy` is met for `depends_on` chains). Additionally, the documented "wait for ready" command is:
  ```bash
  # Poll until the app is ready (works on any OS with curl)
  until curl -fs http://localhost:8080/healthz > /dev/null 2>&1; do sleep 1; done
  echo "Gifty is ready at http://localhost:8080"
  ```
  This is the operator/test-friendly signal (FR-013).

**Rationale**:
- A dedicated endpoint is unambiguous, language-agnostic, and scriptable (clarification Q1, 2026-09-22).
- Compose healthchecks give the orchestration-level ordering guarantee without requiring the app to poll the DB itself.
- The `until curl` loop is the simplest cross-platform "wait for ready" idiom and works in the quickstart and any CI script.

**Alternatives considered**:
- Log-based readiness (`docker logs` grep) — fragile, locale-dependent, not scriptable.
- A separate readiness sidecar — overkill for single-replica local use.

## D7: Port strategy

**Decision**:
- **Published (host-visible)**: `8080:4000` on the `app` service only (host 8080 → container 4000, where the Express API listens per `PORT=4000`). This is the single URL the user opens: `http://localhost:8080`.
- **Internal-only (not published)**: `postgres:5432`. Reachable only from within the Compose network (the `app` service connects to it over the internal network).
- **Dev parity note**: The existing dev flow uses `localhost:5173` (frontend) + `localhost:4000` (API). The containerized flow uses `localhost:8080` for both the SPA and the API (same origin, served by the `app` service). The `VITE_API_URL` env var (currently `http://localhost:4000` default) becomes unnecessary in the containerized build because the SPA and API share an origin. For the host-run e2e suite (clarification Q2), Playwright targets `http://localhost:8080`.

**Rationale**:
- Single published port = simplest mental model (Constitution §V, Simple & Explainable).
- DB not published = smaller attack surface, no accidental host DB client connecting to app data (Constitution §I, §IV).
- Same-origin proxying eliminates CORS configuration in the containerized deployment.

## D8: Image base & supply chain

**Decision**:
- `node:22.x-alpine` for the app build + runtime (Alpine: small, well-maintained, musl-compatible with Node 22; pinned to the 22 minor line, not a floating `latest`).
- `postgres:16.x-alpine` for the DB (already in use; consistent; pinned to the 16 minor line).
- **No** `latest` tags — all pinned to major.minor for reproducibility (FR-009). (L3: use the minor-pinned `22.x` / `16.x` tags in the Dockerfile/compose, not bare `22` / `16`.)
- **No** custom base images or internal registries — all from Docker Hub (network required on first pull, per clarification Q3).

**Rationale**:
- Alpine images are 5–60× smaller than their Debian/Ubuntu equivalents, reducing first-pull time (SC-001: <10 min to working app).
- Pinning to `1.27` / `16` / `22` (not `latest`) is the minimum bar for reproducible builds.
- Docker Hub is the default; no internal registry assumption (Assumptions).

## D9: Build context & .dockerignore

**Decision**:
- A single `Dockerfile` at the repo root (or `app/Dockerfile`) with the repo root as its build context, so one multi-stage build can reach **both** `./frontend` (for the Vite build stage) and `./backend` (for the API build + runtime stage).
- A root `.dockerignore` excludes `node_modules`, `**/dist`, `.env*`, `**/tests`, `test-results`, `*.log`, `.git`, and `specs/` from the build context.

**Rationale**: A single build context that spans both `frontend/` and `backend/` lets one Dockerfile produce the combined `app` image (SPA + API) — matching D1/D2. The `.dockerignore` keeps the context small (excludes `node_modules`, which can be 200+ MB) so builds stay fast. Standard practice.

## D10: What happens to the existing `docker-compose.yml`?

**Decision**: Extend it in place. The existing `postgres` service is adjusted (user `postgres` → `gifty`, volume `postgres_data` → `gifty_postgres_data`) and one new service (`app`) is added that builds the backend image (which includes the frontend `dist/`). The `version: '3.9'` line is removed (deprecated in Compose v2; a warning is printed). A top-level `networks:` block is added so both services share an internal network.

**Rationale**:
- The existing file is already a working starting point (postgres + healthcheck). Extending it preserves the dev workflow (`npm run dev:db` still works).
- Renaming the volume is a one-time migration: the first `docker compose up` after the change will create a new empty volume. **This is a breaking change for anyone with data in the old `postgres_data` volume** — the `docs/docker.md` must document the migration path (dump/restore, or accept the reset for a dev DB).
- Removing `version:` is safe on Docker Desktop ≥ 4.x and silences the deprecation warning.

## D11: `prisma migrate` vs `prisma db push` (boot-time schema)

**Decision**: Use `prisma migrate deploy` in the backend entrypoint (see D3). This requires generating and committing the initial migration as part of this feature's tasks.

**Rationale**:
- `migrate deploy` is idempotent, auditable, and the production-grade path. It applies pending migrations in order and is safe to run on every boot.
- `db push` is a dev convenience; it does not track migration history and can silently drop data if the schema and DB drift. Not acceptable for a deployment that must preserve data across restarts (FR-004).
- The current repo has no `prisma/migrations/` directory, so the first task in this feature is to generate the initial migration (`npx prisma migrate dev --name init`) and commit it.

## D12: SPA routing & static file serving (in the backend)

**Decision**: In `backend/src/app.ts`, when `NODE_ENV === 'production'` and a static build directory is present, register:
1. `app.use(express.static(distDir))` — serves `index.html`, JS/CSS bundles, and other assets.
2. A SPA fallback for `GET` requests that are (a) not an API route (`/auth/*`, `/lists/*`, `/items/*`, `/healthz`) and (b) not a request for an existing static file → respond with `distDir/index.html`.

The API routes and `/healthz` are registered **before** the static fallback so they take precedence. In development (`NODE_ENV !== 'production'`) none of this is mounted, so the Vite dev server flow is unchanged.

**Rationale**:
- Serving static files + SPA fallback from Express is the minimal change that delivers a single-origin deployment without a second container.
- Registering API routes first guarantees API behavior is byte-for-byte unchanged (Constitution §I/§II/§IV — no risk to privacy/authorization logic).
- Gating on `NODE_ENV === 'production'` keeps the dev workflow (separate Vite server on :5173) intact.

## D13: Testing strategy in the containerized deployment

**Decision** (per clarification Q2, 2026-09-22): Tests run from the **host** against the running container.
- **Backend unit/integration tests** (`npm --prefix backend run test`, 59 tests): continue to use their existing local-DB setup (`npm run dev:db` + local Postgres). The containerized deployment does **not** change how these run — the DB is not published to the host in the deployment, and re-architecting the backend test suite to target a container is out of scope. The containerized deployment is validated by the quickstart scenarios and the e2e suite, not by re-running the backend suite inside a container.
- **Frontend e2e (Playwright, 8 tests)**: point `baseURL` at `http://localhost:8080` (the containerized app origin) instead of `http://localhost:5173`. The 8 existing e2e tests remain the acceptance validation for the containerized deployment.

**Rationale**: This keeps the test infrastructure unchanged (no re-architecting) while making the containerized deployment the target of the browser/e2e validation, matching the clarification that tests run from the host against the running container.

## Open Questions (none — all resolved)

All NEEDS CLARIFICATION items from the plan's Technical Context section are resolved by the decisions above. No remaining unknowns.

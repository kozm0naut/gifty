# Agent Instructions

When starting a new session or if you are a fresh agent, please review the following directories to understand the project state, history, and specifications:

- `.agents/`: Contains ongoing memory, project state, and context for agents.
- `specs/`: Contains the formal specifications, plans, and tasks for the features being implemented.

### How to run the app (Docker)
The app ships as a single container (SPA + API) on one URL. From the repo root:

- **Start (build if needed): `npm run docker:up`**  *(= `docker compose up --build -d`)* → app at **http://localhost:8080**
- Health check: `GET http://localhost:8080/healthz` → `{"status":"ok"}`
- Stop (keeps data): `docker compose down` • Reset + wipe DB: `docker compose down -v`
- Requires `JWT_SECRET` (≥ 32 chars, non-default in production) and `POSTGRES_PASSWORD` (non-default in production) in the root `.env` — the boot gate (`validateConfig()`, spec 003 US3) fails fast at boot if either is missing/weak.
- Data is in the `gifty_postgres_data` volume; Postgres is internal-only (not published to the host).
- **Always re-run the e2e suite AFTER every rebuild** (`npm run docker:up`): the Docker build bakes the frontend into the image, so tests run against a stale bundle unless rebuilt first. Order: `npm run docker:up` → `cd frontend; $env:BASE_URL='http://localhost:8080'; npx playwright test` (BASE_URL is mandatory — helpers default to the dev port :4000). Watch for the container-startup race: if the very first test fails with `SocketError: other side closed`, wait for `/healthz` then re-run.

### How to run the app (dev mode)
For local iteration (hot reload, host-side tests) instead of Docker, from the repo root:

- **`npm run dev`** — starts Postgres via `dev:db` (dev override publishes `:5432` for host tests), then runs backend (`tsx watch`, **:4000**) and Vite (**:5173**, proxies `/auth`, `/lists`, `/items`, `/account` → `:4000`) concurrently → app at **http://localhost:5173**
- Backend tests: `cd backend; npm test` + `cd backend; npx tsc -p tsconfig.json --noEmit`. **`npm test` self-provisions its DB** via a `pretest` hook (`scripts/ensure-test-db.mjs`): it brings up the dev-overlay Postgres (publishes host `:5432`), ensures a dedicated **`gifty_test`** database exists, and pushes the Prisma schema — so it no longer needs `npm run dev:db` run first. The suite always targets `gifty_test` (set in `backend/vitest.config.ts`), never the live `gifty` app DB, so `npm test` can't wipe demo/dev data. Requires Docker running (it brings the container up if needed).
- Frontend unit: `cd frontend; npx vitest run` • e2e: `cd frontend; npx playwright test` (dev stack or `npm run docker:up` must be serving the app)
- Frontend typecheck: no local `tsc` in `frontend/` — reuse the backend's (Windows: `cd frontend; ..\backend\node_modules\.bin\tsc.cmd -p tsconfig.json --noEmit`)
- **GitHub Codespaces exception (verified 2026-09-24):** Codespaces DinD drops inter-container bridge traffic, so use `docker compose -f docker-compose.codespace.yml up --build -d` (host networking; app↔Postgres over loopback) instead of `docker compose up`. See `docs/docker.md` §3b.

### Crucial Files for Context
- **Project State & Memory**: `.agents/memories.md` tracks progress, current focus, and high-level implementation status.
- **Specifications & Planning**:
    - `specs/002-docker-deployment/`: **COMPLETE FEATURE** — `spec.md`, `plan.md`, `tasks.md`, `quickstart.md`, and `contracts/deployment.md` for the single-command Docker deployment (all 25 tasks `[x]`).
    - `specs/003-security-hardening/`: **IN-PROGRESS FEATURE** (branch `security-hardening`) — Phases 1–9 / US1–US7 done (rate limiting, password policy, secure defaults, boot gate, cookie-based sessions with refresh rotation + reuse detection, name-disclosure consent with pending invitations, recon-signal hardening: stable 5xx body + FR-010 uniform share responses + fingerprint checks, **and US7 audit trail + account removal** — audit wiring for `list_share`/`list_revoke`/`item_claim`/`item_purchase`/`item_revert` success+denied, `DELETE /account` cascade in `backend/src/account/removal.ts`, and the account area at the `/me` SPA route (NOT `/account`, which is the `GET /account` session-bootstrap API); T001–T050 `[x]`; US5 shipped `dd52a53` + `9bf2dfb`). US8 + polish (T051–T057) NOT started. A converge-ready gap note (owner-view enumeration leak: `GET /lists/:id` owner decoration + `PermissionManager.tsx`) sits in `tasks.md` before Phase 8. See `.agents/memories.md` for the detailed 003 status.
    - `specs/001-gift-list-sharing/spec.md`: **COMPLETE FEATURE** — the source of truth for the core gift-list-sharing requirements and user stories (implemented).
    - `specs/001-gift-list-sharing/plan.md`: The architectural plan for the core feature.
    - `specs/001-gift-list-sharing/tasks.md`: The dependency-ordered task list for the core feature (all marked `[x]`).
- **Core Backend Logic**:
    - `backend/prisma/schema.prisma`: The data model defining all entities and relationships.
    - `backend/src/permissions/access.ts`: Implements the critical privacy/visibility rules (`view` / `claim` / `manage`).
    - `backend/src/gift-lists/router.ts` + `backend/src/gift-items/router.ts`: The API and the owner-privacy filtering (data access is inline Prisma; **there is no `backend/src/storage.ts`** — that file no longer exists).
    - `backend/src/auth/middleware.ts`: session verification (cookie `gifty_access` JWT + session liveness check) + `requireAuth` / `authorizeList` / `authorizeItem`.
    - `backend/src/auth/session.ts`: server-side sessions — rotating `gifty_refresh` tokens, `previousRefreshHash` reuse (theft) detection, 30-day cap, `resolveSessionForAccess`.
    - `backend/src/config/index.ts`: `validateConfig()` boot gate (production refuses weak/missing `JWT_SECRET` and default `POSTGRES_PASSWORD`) + operator settings (rate-limit budgets, `CORS_ORIGINS`, `CSP_FONT_ORIGIN`).
    - `backend/src/audit/events.ts`: fire-and-forget `AuditEvent` writes (auth, share/claim/purchase, session revocation; `scrub()`s sensitive fields).
- **Core Frontend Logic**:
    - `frontend/src/App.tsx`: The main entry point, routing, and `ProtectedRoute`/`PublicRoute` guards (they wait on `isInitializing` rather than bouncing while the session bootstraps).
    - `frontend/src/services/api.ts`: Cookie-only HTTP client — **no localStorage, no `Authorization` header** (Bearer bridge retired in 003 US4); single-flight 401 → `POST /auth/refresh` → retry once; `stale_refresh` surfaces the FR-027 security notice; `fetchAccount()` / `logoutSession()`.
    - `frontend/src/context/AuthContext.tsx`: Session derived from `GET /account`; `sessionNotice` state (security vs plain) consumed by the sign-in page.
    - `frontend/src/components/GiftItemList.tsx`: Implements the privacy-aware item rendering logic.

Reviewing these is crucial to maintain continuity and follow the established development workflow.

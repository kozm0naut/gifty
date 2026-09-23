# Tasks: Docker Deployment

**Input**: Design documents from `/specs/002-docker-deployment/`

**Prerequisites**: plan.md ✅, spec.md ✅, research.md ✅, data-model.md ✅, contracts/deployment.md ✅, quickstart.md ✅

**Tests**: No new automated test authoring is required by the spec. Validation is done by (a) running the existing host-side suites against the containerized app (Playwright e2e, backend Vitest) and (b) executing the quickstart.md scenarios (V1–V8) as verification tasks.

**Organization**: Tasks are grouped by user story (US1 P1 → US2 P2 → US3 P3) to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2, US3)
- All tasks include exact file paths or exact commands

**Normative references** (consult before starting each phase):
- `contracts/deployment.md` — the four commands, the single URL (`http://localhost:8080`), env table, readiness signal, failure modes (normative)
- `research.md` — decisions D1–D13 (two-container topology, backend-serves-static, multi-stage build, `migrate deploy`, non-root, etc.)
- `data-model.md` — persistence invariants + deployment artifacts
- `quickstart.md` — V1–V8 validation scenarios
- Constitution §I/§II/§IV — privacy intact, state intact, security by default (non-root, no baked secrets, DB not host-published)

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Build-context and environment scaffolding required by every later phase.

- [x] T001 [P] Create root `.dockerignore` excluding `node_modules`, `**/node_modules`, `**/dist`, `.env`, `.env.*`, `**/tests`, `test-results`, `*.log`, `.git`, `specs/`, `.specify/`, `coverage` (research D9)
- [x] T002 [P] Create root `.env.example` documenting: `JWT_SECRET` (REQUIRED, no default, generate 32+ random chars — Constitution §IV), `POSTGRES_DB=gifty`, `POSTGRES_USER=gifty`, `POSTGRES_PASSWORD=gifty_dev_password`, `PORT=8080` (contracts/deployment.md §3); confirm `.env` remains git-ignored per `.gitignore`

**Checkpoint**: Build context is lean and the operator-facing env contract is documented.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Backend changes, image build pipeline, and compose stack that ALL user stories depend on.

**⚠️ CRITICAL**: No user story validation can begin until this phase is complete.

- [x] T003 Generate the initial Prisma migration: from `backend/`, start the dev DB (`npm run dev:db`), run `npx prisma migrate dev --name init`, verify `backend/prisma/migrations/` is created and committed (research D3/D11; data-model.md — schema MUST be applied via `migrate deploy` from committed migrations, never `db push` at boot)
- [x] T004 [P] Remove the `'development-secret'` fallback so a missing `JWT_SECRET` fails fast: `backend/src/auth/middleware.ts` (line 18) and `backend/src/auth/router.ts` (lines 34, 62) — read `process.env.JWT_SECRET` directly and throw a clear error ("JWT_SECRET is required") when unset; keep the existing production backstop in `backend/src/config/index.ts`; ensure the dev flow still works by adding `JWT_SECRET` to `backend/.env` if absent. **Immediately after this change, run `npm --prefix backend run test` and confirm the auth tests still pass** (all 8 backend test files set `process.env.JWT_SECRET='test-secret'`, so the change is safe — verify at the point of change per Constitution §III rather than deferring to Phase 6). (research D4; contracts/deployment.md §3 security rules)
- [x] T005 [P] Add `GET /healthz` to `backend/src/app.ts` returning `200 {"status":"ok"}` when the process is up; register it before any static fallback (research D6; contracts/deployment.md §4)
- [x] T006 Add production-only static serving + SPA fallback to `backend/src/app.ts`: when `NODE_ENV === 'production'` and the frontend `dist/` directory exists, register `express.static(distDir)` and a GET fallback serving `distDir/index.html` for non-API, non-asset routes (API paths `/auth`, `/lists`, `/items`, `/healthz` registered first and unchanged); dev flow (`NODE_ENV !== 'production'`) must be unaffected (research D2/D12)
- [x] T007 [P] Create root `entrypoint.sh`: `set -euo pipefail`, run `npx prisma migrate deploy`, then `exec node dist/src/server.js`. **Note (C1, verified 2026-09-22):** `backend/tsconfig.json` has `rootDir: "."` + `include` covering `tests`, so `tsc` emits `dist/src/server.js` (not `dist/server.js`) — the entrypoint MUST target `dist/src/server.js`. (research D3/D11; data-model.md lifecycle — migrations run before the server listens; a failed migration must surface as a startup failure without dropping data)
- [x] T008 Create root `Dockerfile` (multi-stage, build context = repo root; research D1–D3/D8/D9): stage 1 `node:22.x-alpine` — `frontend/`: `npm ci` + `vite build` → `dist/`; stage 2 `node:22.x-alpine` — `backend/`: **first move `prisma` from `devDependencies` to `dependencies` in `backend/package.json` (H1 — the CLI is needed by `prisma migrate deploy` in the prod runtime)**, then `npm ci` + `npx prisma generate` + `tsc` (emits `dist/src/` per C1) + `npm prune --omit=dev` (keeps `prisma` since it is now a dependency, and keeps the generated `@prisma/client`); runtime stage `node:22.x-alpine` — `COPY --from=build` the pruned `node_modules/`, backend `dist/` (incl. `dist/src/`), `prisma/`, `entrypoint.sh`, and frontend `dist/`; create/use non-root user (`USER node`, Constitution §IV), `ENV NODE_ENV=production PORT=4000`, `EXPOSE 4000`, `ENTRYPOINT ["/entrypoint.sh"]` (which runs `node dist/src/server.js`); no secrets baked in (env-injected only)
- [x] T009 Extend `docker-compose.yml` (rewrite in place; research D5/D7/D10; contracts/deployment.md §1–§4): remove `version: '3.9'`; `postgres` service — image `postgres:16.x-alpine` (minor-pinned per L3), env `POSTGRES_DB=gifty`, `POSTGRES_USER=gifty`, `POSTGRES_PASSWORD=${POSTGRES_PASSWORD:-gifty_dev_password}`, healthcheck `pg_isready -U gifty -d gifty`, volume `gifty_postgres_data:/var/lib/postgresql/data`, **no host port published** (DB internal-only, Constitution §I/§IV); `app` service — build context `.`, image tag `gifty-app`, env `DATABASE_URL=postgresql://gifty:${POSTGRES_PASSWORD:-gifty_dev_password}@postgres:5432/gifty?schema=public`, `JWT_SECRET=${JWT_SECRET}` (required — no default), `NODE_ENV=production`, `PORT=4000`, host port mapping `${PORT:-8080}:4000`, `depends_on: postgres: condition: service_healthy`, healthcheck `node -e "fetch('http://localhost:4000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"` (node:22-alpine has no curl; use built-in fetch); top-level `networks:` shared by both services
- [x] T010 [P] **Maintenance/parity task — maps to no FR/SC; justified by research D10 (preserve the existing `npm run dev:db` dev workflow).** Preserve the dev workflow after the compose rename: create `docker-compose.dev.yml` override re-exposing `5432:5432` on `postgres`; update the `dev:db` script in root `package.json` to `docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d postgres`; update `backend/.env` `DATABASE_URL` to `localhost:5432/gifty` with user `gifty` / password `gifty_dev_password` so `npm test` (backend) still passes (research D10)

**Checkpoint**: `docker compose config` parses cleanly; `cd backend && npx tsc --noEmit` passes; dev flow (`npm run dev:db` + `npm test`) still works.

---

## Phase 3: User Story 1 - Run the complete application with a single command (Priority: P1) 🎯 MVP

**Goal**: From a machine with only Docker, `docker compose up --build -d` yields the full app (SPA + API + DB) at `http://localhost:8080` with `GET /healthz` returning `200` within 2 minutes — no host dependency installs (FR-001/002/003, SC-001).

**Independent Test**: Clean Docker-only environment → start command → readiness poll → browser sign-up → list → share → claim all succeed (quickstart V1).

- [x] T011 [US1] Build + start + readiness validation: from repo root set `JWT_SECRET` in `.env`, run `docker compose up --build -d`, verify `docker compose ps` shows `postgres` healthy and `app` running, then poll until `curl -fs http://localhost:8080/healthz` returns `200 {"status":"ok"}` within 2 minutes (contracts/deployment.md §1/§4; quickstart Setup) — fix any Dockerfile/entrypoint/compose defects surfaced
- [x] T012 [US1] Full-flow browser validation (quickstart V1): at `http://localhost:8080` complete sign up → create list → add item → share with a second account → claim the item; every step succeeds and behaves identically to the dev setup; verify SPA deep links (e.g. `/list/:id`) survive a hard browser refresh (FR-002/003/012; research D2/D12)
- [x] T013 [US1] Privacy + integrity parity validation (quickstart V3/V4): as list owner confirm NO claim/purchase state or claimant identity is visible on own lists while the recipient sees full state (FR-011, Constitution §I/§II); attempt near-simultaneous claims of the same available item from two recipient sessions — exactly one succeeds (FR-012, Constitution §II)
- [x] T014 [P] [US1] Add convenience script `docker:up` in root `package.json` wrapping `docker compose up --build -d` (contracts/deployment.md §1 — optional, never required)

**Checkpoint**: US1 is fully functional and independently testable — the MVP. Stop here and demo if desired.

---

## Phase 4: User Story 2 - Data survives application restarts (Priority: P2)

**Goal**: All user data survives stop/start cycles via the `gifty_postgres_data` volume; the app refuses to start rather than serving a broken or empty store (FR-004/005/006, SC-003/SC-005).

**Independent Test**: Create data → `docker compose down` → volume still present → `docker compose up -d` → data intact for the correct users (quickstart V2).

- [x] T015 [US2] Restart persistence validation (quickstart V2): with V1 data present run `docker compose down`; confirm `docker volume ls` still shows `gifty_postgres_data`; run `docker compose up -d` and wait for readiness; log in with the V1 accounts and confirm all accounts, lists, items, sharing grants, and claim/purchase states are unchanged (FR-004/005; data-model.md invariants)
- [x] T016 [US2] Fail-fast validation — missing `JWT_SECRET` (quickstart V6): remove `JWT_SECRET` from `.env`, `docker compose down -v`, then `docker compose up --build -d`; startup MUST fail fast with a clear human-readable message and the app MUST NOT serve with a known/default secret (FR-006; Constitution §IV; contracts/deployment.md §6)
- [x] T017 [US2] Fail-fast validation — broken store / failed migration (US2 scenario 3, contracts/deployment.md §6): simulate Postgres failing its healthcheck (e.g. mismatch `POSTGRES_PASSWORD` in `.env` vs `DATABASE_URL`) and confirm `app` does not start and a clear startup failure is surfaced; confirm a failed migration exits non-zero with the error visible while existing data is NOT dropped (FR-006; data-model.md validation rules)

**Checkpoint**: US1 + US2 both work independently — persistence and safe-failure guarantees proven.

---

## Phase 5: User Story 3 - Reproducible, documented deployment (Priority: P3)

**Goal**: A clean machine (or CI) can reach a working app from documentation alone; stop and reset are one documented command each; the build is repeatable (FR-007/008/009/010, SC-004).

**Independent Test**: Follow only the root documentation on a clean Docker-only machine to a working app; run the build twice in clean environments with equivalent results (quickstart V8).

- [x] T018 [P] [US3] Create `docs/docker.md` — user-facing deployment guide: prerequisites (Docker + Compose only, FR-002/FR-010); generating `JWT_SECRET` into `.env`; the four commands (start `docker compose up --build -d`, ready-check loop on `http://localhost:8080/healthz`, stop `docker compose down`, reset `docker compose down -v`) per contracts/deployment.md §1; the single URL `http://localhost:8080`; failure modes (port 8080 conflict, missing `JWT_SECRET`, DB healthcheck failure) with the required clear-message behavior (§6); one-time volume migration note (old `postgres_data` → `gifty_postgres_data` means a fresh dev volume — dump/restore or accept reset, research D10); advanced backup command for the volume (research D5); dev-workflow note (`npm run dev` unchanged, `docker-compose.dev.yml` override)
- [x] T019 [P] [US3] **Create** `README.md` (none exists yet — verified) with a short "Docker deployment" section: pointer to `docs/docker.md` plus the one-command quickstart (`docker compose up --build -d` → open `http://localhost:8080`)
- [x] T020 [US3] Stop + reset validation (quickstart V7, FR-007/008): confirm `docker compose down` releases host port `8080` (verify nothing still listening); then `docker compose down -v` + `docker compose up --build -d` + readiness wait → a V1 account login MUST fail (data gone) and a fresh signup works (clean initial state)
- [x] T021 [US3] Reproducibility validation (quickstart V8, FR-009, SC-004): from a clean state (`docker compose down -v`), run the full Setup sequence again following only `docs/docker.md`; confirm a working app within the 10/15-minute bounds; run `docker compose build --no-cache` once to confirm a from-scratch build succeeds (first build may pull images; cached rebuild works offline)

**Checkpoint**: All three user stories independently functional — the deployment is documented, resettable, and reproducible.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Cross-story regression and acceptance validation.

- [x] T022 [P] Run the Playwright e2e suite (8 tests) from the host against the containerized app: `BASE_URL=http://localhost:8080 npm --prefix frontend run test:e2e`; if `frontend/playwright.config.ts` does not already read `baseURL` from the `BASE_URL` env var (defaulting to `http://localhost:5173`), update it (research D13; quickstart "Automated validation")
- [x] T023 [P] Run the backend suite (59 Vitest/Supertest tests) from the host: `npm test` — confirm the `development-secret` removal (T004), `/healthz` (T005), and static-serving changes (T006) broke nothing (research D13 — backend suite keeps its existing local-DB setup)
- [x] T024 Execute the full `quickstart.md` validation (V1–V8) end-to-end in order and tick its "Definition of Done" list; record any residual defects as new tasks before closing the feature
- [x] T025 [P] Security hardening sweep (Constitution §IV): verify `docker compose config` and the built image contain no secrets (`docker history` / inspect), the `app` container runs non-root (`docker compose exec app whoami`), and `postgres` has no published host port (`docker compose port`)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on Setup — **BLOCKS all user stories**; internal order: T003 → T004/T005/T007 (parallel) → T006 → T008 → T009 (T010 parallel)
- **User Stories (Phases 3–5)**: All depend on Foundational completion; proceed sequentially in priority order (US1 → US2 → US3) — each phase's validation builds on the running stack from the previous one
- **Polish (Phase 6)**: Depends on all three user stories being complete

### User Story Dependencies

- **User Story 1 (P1)**: Starts after Phase 2 — no dependencies on other stories
- **User Story 2 (P2)**: Starts after US1 (reuses the V1 data for the restart test)
- **User Story 3 (P3)**: Starts after US2 (reset validation must not destroy data needed for regression; docs reference the final command set)

### Within Each User Story

- Build/start (T011) before any browser or state validation
- Functional parity (T012) before privacy/integrity parity (T013)
- Persistence (T015) before destructive failure-mode validation (T016/T017)
- Documentation (T018/T019) before reproducibility-from-docs validation (T020/T021)

### Parallel Opportunities

- T001 ∥ T002 (Phase 1 — different files)
- T004 ∥ T005 ∥ T007 (Phase 2 — different files: auth code, app.ts, entrypoint.sh)
- T010 can run in parallel with T008/T009 (dev override is independent of the app image)
- T014 (optional convenience script) can run alongside US1 validation
- T018 ∥ T019 (Phase 5 — different docs)
- T022 ∥ T023 (Phase 6 — independent test suites)

---

## Parallel Example: Phase 2 (Foundational)

```text
# Wave 1 (parallel):
Task T004: Remove 'development-secret' fallback in backend/src/auth/middleware.ts + backend/src/auth/router.ts
Task T005: Add GET /healthz in backend/src/app.ts
Task T007: Create entrypoint.sh at repo root

# Wave 2 (sequential, after T005):
Task T006: Add production static serving + SPA fallback in backend/src/app.ts
Task T008: Create Dockerfile at repo root (needs the final app.ts surface + entrypoint.sh)
Task T009: Extend docker-compose.yml (healthcheck depends on /healthz)
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (T001–T002)
2. Complete Phase 2: Foundational (T003–T010) — **CRITICAL, blocks all stories**
3. Complete Phase 3: User Story 1 (T011–T014)
4. **STOP and VALIDATE**: single-command start, readiness within 2 minutes, full flow + privacy parity in the browser
5. Demo: `docker compose up --build -d` → `http://localhost:8080`

### Incremental Delivery

1. Setup + Foundational → foundation ready
2. US1 → validate independently → **MVP** (single-command app)
3. US2 → validate independently → persistence + safe failure guaranteed
4. US3 → validate independently → documented, reproducible, resettable deployment
5. Polish → host-side suites green against the container → feature done

### Notes

- [P] tasks = different files, no dependencies on incomplete tasks
- Every validation task names its quickstart scenario (V1–V8) so acceptance is traceable to `spec.md` success criteria
- Commit after each task or logical group
- The containerized deployment MUST NOT alter privacy/authorization behavior (FR-011) — if any task is tempted to weaken behavior to make packaging easier, it violates Constitution §I/§II/§IV and must be reworked

---

## Phase 7: Convergence

**Purpose**: Close residual gaps identified by `/speckit-converge` on 2026-09-23 (all prior phases complete; 0 critical/high findings — two partial evidence gaps on P3 story US3).

- [x] T026 Add a CI workflow (e.g. `.github/workflows/docker.yml`) that, on a clean runner, generates a `JWT_SECRET`, runs `docker compose up --build -d`, polls `GET http://localhost:8080/healthz` until `200`, and then runs the Playwright suite with `BASE_URL=http://localhost:8080` — supplying the genuine "different clean machine / fresh CI environment" evidence for SC-004 / US3-AC1 (quickstart V8) that T021 approximated with a same-machine `--no-cache` rebuild (partial). **Done 2026-09-23**: `.github/workflows/docker-deployment.yml` — clean-runner `docker compose up --build -d` → readiness poll (2-minute budget) → Playwright e2e (8 tests) against `http://localhost:8080`; runs on `main`/`docker-container` + PRs + manual dispatch
- [x] T027 Validate the offline leg of FR-009: with image and layer caches populated, disable Docker's network access (or use a network-isolated runner) and confirm `docker compose build` + `docker compose up -d` complete without any external download, then record the result against the quickstart Definition of Done (partial). **Done 2026-09-23**: `.github/workflows/offline-build.yml` — warm build, then `docker buildx build --network=none` (build sandbox network disabled; BuildKit fails the build if any step needs the network) with a pull-attempt guard, then `docker compose up -d` + readiness; local prerequisite verified 2026-09-23 (cache-served rebuild, all steps `CACHED`)

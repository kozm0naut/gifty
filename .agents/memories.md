# Project Overview: Gifty

Gifty is a web application designed for tracking and sharing gift lists. Its primary goal is to allow users to curate lists of desired gifts and share them with friends or family. The core innovation is the "surprise" element: while shared recipients can see the claim and purchase status of items to avoid duplicates, the list owner cannot see who has claimed or purchased what, preserving the surprise for them.
 
> **Status snapshot (2026-10-06):** `001-gift-list-sharing`, `002-docker-deployment`, `003-security-hardening`, and `004-email-integration` are all **COMPLETE** (004: T001–T035 `[x]`, backend 233/233, frontend unit 18/18, e2e 22/1). The app is deployed as a **single Docker container** (SPA + API + internal Postgres). **Start it with `npm run docker:up`** → http://localhost:8080 (health: `GET /healthz`).

## Completed Feature: `004-email-integration` (COMPLETE 2026-10-06)

Branch `email`; spec at `specs/004-email-integration/` (35 tasks T001–T035, all `[x]`; spec status `Implemented`). **Verification: backend 233/233 (30 files) + tsc clean; frontend unit 18/18 + tsc clean; Playwright e2e 22 passed / 1 skipped (disabled-mode) against `npm run docker:up` :8080.**

- **US1 (invite):** `enqueueInvite` in `backend/src/email/outbox.ts` (best-effort write *after* the share commits — not in-txn, so P2002 dedup recovery re-query works in autocommit); exactly one invite per (list, recipient), home-page link `{origin}/` (no token), owner response unchanged (uniform, feature 003).
- **US2 (confirmation + gate):** `verification.ts` (256-bit token, SHA-256 hash on `User.verificationTokenHash`, TTL `EMAIL_TOKEN_TTL_HOURS`); blocking gate `requireConfirmed` → unconfirmed `GET /lists` 403 `Please confirm your email to continue.`; `GET /confirm?token=` uniform 200 (used/expired/unknown indistinguishable, FR-010); resend rate-limited `RESEND_MAX_PER_ACCOUNT` per window.
- **US4 (reliable delivery):** durable `OutboxMessage` (Prisma schema + migration `20261005135626_email_integration`), drainer `drainOnce()` with backoff `retryBaseMs * 2^(N-1)`, terminal `failed` after `EMAIL_MAX_ATTEMPTS`, `reclaimStaleSending()` at-least-once, `stopDrainer()` async + awaited in `server.ts`.
- **US5 (capture stub):** `mailer.ts` `CaptureMailer` — zero network I/O, in-memory buffer + `capturedEmails()`/`resetCapturedEmails()`/`drainOnce()`/`setMailerForTest()` test hooks (active only in capture/test).
- **US6 (config + boot gate):** `config/index.ts` email block (`EMAIL_ENABLED`/`EMAIL_TRANSPORT`/`RESEND_API_KEY`/`RESEND_FROM`/`GIFTY_PUBLIC_ORIGIN` + retry/drain/token-tuning); `validateConfig()` production + enabled + no key (and no capture override) → refuse to boot naming `RESEND_API_KEY`; live mode requires valid `RESEND_FROM`; disabled mode boots + auto-confirms (warning).
- **Phase 9 (convergence, T030–T035):** `frontend/tests/e2e/email-integration.spec.ts` (4 tests; disabled scenario behind `E2E_EMAIL_MODE=disabled`, covered at API level by `confirmation.test.ts`); quickstart validated live via `scripts/quickstart-check.mjs` (Node fetch, exit 0 — US1/US2/US5 invariants); `docs/docker.md` §9 (3 modes + EMAIL_*/RESEND_* vars + boot gate); README "Email" section.
- **Gotchas (Phase 9):** Playwright test-scoped `request` fixture has NO cookies → use `page.request`; Playwright `fetch` `.ok` is a property (`.ok()` throws); **backend lowercases emails** (psql lookups use `lower("recipientEmail")`); PowerShell .NET refuses Secure-over-http cookies → use **Node fetch** for live validation; psql service is `postgres` (`docker compose exec -T postgres psql -U gifty -d gifty`); `helpers.ts` `apiRegister` auto-confirms unverified accounts via the captured token so pre-email e2e specs pass against the capture-mode stack. **CAUTION:** root `.env` has a live `RESEND_API_KEY` — `EMAIL_TRANSPORT=capture` MUST stay or real emails get sent.

## Completed Feature: `003-security-hardening` (COMPLETE 2026-10-02, PR #3)

Branch `security-hardening`; spec at `specs/003-security-hardening/` (66 tasks T001–T066, all `[x]`). **Verification: backend 176/176 + frontend unit 17/17 + e2e 19/19 (against `npm run docker:up` :8080) + tsc clean.**

- **Phase 1 (foundational, T001–T009)** — session engine + audit module: `backend/src/auth/session.ts` (rotating refresh tokens, `previousRefreshHash` reuse/theft detection, 30-day cap, `resolveSessionForAccess`), `backend/src/audit/events.ts` (13 actions, fire-and-forget, `scrub()`), `POST /auth/refresh` + `POST /auth/logout`; `requireAuth` is session-aware (cookie `gifty_access` OR legacy Bearer; session-liveness check when a `sid` claim is present). Migration `20260928182006_security_hardening`: `UserSession`, `AuditEvent`, `PendingInvitation` models + `SharePermission.recipientEmail`/`nameDisclosureConsent`.
- **Phase 3 (US1, T010–T018)** — rate limiting (`backend/src/auth/rate-limit.ts`: per-source + per-account budgets), password policy (`backend/src/auth/password-policy.ts`), cookie issuance (`gifty_access` signed JWT ~10 min; `gifty_refresh` opaque, path-scoped to `/auth/refresh`; both `HttpOnly`), AuthPage policy message.
- **Phase 4 (US2, T019–T021)** — closed-by-default CORS, CSP (font origin via `CSP_FONT_ORIGIN`), HSTS prod-only, `x-powered-by` off.
- **Phase 5 (US3, T022–T024)** — boot gate: `validateConfig()` (`backend/src/config/index.ts`, called from `server.ts` before listen) refuses missing/short/known-default `JWT_SECRET` and known-default `POSTGRES_PASSWORD` in production; `gifty_dev_password` default removed from `docker-compose.yml`/`docker-compose.codespace.yml`.
- **Phase 6 (US4, T025–T029, commit `bb2d6ef`)** — **cookie-based session rework; Bearer bridge retired (frontend no longer sends `Authorization`; zero localStorage).** `frontend/src/services/api.ts` (single-flight 401 → `POST /auth/refresh` → retry once; `stale_refresh` → FR-027 security notice; `fetchAccount()`/`logoutSession()`), `frontend/src/context/AuthContext.tsx` (bootstrap via `GET /account`; `sessionNotice` security-vs-plain), `frontend/src/pages/AuthPage.tsx` (alert-error vs alert-warning). `vite.config.ts` proxies `/auth` (bypass: HTML → SPA) + `/account` for dev.

- **Phase 7 (US5, T030–T039, `dd52a53` + `9bf2dfb`)** — name-disclosure consent + pending invitations: `SharePermission.nameDisclosureConsent` (pending/revealed/declined), `PendingInvitation` matched transactionally at registration, consent-aware claimant identity in `backend/src/common/identity.ts` + recipient self-serve control, one-time prompt.
- **Phase 8 (US6, T040–T043, `c88e4dc`)** — recon-signal hardening: stable 5xx body, FR-010 uniform share responses (registered vs unregistered indistinguishable), fingerprint checks.
- **Phase 9 (US7, T044–T050)** — **audit trail + account removal.** Audit wiring (`backend/src/gift-lists/router.ts` `list_share`/`list_revoke`; `backend/src/gift-items/router.ts` `item_claim`/`item_purchase`/`item_revert`) with `outcome` success **and** denied + trusted-proxy IP; removal cascade in `backend/src/account/removal.ts` (single txn: revoke sessions → clear claims to `available` → delete owned lists → delete recipient perms → delete user; `account_removal` audit row inside txn, `actorUserId` nulls via FK SetNull) + `DELETE /account` (204 + both cookies cleared; 401 unauth) in `app.ts`. Frontend: `AccountPage.tsx` at the **`/me`** SPA route (NOT `/account` — that path is the `GET /account` session-bootstrap API and Express serves it before the SPA fallback), `deleteAccount()` in `api.ts`, `removeAccount` in `AuthContext`, nav "Account" link. **Committed + pushed 2026-09-30 as `bb4006d` on `security-hardening`** (`c88e4dc..bb4006d`, 24 files).

- **Phase 10 (US8, T051–T053, 2026-10-01)** — supply chain clean (FR-015/SC-006). **Fix:** backend had 3 **high** (`deepmerge-ts@7.1.5` via `prisma`→`@prisma/config`); `npm audit fix` could NOT resolve it — every *stable* Prisma (6.19.3 *and* 7.10.0) pins `deepmerge-ts@7.1.5`; the fix (`deepmerge-ts@8.0.2`) only ships in Prisma 8 (RC). Did **not** bump to a Prisma 8 RC. Instead added `"overrides": { "deepmerge-ts": "^8.0.2" }` to `backend/package.json` (verified `@prisma/config` still works: `prisma validate`/`generate` OK, backend 169/169, image builds, e2e 18/18). **Frontend** = 2 **moderate** only (`react-router`/`react-router-dom`) — out of scope for the high/critical gate; NOT upgrading `react-router-dom` v6→v7 (breaking). **Gate:** root `package.json` now has `audit:prod` = `npm --prefix backend audit --omit=dev --audit-level=high && npm --prefix frontend audit --omit=dev --audit-level=high` + `audit` alias; **T051 proven** the gate blocks (exit 1) on a high finding (scratch `lodash@4.17.15`) and passes (exit 0) once fixed. `npm run audit` exits 0. **Frontend moderates explicitly accepted (2026-10-01):** `react-router` (via `react-router-dom@6.28.0`) has 2 moderate advisories — GHSA-wrjc-x8rr-h8h6 (open redirect via backslash, CWE-601, CVSS 5.1) and GHSA-337j-9hxr-rhxg (SSR hydration constructor injection, CWE-470, CVSS 6.1). Both patched only in v7.18.0 (breaking). Neither affects our declarative client-side SPA (no SSR; navigation targets are hard-coded / server-generated UUIDs). Accepted per FR-015 "explicitly accepted" path; revisit when/if we upgrade `react-router-dom` to v7.

- **Audit-log review decision (2026-09-30):** A `Deleted_User_<id>` placeholder for the actor on removal was **explicitly rejected** — `AuditEvent.actorUserId` is a real FK to `User.id` (`onDelete: SetNull`), so a non-user placeholder can't satisfy it and dropping the FK was not worth it. **Keep null + FK.** The (future) **frontend audit-log review UI** will handle null actors and identify deleted users *after the fact* by cross-referencing the authoritative `account_removal` rows (`targetId` = removed user id) and joining `targetId`/`detail.recipientUserId` against the live user table. **`scripts/audit-query.sql` + `scripts/audit-cols.sql` + `scripts/show-audit.ps1` are KEPT (not temp)** until that audit-review frontend is built — run via `Get-Content scripts\audit-query.sql | docker compose exec -T postgres psql -U gifty -d gifty -X -f -`.

**Verification (final, 2026-10-02):** backend **176/176** (24 files) + tsc clean; frontend unit **17/17** + tsc clean; Playwright e2e **19/19** against `npm run docker:up` (http://localhost:8080). One-approval validation: `npm run verify` (rebuild → `/healthz` wait → `test:e2e:container`) + `npm run e2e` (no rebuild). Supply-chain gate green: `npm run audit` exits 0 (US8, T051–T053 done — see Phase 10 entry above).

**Phases 11–14 (convergence, 2026-10-01 → 2026-10-02):** Phase 11 polish (T054–T057) + Phase 12 uniform owner share view / enumeration fix (`GET /:id/share-permissions` now returns one uniform `permissions` array — registered + pending merged, invite-ordered, no `recipientUserId`/`consent`) + test isolation (T058–T062). **Phase 13 convergence (T063–T065):** FR-029 "Shared with" ordering rule pinned in `spec.md` + `contracts/api.md` (revealed-alphabetical → self-if-masked → remaining in invite order; position must not leak registration status); FR-013 append-only audit tests (no `updatedAt`, no mutation path, no route handler); `plan.md` note that `scripts/ensure-test-db.mjs` is dev/test-only. **Phase 14 convergence (T066):** 3 ordering regression tests (self-contained fixtures in `gifty_test`). `scripts/demo-phase12.mjs` removed. Second converge pass: **converged, 0 findings**.

**Gotchas (this feature):**
- `cookie` package pinned `^2.0.1` — named exports only (`parseCookie`, `stringifySetCookie`); no default export.
- `rotateSession` ordering: token-not-found → `stale_refresh` (checked FIRST), then `revoked`, then `expired`, then reuse-detection. A rotated-out token always yields `stale_refresh`; a current token on a revoked session yields `revoked`.
- Never test the boot gate with `docker compose --env-file X up app` on the live stack — it REPLACES root `.env` (blank `POSTGRES_PASSWORD`) → crash-loop. Rely on `backend/tests/unit/boot-gate.test.ts`.
- Backend tests self-provision: `npm test` runs the `pretest` hook (`scripts/ensure-test-db.mjs`) which brings up the dev-overlay Postgres, ensures the isolated `gifty_test` DB, and pushes the Prisma schema — never touches the live app DB. `scripts/ensure-test-db.mjs` is dev/test-only, not in the production image (see `plan.md` test-infra note).

## Codespaces 502 fix (2026-09-24, CONFIRMED)

**Symptom:** In a GitHub Codespace, the app crash-looped — `prisma migrate deploy` → `P1001: Can't reach database server at postgres:5432` on every attempt — while postgres was `healthy`; browser showed 502.

**Confirmed root cause (Codespace diagnostic, 2026-09-24):** Codespaces' **Docker-in-Docker drops inter-container traffic on user-defined bridge networks**. Evidence from the Codespace: `DNS-OK 172.18.0.2` (name resolves) + postgres healthy on `0.0.0.0:5432` + 12/12 migration attempts `P1001` = DNS works but raw TCP to the bridge IP is **dropped, not refused**. Not a code bug — never reproduces on Docker Desktop (Windows/macOS), where bridge networking works.

**Fix (committed `52c0e70`):**
- **`docker-compose.codespace.yml` (NEW, the real fix)**: both services run with `network_mode: host`, so the app reaches Postgres over **loopback** `127.0.0.1:5432` (never filtered) and binds 8080 directly. Same image, same `gifty_postgres_data` volume, same required `JWT_SECRET`. **Start in Codespaces:** `docker compose -f docker-compose.codespace.yml up --build -d`.
- `entrypoint.sh`: `prisma migrate deploy` retries 12× with 5s backoff (helps transient warm-up; does NOT fix the bridge block).
- `docker-compose.yml`: postgres healthcheck now `pg_isready -h postgres ...` (TCP path, not unix socket).
- Default `docker-compose.yml` otherwise unchanged — local dev + CI keep the bridge topology.

**Status: CONFIRMED WORKING in a real GitHub Codespace (2026-09-24, user verified).** Docs updated: `docs/docker.md` §3b + `AGENTS.md` note the Codespaces exception.

## Completed Feature: `002-docker-deployment` (2026-09-23)

**COMPLETE** — all 25 tasks (`T001`–`T025`) marked `[x]` in `specs/002-docker-deployment/tasks.md`, quickstart V1–V8 validated end-to-end, Definition-of-Done checklist ticked, committed on branch `docker-container` (commit `f5903fb`).

- **Topology**: two-container compose project `gifty` — `app` (serves the SPA static build + API; host `${PORT:-8080}` → container `4000`; non-root `USER node`; `GET /healthz` readiness; `prisma migrate deploy` in `entrypoint.sh` before the server listens) + `postgres` (`postgres:16.9-alpine`, internal-only, **no host ports**, healthcheck `pg_isready`, named volume `gifty_postgres_data`). Single URL: `http://localhost:8080`.
- **Image**: multi-stage `Dockerfile` (build context = repo root), pinned `node:22.16.0-alpine` for all stages; frontend `npm ci` + `vite build`; backend `npm ci` + `prisma generate` + `tsc` (emits `dist/src/`) + `npm prune --omit=dev`; runtime stage `COPY --from=build` of `node_modules/`, `dist/`, `prisma/`, `frontend/dist/`, `entrypoint.sh`. No secrets baked in (verified via image Env).
- **Security (Constitution §IV)**: `development-secret` fallback removed — `backend/src/auth/{middleware,router}.ts` read `JWT_SECRET` directly and throw `'JWT_SECRET is required'`; `backend/src/server.ts` now calls `validateConfig()` (from `config/index.ts`) before `app.listen`, so missing/blank `JWT_SECRET` in production fails fast (`Configuration validation failed: JWT_SECRET must be set in production`). Verified: fail-fast restart loop, never serves.
- **Dev workflow preserved**: `docker-compose.dev.yml` re-exposes `5432` for host-side backend tests; root `npm run dev:db` = `docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d postgres`.
- **Key defects fixed this session**: (1) `Dockerfile` runtime stage had `WORKDIR` written as an `ENV` value → files landed in `/` → `prisma migrate deploy` failed (`Could not load --schema from app/prisma/schema.prisma`); fixed with a real `WORKDIR /app`. (2) `validateConfig` was dead code until wired into `server.ts`. (3) Four stale Playwright assertions (`'Mark as Purchased'` → `'Purchased'`; recipient self-purchase badge resolves to `BY YOU`) — UI was correct; tests updated per user ruling.
- **Test evidence**: backend **80/80** (host DB via dev-override postgres); frontend e2e **8/8** vs `http://localhost:8080` (`BASE_URL` env, `playwright.config.ts` now reads `BASE_URL`); frontend unit 2/2; duplicate-claim race `[200, 409]`; owner privacy verified in browser + e2e.
- **Env hygiene**: root `.env` holds the real `JWT_SECRET` (48 chars, git-ignored via `.gitignore:6`); `.env.example` documents the contract; `.env.bak` removed. Temp scripts (`t017.ps1`, `t020.ps1`, `v5-conflict.yml`) cleaned up.

### Prior spec status (superseded)
Spec was written/clarified/validated 2026-09-22; `plan.md` + `tasks.md` were generated and then fully implemented on 2026-09-23. (The spec header's `Status` was corrected to `Implemented` on 2026-09-23.)

---

## Historical: `002-docker-deployment` starting point

Feature `001-gift-list-sharing` is **COMPLETE** (all 59 backend tests + 8 Playwright e2e tests passing, all tasks marked `[x]`, spec status `Implemented`). The project then moved to **Docker deployment**: packaging the full application (frontend, backend, database) into containers so it can be started with a single command on any machine with Docker installed.

### Key Clarifications (Session 2026-09-22)

1. **Readiness signal**: The application MUST expose a dedicated health/readiness endpoint (FR-013) that operators and tests poll to detect when the app is fully started.
2. **Test scope**: The container runs the application only; automated test suites (backend + frontend) are executed from the host machine against the running container.
3. **Offline builds**: First build may require network access to pull base images; subsequent builds (with cached images) work offline.

### Starting Point

- A `docker-compose.yml` already exists at the repo root — currently it only defines a **PostgreSQL 16** service (`gifty-postgres`, port 5432, volume `postgres_data`). The containerization work needs to extend this (or replace it) to include the backend and frontend services, build from `Dockerfile`s, wire them together, and provide the documented start/stop/reset commands.

## Completed Feature: `001-gift-list-sharing`

The foundational feature set for Gifty was implemented using a spec-driven approach (Spec Kit). All user stories (US1–US5) are functionally implemented (US5 state management is delivered by the US4 lifecycle implementation). **Phase 7: Validation & Polish** is complete — the entire backend validation track (SC-003–SC-006, concurrency/race, hardening, docs/contracts, DB-backed storage) is done and verified (59 backend tests passing across 8 files, confirmed 2026-09-15). The **frontend e2e track** (T035–T038, plus the frontend portions of T025/T044) was validated **manually in-browser** and is now **automated with Playwright** (`frontend/tests/e2e/`, 8 tests passing). All tasks in `tasks.md` are marked `[x]`.

### Core Specification Details

- **Primary User Stories**:
    - **US1: Account & List Management**: Users can register, create, and manage their personal gift lists.
    - **US2: Item Management**: Users can add and manage gift items within their lists.
    - **US3: List Sharing**: Users can invite specific recipients to a list with granular permissions.
    - **US4: Private Claiming/Purchasing**: Recipients can claim or mark items as purchased. This information is visible to other recipients but strictly hidden from the list owner to maintain the surprise.
    - **US5: State Management**: A robust lifecycle for items: `available` $\rightarrow$ `claimed` $\rightarrow$ `purchased`.

- **Key Constraints & Privacy Rules**:
    - **Privacy-by-Default**: List owners have zero visibility into the claim/purchase state of their own items.
    - **Recipient Visibility**: Shared recipients have full visibility into the claim/purchase states of items on their shared lists to facilitate coordination.
    - **Concurrency Control**: The system must handle simultaneous claim/purchase attempts atomically to prevent duplicate claims.
    - **Immutability**: Once an item is added to a list, its core details cannot be modified by the owner to prevent breaking existing claims/purchases.

### Implementation Plan & Status

The project is being built with a **Node.js/TypeScript backend** (using Express/NestJS patterns and Prisma/PostgreSQL) and a **React/Vite frontend**.

**Progress Summary** (as of 2026-09-15):
- [x] **Phase 1: Setup**: Infrastructure and dev tooling initialized.
- [x] **Phase 2: Foundational**: Core domain schema, authentication (JWT), API routing, and permission utilities implemented.
- [x] **Phase 3: US1 (Account & List Management)**: User and GiftList domain models, services, and basic UI/dashboard are complete.
- [x] **Phase 4: US2 (Item Management)**: Core domain models, validation, and item creation APIs are implemented. UI for item management is complete.
- [x] **Phase 5 (US3 List Sharing)**: SharePermission model, share/revoke endpoints, deny-by-default enforcement, and owner-side invite/permission UI (`PermissionManager.tsx`) are complete. T019A is complete: backend cascade cleanup is in place, and the frontend "List Deleted" placeholder is implemented in `frontend/src/pages/ListPage.tsx` (renders when the list returns 404).
- [x] **Phase 6 (US4 Private Claiming)**: Atomic `available -> claimed -> purchased` lifecycle (plus unclaim/unpurchase reverts) is implemented in `backend/src/gift-items/router.ts` via conditional `updateMany`; owner-privacy filtering hides state/claimant from the owner in both `gift-lists/router.ts` and `gift-items/router.ts`; recipient claim/purchase UI is in `GiftItemList.tsx`. US5 (state management) is delivered by this same implementation. T025 is complete: backend coverage (including the SC-004 concurrency/race test in `sc-validation.test.ts`) + frontend e2e in `frontend/tests/e2e/lifecycle.spec.ts` (2 tests passing).
- [x] **Phase 7: Validation & Polish**: Backend track complete and verified — T031–T034 (SC-003–SC-006) and the T032 concurrency/race test pass in `backend/tests/sc-validation.test.ts`; T039 (API docs + contract suite, 26 tests), T040 (quickstart validation — full backend suite of 59 tests passing), T041 (hardening: request logging, security headers, CORS restriction, body limit, 404 handler, error-shape fix), T042 (audit — found and fixed a dashboard privacy leak in `GET /lists`), T043 (Prisma-backed storage), T044 (persistence tests via `persistence.test.ts` + `frontend/tests/e2e/persistence.spec.ts`) are all complete. Frontend e2e track (T035–T038) validated **manually in-browser** on 2026-09-15 and **automated with Playwright** (`frontend/tests/e2e/`, 8 tests passing): T035 (share & claim UX), T036 (duplicate-claim conflict), T037 (owner privacy visibility), T038 (lifecycle reverts + permission revoke).

### Technical Stack

- **Backend**: Node.js, TypeScript, Express, Prisma, PostgreSQL, JWT auth.
- **Frontend**: React, Vite, TypeScript, React Router.
- **Testing**: Vitest + Supertest for backend integration tests (in `backend/tests/`, 59 tests). Playwright for frontend e2e (in `frontend/tests/e2e/`, 8 tests). Run e2e: `npm --prefix frontend run test:e2e` (servers must be running).

## Observations & Strategy

- **Spec-Driven Development**: Feature `001-gift-list-sharing` was built from `specs/001-gift-list-sharing/` (`spec.md`, `plan.md`, `tasks.md`, `data-model.md`). Feature `002-docker-deployment` (`specs/002-docker-deployment/`) is **complete** — spec, plan, and tasks all done; see the `002-docker-deployment` section above.
- **Spec Kit Workflow**: Each feature is tracked via its own `tasks.md`. We use `spec-kit` to ensure consistency between the specification, the plan, and the actual tasks. `001` + `002` complete (2026-09-23); `003-security-hardening` is in flight (T001–T050 done as of 2026-09-30; US8 + polish remaining).
- **Privacy Enforcement (implemented)**: The visibility matrix is enforced at the backend. `backend/src/gift-lists/router.ts` and `backend/src/gift-items/router.ts` strip `claimantUserId`/`purchaserUserId` and force `state: 'available'` when the requester is the list owner, so the owner never sees claim/purchase state. Recipients see full state. The frontend (`GiftItemList.tsx`) additionally hides state/actions from the owner via the `isOwner` prop.
- **Data Integrity (implemented)**: Atomic state transitions use conditional `updateMany` (e.g., `where: { id, state: 'available' }`) in `backend/src/gift-items/router.ts`, so concurrent claim/purchase/unclaim/unpurchase attempts resolve to exactly one winner. The dedicated concurrency/race test (T032 / SC-004) is implemented and passing in `backend/tests/sc-validation.test.ts`.
- **Storage (implemented)**: All persistence is Prisma-backed, called inline from the routers (T043 complete). The legacy `backend/src/storage.ts` file was **deleted** during the dead-code cleanups (the `makeId` helper now lives in `backend/src/common/id.ts`). Persistence is covered by `backend/tests/persistence.test.ts`.

## Next Steps

- `001-gift-list-sharing` — **COMPLETE** (all tasks `[x]`, 59 backend + 8 e2e tests passing).
- `002-docker-deployment` — **COMPLETE** (all 25 tasks `[x]`, quickstart V1–V8 validated, merged to `main` 2026-09-23).
- `003-security-hardening` — **IN PROGRESS** (branch `security-hardening`; T001–T050 `[x]` as of 2026-09-30, T051–T057 `[ ]`). **Next: Phase 10 = US8 (supply-chain audit gate, T051–T053) + Phase 11 polish (T054–T057) — require explicit user go-ahead before starting.** See the 003 section above for details.

**Operational notes for anyone resuming in this repo**:
- **Start the app (it is now a Docker container): `npm run docker:up`**  *(= `docker compose up --build -d`)* → app at **http://localhost:8080** (health: `GET /healthz`).
- Stop: `docker compose down` (data retained). Reset: `docker compose down -v` (data wiped).
- Requires `JWT_SECRET` in the root `.env` (no default; the app fails fast at boot without it).
- Host-side backend tests: `npm run dev:db` (exposes `:5432` via `docker-compose.dev.yml`) → `npx prisma migrate deploy` (from `backend/`) → `npm --prefix backend run test`.
- Frontend e2e against the container: `BASE_URL=http://localhost:8080 npm --prefix frontend run test:e2e`.
- The local dev DB was wiped during the V7 reset validation (2026-09-23) — previously documented demo/e2e accounts are gone; fresh accounts are created by tests as needed.

## Recent Design Work (2026-09-15, not tracked in tasks.md)

- Full design-system overhaul: Google Fonts (Chango logo + Bricolage Grotesque display + Manrope body), CSS design tokens in `frontend/src/index.css`, header redesign (brand left, nav right, no tagline), and restyling of all pages/components (cards, buttons, badges, alerts, empty states).
- **Brand mark redesign**: the logo mark is now a gift-box SVG (magenta `#c026d3` → orange `#f97316` gradient, black `#111` stroke, white ribbon) extracted into a reusable `frontend/src/components/BrandMark.tsx` (uses `useId()` for unique per-instance gradient IDs to avoid collisions). Used in the header brand link (`App.tsx`) and as a large hero on the auth screen (`.auth-brand` / `.auth-brand-mark` / `.auth-brand-title` in `index.css`). **Note**: the user subsequently undid some `AuthPage.tsx` edits and made their own `index.css` changes — re-read both files before further design edits.
- "Manage Sharing" is a modal on the list page (route `/list/:listId/sharing`), rendered by `frontend/src/components/PermissionManager.tsx` inside `frontend/src/pages/ListPage.tsx`, reached via a button on the list page.
- List page share UI: circular share icon button (person + plus) with a recipient avatar stack (initials circles, deterministic color per name, +N overflow) to its left; owner-only.

## Bug Fixes (2026-09-16)

- **"Mark as Purchased" button visible to non-claimant recipients (FIXED)**: In `frontend/src/components/GiftItemList.tsx`, the recipient-only "Mark as Purchased" button was gated only on `item.state === 'claimed'`, so *any* recipient saw it on a claimed item — even one they didn't claim. The backend already correctly rejects non-claimants with `403` "Only the claimant can purchase this item" (`backend/src/gift-items/router.ts`), but the UI should hide the button. **Fix**: added `&& item.claimantUserId === currentUserId` to the button condition, matching the existing pattern used by "Revert Claim" (`claimantUserId === currentUserId`) and "Revert Purchase" (`purchaserUserId === currentUserId`). **Verified in-browser**: Alice (non-claimant recipient) now sees only the "claimed" badge on Jane's Robot Vacuum (no button); Jane (the claimant) still sees "Mark as Purchased" + "(You claimed this)" + "Revert Claim".
- **Auth race condition on full page load (FIXED)**: In `frontend/src/context/AuthContext.tsx`, `isAuthenticated` was initialized to `false` and set to `true` in a `useEffect` (which runs after first render). On a full page load (e.g., `page.goto('/list/:id')`), the first render saw `isAuthenticated === false`, `ProtectedRoute` redirected to `/auth`, then the effect flipped the flag and `PublicRoute` bounced the user to the dashboard. **Fix**: moved the localStorage read into the `useState` initializer so `isAuthenticated` is correct on the very first render. This also fixes the real-world UX issue where users doing a hard refresh on a list page would be bounced to the dashboard.

## Spec/Code Cleanup (2026-09-17)

Addressed the spec/implementation mismatches and dead code flagged during the full-project review. **All 59 backend tests still pass (8 files) after the changes.**

- **Spec corrections (docs only, no code change)**:
  - `specs/001-gift-list-sharing/data-model.md`: removed the invalid `available -> purchased` transition (the implementation correctly requires claim-before-purchase per FR-008); added the `purchased -> claimed` revert transition; clarified "no direct available -> purchased path".
  - `specs/001-gift-list-sharing/contracts/gift-list-api.md`: `POST /auth/login` now documents `token` (was `sessionToken`) + `user`; `POST /lists/{listId}/share` permission is now `"shared"` (was `view|claim|manage`) and accepts `recipientEmail`; `PATCH /items/{itemId}` now documents the 403 immutability rejection (was a mutable update); `POST /items/{itemId}/claim` documents `claimantUserId` as optional/must-match-authenticated-user; `POST /items/{itemId}/purchase` documents no body (purchaser = authenticated claimant).
- **Dead code removed**:
  - Deleted `backend/src/gift-items/gift-item.repository.ts` (only its `GiftItemState` type was imported, by `gift-item.validation.ts`). Inlined `export type GiftItemState = 'available' | 'claimed' | 'purchased'` into `gift-item.validation.ts`.
  - `backend/src/storage.ts` reduced to just the `makeId()` helper (the only export still imported). Removed the legacy JSON-storage types (`User`/`GiftList`/`GiftItem`/`SharePermission`/`StorageState`), `getDefaultStorage`, `getStorageFilePath`, `loadStorageFromDisk`, `persistStorage`, and `createStorage`.
  - Removed the unused `_storage: StorageState` parameter from `createAuthRouter`, `createItemRouter`, `createListRouter`, and removed the now-pointless `const storage = await createStorage()` call + `createStorage` import from `backend/src/app.ts`. Routers now take no args.

## Second Review Cleanup (2026-09-17)

Addressed the 8 remaining items from the full re-review. **All 59 backend tests still pass (8 files) after the changes.**

- **Spec correction**: `specs/001-gift-list-sharing/data-model.md` SharePermission table `permission` enum corrected from `view, claim, manage` to the single `shared` level (matches Prisma schema + implementation); validation rule reworded to describe the single `shared` level.
- **Dead code removed**: `backend/src/gift-items/gift-item.validation.ts` — removed the unused `UpdateGiftItemDto` type, `validateUpdateGiftItem()`, and the now-orphaned `GiftItemState` type (items are immutable; PATCH/DELETE always 403). Only `CreateGiftItemDto` + `validateCreateGiftItem` remain.
- **Artifact removed**: deleted unreferenced `frontend/src/index_old.css` (11.7 KB; only `./index.css` is imported in `main.tsx`).
- **Dead prop removed**: `frontend/src/pages/NewListPage.tsx` — removed the unused `onListCreated` prop (never passed by any caller); the component now always navigates to the new list.
- **Doc fixes**: `specs/001-gift-list-sharing/tasks.md` — replaced the stale "An automated e2e framework is still not set up for regression" line with a note that T035–T038 are automated in Playwright (8 tests). `specs/001-gift-list-sharing/spec.md` — `Status` updated from `Draft` to `Implemented`. `.agents/memories.md` — corrected the `ManageSharingPage.tsx` reference (that file does not exist; the sharing UI is a modal in `ListPage.tsx` via `PermissionManager.tsx`).
- **Housekeeping**: added `test-results/` to root `.gitignore` and removed the leftover `frontend/test-results/` Playwright artifact.

## Final Dead-Code Cleanup (2026-09-17)

Addressed the last two dead-code items from the re-review. **All 59 backend tests still pass (8 files) after the changes.**

- **`backend/src/config/index.ts`**: removed the unused `config` object (`port`/`jwtSecret`/`nodeEnv`/`databaseUrl` were never imported — `server.ts` and the routers read `process.env` directly). `validateConfig()` now reads `process.env` inline. This also removed the misleading `port: 3000` default (the real default is 4000 in `server.ts`).
- **`backend/src/common/errors.ts`**: removed the unused `AppError` class (never instantiated; `errorHandler` reads `(err as any).status` generically).

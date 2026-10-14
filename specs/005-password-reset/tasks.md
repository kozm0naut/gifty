# Tasks: Password Reset

**Input**: Feature specification from `/specs/005-password-reset/spec.md`

**Prerequisites**: plan.md, research.md (D1–D11), data-model.md, contracts/api.md, quickstart.md — all present.

**Tests**: **MANDATORY** for this feature — Constitution Principle III (Test-First Delivery) requires automated coverage for account-flow changes, and the plan's Constitution Check commits to it. Tests are written **before** the implementation they cover and must be seen failing first.

**Organization**: Tasks are grouped by user story so each story can be implemented, tested, and shipped independently. US1 is the MVP; US2 is the hardening layer on top.

## Format: `[TaskID] [P?] [Story?] Description with file path`

- **Checkbox**: every task starts with `- [ ]`.
- **[P]**: present only when the task is parallelizable (different files, no dependency on an incomplete task).
- **[Story]**: present for user-story phase tasks only (`US1`, `US2`); Setup / Foundational / Polish carry no story label.
- **File path**: exact absolute-relative path in the description.

## Path Conventions

- `backend/…` — Node 22 + TypeScript 5 (strict) + Express 4 + Prisma 6, ESM (`.js` import suffix). Auth endpoints live under the existing `/auth` router mounted at `app.use('/auth', createAuthRouter())` in `backend/src/app.ts:131`.
- `frontend/…` — React 18 + Vite 6. Public (no-session) pages mount as bare `<Route>` like the existing `/confirm` at `frontend/src/App.tsx:141`.
- **No new dependencies.** One additive Prisma migration. Cookie-only client — no `Authorization` header, no token in `localStorage` (003 US4 invariant).

## ⚠️ Warnings & Guidelines

- **Blocking**: T002 (migration) gates every test + implementation task — the `PasswordResetToken` table and `OutboxKind.reset` enum value must exist and the Prisma client regenerated before anything can seed or assert against them.
- **TDD**: each user-story phase lists its failing tests first; implement only until those tests pass.
- **Uniform response `U`** (pinned, `contracts/api.md`): `{"message":"Please check your email for the password reset link"}` — returned for registered / unregistered / malformed email, and reused by the 429.
- **Uniform invalid `I`** (pinned): `{"message":"This reset link is invalid or has expired."}` — one body for the whole unknown / expired / already-consumed class (FR-004). Never a distinct status or detail.
- **Policy `P`**: mirror the registration policy message — reuse `PASSWORD_POLICY_MESSAGE` from `backend/src/auth/password-policy.ts` (003 FR-002).
- **No raw token / password / hash** in any response, log, or audit `detail` (FR-006). Store only `tokenHash` (SHA-256 hex).
- **Policy/mismatch rejections MUST NOT consume the token** (FR-003) — the policy + confirm-match checks run before the atomic single-use claim.
- **Atomic success order (D7)**: claim token → rewrite `passwordHash` → set `verifiedAt` if null → revoke all other sessions → invalidate sibling pending tokens → `createSession`. Order matters: revoke before create so the fresh session survives.
- **Rate limiting**: throttle check happens **before** any account lookup; counts every request; the unregistered path still runs one `bcrypt.compare` for timing equalization (FR-002 / SC-002).
- **Test DB**: backend tests self-provision `gifty_test` via the `pretest` hook (`scripts/ensure-test-db.mjs`; requires Docker). Keep `EMAIL_TRANSPORT=capture` (root `.env` has a live `RESEND_API_KEY`).
- **NEVER** test the boot gate with `docker compose --env-file X up app` (it blanks `POSTGRES_PASSWORD` and crash-loops the live stack).
- **Backend lowercases emails** — canonicalize (trim + case-fold) before any reset lookup.

---

## Phase 1: Setup

**Purpose**: Establish a green baseline so post-change failures are attributable to 005, not pre-existing breakage.

- [ ] T001 Verify the pre-005 baseline is green: `cd backend; npm test; npx tsc -p tsconfig.json --noEmit` and `cd frontend; npx vitest run` (record counts; existing suites in `backend/tests/` and `frontend/src/` must pass before any 005 change).

**Checkpoint**: Baseline green — 005 changes are now attributable.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Shared schema + plumbing that both user stories depend on. No story work starts until this is complete.

**⚠️ CRITICAL**: T002 blocks everything else. T003–T007 are independent and parallelizable.

- [ ] T002 Add the `PasswordResetToken` model, the `reset` value to the `OutboxKind` enum, and the `User.passwordResetTokens PasswordResetToken[]` inverse relation to `backend/prisma/schema.prisma`; create the migration under `backend/prisma/migrations/` (name it `<timestamp>_password_reset`); regenerate the Prisma client. Constraints: `tokenHash String` with `@@unique([tokenHash])`, `@@index([userId, consumedAt])`, `userId` FK `@relation(fields: [userId], references: [id], onDelete: Cascade)`, `expiresAt DateTime` (non-null), `consumedAt DateTime?` (nullable).
- [ ] T003 [P] Add reset configuration to `backend/src/config/index.ts`: `resetTokenTtlHours` (default `24`, overridable via `RESET_TOKEN_TTL_HOURS`), `RESET_MAX_PER_SOURCE` (default `5`), `RESET_MAX_PER_ACCOUNT` (default `5`); the rate-limit window reuses the existing `RATE_LIMIT_WINDOW_MINUTES`.
- [ ] T004 [P] Add `reset-request` rate-limit budget keys (per-source via client IP and per-account via normalized email) to `backend/src/auth/rate-limit.ts`, reusing the existing sliding-window store and `clientIp(req)` (with the `TRUST_PROXY` guard).
- [ ] T005 [P] Add `buildResetLink(token)` to `backend/src/email/links.ts` returning `{publicOrigin}/reset/{token}`, mirroring `buildConfirmationLink`.
- [ ] T006 [P] Add `enqueueReset(tx, { userId, recipientEmail, subject, bodyText })` to `backend/src/email/outbox.ts` using the supersede pattern from `enqueueConfirmation` (flip prior `queued`/`sending` reset rows for the same user to `superseded`, then insert a `kind: 'reset'` row).
- [ ] T007 [P] Export `setSessionCookies` and `DUMMY_PASSWORD_HASH` from `backend/src/auth/router.ts` so `auth/password-reset.ts` reuses the exact session-cookie semantics and the uniform-body timing guard (single source of truth, no copy).

**Checkpoint**: Foundation ready — both user stories can now be implemented.

---

## Phase 3: User Story 1 - Recover a forgotten password via email (Priority: P1) 🎯 MVP

**Goal**: A signed-out user requests a reset by email, follows the one-time emailed link, sets a new password, and is signed in on that device — with the old password now rejected and any unconfirmed email treated as confirmed.

**Independent Test**: Request a reset for an account, follow the emailed link, set a new password, and sign in with it — asserting the old password is now rejected.

### Tests for User Story 1 ⚠️ (write FIRST, ensure they FAIL)

- [ ] T008 [P] [US1] Write `backend/tests/password-reset-request.test.ts` asserting: uniform `200` with the pinned `U` body for registered / unregistered / malformed email; capture mode creates a `kind: 'reset'` outbox row whose body contains a `/reset/<token>` link and an expiry notice; disabled mode (`EMAIL_ENABLED=false`) returns `200` `U` and creates **no** outbox row; the raw token is absent from the response body and from the `password_reset_requested` audit `detail`.
- [ ] T009 [P] [US1] Write `backend/tests/password-reset.test.ts` (US1 coverage) asserting: the happy path consumes the token and rewrites `User.passwordHash` so the old password is 401 and the new password logs in (SC-004); success returns `200 {"status":"reset","user":{…,"verified":true}}` **and** sets the `gifty_access`/`gifty_refresh` cookie pair (FR-014); a previously-unconfirmed account has `verifiedAt` set after the reset (FR-013, SC-006); the endpoint requires no prior session.
- [ ] T010 [P] [US1] Write `frontend/src/pages/ResetPage.test.tsx` asserting `ResetPage` renders new-password + confirm fields, rejects a confirm mismatch (400 `P` copy), navigates to the app home on success, and surfaces the 400 `I` "invalid or expired" copy with a "request a new link" affordance; and add an `AuthPage` test asserting the "Forgot password?" link targets `/forgot-password`.

### Implementation for User Story 1

- [ ] T011 [US1] Implement `POST /auth/reset-request` in `backend/src/auth/password-reset.ts`: trim + case-fold the email, look up the account; on no match run one `bcrypt.compare` against the exported `DUMMY_PASSWORD_HASH` (timing equalization); issue a 256-bit token, persist a `PasswordResetToken` (SHA-256 `tokenHash`, `expiresAt = now + resetTokenTtlHours`); `enqueueReset(...)` with a body containing `buildResetLink(token)` plus an expiry notice; emit `password_reset_requested` (no `userId` when the email is unknown); return the uniform `200` body `U` in all cases — including disabled mode, where no enqueue happens.
- [ ] T012 [US1] Implement `POST /auth/reset` in `backend/src/auth/password-reset.ts`, in this exact order: body-shape check → `newPassword === confirmPassword` → `validatePasswordPolicy` (003 FR-002, reuse `PASSWORD_POLICY_MESSAGE`) → atomic token claim (`updateMany where { tokenHash, consumedAt: null, expiresAt: { gte: now } }` → set `consumedAt`; `count === 0` ⇒ `400` body `I`, no state change — the `expiresAt` guard rejects an expired-but-unconsumed link rather than claiming it) → one Prisma transaction: rewrite `User.passwordHash` (bcrypt cost 10), set `User.verifiedAt` if null, revoke all `UserSession` rows `where { userId, revokedAt: null }`, invalidate every other pending `PasswordResetToken` row for the user (`id <> claimed AND consumedAt IS NULL`), then `createSession(userId)`; after commit call the exported `setSessionCookies`; emit `password_reset_success` (detail `revokedSessionCount`, `confirmedEmail`) or `password_reset_failed` (invalid-token class); return `200 S` on success, `400 I` on invalid, `400 P` on policy/mismatch. Policy/mismatch rejections MUST NOT consume the token (FR-003).
- [ ] T013 [US1] Mount the reset router in `backend/src/app.ts` (e.g. `app.use('/auth', createPasswordResetRouter())` alongside the existing `createAuthRouter` at line 131), exposing `POST /auth/reset-request` and `POST /auth/reset`.
- [ ] T014 [P] [US1] Add a "Forgot password?" link to `frontend/src/pages/AuthPage.tsx` → `/forgot-password`, and create `frontend/src/pages/ForgotPasswordPage.tsx` (an email form that calls `requestPasswordReset(email)`; on the uniform `200` `U` it shows the single "check your inbox" message — the endpoint never distinguishes registered vs unregistered, so neither may the UI — and on `429` it shows the recoverable message "Too many recent requests, please try again later" (FR-007: present the throttle as recoverable, no dead end; no specific wait time is shown)).
- [ ] T015 [P] [US1] Create `frontend/src/pages/ResetPage.tsx` (public `/reset/:token`): new-password + confirm fields with a client-side confirm-match check and a policy hint, calling `resetPassword(token, newPassword, confirmPassword)`; on `200` navigate to the app home (`/`), on `400 I` show the invalid-link copy with a "request a new link" affordance (→ `/forgot-password`).
- [ ] T016 [US1] Add `requestPasswordReset(email)` and `resetPassword(token, newPassword, confirmPassword)` to `frontend/src/services/api.ts` (plain `fetch`, cookie-only — no `Authorization` header), and register both public routes in `frontend/src/App.tsx` as bare routes (`/forgot-password`, `/reset/:token`), the same treatment as the existing `/confirm` route at line 141.

**Checkpoint**: US1 is fully functional and independently testable — a locked-out user can recover and be signed in (SC-004, SC-005, SC-006). This is the MVP.

---

## Phase 4: User Story 2 - Reset link is single-use, expiring, and non-enumerable (Priority: P1)

**Goal**: The reset link behaves like the credential it replaces — single-use, time-bounded, non-enumerable, rate-limited — and a successful reset revokes all other sessions and invalidates sibling pending links.

**Independent Test**: Request a reset, then (a) reuse the link (rejected as used), (b) use it after expiry (rejected as expired), (c) request for an unregistered email (indistinguishable), (d) exceed the rate budget (429), (e) confirm other sessions are revoked and a sibling pending link is invalidated.

### Tests for User Story 2 ⚠️ (write FIRST, ensure they FAIL)

- [ ] T017 [P] [US2] Extend `backend/tests/password-reset.test.ts` with US2 coverage: **replay** — a second `POST /auth/reset` with the same token returns `400 I` and changes no password (SC-003); **expiry** — a token presented after its TTL returns `400 I` (FR-005); **sibling invalidation** — two pending links, consuming one invalidates the other so it can no longer change the password (FR-012); **session revocation** — a pre-existing session's access/refresh is rejected after the reset while the resetting device is signed in (FR-012/FR-014); **FR-010 smoke** — a reset changes no list/item/claim/purchase visibility.
- [ ] T018 [P] [US2] Extend `backend/tests/password-reset-request.test.ts` with US2 coverage: **rate limiting** — the request after the `RESET_MAX_PER_SOURCE`+1 (and the per-account) budget is exhausted returns `429` + `Retry-After` with the same uniform body, creates no outbox row, and emits `password_reset_rate_limited`; **non-enumeration** — registered vs unregistered return identical status, byte-identical body, and comparable timing (both perform one `bcrypt` compare) (FR-002, SC-002).

### Implementation for User Story 2

- [ ] T019 [US2] Wire the `reset-request` rate-limit check into `POST /auth/reset-request` in `backend/src/auth/password-reset.ts`: before any account lookup, check the per-source + per-account budgets from `backend/src/auth/rate-limit.ts`; on throttle return `429` + `Retry-After` with the uniform body `U` and emit `password_reset_rate_limited`; ensure the unregistered path still performs the dummy `bcrypt.compare` so timing stays equalized (FR-002/SC-002).
- [ ] T020 [US2] Verify/strengthen the US2 guarantees in `backend/src/auth/password-reset.ts`: confirm the success transaction includes sibling invalidation + bulk session revoke in the D7 order (claim → password → verify → revoke → sibling-invalidate → create session), that the atomic single-use claim returns `400 I` with no state change when `count === 0`, and that `password_reset_failed` fires for the invalid-token class; fix any gap so T017/T018 pass.

**Checkpoint**: US1 and US2 both work independently — the flow is both usable and hardened (SC-001–SC-006, FR-004–FR-012).

---

## Phase 5: Polish & Cross-Cutting Concerns

- [ ] T021 [P] Add `frontend/tests/e2e/password-reset.spec.ts` (Playwright, capture mode, `BASE_URL` mandatory): request a reset → read the captured outbox link → follow `/reset/<token>` → set a new password → land signed in on the app home; the old password is 401 on re-login; a replay shows the invalid-link copy.
- [ ] T022 [P] Reconcile `specs/005-password-reset/quickstart.md` scenario C with the B+ sibling-invalidation semantics (a pending, un-consumed link is rejected as invalidated after a successful reset) so the manual scenarios match FR-012/D7.
- [ ] T023 [P] Audit-trail verification: confirm the four new actions (`password_reset_requested`, `password_reset_rate_limited`, `password_reset_success`, `password_reset_failed`) are emitted with scrubbed `detail` (never the raw token, password, or bcrypt hash) per FR-009/FR-006, and that `scrub()` in `backend/src/audit/events.ts` covers the reset fields.
- [ ] T024 Run the full green gate: `cd backend; npm test; npx tsc -p tsconfig.json --noEmit`; `cd frontend; npx vitest run; ..\backend\node_modules\.bin\tsc.cmd -p tsconfig.json --noEmit`; then rebuild + e2e — `npm run docker:up` (wait for `GET http://localhost:8080/healthz`) → `cd frontend; $env:BASE_URL='http://localhost:8080'; npx playwright test`; confirm everything passes including the new `password-reset*.test.ts` and `tests/e2e/password-reset.spec.ts`.

**Checkpoint**: Feature complete — all suites green, manual scenarios reconciled, audit trail verified.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately.
- **Foundational (Phase 2)**: Depends on Setup. **T002 blocks all user-story work**; T003–T007 parallelize.
- **User Stories (Phase 3 → 4)**: Both depend on Foundational. US1 has no dependency on US2; US2 builds on US1's endpoints (rate-limit wiring + hardening tests) but is independently testable.
- **Polish (Phase 5)**: Depends on US1 + US2.

### User Story Dependencies

- **US1 (P1, MVP)**: After Foundational. Independently shippable (SC-004/SC-005/SC-006).
- **US2 (P1)**: After Foundational. Integrates with US1's `password-reset.ts` endpoints but is independently testable (SC-001–SC-003, FR-004–FR-012).

### Within Each User Story

- Tests (T008–T010, T017–T018) MUST be written and seen failing before the implementation they cover.
- Backend endpoints (T011/T012) before frontend (T014–T016).
- Core flow (US1) before hardening (US2).

### Parallel Opportunities

- **Foundational**: T003, T004, T005, T006, T007 all run in parallel after T002.
- **US1 tests**: T008, T009, T010 in parallel.
- **US1 frontend**: T014 and T015 in parallel (both depend on the T016 `api.ts` helpers existing first — run T016 first, then T014/T015 in parallel).
- **US2 tests**: T017 and T018 in parallel.
- **Polish**: T021, T022, T023 in parallel; T024 last (full gate).

---

## Implementation Strategy

- **MVP first (US1)**: deliver the recover-and-sign-in flow (SC-004/SC-005/SC-006) as a shippable increment — a forgotten password becomes recoverable.
- **Incremental hardening (US2)**: layer on single-use, expiry, non-enumeration, rate limiting, session/sibling invalidation (SC-001–SC-003) on the same endpoints.
- **Mirror the proven 003/004 patterns** (token mechanics, outbox, rate limiting, session, audit) to keep the review surface minimal.
- **Gate every change** on the full suite (T001 baseline → T024 final green), and always re-run e2e after a rebuild.

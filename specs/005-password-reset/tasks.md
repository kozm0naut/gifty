# Tasks: Password Reset

**Input**: Feature specification from `/specs/005-password-reset/spec.md`
**Reference**: plan.md, research.md (D1–D11), data-model.md, contracts/api.md

## Summary

Two P1 user stories. **US1** (MVP) is the end-to-end recoverable flow — request a reset,
follow the emailed link, set a new password, land signed in, old password gone. **US2** is the
hardening layer on top — rate-limiting, non-enumeration timing, single-use + expiry proofs, and
session/sibling invalidation. Both stories are P1; US1 is the minimal shippable slice (SC-004).

The backend `reset` endpoint is a single atomic transaction (claim + set password + revoke
sessions + invalidate siblings + create session), so its *implementation* lands in US1's T008
(inseparable from a secure working reset); US2 adds rate-limiting implementation and the
dedicated *test coverage* that proves the US2 guarantees (SC-001/2/3, FR-010, FR-012).

## Format: `[TaskID] Description [P] (story refs)`

- **Parallel**: `[P]` marks independent tasks that can run concurrently.
- **Story refs**: `# US1` / `# US2` tag the owning user story.
- **Tests**: Constitution Principle III (Test-First Delivery) MANDATES tests for this
  account-flow feature; the TDD template's "tests optional" default is overridden. Test tasks
  are written **before** the implementation they cover.

## Format Examples

```
- [ ] T001 Write failing request tests            # US1
- [ ] T002 Implement buildResetLink + enqueueReset # US1
```

## Path Conventions

- `backend/…` — Node 22 + TS strict + Express 4 + Prisma 6. Auth endpoints live under the
  existing `/auth` router (mounted at `app.use('/auth', createAuthRouter())`, `app.ts:131`).
- `frontend/…` — React 18 + Vite. Public (no-session) pages mount as bare `<Route>` like
  `/confirm`; API helpers for public endpoints use plain `fetch` (see `resendConfirmation`).
- No new dependencies. One additive Prisma migration.

## ⚠️ Warnings & Guidelines

- **Blocking**: T002 (migration) gates every other task — the `PasswordResetToken` table and
  `OutboxKind.reset` must exist before tests can seed/assert.
- **TDD**: each user-story phase lists its failing tests first; implement only until those pass.
- **No raw token in logs/audit/responses** (FR-006); store only `tokenHash` (D1).
- **Uniform invalid class** (FR-004): unknown / expired / consumed tokens MUST return the
  byte-identical `400` body — no distinct status or detail.
- **Single-replica rate limiting**: budgets live in-process (`auth/rate-limit.ts`); reset-request
  counts **every** request (not just failures) — distinct from the login failure counter.
- **Test DB**: backend tests self-provision `gifty_test` via the `pretest` hook (requires Docker).
  Frontend e2e needs `BASE_URL` set and runs against the dev stack or a `docker:up` build.
- **Constitution III**: tests are mandatory and written before implementation.

---

## 🦶 Phase 1: Setup

**Goal**: Establish a green baseline so post-change failures are attributable to 005.

- [ ] T001 [P] Baseline green — run backend (`cd backend; npm test`) and frontend
      (`cd frontend; npx vitest run`) suites and confirm all pass before any 005 change.

**Checkpoint**: `baseline-green` — both suites green pre-change.

---

## 🏗️ Phase 2: Foundational (Blocking Infrastructure)

**Goal**: Schema + config the rest of the feature builds on. All tasks in this phase must
complete before US1 implementation begins.

- [ ] T002 Create the additive Prisma migration in `backend/prisma/schema.prisma`:
      `model PasswordResetToken { id String @id @default(cuid()); userId String @relation(...);
      tokenHash String @unique @db.VarChar(64); createdAt DateTime @default(now());
      expiresAt DateTime; consumedAt DateTime?; @@index([userId, consumedAt]) }` plus the
      `reset` value on the `OutboxKind` enum; run `npx prisma migrate dev` + `prisma generate`.
      (D1, D11)
- [ ] T003 [P] Add `resetTokenTtlHours` (env `RESET_TOKEN_TTL_HOURS`, default 24) to the
      `Config` interface and `loadConfig()` in `backend/src/config/index.ts`. (D2, D4)

**Checkpoint**: `schema-config-ready` — migration applied, client regenerated, TTL config present.

---

## 🎯 Phase 3: User Story 1 — Recover account password via email (Priority: P1) MVP

**Goal (SC-004)**: A user requests a reset, follows the emailed link, sets a new password, is
signed in, and the old password no longer works. Independently testable end-to-end in capture mode.

**Tests (write first — TDD):**
- [ ] T004 [P] Test — `backend/tests/password-reset-request.test.ts`: `POST /auth/reset-request`
      returns the uniform `200 {message}` body for a known email AND an unregistered email
      (indistinguishable status + body); enqueues an `OutboxMessage` (kind=reset) whose body
      contains a `/reset/{token}` link in capture mode; enqueues nothing when email is disabled;
      returns no token material in the response or audit detail. (FR-005, FR-006) # US1
- [ ] T005 [P] Test — `backend/tests/password-reset.test.ts`: SC-004 happy path — issue a valid
      token, `POST /auth/reset` with a policy-compliant `newPassword`/`confirmPassword` →
      `200 {status:'reset'}` + fresh session cookies + the new password authenticates at
      `POST /auth/login` + the old password is rejected at `/auth/login`. (FR-003, FR-013, FR-014) # US1

**Implementation:**
- [ ] T006 Implement `buildResetLink(token)` in `backend/src/email/links.ts` (→
      `${publicOrigin}/reset/${token}`) and `enqueueReset(prisma, {userId, email, to, body})` in
      `backend/src/email/outbox.ts` (supersede prior queued/sending reset rows for the user,
      mirroring `enqueueConfirmation`). (D3) # US1
- [ ] T007 Implement `POST /auth/reset-request` in a new module `backend/src/auth/password-reset.ts`
      and mount it on the auth router (`backend/src/app.ts`): normalize email → dummy
      `bcrypt.compare` against a fixed dummy hash (timing equalization) → if the user exists,
      generate a 256-bit token, hash it (SHA-256), issue a `PasswordResetToken` row with
      `expiresAt = now + resetTokenTtlHours`, `enqueueReset`, audit `password_reset_requested` →
      ALWAYS `200 {message:"Please check your email for the password reset link."}`. Add the four
      audit actions (`password_reset_requested`, `_failed`, `_success`, `_rate_limited`) to
      `AUDIT_ACTIONS` in `backend/src/audit/events.ts`. (D2, D4, D5, D8) # US1
- [ ] T008 Implement `POST /auth/reset` in `backend/src/auth/password-reset.ts`: validate body
      (both fields present, `newPassword === confirmPassword`, `validatePasswordPolicy`) →
      atomic claim via
      `prisma.passwordResetToken.updateMany({where:{tokenHash, consumedAt:null, expiresAt:{gt:now}},
      data:{consumedAt:now}})` (count 0 → uniform `400 {message:"This reset link is invalid or has
      expired."}`) → `bcrypt.hash(newPassword, 10)` → set `User.passwordHash` + `User.verifiedAt`
      (if null) → revoke all `UserSession` rows for the user (`revokedAt = now`) → invalidate
      sibling unconsumed `PasswordResetToken` rows for the user → `createSession(userId)` → set
      session cookies → audit `password_reset_success` (detail: `revokedSessionCount`,
      `confirmedEmail`). (D2, D6, D7, D8) # US1

**Frontend:**
- [ ] T009 [P] Frontend — add `requestPasswordReset(email)` and `resetPassword(token, newPassword,
      confirmPassword)` helpers in `frontend/src/services/api.ts` (public endpoints; plain `fetch`
      with `credentials: 'include'`, like `resendConfirmation`). (D9) # US1
- [ ] T10 [P] Frontend — create `frontend/src/pages/ForgotPasswordPage.tsx` (email form →
      `requestPasswordReset` → uniform "if this email exists…" success message, no account-
      existence leak) and `frontend/src/pages/ResetPage.tsx` (reads the `/reset/:token` param,
      password + confirm form with client-side validation, → `resetPassword` → on success navigate
      to `/`). (D9) # US1
- [ ] T11 Frontend — add a "Forgot password?" link in `frontend/src/pages/AuthPage.tsx` →
      `/forgot-password`; register the public routes `/forgot-password` and `/reset/:token` in
      `frontend/src/App.tsx` (bare `<Route>`, no `ProtectedRoute`, like `/confirm`). (D9) # US1

**✅ Independence test (US1)**: In capture mode — `reset-request` for a real email → read the
token from the captured `OutboxMessage` → `POST /auth/reset` → signed in with the new password; the
old password now fails at `/auth/login`. Proves SC-004 without any US2 hardening.

**Checkpoint**: `us1-mvp` — T004/T005 green; full happy path works end-to-end in capture mode.

---

## 🎯 Phase 4: User Story 2 — Single-use, expiring, non-enumerable reset (Priority: P1)

**Goal**: The mechanism is hardened — rate-limited (SC-001), expiring (SC-002), single-use
(SC-003), non-enumerable (FR-010), and revokes other sessions + invalidates sibling tokens
(FR-012). The core transaction for these lives in T008 (US1); this phase adds rate-limiting and
proves the guarantees with dedicated tests.

**Tests (write first — TDD):**
- [ ] T12 [P] Test — `backend/tests/password-reset-rate-limit.test.ts`: SC-001 — the N+1th
      `reset-request` from one source within the window → `429` + `Retry-After`; the per-account
      budget is also enforced (rotating source IPs does not defeat it); after the window rolls
      over, requests succeed again. (FR-011, FR-012) # US2
- [ ] T13 [P] Test — `backend/tests/password-reset-hardening.test.ts`: SC-002 — a token past
      `resetTokenTtlHours` → uniform `400` invalid class; SC-003 — replaying a consumed token →
      the same uniform `400`; FR-010 — `reset-request` responses for a known vs an unknown email
      are indistinguishable (status + body + timing class); FR-012 — a successful reset revokes the
      user's other live `UserSession` rows AND consumes all sibling unconsumed `PasswordResetToken`
      rows. (FR-004, FR-010, FR-012) # US2

**Implementation:**
- [ ] T14 Add `RESET_MAX_PER_SOURCE` / `RESET_MAX_PER_ACCOUNT` (default 5 each) to `Config` /
      `loadConfig()` in `backend/src/config/index.ts`; add `reset-source` and `reset-account`
      budget kinds that count **every** request (not just failures) in
      `backend/src/auth/rate-limit.ts`; wire the guard into `POST /auth/reset-request` in
      `backend/src/auth/password-reset.ts` (429 + `Retry-After` issued **before** any account
      lookup; audit `password_reset_rate_limited`). (D4, D8) # US2
- [ ] T15 Verify FR-004/FR-012 in `backend/src/auth/password-reset.ts` — confirm the `400`
      invalid class is byte-identical across unknown / expired / consumed tokens, and that the
      claim + session-revocation + sibling-invalidation run atomically (no partial state on
      failure). Adjust T008's transaction if any gap is found. (D6, D7) # US2

**✅ Independence test (US2)**: `T12` + `T13` green — rate limiting fires, expiry + replay both
return the uniform invalid class, known/unknown email responses are indistinguishable, and a
successful reset revokes other sessions + sibling tokens. Proves SC-001/2/3, FR-010, FR-012.

**Checkpoint**: `us2-hardening` — all US2 guarantees proven by test.

---

## 🎨 Phase 5: Polish & Cross-Cutting

**Goal**: Full-stack green + e2e proof + doc sync.

- [ ] T16 [P] Backend typecheck — `cd backend; npx tsc -p tsconfig.json --noEmit` passes.
- [ ] T17 [P] Frontend typecheck — `cd frontend; ..\backend\node_modules\.bin\tsc.cmd -p tsconfig.json --noEmit` passes.
- [ ] T18 Frontend unit tests — `cd frontend; npx vitest run` passes (add/extend coverage for
      `ForgotPasswordPage`, `ResetPage`, and the `api.ts` helpers if not covered by T10).
- [ ] T19 [P] E2E — add `frontend/tests/e2e/password-reset.spec.ts` (capture mode, `BASE_URL`
      set): the full US1 flow (request → capture token → set password → signed in, old rejected)
      plus a US2 check (replayed link is rejected). Run via Playwright against the dev stack or a
      `docker:up` build. (SC-003, SC-004)
- [ ] T20 Full backend suite — `cd backend; npm test` green (all 005 tests + the pre-existing
      suite, no regressions).
- [ ] T21 Docs — reconcile `specs/005-password-reset/quickstart.md` (note B+ sibling invalidation)
      and add a short "Password Reset" section to `README.md` + `backend/docs/api.md` describing
      the two new endpoints, the uniform bodies, and the `RESET_*` env knobs.

**Checkpoint**: `done` — all suites green, e2e passing, docs in sync.

---

## Dependencies & Execution Order

### Critical Path (US1 MVP)

```
T001 (baseline)
  └─> T002 (migration) ─┐
      T003 (TTL config) ─┤
                         ├─> T004 (request test) ─┐
                         ├─> T005 (reset test)   ─┤
                         ├─> T006 (email module) ─┤
                         │       └─> T007 (request endpoint) ─┐
                         └─────────────────────────────────────┤
                         └─> T008 (reset endpoint) ────────────┤
                                                               ├─> T009 (api helpers)
                                                               ├─> T10 (pages) ─> T11 (routes + link)
```

**US1 done at** T11 (checkpoint `us1-mvp`). US2 (T12–T15) can start after T007/T008 land
(the endpoints must exist to test their hardening); T14 depends on T007.

### Phase Dependencies

- **Phase 1 (Setup)**: independent — baseline first.
- **Phase 2 (Foundational)**: T002 + T003 are independent of each other; both gate US1.
- **Phase 3 (US1)**: T004/T005 (tests) before T006–T008 (impl); T009 → T10 → T11 (frontend chain).
- **Phase 4 (US2)**: T12/T13 (tests) before T14 (impl); T15 verifies T008.
- **Phase 5 (Polish)**: after US1 + US2; T19 (e2e) needs the full backend + frontend in place.

## Parallelism

| Parallel pair/group | Why independent |
|---|---|
| T002 ∥ T003 | Migration vs config — different files, no shared state. |
| T004 ∥ T005 | Two test files covering two endpoints; no shared fixtures. |
| T009 ∥ T10 | API helpers vs page components — separate modules. |
| T12 ∥ T13 | Two hardening test files; independent assertions. |
| T16 ∥ T17 ∥ T18 | Independent typecheck/unit verifications. |

**Example (US1 tests + impl, parallel where safe):**
```
T002 + T003  →  T004 ∥ T005  →  T006  →  T007 ∥ T008  →  T009 ∥ T10  →  T11
```

## Implementation Strategy (MVP-first)

1. **Ship US1 first** (T002–T11): a secure, working reset flow (SC-004). This is the minimal
   shippable slice and the feature's MVP. It already enforces single-use, expiry, and session
   revocation in the core transaction (T008), so US1 is not a naive/insecure reset.
2. **Then harden (US2)** (T12–T15): add rate limiting and prove out every US2 guarantee
   (SC-001/2/3, FR-010, FR-012) with dedicated tests.
3. **Polish** (T16–T21): typecheck both packages, full suites, e2e, docs.

**Incremental delivery**: after `us1-mvp` the feature is usable end-to-end; after `us2-hardening`
it meets every spec guarantee; after `done` it is fully verified and documented.

# Tasks: Email Integration

**Input**: Design documents from `/specs/004-email-integration/`

**Prerequisites**: plan.md ✅, spec.md ✅, research.md ✅, data-model.md ✅, contracts/api.md ✅, quickstart.md ✅, constitution.md ✅

**Tests**: Included — mandated by Constitution III (Test-First Delivery), spec Success Criteria, and plan.md testing section.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Path Conventions

- **Web app**: `backend/src/`, `frontend/src/`, `backend/tests/`, `frontend/tests/`
- Prisma: `backend/prisma/`
- Root config: `.env.example`, `docker-compose.yml`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Create the new feature module directory

- [x] T001 Create `backend/src/email/` directory (the new feature module for mailer, outbox, links, verification)

**Checkpoint**: Directory structure ready

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core infrastructure that MUST be complete before ANY user story can be implemented

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [x] T002a [P] Write `backend/tests/email-boot-gate.test.ts` **FIRST** (test-first per Constitution III — these tests MUST fail before T008's config work): test mode resolution (production + enabled + no key → boot refusal; production + enabled + valid key → boots; production + disabled → boots + warning; non-production + no key → capture mode); assert `validateConfig()` throws with a message naming `RESEND_API_KEY` when production + enabled + unconfigured; assert disabled mode auto-confirms at registration (FR-015)
- [x] T002 Extend `backend/prisma/schema.prisma`: add `OutboxMessage` model (fields: id uuid prefixed `outbox_*`, kind `OutboxKind`, recipientEmail String normalized lowercased, listId String? FK→GiftList `onDelete: Cascade`, userId String? FK→User `onDelete: Cascade`, subject String, bodyText String, bodyHtml String?, status `OutboxStatus`, attempts Int default 0, maxAttempts Int default 5, nextAttemptAt DateTime default now(), lastAttemptAt DateTime?, lastError String?, sentAt DateTime?, supersededAt DateTime?, createdAt DateTime default now(), updatedAt DateTime @updatedAt); add `enum OutboxKind { invite confirmation }`; add `enum OutboxStatus { queued sending sent failed superseded }`; add `@@unique([listId, recipientEmail])` (invite-dedup: invite rows one per (list, recipient), confirmation rows unlimited via NULL-distinct); add `@@index([status, nextAttemptAt])` (drainer selection); add `@@index([userId])`, `@@index([listId])`; extend `User` model with four nullable columns: `verifiedAt DateTime?`, `verificationTokenHash String?`, `verificationExpiresAt DateTime?`, `verificationCreatedAt DateTime?`
- [x] T003 Create Prisma migration in `backend/prisma/migrations/` (e.g. `20261004_email_integration/migration.sql`): CREATE ENUM OutboxKind, CREATE ENUM OutboxStatus, CREATE TABLE OutboxMessage (all columns + FKs + unique constraint + 3 indexes), ALTER TABLE User ADD 4 nullable columns, UPDATE "User" SET "verifiedAt" = <the migration's own timestamp, e.g. 20261004> WHERE "verifiedAt" IS NULL (grandfathering backfill per spec Assumptions); run `npx prisma migrate dev` against `gifty_test` to verify
- [x] T004 [P] Implement Mailer port + ResendMailer + CaptureMailer in `backend/src/email/mailer.ts`: `Mailer` interface (single `send(to, subject, text, html?)` method); `ResendMailer` — Node 22 global `fetch` POST to `https://api.resend.com/emails` with `RESEND_API_KEY` Bearer + `RESEND_FROM` (no SDK, research D1); `CaptureMailer` — zero network I/O, in-memory buffer, `capturedEmails()` returns `Array<{ kind, to, subject, text, link }>`, `resetCapturedEmails()` clears buffer (both hooks active only when `EMAIL_TRANSPORT=capture` or in test, per `GIFTY_ENABLE_TEST_PROBES` discipline); export `setMailerForTest(mailer)` injection hook; export `getMailer()` that resolves the active implementation from config mode
- [x] T005 [P] Implement link builders in `backend/src/email/links.ts`: `buildConfirmationLink(token)` → `{GIFTY_PUBLIC_ORIGIN}/confirm?token=<raw>`; `buildInviteLink()` → `{GIFTY_PUBLIC_ORIGIN}/` (home page, no token, no deep link per FR-013, research D9); read `GIFTY_PUBLIC_ORIGIN` from config (defaults to request origin)
- [x] T006 [P] Implement verification token in `backend/src/email/verification.ts`: `issueToken(userId, prisma)` — generate opaque 256-bit random token (crypto.randomBytes(32)), store SHA-256 hash on `User.verificationTokenHash`, set `verificationExpiresAt` = now + `EMAIL_TOKEN_TTL_HOURS` (default 24h), set `verificationCreatedAt`, return raw token (only lives in the outbox message body, never on User); `consumeToken(rawToken, prisma)` — SHA-256 hash the presented token, look up `User.verificationTokenHash`, check `verificationExpiresAt` not past, check `verifiedAt` is null, set `verifiedAt = now`, clear `verificationTokenHash`, return true on success / false on used-expired-unknown (all cases indistinguishable per FR-010); raw token never logged, echoed, or placed in audit detail (FR-011)
- [x] T007 Implement outbox enqueue + drain loop in `backend/src/email/outbox.ts`: `enqueueInvite(prisma, tx, { listId, recipientEmail, subject, bodyText, bodyHtml })` — INSERT OutboxMessage row in the same Prisma transaction, catch P2002 unique violation as "already invited" no-op (dedup per FR-005); `enqueueConfirmation(prisma, tx, { userId, recipientEmail, subject, bodyText, bodyHtml })` — INSERT with listId NULL (not deduped per FR-014); `drainOnce()` — select up to `EMAIL_DRAIN_BATCH` (default 50) rows WHERE status='queued' AND nextAttemptAt <= now() ORDER BY nextAttemptAt, for each: claim to `sending`, call `getMailer().send()`, on success → `sent` + `sentAt`, on failure → if attempts < maxAttempts: `queued` + `nextAttemptAt = now + backoff(attempts, EMAIL_RETRY_BASE_MS)` else `failed` + `lastError` (scrubbed, e.g. `provider_http_5xx`); `reclaimStaleSending()` — on (re)start, SELECT rows in `sending` state, reset to `queued` + `nextAttemptAt = now` (at-least-once delivery per FR-007); `startDrainer()` / `stopDrainer()` — setInterval at `EMAIL_DRAIN_INTERVAL_MS` (default 5000ms), SIGTERM-safe cleanup
- [x] T008 Extend `backend/src/config/index.ts`: parse `EMAIL_ENABLED` (default `true`), `EMAIL_TRANSPORT` (default derived: `resend` in production, `capture` in dev/test), `RESEND_API_KEY`, `RESEND_FROM`, `GIFTY_PUBLIC_ORIGIN`, `EMAIL_MAX_ATTEMPTS` (default 5), `EMAIL_RETRY_BASE_MS` (default 60000), `EMAIL_DRAIN_INTERVAL_MS` (default 5000), `EMAIL_DRAIN_BATCH` (default 50), `EMAIL_TOKEN_TTL_HOURS` (default 24), and `RESEND_MAX_PER_ACCOUNT` (default 3, the confirmation-resend budget per window — the window reuses the existing `RATE_LIMIT_WINDOW_MINUTES`, default 15); resolve sending mode: (a) enabled + live sender, (b) enabled + capture, (c) disabled; extend `validateConfig()` — production + `EMAIL_ENABLED=true` + no valid `RESEND_API_KEY` → throw boot error naming `RESEND_API_KEY` and the fix (FR-009, SC-006); non-production with no live sender → resolve to capture mode (mode b)
- [x] T009 [P] Extend `backend/src/audit/events.ts`: add four new audit action types: `email_invite_queued`, `email_confirmation_queued`, `email_delivered`, `email_failed`; record via existing `recordAuditEvent()` fire-and-forget; `detail` is `scrub()`-protected (never the raw token, never `RESEND_API_KEY`, per FR-011)
- [x] T010 [P] Update `.env.example` (repo root): add `EMAIL_ENABLED=true`, `EMAIL_TRANSPORT=capture`, `RESEND_API_KEY=` (empty), `RESEND_FROM=`, `GIFTY_PUBLIC_ORIGIN=`, `EMAIL_MAX_ATTEMPTS=5`, `EMAIL_RETRY_BASE_MS=60000`, `EMAIL_DRAIN_INTERVAL_MS=5000`, `EMAIL_DRAIN_BATCH=50`, `EMAIL_TOKEN_TTL_HOURS=24`, `RESEND_MAX_PER_ACCOUNT=3` with comments explaining each
- [x] T011 Wire drainer lifecycle in `backend/src/server.ts`: call `startDrainer()` after app boots (after `app.listen` resolves), call `stopDrainer()` on SIGTERM/SIGINT; surface the resolved email mode in startup logging (e.g. `[email] mode: capture (dev/test)` or `[email] mode: live (resend)`)

**Checkpoint**: Foundation ready — outbox infrastructure, mailer port, config, verification, audit, and drainer all in place. User story implementation can now begin.

---

## Phase 3: User Story 1 - Recipient Invite Email (Priority: P1) 🎯 MVP

**Goal**: A list owner shares a list with a recipient (registered or not) → exactly one invite email is produced containing a link to the app home page. Repeat shares produce no additional email.

**Independent Test**: Share a list with a recipient and assert exactly one invite message is produced for that recipient-list pair, containing a link to the app home page; share the same list with the same recipient again and assert no second message.

### Tests for User Story 1 ⚠️

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [x] T013 [P] [US1] Write `backend/tests/invite-email.test.ts`: (1) share a list with a registered recipient → exactly one invite OutboxMessage with kind=`invite`, recipientEmail correct, subject + bodyText + bodyHtml present, link = `{origin}/` (home, no token), status=`queued`; (2) share with an unregistered email → same one invite, owner response indistinguishable from registered share (FR-002); (3) owner revokes the share, then re-shares the same list + same recipient → no second OutboxMessage (dedup, FR-005 — the only UI path to a re-share is revocation-first per US3 scenario 1); (4) share a different list with same recipient → new invite produced (dedup is per-list, US3 scenario 3); (5) owner-facing response body is unchanged (uniform share body from feature 003)

### Implementation for User Story 1

- [x] T014 [US1] Extend `backend/src/gift-lists/router.ts`: in the share endpoint, when a share creates a new share record (SharePermission or PendingInvitation), call `enqueueInvite()` with the rendered invite (subject: "You've been shared a gift list", bodyText: human-readable purpose + link to `{origin}/`, bodyHtml: same with HTML link); the owner-facing response is unchanged (no status/body/timing change per FR-002); in disabled mode (mode c), skip the enqueue entirely (FR-015) — **deviation:** the enqueue runs as a separate best-effort write on the base Prisma client *after* the share record commits, not inside the same `$transaction`. Rationale: (a) FR-006/SC-007 require the share never to fail or roll back because of email, and (b) `enqueueInvite`'s P2002 dedup recovery re-queries the existing row, which Postgres rejects inside an aborted transaction (25P02) — so the dedup no-op path only works in autocommit. Enqueue failures are caught, logged, and audited as `email_invite_queued` only on success; the share response is identical either way.

**Checkpoint**: US1 fully functional — share produces exactly one invite email per (recipient, list), no repeat, owner response unchanged

---

## Phase 4: User Story 2 - Account Confirmation Email (Priority: P1)

**Goal**: A new account registers → confirmation email with verification link is produced. Following the link confirms the account. The blocking gate holds unconfirmed accounts. Resend is rate-limited and non-locking.

**Independent Test**: Register → assert confirmation message with link; follow link → account confirmed; follow same link again → uniform non-error; attempt gated route while unconfirmed → 403; resend → new token, 6th call → 429.

### Tests for User Story 2 ⚠️

- [x] T015 [P] [US2] Write `backend/tests/confirmation.test.ts`: (1) register → OutboxMessage kind=`confirmation`, recipientEmail = account email, body contains `/confirm?token=` link, `verified: false` in response; (2) GET /confirm?token=<valid> → 200 `{status:"confirmed"}`, `verifiedAt` set, `verificationTokenHash` null, gate lifted; (3) GET /confirm?token=<same> again → same 200 body (FR-004); (4) GET /confirm?token=<expired> → same 200 body; (5) GET /confirm?token=<unknown> → same 200 body (FR-010, no existence leak); (6) GET /confirm with no token → same 200 body; (7) unconfirmed account hits GET /lists → 403 `{message:"Please confirm your email to continue."}`; (8) unconfirmed account hits GET /account → 200 (allow-list); (9) unconfirmed account hits POST /auth/refresh → 200 (allow-list); (10) unconfirmed account hits POST /auth/logout → 200 (allow-list); (11) POST /auth/resend-confirmation (unconfirmed) → 202, new token issued (supersedes), new OutboxMessage; (12) (RESEND_MAX_PER_ACCOUNT + 1)th resend within window (i.e. the 4th, given default budget 3) → 429 (rate-limit, FR-014); (13) resend on already-confirmed account → 403; (14) disabled mode: register → `verified: true`, no OutboxMessage, no gate

### Implementation for User Story 2

- [x] T016 [US2] Implement `GET /confirm?token=` route in `backend/src/app.ts`: public (no session required), hash the presented token (SHA-256), look up `User.verificationTokenHash`, check expiry, if valid + unconfirmed → set `verifiedAt = now`, clear `verificationTokenHash`; return `200 {status:"confirmed"}` in ALL cases (valid, used, expired, unknown, missing) per FR-004/FR-010; never echo the raw token, never log it (FR-011)
- [x] T017 [US2] Extend `backend/src/auth/router.ts` register endpoint: on success, call `issueToken()` + `enqueueConfirmation()` in the same transaction (confirmation body: subject "Confirm your email address", bodyText: purpose + `/confirm?token=` link); when email disabled (mode c), set `verifiedAt = now` directly, skip token + enqueue (FR-015); the 201 response `user` object gains `verified: boolean` field
- [x] T018 [US2] Implement `requireConfirmed` gate in `backend/src/auth/middleware.ts`: after `requireAuth`, check if the account is unconfirmed (`verifiedAt === null` and email enabled); if unconfirmed, allow only the pre-confirmation allow-list routes (`GET /account`, `GET /confirm`, `POST /auth/resend-confirmation`, `POST /auth/refresh`, `POST /auth/logout`); all other authenticated routes → `403 {message:"Please confirm your email to continue."}` (stable, non-leaking body per FR-016); apply the gate to all existing authenticated routes in `backend/src/app.ts` (lists, items, sharing, claim, consent, DELETE /account)
- [x] T019 [US2] Extend `backend/src/auth/rate-limit.ts`: add `'confirmation-resend'` budget kind, keyed on account id, budget = `RESEND_MAX_PER_ACCOUNT` (default 3) within the `RATE_LIMIT_WINDOW_MINUTES` window (default 15); extend `backend/src/auth/router.ts`: add `POST /auth/resend-confirmation` — requires live session + unconfirmed account, calls `issueToken()` (supersedes prior token) + `enqueueConfirmation()`, returns `202 {message:"A new confirmation email is on its way."}`; 403 if already confirmed; 429 on rate-limit exhaustion with `{message:"Too many confirmation requests. Please wait a moment and try again."}`; 401 if no session
- [x] T020 [US2] Extend `GET /account` in `backend/src/app.ts`: add `verified: boolean` to the `user` object in the response (derived from `verifiedAt !== null`)
- [x] T021 [US2] Frontend — create `frontend/src/pages/ConfirmPage.tsx`: confirmation status display, "resend email" button (calls `POST /auth/resend-confirmation`), "open app" link to dashboard; **the page keys off `GET /account` → `user.verified`, never off the `/confirm` response body** (the uniform body closes the oracle and is uninformative for UX); when `verified === false` **and a live session exists**, render one screen: *"Confirm your email — a link is on its way to {email}."* + a generic non-leaking note next to the resend button (e.g. *"Confirmation links expire after {EMAIL_TOKEN_TTL_HOURS} hours. If your link isn't working, resend a new one."*) + the resend button; when `verified === false` **but no live session** (cold visit: dead/expired link opened in a fresh browser, `GET /account` returns 401), render a *"This link didn't complete confirmation. Sign in to your account and resend a fresh link."* state with a sign-in link (resend requires a session, so it is not offered here); when `verified === true`, redirect to dashboard; extend `frontend/src/services/api.ts`: add `resendConfirmation()` method, expose `user.verified` from `GET /account`; extend `frontend/src/context/AuthContext.tsx`: expose `isVerified` boolean, add `resendConfirmation` action; extend `frontend/src/App.tsx`: add `/confirm` route, gate unconfirmed users to ConfirmPage (redirect to ConfirmPage when `isVerified === false` and route is not in the allow-list); extend `frontend/src/pages/AuthPage.tsx`: after successful register, route to confirmation page when `verified === false`

**Checkpoint**: US2 fully functional — register → confirmation email → follow link → confirmed → gate lifted; resend rate-limited; disabled mode auto-confirms

---

## Phase 5: User Story 3 - One Invite Per Recipient Per List (Priority: P1)

**Goal**: Repeat shares of the same list to the same recipient never produce a second invite email. Dedup is per (recipient, list), enforced by the database, spanning the registered/unregistered transition.

**Independent Test**: Share a list with a recipient, then share that same list with the same recipient again (registered, unregistered, or after revocation + re-share) → assert only one invite message was ever produced.

### Tests for User Story 3 ⚠️

- [x] T022 [P] [US3] Write `backend/tests/outbox-enqueue.test.ts`: (1) enqueue invite for (list L, recipient R) → one OutboxMessage row; (2) enqueue invite for same (L, R) again → P2002 caught, no second row (dedup no-op); (3) enqueue invite for different list (L2, R) → new row (dedup is per-list); (4) recipient R registers an account → re-enqueue (L, R) → no second row (dedup spans the register transition, key is email not user-id); (5) owner revokes share + re-shares (L, R) → no second row; (6) enqueue confirmation for (userId U, email E) → one row with listId NULL; (7) re-enqueue confirmation for same (U, E) → new row (confirmations are NOT deduped, FR-014)

### Implementation for User Story 3

- [x] T023 [US3] Verify `backend/src/email/outbox.ts` `enqueueInvite()` correctly catches Prisma P2002 unique violation on `@@unique([listId, recipientEmail])` and treats it as a silent no-op (no error, no second email); verify the dedup key is `(listId, recipientEmail)` not user-id (FR-005, D3); verify confirmation enqueue uses `listId = null` so the unique constraint does not apply (FR-014)

**Checkpoint**: US3 fully functional — exactly one invite per (recipient, list), enforced by DB constraint, spans register transition, confirmations are re-sendable

---

## Phase 6: User Story 4 - Reliable, Queued Delivery (Priority: P2)

**Goal**: Every email is queued first and delivered by a separate loop. Transient failures are retried with backoff. Persistent failures reach terminal `failed` state (observable, never retried forever). In-flight messages are reclaimed on restart.

**Independent Test**: Enqueue a message with the sender down → message stays `queued`; make sender available → drain → message reaches `sent`; make sender always fail → message reaches `failed` after maxAttempts; kill process mid-send → restart → message reclaimed and retried.

### Tests for User Story 4 ⚠️

- [x] T024 [P] [US4] Write `backend/tests/outbox-drainer.test.ts`: (1) enqueue with sender available → drainOnce → status=`sent`, `sentAt` set, attempts=1; (2) enqueue with sender failing on first attempt → drainOnce → status=`queued`, attempts=1, nextAttemptAt > now; make sender succeed → drainOnce → `sent`; (3) sender always fails → drain maxAttempts (5) times → status=`failed`, `lastError` set (scrubbed), attempts=maxAttempts; (4) `failed` is terminal — subsequent drainOnce does NOT retry it; (5) simulate in-flight (claim to `sending`, don't resolve) → `reclaimStaleSending()` → status back to `queued`, nextAttemptAt=now; (6) confirmations can be superseded: enqueue confirmation → resend (new token) → prior row → `superseded`, `supersededAt` set; (7) origin action (share/register) succeeds even when sender is down (SC-007)

### Implementation for User Story 4

- [x] T025 [US4] Verify `backend/src/email/outbox.ts` drain loop: `drainOnce()` claims rows to `sending` before calling `getMailer().send()`; on success → `sent` + `sentAt` + `email_delivered` audit; on failure → if attempts < maxAttempts: `queued` + `nextAttemptAt = now + exponential backoff(attempts, EMAIL_RETRY_BASE_MS)` + `email_failed` audit (transient); if attempts == maxAttempts: `failed` + `lastError` (scrubbed) + `email_failed` audit (terminal); `reclaimStaleSending()` runs at drainer startup (before first tick); `startDrainer()` calls `reclaimStaleSending()` then starts the interval; `stopDrainer()` clears the interval and awaits in-flight sends

**Checkpoint**: US4 fully functional — retry with backoff, terminal failed, reclaim on restart, origin action never blocked

---

## Phase 7: User Story 5 - Developer and Test Mail Capture (Priority: P3)

**Goal**: In dev/test, emails are captured locally (process output + in-memory buffer) with zero live provider calls. Tests can assert on captured messages.

**Independent Test**: Trigger an invite + a confirmation in test → assert both captured in `capturedEmails()`, assert zero live provider calls.

### Tests for User Story 5 ⚠️

- [ ] T026 [P] [US5] Write `backend/tests/capture-mode.test.ts`: (1) invite email captured → `capturedEmails()` contains entry with correct `to`, `subject`, `text`, `link` (home page, no token); (2) confirmation email captured → entry with `/confirm?token=` link; (3) zero live provider calls (no fetch to `api.resend.com` — assert via mock or absence of RESEND_API_KEY); (4) `resetCapturedEmails()` clears the buffer; (5) `drainOnce()` processes captured messages (status → `sent`); (6) `setMailerForTest(fakeMailer)` injection works (fake succeeds / fails N times / always fails)

### Implementation for User Story 5

- [ ] T027 [US5] Verify `backend/src/email/mailer.ts` CaptureMailer: zero network I/O by construction (no fetch, no HTTP); `capturedEmails()` returns the in-memory ring buffer; `resetCapturedEmails()` clears it; both hooks are only active when `EMAIL_TRANSPORT=capture` (or in test environment) — never in production (mirrors `GIFTY_ENABLE_TEST_PROBES` discipline); each captured entry logs to process output in a stable greppable shape (e.g. `[capture] invite → guest@example.com: "You've been shared a gift list"`); verify `getMailer()` resolves to CaptureMailer in mode (b) and ResendMailer in mode (a)

**Checkpoint**: US5 fully functional — capture mode produces expected messages, zero live calls, test hooks work

---

## Phase 8: User Story 6 - Operator Configuration and Boot Validation (Priority: P3)

**Goal**: Email sending is controlled by operator config. Production + enabled + unconfigured → fail fast. Disabled → auto-confirm + startup warning. Non-production → capture fallback.

**Independent Test**: Start in production with email enabled but no key → refuse to start; start with email disabled → starts, auto-confirms, warns.

### Tests for User Story 6 ⚠️

> (Test file already written in T002a as part of Foundational, test-first)

- [ ] T028 [US6] Verify `backend/src/config/index.ts` `validateConfig()`: production + `EMAIL_ENABLED=true` + no `RESEND_API_KEY` → throws with message naming `RESEND_API_KEY` and the fix (FR-009, SC-006); production + enabled + valid key + `RESEND_FROM` → boots (mode a); production + disabled → boots + emits startup warning `[config] email disabled — new accounts are auto-confirmed; live delivery is off.` (FR-015, SC-010); non-production + no key → resolves to capture mode (mode b), boots normally; verify the startup warning is emitted at the correct level (warning, not error) and states both facts (email disabled + auto-confirmed)

### Implementation for User Story 6

- [ ] T029 [US6] Verify `backend/src/app.ts` startup logging: on boot, log the resolved email mode (e.g. `[email] mode: live (resend)`, `[email] mode: capture (dev/test)`, `[email] mode: disabled (auto-confirm)`); in disabled mode, the register path auto-confirms (`verifiedAt = now`, no token, no enqueue) — verify the `backend/src/auth/router.ts` register handler checks the mode and branches correctly

**Checkpoint**: US6 fully functional — boot gate, mode resolution, startup warning, auto-confirm all working

---

## Phase 9: Polish & Cross-Cutting Concerns

**Purpose**: Integration validation, regression, documentation

- [ ] T030 [P] Write frontend e2e tests in `frontend/tests/e2e/`: (1) register → confirmation page → follow captured link → dashboard → verified; (2) unconfirmed account → gated at lists page → 403 → confirm → access granted; (3) disabled mode → register → immediately on dashboard (no gate); (4) invite email captured (process output check)
- [ ] T031 [P] Run full backend regression: `cd backend; npm test` + `npx tsc -p tsconfig.json --noEmit` — all 001/003 suites MUST pass unchanged (SC-007)
- [ ] T032 [P] Run full frontend regression: `cd frontend; npx vitest run` + `npx playwright test` (with `BASE_URL=http://localhost:8080`) — all existing e2e MUST pass
- [ ] T033 Run quickstart.md validation scenarios (steps 3a–3c, US1–US6) against the running app (`npm run docker:up` → http://localhost:8080)
- [ ] T034 [P] Update `docs/docker.md`: document the `EMAIL_*` environment variables and the three sending modes in the deployment documentation
- [ ] T035 [P] Update `README.md`: add a short "Email" section documenting the three modes, the capture stub for dev/test, and the boot-gate behavior

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on Setup — BLOCKS all user stories
- **User Stories (Phases 3–8)**: All depend on Foundational (Phase 2)
  - US1, US2, US3 are P1 — can proceed in parallel after Phase 2 (different files)
  - US4 is P2 — depends on Phase 2; can run parallel with US1–US3
  - US5, US6 are P3 — depend on Phase 2; can run parallel with all
- **Polish (Phase 9)**: Depends on all desired user stories being complete

### User Story Dependencies

- **US1 (P1)**: No dependencies on other stories — needs Phase 2 only
- **US2 (P1)**: No dependencies on other stories — needs Phase 2 only (shares `enqueueConfirmation` with US1's `enqueueInvite` in outbox.ts, but they are independent code paths)
- **US3 (P1)**: Logically depends on US1's share router hook (T014) for the dedup no-op path, but the DB constraint (T002/T003) is the real enforcement — US3 is primarily a verification/test story
- **US4 (P2)**: Depends on Phase 2 (drain loop is in T007) — US4 is primarily a verification/test story for the drain loop
- **US5 (P3)**: Depends on Phase 2 (CaptureMailer is in T004) — US5 is primarily a verification/test story
- **US6 (P3)**: Depends on Phase 2 (config is in T008) — US6 is primarily a verification/test story

### Within Each User Story

- Tests MUST be written and FAIL before implementation (TDD per Constitution III)
- Models (schema) before services (outbox/mailer)
- Services before endpoints (router hooks)
- Core implementation before integration (frontend)

### Parallel Opportunities

- **Phase 2**: T004 (mailer), T005 (links), T006 (verification), T009 (audit), T010 (.env.example) can all run in parallel [P]
- **Phase 2**: T002a (boot-gate test, test-first) is written before T008's config work and can run in parallel with T004–T006
- **Phases 3–8**: All user story phases can run in parallel (different files, no cross-story code dependencies beyond Phase 2)
- **Within stories**: Test tasks [P] can run in parallel with implementation tasks in other stories
- **Phase 9**: T030 (e2e), T031 (backend regression), T032 (frontend regression), T034 (docker docs), T035 (README) can all run in parallel [P]

---

## Parallel Example: User Story 1

```text
┌─────────────────────────────────────────────────────┐
│  Phase 2 (Foundational) — sequential where needed   │
│  T001 → T002 → T003 → T004,T005,T006 (parallel)    │
│       → T007 → T008,T009,T010 (parallel) → T011    │
└──────────────────────┬──────────────────────────────┘
                       │
         ┌─────────────┼─────────────┐
         ▼             ▼             ▼
   ┌──────────┐  ┌──────────┐  ┌──────────┐
   │  US1     │  │  US2     │  │  US3     │
   │ T013(test)│ │ T015(test)│ │ T022(test)│
   │ T014(impl)│ │ T016-T021 │ │ T023(verify)│
   └──────────┘  └──────────┘  └──────────┘
         │             │             │
         └─────────────┼─────────────┘
                       ▼
         ┌─────────────────────────┐
         │  US4, US5, US6          │
         │  T024-T029 (verify/test) │
         └────────────┬────────────┘
                      ▼
         ┌─────────────────────────┐
         │  Phase 9: Polish        │
         │  T030-T035 (parallel)   │
         └─────────────────────────┘
```

---

## Implementation Strategy

### MVP First (US1 + US2)

The minimum viable product is **US1 (invite email)** + **US2 (confirmation email)**. These two stories deliver the core value: a recipient gets an email when shared, and a new user confirms their account. Both are P1 and independently testable.

**MVP scope**: Phase 1 + Phase 2 + Phase 3 + Phase 4 (US1 + US2)

### Incremental Delivery

1. **MVP**: US1 + US2 (invite + confirmation) — the two explicit scope items
2. **US3**: Dedup verification (the DB constraint is already in place from Phase 2; US3 is the test verification)
3. **US4**: Delivery reliability verification (drain loop is already in Phase 2; US4 is the test verification)
4. **US5 + US6**: Capture mode + boot gate verification (infrastructure already in Phase 2; these are test + config verification)
5. **Polish**: E2E, regression, docs

### Key Risk Mitigations

- **Dedup race condition**: Enforced by `@@unique` DB constraint (T002/T003), not read-then-write — impossible to race
- **Token leak**: Hash-only storage (T006), scrub audit (T009), no-echo /confirm (T016)
- **Origin action blocked**: Enqueue is in the same transaction (T007), no delivery I/O in request path (FR-006, SC-007)
- **Mode conflation**: Three modes derived from config (T008), never conflated (Assumptions)
- **Existing suite breakage**: All 001/003 suites MUST pass (T031/T032, SC-007)

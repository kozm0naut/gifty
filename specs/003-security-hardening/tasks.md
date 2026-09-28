# Tasks: Security Hardening

**Input**: Design documents from `/specs/003-security-hardening/`

**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/api.md, quickstart.md

**Tests**: Test tasks ARE included — constitution Principle III (Test-First Delivery) requires new behavior to be covered by automated tests before release, and SC-007 requires the existing suites (80 backend, 8 e2e) to pass unchanged.

**Organization**: Tasks are grouped by user story so each story can be implemented, tested, and delivered independently. Story priority order per spec.md: US1 (P1), US2 (P1), US3 (P1), US4 (P2), US5 (P1), US6 (P2), US7 (P2), US8 (P3).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1–US8)
- Exact file paths are included in every description

## Path Conventions

Web app: `backend/src/`, `frontend/src/`, `backend/tests/`, `frontend/tests/e2e/`, `backend/prisma/` (per plan.md project structure).

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Wire the new operator-configurable settings and dependency the feature introduces, before any story code touches them.

- [x] T001 Extend `backend/src/config/index.ts` to load the new operator settings used by the feature: `CORS_ORIGINS` (optional allow-list; unset = closed in production), `CSP_FONT_ORIGIN`, rate-limit budgets (defaults per FR-001: ≤ 10 sign-in failures / 15 min per source; ≤ 3 registration failures / 15 min per source; ≤ 5 sign-in failures / 15 min per account), access-token lifetime (≤ 1 h; implementation default 10 min per research D3), session cap (30 days), and the `JWT_SECRET` strength gate inputs (≥ 32 chars, non-default)
- [x] T002 [P] Add the `cookie` runtime dependency to `backend/package.json` (research D4 — zero transitive deps, used for `Set-Cookie` serialization) and verify `npm install` succeeds in `backend/`

**Checkpoint**: Configuration surface exists; no story task may read a setting that is not declared in `config/index.ts`

## Phase 2: Foundational (Shared Infrastructure)

**Purpose**: The Prisma schema migration and the shared backend modules (session engine, audit capture) that multiple user stories depend on. Per plan.md, one migration introduces `UserSession`, `AuditEvent`, `PendingInvitation`, and extends `SharePermission`.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [x] T003 Extend `backend/prisma/schema.prisma` and create the migration `prisma/migrations/<ts>_security_hardening` adding: `UserSession` (fields per data-model.md: `id` uuid PK, `userId` FK `onDelete: Cascade`, `refreshTokenHash`, `previousRefreshHash?`, `issuedAt`, `lastRefreshAt`, `expiresAt`, `revokedAt?`, `createdAt`/`updatedAt`; indexes `[userId]`, `[refreshTokenHash]`, `[expiresAt]`); `AuditEvent` (`id` uuid PK, `actorUserId?` FK `onDelete: SetNull`, `action` string using the 13-value list from data-model.md, `targetType?`, `targetId?`, `outcome`, `ip?`, `detail` Json?, `createdAt`; indexes `[createdAt]`, `[actorUserId]`, `[targetType, targetId]`); `PendingInvitation` (`id` uuid PK, `giftListId` FK `onDelete: Cascade`, `inviteeEmail`, `ownerUserId` FK, `status` enum `InvitationStatus { pending matched discarded }`, `createdAt`, `expiresAt?`; `@@unique([giftListId, inviteeEmail])`, `@@index([inviteeEmail, status])`); and `SharePermission` gains `recipientEmail String?` and `nameDisclosureConsent` enum `NameDisclosureConsent { pending revealed declined }` (default `pending`). Apply via `npx prisma migrate dev --name security_hardening` in `backend/`
- [x] T004 [P] Implement the session engine in `backend/src/auth/session.ts`: create a session on sign-in (store only SHA-256 hash of the refresh token + `previousRefreshHash`), issue the short-lived access JWT (claim `sid`, `exp` ≤ 1 h / 10-min default), rotate the refresh token on every refresh (old hash → `previousRefreshHash`), treat presentation of a stale (previously rotated) token as a theft signal that revokes the session (FR-026), and enforce the 30-day `expiresAt` cap and `revokedAt` revocation (FR-007/008) — per research D3/D5
- [x] T005 [P] Implement the audit capture module in `backend/src/audit/events.ts`: async fire-and-forget `recordAuditEvent({ actorUserId?, action, targetType?, targetId?, outcome, ip?, detail? })` writing `AuditEvent` rows (research D7); the module MUST NOT throw into the request path and MUST NOT accept or store credentials, tokens, passwords, or request payloads (FR-013); no update/delete path for audit rows — 5-year minimum retention means the app never prunes them (FR-013)
- [x] T006 Implement `POST /auth/refresh` and `POST /auth/logout` in `backend/src/auth/router.ts` per contracts/api.md: refresh returns `{ user }` + new `gifty_access` cookie + rotated `gifty_refresh` cookie, or 401 `{ "error": "Session is no longer active.", "reason": "expired" | "revoked" | "stale_refresh" }` (stale replay revokes the whole session family per FR-026 and clears both cookies; a successful refresh slides the 30-day cap); logout (requires resolvable `sid`) revokes server-side, returns 204, clears both cookies, and is idempotent — an already-revoked/expired session returns the same stable 401 `{ "error": "Session is no longer active." }` (edge case "Sign-out on an already-revoked or expired session"); set `gifty_access` with `HttpOnly; Secure (production); SameSite=Lax; Path=/` and `gifty_refresh` with `Path=/auth/refresh` (FR-009, contracts)
- [x] T007 Extend `backend/src/auth/middleware.ts` so `requireAuth` resolves the `gifty_access` cookie, verifies the JWT, AND confirms the `UserSession` row referenced by `sid` exists, is unrevoked, and unexpired — rejecting credentials for revoked/expired sessions even before the token's `exp` (FR-008); `authorizeList` / `authorizeItem` permission logic is unchanged (FR-016–019 do-not-regress)
- [x] T008 [P] Unit tests for the session engine (rotation, reuse/revocation, expiry, concurrent-use single-winner per edge case "Concurrent refresh-token use") in `backend/tests/unit/session.test.ts`
- [x] T009 [P] Unit tests for audit capture (fire-and-forget never rejects the caller; sensitive data never stored; all 13 `action` values accepted) in `backend/tests/unit/audit-events.test.ts`

**Checkpoint**: Foundation ready — schema applied, session + audit modules in place, `/auth/refresh` + `/auth/logout` live, `requireAuth` session-aware. User story implementation can now begin in parallel.

## Phase 3: User Story 1 - Stop credential abuse at the door (Priority: P1) 🎯 MVP

**Goal**: Throttle sign-in/register per source and per account, reject weak passwords with a clear message, and issue the cookie-based two-layer credentials on successful auth.

**Independent Test**: Repeated failed logins from a single source are throttled and eventually locked out (and per-account when the source IP rotates); a registration with a weak password is rejected with a clear message; a legitimate login works within budget and returns `Set-Cookie` instead of a `token` field.

### Tests for User Story 1 ⚠️

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [ ] T010 [P] [US1] Contract test for the rate-limit contract (exhausted budgets → `429` with body identical to a failed sign-in, no account-existence hint; per-account budget holds under source-IP rotation) in `backend/tests/contract/rate-limit.test.ts`
- [ ] T011 [P] [US1] Unit tests for password policy (8+ chars with uppercase/lowercase/number/symbol; rejection message describes the requirement) in `backend/tests/unit/password-policy.test.ts`
- [ ] T012 [P] [US1] Integration test for the sign-in flow: uniform 401 body for unknown email vs wrong password (FR-020), plus a best-effort loose timing-window assertion (same order of magnitude; do not assert exact ms) that unknown-email vs wrong-password responses are in the same timing class (FR-020), `Set-Cookie` issued on success, `token` field absent from the 200 body, and concurrent duplicate registration → exactly one account + clean "already exists" in `backend/tests/user-story-1-hardened.test.ts`

### Implementation for User Story 1

- [ ] T013 [P] [US1] Implement the in-memory rate limiter (per-source + per-account budgets, 15-min window TTL, trusted-proxy client-IP extraction with TCP-peer fallback) in `backend/src/auth/rate-limit.ts` per research D1; defaults from T001 (10 sign-in / 3 registration per source; 5 per account, sign-in only); counters are per-process and reset on restart (documented single-replica assumption)
- [ ] T014 [P] [US1] Implement the password policy validator (8+ chars incl. one uppercase, one lowercase, one number, one symbol; stable user-facing requirement message) in `backend/src/auth/password-policy.ts` (FR-002)
- [ ] T015 [US1] Wire the rate limiter into `POST /auth/login` and `POST /auth/register` in `backend/src/auth/router.ts`: on budget exhaustion refuse with the stable message identical to a failed attempt (429 body indistinguishable per contracts/api.md; `Retry-After` MAY be present), record `auth_rate_limited` via `backend/src/audit/events.ts`, and keep the registration "already exists" 409 as the intentional FR-020 carve-out (depends on T013)
- [ ] T016 [US1] Wire the password policy into `POST /auth/register` in `backend/src/auth/router.ts`: reject below-policy passwords with 400 and the stable policy message `{ "error": "Password must be at least 8 characters and include an uppercase letter, a lowercase letter, a number, and a symbol." }`; record `auth_register_success` / `auth_register_failure` audit events (depends on T014)
- [ ] T017 [US1] Reissue credentials as cookies in `backend/src/auth/router.ts`: on successful login/register create the `UserSession` via `backend/src/auth/session.ts`, send `gifty_access` + `gifty_refresh` per the contracts cookie table, remove the `token` field from the response body, and record `auth_login_success` / `auth_login_failure` audit events with the source IP (depends on T006)
- [ ] T018 [US1] Show the password-policy rejection message on sign-up failure in `frontend/src/pages/AuthPage.tsx`, rendering the exact stable 400 body message produced by T016 (FR-002 acceptance scenario 3; depends on T016)

**Checkpoint**: User Story 1 fully functional — credential-guessing is throttled, weak passwords rejected, auth issues script-unreadable cookies. Validate independently (T010–T012 green; existing auth suites still pass).

## Phase 4: User Story 2 - Secure defaults at the trust boundary (Priority: P1)

**Goal**: Closed-by-default CORS in production and browser-security directives (CSP with the permitted font source, no `X-Powered-By`, HSTS in production) on the served app and API.

**Independent Test**: A page on a non-permitted origin gets 0 successful authenticated cross-origin reads while a permitted origin works; the served document carries CSP restricting content/scripts/styles to self + the permitted font source.

### Tests for User Story 2 ⚠️

- [ ] T019 [US2] Contract tests for the trust boundary in `backend/tests/contract/trust-boundary.test.ts`: no `Access-Control-Allow-Origin` when `CORS_ORIGINS` is unset in production; exactly the listed origins when set (one allowed origin must not open the API to all others — edge case "Cross-origin with allowed origin") with `Access-Control-Allow-Credentials: true`; CSP present in production with the font source permitted; `X-Powered-By` absent (SC-003, SC-005)

### Implementation for User Story 2

- [ ] T020 [US2] Implement closed-by-default CORS in `backend/src/app.ts`: production sends no `Access-Control-Allow-Origin` unless the origin is in `CORS_ORIGINS` (from T001), then sends exactly that origin + `Access-Control-Allow-Credentials: true` (FR-003); development keeps the permissive default for the Vite dev flow
- [ ] T021 [US2] Add the security headers to `backend/src/app.ts`: `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' <font-origin>; img-src 'self' data:; connect-src 'self'` with `<font-origin>` from config (FR-004), `Strict-Transport-Security: max-age=31536000; includeSubDomains` in production only, and disable Express's `X-Powered-By` (`app.disable('x-powered-by')`) (FR-012)

**Checkpoint**: Trust boundary closed by default and hardened. Validate independently (T019 green; app still serves normally for its own origin).

## Phase 5: User Story 3 - Never boot with a weak or missing secret (Priority: P1)

**Goal**: The startup gate refuses to serve in production with a missing/weak/default signing secret or the known-default database credential, and the default DB credential is removed from the compose default.

**Independent Test**: Starting the app in a production context with a missing/weak/default `JWT_SECRET` or the default DB credential exits non-zero with an actionable message; a strong non-default config starts and serves.

### Tests for User Story 3 ⚠️

- [ ] T022 [US3] Boot-gate tests in `backend/tests/unit/boot-gate.test.ts`: production context fails (non-zero) for missing `JWT_SECRET`, < 32-char `JWT_SECRET`, and a known-default `JWT_SECRET`, and for the known-default `POSTGRES_PASSWORD` — each failure message names the offending value and what must change (FR-005); a strong secret + non-default DB credential starts (US3 acceptance scenario 4); local development is not blocked by production-only rules (edge case "Weak secret in a non-production context")

### Implementation for User Story 3

- [ ] T023 [US3] Extend `validateConfig()` in `backend/src/config/index.ts` (enforced from `backend/src/server.ts`): production context refuses to boot when `JWT_SECRET` is missing, below 32 characters, or a known default, and when the database credential is a known default; each refusal message identifies which value failed and what must change (FR-005/FR-006); production-vs-development distinguished by the existing environment signal (Assumptions)
- [ ] T024 [US3] Remove the `POSTGRES_PASSWORD` default (`gifty_dev_password`) from `docker-compose.yml` — require the credential via the environment in production (FR-006, plan.md Constraints); verify `docker-compose.codespace.yml` and `docker-compose.dev.yml` remain usable for development

**Checkpoint**: Insecure configurations cannot boot in production. Validate independently (T022 green; `npm run docker:up` still starts with an explicit strong secret).

## Phase 6: User Story 4 - Shrink the blast radius of a stolen session (Priority: P2)

**Goal**: The client is fully cookie-backed (no credential in `localStorage`), transparently refreshes on 401, signs out via the server, and — when the session is terminated by refresh-token reuse — is returned to sign-in with a security notice recommending a password change (FR-027).

**Independent Test**: A captured access credential is rejected after its bounded lifetime and on sign-out; a stolen refresh credential cannot be used twice; signing out rejects both credentials immediately; no credential is readable by page scripts; a reuse-triggered termination lands the user on sign-in with the security notice.

### Tests for User Story 4 ⚠️

- [ ] T025 [P] [US4] Unit tests for the reworked `AuthContext` (no token in state/localStorage; session derived from cookie-backed API; logout calls `POST /auth/logout` and clears state) and `api.ts` (transparent 401 → `POST /auth/refresh` → retry once; `stale_refresh` → sign out + security notice; no credential ever read from script storage) in `frontend/src/context/AuthContext.test.tsx`
- [ ] T026 [P] [US4] E2E spec for the session lifecycle in `frontend/tests/e2e/session-revocation.spec.ts`: sign-in issues HttpOnly cookies (not readable by page script); sign-out invalidates both credentials immediately; an expired session forces re-authentication; a refresh 401 with `reason: "expired"` (or `"revoked"`) routes the user to sign-in WITHOUT the security notice; a stale refresh replay revokes the session family and the app shows the security notice recommending a password change (FR-026/FR-027, SC-005)

### Implementation for User Story 4

- [ ] T027 [P] [US4] Rework `frontend/src/context/AuthContext.tsx`: remove all `localStorage['gift-list-token']` persistence and token state; derive the session from the cookie-backed API (`GET /account`); expose `logout()` calling `POST /auth/logout` (FR-008/FR-009)
- [ ] T028 [P] [US4] Rework `frontend/src/services/api.ts`: drop the `Authorization` header and stored token; on 401 call `POST /auth/refresh` once and retry the failed request; on `reason: "stale_refresh"` clear the session, surface the FR-027 security notice ("session ended for security reasons — change your password"), and route to sign-in; on `expired`/`revoked` return the user to the sign-in flow (FR-027); never read, store, or log either cookie
- [ ] T029 [US4] Render the FR-027 security notice in the sign-in flow (e.g., `frontend/src/pages/AuthPage.tsx` via `AuthContext`) and verify every page route transitions to sign-in when the session is terminated — no authenticated page is left in a state where it can no longer act (FR-027)

**Checkpoint**: Session compromise is time-boxed, revocable, theft-detecting, and script-unreadable end-to-end. Validate independently (T025–T026 green; e2e login flow still works).

## Phase 7: User Story 5 - Recipients choose when their identity is revealed (Priority: P1)

**Goal**: Recipient identity is consent-gated per list: placeholder to co-recipients until consent, owner sees the invite email, one-time prompt on first open, self-serve control, consent-aware claimant names, owner email never exposed, and unregistered emails held as pending invitations matched at registration.

**Independent Test**: Share a list with a recipient; co-recipients see the "????" placeholder (no name, no email) until the recipient consents on first open; after consent the display name is visible to owner and co-recipients while the email stays owner-only; sharing to an unregistered email is indistinguishable from a registered share and surfaces when that person registers.

### Tests for User Story 5 ⚠️

- [ ] T030 [P] [US5] Consent endpoint tests in `backend/tests/consent.test.ts`: `GET /lists/:listId/consent` returns the state + the recipient's own display name (200) or 403 for non-recipients / 404 for missing list; `POST /lists/:listId/consent` sets `revealed`/`declined` in either direction at any time (400 on bad body; FR-021/FR-023)
- [ ] T031 [P] [US5] Identity-visibility tests in `backend/tests/consent-visibility.test.ts`: co-recipient lists show the `"????"` placeholder for non-consented recipients and claimants (FR-021/FR-024); after `revealed` the display name appears to owner AND co-recipients with the email still owner-only (SC-008); the owner's email is absent from all recipient-visible responses — `GET /lists`, `GET /lists/:id`, and item-list responses (FR-025); consent is per-list (edge case "Consent is per-list"); re-invite after revocation resets consent to `pending` (edge case "Re-share after revocation")
- [ ] T032 [P] [US5] Pending-invitation tests in `backend/tests/pending-invitation.test.ts`: `POST /lists/:listId/share` to an unregistered email succeeds with the same status/body as a registered share (no 404 path; FR-010); registration with that email transactionally converts every matching `pending` invitation into a `SharePermission` (consent `pending`) and marks it `matched` (SC-009); a pending invitation grants no access until matched; revoking the share or removing the account discards outstanding invitations (edge cases "Pending invitation lifecycle", "Account removal with pending invitations outstanding")
- [ ] T033 [P] [US5] E2E specs in `frontend/tests/e2e/consent.spec.ts` (prompt on first open → reveal → name visible; decline → placeholder persists; self-serve control in Sharing section re-opens the choice) and `frontend/tests/e2e/pending-invitation.spec.ts` (share to unknown email → nothing surfaces; register with that email → list visible, consent prompt appears)

### Implementation for User Story 5

- [ ] T034 [P] [US5] Implement the consent endpoints in `backend/src/gift-lists/router.ts` (or a new `consent.ts` router mounted alongside): `GET /lists/:listId/consent` and `POST /lists/:listId/consent` per contracts/api.md — recipient-only (403 otherwise), body `{ "consent": "revealed" | "declined" }` validated, revocable in either direction without affecting view/claim ability (FR-021/FR-023)
- [ ] T035 [P] [US5] Make `POST /lists/:listId/share` in `backend/src/gift-lists/router.ts` indistinguishable (FR-010): registered email → `SharePermission` (set `recipientEmail`, consent `pending`); unregistered email → create `PendingInvitation` (`inviteeEmail` normalized: trimmed, lowercased) with the SAME success response shape — no `404 not found` path, no distinct message (SC-009); re-invite after revocation creates a fresh `SharePermission` (consent resets to `pending`)
- [ ] T036 [P] [US5] Extend `decorateItemIdentity` and the list-owner/recipient decoration in `backend/src/common/identity.ts` to be consent-aware: resolve a recipient/claimant display name ONLY when that user's `nameDisclosureConsent` on the list is `revealed`; otherwise return the placeholder `"????"`; owner view always shows the invite email from `recipientEmail`; the owner's email is stripped from recipient-visible responses (data-model.md visibility matrix; FR-016/FR-021/FR-024/FR-025 do-not-regress)
- [ ] T037 [US5] Match pending invitations at registration in `backend/src/auth/router.ts`: after a successful `POST /auth/register`, in the same transaction convert every `PendingInvitation` with matching `inviteeEmail` and `status = pending` into a `SharePermission` (consent `pending`) and mark each `matched` (FR-010, SC-009; depends on T035 for the invitation rows)
- [ ] T038 [P] [US5] Create the one-time consent prompt component in `frontend/src/components/ConsentPrompt.tsx`: shown once when a recipient first opens a shared list with consent `pending` (from `GET /lists/:listId/consent`); affirm → `POST /lists/:listId/consent` with `revealed`; decline → `declined`; not repeated unless the choice changes (FR-022, Assumptions "Name-disclosure defaults"); mount it from `frontend/src/pages/ListPage.tsx`
- [ ] T039 [P] [US5] Add the self-serve "identify yourself / hide again" control in the list's Sharing section to `frontend/src/components/PermissionManager.tsx`: toggle consent either direction at any time via the consent endpoints; revocation returns the recipient to the placeholder (FR-023)

**Checkpoint**: Identity disclosure is consent-gated end-to-end. Validate independently (T030–T033 green; SC-008/SC-009 behaviors observable; owner-privacy suite still passes).

## Phase 8: User Story 6 - Stop leaking reconnaissance signals (Priority: P2)

**Goal**: Probing the app reveals nothing about account existence, framework, or internal errors — generic 5xx messages in production and no framework/server fingerprints.

**Independent Test**: Sign-in with a known vs unknown email yields indistinguishable outcomes (status, message, timing class); a production 5xx exposes no stack trace, file path, or library detail; no response advertises the framework or server name.

### Tests for User Story 6 ⚠️

- [ ] T040 [P] [US6] Error-hygiene contract tests in `backend/tests/contract/error-hygiene.test.ts`: induced internal failures return the single stable production body `{ "error": "An internal error occurred." }` with no stack/path/detail (FR-011); `X-Powered-By` absent on every response (FR-012); sign-in failures (unknown email vs wrong password vs rate-limited) are uniform in status+body (FR-020; conformance notes in contracts/api.md)
- [ ] T041 [P] [US6] Enumeration tests for the share flow in `backend/tests/contract/share-enumeration.test.ts`: `POST /lists/:listId/share` to a registered vs unregistered email returns the same status and body (FR-010, US6 acceptance scenario 1)

### Implementation for User Story 6

- [ ] T042 [US6] Harden the error path in `backend/src/common/errors.ts` and `backend/src/app.ts`: in production, all unhandled/5xx responses collapse to the stable generic body with no stack trace, file path, query, or driver detail (FR-011); 4xx bodies keep their specific stable messages; verify Express error handlers and Prisma error mapping do not leak internals (US6 acceptance scenario 2)
- [ ] T043 [US6] Verify and, where needed, remove framework/server fingerprints in `backend/src/app.ts`: confirm `X-Powered-By` disabled (from T021), no `Server` header identifying the framework, and no other response advertises implementation detail (FR-012, US6 acceptance scenario 3)

**Checkpoint**: Recon signals stripped. Validate independently (T040–T041 green; US1's uniform-failure contract still holds).

## Phase 9: User Story 7 - Provide an audit trail and a data lifecycle (Priority: P2)

**Goal**: Every security-relevant action (success and failure) produces an attributable audit record, and a user can remove their account with the clarified cascade — no longer authenticating, personal data gone through the app, claims cleared, lists deleted, nothing newly revealed.

**Independent Test**: A sequence of sign-in, share, claim, delete actions produces an attributable record in the data store; after a confirmed account removal the account cannot authenticate and the user's data is no longer accessible, while the other list's visibility rules are unchanged.

### Tests for User Story 7 ⚠️

- [ ] T044 [P] [US7] Audit coverage tests in `backend/tests/audit-trail.test.ts`: each security-relevant action — `auth_login_success`/`auth_login_failure`/`auth_register_success`/`auth_register_failure`/`auth_rate_limited`, `list_share`, `list_revoke`, `item_claim`, `item_purchase`, `item_revert`, `session_revoked`, `session_reuse_detected`, `account_removal` — produces an `AuditEvent` row with attributable identity (nullable for anonymous failures), target, outcome (including `denied`/`failure` — edge case "Audit under failure"), timestamp, and source IP; no credential/token/password/payload data stored (SC-001, FR-013)
- [ ] T045 [P] [US7] Removal-cascade tests in `backend/tests/account-removal.test.ts`: `DELETE /account` (401 when unauthenticated) → user can no longer authenticate; owned lists + items + shares + pending invitations deleted; claims on other users' items revert to `available` with `claimantUserId` cleared while that list's other content is unchanged; `SharePermission` rows where the user is the recipient on others' lists are deleted (FR-014, edge case "Removal while a recipient on others' lists"); no recipient name/email newly revealed to remaining viewers (edge case "Owner removed while items are claimed (consent interaction)"); audit rows survive with `actorUserId` nulled (data-model.md); `account_removal` recorded (US7 scenarios 2–4)
- [ ] T046 [P] [US7] E2E spec for account removal in `frontend/tests/e2e/account-removal.spec.ts`: dedicated account area → irreversible confirmation (naming list deletion + claim clearing) → removal → app returns to sign-in; no undo/grace period surfaced (FR-028)

### Implementation for User Story 7

- [ ] T047 [US7] Wire audit captures across the routers (using `backend/src/audit/events.ts` from T005): `list_share` and `list_revoke` in `backend/src/gift-lists/router.ts` (incl. denied attempts); `item_claim` / `item_purchase` / `item_revert` in `backend/src/gift-items/router.ts` (outcome incl. denied, atomicity untouched — FR-017); `session_revoked` (sign-out) and `session_reuse_detected` (theft signal) in `backend/src/auth/router.ts` / `backend/src/auth/session.ts`; `account_removal` in the removal module; every event carries `outcome` (`success` | `denied` | `failure`) and the trusted-proxy IP (FR-013, SC-001)
- [ ] T048 [US7] Implement the removal cascade in `backend/src/account/removal.ts` (research D12 — single transaction): revoke all the user's sessions → clear the user's claims on others' items (reset `claimantUserId`/`state`/`claimedAt`/`purchasedAt` to unclaimed) → delete owned lists (items, shares, pending invitations cascade) → delete `SharePermission` rows where the user is the recipient on others' lists → delete the user row; audit `account_removal` inside the transaction; then mount `DELETE /account` in `backend/src/auth/router.ts` (or `backend/src/account/router.ts`) returning 204 + both cookies cleared, 401 when unauthenticated (FR-014, contracts/api.md)
- [ ] T049 [US7] Create the dedicated account area in `frontend/src/pages/AccountPage.tsx` and route it in `frontend/src/App.tsx`: removal action behind an explicit confirmation that states removal is final — owned lists/items permanently deleted and claims on other lists cleared — with no grace period, undo, or soft-delete (FR-028); after success clear the `AuthContext` session and route to sign-in
- [ ] T050 [US7] Add the account area to the user navigation in `frontend/src/pages/DashboardPage.tsx` (entry point to `AccountPage`) and verify the consent self-serve control (T039) and account area do not conflict in the Sharing/account surfaces

**Checkpoint**: Audit trail complete and removal works end-to-end. Validate independently (T044–T046 green; existing user-story suites for claims/sharing still pass).

## Phase 10: User Story 8 - Keep the software supply chain clean (Priority: P3)

**Goal**: Zero known high/critical-severity vulnerabilities in the production runtime, and release verification blocks new ones.

**Independent Test**: A dependency audit of the production runtime reports zero high/critical findings; a planted vulnerable dependency fails the release-verification audit.

### Tests for User Story 8 ⚠️

- [ ] T051 [US8] Verify the release-verification audit script fails (non-zero) when a high/critical finding is present (e.g., against a deliberately vulnerable pinned dependency in a scratch install) and passes once it is fixed — proving the gate blocks rather than merely reports (FR-015, US8 scenario 2)

### Implementation for User Story 8

- [ ] T052 [P] [US8] Run `npm audit fix --omit=dev` (or update the offending dependencies) in `backend/` and `frontend/` until the production runtime has zero high/critical-severity findings (FR-015, SC-006, research D10)
- [ ] T053 [P] [US8] Add a release-verification audit script to the root `package.json` (`"audit:prod"`: runs `npm audit --omit=dev --audit-level=high` in `backend/` and then in `frontend/`) that exits non-zero on any high/critical finding so a release is blocked unless the finding is fixed or explicitly accepted (FR-015, US8 scenario 2)

**Checkpoint**: Supply chain verified clean. Validate independently (root `npm run audit` passes in both apps).

## Phase 11: Polish & Cross-Cutting Concerns

**Purpose**: Full regression and end-to-end validation across all stories.

- [ ] T054 Run the complete backend suite (existing 80 tests + all new suites — explicitly including the do-not-regress suites `backend/tests/unit/access.test.ts` (FR-018/FR-019), `backend/tests/sc-validation.test.ts` (FR-016/FR-017), and `backend/tests/user-story-4-revert.test.ts` (FR-017/FR-019)) and the frontend unit suite in `backend/` and `frontend/` and fix any regressions (SC-007)
- [ ] T055 [P] Run the full Playwright e2e suite (existing 8 tests + new specs: `consent.spec.ts`, `session-revocation.spec.ts`, `pending-invitation.spec.ts`, `account-removal.spec.ts`) against `npm run docker:up` (http://localhost:8080) and fix any failures
- [ ] T056 Run the `specs/003-security-hardening/quickstart.md` validation scenarios end-to-end and confirm each user story's independent test passes; confirm `GET /healthz` → `{"status":"ok"}` and the do-not-regress suites (owner-privacy, claim-integrity, deny-by-default) are green
- [ ] T057 [P] Update `docs/` and `README.md` with the new operator settings (`CORS_ORIGINS`, `CSP_FONT_ORIGIN`, rate-limit budgets, secret-strength requirements), the single-replica rate-limit limitation, the 5-year audit retention, and the `npm run audit` release gate

**Checkpoint**: Feature complete — all stories independently validated, no regressions, operator documentation current.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on Setup (T001 config, T002 `cookie` dep) — BLOCKS all user stories
- **User Stories (Phases 3–10)**: All depend on Foundational (Phase 2). US5 (T037) additionally depends on T035 (invitations exist before registration can match them). US4, US6, US7, US8 may proceed in parallel with each other once Phase 2 is done
- **Polish (Phase 11)**: Depends on all desired user stories being complete

### User Story Dependencies

- **User Story 1 (P1)**: First story after Foundational — no other-story dependencies (🎯 MVP)
- **User Story 2 (P1)**: Independent of US1 (separate file `app.ts`); shares Phase 2 foundation
- **User Story 3 (P1)**: Independent (config + compose); shares Phase 2 foundation
- **User Story 4 (P2)**: Consumes the Phase 2 session engine (`session.ts`, `/auth/refresh`, `/auth/logout`); no US1 dependency
- **User Story 5 (P1)**: Consumes Phase 2 schema (`SharePermission` columns, `PendingInvitation`); T037 depends on T035 within the story
- **User Story 6 (P2)**: Builds on US2's headers (T021) for the fingerprint checks; otherwise independent
- **User Story 7 (P2)**: Consumes the Phase 2 audit module; T048 depends on the Phase 2 `UserSession` table
- **User Story 8 (P3)**: Fully independent (package manifests + root script)

### Within Each User Story

- Tests MUST be written and FAIL before implementation (constitution Principle III)
- Modules before wiring (e.g., `rate-limit.ts` before its router hook; `identity.ts` before the consent UI)
- Core implementation before UI integration
- Story complete (its checkpoint) before moving to the next priority

### Parallel Opportunities

- Phase 1: T001 ∥ T002 (different files)
- Phase 2: T004 ∥ T005 (session engine ∥ audit module); T008 ∥ T009 (their unit tests)
- US1: T010–T012 (tests) in parallel; T013 ∥ T014 (rate-limit ∥ password-policy); T018 independent of the backend tasks
- US4: T025 ∥ T026 (tests); T027 ∥ T028 (AuthContext ∥ api.ts)
- US5: T030–T033 (tests) in parallel; T034 ∥ T035 ∥ T036 (consent endpoints ∥ share router ∥ identity); T038 ∥ T039 (consent prompt ∥ Sharing control)
- US6: T040 ∥ T041 (tests)
- US7: T044–T046 (tests) in parallel
- US8: T052 ∥ T053
- Cross-story: after Phase 2, US2/US3/US4/US5/US6/US7/US8 can proceed in parallel (if staffed); at minimum US1 → US2 → US3 → US5 form the P1 core
- Polish: T054 ∥ T055 ∥ T057

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (T001–T002)
2. Complete Phase 2: Foundational (T003–T009) — CRITICAL, blocks all stories
3. Complete Phase 3: User Story 1 (T010–T018)
4. **STOP and VALIDATE**: US1's independent test — throttled sign-in/register, weak-password rejection with the clear message, cookie-based sign-in; existing suites green

### Incremental Delivery (priority order)

1. **P1 core**: US1 → US2 → US3 → US5 (each validated at its checkpoint) — this set closes the exploitable gaps: credential abuse, open trust boundary, weak-secret boot, and unconsented identity disclosure
2. **P2**: US4 (cookie-backed client + theft detection UX), US6 (recon hygiene), US7 (audit + removal)
3. **P3**: US8 (supply chain)
4. Phase 11 Polish: full regression + quickstart validation

### Validation Gate (before declaring done)

- All of `backend/tests/` (80 existing + new) and `frontend` unit suites pass (SC-007)
- All Playwright e2e specs pass against `npm run docker:up`
- `specs/003-security-hardening/quickstart.md` scenarios all pass
- Root `npm run audit` reports zero high/critical findings (SC-006)
- Do-not-regress invariants verified: FR-016 owner privacy, FR-017 claim atomicity, FR-018 deny-by-default, FR-019 owner-cannot-claim

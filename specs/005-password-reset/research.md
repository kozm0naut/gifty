# Research: Password Reset (005)

**Feature**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md) | **Date**: 2026-10-12

All `NEEDS CLARIFICATION` markers from the Technical Context are resolved below.
The codebase already contains the two closest analogues — 003 (cookie sessions,
rate limiting, audit) and 004 (token + outbox email flow) — so most decisions are
"mirror the proven pattern", not open-ended research.

---

## D1 — Where the reset token lives: dedicated table, not User columns

**Decision**: A new `PasswordResetToken` table (one row per issued reset link) with
columns `id`, `userId`, `tokenHash` (SHA-256, unique), `createdAt`, `expiresAt`,
`consumedAt`.

**Rationale**:
- The spec models the reset request as its own entity with a lifecycle
  (issued / consumed / expired) — a table expresses that directly.
- `User` already carries the confirmation token columns; reusing that shape would
  mean a reset request for an account that is *mid-reset* overwrites (invalidates)
  its own pending token, making concurrent-request behavior implicit in the user row
  rather than explicit per-token rows.
- Consume-time lookup by `tokenHash` returns `userId` + expiry in one query — no
  extra `User` fetch before the password write.

**Alternatives considered**:
- *Columns on `User`* (`resetTokenHash`, …): simpler schema, but conflates two token
  lifecycles (confirmation vs reset) on one row and breaks concurrent request/reset
  semantics (a second request overwrites the pending token). Rejected.
- *Separate `PasswordResetRequest` table + token table*: over-models a flow that
  issues at most one live token per account; the outbox already records the email
  side. Rejected (spec's "Password Reset Request" entity is satisfied by
  token row + outbox row together).

## D2 — Token mechanics: mirror `email/verification.ts`

**Decision**: 256-bit `crypto.randomBytes(32).toString('base64url')`; store only the
SHA-256 hex digest (`tokenHash`, unique); single use via an atomic conditional
`updateMany` (`where { tokenHash, consumedAt: null, expiresAt: { gte: now } }`); TTL
from `RESET_TOKEN_TTL_HOURS` (default 24 h) as a new `resetTokenTtlHours` config key.

**Rationale**: FR-004/FR-005/FR-006 map 1:1 onto the proven 004 mechanics
(256-bit entropy, non-reversible storage, atomic single-use consume, indistinguishable
failure). Reusing the same crypto helpers keeps the review surface tiny.

**Alternatives considered**: Argon2id-hashed tokens (overkill — the token is
high-entropy, not a guessable secret); UUID tokens (lower entropy, and the codebase
already standardized on 256-bit random + SHA-256). Rejected.

## D3 — Delivery: new `OutboxKind.reset`, same queue

**Decision**: Extend the `OutboxKind` enum with `reset`; add
`enqueueReset(tx, { userId, recipientEmail, subject, bodyText })` in `email/outbox.ts`
using the **supersede pattern from `enqueueConfirmation`** (flip prior
`queued`/`sending` reset rows for the same user to `superseded`, then insert).
Add `buildResetLink(token)` to `email/links.ts`
(`{publicOrigin}/reset/{token}`).

**Rationale**: The 004 outbox already provides durability, retry/backoff, terminal
`failed`, and the live/capture/disabled tri-mode. FR-002's "uniform response even in
disabled mode" falls out for free: in disabled mode the request endpoint simply does
not enqueue and still returns the uniform body. Zero new delivery machinery.

**Alternatives considered**: Direct mailer call in the request endpoint (no durability,
breaks capture-mode testability); a second queue (duplicated drainer logic). Rejected.

## D4 — Rate limiting: two new budget keys

**Decision**: Reuse `auth/rate-limit.ts`; add budgets:
- `reset-request` per source (client IP) — default **5 / window**
  (`RESET_MAX_PER_SOURCE`, default 5);
- `reset-request` per account (normalized email) — default **5 / window**
  (`RESET_MAX_PER_ACCOUNT`, default 5);
- window reuses `RATE_LIMIT_WINDOW_MINUTES` (default 15 min).

Throttle applies **before** any account lookup. 429 body is the *same uniform body*
as success (see D5), with `Retry-After` — mirroring 003's register throttle, so the
429 cannot become an enumeration oracle.

**Rationale**: FR-007 requires both per-source and per-account limiting; the existing
sliding-window store and `clientIp` (with the `TRUST_PROXY` guard) already implement
both dimensions correctly.

**Alternatives considered**: Global (per-IP-only) budget (defeats IP rotation for
inbox flooding); per-account-only (lets one source spam every mailbox). Both rejected —
spec names both.

## D5 — Request endpoint: uniform 200 + timing equalization

**Decision**: `POST /auth/reset-request` (`{ email }`) returns **`200 OK` with one
stable body in every case** — registered email, unregistered email, malformed email
(but present), rate-limited (429 shares the body + `Retry-After`):

```json
{ "message": "Please check your email for the password reset link" }
```

(Message text pinned for posterity — this exact string is the uniform body `U`
in the 005 contract.)

When the email matches no account, the endpoint still performs one
`bcrypt.compare` against a precomputed dummy hash (pattern from
`auth/router.ts` `DUMMY_PASSWORD_HASH`) so the two paths land in the same timing
class.

**Rationale**: FR-002 + SC-002 (zero enumeration). The 003 codebase already established
the "uniform body + dummy hash" idiom for exactly this threat; reusing it is the
lowest-risk path.

**Alternatives considered**: 202 for registered / 204 for unknown (enumeration —
rejected, violates FR-002); 200 only + no timing guard (leaks via latency — rejected,
violates SC-002's intent).

## D6 — Consume endpoint: uniform failure, success signs the user in

**Decision**: `POST /auth/reset` (`{ token, newPassword, confirmPassword }`):
- **Order of operations**: validate body shape → validate password policy
  (stateless, identical work for valid/invalid tokens) → look up + atomically claim
  the token row → on claim failure return **400 `{ "message": "This reset link is
  invalid or has expired." }`** (one body, *pinned*, for unknown/expired/consumed
  token — indistinguishable across the classes, FR-004); on claim success perform the
  password change in one Prisma transaction.
- **Success**: `200 OK` `{ "status": "reset", "user": { id, email, displayName, verified: true } }`
  **plus a fresh session cookie pair** (`setSessionCookies`, same as login) — FR-014.

**Rationale**: The 004 `GET /confirm` precedent chose *uniform outcomes* for token
failures (indistinguishable), so a single 400 body for the whole invalid-token class is
consistent. Success *must* sign in (clarification Q2=A) — reusing `createSession` +
`setSessionCookies` is the same code path as `/auth/login`, so no new session
semantics.

**Alternatives considered**: 200 for everything including failure (client cannot
distinguish success — breaks the "password updated, you are signed in" UX); distinct
410/409/404 per failure mode (leaks which failure — against the 004 uniformity
precedent). Rejected.

## D7 — Atomic success semantics (FR-008/012/013)

**Decision**: One Prisma transaction, in order:
1. Claim token row (`updateMany where { id, tokenHash, consumedAt: null,
   expiresAt: { gte: now } }` → set `consumedAt`; `count === 0` ⇒ treat as invalid —
   including an expired token — no state change).
2. `bcrypt.hash(newPassword, 10)` → update `User.passwordHash`.
3. If `verifiedAt` is null → set `verifiedAt = now` (FR-013; no-op when already set).
4. Revoke **all** `UserSession` rows for the user (`updateMany where { userId,
   revokedAt: null }` → set `revokedAt`) (FR-012).
5. `createSession(userId)` (inserts a new, *unrevoked* row — order matters: revoke
   first, then create, so the fresh session survives) and issue the access JWT.

6. **Sibling invalidation (B+)**: mark every *other* `PasswordResetToken` row for
   the user with `consumedAt = now` (`where { userId, id: { not: claimedId },
   consumedAt: null }`) — so a link the user never acted on cannot be used to
   change the password *after* a completed reset (closes the old-link takeover;
   FR-012). Same trust principle as step 4, applied to pending reset state.

After commit: `setSessionCookies` (FR-014) + audit events.

**Rationale**: A partial success (password changed but sessions not revoked, or token
consumed but password unchanged) is a security defect; the transaction makes the
quintuple all-or-nothing. The claim-first-then-revoke order guarantees the new session
is the only live one.

**Alternatives considered**: Separate statements with compensating logic (race window —
rejected); revoking in a post-commit hook (non-atomic — rejected).

## D8 — Audit events

**Decision**: New `action` strings on the existing `AuditEvent` table (fire-and-forget
`recordAuditEvent`, sensitive fields scrubbed per FR-006):

| Event | When | Outcome |
|---|---|---|
| `password_reset_requested` | reset-request accepted (registered or not — same event shape, no `userId` when unknown) | `success` |
| `password_reset_rate_limited` | throttle fired | `failure` |
| `password_reset_success` | consume + change + revoke + confirm | `success` (detail: `revokedSessionCount`, `confirmedEmail: bool`) |
| `password_reset_failed` | invalid/expired/consumed token presented | `failure` (no token material) |

**Rationale**: FR-009 names exactly these four events; the audit module already
implements insert-only rows with `scrub()`.

## D9 — Frontend

**Decision**:
- `AuthPage`: add a "Forgot password?" link → `/forgot-password` (a small form that
  POSTs `requestPasswordReset(email)` and shows the uniform "check your inbox" copy —
  the endpoint never distinguishes, so the UI can't either).
- `ResetPage` (new, at public route `/reset/:token`): new-password + confirm fields,
  client-side mirror of the policy message, calls `resetPassword(token, …)`; on
  success (signed in) navigate to the app home page; on 400 show the
  "link invalid or expired" copy with a "request a new link" affordance.
- `services/api.ts`: two new plain JSON helpers (cookie jar already handles the
  Set-Cookie pair; no `Authorization` header anywhere — 003 US4 invariant).
- `App.tsx`: `/reset/:token` and `/forgot-password` are **public routes** (no
  `ProtectedRoute`), same treatment as `ConfirmPage`.

**Rationale**: Mirrors the `ConfirmPage` precedent exactly (public route + token from
URL + uniform outcome copy). No new UI dependencies.

## D10 — Testing strategy

**Decision**:
- **Backend (Vitest, `gifty_test` DB)**:
  - `password-reset-request.test.ts` — uniform 200 for known/unknown/malformed email;
    rate-limit 429 (same body) after budget exhaustion; disabled mode: uniform 200 and
    **no** outbox row; capture mode: outbox row present with the link; no raw token in
    any response/audit `detail`.
  - `password-reset.test.ts` — full happy path (password swap SC-004, signed in via
    cookies); replay (second consume rejected, SC-003); expired (TTL boundary);
    wrong/new-password policy rejection; **other sessions revoked** (US2 scenario 5)
    while the resetting device's fresh session is live; **unconfirmed account gets
    `verifiedAt` set** (US1 scenario 4); no list/claim/purchase visibility change
    (FR-010 smoke).
- **Frontend (Vitest)**: `ResetPage` renders, validates confirm-match, surfaces the
  invalid-link copy; `AuthPage` link present.
- **e2e (Playwright, capture mode, `BASE_URL`)**: request → read captured email →
  follow link → set password → signed in; old password rejected on re-login; replay
  shows invalid copy.

**Rationale**: Constitution III mandates automated coverage of access control, state
transitions, and consent boundaries; the 003/004 suites demonstrate the exact harness
(test DB provisioning, capture mailer, cookie-based auth in tests).

## D11 — Migration

**Decision**: One new Prisma migration:
- create `PasswordResetToken` (`tokenHash` unique, `userId` indexed, `consumedAt`
  indexed);
- `ALTER TYPE "OutboxKind" ADD VALUE 'reset'` (Postgres enum extension — additive,
  no data migration).

**Rationale**: Additive-only schema change; no existing column semantics touched, so
no backfill and no downtime concern in the single-container deploy.

## Open items

None. All `NEEDS CLARIFICATION` markers resolved; the two clarify-phase questions
(scope, unconfirmed email, post-success sign-in) are already integrated in the spec.

# Phase 0 Research: Email Integration

**Feature**: [spec.md](spec.md) | **Branch**: `004-email-integration` | **Date**: 2026-10-03

**Purpose**: Resolve the design choices required to implement the email-integration spec
against the existing codebase. No `NEEDS CLARIFICATION` markers remain in the spec (all
resolved during `/speckit-clarify`, Session 2026-10-03). Several decisions are **user
directives** and are recorded here as constraints, not open questions: the `Mailer` port
abstraction, Resend as the production provider, a local capture stub for dev/test, the
transactional outbox, and the extension of `validateConfig()`. The decisions below
resolve the mechanics those directives leave open (drain loop, retry budget, token
format, dedup storage, the confirmation gate, and the three-mode model). Each decision
records what was chosen, why, and the alternatives evaluated.

**Grounding facts (verified in-repo)**:
- Stack: Express 4 + Prisma 6 + PostgreSQL 16 backend; React 18 + Vite 6 frontend; single-container Docker deployment (feature 002). The app boots via `server.ts` → `validateConfig()` → `createApp()` → `app.listen`; there is no worker process and no scheduler today.
- There is **no email-sending code anywhere** — no `nodemailer`, no `Resend`, no SMTP, no outbox table. The only email-adjacent state is the `PendingInvitation` model (feature 003) and the registration matching in `auth/router.ts`.
- `backend/src/config/index.ts::validateConfig()` is the existing boot gate: it already fails fast on missing/weak `JWT_SECRET`, a default `POSTGRES_PASSWORD`, and an inconsistent rate-limit budget. This is the natural home for the email-sending gate (FR-009).
- `backend/src/audit/events.ts::recordAuditEvent` is the fire-and-forget, `scrub()`-protected, append-only audit practice (FR-011 must extend the `AUDIT_ACTIONS` list).
- `backend/src/auth/rate-limit.ts` is an in-process, fixed-window, per-key counter with a `clearCounters()` test hook — the pattern the confirmation-resend throttle (FR-014) reuses.
- `backend/src/app.ts::createApp` wires routers and is the natural place to attach the outbox drainer lifecycle; `server.ts` is where a long-running interval would start and (on SIGTERM) stop.
- `frontend/src/App.tsx` routes `/`, `/me`, `/list/:listId` behind `ProtectedRoute` and `/auth` behind `PublicRoute`; the session is bootstrapped from `GET /account` (cookie-backed, `AuthContext.tsx`). The confirmation gate (FR-012) plugs into this bootstrap path.
- The share endpoint (`gift-lists/router.ts`) already produces a **uniform** registered/unregistered response (FR-010/FR-020 from feature 003) and upserts a `PendingInvitation` for unregistered emails — the invite-email dedup (FR-005) hooks in exactly here.

---

## D1 — `Mailer` port: the provider seam (Assumption, FR-006, FR-008)

**Decision**: Define a minimal interface `Mailer` with a single method
`send(message: OutboundEmail): Promise<void>` (or a small `sendMany`), where
`OutboundEmail` is a provider-agnostic DTO: `{ to, subject, text, html? }`. Two
implementations are shipped:
- **`ResendMailer`** — wraps the Resend HTTP API (`POST https://api.resend.com/emails`)
  using the runtime `fetch` (Node 22 global; no new dependency). Reads
  `RESEND_API_KEY`, `RESEND_FROM` (sender address), and the app public origin for
  link construction. Throws on non-2xx so the outbox treats it as a delivery failure.
- **`CaptureMailer`** (dev/test) — performs **no network I/O**. It records the
  message in an in-memory ring buffer **and** logs it to the process output in a
  stable, greppable shape (`[mail:invite] to=… subject=… link=…`). Exposes a test hook
  (`capturedEmails()`, `resetCapturedEmails()`) so automated tests can assert on exactly
  what would have been sent (US5, SC-003).

The rest of the system depends **only** on the `Mailer` port. The concrete implementation
is chosen by the **sending mode** (D8) at boot and injected into the outbox drainer. No
flow (registration, share) ever imports `ResendMailer` directly.

**Rationale**: This is the user's explicit directive ("decouple the sender… a `Mailer`
port"). The port is the seam that lets the same code paths run in all three modes and lets
the provider be swapped (or faked in CI) without touching the email flows. Using the
runtime `fetch` avoids a new `resend` SDK dependency — the API is a single JSON `POST`, so
a ~30-line client is clearer and lighter than pulling a maintained SDK into a
single-replica app. The capture stub is what makes US5/SC-003 possible: 0% live delivery
in dev/test, 100% locally assertable.

**Alternatives considered**:
- *The official `resend` npm SDK* — ergonomic but a new runtime dependency for a one-call
  API; the raw `fetch` client is equally clear and keeps the dependency surface at zero
  (feature 003 already ran `npm audit` gates; minimizing deps keeps that clean). Rejected
  now; trivial to adopt later if Resend adds features we need.
- *`nodemailer` + an SMTP relay* — the classic choice, but the spec/Assumptions fix the
  provider to Resend (HTTP API key auth) and there is no SMTP server in the deployment.
  `nodemailer` is the right tool for SMTP, not for a REST email API. Rejected.
- *A richer port (templates, attachments, queues)* — over-scope. The two message types are
  fixed and small; the outbox (D2) is the queuing layer. Keeping the port minimal keeps
  the seam honest.

**Test hooks**: `CaptureMailer.capturedEmails()` is the assertion surface for US5 and for
the P1 flows (invite + confirmation content, recipients, and links). The `Mailer` port is
injected, so the outbox drainer can be unit-tested against a fake `Mailer` that records
calls and can be flipped to a failing implementation to drive the retry tests (US4).

---

## D2 — Transactional outbox: durable enqueue + separate drain (FR-006, FR-007, US4)

**Decision**: Add a durable `OutboxMessage` table (see [data-model.md](data-model.md))
and a **drain loop**:
- **Enqueue is transactional with the business write.** When the app creates a
  `SharePermission`/`PendingInvitation` (invite) or confirms a new account
  (confirmation), it inserts an `OutboxMessage` row in the **same** Prisma transaction
  as that write. So "the user action" and "the email is queued" commit atomically —
  you can never have a share that should have an email but none queued (FR-006, SC-007).
  The request **returns as soon as the row is committed**; it never waits on delivery.
- **Drain is a separate step.** A single in-process loop (started in `server.ts`,
  stopped on SIGTERM) periodically selects pending messages whose `nextAttemptAt` has
  elapsed and `attempts < maxAttempts`, **claiming** them under a row lock / status
  transition (`queued` → `sending`) so a single worker and (in the unlikely multi-process
  case) other processes never double-send. For each claimed message it builds the
  `OutboundEmail`, calls `mailer.send(...)`, and marks it `sent` (terminal success) or
  schedules a retry.
- **Bounded retries with backoff.** On a `send()` rejection, `attempts += 1`,
  `lastError` is set (scrubbed of the provider key), and `nextAttemptAt = now +
  backoff(attempts)` (exponential, e.g. 1 min → 5 min → 30 min, capped). When
  `attempts` reaches `maxAttempts` (default **5**, operator-tunable), the message is
  marked `failed` (terminal) — this is the operator-observable, non-infinite failure
  (FR-007, US4 scenario 3, SC-004). `failed` rows are never retried automatically; an
  operator can inspect them (and, if desired, re-queue) but the app does not loop.

The drain loop runs at a modest interval (default **5 s**, tunable) and processes a
bounded batch per tick (default **50**). It is resilient to a long provider outage:
messages simply accumulate as `queued` with advancing `nextAttemptAt`, and are retried as
they become due (US4 scenario 2).

**Rationale**: This is the user's explicit directive ("use the transactional outbox").
Writing the outbox row in the same transaction as the business write is the core of the
pattern: it guarantees at-least-once *enqueue* without a distributed queue, and it means
the originating request is never blocked or failed by email (FR-006, SC-007) — the request
only pays for one extra `INSERT` in a transaction it was already committing. The separate
drain loop is what decouples delivery from the request and is what makes the
"sender temporarily unavailable" case (US4) a retryable, observable state instead of a
lost side effect. In-process draining is sufficient for the single-replica deployment
(feature 002); the `queued` → `sending` claim transition is what keeps it correct if the
process is ever duplicated.

**Alternatives considered**:
- *Send inline in the request handler (fire-and-forget `mailer.send()`)* — the simplest
  option, but it violates FR-006 (the request's success becomes coupled to the send),
  loses the message on a transient provider outage (no retry), and blocks the response on
  network I/O. The spec's US4 exists precisely to rule this out. Rejected.
- *A managed queue (SQS/SNS/Redis Streams) + a consumer* — the standard HA answer, but it
  introduces a new service into the single-container deployment for a feature the spec
  scopes to two low-volume message types. Rejected now; the `OutboxMessage` table is the
  documented promotion path (point the drainer at a queue) if HA is ever in scope.
- *Cron / external worker process* — the drain logic is identical; running it in-process
  avoids a second container and a second lifecycle to manage. The claim transition makes
  it safe under the single-replica assumption. Rejected as separate-process; adopted as
  in-process loop.

**Test hooks**: the drainer is a pure-ish function of `(prisma, mailer, now, config)`, so
unit tests can drive it with a fake `mailer` (succeed / fail N times then succeed / always
fail) and an injected clock to assert: retry scheduling, backoff growth, terminal `failed`
after `maxAttempts`, and that a success marks `sent` exactly once (US4, SC-004). Integration
tests enqueue a row and assert the originating request returned 2xx *before* any delivery
(SC-007).

---

## D3 — Invite dedup: one email per (recipient, list), spanning the register transition (FR-005, US3, SC-001)

**Decision**: Deduplication is enforced **at enqueue time** by a **unique index on
`OutboxMessage` of `(listId, recipientEmail)` for the `invite` kind**, combined with the
existing invariants that already give "at most one share record per (list, recipient)":
- The **registered** path already upserts on `SharePermission(giftListId,
  recipientUserId)` (unique) — a repeat share reuses the same permission row.
- The **unregistered** path already upserts on `PendingInvitation(giftListId,
  inviteeEmail)` (unique).
- The email is produced only when a **new** share record is created **or** when a
  previously revoked share is re-created — and the spec's US3 scenario 1 fixes the
  re-share path as **revocation-first**, which produces a fresh permission row. So the
  dedup rule is: *enqueue an invite email for (list, recipientEmail) if and only if no
  `invite`-kind `OutboxMessage` already exists for that pair.* The unique index makes the
  "no second email" guarantee **enforced by the database**, not by a read-then-write race
  (SC-001's "0% of repeat shares produce an additional email").
- The **registered → unregistered transition** (US3 scenario 2) is covered because the
  dedup key is the **email**, which is stable across the transition: the same
  (list, email) pair can only ever carry one invite email, whether it was created against
  a `SharePermission` or a `PendingInvitation`.
- A **different list** for the same recipient is a different key → its own single email
  (US3 scenario 3).

Implementation note: the enqueue helper computes the key, attempts the `INSERT`, and on a
`P2002` unique violation treats it as "already invited" (no error, no second email) — the
same `isUniqueViolation` pattern already used for the concurrent-registration race in
`auth/router.ts`.

**Rationale**: The spec's dedup is per (recipient, list) and must hold across the
register transition (Assumptions). The database unique index is the only mechanism that
guarantees the guarantee under concurrency (two rapid "share" taps), which a
"check-then-insert" would not. It also reuses the *existing* per-(list, recipient)
invariants, so the feature does not invent a new identity model — it keys off the email
that feature 003 already normalizes and stores. The "revocation-first re-share" path
(US3 scenario 1) is a product decision already fixed in the spec; the dedup rule simply
does not special-case it.

**Alternatives considered**:
- *A dedicated `ListInvitationEmail` ledger table* — a second source of truth for the same
  fact the outbox already holds. Duplicated state that can drift. Rejected.
- *Keying dedup on the recipient **user id*** — breaks the unregistered case entirely
  (no user id yet) and would not span the transition. Rejected; the email is the stable
  key.
- *Re-sending is idempotent so just allow it and rely on the provider to dedupe* — the
  spec forbids a second email (SC-001); provider-side dedup is not a contract we can rely
  on, and it would still burn sends. Rejected.

**Test hooks**: integration tests fire two shares of the same list to the same email and
assert exactly one `invite` outbox row (SC-001); a third share to a different list asserts
a second row (US3 scenario 3); the register-transition test (US3 scenario 2) asserts one
row before and after registration. A concurrency test fires N parallel shares and asserts
one row (unique-index guarantee).

---

## D4 — Confirmation verification link: opaque, scoped, single-use, bounded (FR-004, FR-010, US2)

**Decision**: A confirmation link is a **single-use, scoped, time-bounded token** stored
per account, not a reusable link:
- On registration (email enabled), the app creates a verification record: an **opaque
  256-bit random token** (`crypto.randomBytes(32)`), stored **only as a SHA-256 hash**
  on the account (`User.verificationTokenHash`), with `verifiedAt = null` and a
  `verificationExpiresAt` (default **24 h**, tunable). The **raw token** appears in the
  link (e.g. `{PUBLIC_ORIGIN}/confirm?token=<raw>`) and is **never persisted**.
- `GET /confirm?token=` (see [contracts/api.md](contracts/api.md)) looks the account up
  by the **hash** of the presented token. If found and unexpired and the account is still
  unconfirmed, it sets `verifiedAt = now` **and invalidates the token** (single-use) —
  idempotently: a second presentation of the same token, or any token after confirmation,
  returns the same **defined, non-destructive** outcome (no error, no state loss), and
  the response never distinguishes "token for an unknown account" from "already used"
  (FR-010, no account-existence leak).
- Because the token is a **hash lookup**, a crafted/tampered token simply matches nothing
  (same outcome as an unknown account) — there is nothing to replay meaningfully, and the
  single-use invalidation closes the replay window (edge case "confirmation link
  crafted/tampered/replayed").

The verification state is modeled as columns on `User` (`verifiedAt`,
`verificationTokenHash`, `verificationExpiresAt`) rather than a separate table, because
there is at most **one live verification per account** at a time (a resend issues a new
token that supersedes the old one — see D5).

**Rationale**: Mirrors the existing security posture: feature 003 stores refresh tokens
**only as hashes** (D3 there) and the constitution's "Security by Default." Storing only
the hash means a DB leak does not yield usable confirmation links. Single-use + bounded
expiry is the minimum that satisfies FR-010 and the replay edge case. Using an account
column (not a token table) keeps "at most one live verification" structurally true and
avoids an orphaned-token cleanup problem; a resend just overwrites the hash. The link
lands on a **static entry-point URL** (FR-013) — the token is the only secret; the path
is public and carries no per-account state.

**Alternatives considered**:
- *A signed JWT as the confirmation token* — stateless and convenient, but it is
  **reusable until it expires** (hard to make single-use without server state anyway) and
  embeds the account id in a decodable payload (an account-existence hint if leaked).
  The hash+single-use model is strictly stronger for FR-010. Rejected.
- *A separate `VerificationToken` table (many per account)* — correct but over-engineered
  for "one live verification at a time"; adds orphan cleanup and a join. The account
  column achieves the same guarantee with less state. Rejected now; the table is the
  promotion path if we ever need concurrent verifications.
- *No expiry / no single-use* — fails FR-010 and the replay edge case directly. Rejected.

**Test hooks**: unit tests drive the token lifecycle (create → present → confirmed;
re-present → non-destructive; tampered/unknown → same non-destructive outcome; expired →
same). Integration tests exercise `GET /confirm` end-to-end and assert no
account-existence difference between an unknown and a used token (FR-010).

---

## D5 — Confirmation resend: allowed, rate-limited, supersedes (FR-014, SC-009)

**Decision**: A user held at the confirmation step (email enabled, unconfirmed) may
re-request a confirmation email via `POST /auth/resend-confirmation`:
- The endpoint **requires a live session** for the unconfirmed account (the user is
  signed in — see D6) so it is keyed to a real account, not an arbitrary email.
- It **issues a new verification token** (new random token, new 24 h window), **replacing**
  the prior one (the old hash is superseded), and **enqueues a fresh confirmation
  outbox message**. It is **not** subject to the invite dedup rule (FR-014) — a
  confirmation is re-sendable, unlike an invite.
- It is **rate-limited per account and per time window** using the existing
  `rate-limit.ts` in-process counter (a new budget kind `confirmation-resend`, keyed on
  the account id, e.g. **3 / 15 min**), returning the same stable body on throttling to
  avoid a probe signal (FR-014, US2, SC-009).

**Rationale**: FR-014 exists so a lost/undelivered/expired confirmation cannot permanently
lock an account out (SC-009). Requiring a live session means the resend is provably by the
account holder (defeating "resend to any email" abuse) and the per-account window bounds
provider/inbox spam. Reusing `rate-limit.ts` keeps one throttle implementation and one
`Retry-After`/audit convention. Superseding the token (rather than stacking) keeps
"one live verification" true (D4).

**Alternatives considered**:
- *Resend without auth (email in the body)* — an open spam vector and an enumeration
  oracle (200 vs 404 per email). The spec's security posture (feature 003) rejects this.
  Rejected.
- *A global cooldown keyed on IP* — does not stop a single account hammering its own
  resend; per-account is the correct dimension. Rejected.

**Test hooks**: unit tests on the new budget kind (N allowed, N+1 → 429 within a window,
fresh window resets). Integration tests: resend while unconfirmed issues a new token and
one more outbox row; resend is **not** blocked by the invite dedup; resend respects the
per-account window (SC-009).

---

## D6 — The blocking confirmation gate + the unconfirmed state (FR-012, SC-008)

**Decision**: "Unconfirmed" is a real state only when **email sending is enabled**. The
gate is enforced **server-side**, not just in the UI:
- **Server-side**: `requireAuth` (or a thin `requireConfirmed` middleware layered on it)
  resolves the account and, when `config.email.enabled === true` and
  `user.verifiedAt === null`, the account is **unconfirmed**. Authenticated-but-unconfirmed
  accounts are allowed to reach a small allow-list of endpoints only: the account
  bootstrap (`GET /account`, so the client can render the confirmation page), the
  confirmation endpoints (`GET /confirm`, `POST /auth/resend-confirmation`), and sign-out.
  Every **other** authenticated route (lists, items, sharing, claim/purchase, consent,
  account removal) returns a **stable, non-leaking 403** (e.g. `403 { message: "Please
  confirm your email to continue." }`) — the same body for any unconfirmed account, with
  no hint about which features are gated (SC-008). This is the real enforcement: the
  client cannot bypass it.
- **Client-side**: `AuthContext`/`App.tsx` learns the unconfirmed state from
  `GET /account` (which gains a `verified: boolean` field) and routes unconfirmed users to
  a **confirmation page** (with a "resend" affordance) instead of the dashboard, and the
  `ProtectedRoute` guard redirects unconfirmed users to that page. This is the UX half;
  the server-side gate is the security half (defense in depth, Constitution §IV).
- **Grandfathering** (Assumptions): accounts that exist before the feature is introduced
  are treated as confirmed. Mechanism: the migration sets `verifiedAt` to `now()` (or a
  fixed backfill timestamp) for **all existing** `User` rows; only rows created *after* the
  feature ship (with email enabled) are born `verifiedAt = null`. This is a one-time
  data backfill in the migration, not a runtime branch.

**Rationale**: The clarification fixed the gate as **fully blocking** and FR-012/SC-008
require 0% of unconfirmed accounts able to use lists/items/sharing/claim. A UI-only gate
is trivially bypassed by hitting the API directly; the constitution's "Security by
Default" demands the server enforce it. A dedicated `requireConfirmed` layer (rather than
mutating `requireAuth`) keeps the auth primitive clean and lets the small allow-list of
"pre-confirmation" endpoints stay simple. Grandfathering via migration backfill is the
standard, one-time, auditable way to flip existing users to confirmed without a code
branch that could drift.

**Alternatives considered**:
- *UI-only gate* — bypassable; fails SC-008. Rejected.
- *Deny unconfirmed users even `GET /account`* — then the client cannot render the
  confirmation page or offer resend; the account is wedged. The allow-list keeps the
  confirmation UX reachable while blocking everything the spec names. Rejected.
- *A `confirmedAt`/`unconfirmed` flag separate from `verifiedAt`* — redundant state;
  `verifiedAt === null` **is** the unconfirmed state. One field, one meaning. Rejected.

**Test hooks**: integration tests — unconfirmed account → `GET /` (dashboard data) is
403, `GET /account` is 200 (with `verified: false`), `POST /auth/resend-confirmation` is
allowed, `GET /list/:id` is 403 (SC-008). Confirmed account → all routes 2xx.
Grandfathering test: pre-existing rows carry `verifiedAt` after the migration.

---

## D7 — Audit: production + terminal delivery outcome (FR-011)

**Decision**: Extend the existing `AUDIT_ACTIONS` list in `audit/events.ts` with the email
lifecycle events and record them with the same fire-and-forget, `scrub()`-protected
mechanism:
- **Production** (enqueue) events: `email_invite_queued` and
  `email_confirmation_queued` — recorded at the moment the outbox row is committed
  (inside the enqueue path, fire-and-forget, never blocking the request). `detail`
  carries the non-sensitive identity (normalized recipient email for invites, the account
  id for confirmations), **never** the raw token and **never** provider keys.
- **Terminal delivery outcome** events: `email_delivered` and `email_failed` — recorded by
  the drainer when a message reaches `sent` or `failed`. `email_failed` carries a
  scrubbed error class (e.g. `provider_http_5xx`), the attempt count, and the message id
  — this is the **operator-observable** failure (FR-007, US4 scenario 3) and the thing
  SC-004 asserts on. The `OutboxMessage` row itself (status, attempts, `lastError`) is
  the durable, queryable record; the audit row is the append-only trail.

**Rationale**: FR-011 names "production and the terminal delivery outcome of every email"
and points at "the existing audit practice" — so the extension is additive to
`AUDIT_ACTIONS` and reuses `recordAuditEvent`. Recording production **and** terminal
outcome (not every intermediate retry) keeps the trail meaningful without noise; the
`OutboxMessage` table holds the per-attempt detail, the audit holds the security/ops
story. `scrub()` already strips credential-like keys, so the `RESEND_API_KEY` can never
leak into `detail`.

**Alternatives considered**:
- *Audit every retry attempt* — noisy and redundant with `OutboxMessage.attempts`; the
  spec asks for the **terminal** outcome. Rejected.
- *A separate `EmailLog` table in place of audit + outbox* — the outbox already is the
  delivery record; a third table duplicates it. Rejected.

**Test hooks**: integration tests assert one `email_*_queued` row on enqueue and one
`email_delivered`/`email_failed` on terminal outcome, and that no audited `detail` contains
the raw token or the API key (FR-011, FR-010).

---

## D8 — The three sending modes + the boot gate (FR-009, FR-015, US5, US6, SC-006, SC-010)

**Decision**: Email behavior is driven by a small, explicit **mode** derived from config,
so the three modes in the spec's Assumptions can never be conflated:
- **Config surface** (extends `loadConfig()` / `validateConfig()` in `config/index.ts`):
  - `EMAIL_ENABLED` (`true`/`false`, default **true** in dev/test, and **true** in
    production unless the operator explicitly disables it) — the master switch.
  - `RESEND_API_KEY` — required when sending to the live provider.
  - `RESEND_FROM` — sender address (required when live; may be a placeholder for capture).
  - `GIFTY_PUBLIC_ORIGIN` — the public base URL used to build the confirmation link and
    the home-page link (defaults to the request origin / `http://localhost:8080`).
  - `EMAIL_MAX_ATTEMPTS` (default 5), `EMAIL_RETRY_BASE_MS`, `EMAIL_DRAIN_INTERVAL_MS`
    (default 5000), `EMAIL_DRAIN_BATCH` (default 50) — the drainer knobs (D2).
- **Mode resolution** (pure function of config):
  - **(a) enabled + live sender configured** → `ResendMailer`, the blocking gate is
    **active** (D6), real emails are delivered by the drainer.
  - **(b) enabled + capture sender** (no live key, or `EMAIL_TRANSPORT=capture`) →
    `CaptureMailer`, the blocking gate is **active** and exercised for real via the
    captured link (US5/Assumptions). This is the dev/test mode.
  - **(c) disabled** (`EMAIL_ENABLED=false`) → **no confirmation email is produced**, new
    accounts are **auto-confirmed at registration** (D6 off), a **startup warning** is
    emitted (`[config] email disabled — new accounts are auto-confirmed; live delivery is
    off`), and invite emails are **not** sent (shares still work; the recipient just has
    no email nudge). This is the explicit, non-hidden state (FR-015, US6, SC-010).
- **Boot gate** (extends `validateConfig()`): in **production**, if `EMAIL_ENABLED` is
  `true` **and** `RESEND_API_KEY` is missing/weak (or a known default), the app **refuses
  to start** with a message that names the offending variable and the fix (FR-009, US6
  scenario 1, SC-006) — exactly the discipline `JWT_SECRET` already gets. In
  **non-production**, an unconfigured live sender is fine (it resolves to mode (b)
  capture) and must NOT block boot (US6 scenario 3). Disabling email in production is
  allowed and starts normally (US6 scenario 2) — but emits the mode-(c) warning.

**Rationale**: The spec is explicit that the three modes are categorically different
(Assumptions) and that mode (c) "disabled" is **not** mode (b) "enabled + capture."
Deriving a single explicit mode from config, and gating production on it, is the only way
to honor all of FR-008, FR-009, FR-012, and FR-015 without a tangle of `if`s. Auto-confirm
in mode (c) is the user-directed fix for the "email disabled + blocking gate = permanent
lockout" dead-end (FR-015, SC-010). The startup warning makes the explicit state visible
(US6 scenario 5) instead of silent. Reusing `validateConfig()` keeps one boot-gate
implementation and the same operator-facing message style as the existing gates.

**Alternatives considered**:
- *Default email OFF in production* — the spec's US6 scenario 1 treats "enabled but
  unconfigured" as the failure case, implying email is **on** by default in production;
  defaulting off would hide a misconfiguration. Default-on with a hard gate is the safer
  fail-loud posture. (Documented; operator can set `EMAIL_ENABLED=false` deliberately.)
- *A separate process/service for sending* — unnecessary for single-replica; the in-process
  drainer (D2) is sufficient and keeps the deployment single-container (feature 002).
  Rejected now.
- *Conflating capture with disabled* — directly violates the Assumptions and SC-010.
  Rejected.

**Test hooks**: unit tests on mode resolution (each of the three config shapes → the
expected mode + mailer). Boot-gate tests: production + enabled + no key → throws naming
`RESEND_API_KEY`; production + enabled + strong key → passes; non-prod + no key → passes
(mode b); production + disabled → passes (mode c). US5 tests: in capture mode, invite +
confirmation produce **captured** messages and **zero** live-provider calls (SC-003).

---

## D9 — Where links point + the app public origin (FR-013, SC-005)

**Decision**: Both message types build their link from `GIFTY_PUBLIC_ORIGIN`:
- **Confirmation** → `{origin}/confirm?token=<raw>` — a real, token-bearing URL that
  confirms the account (D4). The landing destination is the app entry point; the token is
  the mechanism.
- **Invite** → `{origin}/` (the **home page**, no token, no per-list state) — the
  recipient signs in / signs up from the entry point and reaches the shared list there
  (FR-013, FR-001, US1). There is **no deep link** and **no token** in an invite (FR-010,
  Assumptions): the link has nothing to replay.

`GIFTY_PUBLIC_ORIGIN` is operator-configurable and validated (must be an absolute
`http(s)://` URL) when it is set; it defaults to a sensible local origin in dev/test so
captured links are usable without configuration (US5). The link builder is a pure
function `(kind, origin, token?) → string`, trivially unit-tested for both kinds (SC-005:
100% of links resolve to a valid, intended destination).

**Rationale**: FR-013 and the clarifications fix links to the **generic entry point**
(no deep-linking). The invite is a pure entry-point URL by design (nothing to leak or
replay); the confirmation is the only token-bearing URL (D4). Centralizing the origin in
one config value keeps the two link builders consistent and makes the production URL
explicit rather than guessed from the request (the request origin is the *API* origin,
which behind TLS termination may differ from the public origin).

**Alternatives considered**:
- *Derive the origin from the request on each send* — fragile behind proxies/TLS and
  inconsistent between the API origin and the public app origin. An explicit config value
  is unambiguous. Rejected.
- *Deep-link invites to `/list/:id`* — explicitly against the clarifications and FR-013;
  and it would leak the list id to an unauthenticated recipient. Rejected.

**Test hooks**: unit tests assert the confirmation link contains the token and the origin,
and the invite link is exactly `{origin}/` with no token (SC-005, FR-013).

---

## Summary of resolved decisions

| ID | Decision (one line) |
|----|---------------------|
| D1 | `Mailer` port (`ResendMailer` via `fetch`, `CaptureMailer` for dev/test); flows depend only on the port. |
| D2 | Transactional outbox (`OutboxMessage`) committed with the business write + a separate in-process drain loop with bounded exponential backoff and a terminal `failed` state. |
| D3 | Invite dedup enforced by a **unique index on (listId, recipientEmail)** for `invite` messages — one email per (recipient, list), spanning the register transition. |
| D4 | Confirmation link = opaque 256-bit token, stored **only as a hash**, single-use, 24 h window; used/unknown/expired all return the same non-destructive, non-leaking outcome. |
| D5 | Resend confirmation: session-required, issues a new token (supersedes), enqueues a fresh message, rate-limited per account/window; not subject to invite dedup. |
| D6 | Blocking gate enforced **server-side** (`requireConfirmed`) with a small pre-confirmation allow-list; `GET /account` gains `verified`; existing accounts grandfathered via migration backfill. |
| D7 | Audit extended with `email_*_queued` / `email_delivered` / `email_failed`; production + terminal outcome; `scrub()`-protected. |
| D8 | Three explicit modes (live / capture / disabled) derived from config; production boot gate on `RESEND_API_KEY` when enabled; auto-confirm + startup warning when disabled. |
| D9 | Links built from `GIFTY_PUBLIC_ORIGIN`; confirmation token-bearing to `/confirm`, invite a plain `{origin}/` home URL. |

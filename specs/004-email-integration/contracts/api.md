# API Contracts: Email Integration

**Feature**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md) | **Data model**: [../data-model.md](../data-model.md) | **Date**: 2026-10-03

This document defines the **contract changes** for the email-integration feature. It
supplements the baseline contract in `specs/001-gift-list-sharing/contracts/gift-list-api.md`
and the security contract in `specs/003-security-hardening/contracts/api.md`, and lists
only what is **added** or **changed**. Unchanged endpoints keep the 001/003 contracts.
All requests/responses are `application/json` unless noted.

The two **message types** in scope (Assumptions): **account confirmation** and **list
invite**. Delivery is always via the transactional outbox (research D2) — no endpoint
waits on a live send. The `Mailer` (Resend vs capture) and the three sending modes
(research D8) are invisible to the API: the same endpoints behave identically across
modes; only what actually reaches an inbox differs.

## Global Changes (apply to every endpoint)

### New `GET /account` field — `verified` (FR-012)

`GET /account` (the session-bootstrap endpoint, feature 003) gains one field in the
`user` object:

| Field | Type | Meaning |
|---|---|---|
| `user.verified` | `boolean` | `true` when the account is confirmed (or email is disabled → auto-confirmed), `false` when the account is unconfirmed (email enabled, `verifiedAt` null). The client uses this to route to the confirmation page (D6). |

- **200 OK** — `{ "user": { id, email, displayName, verified } }`
- This endpoint is in the **pre-confirmation allow-list** (reachable while unconfirmed,
  D6) so the client can render the confirmation page and offer resend.

### The blocking confirmation gate (FR-012, SC-008)

Enforced **server-side** (research D6), not just in the UI. When a signed-in account is
**unconfirmed** (email enabled, `verifiedAt` null):

- **Allowed** (the pre-confirmation allow-list): `GET /account`, `GET /confirm`,
  `POST /auth/resend-confirmation`, `POST /auth/logout`, `POST /auth/refresh` (the
  session must stay alive).
- **Denied** — every other authenticated route (lists, items, sharing, claim/purchase,
  consent, `DELETE /account`) returns a **stable, non-leaking** body:

  ```json
  { "message": "Please confirm your email to continue." }
  ```

  - Status `403`. **Identical body for every gated route** and for every unconfirmed
    account — no hint about which feature is gated or whether the account exists
    (SC-008, FR-010 hygiene).
- When email is **disabled** (mode c, D8), there is no unconfirmed state (accounts are
  auto-confirmed, FR-015), so the gate never fires — all routes behave as for a
  confirmed account.

### Rate limiting (FR-014)

- Applies to `POST /auth/resend-confirmation` (a **new** budget kind
  `confirmation-resend`, keyed on the **account id**, reusing `auth/rate-limit.ts`).
- Default budget: **3 resends / 15 min** per account. Tunable via `RESEND_MAX_PER_ACCOUNT` (default `3`); the window reuses the existing `RATE_LIMIT_WINDOW_MINUTES` (default `15`).
- On exhaustion: `429` with a **stable body** (see endpoint) — the throttle signal must
  not become a probe/abuse oracle (FR-014, SC-009).

### Security headers / error hygiene

- Unchanged from feature 003 (CSP, `X-Content-Type-Options`, `X-Frame-Options`,
  `Referrer-Policy`, HSTS in production, no `X-Powered-By`, closed-by-default CORS,
  5xx collapse). The new endpoints inherit all of it.

---

## New Endpoints

### `GET /confirm?token=<raw>`

Confirms an account's email by consuming its single-use verification token (FR-004,
FR-010, US2). **No session required** — the token is the credential.

**Contract — a single, uniform outcome.** This endpoint returns **`200 OK` with one
stable body in every case** — a fresh valid token, an already-used token, an expired
token, a token that matches no account, or a missing token:

```json
{ "status": "confirmed" }
```

- **Fresh, valid token** → sets `User.verifiedAt = now`, clears
  `verificationTokenHash`, and the account becomes usable (the gate is lifted). Returns
  the body (US2 scenario 2).
- **Already-used / already-confirmed** → changes no state and returns the **same** body
  — non-destructive, no duplicate confirmation (FR-004, US2 scenario 3: "no error, no
  duplicate confirmation, no loss of the confirmed state").
- **Expired / unknown / missing token** → changes no state and returns the **same** body
  (FR-010: "rejected without leaking whether the referenced account exists"; edge case
  "crafted/tampered/replayed").

> **Why a single `200` for all cases (and not a mix of 200/400/410).** FR-010 requires
> that *invalid*, *already-used*, and *expired* outcomes be **indistinguishable** (so the
> response is a closed account-existence oracle), and US2 scenario 3 requires the
> already-confirmed case to be **a non-error, non-destructive outcome**. Those two
> constraints together force the same non-error status for the whole class: if the
> "invalid" case returned a 4xx, the "already-used" case would have to return a 4xx too
> to stay indistinguishable — contradicting "no error." The only consistent resolution
> is **one uniform, non-error response**. "Rejected" (FR-010) is therefore read as
> "not honored as a fresh confirmation / a no-op," which a `200` + stable body satisfies.
> The real signal of success is the account's confirmed state, observable via
> `GET /account` (`user.verified`), not the HTTP status.
- **Server behavior**: hashes the presented token (SHA-256) and looks it up against
  `User.verificationTokenHash` (D4). A raw token is never echoed, logged, or placed in
  response or audit `detail` (FR-010/FR-011). The endpoint is safe to hit repeatedly
  (idempotent) and carries no per-account state in the URL (the token is the only secret).

### `POST /auth/resend-confirmation`

Re-issues a confirmation email for the **caller's own** unconfirmed account (FR-014,
SC-009). **Requires a live session** for the account (the user is signed in) so it is
keyed to a real account, not an arbitrary email (D5).

- **Request**: no body. Requires the `gifty_access` cookie (session must resolve to an
  **unconfirmed** account).
- **202 Accepted** — a new verification token was issued (superseding the prior one) and
  a fresh confirmation `OutboxMessage` was enqueued. Body:
  ```json
  { "message": "A new confirmation email is on its way." }
  ```
  - The response is **identical whether or not a prior email was in flight** (no
    "already sent" distinction to probe).
  - **Not** subject to the invite dedup rule (FR-014) — confirmations are re-sendable.
- **403 Forbidden** — the account is **already confirmed** (nothing to resend):
  ```json
  { "message": "Your email is already confirmed." }
  ```
- **429 Too Many Requests** — the per-account resend budget is exhausted (FR-014, D5):
  ```json
  { "message": "Too many confirmation requests. Please wait a moment and try again." }
  ```
  - A `Retry-After` header MAY be sent; its presence/magnitude must not leak account
    state (SC-009 hygiene).
- **401 Unauthorized** — no live session.

> In **mode (c) disabled** (D8), this endpoint is a no-op success (202) or `403`
> (already auto-confirmed) — there is no live email to send, and no unconfirmed state
> exists (FR-015). The client should not surface resend when email is disabled.

---

## Changed Behavior (existing endpoints)

### `POST /auth/register` (FR-003, FR-015)

- **Email enabled (mode a/b)**: on success, the account is created **unconfirmed**
  (`verifiedAt = null`, a verification token issued), and a **confirmation
  `OutboxMessage`** is enqueued in the **same transaction**. The `201` body is unchanged
  in shape but the user object gains the `verified` field:
  ```json
  { "user": { id, email, displayName, "verified": false } }
  ```
  - The response is issued **as soon as the account + outbox row commit** — it does not
    wait for delivery (FR-006, SC-007).
- **Email disabled (mode c)**: the account is created **auto-confirmed**
  (`verifiedAt = now`), **no** confirmation email is enqueued, and the user object
  reflects it:
  ```json
  { "user": { id, email, displayName, "verified": true } }
  ```
  (FR-015, SC-010; a startup warning was already emitted at boot.)
- Pending-invitation matching (feature 003) is **unchanged** and still runs in the same
  transaction.

### `POST /lists/:listId/share` (FR-001, FR-005, FR-006)

- **Behavior otherwise unchanged** (uniform registered/unregistered response — feature
  003 FR-010). The **only** addition: when a share **creates a new** share record
  (a `SharePermission` or `PendingInvitation`), an **invite `OutboxMessage`** is
  enqueued **in the same transaction**, keyed `(listId, recipientEmail)`.
  - **Dedup (FR-005, SC-001)**: the `@@unique([listId, recipientEmail])` on
    `OutboxMessage` means a **repeat share** of the same list to the same recipient
    (registered, unregistered, or across the register transition) does **not** enqueue a
    second invite email — the `INSERT` is a no-op (`P2002` → "already invited"). A
    **different list** to the same recipient enqueues its own single invite (US3
    scenario 3).
  - The **owner-facing response is unchanged** — enqueuing (or its dedup no-op) never
    changes status, body, or timing in a way that distinguishes recipients (FR-002,
    feature 003 FR-010).
  - In **mode (c) disabled**, no invite email is enqueued (shares still succeed; the
    recipient simply has no email nudge).
- **The share itself still never fails because of email** (FR-006, SC-007): the outbox
  `INSERT` is part of a transaction the share was already committing; there is no
  delivery I/O in the request path.

### Audit trail (FR-011)

- The existing `AuditEvent` shape is unchanged; the `action` vocabulary gains:
  `email_invite_queued`, `email_confirmation_queued`, `email_delivered`,
  `email_failed` (research D7). Recorded fire-and-forget via the existing
  `recordAuditEvent`; `detail` is `scrub()`-protected (never the raw token, never
  `RESEND_API_KEY`).
- No API endpoint exposes audit rows (consistent with feature 003 — the trail is
  operator-observed, e.g. `psql`/`scripts/audit-query.sql`).

---

## Operator / Configuration Surface (research D8)

Not an HTTP endpoint, but part of the contract for operators and tests:

| Env var | Default | Meaning |
|---|---|---|
| `EMAIL_ENABLED` | `true` | Master switch. `false` → mode (c): no emails, auto-confirm, startup warning. |
| `RESEND_API_KEY` | — | Live provider credential. **Required** when enabled in production (else boot fails). |
| `RESEND_FROM` | — | Sender address (required for live send). |
| `GIFTY_PUBLIC_ORIGIN` | request origin | Public base URL used to build the `/confirm?token=` and home-page links (D9). |
| `EMAIL_TRANSPORT` | derived | `resend` \| `capture`. `capture` forces the local capture stub (dev/test, mode b). |
| `EMAIL_MAX_ATTEMPTS` | `5` | Bounded-retry cap per message (FR-007). |
| `EMAIL_RETRY_BASE_MS` | `60000` | Base backoff between retries (D2). |
| `EMAIL_DRAIN_INTERVAL_MS` | `5000` | Drainer tick interval (D2). |
| `EMAIL_DRAIN_BATCH` | `50` | Max messages per tick (D2). |
| `EMAIL_TOKEN_TTL_HOURS` | `24` | Verification token validity window (D4). |
| `RESEND_MAX_PER_ACCOUNT` | `3` | Max confirmation resends per account within the rate-limit window (FR-014, D5); the window reuses the existing `RATE_LIMIT_WINDOW_MINUTES` (default 15). |

**Boot gate** (`validateConfig()`, extended):
- **Production + `EMAIL_ENABLED=true` + no valid `RESEND_API_KEY`** → **refuse to start**,
  message names `RESEND_API_KEY` and the fix (FR-009, US6 scenario 1, SC-006).
- **Production + `EMAIL_ENABLED=true` + valid key** → boots (mode a).
- **Production + `EMAIL_ENABLED=false`** → boots (mode c) + startup warning.
- **Non-production** (any) → boots; unconfigured live sender resolves to capture (mode b).

**Capture mode observability** (US5, SC-003): in capture mode, each email is logged to
the process output in a stable, greppable shape and held in an in-memory buffer exposed
by a test-only hook (`capturedEmails()` / `resetCapturedEmails()`). The test hook is
available only when `EMAIL_TRANSPORT=capture` (or in test), so it never exists in a
normal production app (mirrors the `GIFTY_ENABLE_TEST_PROBES` discipline, feature 003).

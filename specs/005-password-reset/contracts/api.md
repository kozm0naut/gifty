# API Contracts: Password Reset (005)

**Feature**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md) | **Data model**: [../data-model.md](../data-model.md) | **Date**: 2026-10-12

This document defines the **contract changes** for the password-reset feature. It
supplements the baseline (001), security (003), and email (004) contracts and lists
only what is **added**. Unchanged endpoints keep their existing contracts. All
requests/responses are `application/json`.

Both endpoints are **unauthenticated** (the requester is signed out by definition)
and inherit the global security headers, 5xx collapse, and closed-by-default CORS
from feature 003.

---

## New Endpoints

### `POST /auth/reset-request`

Requests a password-reset email (FR-001, FR-002, SC-002).

- **Request**: `{ "email": "user@example.com" }` — trimmed and case-folded before
  lookup (Assumptions).
- **Rate limited** (FR-007): per source (client IP) and per account (normalized
  email), budget default **5 per 15-min window** each
  (`RESET_MAX_PER_SOURCE` / `RESET_MAX_PER_ACCOUNT`; window reuses
  `RATE_LIMIT_WINDOW_MINUTES`). Throttle check happens **before** any account
  lookup.

**Uniform outcome (the contract's core):**

| Case | Status | Body |
|---|---|---|
| Email registered → token issued + reset email enqueued | `200` | `U` |
| Email **not** registered (dummy bcrypt run for timing) | `200` | `U` |
| Email missing/malformed | `200` | `U` |
| Rate limited | `429` + `Retry-After` | `U` |

where `U` is the single stable body (pinned):

```json
{ "message": "Please check your email for the password reset link" }
```

- The response is **indistinguishable** across the first three rows (FR-002, SC-002);
  the 429 reuses the same body so the throttle signal is not an enumeration oracle.
- **Rate-limit recovery (FR-007)**: a throttled request is recoverable without operator
  help — once the window elapses, requests succeed again. The 429 + `Retry-After`
  is allowed (and expected) to be distinct from the 200; signaling the wait to the
  user does not weaken FR-002 non-enumeration (throttle fires before account lookup).
- **Reset email content** (FR-002): the captured/live message MUST contain the reset
  link and a notice that the link expires; exact subject/body copy is an
  implementation detail (reviewer gate: presence, not wording).
- **Disabled mode** (`EMAIL_ENABLED=false`): the endpoint still returns `200 U` and
  performs no enqueue (no reset is possible by email in that mode; uniform response
  preserved — Assumptions).
- **Capture mode**: a `kind = reset` `OutboxMessage` row is created with the link;
  nothing hits the network.
- Audit: `password_reset_requested` (registered or unknown email — same event
  shape, no `userId` when unknown) / `password_reset_rate_limited` (throttle).
  `detail` never contains the raw token.

### `POST /auth/reset`

Consumes a reset link and sets the new password (FR-003–FR-008, FR-012–FR-014).
The token in the body is the credential — **no session required**.

- **Request**:
  ```json
  { "token": "<raw token from link>", "newPassword": "…", "confirmPassword": "…" }
  ```
- **Order of operations** (research D6/D7): body shape check →
  `newPassword === confirmPassword` → password policy (same rules as registration,
  003 FR-002; FR-003) → atomic token claim → transactional success writes. The policy check runs
  identically whether or not the token is valid (no token-validity oracle from
  status differences on policy failures).

| Case | Status | Body / effect |
|---|---|---|
| Valid, unexpired token + policy-passing password | `200` | `S` + **fresh session cookie pair** (`gifty_access`, `gifty_refresh`, same attributes as `/auth/login`) |
| Token unknown / expired / already consumed | `400` | `I` — no state change |
| Missing fields, mismatched confirmation, or policy failure | `400` | `P` (policy message mirrors the registration policy message) |

Bodies:

```json
// S — success (FR-014: the user is now signed in on this device)
{ "status": "reset", "user": { "id": "…", "email": "…", "displayName": "…", "verified": true } }

// I — invalid link (one body for the whole class: unknown/expired/consumed;
// indistinguishable across the classes — FR-004; pinned)
{ "message": "This reset link is invalid or has expired." }

// P — weak/mismatched password (003 FR-002 policy)
{ "message": "<stable policy message, same as registration (003 FR-002)>" }
```

**Success semantics (one transaction, all-or-nothing — research D7):**

1. Token row claimed (single use — FR-004);
2. `User.passwordHash` rewritten (old password immediately rejected — FR-008, SC-004);
3. `User.verifiedAt` set if null (FR-013 — confirmation gate lifted; `user.verified`
   is therefore always `true` in `S`);
4. All `UserSession` rows for the user revoked (FR-012 — other devices must sign in);
5. Every *other* pending `PasswordResetToken` row for the user consumed (sibling invalidation — a link the user never acted on cannot overwrite this completed reset; FR-012);
6. One fresh session created for the resetting device (survives step 4 by ordering).

- Audit: `password_reset_success` (detail: `revokedSessionCount`, `confirmedEmail`)
  or `password_reset_failed` (invalid-token class). Never the raw token or password
  (FR-006).
- **Idempotency**: not idempotent by design — a second presentation is the `I` case
  (FR-004). The endpoint is safe to *probe* (uniform `I`), never safe to *replay*.

### Frontend route contracts (UI surface)

| Route | Auth | Purpose |
|---|---|---|
| `/forgot-password` | public | Email form; on submit MUST show one uniform message regardless of outcome (FR-002; SHOULD reuse the pinned `U` string) and MUST NOT reveal whether the email is registered |
| `/reset/:token` | public | Set-new-password form; success → navigate to app home (already signed in); `I` copy → offer "request a new link" (→ `/forgot-password`) |

Both are public routes (no `ProtectedRoute`), same treatment as the 004
`/confirm` route. The SPA client remains cookie-only — no `Authorization` header, no
token in `localStorage` (003 US4 invariant preserved).

---

## Unchanged (explicit)

- `POST /auth/login`, `/auth/register`, `/auth/refresh`, `/auth/logout`,
  `GET /account`, `GET /confirm`, `POST /auth/resend-confirmation` — contracts from
  003/004 stand.
- All list/item/sharing/claim/purchase endpoints — FR-010: a reset changes none of
  their behavior or visibility.

## Rate-limit budget summary (new)

| Key | Dimension | Default | Env override |
|---|---|---|---|
| `reset-request` | per source (IP) | 5 / 15 min | `RESET_MAX_PER_SOURCE` |
| `reset-request` | per account (email) | 5 / 15 min | `RESET_MAX_PER_ACCOUNT` |

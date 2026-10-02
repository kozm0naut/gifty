# API Contracts: Security Hardening

**Feature**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md) | **Data model**: [data-model.md](../data-model.md) | **Date**: 2026-09-27

This document defines the **security-relevant contract changes** for feature
003. It supplements the baseline contract in
`specs/001-gift-list-sharing/contracts/gift-list-api.md` and lists only what
changes, is added, or is explicitly constrained. Unchanged endpoints keep the
001 contract. All requests are `application/json` unless noted.

## Global Changes (apply to every endpoint)

### Authentication transport — Bearer header → `HttpOnly` cookies

- The `Authorization: Bearer <token>` header is **retired**. The access
  credential is now the `gifty_access` cookie (research D4); the refresh
  credential is the `gifty_refresh` cookie, scoped to `Path=/auth/refresh`.
- `Set-Cookie` attributes (production):

| Cookie | Value | Attributes |
|---|---|---|
| `gifty_access` | signed JWT, `exp` ≤ 1 h (impl default 10 min), claim `sid` | `HttpOnly; Secure; SameSite=Lax; Path=/` |
| `gifty_refresh` | opaque 256-bit random string (never stored or logged in full) | `HttpOnly; Secure; SameSite=Lax; Path=/auth/refresh` |

- `Secure` is set in production (`NODE_ENV=production`); in local development
  over `http://localhost` the `Secure` flag is omitted so the flow is
  testable. `HttpOnly` is always set (FR-009: credential not readable by page
  scripts).
- Client code must never read, store, or log either cookie.

### Rate limiting (FR-001)

- Applies to `POST /auth/login` and `POST /auth/register`.
- Two independent budgets (research D1): per-source (trusted-proxy client IP)
  and per-account (email, login only). Operator-configurable; defaults:
  **10 failures / 15 min** per source for sign-in; **3 failures / 15 min** per
  source for registration (tighter — the 409 "already exists" response is an
  enumeration vector per FR-020); **5 failures / 15 min** per account (sign-in
  only).
- On budget exhaustion: `429 Too Many Requests` with a body **identical** to
  a failed sign-in (`{ "error": "Invalid email or password." }` on login; the
  corresponding stable message on register). No header or body may distinguish
  "rate-limited" from "wrong credentials" in a way that aids enumeration
  (SC-002).
- A `Retry-After` header MAY be sent; its presence must not leak account
  existence.

### Security headers (FR-003, FR-004, FR-012)

Production responses (API and served SPA) carry:

- `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' <font-origin>; img-src 'self' data:; connect-src 'self'`
  (`<font-origin>` is operator-configurable; the Vite build inlines no
  external scripts).
- `X-Content-Type-Options: nosniff` (existing)
- `X-Frame-Options: DENY` (existing)
- `Referrer-Policy: strict-origin-when-cross-origin` (existing)
- `Strict-Transport-Security: max-age=31536000; includeSubDomains` (production only)
- **`X-Powered-By` is not sent** (FR-012, US6 scenario 3).
- **CORS**: when `CORS_ORIGINS` is unset, production sends no
  `Access-Control-Allow-Origin` (closed by default, FR-003). When set, it
  lists exactly the permitted origins and `Access-Control-Allow-Credentials:
  true` is sent (cookies require it). Development keeps the permissive
  default for the Vite dev flow.

### Error hygiene (FR-011)

- 5xx responses in production are a single stable body
  (`{ "error": "An internal error occurred." }`) — no stack, query, or
  driver detail. 4xx bodies may carry the specific stable message (e.g.
  policy, validation).

### Enumeration hygiene (FR-020, FR-010)

- `POST /auth/login` failures (wrong email, wrong password, rate limit) are
  indistinguishable: same status (401 or 429), same body, same timing class.
- `POST /lists/:listId/share` returns the **same** status and body whether or
  not the recipient email is registered (FR-010). No `404 not found` path for
  unregistered emails.

## New Endpoints

### POST /auth/refresh

Rotates the session's refresh token (research D3).

- **Request**: no body. Requires the `gifty_refresh` cookie.
- **200 OK** — body `{ "user": { id, email, displayName } }`; sends a new
  `gifty_access` cookie and a **rotated** `gifty_refresh` cookie (old value
  recorded for reuse detection only).
- **401 Unauthorized** — body `{ "error": "Session is no longer active.", "reason": <"expired" | "revoked" | "stale_refresh"> }`; sent
  when the presented refresh token is unknown, the session is
  revoked/expired, or a **stale (already-rotated) token is replayed** — in
  the replay case the entire session family is revoked (FR-026) and both
  cookies are cleared in the response.
  - `reason` is present **only** on this endpoint and distinguishes the cause
    so the client can act per **FR-027**: `stale_refresh` → show the security
    notice + recommend a password change; `expired`/`revoked` → the plain
    "sign in again" outcome. This does not weaken anti-enumeration (the caller
    already holds a refresh token; the value is not an account-existence hint).
- A successful refresh also advances the session's 30-day cap (sliding).

### POST /auth/logout

Signs out the current session (FR-008).

- **Request**: no body. Requires the `gifty_access` cookie (session must be
  resolvable via `sid`).
- **204 No Content** — session revoked server-side (`revokedAt = now`); both
  cookies cleared (`Max-Age=0`). Subsequent requests with the old access
  token get `401` even before its `exp` (revocation is immediate).
- **401 Unauthorized** — `{ "error": "Session is no longer active." }` if the
  session cannot be resolved (already signed out, expired, or revoked).

### GET /account

Returns the caller's own profile (unchanged from 001, now cookie-auth).

- **200 OK** — `{ "user": { id, email, displayName } }`

### DELETE /account

Removes the caller's own account (FR-014, clarification Q1).

- **Request**: no body. Requires a valid session.
- **204 No Content** — transactional removal (research D12): sessions
  revoked → claims on others' items cleared (items revert to `available`) →
  owned lists (and their items/shares/invitations) deleted → pending
  invitations for this email discarded → user row deleted. Both cookies
  cleared. Audit event `account_removal` recorded.
- **401 Unauthorized** — not authenticated.
- **409 Conflict** — not expected in this feature; reserved.

### GET /lists/:listId/consent

Recipients fetch their current consent state for the list (FR-021).

- **Request**: authenticated **recipient** of the list.
- **200 OK** — `{ "consent": "pending" | "revealed" | "declined", "displayName": "<recipient's own display name>" }`
- **403 Forbidden** — caller is not a recipient of the list.
- **404 Not Found** — no such list.

### POST /lists/:listId/consent

Sets (or re-sets) the caller's consent (FR-021, FR-023 — revocable, either
direction, any time).

- **Request body**: `{ "consent": "revealed" | "declined" }`
- **200 OK** — `{ "consent": "revealed" | "declined" }`
- **400 Bad Request** — body missing or `consent` not one of the two values.
- **403 Forbidden** — caller is not a recipient of the list.
- **404 Not Found** — no such list.

## Changed Endpoints (behavior deltas from 001)

### POST /auth/register

- New: `400 Bad Request` with a **stable policy message** when the password
  fails the policy (FR-002):
  `{ "error": "Password must be at least 8 characters and include an uppercase letter, a lowercase letter, a number, and a symbol." }`
- New: `429` per the rate-limit contract (FR-001).
- New: on success, **invitations are matched** (SC-009): any
  `PendingInvitation` for this email becomes a `SharePermission` (consent
  `pending`) before the `201` is returned. Response gains nothing visible to
  the caller beyond the existing `{ user }` (matching is a side effect, not a
  payload change).
- New: `Set-Cookie` for `gifty_access` + `gifty_refresh` (replaces the
  returned `token` field, which is **removed** from the response).
- `409 Conflict` body unchanged: `{ "error": "A user with this email already exists." }`

### POST /auth/login

- New: `429` per the rate-limit contract (FR-001).
- New: `Set-Cookie` for `gifty_access` + `gifty_refresh`.
- Changed: the `token` field is **removed** from the `200` body; body is now
  `{ "user": { id, email, displayName } }`.
- Unchanged: `401` body `{ "error": "Invalid email or password." }` (FR-020).

### POST /lists/:listId/share

- Changed: for an **unregistered** email, the endpoint now succeeds (same as
  registered) and creates a `PendingInvitation` (FR-010, US5 scenario 7). No
  more `404 ... not found` for unregistered emails (FR-020 enumeration fix).
- Response `200`/`201` unchanged in shape: `{ "list": { ... } }` — the owner's
  view of the shared recipient is the **email string** (from
  `recipientEmail`), never a resolved user object.
- New: re-share after revocation creates a fresh `SharePermission` with
  consent `pending` (edge case "Re-share after revocation").

### GET /lists/:listId (and `GET /lists` dashboard rows)

- Changed (recipient view): `owner` object no longer contains `email` — only
  `{ id, displayName }` (FR-025).
- Changed (recipient view): co-recipient identity fields are consent-gated
  (FR-021/FR-024) — a claimant's name renders as the display name when that
  claimant's consent is `revealed`, otherwise the placeholder string `"????"`.
- Unchanged (owner view): owner always sees recipient emails and display
  names; owner **never** sees any claim/purchase state or claimant identity
  (FR-016, do-not-regress).
- New: each recipient entry in the list's sharing metadata exposes
  `consent: "pending" | "revealed" | "declined"` to the **owner only**.

### GET /lists/:listId/share-permissions (owner) and GET /lists/:listId/recipients (recipient)

- New (contractually pinned, 2026-10-02): the **ordering** of the
  shared-recipient entries in both responses (FR-029). Both endpoints merge
  the list's registered shares and pending invitations, then order:
  1. identified (name-revealed) entries alphabetically by display name;
  2. (recipient view only) the viewer's own masked entry, when present;
  3. all remaining unidentified entries in the order they were invited
     (share/invitation creation order).
- The ordering MUST NOT distinguish registered from unregistered invitees by
  position — an entry's position MUST NOT let a viewer infer whether the
  invitee has registered (FR-010).

## Status-Code Summary (new/changed)

| Endpoint | 400 | 401 | 403 | 404 | 409 | 429 | 200/201/204 |
|---|---|---|---|---|---|---|---|
| `POST /auth/register` | policy | — | — | — | email exists | budget | creates user + cookies |
| `POST /auth/login` | — | bad credentials | — | — | — | budget | issues cookies |
| `POST /auth/refresh` | — | stale/revoked/unknown | — | — | — | — | rotates tokens |
| `POST /auth/logout` | — | no session | — | — | — | — | revokes + clears |
| `DELETE /account` | — | not authed | — | — | — | — | removes account |
| `GET /lists/:id/consent` | — | not authed | not recipient | no list | — | — | consent state |
| `POST /lists/:id/consent` | bad body | not authed | not recipient | no list | — | — | sets consent |
| `POST /lists/:id/share` | bad body | not authed | not owner | no list | — | — | shares (registered or pending) |

## Conformance Notes for Tests

- Contract tests (Supertest) must assert the **uniformity** of login failures
  (same status+body for unknown email vs wrong password) and the **absence**
  of a `404` on unregistered share (FR-010/FR-020, US5 scenario 7, US6
  scenario 1).
- Cookie assertions: `gifty_refresh` must not be sent to any path other than
  `/auth/refresh`; `HttpOnly` must be present on both (FR-009).
- Header assertions: no `X-Powered-By`; CSP present in production (FR-004,
  FR-012).
- Consent state transitions and their effect on co-recipient name rendering
  are covered by user-story 5 tests (FR-021–024).

# Phase 0 Research: Security Hardening

**Feature**: [spec.md](spec.md) | **Branch**: `security-hardening` | **Date**: 2026-09-27

**Purpose**: Resolve the design choices required to implement the spec against the
existing codebase. No `NEEDS CLARIFICATION` markers remain in the spec (all
resolved during `/speckit-clarify`, Session 2026-09-27). Each decision records
what was chosen, why, and the alternatives evaluated.

**Grounding facts (verified in-repo)**:
- Stack: Express 4 + Prisma 6 + PostgreSQL 16 backend; React 18 + Vite 6 frontend; single-container Docker deployment (feature 002).
- Auth today: `backend/src/auth/router.ts` issues a single `jwt.sign(..., { expiresIn: '7d' })`; `middleware.ts::requireAuth` verifies it with `jwt.verify` + a `prisma.user.findUnique` existence check. Token is held by the frontend in `localStorage['gift-list-token']` (`frontend/src/services/api.ts`, `frontend/src/context/AuthContext.tsx`).
- `backend/src/config/index.ts::validateConfig()` only checks `JWT_SECRET` is set (and rejects the literal `development-secret` in production) and that `DATABASE_URL` is set. No length/strength check; no DB-credential check.
- `backend/src/app.ts`: `cors(corsOrigins ? { origin } : {})` → open by default when `CORS_ORIGINS` is unset; security headers set but **no CSP**; `app.set('x-powered-by')` not disabled.
- `docker-compose.yml` sets `POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-gifty_dev_password}` (a well-known default) and embeds it in `DATABASE_URL`.
- `backend/src/gift-lists/router.ts::withOwnerIdentity` returns the owner **email** to recipients (FR-025 violation); `POST /:listId/share` returns `404 'Recipient user with this email not found'` for unregistered emails (FR-010/FR-020 violation).
- `backend/package.json` production deps include `@prisma/client` (→ `deepmerge-ts` HIGH via `@prisma/config`) and `express` (→ `qs` moderate) per `npm audit --omit=dev`.
- `backend/src/permissions/access.ts` + `gift-items/router.ts` implement the owner-privacy + atomic-claim invariants that MUST NOT regress (FR-016–019).

---

## D1 — Rate-limiting store and "source" keying (FR-001, SC-002)

**Decision**: Enforce two independent budgets at the two auth entrypoints
(`/auth/login`, `/auth/register`): (a) a **per-source** budget keyed on the
client IP taken from the trusted-proxy forwarded header (`X-Forwarded-For`
leftmost untrusted-trusted value, falling back to `req.ip`), and (b) a
**per-account** budget keyed on the normalized email for `/auth/login` only.
Both are fixed-window counters with a bounded window and a bounded failure
threshold, operator-configurable via env with sensible defaults:
**10 failures / 15 min** for sign-in per source; **3 failures / 15 min** for
registration per source (tighter, because register's 409 response is an
enumeration vector — FR-020); **5 failures / 15 min** per account (login
only). Counters live in an in-process `Map` with window timestamps; a periodic
sweep (or lazy expiry on access) drops stale windows. Exceeding a budget
returns `429` with a
body identical to a normal failed auth attempt (no account-existence hint, per
FR-020/SC-002).

**Rationale**: Matches clarification Q3 exactly (trusted-proxy IP + per-account
budget) and the spec's "source" definition. Per-account is what defeats
source-IP rotation (US1 scenario 6); per-source is what defeats mass
enumeration and throwaway-account creation. In-process is sufficient for the
single-replica deployment (Assumptions; feature 002) and avoids a new
stateful dependency. The 429 body mirroring a failed attempt preserves the
anti-enumeration guarantee.

**Alternatives considered**:
- *Redis-backed counters (e.g. `rate-limiter-flexible` + Redis)* — the standard
  multi-replica answer, but introduces a new service into the single-container
  deployment and is overkill for the declared single-replica scope. Rejected
  now; documented as the promotion path if HA is ever in scope.
- *`express-rate-limit` middleware* — fine for per-source, but does not
  natively provide the per-account (email-keyed) budget that requires reading
  the request body before the limit is applied, and its store abstraction
  still needs a backend for multi-instance. Rolling our own ~60-line module
  keeps both budgets in one place and testable without a store.
- *Keying on `Authorization`/user-agent or a client nonce* — weaker than IP for
  source attribution and adds a client contract; not required by the spec.

**Test hooks**: unit tests drive the counter directly (inject a clock + key);
integration tests fire N+1 requests through Supertest and assert `429` after
the threshold, and that a second, distinct source is unaffected.

---

## D2 — Password policy enforcement (FR-002, US1 scenario 3)

**Decision**: Validate the password at registration in a small pure function
(`auth/password-policy.ts`) returning `{ ok, message }`. Default policy:
length ≥ 8 AND contains at least one uppercase letter, one lowercase letter,
one digit, and one non-alphanumeric symbol. The rejection `400` message is a
single, stable, user-facing string that states the requirement (e.g.
"Password must be at least 8 characters and include an uppercase letter, a
lowercase letter, a number, and a symbol."). The policy is applied only to
**new** accounts (registration); sign-in is unaffected.

**Rationale**: Matches clarification Q5 (Option D) and the spec's "user-facing
message describing the requirement." A pure function is trivially unit-testable
and keeps the router thin. Keeping it to new accounts only avoids locking out
existing users whose passwords predate the policy (no forced migration is in
scope).

**Alternatives considered**:
- *Composition-free length-only (≥ 12, NIST 800-63B style)* — a defensible
  alternative, but the user explicitly chose the composition-rule policy in
  clarification Q5; the spec and checklist now codify that choice.
- *Zod/Joi schema validation* — the repo has no validation library in
  production deps today; adding one for a single field is unnecessary
  surface. Rejected.

---

## D3 — Two-layer session / credential model (FR-007, FR-008, FR-026, US4)

**Decision**: Introduce a stateful `UserSession` row per active login. Two
credentials are issued at sign-in and rotated at refresh:
- **Access credential**: a signed JWT (`jsonwebtoken`, same `JWT_SECRET`) with
  a short `exp` (implementation default **10 minutes**, within the spec's ≤1 h
  bound) and a `sid` (session id) claim. Verified in `requireAuth` by
  `jwt.verify` **plus** a `prisma.userSession.findUnique({ where: { id: sid,
  revokedAt: null } })` check, so revocation is effective immediately.
- **Refresh credential**: a cryptographically random opaque token
  (`crypto.randomBytes(32)`), stored **only as a SHA-256 hash** on the
  `UserSession` row. On `/auth/refresh`, the server looks up the session by
  the presented hash; if found and live, it **rotates** (generates a new
  token, stores the new hash, and records the old hash as
  `previousRefreshHash` for a bounded reuse-detection window). If a presented
  hash matches `previousRefreshHash` (a replay of an already-rotated token),
  the entire session is revoked (`revokedAt = now`) and the user must
  re-authenticate (FR-026 theft signal).

**Rationale**: This is the industry "stay logged in" pattern the user asked
about, and it satisfies FR-007 (bounded access lifetime + 30-day session cap
via `UserSession.expiresAt`), FR-008 (server-side revocation on sign-out), and
FR-026 (rotation + reuse detection) simultaneously. Storing only the refresh
**hash** means a DB leak does not yield usable refresh tokens. The `sid` claim
is what makes `requireAuth` revocation-aware without a per-request DB write
beyond one indexed read.

**Alternatives considered**:
- *Keep a single longer-lived stateless JWT (e.g. 24 h)* — simpler, but
  cannot be revoked server-side (defeats FR-008) and keeps the credential in a
  script-readable form (defeats FR-009's intent). Rejected.
- *Opaque access tokens only (no JWT)* — requires a DB read on every request;
  the signed-JWT + sid-check gives the same revocation with one indexed read
  and keeps the access credential self-contained. Chosen.
- *`httpOnly`-only single bearer (no rotation)* — loses FR-026 theft
  detection. Rejected.

**Boundaries**: access `exp` ≤ 1 h (spec) — we use 10 min for a smaller
compromise window; session `expiresAt` = 30 days (spec default) from last
activity or issuance (implementation detail, operator-configurable).

---

## D4 — Credential storage: `HttpOnly` cookies (FR-009, US4 scenario 5)

**Decision**: Both credentials are delivered and returned via `Set-Cookie`:
- `gifty_access` — `HttpOnly; Secure; SameSite=Lax; Path=/`
- `gifty_refresh` — `HttpOnly; Secure; SameSite=Lax; Path=/auth/refresh` (scoped
  path so it is only sent to the refresh endpoint, limiting its exposure)

The frontend **stops** writing the token to `localStorage`
(`gift-list-token`) and **stops** sending `Authorization: Bearer …` headers;
the browser attaches the access cookie automatically on same-site requests.
`Secure` is safe because the app is served over TLS at the edge (Assumptions);
in local development the frontend/API run over `http://localhost`, which
browsers treat as a secure context for `Secure` cookies only when
`localhost` is exempted — we therefore set `Secure` conditionally on
`NODE_ENV === 'production'` and rely on the edge for production.

**Rationale**: `HttpOnly` is the property that makes the credential
"not readable by page scripts" (FR-009) — `localStorage` is, by definition,
script-readable, so it is disallowed. `SameSite=Lax` plus the scoped
`Path=/auth/refresh` on the refresh cookie contain the main CSRF vector for
the refresh call (a cross-site `fetch` to `/auth/refresh` will not carry the
cookie, and a top-level GET navigation won't POST). The scoped path means the
refresh credential is never sent to data endpoints even if a script could
force a request.

**Alternatives considered**:
- *Keep `localStorage` for the access token + `HttpOnly` only for refresh* —
  the access token would still be script-readable, violating FR-009. Rejected.
- *`SameSite=Strict`* — stronger, but breaks legitimate cross-site redirects
  back into the app; `Lax` is the safe default for this SPA. Chosen.
- *CSRF token on the refresh endpoint* — a reasonable hardening add-on; the
  `SameSite` + scoped-path combination is the primary control and a token is
  an optional extra. Noted, not required by the spec.

**Frontend impact**: `api.ts::getAuthHeaders` drops the `Authorization`
header; `AuthContext` no longer persists a token; the 401 handler calls
`/auth/refresh` (see D8). Existing e2e tests that seed `localStorage` must be
re-baselined to use cookie-based auth (Playwright context).

---

## D5 — Access-token verification stays in `requireAuth` (FR-018)

**Decision**: `middleware.ts::requireAuth` keeps its current shape
(`jwt.verify` + user existence check) and **adds** the `UserSession` liveness
check keyed on the `sid` claim. `authorizeList`/`authorizeItem` and
`permissions/access.ts` are **unchanged** — deny-by-default authorization is a
do-not-regress invariant (FR-018) and is already correct.

**Rationale**: Minimal diff to the authz surface reduces regression risk to
the invariants we are explicitly protecting (FR-016–019). The only authz-
relevant change is that an otherwise-valid JWT is now also rejected if its
session was revoked, which is the FR-008 requirement.

**Alternatives considered**:
- *Move verification into a new `requireSession` middleware* — a rename
  refactor with no functional benefit and more diff. Rejected.

---

## D6 — Consent + pending-invitation data model (FR-010, FR-021–025, US5)

**Decision**:
- Extend `SharePermission` with two columns: `recipientEmail String?` (the
  email the owner used to invite; source of truth for the owner's view) and
  `nameDisclosureConsent NameDisclosureConsent @default(pending)` where the
  enum is `pending | revealed | declined`. When the recipient is a registered
  user, `recipientUserId` is set and the consent defaults to `pending` until
  the recipient acts (FR-021/FR-023).
- New `PendingInvitation` model: `{ id, giftListId, inviteeEmail,
  ownerUserId, status: pending|matched|discarded, createdAt, expiresAt }`,
  with a unique constraint on `(giftListId, inviteeEmail)`. On share to an
  unregistered email, a `PendingInvitation` is created and the response is
  identical to a registered share (FR-010, US5 scenario 7, US6 scenario 1). On
  registration with a matching email, all `pending` invitations for that email
  are matched: a `SharePermission` row is created (consent `pending`) and the
  invitation is marked `matched` (FR-010, SC-009).
- `identity.ts::decorateItemIdentity` becomes consent-aware: it resolves a
  claimant's display name **only** when that claimant's `nameDisclosureConsent`
  on the list is `revealed`; otherwise it emits a neutral placeholder
  (FR-024). The owner-privacy suppression path is untouched (FR-016).
- `withOwnerIdentity` (and every owner-echo path) stops returning the owner
  `email` to recipients — only `displayName` (FR-025).

**Rationale**: Matches the clarification (Q1 cascade, US5/US6 scenarios) and
keeps consent as a single, revocable, per-list state on the existing
`SharePermission` row — no new relation for the registered case. The
`PendingInvitation` table is the minimal structure that makes
"share to an unregistered email is accepted and matched at registration"
expressible and queryable (SC-009).

**Alternatives considered**:
- *Store consent in a JSON blob on `GiftList`* — loses the per-recipient
  granularity the spec requires (consent is per recipient per list). Rejected.
- *A separate `NameDisclosureConsent` table* — an extra join for what is a
  single scalar per existing row; a column is simpler and the
  `SharePermission` row already has the `(giftListId, recipientUserId)`
  uniqueness. Chosen.
- *Send an email to the pending invitee* — explicitly out of scope (Assumptions:
  "the app does not email"). Rejected.

**Migration note**: adding `nameDisclosureConsent` (defaulted) and
`recipientEmail` (nullable) to `SharePermission` is non-breaking; the new
`PendingInvitation` table is additive. One migration.

---

## D7 — Audit capture (FR-013, SC-001, US7)

**Decision**: New `AuditEvent` model
`{ id, actorUserId?, action, targetType?, targetId?, outcome, ip?, createdAt }`
with an index on `createdAt` and on `actorUserId`. A small
`audit/events.ts` exposes `recordAuditEvent(partial)` that enqueues a
`prisma.auditEvent.create` **without awaiting it on the request path**
(fire-and-forget with a `.catch` that logs to stderr). Capture points are
added at: auth success/failure (login, register), list share, list revoke, item
claim, item purchase, item revert, and account removal — including **failed /
denied** attempts (edge case "Audit under failure"), where `actorUserId` may be
null and `outcome` is `denied`/`failure`. No query/export API is added
(clarification Q2: the trail is inspectable by the operator in the data store).

**Rationale**: Satisfies SC-001 (100% of listed actions produce a record) and
the "failed or denied attempts" requirement without coupling the audit write
to request latency. A plain table is the spec's own model ("stored in the
app's own data store"). Keeping it append-only and unqueryable-via-API matches
the deferred admin feature (Out of Scope).

**Alternatives considered**:
- *Structured log lines (pino) to stdout only* — loses the durable,
  attributable, queryable record the spec asks for ("queryable … record");
  logs are not a data store. Rejected as the primary mechanism (stderr logging
  of audit-write failures is fine as a side channel).
- *An external sink (SIEM/ELK)* — explicitly out of scope (Assumptions).
  Rejected.
- *Awaiting the audit write* — correct but adds a DB round-trip to every
  security-relevant action; the spec does not require synchronous durability.
  Fire-and-forget chosen, with the trade-off documented.

---

## D8 — Frontend auth flow with transparent refresh (FR-007/008/009)

**Decision**: Rework `frontend/src/services/api.ts` and
`context/AuthContext.tsx`:
- Remove the `localStorage` token; rely on the `HttpOnly` access cookie.
- `handleResponse` on a `401`: call `POST /auth/refresh` **once** (the browser
  sends the `gifty_refresh` cookie). On success, retry the original request
  exactly once with the new access cookie. On refresh failure, dispatch the
  existing `SESSION_EXPIRED_EVENT` so `AuthContext` clears state and
  redirects to `/auth` (preserving current UX).
- `logout()` calls `POST /auth/logout` (server revokes the session, clears
  both cookies) and then clears local UI state.
- The auth page (`AuthPage.tsx`) surfaces the password-policy message (FR-002)
  and the sign-in "Invalid email or password" message (FR-020) unchanged.

**Rationale**: Keeps the user-facing behavior identical (auto-redirect on
expiry, same sign-in page) while moving credential storage off
`localStorage`. The single-retry guard prevents a refresh loop. This is the
standard cookie-session flow and is well within the existing React Router SPA
structure.

**Alternatives considered**:
- *Explicit "refresh button" / no auto-refresh* — worse UX and not required.
  Rejected.
- *A service-worker token store* — over-engineered; `HttpOnly` cookies already
  satisfy FR-009. Rejected.

---

## D9 — Startup gate (FR-005, FR-006, US3)

**Decision**: Extend `config/index.ts::validateConfig()` so that, in the
production context (`NODE_ENV === 'production'`), it throws (failing the boot)
when:
- `JWT_SECRET` is missing, **or** shorter than 32 bytes (256 bits), **or**
  equal to a known default value (the existing `development-secret` check plus
  any value in a small deny-list);
- the `POSTGRES_PASSWORD` parsed from `DATABASE_URL` is missing or equal to a
  known default (`gifty_dev_password`).

In non-production, the existing lenient behavior is retained (local dev is not
blocked). `server.ts` already calls `validateConfig()` before serving, so a
thrown error yields a non-zero exit with the message (SC-004).

**Rationale**: Directly implements US3's four scenarios and clarification Q5's
bundled secret floor. Parsing the password out of `DATABASE_URL` keeps a single
source of truth. Keeping the gate context-scoped preserves the
"weak secret in a non-production context" edge case.

**Alternatives considered**:
- *Fail in all contexts* — would block local development and violate the
  edge case. Rejected.
- *Require a min-entropy (zxcvbn-style) check on the secret* — overkill for an
  operator-supplied value; a length + deny-list is the spec's ask. Rejected.

---

## D10 — Supply chain (FR-015, SC-006, US8)

**Decision**: 
- Apply `npm audit fix --omit=dev` in `backend/` to resolve the
  `deepmerge-ts` (HIGH, via `@prisma/config`) and `qs` (moderate, via
  `express`) advisories; verify with `npm audit --omit=dev` that **0
  high/critical** remain (SC-006).
- Add a release-verification step (package.json script, e.g.
  `audit:prod` → `npm audit --omit=dev --audit-level=high`) that CI / the
  release process runs and that **blocks** on a high/critical finding unless
  explicitly accepted (FR-015, US8 scenario 2).

**Rationale**: The current `npm audit --omit=dev` reports 5 findings including
one HIGH; FR-015/SC-006 require zero high/critical in the production runtime.
A gate script turns "keep it clean" into an enforced, repeatable check.

**Alternatives considered**:
- *Pin exact versions and ignore advisories* — does not satisfy "no known
  high/critical." Rejected.
- *A dependency bot / Renovate policy* — process, not a code artifact; the
  audit gate is the enforceable control the spec names. The gate is chosen.

---

## D11 — Trust boundary: CORS, CSP, headers (FR-003, FR-004, FR-012)

**Decision**: In `app.ts`:
- **CORS closed by default**: when `CORS_ORIGINS` is unset, configure the `cors`
  middleware with `origin: false` (reflect no origin) in production instead of
  the current open `{}`; when set, allow exactly the listed origins (FR-003,
  SC-003). In development, the current open behavior is retained for the Vite
  dev flow.
- **CSP**: add a `Content-Security-Policy` header restricting
  `default-src 'self'`, `script-src 'self'`, `style-src 'self' 'unsafe-inline'`
  (Vite/React inline styles), and `font-src 'self' <permitted font origin>`
  (FR-004). The permitted font source is operator-configurable.
- **No framework/server advertisement**: `app.disable('x-powered-by')` (FR-012,
  US6 scenario 3).
- **HSTS**: set `Strict-Transport-Security` in production (edge TLS assumed).
- **Error hygiene**: confirm `common/errors.ts` already hides 5xx detail in
  production (FR-011); no change if it does.

**Rationale**: Implements US2 and US6 scenarios with the fewest moving parts,
using the existing `cors` dependency and inline header middleware (the repo
already sets headers by hand in `securityHeaders`). `origin: false` is the
clean "closed by default" expression.

**Alternatives considered**:
- *A dedicated `helmet` package* — would bundle the headers for us, but adds a
  dependency and a default CSP that would need customizing anyway; the repo's
  existing hand-rolled `securityHeaders` is the established pattern. Rejected
  (keep the pattern, add CSP).

---

## D12 — Account removal cascade (FR-014, US7)

**Decision**: `account/removal.ts::removeAccount(userId)` runs a single Prisma
transaction that, in order:
1. Revokes all the user's `UserSession` rows (`revokedAt = now`).
2. Clears the user's claims on **other** users' items: set
   `claimantUserId = null`, `state = 'available'`, `claimedAt = null`,
   `purchasedAt = null` on `GiftItem` rows where `claimantUserId = userId`
   (items revert to unclaimed per clarification Q1).
3. Deletes the user's **owned** `GiftList` rows (Prisma cascade removes their
   `GiftItem`, `SharePermission`, and `PendingInvitation` rows via
   `onDelete: Cascade`).
4. Marks any `PendingInvitation` where `inviteeEmail = user.email` and
   `status = pending` as `discarded` (edge case "Account removal with pending
   invitations outstanding").
5. Deletes the `User` row.
6. Records an `account_removal` audit event (actor = the removed user, outcome
   = `success`).

The endpoint requires authentication and is the user's own account (deny-
by-default, FR-018). The owner-privacy invariant holds because deletion only
*removes* visibility; it never newly exposes claimant identity (FR-016, US7
scenario 3).

**Rationale**: Matches clarification Q1 (owned lists deleted; claims cleared)
and the two removal edge cases. Doing it in one transaction makes the cascade
atomic and idempotent-ish (re-run finds nothing). Reusing the existing
`onDelete: Cascade` on `GiftList` keeps the owned-side cleanup declarative.

**Alternatives considered**:
- *Soft-delete (a `deletedAt` flag)* — the spec says "personal data is no
  longer accessible through the app" and "delete"; a hard delete is the
  faithful reading and avoids retaining the very data the user asked to
  remove. Rejected.
- *Reassign owned lists to a system user* — adds a phantom identity and
  conflicts with "the user's owned lists are deleted." Rejected (clarification
  Q1 chose deletion).

---

## Coverage Map (spec requirement → decision)

| Requirement(s) | Decision |
|---|---|
| FR-001, SC-002 (throttle + source) | D1 |
| FR-002, US1.3 (password policy) | D2 |
| FR-007/008/026, US4, SC-005 (session model) | D3 |
| FR-009, US4.5 (script-unreadable storage) | D4 |
| FR-018 (deny-by-default authz retained) | D5 |
| FR-010, FR-021–025, US5, SC-008/009 (consent + invitations) | D6 |
| FR-013, SC-001, US7 (audit) | D7 |
| FR-007/008/009 (frontend flow) | D8 |
| FR-005/006, US3, SC-004 (boot gate) | D9 |
| FR-015, SC-006, US8 (supply chain) | D10 |
| FR-003/004/012, US2, US6 (trust boundary) | D11 |
| FR-014, US7 (removal cascade) | D12 |
| FR-016/017/019 (do-not-regress invariants) | preserved by D5/D6/D12 (no change to `access.ts` / claim atomics / owner-privacy suppression) |

**Open items**: none. All `NEEDS CLARIFICATION` markers were resolved during
`/speckit-clarify`; the remaining numeric tuning values (rate-limit
thresholds, access-token lifetime within the ≤1 h bound, session cap) are
explicitly implementation/tuning details per the spec's Assumptions and are
operator-configurable with the defaults stated above.

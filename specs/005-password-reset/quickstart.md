# Quickstart Validation: Password Reset (005)

**Feature**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md) | **Contracts**: [contracts/api.md](contracts/api.md) | **Data model**: [data-model.md](data-model.md) | **Date**: 2026-10-12

Runnable validation scenarios that prove the feature works end-to-end. Prerequisites
and commands first, then the scenarios in priority order.

---

## Prerequisites

- Docker running (Postgres for the app + the test DB).
- Root `.env` present with `JWT_SECRET` (≥ 32 chars) and `POSTGRES_PASSWORD`
  (non-default) — the 003 boot gate fails fast otherwise.
- **Keep `EMAIL_TRANSPORT=capture`** for all of the following (the root `.env` has a
  live `RESEND_API_KEY`; capture mode keeps links local and readable, exactly as 004
  validation did).

## Bring the stack up

```powershell
# From the repo root — builds and starts the single container (app + Postgres).
npm run docker:up
# Wait for health:  GET http://localhost:8080/healthz  -> {"status":"ok"}
```

App: **http://localhost:8080**.

---

## Scenario A — Happy path: locked-out user recovers and is signed in (SC-001, SC-004, SC-005, FR-014)

1. `POST /auth/register` with `user-005@example.com` / a policy-passing password →
   note the account is created (capture mode: a confirmation email is also captured;
   ignore it).
2. `POST /auth/login` with the same credentials, then `POST /auth/logout` (you now
   have a real account and no live session).
3. `POST /auth/reset-request` `{ "email": "user-005@example.com" }` → expect **200**
   with the uniform body.
4. Read the captured outbox row (dev/test capture store — same mechanism 004 used,
   e.g. the capture mailer's recorded messages) → extract the `/reset/<token>` link.
5. Open the link in the browser → `ResetPage` renders. Set a **new** policy-passing
   password + confirmation → submit.
6. **Assert**:
   - the response is `200 { "status": "reset", … }` and **session cookies were set**;
   - the browser is now on the app home page, signed in (no sign-in step — FR-014);
   - `POST /auth/logout`, then `POST /auth/login` with the **new** password → 200;
   - `POST /auth/login` with the **old** password → 401 (SC-004).

## Scenario B — Non-enumerable (SC-002, FR-002)

1. `POST /auth/reset-request` with a **registered** email → record status, body, and
   response time.
2. Repeat with a **guaranteed-unregistered** email (`nobody-<random>@example.com`) →
   record status, body, response time.
3. **Assert**: identical status (200), byte-identical body, and no systematic timing
   difference (both perform one bcrypt compare). No outbox row exists for the
   unregistered email.

## Scenario C — Single-use + expiry (SC-003, FR-004/005)

1. From Scenario A step 3–4, take the link.
2. Consume it once successfully (Scenario A step 5).
3. **Replay** the same `POST /auth/reset` with the same token and any valid password
   → expect **400** with the uniform invalid-link body, and **no** password change
   (login with the new password still works; a *different* password was not set).
4. Expiry: with a fresh account, issue a link, then present the token after its TTL
   (for the test, set `EMAIL_TOKEN_TTL_HOURS` low or manipulate the row's
   `expiresAt`) → **400** uniform body.

## Scenario D — Session revocation (US2 scenario 5, FR-012)

1. Sign the account in on **device 1** (a first browser context) → hold its cookies.
2. Sign the account in on **device 2** (a second context).
3. From device 2's signed-out state, complete a full reset (request → link → new
   password).
4. **Assert**:
   - device 1's session is dead: its next authenticated call (or refresh) is
     rejected (`revoked` / 401);
   - the resetting device (the one that submitted `POST /auth/reset`) is signed in
     and can call `GET /account` immediately.

## Scenario E — Unconfirmed email recovers in one flow (US1 scenario 4, SC-006, FR-013)

1. Register a fresh account (email enabled/capture) — it is **unconfirmed**
   (`GET /account` → `user.verified: false`) and would be held at the
   confirmation gate.
2. Log out, request a reset, follow the link, set a new password.
3. **Assert**: success response has `user.verified: true`; the account can navigate
   the app immediately (no confirmation gate); `GET /account` shows
   `verified: true`. No separate confirmation step occurred.

## Scenario F — Rate limiting (FR-007)

1. Fire `RESET_MAX_PER_SOURCE` + 1 consecutive `POST /auth/reset-request` calls from
   one source.
2. **Assert**: the call after the budget is exhausted returns **429** with
   `Retry-After` **and the same uniform body** as success; no new outbox rows were
   created for those; audit shows `password_reset_rate_limited`.

## Scenario G — No list-side impact (FR-010 smoke)

1. As the Scenario A account, create a list, invite a recipient, and (as the
   recipient) claim an item — establishing the 001 invariants.
2. Complete a password reset for the **owner**.
3. **Assert**: the owner still cannot see claimant/claim state; the recipient's view
   is unchanged. (This is a smoke check; the real protection is that the reset
   module shares no code path with list logic.)

---

## Automated suites (run after every rebuild)

```powershell
# Backend (self-provisions the gifty_test DB; requires Docker):
cd backend; npm test; npx tsc -p tsconfig.json --noEmit

# Frontend unit + typecheck:
cd frontend; npx vitest run
cd frontend; ..\backend\node_modules\.bin\tsc.cmd -p tsconfig.json --noEmit

# e2e (stack must be serving; BASE_URL is mandatory — helpers default to :4000):
cd frontend; $env:BASE_URL='http://localhost:8080'; npx playwright test
```

Expected: all green, including the new `password-reset*.test.ts` backend suites and
`tests/e2e/password-reset.spec.ts`.

## Tear down

```powershell
docker compose down          # keep data
docker compose down -v       # reset + wipe DB
```

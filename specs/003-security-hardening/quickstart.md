# Quickstart: Security Hardening

**Feature**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md) | **Date**: 2026-09-27

This guide validates feature 003 end-to-end against the running app. It is a
runbook for a human (or CI) — it assumes the implementation from
[plan.md](plan.md) is complete. For the full test catalog, run the suites in
step 5; the scenarios here are the fastest way to see each user story work.

## 1. Prerequisites

- Docker (feature 002 ships the app as one container + internal Postgres).
- A root `.env` with a **strong** `JWT_SECRET` — at least 32 characters
  (256 bits), not `development-secret` (US3/FR-005):
  ```powershell
  # PowerShell 5.1 — generate 32 random bytes as hex (64 chars)
  [Convert]::ToHexString(-join (1..32 | % { '{0:x2}' -f (Get-Random -Max 256) })) | Set-Content .\secrets.tmp
  "JWT_SECRET=" + (Get-Content .\secrets.tmp) | Set-Content .\.env
  "POSTGRES_PASSWORD=" + (Get-Content .\secrets.tmp) | Add-Content .\.env
  Remove-Item .\secrets.tmp
  ```
- Windows PowerShell 5.1 (or WSL). Ports: `8080` (app) — Postgres stays
  internal.

## 2. Setup

```powershell
cd c:\Users\Travis\gifty
npm install
npm run docker:up          # docker compose up --build -d → http://localhost:8080
```

> **GitHub Codespaces**: use `docker compose -f docker-compose.codespace.yml up --build -d`
> instead (host networking; see `docs/docker.md` §3b).

Health check:

```powershell
Invoke-RestMethod http://localhost:8080/healthz   # {"status":"ok"}
```

> **Codespaces note**: the app is on `localhost:8080`.

Stop (keeps data): `docker compose down` • Reset + wipe DB: `docker compose down -v`

## 3. Quick validation scenarios

Each scenario maps to a user story in [spec.md](spec.md). Use two browser
profiles (or one regular + one private window) for "two users" scenarios.

### US1 — Throttle + password policy (FR-001, FR-002, SC-002)

1. Open `http://localhost:8080/auth`, sign in with a **wrong** password 10
   times (defaults: 10 / 15 min per source). The 11th attempt returns `429`
   with the same body as a failed attempt.
2. Register with password `abc` → `400` with the stable policy message
   (≥ 8 chars, upper, lower, number, symbol).
3. Register with `Passw0rd!` → success.
4. Confirm a *different* source (e.g. a second machine / VPN) can still
   attempt while the first is throttled (per-source budget isolation).

### US2 — Trust boundary (FR-003, FR-004, FR-012)

1. `Invoke-WebRequest http://localhost:8080/ -Method OPTIONS -Headers @{Origin="http://evil.example"}` → no `Access-Control-Allow-Origin` header (CORS closed by default).
2. `Invoke-WebRequest http://localhost:8080/healthz` → headers include `Content-Security-Policy`, `X-Content-Type-Options: nosniff`, **no** `X-Powered-By`.

### US3 — Boot gate (FR-005, FR-006, SC-004)

1. Put `JWT_SECRET=short` in `.env`, then `docker compose up --build -d` →
   container exits non-zero with the message naming `JWT_SECRET`.
2. Put `POSTGRES_PASSWORD=gifty_dev_password` → same failure naming the DB
   credential.
3. Restore strong values → boots, `/healthz` ok.

### US4 — Session blast radius (FR-007–009, FR-026, SC-005)

1. Sign in; in DevTools → Application → Cookies you see `gifty_access` and
   `gifty_refresh`, **both `HttpOnly`**, and **no** `gift-list-token` in
   Local Storage.
2. `POST /auth/logout` → immediately `401` on the next API call with the old
   access token (revocation is immediate, FR-008).
3. In one window sign in; in another (same browser profile) refresh the page
   — you are still signed in until the 30-day cap (long-lived session).
4. Capture the `gifty_refresh` cookie value, call `/auth/refresh` once
   (succeeds), then call `/auth/refresh` again with the **old** value → `401`
   and the *entire* session is dead (theft detection, FR-026).

### US5 — Consent-gated identity (FR-010, FR-021–025, SC-008, SC-009)

1. As **owner**: share a list with `nobody@nowhere.example` (unregistered) →
   **same success response** as a registered share (no enumeration, FR-010).
   Owner sees the email in their sharing list.
2. As **recipient** (registered user): open the list → owner's **name** is
   visible, owner's **email** is not (FR-025).
3. Recipient sees a consent prompt → choose "Keep my name hidden" → as a
   **third** user (another co-recipient), the claimant shows as `????`
   (FR-023/024); after "Reveal my name" the display name appears
   (FR-021). Toggling back works (revocable).
4. Register `nobody@nowhere.example` → they instantly see the shared list in
   their dashboard (SC-009).

### US6 — Recon signals (FR-011–012)

1. Trigger a server error path (e.g. malformed JSON body) → production 5xx
   body is the stable generic message, no stack/query text (FR-011).
2. No `X-Powered-By` header anywhere (US2 step 2 covers this).

### US7 — Audit + removal (FR-013, FR-014)

1. Perform: login, failed login, share, claim, purchase, revert, logout,
   sign-out. Then inspect the store:
   ```powershell
   docker compose exec gifty psql gifty "SELECT action, outcome, \"createdAt\" FROM \"AuditEvent\" ORDER BY \"createdAt\" DESC LIMIT 20;"
   ```
   (container/service names per `docker-compose.yml`; the `psql` binary is in
   the Postgres container.) Expect one row per action **including** the
   failed login (SC-001, "Audit under failure").
2. As a user who claimed items on *another* user's list and owns their own
   list: `DELETE /account` (via UI logout-removal flow or
   `Invoke-RestMethod -Method Delete http://localhost:8080/account -WebSession $s`)
   → 204. The other user's items are back to `available`; the removed user's
   owned lists are gone; the removed email can no longer sign in (FR-014,
   US7 scenarios 1–3).

### US8 — Supply chain (FR-015, SC-006)

```powershell
cd c:\Users\Travis\gifty\backend
npm audit --omit=dev                 # expect 0 high / 0 critical (SC-006)
cd c:\Users\Travis\gifty
npm run audit:prod                   # blocking gate used by CI / release (root script; runs backend/ and frontend/)
```

## 4. Regression invariants (MUST still hold — FR-016–019)

- Owner of a list: dashboard and list view show **no** claim/purchase state
  and **no** claimant identity, ever.
- Two users racing to claim the same item: exactly one wins (atomic).
- Owner is **not** offered a "claim" action on their own items.
- Unauthenticated/unknown user: every list/item endpoint is `401`/`403`.

## 5. Full test suites

```powershell
cd c:\Users\Travis\gifty
docker compose up -d gifty_postgres        # backend tests need Postgres (or docker:up)
cd backend
npm test                                    # Vitest + Supertest (unit + integration + user stories)
cd ..\frontend
npm run test                                # frontend unit tests
npm run test:e2e -- --base-url http://localhost:8080   # Playwright (lifecycle, owner-privacy, share-claim, persistence)
```

All suites must pass (SC-007: no regressions to the existing 80 backend / 8
e2e tests). E2E tests that previously seeded `localStorage['gift-list-token']`
are re-baselined to cookie auth by this feature (see research D4/D8).

## 6. Reset

```powershell
docker compose down -v    # wipe volume; next docker:up starts from a fresh DB
```

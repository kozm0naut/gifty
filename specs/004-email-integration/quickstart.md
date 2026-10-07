# Quickstart: Email Integration

**Feature**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md) | **Date**: 2026-10-03

This guide validates feature 004 end-to-end against the running app. It is a runbook for
a human (or CI) and assumes the implementation from [plan.md](plan.md) is complete. For
the full test catalog, run the suites in step 5; the scenarios here are the fastest way
to see each user story work.

> **Mode under test**: local dev/test runs in **capture mode** (mode b, research D8) —
> `EMAIL_TRANSPORT=capture`. No live email is ever sent; every message is captured to the
> process output and an in-memory buffer that tests assert on. Set `EMAIL_ENABLED=true`
> (the default) so the **blocking confirmation gate is exercised for real** via the
> captured link (US5/Assumptions). The disabled mode (mode c) is validated in step 3c by
> flipping `EMAIL_ENABLED=false`.

## 1. Prerequisites

- Docker (feature 002 ships the app as one container + internal Postgres).
- A root `.env` with a **strong** `JWT_SECRET` (≥ 32 chars) and `POSTGRES_PASSWORD`.
  For local capture mode you do **not** need a real Resend key; set the transport to
  capture:
  ```powershell
  # PowerShell 5.1 — add email config (capture mode, no live provider)
  "EMAIL_ENABLED=true"        | Add-Content .\.env
  "EMAIL_TRANSPORT=capture"   | Add-Content .\.env
  "GIFTY_PUBLIC_ORIGIN=http://localhost:8080" | Add-Content .\.env
  ```
- Windows PowerShell 5.1 (or WSL). Ports: `8080` (app) — Postgres stays internal.

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

Stop (keeps data): `docker compose down` • Reset + wipe DB: `docker compose down -v`

## 3. Quick validation scenarios

Each scenario maps to a user story in [spec.md](spec.md). Use two browser profiles (or one
regular + one private window) for "two users" scenarios. In capture mode, "the email was
sent" means the message appears in the app's process output **and** the captured buffer.

### US1 — Invite email (FR-001, FR-002, SC-001, SC-005)

1. As **owner A**, share a list with `guest@example.com` (a new email, no account) →
   `201` with the **uniform** share body (feature 003, unchanged).
2. In the app's process output (capture mode) you see **one** captured invite addressed
   to `guest@example.com` whose link is `http://localhost:8080/` (home page, **no
   token**, D9). (SC-001, FR-013)
3. As **owner A**, share the **same** list with `guest@example.com` again → `201`, but
   **no second** invite is captured (dedup, SC-001 "0% repeat shares").
4. As **owner A**, share a **different** list with `guest@example.com` → a second invite
   is captured (dedup is per-list, US3 scenario 3).

### US2 — Confirmation email + gate (FR-003, FR-004, FR-012, FR-014, SC-002, SC-008)

1. Open a **private** window, register `newbie@example.com` → `201`, and the response
   `user` object carries `"verified": false`.
2. Capture mode shows a captured confirmation to `newbie@example.com` with a link
   `http://localhost:8080/confirm?token=…` (D4, D9).
3. In the browser you are **held at the confirmation page** (gate, SC-008). Directly
   hitting the API confirms the gate is **server-side**:
   ```powershell
   # unconfirmed account → gated (stable, non-leaking 403)
   Invoke-RestMethod http://localhost:8080/lists -Method Get   # 403 "Please confirm your email to continue."
   ```
4. Follow the captured link:
   ```powershell
   Invoke-RestMethod "http://localhost:8080/confirm?token=<raw-token>"   # 200 { "status":"confirmed" }
   ```
   Reload — you are now on the dashboard; `GET /account` returns `"verified": true`.
5. Follow the **same** link again → **same** `200 { "status":"confirmed" }`, nothing
   broken (US2 scenario 3, FR-010).
6. A **tampered/unknown** token → the **same** uniform body (FR-010, no existence leak):
   ```powershell
   Invoke-RestMethod "http://localhost:8080/confirm?token=deadbeef"   # same 200 body
   ```
7. **Resend** (FR-014): register another unconfirmed account, call
   `POST /auth/resend-confirmation` (with its session cookie) → `202`, and a **new**
   captured confirmation with a **new** token appears. Call it 4 times within the window
   → the 4th is `429` (rate-limited, SC-009 — budget is 3 per 15 min).

### US3 — One invite per (recipient, list), across registration (FR-005, SC-001)

1. Owner A shares list L with `switcher@example.com` (unregistered) → one invite captured.
2. Register `switcher@example.com` (confirm it). The owner **re-shares** list L with the
   same email → **no** additional invite captured (US3 scenario 2 — dedup spans the
   transition because the key is the email).
3. Owner A **revokes** the share, then re-shares list L with `switcher@example.com`
   (the only UI path to a re-share is revocation-first, US3 scenario 1) → no additional
   invite (the `(listId, recipientEmail)` outbox row already exists).

### US4 — Reliable, queued delivery (FR-006, FR-007, SC-004, SC-007)

These are best proven by the test suite (step 5), but the observable facts are:

1. **The share never fails because of email** (SC-007): even with the sender down, the
   share returns `201` the instant the outbox row commits — delivery is out of band.
2. **Retry on transient failure, then delivery** (US4 scenario 2): with the drainer
   running, a message whose first `send` failed is retried (backoff) and reaches
   `sent` once the sender is available.
3. **Bounded, observable failure** (FR-007, US4 scenario 3): a message that fails
   `EMAIL_MAX_ATTEMPTS` times (default 5) lands in terminal status `failed` with a
   scrubbed `lastError` and an `email_failed` audit row — **not** retried indefinitely,
   and **not** silent.

Inspect the durable state:

```powershell
docker compose exec gifty psql gifty `
  "SELECT ""kind"", ""recipientEmail"", ""status"", ""attempts"", ""maxAttempts"", ""sentAt"" FROM ""OutboxMessage"" ORDER BY ""createdAt"" DESC LIMIT 20;"
```

### US5 — Dev/test capture (FR-008, SC-003)

1. Trigger an invite (US1) and a confirmation (US2) in capture mode.
2. Both appear in the **process output** and the **captured buffer**; **zero** calls hit
   the live provider (no `RESEND_API_KEY` is even set). Assertable via the test hook
   (`capturedEmails()`): exactly the expected recipients, subjects, and links.

### US6 — Operator config + boot gate (FR-009, FR-015, SC-006, SC-010)

**3a — Production, enabled, unconfigured → refuse to start (SC-006):**

```powershell
# In a production context (NODE_ENV=production) with EMAIL_ENABLED=true and NO valid
# RESEND_API_KEY:
#   → container exits non-zero with a message that names RESEND_API_KEY and the fix.
```

**3b — Production, enabled, configured → boots (mode a):** set a valid
`RESEND_API_KEY` + `RESEND_FROM` → app boots and delivers via Resend.

**3c — Disabled mode → boots, auto-confirms, warns (FR-015, SC-010):**

```powershell
# EMAIL_ENABLED=false (any context):
#   → app boots normally; the startup log shows a warning:
#     [config] email disabled — new accounts are auto-confirmed; live delivery is off.
#   → register a new account:
```
```powershell
#   → 201 with "verified": true (auto-confirmed), NO confirmation email captured,
#     and the account is immediately usable (no confirmation gate).
```

### Regression invariants (MUST still hold)

- Owner of a list: dashboard and list view show **no** claim/purchase state and **no**
  claimant identity, ever (feature 001/003).
- Two users racing to claim the same item: exactly one wins (atomic).
- Owner is **not** offered a "claim" action on their own items.
- Unauthenticated/unknown user: every list/item endpoint is `401`/`403`.
- The share response is **uniform** for registered vs unregistered recipients (feature
  003 FR-010) — adding the invite email did not change that.
- Existing accounts (created before this feature) are **confirmed** after the migration
  (grandfathering) and can use the app immediately.

## 4. Test-only hooks (capture / test mode)

Available **only** when `EMAIL_TRANSPORT=capture` (or in the test environment), never in
a normal production app (mirrors the feature 003 `GIFTY_ENABLE_TEST_PROBES` discipline):

- `capturedEmails()` — the in-memory ring buffer of messages captured since the last
  reset. Each entry: `{ kind, to, subject, text, link }`.
- `resetCapturedEmails()` — clears the buffer (tests call in `beforeEach`).
- `drainOnce()` — runs one drainer tick synchronously (tests use it to force delivery
  without waiting for the interval), returning the number of messages processed.
- `setMailerForTest(mailer)` — injects a fake `Mailer` (succeed / fail N times / always
  fail) to drive the retry and terminal-failure tests (US4, D2).

## 5. Automated test suites

```powershell
# Backend (self-provisions its own gifty_test DB via the pretest hook)
cd c:\Users\Travis\gifty\backend
npm test
npx tsc -p tsconfig.json --noEmit

# Frontend unit
cd c:\Users\Travis\gifty\frontend
npx vitest run

# E2E (dev stack or docker:up must be serving the app)
$env:BASE_URL = 'http://localhost:8080'
npx playwright test
```

**New suites to run** (see [plan.md](plan.md) / `tasks.md`):
- `outbox-enqueue.test.ts` — transactional enqueue + invite dedup (unique index),
  confirmation enqueue (SC-001, SC-002).
- `outbox-drainer.test.ts` — retry/backoff, terminal `failed`, `superseded`,
  at-least-once claim (US4, SC-004).
- `confirmation.test.ts` — token lifecycle, single-use, non-leaking `/confirm`,
  resend + rate limit, the blocking gate allow-list (US2, SC-008, SC-009).
- `invite-email.test.ts` — one email per (recipient, list), across the register
  transition, different list = new email (US3, SC-001).
- `capture-mode.test.ts` — capture produces expected messages, zero live calls (US5,
  SC-003).
- `email-boot-gate.test.ts` — mode resolution + production boot refusals (US6, SC-006).
- `audit-email.test.ts` — `email_*` audit rows, scrubbed detail (FR-011).

**Existing suites MUST pass unchanged** (SC-007): the feature 001/003 regression
invariants (owner privacy, claim integrity, session/cookie model, consent, pending
invitations, audit, removal) all still hold.

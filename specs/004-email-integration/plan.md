# Implementation Plan: Email Integration

**Branch**: `004-email-integration` | **Date**: 2026-10-03 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/004-email-integration/spec.md`

**Note**: This plan was filled in by the `/speckit-plan` command; its definition describes the execution workflow.

## Summary

Add outbound email to the existing Gifty application (React 18 / Vite 6 frontend, Express 4 / Prisma 6 / PostgreSQL 16 backend, single-container Docker deployment) for **exactly two message types** — an **account confirmation** email (with a single-use verification link) and a **list invite** email (one per recipient per list) — without changing the product surface or the privacy/consent model. The delivery backbone is a **transactional outbox** (`OutboxMessage`) committed in the same transaction as the share/registration and drained by a separate in-process loop with bounded retries and a terminal, operator-observable `failed` state, so a send is never lost, never blocks the originating request, and is never retried forever. The provider is isolated behind a **`Mailer` port** (Resend in production via the runtime `fetch`; a local **capture stub** in dev/test that sends nothing and exposes the captured messages to tests). Confirmation is a **blocking gate** enforced **server-side** (unconfirmed accounts may only reach the confirmation page, resend, and sign-out), with existing accounts grandfathered as confirmed by a migration backfill; when email is **disabled**, new accounts are **auto-confirmed** and a **startup warning** is emitted. `validateConfig()` is extended to fail fast in production when email is enabled but the live sender is unconfigured. The two explicit user directives — the `Mailer` port, Resend + capture stub, the transactional outbox, and the `validateConfig()` extension — are the architectural spine; everything else (drain loop, retry budget, token format, dedup, the gate, the three modes) resolves against those.

## Technical Context

**Language/Version**: Node.js 22 (existing toolchain, `@types/node ^22`; global `fetch` used for the Resend client — no SDK), TypeScript 5.7 (backend `tsc` build), React 18 + Vite 6 (frontend). No new language or major-framework versions.

**Primary Dependencies**:
- Backend (existing): Express 4, Prisma 6 + `@prisma/client`, bcryptjs, jsonwebtoken, cors, cookie, dotenv.
- Backend (new): **none at runtime.** The Resend provider is called with the Node 22 global `fetch` (a single JSON `POST`); the capture stub is pure in-process. No `nodemailer`, no `resend` SDK, no Redis, no queue client (research D1/D2/D8).
- Frontend (existing): React 18, react-router-dom 6, Vite 6 + `@vitejs/plugin-react`. No new runtime deps expected.
- Dev: Vitest + Supertest (backend), Vitest (frontend unit), Playwright (e2e).

**Storage**: PostgreSQL 16 via Prisma (existing `gifty_postgres_data` volume). One new table `OutboxMessage` (with `OutboxKind`, `OutboxStatus` enums) and four nullable columns on `User` (`verifiedAt`, `verificationTokenHash`, `verificationExpiresAt`, `verificationCreatedAt`), all in **one** migration that also backfills `verifiedAt` for pre-existing accounts (grandfathering). No new storage engine; no Redis. The existing `PendingInvitation` / `SharePermission` per-(list, recipient) invariants are reused as the invite-dedup substrate (research D3).

**Testing**:
- Backend: Vitest + Supertest (`backend/tests/`). New suites: outbox enqueue + invite dedup, outbox drainer (retry/backoff/terminal `failed`/`superseded`), confirmation (token lifecycle, non-leaking `/confirm`, resend + rate limit, blocking-gate allow-list), invite email (one per (recipient, list), across the register transition, different list), capture mode (expected messages, zero live calls), email boot gate (mode resolution + production refusals), and email audit rows. **All existing 001/003 suites MUST pass unchanged** (SC-007).
- Frontend: Vitest unit — `AuthContext` / `api.ts` re-baselined for the `verified` field; a new `ConfirmPage` component.
- E2E: Playwright (`frontend/tests/e2e/`) — new specs: register → confirm → usable; invite captured; gate held for unconfirmed; disabled-mode auto-confirm. Existing e2e MUST pass.

**Target Platform**: Docker Engine / Docker Desktop (existing deployment, `npm run docker:up` → http://localhost:8080; Codespaces variant per `docker-compose.codespace.yml`). Browser target: modern evergreen (Chromium/Firefox/Safari). The capture stub means the dev/test loop stays fully offline.

**Project Type**: Web application (existing `backend/` + `frontend/` split, unchanged).

**Performance Goals**: Modest — developer laptop, single replica (Assumptions). The request path gains at most **one extra `INSERT`** in a transaction it was already committing (the outbox row); there is **no delivery I/O** in the request path (FR-006, SC-007). The drainer runs at a modest interval (default 5 s) in batches (default 50) and is not on any request hot path. Verification checks are one indexed `User` lookup (by token hash).

**Constraints**:
- No runtime delivery I/O in any request handler (FR-006, SC-007) — delivery is always out-of-band via the drainer.
- Invite dedup is **enforced by the database** (`@@unique([listId, recipientEmail])` on `OutboxMessage`), not a read-then-write (FR-005, SC-001).
- Verification token stored **only as a SHA-256 hash** on `User`; raw token lives only in the pending `OutboxMessage` body and is never stored on `User`, echoed, logged, or placed in audit `detail` (FR-010, FR-011).
- `/confirm` returns **one uniform non-error body** for valid / used / expired / unknown / missing (FR-010, FR-004, US2 scenario 3) — a closed account-existence oracle.
- The confirmation gate is enforced **server-side** (`requireConfirmed`) with a small pre-confirmation allow-list; the client-side routing is UX, not security (FR-012, SC-008).
- Production boots **only** if email is disabled or a valid live sender is configured (FR-009, SC-006).
- The three sending modes (live / capture / disabled) are derived from config and must never be conflated (Assumptions, FR-015, SC-010).
- All existing 001/003 backend + frontend + e2e suites MUST pass after the change (SC-007).

**Scale/Scope**: Single-operator, single-replica, local deployment (per feature 002). Two low-volume message types. Multi-replica / HA / managed-cloud topologies are out of scope and would promote the in-process drainer to a queue-backed consumer (documented promotion path, research D2). No new top-level directories, no new runtime service.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design.*

Constitution: `.specify/memory/constitution.md`

| # | Principle | Gate for this feature | Result (pre-Phase 0) |
|---|-----------|----------------------|--------|
| I | User Trust & Privacy | The verification token MUST be stored only as a hash and never leak (FR-010); `/confirm` MUST NOT reveal account existence (FR-010); invite responses MUST stay indistinguishable registered/unregistered (FR-002, feature 003 FR-010); owner privacy MUST hold (feature 001/003). | ✅ PASS — token hash-only (D4); uniform non-leaking `/confirm` (D4/contracts); invite enqueue never changes the uniform share response (D3); owner-privacy code untouched. |
| II | List Integrity & Consent | Claim/purchase + owner-cannot-claim MUST be unchanged (feature 001/003 FR-016–019); the confirmation gate MUST NOT alter list/claim data — it only gates account feature access (FR-012). | ✅ PASS — `gift-items/router.ts` / `permissions/access.ts` untouched; the gate is an auth-layer allow-list (D6), not a data change; invite dedup reuses existing invariants without new claim logic. |
| III | Test-First Delivery | Spec + quality checklist complete before implementation; new behavior covered by automated tests; existing suites pass. | ✅ PASS — `spec.md` + `checklists/requirements.md` (16/16) done; quickstart defines runnable validation incl. the 7 new suites + regression invariants (SC-007). |
| IV | Security by Default | Authn required + server-side authz on every mutation; the confirmation gate MUST be server-enforced (FR-012); boot gate on a misconfigured live sender (FR-009); resend MUST be session-scoped + rate-limited (FR-014); no client-supplied identity trusted. | ✅ PASS — gate is `requireConfirmed` middleware (D6); `validateConfig()` extended (D8); resend requires a live session + a new rate-limit budget (D5); `requireAuth`/`authorizeList` pattern preserved. |
| V | Simple, Explainable Sharing | Sharing stays explicit; the new behavior (invite email, confirmation) MUST be a visible, explainable state — no hidden transitions. | ✅ PASS — invite/confirmation are explicit messages; the confirmation state is one field surfaced in the UI and the API (`verified`); disabled mode is a startup warning, not a silent switch (FR-015). |

**Gate result (pre-Phase 0)**: ✅ PASS — no violations; Complexity Tracking not required.

**Gate result (post-Phase 1 design, re-checked)**: ✅ PASS — the design in [research.md](research.md) / [data-model.md](data-model.md) / [contracts/api.md](contracts/api.md) satisfies every gate above with no new violations. The one point requiring explicit justification (a single `200` for all `/confirm` outcomes rather than a 4xx) is a direct consequence of FR-010 (indistinguishable) + FR-004/US2-scenario-3 (non-error) and is documented in the contract; it is not a complexity violation. Complexity Tracking remains unrequired.

## Project Structure

### Documentation (this feature)

```text
specs/004-email-integration/
├── plan.md              # This file (/speckit-plan command output)
├── research.md          # Phase 0 output — D1–D9 resolved decisions
├── data-model.md        # Phase 1 output — OutboxMessage + User verification columns + migration
├── quickstart.md        # Phase 1 output — runnable validation scenarios
├── checklists/
│   └── requirements.md  # Already complete (16/16, re-validated during /speckit-clarify)
├── contracts/
│   └── api.md           # Phase 1 output — /confirm, resend-confirmation, gate, register/share behavior, config surface
└── tasks.md             # Phase 2 output (/speckit-tasks command - NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
.
├── backend/
│   ├── prisma/
│   │   ├── schema.prisma          # EXTEND: + OutboxMessage (+ OutboxKind, OutboxStatus enums);
│   │   │                           #   User + verifiedAt, verificationTokenHash, verificationExpiresAt, verificationCreatedAt
│   │   └── migrations/            # NEW: one migration (table + enums + columns + verifiedAt backfill)
│   ├── src/
│   │   ├── server.ts              # EXTEND: start the outbox drainer on boot, stop it on SIGTERM (D2)
│   │   ├── app.ts                 # EXTEND: wire GET /confirm (public) + POST /auth/resend-confirmation;
│   │   │                           #   surface email mode in startup logging (D8)
│   │   ├── config/index.ts        # EXTEND: parse EMAIL_* config; resolve the sending mode;
│   │   │                           #   validateConfig() production boot gate on RESEND_API_KEY (D8)
│   │   ├── email/                 # NEW feature module
│   │   │   ├── mailer.ts          # NEW: Mailer port + ResendMailer (fetch) + CaptureMailer (D1)
│   │   │   ├── outbox.ts          # NEW: enqueue (transactional, invite dedup via unique index) +
│   │   │   │                      #   drainOnce loop (claim, send, retry/backoff, terminal states) (D2, D3)
│   │   │   ├── links.ts           # NEW: link builders from GIFTY_PUBLIC_ORIGIN (confirmation + home) (D9)
│   │   │   └── verification.ts    # NEW: issue/consume single-use verification token (hash-only) (D4)
│   │   ├── auth/
│   │   │   ├── router.ts          # EXTEND: register → enqueue confirmation (+ auto-confirm when disabled);
│   │   │   │                      #   POST /auth/resend-confirmation (D5)
│   │   │   ├── middleware.ts      # EXTEND: requireConfirmed gate + pre-confirmation allow-list (D6)
│   │   │   └── rate-limit.ts      # EXTEND: + 'confirmation-resend' budget kind, per-account (D5)
│   │   ├── gift-lists/router.ts   # EXTEND: share → enqueue invite (dedup no-op on repeat) (D3)
│   │   ├── audit/events.ts        # EXTEND: + email_invite_queued, email_confirmation_queued,
│   │   │                           #   email_delivered, email_failed (D7)
│   │   └── common/errors.ts       # (unchanged; new endpoints inherit 5xx collapse + error hygiene)
│   ├── tests/                     # EXTEND: + outbox-enqueue, outbox-drainer, confirmation, invite-email,
│   │                              #   capture-mode, email-boot-gate, audit-email; existing 001/003 suites MUST pass
│   └── package.json               # (no new runtime deps; dev deps unchanged)
├── frontend/
│   ├── src/
│   │   ├── services/api.ts        # EXTEND: resendConfirmation(); expose user.verified; confirm() helper
│   │   ├── context/AuthContext.tsx# EXTEND: expose isVerified + a confirm/resend action
│   │   ├── pages/ConfirmPage.tsx  # NEW: the confirmation page (status, resend affordance, "open app" link)
│   │   ├── App.tsx                # EXTEND: route /confirm; gate unconfirmed users to ConfirmPage (D6 UX half)
│   │   └── pages/AuthPage.tsx     # EXTEND: post-register, route to confirmation when verified=false
│   ├── tests/                     # EXTEND: unit for ConfirmPage + verified state in AuthContext/api
│   └── package.json               # (no new runtime deps)
├── docker-compose.yml             # EXTEND (optional): document EMAIL_* env passthrough; no new service
├── .env.example                   # EXTEND: + EMAIL_ENABLED, EMAIL_TRANSPORT, RESEND_API_KEY, RESEND_FROM,
│                                  #   GIFTY_PUBLIC_ORIGIN, EMAIL_* tuning knobs
└── package.json                   # (unchanged; docker:up / dev / test scripts already exist)
```

**Test infrastructure note**: `scripts/ensure-test-db.mjs` (repo root) remains the dev/test-only
self-provisioning hook (brings up the dev-overlay Postgres, ensures `gifty_test`, pushes the Prisma
schema before `npm test`). It is NOT part of the production runtime. The capture stub and its
test hooks (`capturedEmails()`, `resetCapturedEmails()`, `drainOnce()`, `setMailerForTest()`)
are active only when `EMAIL_TRANSPORT=capture` (or in test), mirroring the feature 003
`GIFTY_ENABLE_TEST_PROBES` discipline — they never exist in a normal production app.

**Structure Decision**: Same single-repo, two-app layout as today. All new backend logic lives
under `backend/src/email/` (a small, single-responsibility feature module: `mailer`, `outbox`,
`links`, `verification`) plus targeted extensions to the existing `config/`, `auth/`,
`gift-lists/`, and `audit/` modules — mirroring the `auth/` + `common/` + `permissions/`
organization. One Prisma migration introduces `OutboxMessage` and the four `User` columns (and
the grandfathering backfill). Frontend changes are confined to the existing `services/`,
`context/`, `pages/`, and `App.tsx` plus one new `ConfirmPage`. No new top-level directories, no
monorepo restructuring, no new runtime dependency, no new service (no Redis, no queue) — the single
Postgres instance already in the deployment is the only stateful backend, and the in-process
drainer is the only new long-running work.

## Design Approach (summary of Phase 0 decisions — full rationale in [research.md](research.md))

- **D1 — `Mailer` port**: `ResendMailer` (runtime `fetch`, no SDK) + `CaptureMailer`
  (dev/test, zero network I/O, exposes captured messages). Flows depend only on the port.
- **D2 — Transactional outbox**: `OutboxMessage` committed with the business write; a
  separate in-process drain loop with bounded exponential backoff and a terminal
  `failed` state (never retried forever, always observable).
- **D3 — Invite dedup**: `@@unique([listId, recipientEmail])` on `OutboxMessage` —
  one email per (recipient, list), enforced by the DB, spanning the register transition.
- **D4 — Verification link**: opaque 256-bit token, stored **only as a hash**, single-use,
  24 h window; used/unknown/expired all return the same uniform non-error outcome.
- **D5 — Resend confirmation**: session-scoped, issues a new token (supersedes), enqueues
  a fresh message, rate-limited per account/window; not subject to invite dedup.
- **D6 — Blocking gate**: enforced **server-side** (`requireConfirmed`) with a small
  pre-confirmation allow-list; `GET /account` gains `verified`; existing accounts
  grandfathered via migration backfill.
- **D7 — Audit**: `email_*_queued` / `email_delivered` / `email_failed`,
  `scrub()`-protected, fire-and-forget.
- **D8 — Three modes + boot gate**: live / capture / disabled derived from config;
  production boot gate on `RESEND_API_KEY` when enabled; auto-confirm + startup warning
  when disabled.
- **D9 — Links**: built from `GIFTY_PUBLIC_ORIGIN`; confirmation token-bearing to
  `/confirm`, invite a plain `{origin}/` home URL (no deep link, no token).

## Complexity Tracking

> No Constitution violations to justify (Gate result: ✅ PASS, both checks). This table is
> intentionally empty.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| — | — | — |

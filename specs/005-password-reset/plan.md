# Implementation Plan: Password Reset

**Branch**: `005-password-reset` | **Date**: 2026-10-12 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/005-password-reset/spec.md`

## Summary

Add an unauthenticated **forgot-password email flow**: a signed-out user requests a reset by email, receives a one-time, time-bounded reset link (delivered through the existing durable outbox), and uses it to set a new password. A successful reset is single-use, revokes all other active sessions, confirms the account's email (lifting the 004 confirmation gate), and signs the resetting device in with a fresh session (FR-012/013/014). Requests are non-enumerable and rate-limited; every event lands in the existing audit trail. Technical approach: mirror the proven 003/004 patterns — a dedicated single-use token table (`PasswordResetToken`, research D1), the 256-bit/SHA-256 token mechanics of `email/verification.ts`, a new `reset` outbox kind on the existing queue (D3), and the existing `rate-limit.ts` / `session.ts` / `audit` / cookie machinery (D4–D7).

## Technical Context

<!--
  ACTION REQUIRED: Replace the content in this section with the technical details
  for the project. The structure here is presented in advisory capacity to guide
  the iteration process.
-->

**Language/Version**: TypeScript 5 (strict) on Node 22 — backend `tsx`/ESM; React 18 + Vite 6 frontend

**Primary Dependencies**: Express 4, Prisma 6, bcryptjs, jsonwebtoken, cookie — all already in `backend/package.json`; frontend react-router + existing `services/api.ts` client. **No new dependencies.**

**Storage**: PostgreSQL via Prisma (new `PasswordResetToken` table + `OutboxKind` enum extension; one migration)

**Testing**: Vitest (backend API tests against the dedicated `gifty_test` DB, self-provisioned by `pretest`), Vitest (frontend unit), Playwright (e2e, `BASE_URL` mandatory)

**Target Platform**: Same single-container deployment as features 002/003/004 (app + Postgres; `npm run docker:up` → `:8080`)

**Project Type**: Web application (frontend/ + backend/)

**Performance Goals**: Not a hot path — reset requests are rare, human-paced; must stay under the existing 200 ms-class p95 of the API (no measurable regression)

**Constraints**: Non-enumerable (uniform responses, timing equalization), raw token/password never stored or logged, rate-limited per source and per account, list/claim/purchase behavior untouched (FR-010)

**Scale/Scope**: Two new unauthenticated endpoints + one new table + one outbox kind + 4 frontend pieces (forgot-password link, `ForgotPasswordPage`, `ResetPage`, api helpers) + tests

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **I. User Trust & Privacy — PASS.** Reset is an account-credential path; it touches no list data, and the flow never discloses whether an email is registered (FR-002) or leaks raw secrets (FR-006).
- **II. List Integrity & Consent — PASS.** FR-010 requires zero change to list/item/claim/purchase visibility; the reset module shares no state with list logic.
- **III. Test-First Delivery — PASS (plan commitment).** The feature changes account flows, so automated coverage is mandated: replay/expiry, enumeration, rate limiting, session revocation, unconfirmed-email confirmation, and credential swap are all encoded as spec acceptance scenarios to be covered by backend API tests + e2e before release.
- **IV. Security by Default — PASS.** Server-side enforcement everywhere: single-use token via atomic conditional update, bounded TTL, non-reversible storage, rate limiting, session revocation, audit trail; UI is a thin consumer of the API.
- **V. Simple, Explainable Sharing — N/A (no sharing behavior change).** Outcomes ("check your inbox" / "link invalid or expired" / signed-in) are explicit and user-visible.

**Gate result: PASS — no violations; Complexity Tracking not required.** Re-checked after Phase 1 design: still PASS (all design decisions in research.md reinforce, not relax, the above).

## Project Structure

### Documentation (this feature)

```text
specs/[###-feature]/
├── plan.md              # This file (/speckit-plan command output)
├── research.md          # Phase 0 output (/speckit-plan command)
├── data-model.md        # Phase 1 output (/speckit-plan command)
├── quickstart.md        # Phase 1 output (/speckit-plan command)
├── contracts/           # Phase 1 output (/speckit-plan command)
└── tasks.md             # Phase 2 output (/speckit-tasks command - NOT created by /speckit-plan)
```

### Source Code (repository root)
<!--
  ACTION REQUIRED: Replace the placeholder tree below with the concrete layout
  for this feature. Delete unused options and expand the chosen structure with
  real paths (e.g., apps/admin, packages/something). The delivered plan must
  not include Option labels.
-->

```text
backend/
├── prisma/
│   ├── schema.prisma                 # + PasswordResetToken model; OutboxKind + reset
│   └── migrations/<new>_password_reset/
├── src/
│   ├── auth/
│   │   ├── password-reset.ts         # NEW: POST /auth/reset-request + POST /auth/reset
│   │   ├── router.ts                 # (unchanged; reset routes mounted separately)
│   │   ├── rate-limit.ts             # (unchanged; new budget keys)
│   │   ├── session.ts                # (unchanged; createSession + bulk revoke used)
│   │   └── password-policy.ts        # (unchanged; reused for the new password)
│   ├── email/
│   │   ├── outbox.ts                 # + enqueueReset() (supersede pattern from enqueueConfirmation)
│   │   ├── links.ts                  # + buildResetLink(token)
│   │   └── mailer.ts                 # (unchanged; reset rows drain through it)
│   ├── audit/events.ts               # (unchanged; new action strings)
│   └── config/index.ts               # + reset rate-limit budgets (RESET_MAX_PER_SOURCE/ACCOUNT)
└── tests/
    ├── password-reset-request.test.ts   # uniform response, enumeration, rate limit, disabled mode
    └── password-reset.test.ts           # consume, single-use, expiry, session revoke, email confirm

frontend/
├── src/
│   ├── pages/
│   │   ├── AuthPage.tsx              # + "Forgot password?" link → /forgot-password
│   │   ├── ForgotPasswordPage.tsx    # NEW: email form (POST /auth/reset-request)
│   │   └── ResetPage.tsx             # NEW: set-new-password form (token from /reset/:token)
│   ├── App.tsx                       # + /reset/:token + /forgot-password public routes
│   └── services/api.ts               # + requestPasswordReset() / resetPassword()
└── tests/e2e/password-reset.spec.ts  # full flow in capture mode
```

**Structure Decision**: Option 2 (existing web application layout). All changes are additive inside the two existing apps — one new backend module (`auth/password-reset.ts`), one new table, one new outbox kind, one new frontend page; no new services, packages, or deployment topology. Mirrors how feature 004 added `email/` modules without restructuring.

## Complexity Tracking

> **No Constitution violations — table intentionally empty.**

## Decision Log (summary)

Full rationale in [research.md](research.md).

| # | Decision | One-line rationale |
|---|----------|--------------------|
| D1 | Dedicated `PasswordResetToken` table (not User columns) | Spec models the request as a lifecycle entity (issued/consumed/expired; a pending token is also consumed when any reset for the account succeeds — sibling invalidation, FR-012); no extra user fetch at consume time |
| D2 | 256-bit token, SHA-256-only storage, atomic single-use consume | Proven in `email/verification.ts` (004 D4); matches FR-004/005/006 |
| D3 | New `OutboxKind.reset` on the existing queue | Reuses delivery, retry, capture/disabled modes (004); zero new delivery machinery |
| D4 | New rate-limit budgets `reset-request` (source + account) | Consistent with 003/004 budgets; FR-007 |
| D5 | Uniform 200 on request endpoint + dummy bcrypt equalization | FR-002/SC-002; mirrors 003 login timing guard |
| D6 | `POST /auth/reset`: 200 + fresh session cookies on success; 400 uniform on invalid token | FR-014 auto sign-in; mirrors 004 `GET /confirm` uniformity |
| D7 | Success = password change + sibling token invalidation + revoke all other sessions + confirm email + new session, one transaction | FR-008/012/013 atomicity; sibling invalidation closes old-link takeover (CHK004 B+); reuses `session.ts` |
| D8 | Frontend: `/reset/:token` public route + `ResetPage`; "Forgot password?" on `AuthPage` | Consistent with existing `ConfirmPage` pattern; cookie-only client unchanged |

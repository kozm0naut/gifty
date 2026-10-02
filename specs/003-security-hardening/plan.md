# Implementation Plan: Security Hardening

**Branch**: `security-hardening` | **Date**: 2026-09-27 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/003-security-hardening/spec.md`

**Note**: This plan was filled in by the `/speckit-plan` command; its definition describes the execution workflow.

## Summary

Harden the existing Gifty application (React 18 / Vite 6 frontend, Express 4 / Prisma 6 / PostgreSQL 16 backend, single-container Docker deployment) across eight prioritized user stories without changing the product surface: throttle credential abuse at sign-in/register (FR-001/002), close the trust boundary by default (FR-003/004), gate boot on strong secrets (FR-005/006), replace the current 7-day, non-revocable, `localStorage` JWT with a two-layer stateful session — short-lived access credential + rotating refresh credential with reuse detection, stored script-unreadably (FR-007–009, FR-026), gate recipient identity disclosure behind per-list consent (FR-021–025), hold shares to unregistered emails as pending invitations matched at registration (FR-010), strip reconnaissance signals (FR-011/012, FR-020), record an in-app audit trail (FR-013), and provide account removal with the clarified cascade (FR-014) — all while preserving the owner-privacy, claim-integrity, deny-by-default, and owner-cannot-claim invariants (FR-016–019).

Technical approach: extend the existing `backend/src` module layout with new `auth/session`, `auth/rate-limit`, `auth/password-policy`, `audit`, and `account` modules; add one Prisma migration introducing `UserSession`, `AuditEvent`, and `PendingInvitation` and extending `SharePermission` with `recipientEmail` + `nameDisclosureConsent`; rewrite `auth/router.ts` for the two-layer credential model with `HttpOnly` cookie-based, script-unreadable storage plus `/auth/refresh` and `/auth/logout`; add an auth-entrypoint rate limiter (trusted-proxy IP + per-account budget); gate `validateConfig()` on secret strength and a non-default DB credential; harden `app.ts` (closed-by-default CORS, CSP, no `X-Powered-By`, HSTS in production); make `identity.ts` consent-aware (FR-024); and update the frontend to stop persisting tokens in `localStorage`, transparently refresh on 401, and render the consent prompt + self-serve Sharing control.

## Technical Context

**Language/Version**: Node.js 22 (existing toolchain, `@types/node ^22`), TypeScript 5.7 (backend `tsc` build), React 18 + Vite 6 (frontend). No new language or major-framework versions.

**Primary Dependencies**:
- Backend (existing): Express 4, Prisma 6 + `@prisma/client`, bcryptjs, jsonwebtoken, cors, dotenv.
- Backend (new, minimal): `cookie` (cookie serialization for `Set-Cookie` strings; ~4 kB, zero transitive deps). No Redis, no rate-limit middleware framework, no cookie-session framework (research D1/D4).
- Frontend (existing): React 18, react-router-dom 6, Vite 6 + `@vitejs/plugin-react`. No new runtime deps expected.
- Dev: Vitest + Supertest (backend), Playwright (e2e).

**Storage**: PostgreSQL 16 via Prisma (existing `gifty_postgres_data` volume). New tables: `UserSession`, `AuditEvent`, `PendingInvitation`; `SharePermission` extended in place with `recipientEmail` + `nameDisclosureConsent`. No new storage engine; no Redis (single-replica deployment, research D1).

**Testing**:
- Backend: Vitest + Supertest (`backend/tests/`, existing 80 tests + new suites: rate limit, session lifecycle, consent, pending invitations, removal cascade, audit capture). Existing suites MUST pass unchanged (SC-007).
- Frontend: Vitest unit (`frontend/src/**/*.test.tsx`) — `AuthContext` / `api.ts` tests re-baselined for the cookie model (research D8).
- E2E: Playwright (`frontend/tests/e2e/`, existing 8 tests) — new specs: consent flow, session revocation, pending invitations.

**Target Platform**: Docker Engine / Docker Desktop (existing deployment, `npm run docker:up` → http://localhost:8080; Codespaces variant per `docker-compose.codespace.yml`). Browser target: modern evergreen (Chromium/Firefox/Safari) for the `HttpOnly` + `Secure` cookie model.

**Project Type**: Web application (existing `backend/` + `frontend/` split, unchanged).

**Performance Goals**: Modest — developer laptop, single replica (Assumptions). Access-token verification adds at most one indexed `UserSession` lookup per authenticated request; audit inserts are async fire-and-forget (research D7) and MUST NOT add measurable latency to the request path; rate-limit checks are in-memory O(1) (research D1).

**Constraints**:
- `JWT_SECRET` MUST be ≥ 256 bits (32 bytes) in production (FR-005, clarified Q5); known default values MUST be rejected.
- `POSTGRES_PASSWORD` MUST NOT be the known default in production (FR-006); the current `docker-compose.yml` default (`gifty_dev_password`) is removed from the compose default and required via env.
- Refresh cookie MUST be `HttpOnly; Secure; SameSite=Lax` (FR-009); `Secure` relies on edge TLS termination (Assumptions).
- Access credential MUST be rejected after its bounded lifetime (≤1 h default per spec; this implementation uses 10 min, research D3) and after session revocation (FR-007/008).
- Rate-limit counters are in-memory and reset on process restart — acceptable for single-replica; documented limitation (research D1).
- The frontend MUST NOT persist any session credential in `localStorage` / `sessionStorage` (FR-009).
- All existing backend + frontend test suites MUST pass after the change (SC-007).

**Scale/Scope**: Single-operator, single-replica, local deployment (per feature 002). Multi-replica / HA / managed-cloud topologies are out of scope and would require promoting the rate-limit store to a shared backend (documented limitation, research D1).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Constitution: `.specify/memory/constitution.md` (v1.0.0)

| # | Principle | Gate for this feature | Result |
|---|-----------|----------------------|--------|
| I | User Trust & Privacy | Recipient identity disclosure MUST be consent-gated per list (FR-021–024); owner privacy MUST hold in every response path (FR-016); account removal MUST make personal data inaccessible (FR-014); the refresh credential MUST be script-unreadable (FR-009). | ✅ PASS — `nameDisclosureConsent` added per list + `PendingInvitation` for unregistered emails; owner-privacy suppression in `gift-lists/router.ts` and `identity.ts` is preserved and extended (consent-aware); removal cascade deletes owned lists, clears claims, discards pending invitations, revokes sessions; refresh cookie is `HttpOnly`. |
| II | List Integrity & Consent | Claim/purchase state logic MUST be unchanged (FR-017); owner-cannot-claim MUST hold (FR-019); consent MUST be explicit, revocable, per-list (FR-023). | ✅ PASS — `gift-items/router.ts` atomic-claim code untouched; consent is a separate column on `SharePermission` that does not affect `GiftItem.state` or the claimant FK; re-invite after revocation resets consent (edge case). |
| III | Test-First Delivery | Spec + quality checklist complete before implementation; new behavior covered by automated tests before release; existing suites pass. | ✅ PASS — `spec.md` + `checklists/requirements.md` (16/16, re-validated 2026-09-27) done; quickstart defines runnable validation incl. regression suites. |
| IV | Security by Default | Authn required + server-side authz on every mutation (FR-018); closed-by-default CORS (FR-003); boot gate on weak/default secrets (FR-005/006); rate limiting at the auth entrypoints (FR-001); server-side session revocation (FR-008). | ✅ PASS — all controls land in `backend/` (middleware, `validateConfig`, `app.ts`, new `auth/` modules); no client-supplied identity is ever trusted (existing `requireAuth`/`authorizeList`/`authorizeItem` pattern preserved and extended). |
| V | Simple, Explainable Sharing | Sharing stays explicit: one-time consent prompt on first open + self-serve control in the Sharing section (FR-022/023); no hidden state transitions. | ✅ PASS — consent is one boolean per list surfaced in the UI; revocation returns to placeholder; no new sharing flow types. |

**Gate result (pre-Phase 0)**: ✅ PASS — no violations; Complexity Tracking not required.

## Project Structure

### Documentation (this feature)

```text
specs/003-security-hardening/
├── plan.md              # This file (/speckit-plan command output)
├── research.md          # Phase 0 output (/speckit-plan command)
├── data-model.md        # Phase 1 output (/speckit-plan command)
├── quickstart.md        # Phase 1 output (/speckit-plan command)
├── checklists/
│   └── requirements.md  # Already complete (16/16, re-validated during /speckit-clarify)
├── contracts/
│   └── api.md           # Phase 1 output — REST + cookie contract for the hardened API
└── tasks.md             # Phase 2 output (/speckit-tasks command - NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
.
├── backend/
│   ├── prisma/
│   │   ├── schema.prisma          # EXTEND: + UserSession, + AuditEvent, + PendingInvitation; SharePermission + recipientEmail, + nameDisclosureConsent
│   │   └── migrations/            # NEW: one migration for the above
│   ├── src/
│   │   ├── app.ts                 # EXTEND: closed-by-default CORS, CSP, no X-Powered-By, HSTS (prod)
│   │   ├── config/index.ts        # EXTEND: secret-strength + no-default-DB-credential gate (FR-005/006)
│   │   ├── common/errors.ts       # VERIFY: 5xx messages stay generic in production (FR-011)
│   │   ├── auth/
│   │   │   ├── router.ts          # REWRITE: password policy, rate-limit hook, two-layer credential issue, /refresh, /logout, removal endpoint
│   │   │   ├── middleware.ts      # EXTEND: requireAuth verifies access token AND live session row; authorizeList/authorizeItem logic unchanged
│   │   │   ├── rate-limit.ts      # NEW: trusted-proxy IP + per-account budget, in-memory store with window TTL (FR-001)
│   │   │   ├── password-policy.ts # NEW: 8+ chars with upper/lower/number/symbol; user-facing message (FR-002)
│   │   │   └── session.ts         # NEW: create/rotate/revoke/detect-reuse for refresh credentials (FR-007/008/026)
│   │   ├── audit/
│   │   │   └── events.ts          # NEW: async fire-and-forget audit capture (FR-013)
│   │   ├── permissions/access.ts  # (logic unchanged; may gain a consent-aware helper for recipient decoration)
│   │   ├── common/identity.ts     # EXTEND: resolve names only when nameDisclosureConsent = revealed (FR-024); owner email stripped (FR-025)
│   │   └── account/
│   │       └── removal.ts         # NEW: cascade — clear claims, delete owned lists, discard pending invitations, revoke sessions, audit (FR-014)
│   ├── tests/                     # EXTEND: new suites (rate-limit, session, consent, pending-invitation, removal, audit); existing 80 MUST pass
│   └── package.json               # EXTEND: + cookie dep; apply `npm audit fix` for deepmerge-ts / qs
├── frontend/
│   ├── src/
│   │   ├── services/api.ts        # REWORK: no localStorage token; transparent 401 → /auth/refresh → retry once; pending-invitation surface; consent endpoints (FR-009/010/022/023)
│   │   ├── context/AuthContext.tsx# REWORK: no token in state/localStorage; session derived from cookie-backed API; logout calls /auth/logout (FR-008/009)
│   │   ├── components/ConsentPrompt.tsx      # NEW: one-time per-list consent prompt (FR-022)
│   │   ├── components/PermissionManager.tsx  # EXTEND: self-serve "identify yourself / hide again" control in Sharing section (FR-023)
│   │   ├── pages/AuthPage.tsx     # EXTEND: show the password-policy message on rejection (FR-002)
│   │   └── pages/AccountPage.tsx  # NEW: dedicated account area — removal action with confirm + irreversibility notice (FR-028); home for future account-level controls
│   ├── tests/e2e/                 # + consent.spec.ts, + session-revocation.spec.ts, + pending-invitation.spec.ts; existing 8 MUST pass
│   └── package.json               # (no new runtime deps expected)
├── docker-compose.yml             # EXTEND: remove the POSTGRES_PASSWORD default — require explicit env in production (FR-006)
├── entrypoint.sh                  # (unchanged; already runs `prisma migrate deploy` then serves)
└── package.json                   # EXTEND: + audit script (npm audit --omit=dev) for release verification (FR-015)
```

**Test infrastructure note (2026-10-02)**: `scripts/ensure-test-db.mjs` (repo root) is a **dev/test-only** helper — the `pretest` self-provisioning hook in `backend/package.json` that brings up the dev-overlay Postgres, ensures the isolated `gifty_test` database, and pushes the Prisma schema before `npm test` runs. It is NOT part of the production runtime: the Docker image and `entrypoint.sh` never invoke it (production runs `prisma migrate deploy` against the live DB). The one-off fixture script `scripts/demo-phase12.mjs` was removed on 2026-10-02.

**Structure Decision**: Same single-repo, two-app layout as today. All new backend logic lives under `backend/src/` in small, single-responsibility modules (`auth/session`, `auth/rate-limit`, `auth/password-policy`, `audit`, `account`), mirroring the existing `auth/` + `common/` + `permissions/` organization. One Prisma migration introduces the three new tables and the two new `SharePermission` columns. Frontend changes are confined to the existing `services/`, `context/`, `components/`, and `pages/` directories plus one new component. No new top-level directories; no monorepo restructuring; no new runtime service (no Redis, no token broker) — the single Postgres instance already running in the deployment is the only stateful backend.

## Design Approach (summary of Phase 0 decisions — full rationale in research.md)

- **D1 — Rate limiting**: in-memory per-source + per-account counters with window TTL (no Redis; single-replica in scope, documented). Source = trusted-proxy client IP per clarification Q3.
- **D3 — Session model**: stateful `UserSession` row per login; access credential = short-lived signed token (10 min) verified against the session row; refresh credential = opaque random token, only its hash stored; rotation with reuse detection (FR-026).
- **D4/D5 — Storage & rotation**: both credentials in `HttpOnly; Secure; SameSite=Lax` cookies; frontend drops the `localStorage` token; refresh reuse revokes the session family.
- **D6 — Consent model**: `nameDisclosureConsent` on `SharePermission` (default `pending`) + `PendingInvitation` for unregistered emails, matched at registration.
- **D7 — Audit**: `AuditEvent` table, async fire-and-forget capture; never blocks the request.
- **D8 — Frontend auth**: cookie-backed, transparent 401 → `POST /auth/refresh` → retry once.
- **D9 — Boot gate**: `validateConfig()` enforces `JWT_SECRET` length + non-default + non-default `POSTGRES_PASSWORD` in production.
- **D10 — Supply chain**: `npm audit fix --omit=dev` + release-verification audit; zero high/critical findings (FR-015).
- **D11 — Trust boundary**: closed-by-default CORS, CSP with font-source allow-list, `X-Powered-By` disabled, HSTS in production.
- **D12 — Account removal**: single transaction — revoke sessions, clear claims on others' lists (items revert to `available`), delete owned lists + items + shares, discard pending invitations, record audit event.

## Complexity Tracking

> Not required — Constitution Check passed with no violations.

**Gate result (post-Phase 1)**: re-checked after data-model.md / contracts / quickstart were generated — still ✅ PASS; no violations, no Complexity Tracking entries required.

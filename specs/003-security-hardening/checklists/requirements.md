# Specification Quality Checklist: Security Hardening

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-09-27
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Notes

- Items marked incomplete require spec updates before `/speckit-clarify` or `/speckit-plan`

### Validation notes (2026-09-27)

- **Content Quality — no implementation details**: PASS. Requirements are written against
  capabilities (rate limiting, closed-by-default cross-origin policy, startup secret gate,
  session lifetime/revocation/storage, no recon signals, audit, account removal, clean supply
  chain, and explicit do-not-regress invariants). No specific library, framework, header name,
  or API endpoint is prescribed. "Session credential" and "signing secret" are used as
  domain concepts, not tied to a particular token format.
- **Testability**: PASS. Every FR maps to at least one acceptance scenario in a user story;
  FR-016/017/018/019 (do-not-regress invariants) are verifiable by the existing
  access-control / state-transition / consent-boundary suites, which SC-007 references.
- **Technology-agnostic success criteria**: PASS. SC-001–SC-007 are expressed as outcomes
  (percentages, counts, "rejected after sign-out", "0 high/critical findings") with no
  reference to specific tools, headers, or stack.
- **Edge cases**: PASS. Covers concurrent registration, throttle boundary, sign-out replay,
  allowed-origin isolation, owner-removed-while-claimed, weak-secret context split, and
  audit-on-failure.
- **Scope bounded**: PASS. Out of Scope section excludes SSO/MFA, new permission models,
  E2E encryption, public API, and native clients.
- **Clarifications**: None required — the feature is a hardening pass over an existing,
  well-understood codebase, and all ambiguities were resolved with reasonable defaults
  documented in Assumptions (thresholds operator-configurable; audit stored in-app;
  TLS/HSTS at the edge; removal cascade constrained by existing privacy invariants).

### Revision (2026-09-27, reviewer feedback)

- **Account-existence disambiguation**: US1 Scenario 4 ("already exists" on
  concurrent registration) initially read as contradicting the Scenario 1
  anti-enumeration rule. Resolved: sign-in (new **FR-020**) and share (FR-010)
  MUST hide account existence; registration MAY indicate a taken email because
  it is required UX, and is rate-limited (FR-001) against enumeration abuse.
  Added US1 acceptance Scenario 5 (sign-in outcome indistinguishability) and an
  explicit assumption documenting the policy. Matches existing implementation
  (`auth/router.ts` already returns uniform "Invalid email or password").

### Revision 2 (2026-09-27, reviewer direction)

- **Consent-gated identity disclosure (new P1 user story, now US5)**: per user
  direction, sharing no longer broadcasts a recipient's identity to all
  co-recipients immediately. Recipient is identified by email to the owner only,
  placeholder ("????") to other shared users until a one-time consent prompt on
  first open of the list; consent reveals the display name (owner + co-recipients),
  email stays owner-only. Added FR-021–FR-025 (including FR-024: claimant name on
  items follows consent state; FR-025: owner's email hidden from recipients —
  flagged as an extension of the user's rule for confirmation). Old US5–US7
  renumbered to US6–US8; SC-008, new key entity (name-disclosure consent),
  per-list consent edge cases, and assumptions added.
- **Resolved (user decisions 2026-09-27)**: Q1 = Option C — unregistered emails
  accepted as **pending invitations**, matched at registration (FR-010 updated,
  US5 scenario 7 resolved, new **Pending invitation** key entity, SC-009,
  pending-invitation lifecycle edge case, no-email-sent assumption). Q2 =
  declining recipients keep access, plus a self-serve control in the list's
  **Sharing section** to identify themselves at any time (US5 scenario 4,
  FR-023). All [NEEDS CLARIFICATION] markers resolved.

### Revalidation (2026-09-27, after /speckit-clarify Session 2026-09-27)

Re-evaluated all 16 items against the spec after five clarifications
(account-removal cascade = Q1; audit access = Q2; throttle source = Q3;
session model = Q4; password/secret strength = Q5). Result: **16/16 passing
before → 16/16 after, no checkbox toggles**.

- Q1 (FR-014): owned lists deleted; claims on others' lists cleared (revert to
  unclaimed). US7 scenario 4, edge cases, assumption updated.
- Q2 (FR-013): audit trail stored in-app, operator-inspectable only; no
  user/admin API this feature (deferred to a future admin feature). US7,
  assumption, Out of Scope updated.
- Q3 (FR-001): source = trusted-proxy client IP + per-account (email-keyed)
  sign-in failure budget. US1 scenario 6, edge case, SC-002, assumption
  updated.
- Q4 (FR-007/008/009, new FR-026): two-layer session model — short-lived
  access credential (≤1 h) + rotating refresh credential (30-day absolute
  cap, server-side revocation, reuse-detection theft revocation,
  script-unreadable storage). US4 rewritten (5 scenarios), key entity,
  SC-005, assumptions, edge cases updated. FR-009's `HttpOnly` example is
  kept as an illustrative example ("or equivalent script-unreadable
  storage"); the requirement remains capability-based, so the
  no-implementation-details items hold.
- Q5 (FR-002/FR-005): password policy = 8+ characters with composition
  rules (upper, lower, number, symbol); signing-secret minimum 256 bits by
  default; both operator-configurable. US1 scenario 3, assumption added.

No [NEEDS CLARIFICATION] or NEEDS markers introduced; FR numbering remains
contiguous (FR-001…FR-026); all new headings are limited to `## Clarifications` / `### Session 2026-09-27`.

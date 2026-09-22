<!--
Sync Impact Report
- Version change: 0.0.0 → 1.0.0
- Modified principles: Template placeholders → I. User Trust & Privacy; Template placeholders → II. List Integrity & Consent; Template placeholders → III. Test-First Delivery; Template placeholders → IV. Security by Default; Template placeholders → V. Simple, Explainable Sharing
- Added sections: Privacy & Sharing Standards; Delivery & Review Workflow
- Removed sections: None
- Deferred items: TODO(RATIFICATION_DATE): initial project adoption date is not yet assigned
-->

# Gifty Constitution

## Core Principles

### I. User Trust & Privacy
All gift list data MUST be stored and shared only with explicit user consent. Account registration, list visibility, and claim actions MUST be tied to an authenticated identity. The system MUST treat wish lists as personal data and MUST NOT expose private details to uninvited recipients without the originator's permission.

Rationale: Gift lists contain deeply personal preferences and social trust signals. Privacy violations reduce user confidence and undermine the usefulness of sharing.

### II. List Integrity & Consent
The list originator MUST control who can view, claim, or purchase items on a list. Any claim or purchase state MUST be recorded without altering the originator's private preferences or hidden context. Claiming or marking an item as purchased MUST be visible only to the appropriate users and the status, claimant or purchaser of gifts MUST NOT be revealed to the originator of the list.

Rationale: Gift sharing remains trustworthy only when ownership, consent, and visible states are accurate and controlled. Gifts and gift-givers are meant to be a surprise (unknown to the list creator).

### III. Test-First Delivery
Every feature that changes account flows, list creation, sharing, or claim logic MUST be specified and tested before implementation. Changes MUST be verified with automated tests for access control, state transitions, and consent boundaries before release.

Rationale: Social and personal data flows break trust quickly; tests are required to protect user consent and list integrity.

### IV. Security by Default
Authentication MUST be required for account access, and authorization checks MUST be enforced on every list, claim, and purchase mutation. Sensitive actions such as sharing or revealing claim status MUST validate user identity and permission at runtime, not only in the UI layer.

Rationale: Gift lists are both personal and socially shared; authorization must be enforced server-side everywhere.

### V. Simple, Explainable Sharing
The product MUST favor explicit, minimal sharing flows and clear visible state transitions. Users MUST be able to understand who can see a list, who has claimed/purchased an item without hidden or ambiguous behavior (aside from the list creator from whom claimed/purchased state and user MUST remain hidden).

Rationale: Users should understand who is claiming/purchasing which gifts, but the list creator should not be able to see this.

## Privacy & Sharing Standards

Gift list sharing MUST use explicit permission models:
- Users MUST be able to create private or shared lists according to the originator's intent.
- Shared recipients MUST receive the minimum required access to claim or purchase items.
- Claim and purchase state MUST be visible only to shared users (and not originator) without disclosing private list metadata beyond approved scope.
- Personal profile and wishlist data MUST be protected by authentication and least-privilege access controls.

## Delivery & Review Workflow

Every change affecting user accounts, gift lists, sharing, or purchase states MUST:
- Validate requirements against privacy and consent rules before coding.
- Include automated coverage for authorization, state boundaries, and user-visible behavior.
- Require review for security, disclosure risk, and consent clarity before merge.
- Verify production readiness through integration tests covering account signup, sharing, claiming, and purchased-state updates.

## Governance

This Constitution supersedes ad hoc product decisions that conflict with its rules. Any amendment MUST document the reason, preserve a clear migration path for affected users, and be approved by the project maintainer or designated review authority before release.

Changes to principles or required process MUST be versioned by semantic versioning: MAJOR for backward-incompatible governance changes, MINOR for added or materially expanded guidance, and PATCH for clarifications or non-semantic wording updates. The project MUST review compliance for every feature affecting privacy, sharing, or gifting state before deployment.

**Version**: 1.0.0 | **Ratified**: TODO(RATIFICATION_DATE): initial project adoption date is not yet assigned. | **Last Amended**: 2026-09-10

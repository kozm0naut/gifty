# Feature Specification: Password Reset

**Feature Branch**: `005-password-reset`

**Created**: 2026-10-12

**Status**: Draft

**Input**: User description: "Let's add a password reset feature"

## Clarifications

### Session 2026-10-12

- **Q: Does the feature scope include an authenticated "change password" action (while signed in), or only the unauthenticated forgot-password email flow?** → A: Only the unauthenticated forgot-password email flow. An authenticated "change password while signed in" action is out of scope for this feature.
- **Q: On a successful password reset, should all other active sessions for the account be revoked (forcing sign-in on every device)?** → A: Yes — but only after the reset token is successfully consumed and the password is truly changed, all other active sessions for the account are revoked.
- **Q: If a user with an unconfirmed email address requests a password reset, should they be allowed to set a new password without first confirming their email?** → A: Allow the reset, and a successful reset confirms the account's email (the reset proves inbox control and lifts the confirmation gate).
- **Q: After a user successfully sets a new password via the reset link, should they be automatically signed in, or directed to the sign-in page to sign in manually?** → A: Automatically signed in — a fresh session is created for the device completing the reset and the user is landed on the app home page, consistent with the existing confirmation-link flow.

## User Scenarios & Testing *(mandatory)*

<!--
  Prioritized, independently testable user journeys. Each is a standalone slice
  that can be developed, tested, and demonstrated on its own.
-->

### User Story 1 - Recover a forgotten password via email (Priority: P1)

A signed-out user who has forgotten their password requests a reset by entering the
email address they registered with. The app sends them a one-time reset link. Following
the link takes them to a page where they set a new password (and confirm it). After that,
they can sign in with the new credential, and the old password no longer works. This is
the recovery path for locked-out users and the single most common account-recovery need
for the product. Completing the reset also signs the user in on the device that completed it,
so they land on the app home page with no further step.

**Why this priority**: Without a reset path, a forgotten password is unrecoverable and
the account is a permanent dead end. This is the smallest change that makes a forgotten
password fixable, and it is the core of the feature.

**Independent Test**: Request a reset for an account, follow the emailed link, set a new
password, and sign in with it — asserting the old password is now rejected.

**Acceptance Scenarios**:

1. **Given** a signed-out user with an existing account, **When** they submit their registered email on the reset-request form, **Then** they receive a one-time reset link in their email, and the request returns a uniform success response indistinguishable from a request for an unknown email.
2. **Given** a pending reset request, **When** the recipient follows the reset link, **Then** they land on a page to set a new password, where the new value and its confirmation are both required and validated against the account's password policy (003 FR-002).
3. **Given** a valid, unexpired reset link, **When** the user submits a new password and confirmation, **Then** the password is changed, the reset link is invalidated (single-use), and the user is automatically signed in on the same device — they land on the app home page with a fresh session, while the old password is rejected for any subsequent sign-in attempt.
4. **Given** an account whose email has not been confirmed, **When** a valid reset link is consumed and a new password is set, **Then** the account's email is treated as confirmed as a result of the reset, the account is signed in with the new password, and it is not held at the confirmation gate.
5. **Given** a reset link that has already been used or has expired, **When** it is followed, **Then** the user sees the uniform invalid-link error — `400` with the pinned `I` body from contracts/api.md ("This reset link is invalid or has expired."), indistinguishable across the unknown / expired / already-consumed classes (FR-004) — no password is changed, no session is created, and they can request a fresh reset link.

---

### User Story 2 - Reset link is single-use, expiring, and non-enumerable (Priority: P1)

The reset link a user receives must be safe to treat like the credential it replaces: it
works exactly once, only within a bounded time window, and requesting one must not reveal
whether an email address is registered. This protects against link interception, replay,
and account enumeration — the same threat model the app already applies to sign-in and
account confirmation.

**Why this priority**: A leaked, guessed, or replayed reset link is a full account
takeover. The link's lifecycle and its non-disclosure behavior are inseparable from the
reset being trustworthy, so they must ship with the core flow and be independently
demonstrable.

**Independent Test**: Request a reset, then (a) reuse the same link a second time (rejected
as already used), (b) use the link after its expiry window (rejected as expired), and
(c) request a reset for an unregistered email and confirm the response is
indistinguishable from a registered one.

**Acceptance Scenarios**:

1. **Given** a reset link has already been used to set a password, **When** it is followed again, **Then** the change is rejected and no password changes; a fresh request is required to obtain a new link.
2. **Given** a reset link is followed after its validity window has elapsed, **Then** the change is rejected and no password changes, and the user can request a fresh link.

   Both rejections return the same uniform error response (FR-004), so the failure mode does not reveal whether the token was already used versus expired.
3. **Given** a reset request for an email that does not correspond to a registered account, **When** the request completes, **Then** the response (status, body, side effects, and response time) is indistinguishable from a request for a registered email, so the flow cannot be used to enumerate valid accounts.
4. **Given** a reset request, **When** the requester exceeds the allowed number of reset requests within a window, **Then** further requests in that window are rejected with a rate-limited outcome and no new reset link is issued.
5. **Given** an account with other active sessions on other devices, **When** its reset link is consumed and the password is changed, **Then** all other active sessions for that account are revoked and must sign in again, while the account remains usable with the new password.
6. **Given** two pending (un-consumed, unexpired) reset links for the same account, **When** the first is consumed to set a password, **Then** the second is rejected as invalidated, so a link the user never acted on cannot be used afterward to change the password again (sibling invalidation — FR-012).

---

### Edge Cases

- A user requests a reset, then requests another before using the first — any un-consumed, unexpired link is valid until consumed (single use), **and a successful reset immediately invalidates every other pending link for that account**, so a link the user never acted on cannot be used to overwrite a completed reset.
- Two near-simultaneous reset requests (from any sources) each issue their own valid link; neither "wins" by being newer — whichever link is consumed first completes the reset and invalidates the other (deterministic under concurrent requests via the atomic single-use claim).
- A reset link is followed on one device while the same account is actively signed in elsewhere — on successful consumption and password change, all other active sessions for that account are revoked; the resetting device is automatically signed in with the new password (a fresh session is created for it) and lands on the app home page.
- The email is valid but the account's email is unconfirmed — a successful reset also confirms the account's email (the reset proves inbox control), so the user can sign in with the new password without any further confirmation step.
- Extremely long or whitespace-heavy emails, and case-variant emails, are normalized consistently so a reset request always targets the canonical account.
- A successful reset must not alter any list, item, claim, or purchase visibility, and must not affect the list-creator's privacy guarantees.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST allow a signed-out user to request a password reset by submitting the email address associated with their account.
- **FR-002**: System MUST deliver a one-time reset link to the account's email address, and MUST return a uniform, successful-looking response to reset requests regardless of whether the email is registered, missing, or malformed. The reset email MUST contain the reset link and a notice that the link expires (the exact subject/body copy is an implementation detail; FR-005's bounded window is otherwise invisible to the user). The reset-request form MUST, after submission, display a single uniform message and MUST NOT display any distinction based on whether the email is registered (the exact UI copy is an implementation detail; it SHOULD reuse the pinned API body string for consistency). For an unregistered email the system MUST perform work of comparable cost to the registered path (e.g., a dummy hash verification) so that response time does not signal registration status (the specific equalization technique is an implementation detail; the property is that registered and unregistered requests complete in comparable time).
- **FR-003**: System MUST allow the holder of a valid, unexpired reset link to set a new password (with a confirmation value), and MUST apply the account's password policy (as defined by 003 FR-002) to the new value. A new-password attempt that fails the policy check or the confirmation match MUST NOT consume the token: the link MUST remain valid and usable for a corrected retry, so a typo or an initially-rejected password does not cost the user their reset link (the policy and confirmation checks run before the atomic single-use claim, and only a successful change consumes the link).
- **FR-004**: System MUST treat a reset link as single-use: once it has been used to change a password, it MUST be invalidated and unusable thereafter. All invalid-link outcomes on the consume endpoint (unknown token, expired, already consumed) MUST be rejected with one uniform error response indistinguishable across the classes, so the endpoint cannot be used to determine whether a presented token ever existed.
- **FR-005**: System MUST enforce a bounded validity window on every reset link and MUST reject any link presented after that window has elapsed.
- **FR-006**: System MUST store reset-link secrets only in a non-reversible form and MUST NOT log or expose the raw reset link or the new password — including in any audit `detail` record (the existing audit scrub is the enforcement mechanism, per 003 FR-013; research D8 cites this requirement as its authority).
- **FR-007**: System MUST rate-limit password-reset requests per source and per account to prevent abuse and inbox flooding. A rate-limited user MUST be able to complete a reset without operator intervention (the budget window elapses and requests succeed again), and the UI MUST present the throttled state as recoverable — it MUST NOT show a dead end (exact copy is an implementation detail; signaling the wait is explicitly allowed and does not conflict with FR-002's non-enumeration, which concerns registered-vs-unregistered only).
- **FR-008**: System MUST, immediately after a successful reset, reject the previous password and accept the new password for subsequent sign-in.
- **FR-009**: System MUST log reset-related security events to the existing audit trail, using exactly four actions with these trigger conditions: `password_reset_requested` (reset request accepted, registered or unknown email — same event shape), `password_reset_rate_limited` (throttle fired), `password_reset_success` (link consumed + password changed + other sessions revoked + email confirmed), `password_reset_failed` (an invalid-link-class token presented — unknown, expired, or already consumed). The action names and trigger conditions are pinned 1:1 in research D8 and contracts/api.md.
- **FR-010**: System MUST ensure the reset flow does not change gift-list, item, claim, or purchase visibility and does not weaken the list-creator privacy guarantee.
- **FR-011**: This feature is limited to the unauthenticated forgot-password email flow; an authenticated "change password while signed in" action is explicitly out of scope for this feature.
- **FR-012**: Immediately after a reset link is successfully consumed and the account's password is changed, the system MUST revoke all other active sessions for that account, so that every device except the one completing the reset must sign in again. In the same operation the system MUST invalidate all other pending (un-consumed) reset links for that account, so that a link the user never acted on cannot be used afterward to change the password again (a completed reset ends all pending reset state for the account).
- **FR-013**: A successful password reset MUST also confirm the account's email address (treat the account as confirmed), so that a user who lost both their password and their confirmation email is not left without a recovery path; the confirmation gate is lifted for that account as a direct consequence of the reset.
- **FR-014**: On a successful password reset, the system MUST create a fresh session for the device completing the reset and MUST sign the user in on that device (they land on the app home page — the generic app entry point, i.e. the Dashboard, as defined by 004 FR-013, rather than a specific list or feature page); the reset endpoint MUST NOT require the user to sign in again with the new password as a separate step.

### Key Entities

- **Password Reset Request**: A pending out-of-band reset for an account — the target account (by email), a reference to a single-use, non-reversibly-stored secret, the time it was issued, its expiry boundary, and its lifecycle status (issued, consumed, expired; a pending link is additionally invalidated the moment any reset for that account succeeds — see FR-012).
- **Account (User)**: The existing account entity — email and the stored (hashed) credential. Reset mutates this account's credential.
- **Outbox message**: The existing durable email record that carries the reset link to the account's inbox (reused from the existing delivery pipeline).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A locked-out user can recover access to their account — from clicking "forgot password" to signing in with the new password — in under 3 minutes once the reset email is received.
- **SC-002**: 100% of password-reset requests return a uniform response — same status and body, and comparable response time — and zero requests reveal whether a given email address is registered (no account enumeration via the flow; timing is part of indistinguishability, not a side channel).
- **SC-003**: A reset link that has been used or has expired is rejected in 100% of replay/late-presentations, and no such presentation ever changes a password.
- **SC-004**: Immediately after a successful reset, the old password is rejected and the new password is accepted in 100% of subsequent sign-in attempts (zero residual access with the old credential).
- **SC-005**: A signed-out user who completes the reset flow reaches a signed-in state on the device that completed the reset without any additional step beyond receiving and following the email (the reset response itself signs them in with the new password).
- **SC-006**: A user with an unconfirmed email who completes a password reset recovers full access to the account (sign-in works and the account is not held at the confirmation gate) in a single flow, with no separate confirmation step required.

## Assumptions

- The existing email delivery pipeline (durable outbox + pluggable mailer) is reused, including its three modes (live / capture / disabled). In **disabled** mode no reset email is delivered, so a password reset cannot be completed by email in that mode; reset requests still return a uniform response. In **capture** mode the reset link is captured for testing exactly as confirmation/invite links are.
- Reset-link secrets follow the same design as the existing account-confirmation token: generated once, stored only as a non-reversible digest, single-use, and time-bounded.
- The new password must satisfy the same policy already enforced at registration (003 FR-002).
- Reset requests are rate-limited using dedicated per-source and per-account budgets (defaults in research D4; operator-configurable via `RESET_MAX_PER_SOURCE` / `RESET_MAX_PER_ACCOUNT`), on the same rate-limit machinery as the existing sign-in and confirmation-resend budgets.
- On a successful reset, all other active sessions for the account are revoked; this is treated as a security property (a reset implies the prior credential should no longer be trusted) and applies only after the reset link is actually consumed and the password changed.
- On a successful reset, the device completing the reset is automatically signed in (a fresh session is issued as part of the reset response) and lands on the app home page — consistent with the existing confirmation-link flow (004 US2), no separate sign-in step is required.
- An authenticated "change password while signed in" action is out of scope for this feature and is not assumed to exist.
- Email addresses are normalized (trimmed, case-folded) before any reset lookup so a request always targets the canonical account.
- The feature does not touch list, item, claim, or purchase logic; it is purely an account-credential recovery path layered on the existing authentication.
- Delivery of the reset email is asynchronous through the outbox (the request returns before the email is actually dispatched), consistent with the existing invite/confirmation behavior.

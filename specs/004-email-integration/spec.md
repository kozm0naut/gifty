# Feature Specification: Email Integration

**Feature Branch**: `004-email-integration`

**Created**: 2026-10-03

**Status**: Implemented (feature `004-email-integration` complete; all tasks T001–T035 in `tasks.md` marked `[x]`)

**Input**: User description: "Integrate email-sending support into the project. Decouple the sender (a `Mailer` port) with Resend in prod and an output stub for dev/test. Use the transactional outbox. Extend `validateConfig()`. Scope: (1) account confirmation email with verification link; (2) a single invite email per (registered or unregistered) user per shared list — don't resend on repeat invitations."

## Clarifications

### Session 2026-10-03

- **Q: Is account email confirmation a hard gate (account cannot be used until confirmed) or advisory?** → A: Fully blocking — a newly registered account cannot proceed past the account confirmation page until its email address is confirmed.
- **Q: Where should invite and confirmation links land — a list-specific destination or the generic app entry point?** → A: The generic app entry point (no deep-linking to a specific list).

## User Scenarios & Testing *(mandatory)*

<!--
  Prioritized, independently testable user journeys. Each is a standalone slice
  that can be developed, tested, and demonstrated on its own.
-->

### User Story 1 - Recipient invite email (Priority: P1)

A list owner shares a list with a recipient — whether that recipient already has an
account or is an email address that does not yet. The recipient receives a single
email that tells them they've been shared a list and gives them a link to open it.
This is the app's first real way to reach a person who isn't already sitting in the
browser, and it is what turns "shared" from an invisible state into a usable one.

**Why this priority**: Sharing is the product's core value, and today a newly shared
recipient has no signal that a list is waiting for them. Delivering an invite email is
the smallest change that makes sharing actually land.

**Independent Test**: Share a list with a recipient and assert that exactly one invite
message is produced for that recipient-list pair, containing a link to the app home
page from which the recipient can reach the shared list.

**Acceptance Scenarios**:

1. **Given** an owner shares a list with a recipient who already has an account, **When** the share succeeds, **Then** one invite message is produced for that recipient addressed to that recipient's email, containing a working link to the app home page, from which the recipient can sign in and find the shared list.
2. **Given** an owner shares a list with an email address that has no account yet, **When** the share succeeds, **Then** one invite message is produced for that email address containing a working link, and no error is surfaced to the owner (the response is indistinguishable from a share to an existing account).
3. **Given** an invite message for a list is produced, **When** the recipient follows its link without an account, **Then** the recipient is guided to sign up or sign in and, once authenticated (and, if newly registered, email-confirmed), the shared list is reachable from the app entry point.

---

### User Story 2 - Account confirmation email (Priority: P1)

A person registers a new account and receives a confirmation email containing a
verification link. Following the link confirms the account's email address. Until that
happens, the account is held at an account confirmation page and cannot use the rest
of the app. This gives the app a way to prove that the person who registered actually
controls the inbox they claimed, and it is the foundation for any future out-of-band
messaging.

**Why this priority**: Confirmation is one of the two explicit scope items and it
introduces the account-scoped link/token mechanism that the rest of the email feature
depends on. It must be independently demonstrable: register → receive a link → follow
it → confirmed.

**Independent Test**: Register a new account and assert that a confirmation message is
produced with a verification link; follow the link and assert the account becomes
confirmed; attempt to use the same link a second time and assert a well-defined
result.

**Acceptance Scenarios**:

1. **Given** a new account is registered, **When** registration succeeds, **Then** a confirmation message is produced addressed to the account's email, containing a working verification link (a further confirmation may be re-requested per FR-014).
2. **Given** an unconfirmed account, **When** the recipient follows the verification link, **Then** the account becomes confirmed, the blocking confirmation gate is lifted, and the user lands at the app entry point (home page) and can navigate normally.
3. **Given** an already-confirmed account, **When** its verification link is followed again, **Then** the result is a well-defined, non-destructive outcome (no error, no duplicate confirmation, no loss of the confirmed state).
4. **Given** a newly registered, unconfirmed account, **When** the user attempts to reach any part of the app beyond the confirmation page, **Then** they are held at the confirmation page and cannot access lists, items, sharing, or claim/purchase until the email is confirmed.

---

### User Story 3 - One invite email per recipient per list (Priority: P1)

When an owner re-shares a list with a recipient they already invited to that same list,
the system does not send another email. Recipients should not be spammed with duplicate
invites for the same list no matter how many times the owner taps "share," and this rule
holds whether the recipient is a registered account or a not-yet-registered email.

**Why this priority**: This is the deduplication rule that makes invite emails safe to
send at all. Without it, every repeat share becomes a duplicate email, which is both
noisy and a cost. It is an explicit scope item and it must hold on its own.

**Independent Test**: Share a list with a recipient, then share that same list with the
same recipient again; assert that only one invite message was ever produced for that
recipient-list pair.

**Acceptance Scenarios**:

1. **Given** an owner has already shared a list with a recipient (email produced or not), **When** the owner revokes the share and then re-shares that same list with the same recipient, **Then** no additional invite message is produced (the only UI path to a re-share is via revocation first).
2. **Given** a recipient was first invited as an unregistered email and later registered an account, **When** the owner re-shares that list with the recipient, **Then** no additional invite message is produced for that recipient-list pair.
3. **Given** an owner shares one list with a recipient, **When** the owner shares a different list with the same recipient, **Then** the new list produces its own single invite message (deduplication is per list, not per recipient globally).

---

### User Story 4 - Reliable, queued delivery (Priority: P2)

Every email the app is supposed to send is queued first and delivered by a separate
process, so a send is never lost to a transient failure of the sending service and is
never blocked by the request that asked for it. If the sending service is briefly
unavailable, the message waits and is retried; if it ultimately cannot be delivered,
that is observable rather than silent.

**Why this priority**: Email is a best-effort side effect of actions the user cares
about (sharing, registering). The app must not fail those actions because of email, yet
it must not quietly lose them either. This is the delivery backbone the P1 stories
rely on to actually reach inboxes.

**Independent Test**: Enqueue a message while the sender is unavailable, then make the
sender available and assert the message is eventually delivered and the failure window
was observable (not a silent drop).

**Acceptance Scenarios**:

1. **Given** a user action that should produce an email, **When** the action completes, **Then** the action succeeds even if the sending service is temporarily unavailable.
2. **Given** a queued email whose first delivery attempt fails, **When** the sending service becomes available, **Then** the email is retried and eventually delivered (not lost).
3. **Given** a queued email that cannot be delivered, **When** delivery ultimately fails, **Then** the failure is recorded and observable to an operator, and the email is not retried indefinitely.

---

### User Story 5 - Developer and test mail capture (Priority: P3)

In development and test environments the app does not send to the live email provider.
Instead, messages are captured locally (for example, written to the process output),
so developers and automated tests can see exactly what would have been sent, addressed
to whom, without any real delivery and without any external dependency.

**Why this priority**: The existing test suites and local dev loop must remain fully
deterministic and offline. Capturing mail locally instead of sending it is what lets the
P1–P4 stories be verified in CI without network access or a live provider.

**Independent Test**: Trigger an invite and a confirmation in the test environment and
assert that the expected messages are captured locally and that nothing was sent to the
live provider.

**Acceptance Scenarios**:

1. **Given** the app runs in a test environment, **When** an invite or confirmation email is produced, **Then** the message is captured locally (observable in process output or an in-memory sink) and no message reaches the live provider.
2. **Given** the app runs in a development environment, **When** an email is produced, **Then** it is captured locally rather than delivered, and the capture is visible to the developer.

---

### User Story 6 - Operator configuration and boot validation (Priority: P3)

Email sending is controlled by operator configuration. In production, if the operator
enables email sending but the sending service is not correctly configured, the app fails
at startup rather than running and silently dropping mail. When email sending is not
enabled, the app still starts and functions, and the absence of live delivery is an
explicit, expected state rather than a hidden one. Because a confirmation email can
never arrive when sending is off, newly registered accounts are automatically confirmed
in this mode (they are not held at the confirmation gate), and a startup warning makes
both facts explicit to the operator.

**Why this priority**: The app already fails fast on weak or missing secrets; email
sending must follow the same discipline so that a misconfigured production never
pretends to deliver mail it cannot.

**Independent Test**: Start the app in production mode with email enabled but the sender
unconfigured and assert it refuses to start; start it with email disabled and assert it
starts and runs normally.

**Acceptance Scenarios**:

1. **Given** a production environment with email sending enabled, **When** the sending service is not correctly configured, **Then** the app refuses to start (fails fast at startup).
2. **Given** a production environment with email sending disabled, **When** the app starts, **Then** it starts and functions normally, with live delivery explicitly off.
3. **Given** a non-production environment, **When** the app starts without a configured live sender, **Then** it starts normally and uses local capture instead of failing.
4. **Given** the app runs with email sending disabled, **When** a new account is registered, **Then** the account is automatically confirmed at registration and is immediately usable (the blocking confirmation gate does not apply in this mode).
5. **Given** the app starts with email sending disabled, **When** the operator observes startup, **Then** a warning is produced stating that email is disabled and that new accounts are being auto-confirmed.

---

### Edge Cases

- What happens when the same recipient is invited to the same list by the owner, then
  later the recipient registers and the owner shares again? (covered by US3 — no resend)
- What happens when a confirmation link is followed after it has already been used or
  has expired? (defined, non-destructive outcome)
- What happens when the sending service is down for the entire delivery window of a
  message? (message is retried within its window and then marked failed and observable —
  never silently dropped)
- What happens when email sending is disabled in production? (app runs, live delivery is
  explicitly off, and new accounts are auto-confirmed at registration rather than held
  at the confirmation gate, with a startup warning noting this — see FR-015 and US6)
- What happens when a confirmation link is crafted, tampered with, or replayed by an
  attacker? (the link is single-use/scoped and an invalid, used, or expired confirmation
  link is rejected without leaking whether the account exists; invite links carry no
  token, so they have nothing to replay)
- What happens when the recipient of an invite is the list owner's own address? (owner
  cannot share with themselves, so no self-invite email is produced)
- What happens to accounts that existed before email confirmation was introduced? (they
  are treated as confirmed — see Assumptions)
- What happens when a new user's confirmation email is never delivered or is lost? (the
  account remains held at the confirmation page, but the user can re-request a
  confirmation email; the delivery failure is also operator-observable per US4 — see FR-014
  and Assumptions)
- What happens when a user repeatedly requests a new confirmation email? (resends are
  rate-limited per account and per time window, so the action cannot be abused to spam
  the inbox or the sending provider — see FR-014)

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST produce exactly one invite email per recipient per shared list, addressed to the recipient's email, containing a **subject** and a **human-readable body** (plain text, optionally HTML) that states the purpose of the share and includes a link that leads to the app entry point from which the recipient can reach the shared list. The sender address is operator configuration, not a feature requirement (see Assumptions).
- **FR-002**: The system MUST produce an invite email for both a recipient who already has an account and a recipient whose email has no account yet, and the owner-facing result of both MUST remain indistinguishable (no leakage of whether the email is a registered account).
- **FR-003**: The system MUST produce a confirmation email for each newly registered account, containing a **subject** and a **human-readable body** (plain text, optionally HTML) that explains the purpose of the account confirmation and includes a verification link (the token appears only in that link, per FR-010); the sender address is operator configuration (see Assumptions). Further confirmations may be re-requested per FR-014.
- **FR-004**: The system MUST confirm an account's email when the recipient follows the account's verification link, and MUST treat a repeated use of an already-used or expired link, as well as any invalid, unknown, or missing token, as a **uniform, non-error outcome indistinguishable from a successful confirmation** — the same non-error response in every case, never leaking which case occurred (per FR-010).
- **FR-005**: The system MUST NOT send a second invite email for the same recipient to the same list on any repeat share; deduplication MUST be per (recipient, list) and MUST hold whether the recipient is registered or not.
- **FR-006**: The system MUST queue every email before delivery and deliver it independently of the request that produced it, so that producing an email never blocks or fails the originating user action.
- **FR-007**: The system MUST retry delivery of a queued email on transient failure and MUST record a delivery that ultimately fails in an operator-observable way, without retrying it indefinitely. The `failed` state is **terminal** — the system MUST NOT automatically re-deliver a failed message; any manual re-queue is an operator action outside the system's delivery loop and is not a feature of this change. On process (re)start, any message left in an in-flight state (claimed but not yet resolved to `sent` or a scheduled retry) MUST be reclaimed for retry so that it is not silently lost (at-least-once delivery; SC-004).
- **FR-008**: In development and test environments the system MUST capture emails locally (observable without external delivery) and MUST NOT deliver them to the live provider.
- **FR-009**: The system MUST gate email sending behind operator configuration; in production, email enabled without a correctly configured sender MUST cause startup to fail fast.
- **FR-010**: The system MUST treat confirmation links as scoped, single-use references; an invalid, already-used, or expired confirmation link MUST be rejected without leaking whether the referenced account exists. (Invite links are a static app entry-point URL and carry no token or state.)
- **FR-011**: The system MUST record the production of and the terminal delivery outcome of every email (invite and confirmation) so that the email flow is auditable in line with the existing audit practice, and MUST NOT record the raw verification token or any provider credential in the audit record.
- **FR-012**: The system MUST block a newly registered account from proceeding past the account confirmation page until its email address is confirmed; while unconfirmed, the account MUST NOT be able to access lists, items, sharing, or claim/purchase features. This gate applies only when email sending is enabled; when email sending is disabled, newly registered accounts are auto-confirmed at registration (FR-015) and the gate does not apply.
- **FR-013**: Invite and confirmation links MUST land on the generic app entry point rather than on a specific list or feature page; the recipient reaches their destination from the entry point after signing in and, if newly registered, confirming.
- **FR-014**: The system MUST allow a user who is held at the confirmation step to re-request a new confirmation email for their account, so a lost, undelivered, or expired confirmation does not permanently lock the account out; this re-request MUST be rate-limited per account and per time window to prevent abuse, and MUST NOT be subject to the per-list invite deduplication rule (which applies only to list invitations).
- **FR-015**: When email sending is disabled, the system MUST automatically confirm newly registered accounts at registration (no confirmation email is required and the confirmation gate does not apply), and MUST emit a startup warning stating that email is disabled and that new accounts are being auto-confirmed, so the operator is never left assuming a delivery channel that is not present. In this mode the system MUST NOT produce invite emails either: a share still succeeds, but no invite email is enqueued and the recipient receives no email nudge (this is the explicit, operator-visible "email off" state).
- **FR-016**: While an account is unconfirmed (email enabled, not yet verified), the account MAY access only the pre-confirmation endpoints required for the confirmation flow: the session-bootstrap endpoint (`GET /account`), the confirmation endpoint (`GET /confirm`), the resend-confirmation endpoint (`POST /auth/resend-confirmation`), session refresh (`POST /auth/refresh`), and sign-out (`POST /auth/logout`). All other authenticated routes MUST return a stable, non-leaking denial (the same body for every gated route and every unconfirmed account).

### Key Entities

- **Queued Email (Outbox Message)**: A pending outbound email. Represents the recipient
  address, the email kind (invite or confirmation), the associated list (for invites),
  the intended link/payload, its delivery status, the number of delivery attempts, and
  its timing. The single source of truth for "what should be sent and what has been
  sent."
- **Verification Link (Account)**: A scoped, single-use reference tied to an account
  that confirms the account's email address. Carries the account it belongs to and its
  validity window.
- **Recipient (Invite Identity)**: The person invited to a list, identified by email
  (which, once registered, corresponds to an account). The deduplication key, together
  with the list, for "at most one invite email."

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of successful shares of a list to a recipient produce exactly one queued invite email for that recipient-list pair, and 0% of repeat shares of the same list to the same recipient produce an additional email.
- **SC-002**: 100% of new account registrations produce a queued confirmation email with a verification link that, when followed, confirms the account.
- **SC-003**: In development and test environments, 0% of emails are delivered to the live provider and 100% of expected emails are captured locally and assertable by automated tests.
- **SC-004**: A transient sending-service outage results in 0% emails lost within the bounded delivery window (queued emails are retried and delivered before the window ends); a message whose window is exhausted is marked `failed` and operator-observable — never silently dropped. 100% of such failures are operator-observable.
- **SC-005**: 100% of invite and confirmation emails contain a link that resolves to a valid, intended destination for the recipient.
- **SC-006**: In production, starting the app with email sending enabled but the sender unconfigured results in 100% startup refusal (fail fast), with no request served.
- **SC-007**: No originating user action (share, register) is failed or blocked because of email; the originating action completes successfully even while email is queued or the sender is down.
- **SC-008**: When email sending is enabled, every unconfirmed account is held at the confirmation step and cannot access lists, items, sharing, or claim/purchase features until its email is confirmed; 0% of unconfirmed accounts can use those features. (When email is disabled, newly registered accounts are auto-confirmed per SC-010, so there is no unconfirmed state to be held at.)
- **SC-009**: An unconfirmed user whose confirmation email was never delivered can always re-request a confirmation email and, once it is delivered and followed, complete confirmation; the re-request is rate-limited and never locks the account out permanently.
- **SC-010**: When email sending is disabled, 100% of newly registered accounts are auto-confirmed at registration and usable immediately, and 100% of such startups emit a warning stating that email is disabled and that new accounts are being auto-confirmed.

## Assumptions

- The sending service is **Resend** in production; in development and test the system uses a **local capture stub** (process output / in-memory sink) that implements the same sending interface and performs no real delivery. The sending interface ("the `Mailer` port") is the seam that isolates the rest of the system from the provider, so the provider can be swapped without touching the email flows.
- Delivery uses a **transactional outbox**: emails are written to a durable queue as part of (or immediately after) the originating operation and are drained by a separate delivery step with bounded retries, rather than being sent inline within the request.
- This feature assumes the **single-replica, single-container deployment** (feature 002); the in-process delivery loop is correct under that assumption and is **not** designed to be safe under a multi-replica deployment.
- `validateConfig()` is the existing boot gate and is the place where email-sending configuration is validated (enabled/disabled, sender configured) so production fails fast when email is enabled but misconfigured.
- A recipient is identified for deduplication by email address; once that email is registered, it corresponds to that account, so the "one invite per recipient per list" rule spans the registered/unregistered transition for the same list.
- Confirmation links are generated as opaque, scoped, single-use references **stored only in hashed form** with a validity window. Invite links are a static app entry-point URL (home page) with no token or per-list state. The system does not rely on any link being the only means of access (a recipient who is already signed in can reach their lists without a link).
- Deliverability (SPF/DKIM/DMARC on the sending domain, sender address, list-unsubscribe handling) is an operator/deployment concern configured externally, not a feature of this change.
- This feature does not introduce passwordless sign-in, per-claim/per-purchase notification emails, or bulk/marketing email — only the two message types in scope (account confirmation, list invite) plus the delivery backbone that carries them.
- The blocking confirmation gate applies only to newly created accounts; accounts that already exist when this feature is introduced are treated as confirmed (grandfathered in).
- The "no resend" rule applies **only to list invitations** (FR-005, per recipient per list); it does **not** apply to account confirmation. A user who is held at the confirmation step can re-request a confirmation email (FR-014), and that re-request is rate-limited per account and per time window to prevent inbox/provider spam.
- In development and test, accounts are confirmed by following the verification link captured by the local mail-capture stub, so the blocking gate is exercised for real rather than bypassed.
- There are three distinct sending modes, and they must not be conflated: **(a) email enabled + live sender** (production) — real confirmation emails are sent and the blocking gate (FR-012) applies; **(b) email enabled + local capture stub** (development/test) — confirmation emails are captured rather than delivered and the gate is exercised for real via the captured link (US5); **(c) email disabled** — no confirmation email is produced, new accounts are auto-confirmed (FR-015), and a startup warning notes this (US6). Mode (c) "disabled" is categorically different from mode (b) "enabled + capture".
- The existing "owner cannot see claim/purchase state" and "owner cannot share with themselves" rules are unchanged and continue to hold; this feature adds outbound mail without altering the privacy model.

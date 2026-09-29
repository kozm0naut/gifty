# Feature Specification: Security Hardening

**Feature Branch**: `security-hardening`

**Created**: 2026-09-27

**Status**: In Progress

**Input**: User description: "Let's make a spec for security hardening based on everything we've gone over, including what not to regress on"

## Clarifications

### Session 2026-09-27

- Q: When a user requests removal of their account, what happens to the lists they own and to any items they had claimed on other people's lists? (FR-014) → A: Option A — the user's owned lists (and their items) are deleted, and any claims they made on other users' lists are cleared so those items revert to unclaimed (`available`).
- Q: Who is allowed to read the audit trail, and through what mechanism? (FR-013) → A: Option D — no API in this feature; the audit trail is satisfied by events existing in the app's own data store (inspectable by the operator directly). A read/query/export API and an admin access level + panel are deferred to a future admin feature.
- Q: How should the system identify the "source" that the throttle/lockout counters are keyed to? (FR-001) → A: Option B — trusted-proxy mode: use the client IP forwarded by the edge proxy when present (falling back to the direct TCP peer), and additionally enforce a per-account (email-keyed) failure budget on sign-in so brute force is throttled even when the source IP rotates.
- Q: What maximum lifetime should a session credential have before it is automatically rejected? (FR-007) → A: Option D — two-layer session model: a short-lived access credential (≤1 hour) used for API calls, plus a rotating refresh credential backed by a server-side session with a 30-day absolute cap; refresh tokens rotate on every use with reuse-detection revocation (FR-026), and the refresh credential is stored script-unreadably (e.g., an `HttpOnly` cookie), replacing the current 7-day, non-revocable, `localStorage` JWT.
- Q: What should the minimum password strength be for new accounts? (FR-002) → A: Option D — 8+ characters with composition rules: at least one uppercase, one lowercase, one number, and one symbol; the rejection message describes these requirements. Bundled signing-secret gate (FR-005): default minimum strength 256 bits (32 bytes), operator-configurable.

## User Scenarios & Testing *(mandatory)*

<!--
  User stories are PRIORITIZED as user journeys ordered by importance.
  Each story is INDEPENDENTLY TESTABLE — implementing just one still yields
  a viable, safer product.
-->

### User Story 1 - Stop credential abuse at the door (Priority: P1)

An attacker can no longer brute-force a user's password at network speed, nor
mass-create throwaway accounts, because the authentication entry points throttle
repeated attempts and reject weak passwords.

**Why this priority**: The login and registration entry points are the only
unauthenticated surface. Without throttling and password policy, every other
control can be undermined by a simple credential attack. This is the most
exploitable gap identified.

**Independent Test**: Repeated failed logins from a single source are throttled
and eventually locked out; a registration with a weak password is rejected with
a clear message. Deliverable is a login/register flow that resists automated
credential guessing and low-effort account creation.

**Acceptance Scenarios**:

1. **Given** an attacker issuing a large number of failed logins from one source, **When** the attempts exceed a configured threshold within a window, **Then** further attempts from that source are refused until the window resets, and the refusal is indistinguishable to the client from a normal failed attempt (no account-existence hint).
2. **Given** a legitimate user with the correct password, **When** they log in within the normal attempt budget, **Then** they are authenticated normally and the throttle does not interfere.
3. **Given** a new user registering, **When** they submit a password below the minimum strength — fewer than 8 characters, or missing any required class (uppercase, lowercase, number, symbol) — **Then** the request is rejected with a user-facing message describing the requirement, and no account is created.
4. **Given** two concurrent registrations for the same email, **When** both are processed, **Then** exactly one account is created and the other is cleanly rejected as "already exists" (no internal error surfaced). This registration-time "already exists" signal is **intended and required** — registration is the self-service creation flow where the user must be told to sign in instead — and is deliberately distinct from the anti-enumeration rule on the sign-in and share flows (FR-010, FR-020). It remains subject to the registration rate limit (FR-001) so it cannot be used for large-scale enumeration.
5. **Given** an attacker probing the sign-in endpoint with candidate emails, **When** they submit a sign-in for an email that is not registered versus one that is, **Then** the response (status, message, and timing) is indistinguishable, so the sign-in path reveals nothing about which accounts exist.
6. **Given** an attacker issuing failed sign-ins for a specific account from many different source IPs, **When** that account's per-account failure budget is exhausted within the window, **Then** further sign-in attempts for that account are refused until the window resets, regardless of source-IP rotation.

---

### User Story 2 - Secure defaults at the trust boundary (Priority: P1)

A visitor who has a malicious website open can no longer read the app's data via
a cross-origin request, and the browser is given strong directives that block
injected content. By default the app is closed to other origins unless the
operator explicitly allows one.

**Why this priority**: An open cross-origin policy plus a missing content
policy together let a compromised or merely visited third-party site read the
victim's authenticated data or inject content. Defaulting to closed is the
safe baseline and protects every other flow.

**Independent Test**: A page on a different origin cannot successfully read an
authenticated response from the app, while the app's own origin works normally.
The served app carries strong browser-security directives. Deliverable is a
boundary that is closed by default and hardened against injected content.

**Acceptance Scenarios**:

1. **Given** a request from an origin that is not explicitly allowed, **When** it makes a cross-origin request to the authenticated API, **Then** the response is not exposed to that origin (the cross-origin read fails).
2. **Given** an operator who configures a specific allowed origin, **When** a request is made from that origin, **Then** the cross-origin read succeeds.
3. **Given** the app's own page, **When** it loads, **Then** the served document carries browser-security directives that restrict the sources of content, scripts, and styles to the app's own origin plus the explicitly permitted font source.

---

### User Story 3 - Never boot with a weak or missing secret (Priority: P1)

An operator who deploys the app without a strong signing secret, or with a known
default credential, is stopped at startup with a clear, actionable message —
the app refuses to serve rather than run insecurely.

**Why this priority**: A weak or default secret/credential silently defeats all
authn/authz and database isolation. Failing fast at boot (rather than serving
with a guessable secret) is the only reliable guarantee, and it already matches
the project's "security by default" principle for the signing secret — this
extends the same guarantee to the database credential and to secret strength.

**Independent Test**: Starting the app with a missing or weak signing secret, or
with the default database credential in a production context, results in a
non-zero startup failure with a clear message, and the app does not begin
serving. Deliverable is a startup gate that makes insecure configs impossible
to run.

**Acceptance Scenarios**:

1. **Given** the app is started in a production context with no signing secret set, **When** it reaches the startup gate, **Then** it exits with a clear error and does not serve.
2. **Given** the app is started with a signing secret that is present but below the minimum strength, **When** it reaches the startup gate, **Then** it exits with a clear error and does not serve.
3. **Given** the app is started in a production context using the default (well-known) database credential, **When** it reaches the startup gate, **Then** it exits with a clear error and does not serve.
4. **Given** the app is started in a production context with a strong signing secret and an explicit, non-default database credential, **When** it reaches the startup gate, **Then** it starts and serves normally.

---

### User Story 4 - Shrink the blast radius of a stolen session (Priority: P2)

If a session credential is captured, its usefulness is limited: the access
credential expires within an hour, the whole session is hard-capped at 30
days, the user's sign-out invalidates everything on the server side, and the
refresh credential rotates so a stolen one cannot be replayed. Credentials are
stored where injected scripts cannot read them.

**Why this priority**: Long-lived, non-revocable, script-readable credentials
turn any single content-injection bug into a full account takeover that lasts
for days. Reducing lifetime, adding server-side revocation, and hardening
storage all directly cut that window and that reach.

**Independent Test**: A captured access credential stops working within its
bounded lifetime and the whole session at 30 days; a captured refresh
credential cannot be used twice; signing out revokes everything immediately;
and no credential is readable by page scripts. Deliverable is a session model
whose compromise is time-boxed, revocable, and theft-detecting.

**Acceptance Scenarios**:

1. **Given** a valid access credential, **When** its bounded lifetime (default 1 hour or less) elapses, **Then** it is no longer accepted for API calls; if the session is still alive (within the 30-day cap and not revoked), the refresh flow issues a fresh access credential and a rotated refresh credential.
2. **Given** a session whose 30-day absolute cap has elapsed, **When** any credential for it is presented, **Then** it is rejected and the user must authenticate again.
3. **Given** a signed-in user, **When** they sign out, **Then** their session is revoked server-side and neither the access credential nor the refresh credential is accepted, even before their natural expiry.
4. **Given** a refresh credential that has already been rotated to a successor, **When** it is presented again (a replay of a stolen token), **Then** the server treats it as a theft signal and revokes the user's entire session family, forcing re-authentication.
5. **Given** a page on the app, **When** a script attempts to read the session's refresh credential from script-accessible storage, **Then** it cannot (the refresh credential is not exposed to page scripts).

---

### User Story 5 - Recipients choose when their identity is revealed (Priority: P1)

When a list owner shares a list with someone, that person's identity is not
automatically broadcast to the other people the list is shared with. The owner
sees the email address they used to invite. Everyone else sees an unidentified
placeholder. When the recipient first opens the shared list, a one-time prompt
asks whether they are comfortable revealing their display name to the other
shared users of that list. Only after they agree does their name appear — and
their email remains hidden from everyone except the owner who invited them.

**Why this priority**: Disclosing a person's identity to a social circle is a
consent decision, and the constitution requires explicit user consent before
identity is shared. The current flow discloses the recipient's name to every
co-recipient the moment the share is sent, removes the recipient's control
over that disclosure, and (for unregistered emails) leaks account existence.

**Independent Test**: Share a list with a recipient and verify co-recipients see a placeholder (no name, no email) until the recipient opens the list and consents; after consent, the display name is visible to the owner and co-recipients, and the email is visible to the owner only.

**Acceptance Scenarios**:

1. **Given** the owner has shared a list with a recipient, **When** another shared user views the recipient list, **Then** the recipient appears as an unidentified placeholder (e.g., "????") with no display name and no email; the owner's own sharing view identifies the recipient by the email used to invite them.
2. **Given** a recipient who has not yet consented to name disclosure on this list, **When** they open the shared list for the first time, **Then** a one-time consent prompt is shown asking whether they are comfortable revealing their display name to the other shared users of this list.
3. **Given** a recipient who consents, **When** they respond affirmatively, **Then** their display name becomes visible in the owner's sharing view and in the other shared users' recipient lists, while their email remains visible only to the owner.
4. **Given** a recipient who declines, **When** they respond negatively, **Then** they remain a full shared recipient (view and claim still work), their name continues to appear as a placeholder to other shared users, and they may change their choice later at any time — including via a self-serve control in the list's Sharing section to identify themselves (reveal their display name) or hide it again — with revocation returning them to the placeholder.
5. **Given** a recipient who has claimed an item but has not consented to name disclosure on that list, **When** another shared user views the item, **Then** the claim state is visible but the claimant is shown as a neutral placeholder instead of a name.
6. **Given** the list owner, **When** any shared recipient views the list, **Then** the owner's email is never shown to the recipient — only the owner's display name.
7. **Given** the owner shares a list to an email with no registered account, **When** the share is submitted, **Then** the share is accepted with an outcome indistinguishable from a share to a registered recipient and is held as a pending invitation; when the person registers with that email, the pending invitation surfaces and the list becomes visible to them as a full shared recipient, entering the consent flow (scenario 2) on first open.

---

### User Story 6 - Stop leaking reconnaissance signals (Priority: P2)

An attacker probing the app learns nothing about which accounts exist, which
server framework is in use, or internal implementation details from error
responses.

**Why this priority**: Account existence, framework fingerprinting, and internal
error text all lower the cost of the attacks in User Story 1. Removing these
signals is cheap and compounds the other controls.

**Independent Test**: Probing with a known and an unknown account yields
indistinguishable outcomes; error responses for internal failures expose no
implementation detail; framework-identifying headers are absent.

**Acceptance Scenarios**:

1. **Given** an owner sharing a list to a recipient email that is not a registered account, **When** the share is submitted, **Then** the outcome and message are indistinguishable from sharing to a registered recipient (no "this email is not a user" signal): the share is accepted and held as a pending invitation (User Story 5, scenario 7), so the response never reveals whether the email is registered.
2. **Given** an internal (server-side) failure occurs while handling a request, **When** the response is returned in a production context, **Then** it carries a generic message and no stack trace, file path, or internal library detail.
3. **Given** any response from the app, **When** it is inspected, **Then** it does not advertise the application framework or server name.

---

### User Story 7 - Provide an audit trail and a data lifecycle (Priority: P2)

Security-relevant events are recorded with who did what to what, and a user can
leave the platform — their account and associated data can be removed.

**Why this priority**: Without an audit trail, incidents cannot be investigated
and abuse cannot be detected. Without a way to leave, the app holds personal
data it cannot be asked to delete. Both are standard production/compliance
expectations.

**Independent Test**: A sequence of sign-in, share, claim, and delete actions
produces a queryable, attributable record; a user can request account removal
and their personal data is no longer accessible afterward.

**Acceptance Scenarios**:

1. **Given** a user who signs in, shares a list, has a recipient claim an item, and then deletes the list, **When** the audit trail in the data store is reviewed, **Then** each security-relevant action is present with an attributable identity, a target, an outcome, and a timestamp. (No user-facing or admin-facing API for the trail is in scope for this feature; a future admin feature may add one.)
2. **Given** a signed-in user, **When** they request account removal, **Then** their account can no longer authenticate and their personal data is no longer accessible through the app.
3. **Given** a list owner whose account is removed, **When** they had items claimed by recipients, **Then** the platform's existing visibility rules still hold (the removal does not newly expose claim/purchase state to the removed owner or to unintended parties).
4. **Given** a user who owns lists and has also claimed an item on someone else's list, **When** they request account removal, **Then** their owned lists and items are deleted, and the item they claimed on the other person's list reverts to unclaimed (`available`) with the claimant identity cleared, while the rest of that list and its visibility rules are unchanged.

---

### User Story 8 - Keep the software supply chain clean (Priority: P3)

The set of software the app ships is free of known high- or critical-severity
vulnerabilities.

**Why this priority**: Known vulnerable components are a standing, low-effort
attack surface. Keeping them out is table stakes for production, though it is
lower urgency than the active-abuse controls above.

**Independent Test**: A dependency audit of the production runtime reports zero
high- or critical-severity findings.

**Acceptance Scenarios**:

1. **Given** the production set of software the app runs, **When** it is audited for known vulnerabilities, **Then** no high- or critical-severity finding is reported.
2. **Given** a future dependency update that introduces a known high- or critical vulnerability, **When** the audit is run as part of release verification, **Then** the release is blocked until the finding is resolved or explicitly accepted.

---

### Edge Cases

- **Concurrent first-time registrations** of the same email: exactly one account wins; the loser gets a clean "already exists", never an internal error.
- **Throttle boundary**: a user who is throttled by an attack from a shared network address must not be permanently locked out; the limit resets after the window and does not accumulate across unrelated users beyond the shared-source cap.
- **Source-IP rotation**: failed sign-ins against a specific account MUST accumulate toward that account's per-account failure budget even when each attempt arrives from a different source IP, so rotation cannot evade lockout; unrelated accounts sharing a source IP are not locked out by each other's failures beyond the source-level cap.
- **Sign-out then replay**: a revoked session credential presented after sign-out (even within its lifetime) must be rejected.
- **Refresh-token replay**: presenting a refresh credential that has already been rotated (stale) must be treated as a theft signal and must revoke the user's entire session family, forcing re-authentication.
- **Concurrent refresh-token use**: if the same still-valid refresh token is presented more than once (e.g., two simultaneous refresh requests), at most one must succeed; the other must be rejected and the session family must be revoked, as if a stale replay had occurred.
- **Cross-origin with allowed origin**: allowing one origin must not open the API to all others.
- **Owner removed while items are claimed**: removal must not violate the existing rule that claim/purchase state and identity stay hidden from the originator.
- **Weak secret in a non-production context**: the gate must distinguish contexts so that local development is not blocked by production-only rules, while production never runs with a weak/default secret.
- **Audit under failure**: a rejected or failed security-relevant action (e.g., a failed login, a denied share) is still recorded as an event, not only successful ones.
- **Consent is per-list**: a recipient who consented to name disclosure on one list is still unidentified (placeholder) on another list where they have not consented.
- **Declined consent + claiming**: a recipient who declined may still claim items; the claim state is visible to co-recipients but the claimant is shown as a placeholder.
- **Re-share after revocation**: if the owner removes a recipient and later re-invites them, the previous consent does not carry over — the recipient must consent again.
- **Owner removed while items are claimed (consent interaction)**: account removal must not newly reveal any recipient's display name or email to parties who had not seen it under the consent rules.
- **Removal while a recipient on others' lists**: when a user's account is removed, any `SharePermission` rows in which they are the **recipient** (on other users' lists) MUST be deleted — their display name, email, and consent state no longer appear on those lists, and nothing new is revealed to the remaining viewers (FR-014).
- **Pending invitation lifecycle**: if the owner revokes the share or deletes the list before the person registers, the pending invitation is discarded and nothing surfaces at registration; a pending invitation grants no access until it is matched to a registered account.
- **Account removal with pending invitations outstanding**: if the owner removes their account while pending invitations on their lists await registration, the owned lists are deleted and their pending invitations are discarded; a later registration with an invited email surfaces nothing for that list.
- **Sign-out on an already-revoked or expired session**: the sign-out action is idempotent — it returns the same "no active session" outcome (401, stable message) as a fresh sign-out would, with no error and no side effects beyond what the prior revocation already caused.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST limit the rate of authentication attempts (login and registration) per source so that automated credential guessing is throttled, and MUST apply lockout after a bounded number of failures within a bounded window. The "source" for these counters MUST be the client IP as forwarded by the edge proxy (trusted-proxy mode, falling back to the direct TCP peer), and for sign-in the system MUST additionally enforce a per-account (email-keyed) failure budget so that a rotating source IP cannot evade lockout. Because the registration endpoint returns a distinct "already exists" outcome (per FR-020's registration carve-out) that reveals account existence, the per-source registration budget MUST be **strictly tighter** than the per-source sign-in budget (default: ≤ 3 failures / 15 min for registration vs. ≤ 10 failures / 15 min for sign-in; both operator-configurable). The per-account budget applies to sign-in only.
- **FR-002**: The system MUST enforce a minimum password strength for new accounts — default policy: at least 8 characters including at least one uppercase letter, one lowercase letter, one number, and one symbol — and MUST reject passwords below that threshold with a user-facing requirement message describing the policy.
- **FR-003**: The system MUST treat the cross-origin policy as closed by default in production, and MUST allow a cross-origin read only for origins the operator has explicitly permitted.
- **FR-004**: The system MUST serve the app with browser-security directives that restrict content, scripts, and styles to the app's own origin plus the explicitly permitted font source, and MUST permit the permitted font source to load.
- **FR-005**: The system MUST refuse to start serving in a production context when the session-signing secret is missing, below a minimum strength (default: at least 256 bits / 32 bytes), or a known default value. When the startup gate refuses to start (this requirement or FR-006), the error message MUST identify **which** configuration value failed (e.g. `JWT_SECRET`, the database credential) and **what must change** (e.g. "must be at least 32 characters", "must not be the known default"), so that an operator can remediate without consulting documentation.
- **FR-006**: The system MUST refuse to start serving in a production context when the database credential is a known default value, requiring an explicit operator-supplied credential.
- **FR-007**: The system MUST authenticate API calls with a short-lived access credential whose lifetime is bounded (default 1 hour or less), and MUST cap the overall user session at a hard absolute lifetime (default 30 days), after which the user must authenticate again.
- **FR-008**: The system MUST back sessions server-side and MUST invalidate the user's refresh credential upon sign-out, such that no credential for that session is accepted after sign-out.
- **FR-009**: The system MUST store the session's refresh credential so it is not readable by page scripts (e.g., an `HttpOnly`, `Secure`, `SameSite` cookie or equivalent script-unreadable storage), and MUST NOT persist session credentials in script-readable storage such as `localStorage`.
- **FR-010**: The system MUST return indistinguishable outcomes for sharing to a registered recipient versus an unregistered recipient, so that account existence cannot be inferred; a share to an unregistered email MUST be accepted and held as a pending invitation that is matched to the account when the person registers with that email.
- **FR-011**: The system MUST return a generic message for internal (server-side) failures in a production context and MUST NOT disclose stack traces, file paths, or internal library details.
- **FR-012**: The system MUST NOT advertise the application framework or server name in responses.
- **FR-013**: The system MUST record an attributable audit event (identity, action, target, outcome, timestamp) for each security-relevant action, including failed or denied attempts, covering at minimum: authentication (success and failure, including rate-limited / `429` refusals), session revocation (sign-out and refresh-token-reuse / theft), list share, list revoke, item claim, item purchase, item revert, and account removal. Audit records MUST NOT contain credentials, tokens, passwords, request payloads, or other sensitive data — only the attributable metadata (identity, action, target, outcome, timestamp, source IP). Audit events MUST be retained for a minimum of **5 years** from their creation timestamp; automatic pruning before that window is prohibited. In this feature the audit trail MUST be stored in the app's own data store and inspectable by the operator directly; a user-facing or admin-facing audit query/export API is NOT part of this feature (deferred to a future admin feature).
- **FR-014**: The user MUST be able to request removal of their account, after which the account can no longer authenticate and the user's personal data is no longer accessible through the app. Removal MUST delete the user's owned gift lists (and their items), and MUST clear any claims the user had made on items in other users' lists, reverting those items to the unclaimed state. Removal MUST also delete any `SharePermission` rows in which the user is the **recipient** on another user's list, so that the user's display name, email, and consent state no longer appear on those lists and no new identity is revealed to the remaining viewers.
- **FR-015**: The production runtime's set of software MUST contain no known high- or critical-severity vulnerabilities, and release verification MUST detect and block new such findings unless explicitly accepted.
- **FR-016**: The system MUST NOT regress the owner-privacy invariant: the list originator MUST still be unable to see the claim/purchase state or the identity of the claimant for items on a list they own, in every response path that returns items.
- **FR-017**: The system MUST NOT regress the claim-integrity invariant: a claim or purchase transition MUST remain atomic such that concurrent attempts resolve to exactly one winner, and a purchase MUST remain restricted to the current claimant.
- **FR-018**: The system MUST NOT regress deny-by-default authorization: every list, claim, and purchase mutation MUST still require authentication and an explicit, server-side permission check anchored to the authenticated identity, never to client-supplied identity.
- **FR-019**: The system MUST NOT regress the "owner cannot claim" rule: the list originator MUST still be denied the claim action on their own list while recipients may claim.
- **FR-020**: The sign-in flow MUST return an identical outcome and message whether the supplied email is not registered or the password is incorrect, so that account existence cannot be inferred from the sign-in endpoint. The registration flow, by contrast, MAY and SHOULD indicate that an email is already registered because that is required for the user to know to sign in instead; that signal remains subject to the registration rate limit (FR-001).
- **FR-021**: When a list is shared with a recipient, the recipient MUST be presented to other shared users as an unidentified placeholder until the recipient consents to reveal their display name for that list, and the recipient's email MUST be visible only to the owner who invited them.
- **FR-022**: When a recipient first opens a shared list for which they have not yet consented to name disclosure, the app MUST present a one-time consent prompt asking whether they are comfortable revealing their display name to the other shared users of that list.
- **FR-023**: A recipient MUST be able to consent to or decline name disclosure on a per-list basis and MUST be able to change that choice later at any time — including via a self-serve control in the list's Sharing section to identify themselves (reveal their display name) or hide it again; consent MUST make their display name visible to the owner and to the other shared users of that list, and revocation MUST return them to the placeholder, in neither case affecting their ability to view or claim items.
- **FR-024**: The claimant identity displayed on an item MUST follow the claimant's consent state on that list; if the claimant has not consented to name disclosure, other shared users MUST see a neutral placeholder instead of a name.
- **FR-025**: The list owner's email MUST NOT be exposed to shared recipients; recipients MUST see only the owner's display name.
- **FR-026**: The system MUST rotate the refresh credential on every refresh, and MUST treat presentation of a previously rotated (stale) refresh credential as a theft signal that revokes the user's entire session family and forces re-authentication.
- **FR-027**: When a session is terminated — whether by expiry (FR-007), sign-out (FR-008), or refresh-token-reuse revocation (FR-026) — the app MUST end the user's authenticated session and return the user to the sign-in flow, rather than leaving them on an authenticated page that can no longer act. If the termination was triggered by refresh-token reuse (a theft signal, FR-026), the app MUST additionally present a notice that the session was ended for security reasons and recommend that the user change their password.
- **FR-028**: Account removal (FR-014) MUST be an explicit, user-initiated action surfaced in a dedicated account area of the user's own UI. Because removal is destructive and irreversible, the app MUST require the user to confirm the action before it is performed, and MUST communicate prior to confirmation that it is final — that their owned lists and items will be permanently deleted and their claims on other users' lists will be cleared. No grace period, undo, or soft-delete is provided.

### Key Entities *(include if feature involves data)*

- **Session credential**: The bearer that proves an authenticated identity to the API. Under this feature it becomes a two-layer model: a short-lived access credential (≤1 hour) for API calls plus a rotating refresh credential backed by a server-side session (30-day absolute cap), stored script-unreadably and revocable on sign-out or refresh-token reuse.
- **Account**: A registered user identity (email, display name, password). Gained a strength requirement on creation and a removal path.
- **Audit event**: A record of a security-relevant action with attributable identity, target, outcome, and time. New in this feature.
- **Signing secret**: The operator-supplied secret used to sign session credentials. Gained a minimum-strength and no-default guarantee at startup.
- **Database credential**: The operator-supplied credential for the data store. Gained a no-default guarantee at startup.
- **Allowed origin**: An explicitly permitted cross-origin source. New in this feature.
- **Name-disclosure consent**: A per-list consent state recording whether a recipient has agreed to reveal their display name to the other shared users of that list. New in this feature.
- **Pending invitation**: A share to an email with no registered account, held until the person registers with that email and the invitation is matched to the new account. New in this feature.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of security-relevant actions (authentication success/failure, session revocation, share, list revoke, claim, purchase, revert, account removal) produce an attributable audit record.
- **SC-002**: An automated credential-guessing attempt from a single source cannot sustain more than the configured per-window threshold of successful probes; attempts beyond the threshold are refused until the window resets — and the same holds for a per-account failure budget when the attacker rotates source IPs.
- **SC-003**: A page on a non-permitted origin achieves 0 successful authenticated reads of the app's data, while a permitted origin achieves the expected reads.
- **SC-004**: In a production context, the app fails to serve (non-zero startup, no HTTP service) in 100% of cases where the signing secret is missing/weak/default or the database credential is the known default.
- **SC-005**: A captured access credential is rejected after its bounded lifetime (≤1 hour by default) and a session is rejected after its 30-day absolute cap; a stolen refresh credential cannot be used twice (reuse revokes the session family); signing out rejects both credentials immediately; and no session credential is readable by page scripts.
- **SC-006**: The production dependency audit reports 0 high- or critical-severity findings.
- **SC-007**: The owner-privacy invariant, the claim-integrity invariant, and deny-by-default authorization remain 100% intact (verified by the existing access-control, state-transition, and consent-boundary test suites) after all hardening changes.
- **SC-008**: 100% of shared recipients appear as an unidentified placeholder to co-recipients until they consent to name disclosure for that list; 0 occurrences of a recipient's email in any view other than the owner's; 0 occurrences of the owner's email in any recipient-visible view — verified across all endpoints that return recipient or owner identity (notably `GET /lists`, `GET /lists/:id`, and the item-list responses), enforced by the shared identity decorator.
- **SC-009**: A pending invitation for an unregistered email surfaces for the person in 100% of cases when they register with that email, and the share's acceptance is indistinguishable in 100% of cases from a share to a registered recipient.

## Assumptions

- The existing authentication (email/password + signed session credential) model is retained; this feature hardens it rather than replacing it with a different identity provider. The current single 7-day, non-revocable, `localStorage`-stored JWT is replaced by the two-layer model of FR-007–FR-009 and FR-026 (short-lived access credential + rotating, server-side-revocable refresh credential) — a hardening of the same model, not a new identity provider.
- The app is served over HTTP(S) at a single operator-controlled origin; TLS termination and HSTS are handled at the edge in front of the container, and this feature assumes a reverse proxy or load balancer can supply the forwarded-host context for same-origin detection and the forwarded client IP (trusted-proxy mode) for rate-limit source identification. The script-unreadable session storage (FR-009) uses a `Secure` cookie that relies on this edge TLS termination.
- "Production context" is distinguishable from a local development context (an environment signal), and the startup gate applies its strict rules to the production context.
- Rate limiting and lockout thresholds are operator-configurable with sensible defaults; the exact numeric values are an implementation/tuning detail, not a product decision.
- **Single-replica deployment**: rate-limit and lockout counters are kept in per-process memory, so this design assumes a **single replica** of the app. Running multiple app replicas would require a shared counter store (e.g., Redis) and is out of scope; per-process counters on multiple replicas would under-count and weaken the throttle.
- **Password and secret strength (clarified, Session 2026-09-27)**: the default minimum password policy is 8+ characters including at least one uppercase, one lowercase, one number, and one symbol (FR-002); the default signing-secret minimum strength is 256 bits (32 bytes) (FR-005). Both remain operator-configurable.
- The audit trail is stored within the app's own data store and is accessible to the operator by direct inspection; no user-facing or admin-facing audit API, and no shipping to an external sink, is in scope for this feature. A future admin feature (admin access level + panel) may add a query/export API over this data.
- Account removal is confirmed (clarification, Session 2026-09-27) to delete the user's owned lists and items and to clear their claims on other users' lists (items revert to unclaimed); the removal must not expose claimant identity (FR-016/FR-017).
- This feature does not add new user-facing sharing flows; it only removes insecure defaults and reconnaissance signals and adds auditing and data lifecycle.
- **Account-existence policy (disambiguation)**: Hiding account existence is required on the **sign-in** (FR-020) and **share** (FR-010) flows, to defeat credential guessing and enumeration. On the **registration** flow, indicating that an email is already registered is intentional and required UX (so the user knows to sign in) and is not treated as a leak; that signal is still rate-limited (FR-001) to prevent large-scale enumeration.
- **Name-disclosure defaults**: consent is per-list and revocable (FR-023); a declining recipient keeps full view/claim ability; the unidentified placeholder is a neutral marker (e.g., "????") carrying no identifying attributes; the consent prompt appears once per list on first open and is not repeated unless the recipient changes their choice.
- **Owner-email extension**: FR-025 extends the "email stays hidden except from the inviter" principle to the owner's own email, which the current implementation exposes to recipients (`GET /lists` / `GET /lists/:id` include the owner's email). Flagged for confirmation as an extension of the requested rule.
- **Pending invitations are discovered at registration, not by email**: the app does not send email; a pending invitation is surfaced only when the person registers with the invited email. Expiration of pending invitations is an implementation/tuning detail, not a product decision.

## Out of Scope

- Introducing a different identity provider (SSO/OAuth) or multi-factor authentication.
- A role/permission model beyond the existing owner/shared-recipient distinction.
- End-to-end encryption of list contents at rest.
- A public API or third-party integrations.
- A user-facing or admin-facing audit-trail query/export API or admin panel (deferred to a future admin feature; the data is still recorded per FR-013 in this feature).
- Persisting rate-limit or lockout state across app restarts: counters are in-memory, per-process, and reset when the app restarts or is redeployed. A shared, durable store (e.g., Redis-backed) is the documented promotion path if high-availability / multi-replica is ever in scope (single-replica assumption).
- Mobile-native clients.

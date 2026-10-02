# Data Model: Security Hardening

**Feature**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md) | **Date**: 2026-09-27

This feature adds three new entities and two columns on an existing one. All
changes land in **one** Prisma migration. Existing entities (`User`,
`GiftList`, `GiftItem`) keep their shapes; only relationship behavior around
removal changes (see D12).

## Entity Overview

```text
User 1───* UserSession            (NEW: one row per active login)
User 1───* AuditEvent             (NEW: actor reference, nullable for anonymous failures)
GiftList 1───* PendingInvitation  (NEW: share to unregistered email)
SharePermission *───1 GiftList    (EXTENDED: + recipientEmail, + nameDisclosureConsent)
GiftItem *───0..1 User           (UNCHANGED: claimant FK; removal clears it)
```

## New Entities

### UserSession (NEW)

The server-side session backing the two-layer credential model (research D3).

| Field | Type | Notes |
|---|---|---|
| `id` | `String` (uuid) | PK; the `sid` claim inside the access JWT |
| `userId` | `String` | FK → `User.id`, `onDelete: Cascade` |
| `refreshTokenHash` | `String` | SHA-256 of the **current** refresh token (raw token never stored) |
| `previousRefreshHash` | `String?` | SHA-256 of the last rotated-out token — the reuse-detection tripwire (FR-026) |
| `issuedAt` | `DateTime` | default `now()` |
| `lastRefreshAt` | `DateTime` | default `now()`; sliding anchor for the 30-day cap |
| `expiresAt` | `DateTime` | hard cap (default 30 days); after this the session is dead (FR-007) |
| `revokedAt` | `DateTime?` | set on sign-out or reuse-detection; a non-null value makes every credential for this session invalid (FR-008) |
| `createdAt` / `updatedAt` | `DateTime` | `now()` / `@updatedAt` |

Indexes: `@@index([userId])`, `@@index([refreshTokenHash])`, `@@index([expiresAt])`.

State transitions:

```text
active ──sign-out──────────────► revoked
active ──expiresAt elapsed─────► expired (treated as revoked on read)
active ──refresh───────────────► active (new refreshTokenHash; old → previousRefreshHash)
active ──stale token replayed──► revoked   (FR-026 theft signal; entire family killed)
```

### AuditEvent (NEW)

Append-only security-relevant event record (research D7). No API exposes it
in this feature (clarification Q2).

| Field | Type | Notes |
|---|---|---|
| `id` | `String` (uuid) | PK |
| `actorUserId` | `String?` | FK → `User.id`, `onDelete: SetNull` — nullable because **failed/denied** auth attempts have no (or a to-be-deleted) account; removal itself is recorded with the actor |
| `action` | `String` | one of: `auth_login_success`, `auth_login_failure`, `auth_register_success`, `auth_register_failure`, `auth_rate_limited`, `list_share`, `list_revoke`, `item_claim`, `item_purchase`, `item_revert`, `account_removal`, `session_revoked`, `session_reuse_detected`, `consent_updated` (US5, FR-021/FR-023), `invitation_matched` (US5, FR-011) |
| `targetType` | `String?` | `gift_list` \| `gift_item` \| `user` \| `session` \| null |
| `targetId` | `String?` | the referenced row id |
| `outcome` | `String` | `success` \| `denied` \| `failure` — failed/denied attempts are recorded too (edge case "Audit under failure") |
| `ip` | `String?` | trusted-proxy client IP (same source as rate limiting, D1) |
| `detail` | `Json?` | small structured extra (e.g. `{ email }` for auth events) — no secrets, never the password |
| `createdAt` | `DateTime` | default `now()` |

Indexes: `@@index([createdAt])`, `@@index([actorUserId])`, `@@index([targetType, targetId])`.

Constraint: rows are append-only — the application never updates or deletes
them in this feature.

### PendingInvitation (NEW)

A share addressed to an email with no registered account (research D6,
clarification Q1/US5 scenario 7).

| Field | Type | Notes |
|---|---|---|
| `id` | `String` (uuid) | PK |
| `giftListId` | `String` | FK → `GiftList.id`, `onDelete: Cascade` (list deleted → invitation discarded) |
| `inviteeEmail` | `String` | normalized (trimmed, lowercased) — the match key at registration |
| `ownerUserId` | `String` | FK → `User.id` (the inviter; identifies the owner's view) |
| `status` | `InvitationStatus` | `pending` → `matched` \| `discarded` |
| `createdAt` | `DateTime` | default `now()` |
| `expiresAt` | `DateTime?` | optional operator-configurable expiry (Assumptions: tuning detail); null = no expiry |

`enum InvitationStatus { pending matched discarded }`

Indexes: `@@unique([giftListId, inviteeEmail])`, `@@index([inviteeEmail, status])`.

Matching rule (SC-009): on successful registration with email `E`, every
`PendingInvitation` where `inviteeEmail = E` and `status = pending` is
transactionally converted into a `SharePermission` (consent `pending`) and
marked `matched`. A `PendingInvitation` grants **no access** until matched
(edge case "Pending invitation lifecycle").

## Extended Entity

### SharePermission (EXTENDED)

Two columns added; existing columns and the
`@@unique([giftListId, recipientUserId])` constraint unchanged.

| New field | Type | Notes |
|---|---|---|
| `recipientEmail` | `String?` | the email the owner used to invite. Source of truth for the owner's sharing view (FR-021). Set for every share (registered or not); for the registered case it mirrors the user's email at invite time |
| `nameDisclosureConsent` | `NameDisclosureConsent` | default `pending` — the per-list, revocable consent state (FR-021/023) |

`enum NameDisclosureConsent { pending revealed declined }`

Semantics:
- `pending` — recipient has never answered the prompt; appears as a
  placeholder ("????") to co-recipients; owner sees the email.
- `revealed` — display name visible to owner **and** co-recipients; email
  still owner-only (FR-021).
- `declined` — placeholder to co-recipients; recipient keeps full view/claim
  (FR-023).
- Re-invite after revocation creates a **new** `SharePermission` row → consent
  resets to `pending` (edge case "Re-share after revocation").

Visibility matrix (drives `identity.ts` + `gift-lists/router.ts`):

| Viewer | Recipient name | Recipient email | Claimant name on items |
|---|---|---|---|
| Owner (of the list) | always (email used to invite) | ✅ own email | ❌ never (owner privacy, FR-016) |
| Co-recipient, consent `revealed` | ✅ display name | ❌ | ✅ if claimant consented, else placeholder |
| Co-recipient, consent `pending`/`declined` | "????" placeholder | ❌ | "????" placeholder |

The owner's **own** email is never sent to recipients in any response —
`withOwnerIdentity` returns `displayName` only for non-owner viewers (FR-025).

## Unchanged Entities (do-not-regress)

- **User** — shape unchanged; gains a removal path (D12) but no new columns.
- **GiftList** — unchanged; `status` enum retained.
- **GiftItem** — unchanged. Claim transitions remain atomic
  conditional-`updateMany` in `gift-items/router.ts` (FR-017). On account
  removal, `claimantUserId`/`state`/`claimedAt`/`purchasedAt` are reset to the
  unclaimed state (D12) — this is data cleanup, not a state-machine change.

## Relationship & Constraint Summary

```text
User 1──* UserSession      onDelete: Cascade
User 1──* AuditEvent       onDelete: SetNull   (history survives account removal)
GiftList 1──* PendingInvitation  onDelete: Cascade
User 1──* PendingInvitation      (ownerUserId; plain FK)
GiftList 1──* SharePermission    (existing; now carries consent + invite email)
GiftItem *──0..1 User            (existing claimant FK; cleared on removal)
```

Note: audit history intentionally **survives** account removal
(`SetNull` keeps the row, `actorUserId` becomes null) — the record of what
happened is preserved even though the actor no longer exists; this matches
"personal data no longer accessible **through the app**" while keeping the
operator's trail (FR-013/FR-014).

## Migration Notes

- One migration: `prisma migrate dev --name security_hardening` (applied via
  the existing `prisma migrate deploy` in `entrypoint.sh`).
- All additions are backward-compatible (new tables; nullable/defaulted
  columns). No data backfill required: existing `SharePermission` rows get
  `nameDisclosureConsent = pending` and `recipientEmail = null` (owner view
  falls back to the recipient user's email for legacy rows).
- No destructive changes; `docker compose down -v` + fresh migrate remains a
  valid reset path.

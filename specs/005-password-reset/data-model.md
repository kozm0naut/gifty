# Data Model: Password Reset (005)

**Feature**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md) | **Date**: 2026-10-12

Additive-only changes to `backend/prisma/schema.prisma`. One new model, one enum
value, one migration (research D1/D3/D11). No existing column semantics change.

---

## New model: `PasswordResetToken`

```prisma
/// Single-use password-reset credential (005 FR-004/005/006). Only the SHA-256
/// digest is stored — the raw token exists once, in the outbox email body, and is
/// never persisted, logged, or echoed (005 FR-006).
model PasswordResetToken {
  id         String    @id @default(uuid())
  userId     String
  user       User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  tokenHash  String    // SHA-256 hex of the 256-bit raw token (research D2)
  createdAt  DateTime  @default(now())
  expiresAt  DateTime  // now + resetTokenTtlHours (default 24 h)
  consumedAt DateTime? // set atomically on successful consume (single use)

  @@unique([tokenHash])
  @@index([userId, consumedAt])
}
```

**Validation rules** (enforced in `auth/password-reset.ts`, not the schema):
- Raw token: `crypto.randomBytes(32).toString('base64url')` — 256 bits.
- `expiresAt = createdAt + resetTokenTtlHours` (config; default 24 h).
- Consume is the atomic
  `updateMany({ where: { id, tokenHash, consumedAt: null }, data: { consumedAt } })`;
  `count === 0` ⇒ invalid (unknown, expired-checked, or already consumed) with **no
  state change** (research D2/D7).

**State transitions** (the spec's "issued / consumed / expired / superseded"
lifecycle, expressed over the row):

```text
        issued (insert)
           │
           ├─► consumed   (consumedAt set — terminal; set either by the atomic
           │              claim on a successful reset OR by the sibling invalidation
           │              inside that same reset's transaction)
           │
           └─► expired    (expiresAt < now at presentation — virtual, rejected)
```

> Note (CHK004, B+ semantics): there is no separate "superseded" token state.
> A pending (issued) link stays valid until it is consumed, expires, or is
> invalidated by a successful reset for the same user (see the success-transaction
> rule below and FR-012). This closes the takeover hole where an old, unused,
> unexpired link could change the password *after* the user already completed a
> reset. `OutboxMessage` still carries an explicit `superseded` status for the
> in-flight *email* (D3), but the token side needs no such column — the
> invalidation write is the whole mechanism.

## Enum extension: `OutboxKind`

```prisma
enum OutboxKind {
  invite
  confirmation
  reset        // NEW (005, research D3)
}
```

`OutboxMessage` semantics for `kind = reset`:
- `userId` set (the account being reset), `listId` null.
- Supersede-on-reissue: `enqueueReset` flips prior `queued`/`sending` reset rows for
  the same user to `superseded` (same pattern as `enqueueConfirmation`) — so the
  inbox never holds two "current" reset emails for one account.
- Body embeds the raw link `{publicOrigin}/reset/{token}` — same sensitivity class as
  the confirmation body (never returned by any API; read only by the drainer and
  operators).
- Drains through the existing `drainOnce()` loop unchanged (live / capture /
  disabled tri-mode behavior inherited, research D3).

## `User` (unchanged; relationships)

- Gains the `passwordResetTokens PasswordResetToken[]` inverse relation only.
- `passwordHash` — the field a successful reset rewrites (bcrypt cost 10, same as
  registration).
- `verifiedAt` — a successful reset sets it when null (FR-013); no new column.

## `UserSession` (unchanged; behavior)

- A successful reset bulk-revokes all rows `where { userId, revokedAt: null }`
  (FR-012), **then** inserts one fresh row via the existing `createSession`
  (research D7 order). No schema change.

## Success transaction — sibling invalidation (FR-012, B+)

Inside the same all-or-nothing transaction that performs the reset, one additional
write invalidates every other pending link for the account:

```sql
UPDATE "PasswordResetToken" SET "consumedAt" = now()
WHERE "userId" = ? AND id <> <claimed row> AND "consumedAt" IS NULL
```

Effect: after any successful reset, zero pending links remain for the account —
a completed reset ends all pending reset state (same trust principle as the
session revocation it sits beside).

## `AuditEvent` (unchanged; new action strings)

New `action` values (research D8): `password_reset_requested`,
`password_reset_rate_limited`, `password_reset_success`, `password_reset_failed`.
`detail` is scrubbed — never contains the raw token, the new password, or the
bcrypt hash (FR-006).

## Invariants

1. **At most one consumed reset per token row** — unique `tokenHash` + conditional
   claim make double-consume impossible even under concurrent requests.
2. **Raw token never persisted outside the outbox body** — `PasswordResetToken`
   stores only the digest; the outbox body is the single raw-token holder (same as
   004).
4. **A completed reset ends all pending reset state** — after a successful reset,
   no un-consumed `PasswordResetToken` rows remain for the account (sibling
   invalidation, FR-012 B+).
3. **Reset is orthogonal to list state** — no relation exists between
   `PasswordResetToken`/reset logic and `GiftList`/`GiftItem`/`SharePermission`
   (FR-010); the only shared entities are `User` and `UserSession`.

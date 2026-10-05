# Data Model: Email Integration

**Feature**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md) | **Date**: 2026-10-03

This feature adds **one new entity** (`OutboxMessage`) and **four columns** on `User`.
All changes land in **one** Prisma migration. Existing entities (`User`, `GiftList`,
`GiftItem`, `SharePermission`, `PendingInvitation`, `UserSession`, `AuditEvent`) keep
their shapes; only `User` gains verification state. The existing `PendingInvitation` and
`SharePermission` per-(list, recipient) invariants are reused as the identity substrate
for invite dedup (research D3) — no new identity table is introduced.

## Entity Overview

```text
User 1───* OutboxMessage          (NEW: confirmation messages, keyed by userId)
GiftList 1───* OutboxMessage      (NEW: invite messages, keyed by listId)
User 1───0..1 (live verification) (EXTENDED: verifiedAt, verificationTokenHash,
                                    verificationExpiresAt, verificationCreatedAt)
SharePermission / PendingInvitation (UNCHANGED — their (list, recipient) unique
                                    invariants back the invite dedup rule)
AuditEvent (UNCHANGED shape — gains new `action` values: email_* — see D7)
```

## New Entity

### OutboxMessage (NEW)

The durable, transactional email queue (research D2). A row is committed **in the same
Prisma transaction** as the business write that produced it (the share, the registration),
then drained by a separate loop (research D2). It is the single source of truth for
"what should be sent, to whom, and what happened to it" (FR-006, FR-007, SC-001, SC-004).

| Field | Type | Notes |
|---|---|---|
| `id` | `String` (uuid) | PK; prefixed `outbox_*` via `makeId('outbox')` |
| `kind` | `OutboxKind` | `invite` \| `confirmation` — drives the link + body rendering (D9, D7) |
| `recipientEmail` | `String` | normalized (trimmed, lowercased) — the delivery address **and** the invite-dedup key (D3) |
| `listId` | `String?` | FK → `GiftList.id`, `onDelete: Cascade` — **set for `invite`, null for `confirmation`**; the dedup discriminator (see Indexes) |
| `userId` | `String?` | FK → `User.id`, `onDelete: Cascade` — the account being confirmed (set for `confirmation`, null for `invite`) |
| `subject` | `String` | rendered subject (stable; stored at enqueue so delivery is a pure send) |
| `bodyText` | `String` | rendered plain-text body (contains the link) |
| `bodyHtml` | `String?` | rendered HTML body (contains the link) |
| `status` | `OutboxStatus` | `queued` → `sending` → `sent` \| `failed` \| `superseded` (see State transitions) |
| `attempts` | `Int` | default `0`; incremented per delivery attempt (D2) |
| `maxAttempts` | `Int` | default `5` (from `EMAIL_MAX_ATTEMPTS` at enqueue) — the bounded-retry cap (FR-007) |
| `nextAttemptAt` | `DateTime` | default `now()` — when the drainer may next attempt (backoff anchor, D2) |
| `lastAttemptAt` | `DateTime?` | set on each attempt |
| `lastError` | `String?` | **scrubbed** error class/message (e.g. `provider_http_5xx`), never a provider key (FR-011) |
| `sentAt` | `DateTime?` | set on terminal `sent` |
| `supersededAt` | `DateTime?` | set on `superseded` (a confirmation replaced by a resend, D5) |
| `createdAt` | `DateTime` | default `now()` |
| `updatedAt` | `DateTime` | `@updatedAt` |

```text
enum OutboxKind   { invite confirmation }
enum OutboxStatus { queued sending sent failed superseded }
```

**Indexes / constraints**:
- `@@unique([listId, recipientEmail])` — **the invite-dedup guarantee (FR-005, SC-001),
  enforced by the database.** Postgres treats `NULL` as distinct in a unique index, so:
  - **invite** rows (`listId` non-null) → at most **one** per `(list, recipientEmail)`;
    a repeat share's `INSERT` hits a `P2002` violation and is treated as "already invited"
    (no second email) — the read-then-write race is impossible (D3).
  - **confirmation** rows (`listId` NULL) → **unlimited** per `recipientEmail` (confirmations
    are re-sendable, FR-014) — `NULL` never collides with itself.
  This single constraint therefore encodes *both* the "one invite per (recipient, list)"
  rule **and** the "confirmations are not deduped" rule, with no code branch.
- `@@index([status, nextAttemptAt])` — the drainer's selection query
  (`WHERE status = 'queued' AND nextAttemptAt <= now() ORDER BY nextAttemptAt LIMIT n`).
- `@@index([userId])`, `@@index([listId])` — per-account / per-list lookups.

**State transitions**:

```text
queued ──drainer claim────────► sending ──send ok────────────► sent        (terminal)
   ▲                              │
   │ (attempts < maxAttempts)     ├──send fail────────► queued (nextAttemptAt = now + backoff)
   │                              │
   └──────────────────────────────┴──process (re)start (reclaim, FR-007/SC-004)► queued (nextAttemptAt = now)
   │
   └───────────────────────────────────────────────────► failed          (terminal, attempts == maxAttempts; observable, never auto-retried)
confirmation: queued/sending ──superseded by a resend (D5)────────────────► superseded  (terminal, not delivered)
```

**In-flight reclaim (FR-007, SC-004)**: a row claimed into `sending` is in-flight. If the process dies or restarts before the send resolves to `sent` or a scheduled retry, the row would otherwise be wedged in `sending` (the drainer only selects `queued`) and silently lost. On (re)start the drainer reclaims such stale `sending` rows back to `queued` (`nextAttemptAt = now`) so they are retried — at-least-once delivery (a message whose send actually succeeded but whose `sent` write did not commit may be sent again; acceptable for this feature and consistent with the at-least-once enqueue guarantee, D2).

**Sensitivity note**: a `confirmation` row's `bodyText`/`bodyHtml` embeds the raw
verification token (the link). This is the *send* copy of the token; the *check* copy is
`User.verificationTokenHash` (D4). The row is therefore sensitive and is never returned
by any API; it is read only by the drainer (delivery) and by operators (inspection). The
token is single-use and bounded (24 h), so exposure is limited, but the row MUST NOT be
serialized into any response or audit `detail` (FR-010/FR-011; `scrub()` + never select
`body*` into API responses).

## Extended Entity

### User (EXTENDED)

Four nullable columns added for the confirmation/verification state (research D4/D5/D6).
`User`'s existing columns and all relationships are unchanged.

| New field | Type | Notes |
|---|---|---|
| `verifiedAt` | `DateTime?` | **null = unconfirmed** (only meaningful when email is enabled); set to the confirmation timestamp when the verification link is followed (FR-012, SC-008). Grandfathering: the migration backfills this to a fixed timestamp for **all pre-existing rows** (Assumptions) — new accounts created with email enabled are born `null`. |
| `verificationTokenHash` | `String?` | SHA-256 of the **current** raw verification token (the raw token is never stored on `User`; it lives only in the pending `OutboxMessage` body, D4). `GET /confirm?token=` hashes the presented token and looks this up — the single-use verification check. Null when no live token (confirmed, or email disabled). |
| `verificationExpiresAt` | `DateTime?` | expiry of the current token (default now + 24 h, `EMAIL_TOKEN_TTL_HOURS` tunable). A past expiry → the token is rejected with the same non-destructive outcome as a used/unknown token (FR-010). |
| `verificationCreatedAt` | `DateTime?` | when the current token was issued (resend supersedes and refreshes this). Diagnostic/audit aid. |

**Semantics / state**:

```text
[account created, email enabled]
   └─► unconfirmed (verifiedAt = null, verificationTokenHash = H(t0), expiresAt = now+24h)
           │  follow valid link
           ▼
        confirmed (verifiedAt = now, verificationTokenHash = null)   ← terminal for confirmation
           ▲
unconfirmed ──resend (D5)──► unconfirmed (verificationTokenHash = H(t1), expiresAt = now+24h)  [t0 superseded]

[account created, email DISABLED] ──► confirmed (verifiedAt = now, no token, no email)   (FR-015, D8)
[pre-existing account, migration backfill] ──► confirmed (verifiedAt = backfill ts)        (Assumptions)
```

**Invariants**:
- At most **one live verification** per account: `verificationTokenHash` holds a single
  value; a resend overwrites it (D5). No token table, no orphan cleanup.
- `verifiedAt === null` **is** the unconfirmed state — there is no separate boolean
  (D6). When email is disabled the account is created `verifiedAt = now`, so the state
  does not exist in that mode (FR-015).
- The verification state does **not** affect list/claim/consent data (Constitution II):
  it only gates the account's ability to use authenticated features (D6 allow-list).

## Migration (single)

One Prisma migration (e.g. `2026xxxx_email_integration`) contains:
1. `CREATE ENUM "OutboxKind"`, `CREATE ENUM "OutboxStatus"`.
2. `CREATE TABLE "OutboxMessage"` with the columns above, the FKs
   (`listId → GiftList` ON DELETE CASCADE, `userId → User` ON DELETE CASCADE), the
   `@@unique([listId, recipientEmail])` constraint, and the three indexes.
3. `ALTER TABLE "User"` adding the four nullable columns.
4. **Backfill**: `UPDATE "User" SET "verifiedAt" = <fixed timestamp> WHERE "verifiedAt" IS NULL`
   — grandfathering all pre-existing accounts as confirmed (Assumptions). New accounts
   created after this migration are the only ones born unconfirmed.

No data loss: every added column is nullable or has a default; existing rows are untouched
except the `verifiedAt` backfill.

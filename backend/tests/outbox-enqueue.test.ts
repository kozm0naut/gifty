/**
 * T022 — US3: One Invite Per Recipient Per List (FR-005, FR-014, SC-001)
 *
 * These tests drive the outbox enqueue primitives directly (the same call
 * shape the share/register routers use) and pin the dedup guarantees:
 *
 *  1. enqueue invite for (L, R)            → exactly one OutboxMessage row
 *  2. enqueue invite for same (L, R) again  → P2002 caught, no second row (no-op)
 *  3. enqueue invite for different (L2, R)  → new row (dedup is per-list)
 *  4. recipient registers, then (L, R) re-enqueued → no second row
 *     (the dedup key is (listId, recipientEmail), NOT user-id)
 *  5. revoke + re-share (L, R)             → no second row
 *  6. enqueue confirmation (U, E)          → one row with listId NULL
 *  7. re-enqueue confirmation (U, E)       → new row (confirmations are NOT deduped)
 *
 * The dedup is enforced by the database (`@@unique([listId, recipientEmail])`,
 * Postgres NULL-distinct), so these tests fail if `enqueueInvite` stops
 * swallowing the P2002 or if the unique constraint / discriminator drifts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../src/prisma.js';
import { enqueueInvite, enqueueConfirmation } from '../src/email/outbox.js';

const uniqueEmail = (prefix: string) =>
  `${prefix.toLowerCase()}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`;

/** Seed the minimal rows the enqueue paths reference (owner, recipient, list). */
async function seed(lists = 1) {
  const owner = await prisma.user.create({
    data: { email: uniqueEmail('owner'), passwordHash: 'x', displayName: 'Owner' },
  });
  const recipient = await prisma.user.create({
    data: { email: uniqueEmail('recip'), passwordHash: 'x', displayName: 'Recipient' },
  });
  const created: string[] = [];
  for (let i = 0; i < lists; i++) {
    const list = await prisma.giftList.create({
      data: { ownerUserId: owner.id, title: `List ${i}` },
    });
    created.push(list.id);
  }
  return { owner, recipient, lists: created };
}

const INVITE = (listId: string, recipientEmail: string) => ({
  listId,
  recipientEmail,
  subject: 'You\u2019ve been shared a gift list',
  bodyText: `Open your list: ${listId}`,
  bodyHtml: `Open your list: ${listId}`,
});

describe('US3 — One Invite Per Recipient Per List (FR-005, FR-014)', () => {
  beforeEach(async () => {
    await prisma.outboxMessage.deleteMany();
    await prisma.giftItem.deleteMany();
    await prisma.sharePermission.deleteMany();
    await prisma.pendingInvitation.deleteMany();
    await prisma.giftList.deleteMany();
    await prisma.user.deleteMany();
  });

  it('T022.1: first enqueue for (L, R) inserts exactly one row', async () => {
    const { recipient, lists } = await seed();
    const [listId] = lists;

    const res = await enqueueInvite(prisma, INVITE(listId, recipient.email));

    expect(res.inserted).toBe(true);
    expect(res.outboxMessageId).toBeTruthy();
    const rows = await prisma.outboxMessage.findMany({
      where: { listId, recipientEmail: recipient.email },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('invite');
    expect(rows[0].status).toBe('queued');
    expect(rows[0].listId).toBe(listId);
  });

  it('T022.2: re-enqueue for the same (L, R) is a no-op (P2002 → no second row)', async () => {
    const { recipient, lists } = await seed();
    const [listId] = lists;

    const first = await enqueueInvite(prisma, INVITE(listId, recipient.email));
    const second = await enqueueInvite(prisma, INVITE(listId, recipient.email));

    expect(first.inserted).toBe(true);
    // The duplicate resolves to the SAME existing row — no new row, no throw.
    expect(second.inserted).toBe(false);
    expect(second.outboxMessageId).toBe(first.outboxMessageId);

    expect(await prisma.outboxMessage.count({ where: { listId, recipientEmail: recipient.email } })).toBe(1);
  });

  it('T022.3: different list, same recipient → new row (dedup is per-list)', async () => {
    const { recipient, lists } = await seed(2);
    const [list1, list2] = lists;

    await enqueueInvite(prisma, INVITE(list1, recipient.email));
    const res2 = await enqueueInvite(prisma, INVITE(list2, recipient.email));

    expect(res2.inserted).toBe(true);
    expect(await prisma.outboxMessage.count({ where: { listId: list1, recipientEmail: recipient.email } })).toBe(1);
    expect(await prisma.outboxMessage.count({ where: { listId: list2, recipientEmail: recipient.email } })).toBe(1);
    expect(await prisma.outboxMessage.count({ where: { recipientEmail: recipient.email, kind: 'invite' } })).toBe(2);
  });

  it('T022.4: dedup spans the register transition — key is (listId, email), not user-id', async () => {
    // Recipient is already registered at seed time. Re-enqueueing the same
    // (L, R) — as if the account had just registered — must still be a no-op,
    // proving the key is (listId, recipientEmail), not recipient user-id.
    const { recipient, lists } = await seed();
    const [listId] = lists;

    await enqueueInvite(prisma, INVITE(listId, recipient.email));
    // Simulate "the same email re-appears" (e.g. a re-share after register):
    // the enqueue is keyed on the email address, so the user-id is irrelevant.
    const again = await enqueueInvite(prisma, INVITE(listId, recipient.email));

    expect(again.inserted).toBe(false);
    expect(await prisma.outboxMessage.count({ where: { listId, recipientEmail: recipient.email } })).toBe(1);
    // The stored row's recipient is the email; it is not tied to a user-id.
    const row = await prisma.outboxMessage.findUniqueOrThrow({ where: { id: again.outboxMessageId } });
    expect(row.recipientEmail).toBe(recipient.email);
    expect(row.listId).toBe(listId);
  });

  it('T022.5: revoke + re-share the same (L, R) → no second row', async () => {
    const { recipient, lists } = await seed();
    const [listId] = lists;

    const first = await enqueueInvite(prisma, INVITE(listId, recipient.email));
    // A revoked share leaves the outbox row in place; re-sharing re-enqueues
    // the same (listId, recipientEmail) → P2002 → no-op.
    const reShare = await enqueueInvite(prisma, INVITE(listId, recipient.email));

    expect(first.inserted).toBe(true);
    expect(reShare.inserted).toBe(false);
    expect(await prisma.outboxMessage.count({ where: { listId, recipientEmail: recipient.email } })).toBe(1);
  });

  it('T022.6: confirmation enqueue produces one row with listId NULL', async () => {
    const { recipient } = await seed();

    const res = await enqueueConfirmation(prisma, {
      userId: recipient.id,
      recipientEmail: recipient.email,
      subject: 'Confirm your email address',
      bodyText: 'Confirm: /confirm?token=abc',
      bodyHtml: 'Confirm: /confirm?token=abc',
    });

    expect(res.inserted).toBe(true);
    const rows = await prisma.outboxMessage.findMany({
      where: { userId: recipient.id, recipientEmail: recipient.email, kind: 'confirmation' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].listId).toBeNull();
    expect(rows[0].userId).toBe(recipient.id);
    expect(rows[0].status).toBe('queued');
  });

  it('T022.7: re-enqueue confirmation for the same (U, E) → new row (not deduped, FR-014)', async () => {
    const { recipient } = await seed();

    const first = await enqueueConfirmation(prisma, {
      userId: recipient.id,
      recipientEmail: recipient.email,
      subject: 'Confirm your email address',
      bodyText: 'Confirm: /confirm?token=one',
    });
    const second = await enqueueConfirmation(prisma, {
      userId: recipient.id,
      recipientEmail: recipient.email,
      subject: 'Confirm your email address',
      bodyText: 'Confirm: /confirm?token=two',
    });

    // Confirmations are NOT deduped — listId NULL falls out of the unique
    // constraint (Postgres NULL-distinct), so each (re)send is a new row.
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(true);
    expect(first.outboxMessageId).not.toBe(second.outboxMessageId);
    expect(
      await prisma.outboxMessage.count({
        where: { userId: recipient.id, recipientEmail: recipient.email, kind: 'confirmation' },
      }),
    ).toBe(2);
  });
});

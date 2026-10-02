import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../src/prisma.js';
import { createApp } from '../src/app.js';

/**
 * T045 [US7] — Account removal cascade (FR-014, FR-028; US7 scenarios 2–4;
 * edge cases "Removal while a recipient on others' lists",
 * "Owner removed while items are claimed (consent interaction)").
 *
 * `DELETE /account` must, in one transaction:
 *   1. revoke the user's sessions → the account can no longer authenticate;
 *   2. clear the user's claims on OTHERS' items (item reverts to `available`,
 *      claimant identity cleared; the rest of that list unchanged);
 *   3. delete the user's owned lists (items / shares / pending invitations cascade);
 *   4. delete the user's recipient-side `SharePermission` rows on others' lists;
 *   5. discard the user's pending invitations as owner;
 *   6. delete the user row;
 *   7. record `account_removal`; audit rows survive with `actorUserId` nulled.
 * Nothing newly revealed to remaining viewers (CHK013 do-not-regress).
 */

const uniqueEmail = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`;

function accessCookie(setCookieHeader: unknown): string {
  const arr = Array.isArray(setCookieHeader)
    ? setCookieHeader
    : setCookieHeader
      ? [setCookieHeader]
      : [];
  for (const c of arr) {
    const s = String(c);
    if (s.startsWith('gifty_access=')) {
      return s.split(';')[0].slice('gifty_access='.length);
    }
  }
  throw new Error('no gifty_access cookie in response');
}

type User = { id: string; access: string; email: string };

async function register(app: any, prefix: string, displayName: string): Promise<User> {
  const res = await request(app)
    .post('/auth/register')
    .send({ email: uniqueEmail(prefix), password: 'Password123!', displayName });
  return {
    id: res.body.user.id,
    access: accessCookie(res.headers['set-cookie']),
    email: res.body.user.email,
  };
}

async function createList(app: any, owner: User, title: string): Promise<string> {
  const res = await request(app)
    .post('/lists')
    .set('Cookie', `gifty_access=${owner.access}`)
    .send({ title });
  return res.body.list.id as string;
}

async function shareList(app: any, owner: User, listId: string, recipient: User) {
  return request(app)
    .post(`/lists/${listId}/share`)
    .set('Cookie', `gifty_access=${owner.access}`)
    .send({ recipientUserId: recipient.id, permission: 'shared' });
}

async function createItem(app: any, owner: User, listId: string, name: string) {
  const res = await request(app)
    .post(`/lists/${listId}/items`)
    .set('Cookie', `gifty_access=${owner.access}`)
    .send({ name, quantity: 1 });
  return res.body.item.id as string;
}

async function claimItem(app: any, claimant: User, itemId: string) {
  return request(app)
    .post(`/items/${itemId}/claim`)
    .set('Cookie', `gifty_access=${claimant.access}`)
    .send({ claimantUserId: claimant.id });
}

beforeEach(async () => {
  process.env.JWT_SECRET = 'test-secret-32-characters-long-0000';
  await prisma.auditEvent.deleteMany();
  await prisma.pendingInvitation.deleteMany();
  await prisma.sharePermission.deleteMany();
  await prisma.giftItem.deleteMany();
  await prisma.giftList.deleteMany();
  await prisma.userSession.deleteMany();
  await prisma.user.deleteMany();
});

describe('account removal cascade (T045, FR-014, FR-028)', () => {
  it('requires authentication (401 without a session)', async () => {
    const app = await createApp();
    const res = await request(app).delete('/account');
    expect(res.status).toBe(401);
  });

  it('removes a simple account: can no longer authenticate; owned lists/items gone; account_removal audited', async () => {
    const app = await createApp();
    const user = await register(app, 'simple', 'Simple');
    const listId = await createList(app, user, 'My List');
    await createItem(app, user, listId, 'Item One');

    const del = await request(app)
      .delete('/account')
      .set('Cookie', `gifty_access=${user.access}`);
    expect(del.status).toBe(204);

    // Account can no longer authenticate (session revoked + user gone).
    const login = await request(app)
      .post('/auth/login')
      .send({ email: user.email, password: 'Password123!' });
    expect(login.status).toBe(401);

    const account = await request(app).get('/account').set('Cookie', `gifty_access=${user.access}`);
    expect(account.status).toBe(401);

    // Owned data is gone.
    expect(await prisma.user.findUnique({ where: { id: user.id } })).toBeNull();
    expect(await prisma.giftList.findUnique({ where: { id: listId } })).toBeNull();
    expect(await prisma.giftItem.findMany({ where: { giftListId: listId } })).toHaveLength(0);

    // The removal itself is recorded, attributable, with a timestamp.
    const row = await prisma.auditEvent.findFirst({ where: { action: 'account_removal' } });
    expect(row).toBeTruthy();
    expect(row!.outcome).toBe('success');
    expect(row!.targetType).toBe('user');
    expect(row!.targetId).toBe(user.id);
  });

  it('removal as a RECIPIENT on others’ lists: their access is removed, the list and its other content are unchanged, nothing newly revealed (US7 scenario 4)', async () => {
    const app = await createApp();
    const owner = await register(app, 'owner', 'Owner');
    const recipient = await register(app, 'recip', 'Recipient');
    const other = await register(app, 'other', 'Other');

    const listId = await createList(app, owner, 'Owner List');
    const itemId = await createItem(app, owner, listId, 'Headphones');
    await shareList(app, owner, listId, recipient);
    await shareList(app, owner, listId, other);

    // Recipient claims an item → then is removed.
    const claim = await claimItem(app, recipient, itemId);
    expect(claim.status).toBe(200);

    const del = await request(app)
      .delete('/account')
      .set('Cookie', `gifty_access=${recipient.access}`);
    expect(del.status).toBe(204);

    // The item reverts to unclaimed, identity cleared…
    const item = await prisma.giftItem.findUnique({ where: { id: itemId } });
    expect(item).toBeTruthy();
    expect(item!.state).toBe('available');
    expect(item!.claimantUserId).toBeNull();
    expect(item!.claimedAt).toBeNull();

    // …the list still exists with its item (rest of the list unchanged)…
    const list = await prisma.giftList.findUnique({ where: { id: listId } });
    expect(list).toBeTruthy();
    expect(await prisma.giftItem.count({ where: { giftListId: listId } })).toBe(1);

    // …the recipient's permission row is gone…
    expect(
      await prisma.sharePermission.findMany({ where: { recipientUserId: recipient.id } }),
    ).toHaveLength(0);

    // …and the other recipient still has access with the same visibility rules
    // (nothing newly revealed: they see the claimant as placeholder, as before).
    const otherLists = await request(app).get('/lists').set('Cookie', `gifty_access=${other.access}`);
    const entry = otherLists.body.lists.find((l: any) => l.id === listId);
    expect(entry).toBeTruthy();
    const itemView = entry.items.find((i: any) => i.id === itemId);
    expect(itemView.state).toBe('available');
    expect(itemView.claimantDisplayName ?? null).toBeFalsy();
  });

  it('removal as OWNER: owned lists cascade away; pending invitations the owner sent are discarded; the owner can no longer see anything', async () => {
    const app = await createApp();
    const owner = await register(app, 'owner', 'Owner');
    const listId = await createList(app, owner, 'Doomed List');
    await createItem(app, owner, listId, 'Gadget');

    // Owner sent a pending invitation to an unregistered email.
    const ghostEmail = uniqueEmail('ghost');
    const share = await request(app)
      .post(`/lists/${listId}/share`)
      .set('Cookie', `gifty_access=${owner.access}`)
      .send({ recipientEmail: ghostEmail, permission: 'shared' });
    expect(share.status).toBe(201);
    expect(
      await prisma.pendingInvitation.findMany({ where: { inviteeEmail: ghostEmail } }),
    ).toHaveLength(1);

    const del = await request(app)
      .delete('/account')
      .set('Cookie', `gifty_access=${owner.access}`);
    expect(del.status).toBe(204);

    expect(await prisma.giftList.findUnique({ where: { id: listId } })).toBeNull();
    // Pending invitations cascaded away with the list (or were discarded).
    expect(await prisma.pendingInvitation.findMany({ where: { inviteeEmail: ghostEmail } })).toHaveLength(0);

    // Registering the ghost email later finds NO invitation to match.
    const reg = await request(app)
      .post('/auth/register')
      .send({ email: ghostEmail, password: 'Password123!', displayName: 'Ghost' });
    expect(reg.status).toBe(201);
    expect(
      await prisma.sharePermission.findMany({ where: { recipientUserId: reg.body.user.id } }),
    ).toHaveLength(0);
  });

  it('audit history SURVIVES removal with actorUserId nulled (data-model.md; FR-013)', async () => {
    const app = await createApp();
    const user = await register(app, 'aud', 'Audited');
    const listId = await createList(app, user, 'Audit List');
    const share = await request(app)
      .post(`/lists/${listId}/share`)
      .set('Cookie', `gifty_access=${user.access}`)
      .send({ recipientEmail: uniqueEmail('someone'), permission: 'shared' });
    expect(share.status).toBe(201);
    // Ensure at least one attributable audit row exists for this user.
    const before = await prisma.auditEvent.findFirst({
      where: { actorUserId: user.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(before).toBeTruthy();

    const del = await request(app)
      .delete('/account')
      .set('Cookie', `gifty_access=${user.access}`);
    expect(del.status).toBe(204);

    // The pre-removal rows remain (append-only) but their actor is nulled
    // (onDelete: SetNull) — the record is preserved, the identity is not.
    const survivor = await prisma.auditEvent.findFirst({
      where: { action: before!.action, targetId: before!.targetId, actorUserId: null },
      orderBy: { createdAt: 'desc' },
    });
    expect(survivor).toBeTruthy();
  });
});

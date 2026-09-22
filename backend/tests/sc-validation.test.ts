import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../src/prisma.js';
import { createApp } from '../src/app.js';

const uniqueEmail = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`;

type User = { id: string; token: string };

async function register(app: any, prefix: string, displayName: string): Promise<User> {
  const res = await request(app)
    .post('/auth/register')
    .send({ email: uniqueEmail(prefix), password: 'Password123!', displayName });
  return { id: res.body.user.id, token: res.body.token };
}

async function createList(app: any, owner: User, title: string) {
  const res = await request(app)
    .post('/lists')
    .set('Authorization', `Bearer ${owner.token}`)
    .send({ title, description: 'Test list' });
  return res.body.list.id as string;
}

async function shareList(app: any, owner: User, listId: string, recipient: User) {
  return request(app)
    .post(`/lists/${listId}/share`)
    .set('Authorization', `Bearer ${owner.token}`)
    .send({ recipientUserId: recipient.id, permission: 'shared' });
}

async function createItem(app: any, owner: User, listId: string, name: string) {
  const res = await request(app)
    .post(`/lists/${listId}/items`)
    .set('Authorization', `Bearer ${owner.token}`)
    .send({ name, quantity: 1, description: 'Test item' });
  return res.body.item.id as string;
}

async function claimItem(app: any, recipient: User, itemId: string) {
  return request(app)
    .post(`/items/${itemId}/claim`)
    .set('Authorization', `Bearer ${recipient.token}`)
    .send({ claimantUserId: recipient.id });
}

async function purchaseItem(app: any, recipient: User, itemId: string) {
  return request(app)
    .post(`/items/${itemId}/purchase`)
    .set('Authorization', `Bearer ${recipient.token}`);
}

beforeEach(async () => {
  process.env.JWT_SECRET = 'test-secret';
  await prisma.sharePermission.deleteMany();
  await prisma.giftItem.deleteMany();
  await prisma.giftList.deleteMany();
  await prisma.user.deleteMany();
});

// ─────────────────────────────────────────────────────────────────────────────
// T031 / SC-003: ≥95% of valid share and claim actions complete without errors
// ─────────────────────────────────────────────────────────────────────────────
describe('SC-003: Share and claim success rate (≥95%)', () => {
  it('completes a full share → claim cycle without errors', async () => {
    const app = await createApp();
    const owner = await register(app, 'sc3-owner', 'Owner');
    const recipient = await register(app, 'sc3-recipient', 'Recipient');

    const listId = await createList(app, owner, 'SC-003 List');
    const shareRes = await shareList(app, owner, listId, recipient);
    expect(shareRes.status).toBe(201);

    const itemId = await createItem(app, owner, listId, 'Headphones');
    const claimRes = await claimItem(app, recipient, itemId);
    expect(claimRes.status).toBe(200);
    expect(claimRes.body.item.state).toBe('claimed');
  });

  it('succeeds across multiple share + claim cycles (10 iterations)', async () => {
    const app = await createApp();
    const owner = await register(app, 'sc3-multi-owner', 'Owner');
    const recipient = await register(app, 'sc3-multi-recipient', 'Recipient');

    let successes = 0;
    const total = 10;

    for (let i = 0; i < total; i++) {
      const listId = await createList(app, owner, `SC-003 List ${i}`);
      const shareRes = await shareList(app, owner, listId, recipient);
      if (shareRes.status !== 201) continue;

      const itemId = await createItem(app, owner, listId, `Item ${i}`);
      const claimRes = await claimItem(app, recipient, itemId);
      if (claimRes.status === 200) successes++;
    }

    const rate = successes / total;
    expect(rate).toBeGreaterThanOrEqual(0.95);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T032 / SC-004: ≥99% duplicate-claim prevention
// ─────────────────────────────────────────────────────────────────────────────
describe('SC-004: Duplicate-claim race protection (≥99%)', () => {
  it('allows exactly one winner when two recipients claim simultaneously', async () => {
    const app = await createApp();
    const owner = await register(app, 'sc4-owner', 'Owner');
    const r1 = await register(app, 'sc4-r1', 'Recipient 1');
    const r2 = await register(app, 'sc4-r2', 'Recipient 2');

    const listId = await createList(app, owner, 'SC-004 List');
    await shareList(app, owner, listId, r1);
    await shareList(app, owner, listId, r2);
    const itemId = await createItem(app, owner, listId, 'Contested Item');

    const [res1, res2] = await Promise.all([
      claimItem(app, r1, itemId),
      claimItem(app, r2, itemId),
    ]);

    const statuses = [res1.status, res2.status].sort();
    expect(statuses).toEqual([200, 409]);

    const winner = res1.status === 200 ? r1 : r2;
    const item = await prisma.giftItem.findUnique({ where: { id: itemId } });
    expect(item?.state).toBe('claimed');
    expect(item?.claimantUserId).toBe(winner.id);
  });

  it('prevents duplicate claims across 20 concurrent race rounds (≥99% protection)', async () => {
    const app = await createApp();
    const owner = await register(app, 'sc4-bulk-owner', 'Owner');
    const r1 = await register(app, 'sc4-bulk-r1', 'R1');
    const r2 = await register(app, 'sc4-bulk-r2', 'R2');

    let protectedRounds = 0;
    const totalRounds = 20;

    for (let i = 0; i < totalRounds; i++) {
      const listId = await createList(app, owner, `SC-004 Race ${i}`);
      await shareList(app, owner, listId, r1);
      await shareList(app, owner, listId, r2);
      const itemId = await createItem(app, owner, listId, `Race Item ${i}`);

      const [res1, res2] = await Promise.all([
        claimItem(app, r1, itemId),
        claimItem(app, r2, itemId),
      ]);

      const oneWon = (res1.status === 200 && res2.status === 409) ||
                     (res2.status === 200 && res1.status === 409);
      if (oneWon) protectedRounds++;
    }

    const protectionRate = protectedRounds / totalRounds;
    expect(protectionRate).toBeGreaterThanOrEqual(0.99);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T033 / SC-005: Owner privacy boundary enforcement
// ─────────────────────────────────────────────────────────────────────────────
describe('SC-005: Owner privacy boundary', () => {
  it('hides claimant identity and state from the list owner', async () => {
    const app = await createApp();
    const owner = await register(app, 'sc5-owner', 'Owner');
    const recipient = await register(app, 'sc5-recipient', 'Recipient');

    const listId = await createList(app, owner, 'SC-005 List');
    await shareList(app, owner, listId, recipient);
    const itemId = await createItem(app, owner, listId, 'Secret Gift');

    await claimItem(app, recipient, itemId);

    const ownerView = await request(app)
      .get(`/lists/${listId}`)
      .set('Authorization', `Bearer ${owner.token}`);

    expect(ownerView.status).toBe(200);
    const item = ownerView.body.list.items.find((i: any) => i.id === itemId);
    expect(item.state).toBe('available');
    expect(item.claimantUserId).toBeUndefined();
  });

  it('hides claimant identity and state from the list owner', async () => {
    const app = await createApp();
    const owner = await register(app, 'sc5-p-owner', 'Owner');
    const recipient = await register(app, 'sc5-p-recipient', 'Recipient');

    const listId = await createList(app, owner, 'SC-005 Purchase List');
    await shareList(app, owner, listId, recipient);
    const itemId = await createItem(app, owner, listId, 'Purchased Gift');

    await claimItem(app, recipient, itemId);
    await purchaseItem(app, recipient, itemId);

    const ownerView = await request(app)
      .get(`/lists/${listId}`)
      .set('Authorization', `Bearer ${owner.token}`);

    expect(ownerView.status).toBe(200);
    const item = ownerView.body.list.items.find((i: any) => i.id === itemId);
    expect(item.state).toBe('available');
    expect(item.claimantUserId).toBeUndefined();
  });

  it('hides claim/purchase state from the owner in the dashboard (GET /lists) view', async () => {
    const app = await createApp();
    const owner = await register(app, 'sc5-dash-owner', 'Owner');
    const recipient = await register(app, 'sc5-dash-recipient', 'Recipient');

    const listId = await createList(app, owner, 'SC-005 Dashboard List');
    await shareList(app, owner, listId, recipient);
    const itemId = await createItem(app, owner, listId, 'Dashboard Gift');

    await claimItem(app, recipient, itemId);
    await purchaseItem(app, recipient, itemId);

    // The owner's dashboard must not leak claim/purchase state for their own list.
    const dashboard = await request(app)
      .get('/lists')
      .set('Authorization', `Bearer ${owner.token}`);

    expect(dashboard.status).toBe(200);
    const list = dashboard.body.lists.find((l: any) => l.id === listId);
    const item = list.items.find((i: any) => i.id === itemId);
    expect(item.state).toBe('available');
    expect(item.claimantUserId).toBeUndefined();
  });

  it('shows full claim and purchase state to authorized recipients', async () => {
    const app = await createApp();
    const owner = await register(app, 'sc5-r-owner', 'Owner');
    const r1 = await register(app, 'sc5-r1', 'R1');
    const r2 = await register(app, 'sc5-r2', 'R2');

    const listId = await createList(app, owner, 'SC-005 Recipient List');
    await shareList(app, owner, listId, r1);
    await shareList(app, owner, listId, r2);
    const itemId = await createItem(app, owner, listId, 'Shared Gift');

    await claimItem(app, r1, itemId);
    await purchaseItem(app, r1, itemId);

    const r2View = await request(app)
      .get(`/lists/${listId}`)
      .set('Authorization', `Bearer ${r2.token}`);

    expect(r2View.status).toBe(200);
    const item = r2View.body.list.items.find((i: any) => i.id === itemId);
    expect(item.state).toBe('purchased');
    expect(item.claimantUserId).toBe(r1.id);
  });

  it('resolves and exposes claimant display names to recipients (T047)', async () => {
    const app = await createApp();
    const owner = await register(app, 'sc5-name-owner', 'Owner');
    const r1 = await register(app, 'sc5-name-r1', 'Claimer One');
    const r2 = await register(app, 'sc5-name-r2', 'Viewer Two');

    const listId = await createList(app, owner, 'T047 Name List');
    await shareList(app, owner, listId, r1);
    await shareList(app, owner, listId, r2);
    const itemId = await createItem(app, owner, listId, 'Named Gift');

    await claimItem(app, r1, itemId);
    await purchaseItem(app, r1, itemId);

    // Recipient view via GET /lists/:listId
    const listView = await request(app)
      .get(`/lists/${listId}`)
      .set('Authorization', `Bearer ${r2.token}`);
    expect(listView.status).toBe(200);
    const listItem = listView.body.list.items.find((i: any) => i.id === itemId);
    expect(listItem.claimantDisplayName).toBe('Claimer One');

    // Recipient view via GET /lists/:listId/items
    const itemsView = await request(app)
      .get(`/lists/${listId}/items`)
      .set('Authorization', `Bearer ${r2.token}`);
    expect(itemsView.status).toBe(200);
    const itemsItem = itemsView.body.items.find((i: any) => i.id === itemId);
    expect(itemsItem.claimantDisplayName).toBe('Claimer One');

    // Recipient view via GET /lists (dashboard)
    const dashView = await request(app)
      .get('/lists')
      .set('Authorization', `Bearer ${r2.token}`);
    expect(dashView.status).toBe(200);
    const dashList = dashView.body.lists.find((l: any) => l.id === listId);
    const dashItem = dashList.items.find((i: any) => i.id === itemId);
    expect(dashItem.claimantDisplayName).toBe('Claimer One');

    // Owner view must NOT expose identity (owner-privacy boundary preserved)
    const ownerView = await request(app)
      .get(`/lists/${listId}`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(ownerView.status).toBe(200);
    const ownerItem = ownerView.body.list.items.find((i: any) => i.id === itemId);
    expect(ownerItem.claimantDisplayName).toBeUndefined();
    expect(ownerItem.state).toBe('available');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T034 / SC-006: Permission and lifecycle update coverage (≥90%)
// ─────────────────────────────────────────────────────────────────────────────
describe('SC-006: Permission and lifecycle update coverage (≥90%)', () => {
  it('supports share → revoke → re-share cycle', async () => {
    const app = await createApp();
    const owner = await register(app, 'sc6-owner', 'Owner');
    const recipient = await register(app, 'sc6-recipient', 'Recipient');

    const listId = await createList(app, owner, 'SC-006 List');
    const shareRes = await shareList(app, owner, listId, recipient);
    expect(shareRes.status).toBe(201);

    const perms = await request(app)
      .get(`/lists/${listId}/share-permissions`)
      .set('Authorization', `Bearer ${owner.token}`);
    const permId = perms.body.permissions[0].id;

    const revokeRes = await request(app)
      .delete(`/lists/${listId}/share/${permId}`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(revokeRes.status).toBe(204);

    const reShareRes = await shareList(app, owner, listId, recipient);
    expect(reShareRes.status).toBe(201);
  });

  it('supports claim → unclaim → re-claim cycle', async () => {
    const app = await createApp();
    const owner = await register(app, 'sc6-c-owner', 'Owner');
    const recipient = await register(app, 'sc6-c-recipient', 'Recipient');

    const listId = await createList(app, owner, 'SC-006 Claim List');
    await shareList(app, owner, listId, recipient);
    const itemId = await createItem(app, owner, listId, 'Cycle Item');

    const claim1 = await claimItem(app, recipient, itemId);
    expect(claim1.status).toBe(200);

    const unclaim = await request(app)
      .post(`/items/${itemId}/unclaim`)
      .set('Authorization', `Bearer ${recipient.token}`);
    expect(unclaim.status).toBe(200);
    expect(unclaim.body.item.state).toBe('available');

    const claim2 = await claimItem(app, recipient, itemId);
    expect(claim2.status).toBe(200);
    expect(claim2.body.item.state).toBe('claimed');
  });

  it('supports claim → purchase → unpurchase → re-purchase cycle', async () => {
    const app = await createApp();
    const owner = await register(app, 'sc6-p-owner', 'Owner');
    const recipient = await register(app, 'sc6-p-recipient', 'Recipient');

    const listId = await createList(app, owner, 'SC-006 Purchase List');
    await shareList(app, owner, listId, recipient);
    const itemId = await createItem(app, owner, listId, 'Purchase Cycle Item');

    await claimItem(app, recipient, itemId);

    const purchase1 = await purchaseItem(app, recipient, itemId);
    expect(purchase1.status).toBe(200);
    expect(purchase1.body.item.state).toBe('purchased');

    const unpurchase = await request(app)
      .post(`/items/${itemId}/unpurchase`)
      .set('Authorization', `Bearer ${recipient.token}`);
    expect(unpurchase.status).toBe(200);
    expect(unpurchase.body.item.state).toBe('claimed');

    const purchase2 = await purchaseItem(app, recipient, itemId);
    expect(purchase2.status).toBe(200);
    expect(purchase2.body.item.state).toBe('purchased');
  });

  it('returns clear rejection errors for blocked actions', async () => {
    const app = await createApp();
    const owner = await register(app, 'sc6-b-owner', 'Owner');
    const recipient = await register(app, 'sc6-b-recipient', 'Recipient');
    const outsider = await register(app, 'sc6-b-outsider', 'Outsider');

    const listId = await createList(app, owner, 'SC-006 Blocked List');
    await shareList(app, owner, listId, recipient);
    const itemId = await createItem(app, owner, listId, 'Blocked Item');

    // Owner cannot claim
    const ownerClaim = await request(app)
      .post(`/items/${itemId}/claim`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ claimantUserId: owner.id });
    expect(ownerClaim.status).toBe(403);
    expect(ownerClaim.body.message).toBeTruthy();

    // Outsider cannot claim (no permission)
    const outsiderClaim = await request(app)
      .post(`/items/${itemId}/claim`)
      .set('Authorization', `Bearer ${outsider.token}`)
      .send({ claimantUserId: outsider.id });
    expect(outsiderClaim.status).toBe(403);

    // Cannot purchase without claiming first
    const noClaimPurchase = await purchaseItem(app, recipient, itemId);
    expect(noClaimPurchase.status).toBe(409);
    expect(noClaimPurchase.body.message).toBeTruthy();

    // Item is immutable
    const patch = await request(app)
      .patch(`/items/${itemId}`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'Changed' });
    expect(patch.status).toBe(403);

    const del = await request(app)
      .delete(`/items/${itemId}`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(del.status).toBe(403);
  });

  it('achieves ≥90% success across a mixed scenario suite', async () => {
    const app = await createApp();
    const owner = await register(app, 'sc6-mix-owner', 'Owner');
    const recipient = await register(app, 'sc6-mix-recipient', 'Recipient');

    let successes = 0;
    const total = 10;

    for (let i = 0; i < total; i++) {
      const listId = await createList(app, owner, `SC-006 Mix ${i}`);
      const shareRes = await shareList(app, owner, listId, recipient);
      if (shareRes.status !== 201) continue;

      const itemId = await createItem(app, owner, listId, `Mix Item ${i}`);
      const claimRes = await claimItem(app, recipient, itemId);
      if (claimRes.status !== 200) continue;

      const purchaseRes = await purchaseItem(app, recipient, itemId);
      if (purchaseRes.status !== 200) continue;

      const unpurchaseRes = await request(app)
        .post(`/items/${itemId}/unpurchase`)
        .set('Authorization', `Bearer ${recipient.token}`);
      if (unpurchaseRes.status === 200) successes++;
    }

    const rate = successes / total;
    expect(rate).toBeGreaterThanOrEqual(0.90);
  });
});

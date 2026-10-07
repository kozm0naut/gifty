import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../../src/prisma.js';
import { createApp } from '../../src/app.js';

const uniqueEmail = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`;

/** Extract the `gifty_access` value from a supertest Set-Cookie header. */
function accessCookie(setCookieHeader: unknown): string {
  const arr = Array.isArray(setCookieHeader) ? setCookieHeader : setCookieHeader ? [setCookieHeader] : [];
  for (const c of arr) {
    const s = String(c);
    if (s.startsWith('gifty_access=')) {
      return s.split(';')[0].slice('gifty_access='.length);
    }
  }
  throw new Error('no gifty_access cookie in response');
}

type User = { id: string; email: string; access: string };

async function register(app: any, prefix: string, displayName: string): Promise<User> {
  const email = uniqueEmail(prefix);
  const res = await request(app)
    .post('/auth/register')
    .send({ email, password: 'Password123!', displayName });
  return { id: res.body.user.id, email, access: accessCookie(res.headers['set-cookie']) };
}

beforeEach(async () => {
  process.env.JWT_SECRET = 'test-secret';
  await prisma.sharePermission.deleteMany();
  await prisma.giftItem.deleteMany();
  await prisma.giftList.deleteMany();
  await prisma.user.deleteMany();
});

describe('API contract: authentication', () => {
  it('POST /auth/register returns 201 with user and session cookie', async () => {
    const app = await createApp();
    const res = await request(app)
      .post('/auth/register')
      .send({ email: uniqueEmail('contract'), password: 'Password123!', displayName: 'Contract User' });

    expect(res.status).toBe(201);
    expect(res.body.user).toHaveProperty('id');
    expect(res.body.user).toHaveProperty('email');
    expect(res.body.user).toHaveProperty('displayName');
    expect(res.body.token).toBeUndefined();
    expect(accessCookie(res.headers['set-cookie'])).toBeTruthy();
  });

  it('POST /auth/register rejects duplicate email with 409', async () => {
    const app = await createApp();
    const email = uniqueEmail('dup');
    await request(app).post('/auth/register').send({ email, password: 'Password123!', displayName: 'First' });
    const res = await request(app).post('/auth/register').send({ email, password: 'Password123!', displayName: 'Second' });
    expect(res.status).toBe(409);
  });

  it('POST /auth/login returns 200 with session cookie for valid credentials', async () => {
    const app = await createApp();
    const email = uniqueEmail('login');
    await request(app).post('/auth/register').send({ email, password: 'Password123!', displayName: 'Login User' });
    const res = await request(app).post('/auth/login').send({ email, password: 'Password123!' });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeUndefined();
    expect(accessCookie(res.headers['set-cookie'])).toBeTruthy();
  });

  it('POST /auth/login rejects invalid credentials with 401', async () => {
    const app = await createApp();
    const email = uniqueEmail('badlogin');
    await request(app).post('/auth/register').send({ email, password: 'Password123!', displayName: 'Bad Login' });
    const res = await request(app).post('/auth/login').send({ email, password: 'WrongPassword!' });
    expect(res.status).toBe(401);
  });
});

describe('API contract: gift lists', () => {
  it('POST /lists returns 201 with list.id', async () => {
    const app = await createApp();
    const owner = await register(app, 'list-owner', 'Owner');
    const res = await request(app)
      .post('/lists')
      .set('Cookie', `gifty_access=${owner.access}`)
      .send({ title: 'Contract List' });

    expect(res.status).toBe(201);
    expect(res.body.list).toHaveProperty('id');
    expect(res.body.list.title).toBe('Contract List');
  });

  it('POST /lists rejects missing title with 400', async () => {
    const app = await createApp();
    const owner = await register(app, 'list-bad', 'Owner');
    const res = await request(app)
      .post('/lists')
      .set('Cookie', `gifty_access=${owner.access}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it('GET /lists returns 200 with lists array', async () => {
    const app = await createApp();
    const owner = await register(app, 'list-get', 'Owner');
    await request(app).post('/lists').set('Cookie', `gifty_access=${owner.access}`).send({ title: 'A' });
    const res = await request(app).get('/lists').set('Cookie', `gifty_access=${owner.access}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.lists)).toBe(true);
    expect(res.body.lists.length).toBe(1);
  });

  it('GET /lists/:listId returns 200 with list and items', async () => {
    const app = await createApp();
    const owner = await register(app, 'list-detail', 'Owner');
    const listRes = await request(app).post('/lists').set('Cookie', `gifty_access=${owner.access}`).send({ title: 'Detail' });
    const res = await request(app).get(`/lists/${listRes.body.list.id}`).set('Cookie', `gifty_access=${owner.access}`);
    expect(res.status).toBe(200);
    expect(res.body.list).toHaveProperty('id');
    expect(res.body.list).toHaveProperty('items');
  });

  it('GET /lists/:listId returns 403 for a list the user has no access to', async () => {
    const app = await createApp();
    const owner = await register(app, 'list-403', 'Owner');
    const outsider = await register(app, 'list-403-out', 'Outsider');
    const listRes = await request(app).post('/lists').set('Cookie', `gifty_access=${owner.access}`).send({ title: 'Private' });
    const res = await request(app).get(`/lists/${listRes.body.list.id}`).set('Cookie', `gifty_access=${outsider.access}`);
    expect(res.status).toBe(403);
  });

  it('DELETE /lists/:listId returns 200 and removes the list', async () => {
    const app = await createApp();
    const owner = await register(app, 'list-del', 'Owner');
    const listRes = await request(app).post('/lists').set('Cookie', `gifty_access=${owner.access}`).send({ title: 'Delete Me' });
    const del = await request(app).delete(`/lists/${listRes.body.list.id}`).set('Cookie', `gifty_access=${owner.access}`);
    expect(del.status).toBe(200);
    // After deletion, the list no longer appears in the owner's dashboard
    const dashboard = await request(app).get('/lists').set('Cookie', `gifty_access=${owner.access}`);
    expect(dashboard.body.lists.some((l: any) => l.id === listRes.body.list.id)).toBe(false);
  });
});

describe('API contract: sharing', () => {
  it('POST /lists/:listId/share returns 201 with sharePermission', async () => {
    const app = await createApp();
    const owner = await register(app, 'share-owner', 'Owner');
    const recipient = await register(app, 'share-recipient', 'Recipient');
    const listRes = await request(app).post('/lists').set('Cookie', `gifty_access=${owner.access}`).send({ title: 'Share List' });

    const res = await request(app)
      .post(`/lists/${listRes.body.list.id}/share`)
      .set('Cookie', `gifty_access=${owner.access}`)
      .send({ recipientUserId: recipient.id, permission: 'shared' });

    expect(res.status).toBe(201);
    expect(res.body.sharePermission).toHaveProperty('id');
    expect(res.body.sharePermission.recipientUserId).toBe(recipient.id);
  });

  it('POST /lists/:listId/share rejects self-share with 400', async () => {
    const app = await createApp();
    const owner = await register(app, 'share-self', 'Owner');
    const listRes = await request(app).post('/lists').set('Cookie', `gifty_access=${owner.access}`).send({ title: 'Self Share' });
    const res = await request(app)
      .post(`/lists/${listRes.body.list.id}/share`)
      .set('Cookie', `gifty_access=${owner.access}`)
      .send({ recipientUserId: owner.id, permission: 'shared' });
    expect(res.status).toBe(400);
  });

  it('GET /lists/:listId/share-permissions returns 200 with permissions array', async () => {
    const app = await createApp();
    const owner = await register(app, 'perm-owner', 'Owner');
    const recipient = await register(app, 'perm-recipient', 'Recipient');
    const listRes = await request(app).post('/lists').set('Cookie', `gifty_access=${owner.access}`).send({ title: 'Perm List' });
    await request(app).post(`/lists/${listRes.body.list.id}/share`).set('Cookie', `gifty_access=${owner.access}`).send({ recipientUserId: recipient.id, permission: 'shared' });

    const res = await request(app).get(`/lists/${listRes.body.list.id}/share-permissions`).set('Cookie', `gifty_access=${owner.access}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.permissions)).toBe(true);
    // Uniform owner share view (T058/T060, 003 FR-010/003 FR-021): a single
    // `permissions` array (pending invitations included — no separate
    // `pendingInvitations` array), the invite email as the owner's source of
    // truth, and the recipient display name only after consent to reveal.
    expect(res.body).not.toHaveProperty('pendingInvitations');
    const entry = res.body.permissions[0];
    expect(entry.recipientEmail).toBe(recipient.email);
    expect(entry.recipientDisplayName ?? null).toBeNull();
  });

  it('DELETE /lists/:listId/share/:permissionId returns 204', async () => {
    const app = await createApp();
    const owner = await register(app, 'revoke-owner', 'Owner');
    const recipient = await register(app, 'revoke-recipient', 'Recipient');
    const listRes = await request(app).post('/lists').set('Cookie', `gifty_access=${owner.access}`).send({ title: 'Revoke List' });
    const shareRes = await request(app).post(`/lists/${listRes.body.list.id}/share`).set('Cookie', `gifty_access=${owner.access}`).send({ recipientUserId: recipient.id, permission: 'shared' });

    const res = await request(app).delete(`/lists/${listRes.body.list.id}/share/${shareRes.body.sharePermission.id}`).set('Cookie', `gifty_access=${owner.access}`);
    expect(res.status).toBe(204);
  });
});

describe('API contract: gift items', () => {
  it('POST /lists/:listId/items returns 201 with item in available state', async () => {
    const app = await createApp();
    const owner = await register(app, 'item-owner', 'Owner');
    const listRes = await request(app).post('/lists').set('Cookie', `gifty_access=${owner.access}`).send({ title: 'Item List' });

    const res = await request(app)
      .post(`/lists/${listRes.body.list.id}/items`)
      .set('Cookie', `gifty_access=${owner.access}`)
      .send({ name: 'Headphones', quantity: 1 });

    expect(res.status).toBe(201);
    expect(res.body.item).toHaveProperty('id');
    expect(res.body.item.state).toBe('available');
  });

  it('POST /lists/:listId/items rejects missing name with 400', async () => {
    const app = await createApp();
    const owner = await register(app, 'item-bad', 'Owner');
    const listRes = await request(app).post('/lists').set('Cookie', `gifty_access=${owner.access}`).send({ title: 'Bad Item' });
    const res = await request(app)
      .post(`/lists/${listRes.body.list.id}/items`)
      .set('Cookie', `gifty_access=${owner.access}`)
      .send({ quantity: 1 });
    expect(res.status).toBe(400);
  });

  it('PATCH /items/:itemId returns 403 (immutable)', async () => {
    const app = await createApp();
    const owner = await register(app, 'immut-owner', 'Owner');
    const listRes = await request(app).post('/lists').set('Cookie', `gifty_access=${owner.access}`).send({ title: 'Immut List' });
    const itemRes = await request(app).post(`/lists/${listRes.body.list.id}/items`).set('Cookie', `gifty_access=${owner.access}`).send({ name: 'Locked', quantity: 1 });

    const res = await request(app).patch(`/items/${itemRes.body.item.id}`).set('Cookie', `gifty_access=${owner.access}`).send({ name: 'Changed' });
    expect(res.status).toBe(403);
  });

  it('DELETE /items/:itemId returns 403 (immutable)', async () => {
    const app = await createApp();
    const owner = await register(app, 'immut-del', 'Owner');
    const listRes = await request(app).post('/lists').set('Cookie', `gifty_access=${owner.access}`).send({ title: 'Immut Del' });
    const itemRes = await request(app).post(`/lists/${listRes.body.list.id}/items`).set('Cookie', `gifty_access=${owner.access}`).send({ name: 'Locked', quantity: 1 });

    const res = await request(app).delete(`/items/${itemRes.body.item.id}`).set('Cookie', `gifty_access=${owner.access}`);
    expect(res.status).toBe(403);
  });
});

describe('API contract: item lifecycle', () => {
  it('POST /items/:itemId/claim returns 200 with claimed state', async () => {
    const app = await createApp();
    const owner = await register(app, 'lc-owner', 'Owner');
    const recipient = await register(app, 'lc-recipient', 'Recipient');
    const listRes = await request(app).post('/lists').set('Cookie', `gifty_access=${owner.access}`).send({ title: 'LC List' });
    await request(app).post(`/lists/${listRes.body.list.id}/share`).set('Cookie', `gifty_access=${owner.access}`).send({ recipientUserId: recipient.id, permission: 'shared' });
    const itemRes = await request(app).post(`/lists/${listRes.body.list.id}/items`).set('Cookie', `gifty_access=${owner.access}`).send({ name: 'LC Item', quantity: 1 });

    const res = await request(app).post(`/items/${itemRes.body.item.id}/claim`).set('Cookie', `gifty_access=${recipient.access}`).send({ claimantUserId: recipient.id });
    expect(res.status).toBe(200);
    expect(res.body.item.state).toBe('claimed');
  });

  it('POST /items/:itemId/claim returns 409 when already claimed', async () => {
    const app = await createApp();
    const owner = await register(app, 'lc-dup-owner', 'Owner');
    const r1 = await register(app, 'lc-dup-r1', 'R1');
    const r2 = await register(app, 'lc-dup-r2', 'R2');
    const listRes = await request(app).post('/lists').set('Cookie', `gifty_access=${owner.access}`).send({ title: 'LC Dup' });
    await request(app).post(`/lists/${listRes.body.list.id}/share`).set('Cookie', `gifty_access=${owner.access}`).send({ recipientUserId: r1.id, permission: 'shared' });
    await request(app).post(`/lists/${listRes.body.list.id}/share`).set('Cookie', `gifty_access=${owner.access}`).send({ recipientUserId: r2.id, permission: 'shared' });
    const itemRes = await request(app).post(`/lists/${listRes.body.list.id}/items`).set('Cookie', `gifty_access=${owner.access}`).send({ name: 'LC Dup Item', quantity: 1 });

    await request(app).post(`/items/${itemRes.body.item.id}/claim`).set('Cookie', `gifty_access=${r1.access}`).send({ claimantUserId: r1.id });
    const res = await request(app).post(`/items/${itemRes.body.item.id}/claim`).set('Cookie', `gifty_access=${r2.access}`).send({ claimantUserId: r2.id });
    expect(res.status).toBe(409);
  });

  it('POST /items/:itemId/purchase returns 200 with purchased state', async () => {
    const app = await createApp();
    const owner = await register(app, 'lc-p-owner', 'Owner');
    const recipient = await register(app, 'lc-p-recipient', 'Recipient');
    const listRes = await request(app).post('/lists').set('Cookie', `gifty_access=${owner.access}`).send({ title: 'LC P' });
    await request(app).post(`/lists/${listRes.body.list.id}/share`).set('Cookie', `gifty_access=${owner.access}`).send({ recipientUserId: recipient.id, permission: 'shared' });
    const itemRes = await request(app).post(`/lists/${listRes.body.list.id}/items`).set('Cookie', `gifty_access=${owner.access}`).send({ name: 'LC P Item', quantity: 1 });
    await request(app).post(`/items/${itemRes.body.item.id}/claim`).set('Cookie', `gifty_access=${recipient.access}`).send({ claimantUserId: recipient.id });

    const res = await request(app).post(`/items/${itemRes.body.item.id}/purchase`).set('Cookie', `gifty_access=${recipient.access}`);
    expect(res.status).toBe(200);
    expect(res.body.item.state).toBe('purchased');
  });

  it('POST /items/:itemId/purchase returns 409 when not claimed', async () => {
    const app = await createApp();
    const owner = await register(app, 'lc-pb-owner', 'Owner');
    const recipient = await register(app, 'lc-pb-recipient', 'Recipient');
    const listRes = await request(app).post('/lists').set('Cookie', `gifty_access=${owner.access}`).send({ title: 'LC PB' });
    await request(app).post(`/lists/${listRes.body.list.id}/share`).set('Cookie', `gifty_access=${owner.access}`).send({ recipientUserId: recipient.id, permission: 'shared' });
    const itemRes = await request(app).post(`/lists/${listRes.body.list.id}/items`).set('Cookie', `gifty_access=${owner.access}`).send({ name: 'LC PB Item', quantity: 1 });

    const res = await request(app).post(`/items/${itemRes.body.item.id}/purchase`).set('Cookie', `gifty_access=${recipient.access}`);
    expect(res.status).toBe(409);
  });

  it('POST /items/:itemId/unclaim returns 200 with available state', async () => {
    const app = await createApp();
    const owner = await register(app, 'lc-u-owner', 'Owner');
    const recipient = await register(app, 'lc-u-recipient', 'Recipient');
    const listRes = await request(app).post('/lists').set('Cookie', `gifty_access=${owner.access}`).send({ title: 'LC U' });
    await request(app).post(`/lists/${listRes.body.list.id}/share`).set('Cookie', `gifty_access=${owner.access}`).send({ recipientUserId: recipient.id, permission: 'shared' });
    const itemRes = await request(app).post(`/lists/${listRes.body.list.id}/items`).set('Cookie', `gifty_access=${owner.access}`).send({ name: 'LC U Item', quantity: 1 });
    await request(app).post(`/items/${itemRes.body.item.id}/claim`).set('Cookie', `gifty_access=${recipient.access}`).send({ claimantUserId: recipient.id });

    const res = await request(app).post(`/items/${itemRes.body.item.id}/unclaim`).set('Cookie', `gifty_access=${recipient.access}`);
    expect(res.status).toBe(200);
    expect(res.body.item.state).toBe('available');
  });

  it('POST /items/:itemId/unpurchase returns 200 with claimed state', async () => {
    const app = await createApp();
    const owner = await register(app, 'lc-up-owner', 'Owner');
    const recipient = await register(app, 'lc-up-recipient', 'Recipient');
    const listRes = await request(app).post('/lists').set('Cookie', `gifty_access=${owner.access}`).send({ title: 'LC UP' });
    await request(app).post(`/lists/${listRes.body.list.id}/share`).set('Cookie', `gifty_access=${owner.access}`).send({ recipientUserId: recipient.id, permission: 'shared' });
    const itemRes = await request(app).post(`/lists/${listRes.body.list.id}/items`).set('Cookie', `gifty_access=${owner.access}`).send({ name: 'LC UP Item', quantity: 1 });
    await request(app).post(`/items/${itemRes.body.item.id}/claim`).set('Cookie', `gifty_access=${recipient.access}`).send({ claimantUserId: recipient.id });
    await request(app).post(`/items/${itemRes.body.item.id}/purchase`).set('Cookie', `gifty_access=${recipient.access}`);

    const res = await request(app).post(`/items/${itemRes.body.item.id}/unpurchase`).set('Cookie', `gifty_access=${recipient.access}`);
    expect(res.status).toBe(200);
    expect(res.body.item.state).toBe('claimed');
  });
});

describe('API contract: privacy boundary', () => {
  it('owner never sees claimant identity or state', async () => {
    const app = await createApp();
    const owner = await register(app, 'priv-owner', 'Owner');
    const recipient = await register(app, 'priv-recipient', 'Recipient');
    const listRes = await request(app).post('/lists').set('Cookie', `gifty_access=${owner.access}`).send({ title: 'Priv List' });
    await request(app).post(`/lists/${listRes.body.list.id}/share`).set('Cookie', `gifty_access=${owner.access}`).send({ recipientUserId: recipient.id, permission: 'shared' });
    const itemRes = await request(app).post(`/lists/${listRes.body.list.id}/items`).set('Cookie', `gifty_access=${owner.access}`).send({ name: 'Priv Item', quantity: 1 });
    await request(app).post(`/items/${itemRes.body.item.id}/claim`).set('Cookie', `gifty_access=${recipient.access}`).send({ claimantUserId: recipient.id });
    await request(app).post(`/items/${itemRes.body.item.id}/purchase`).set('Cookie', `gifty_access=${recipient.access}`);

    const ownerView = await request(app).get(`/lists/${listRes.body.list.id}`).set('Cookie', `gifty_access=${owner.access}`);
    const item = ownerView.body.list.items.find((i: any) => i.id === itemRes.body.item.id);
    expect(item.state).toBe('available');
    expect(item.claimantUserId).toBeUndefined();
  });

  it('recipient sees full claim and purchase state', async () => {
    const app = await createApp();
    const owner = await register(app, 'priv2-owner', 'Owner');
    const r1 = await register(app, 'priv2-r1', 'R1');
    const r2 = await register(app, 'priv2-r2', 'R2');
    const listRes = await request(app).post('/lists').set('Cookie', `gifty_access=${owner.access}`).send({ title: 'Priv2 List' });
    await request(app).post(`/lists/${listRes.body.list.id}/share`).set('Cookie', `gifty_access=${owner.access}`).send({ recipientUserId: r1.id, permission: 'shared' });
    await request(app).post(`/lists/${listRes.body.list.id}/share`).set('Cookie', `gifty_access=${owner.access}`).send({ recipientUserId: r2.id, permission: 'shared' });
    const itemRes = await request(app).post(`/lists/${listRes.body.list.id}/items`).set('Cookie', `gifty_access=${owner.access}`).send({ name: 'Priv2 Item', quantity: 1 });
    await request(app).post(`/items/${itemRes.body.item.id}/claim`).set('Cookie', `gifty_access=${r1.access}`).send({ claimantUserId: r1.id });
    await request(app).post(`/items/${itemRes.body.item.id}/purchase`).set('Cookie', `gifty_access=${r1.access}`);

    const r2View = await request(app).get(`/lists/${listRes.body.list.id}`).set('Cookie', `gifty_access=${r2.access}`);
    const item = r2View.body.list.items.find((i: any) => i.id === itemRes.body.item.id);
    expect(item.state).toBe('purchased');
    expect(item.claimantUserId).toBe(r1.id);
  });
});

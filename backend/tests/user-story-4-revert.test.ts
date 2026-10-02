import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../src/prisma.js';
import { createApp } from '../src/app.js';

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

type User = { id: string; access: string };

async function register(app: any, prefix: string, displayName: string): Promise<User> {
  const res = await request(app)
    .post('/auth/register')
    .send({ email: uniqueEmail(prefix), password: 'Password123!', displayName });
  return { id: res.body.user.id, access: accessCookie(res.headers['set-cookie']) };
}

async function setupSharedList(app: any, owner: User, recipient: User, itemName: string) {
  const listResponse = await request(app)
    .post('/lists')
    .set('Cookie', `gifty_access=${owner.access}`)
    .send({ title: 'Revert Test List', description: 'For revert testing' });

  await request(app)
    .post(`/lists/${listResponse.body.list.id}/share`)
    .set('Cookie', `gifty_access=${owner.access}`)
    .send({ recipientUserId: recipient.id, permission: 'shared' as any });

  const itemResponse = await request(app)
    .post(`/lists/${listResponse.body.list.id}/items`)
    .set('Cookie', `gifty_access=${owner.access}`)
    .send({ name: itemName, quantity: 1, description: 'Test item' });

  return { listId: listResponse.body.list.id, itemId: itemResponse.body.item.id };
}

describe('User Story 4 - Revert gift states (unclaim / unpurchase)', () => {
  beforeEach(async () => {
    process.env.JWT_SECRET = 'test-secret';
    await prisma.sharePermission.deleteMany();
    await prisma.giftItem.deleteMany();
    await prisma.giftList.deleteMany();
    await prisma.user.deleteMany();
  });

  it('allows the claimant to unclaim an item, returning it to available', async () => {
    // Arrange
    const app = await createApp();
    const owner = await register(app, 'owner', 'Owner');
    const recipient = await register(app, 'recipient', 'Recipient');
    const { itemId } = await setupSharedList(app, owner, recipient, 'Headphones');

    const claim = await request(app)
      .post(`/items/${itemId}/claim`)
      .set('Cookie', `gifty_access=${recipient.access}`)
      .send({ claimantUserId: recipient.id });
    expect(claim.status).toBe(200);
    expect(claim.body.item.state).toBe('claimed');

    // Act
    const unclaim = await request(app)
      .post(`/items/${itemId}/unclaim`)
      .set('Cookie', `gifty_access=${recipient.access}`);

    // Assert
    expect(unclaim.status).toBe(200);
    expect(unclaim.body.item.state).toBe('available');
    expect(unclaim.body.item.claimantUserId).toBeNull();
  });

  it('denies the list owner the ability to unclaim an item', async () => {
    // Arrange
    const app = await createApp();
    const owner = await register(app, 'owner', 'Owner');
    const recipient = await register(app, 'recipient', 'Recipient');
    const { itemId } = await setupSharedList(app, owner, recipient, 'Headphones');

    await request(app)
      .post(`/items/${itemId}/claim`)
      .set('Cookie', `gifty_access=${recipient.access}`)
      .send({ claimantUserId: recipient.id });

    // Act
    const unclaim = await request(app)
      .post(`/items/${itemId}/unclaim`)
      .set('Cookie', `gifty_access=${owner.access}`);

    // Assert
    expect(unclaim.status).toBe(403);
    expect(unclaim.body.message).toBe('Only shared recipients can claim items');
  });

  it('denies a non-claimant the ability to unclaim someone else\'s claim', async () => {
    // Arrange
    const app = await createApp();
    const owner = await register(app, 'owner', 'Owner');
    const claimant = await register(app, 'claimant', 'Claimant');
    const other = await register(app, 'other', 'Other');
    const { listId, itemId } = await setupSharedList(app, owner, claimant, 'Headphones');

    await request(app)
      .post(`/lists/${listId}/share`)
      .set('Cookie', `gifty_access=${owner.access}`)
      .send({ recipientUserId: other.id, permission: 'shared' as any });

    await request(app)
      .post(`/items/${itemId}/claim`)
      .set('Cookie', `gifty_access=${claimant.access}`)
      .send({ claimantUserId: claimant.id });

    // Act
    const unclaim = await request(app)
      .post(`/items/${itemId}/unclaim`)
      .set('Cookie', `gifty_access=${other.access}`);

    // Assert
    expect(unclaim.status).toBe(403);
    expect(unclaim.body.message).toBe('Only the current claimant can revert this claim');
  });

  it('rejects unclaim when the item is not in a claimed state', async () => {
    // Arrange
    const app = await createApp();
    const owner = await register(app, 'owner', 'Owner');
    const recipient = await register(app, 'recipient', 'Recipient');
    const { itemId } = await setupSharedList(app, owner, recipient, 'Headphones');

    // Act
    const unclaim = await request(app)
      .post(`/items/${itemId}/unclaim`)
      .set('Cookie', `gifty_access=${recipient.access}`);

    // Assert
    expect(unclaim.status).toBe(409);
    expect(unclaim.body.message).toBe('This item is not in a claimed state');
  });

  it('allows the claimant to unpurchase an item, returning it to claimed', async () => {
    // Arrange
    const app = await createApp();
    const owner = await register(app, 'owner', 'Owner');
    const recipient = await register(app, 'recipient', 'Recipient');
    const { itemId } = await setupSharedList(app, owner, recipient, 'Headphones');

    await request(app)
      .post(`/items/${itemId}/claim`)
      .set('Cookie', `gifty_access=${recipient.access}`)
      .send({ claimantUserId: recipient.id });

    const purchase = await request(app)
      .post(`/items/${itemId}/purchase`)
      .set('Cookie', `gifty_access=${recipient.access}`);
    expect(purchase.status).toBe(200);
    expect(purchase.body.item.state).toBe('purchased');

    // Act
    const unpurchase = await request(app)
      .post(`/items/${itemId}/unpurchase`)
      .set('Cookie', `gifty_access=${recipient.access}`);

    // Assert
    expect(unpurchase.status).toBe(200);
    expect(unpurchase.body.item.state).toBe('claimed');
    expect(unpurchase.body.item.claimantUserId).toBe(recipient.id);
  });

  it('denies the list owner the ability to unpurchase an item', async () => {
    // Arrange
    const app = await createApp();
    const owner = await register(app, 'owner', 'Owner');
    const recipient = await register(app, 'recipient', 'Recipient');
    const { itemId } = await setupSharedList(app, owner, recipient, 'Headphones');

    await request(app)
      .post(`/items/${itemId}/claim`)
      .set('Cookie', `gifty_access=${recipient.access}`)
      .send({ claimantUserId: recipient.id });

    await request(app)
      .post(`/items/${itemId}/purchase`)
      .set('Cookie', `gifty_access=${recipient.access}`);

    // Act
    const unpurchase = await request(app)
      .post(`/items/${itemId}/unpurchase`)
      .set('Cookie', `gifty_access=${owner.access}`);

    // Assert
    expect(unpurchase.status).toBe(403);
    expect(unpurchase.body.message).toBe('Only shared recipients can claim items');
  });

  it('rejects unpurchase when the item is not in a purchased state', async () => {
    // Arrange
    const app = await createApp();
    const owner = await register(app, 'owner', 'Owner');
    const recipient = await register(app, 'recipient', 'Recipient');
    const { itemId } = await setupSharedList(app, owner, recipient, 'Headphones');

    await request(app)
      .post(`/items/${itemId}/claim`)
      .set('Cookie', `gifty_access=${recipient.access}`)
      .send({ claimantUserId: recipient.id });

    // Act
    const unpurchase = await request(app)
      .post(`/items/${itemId}/unpurchase`)
      .set('Cookie', `gifty_access=${recipient.access}`);

    // Assert
    expect(unpurchase.status).toBe(409);
    expect(unpurchase.body.message).toBe('This item is not in a purchased state');
  });

  it('supports the full revert cycle: purchased -> claimed -> available', async () => {
    // Arrange
    const app = await createApp();
    const owner = await register(app, 'owner', 'Owner');
    const recipient = await register(app, 'recipient', 'Recipient');
    const { itemId } = await setupSharedList(app, owner, recipient, 'Headphones');

    await request(app)
      .post(`/items/${itemId}/claim`)
      .set('Cookie', `gifty_access=${recipient.access}`)
      .send({ claimantUserId: recipient.id });

    await request(app)
      .post(`/items/${itemId}/purchase`)
      .set('Cookie', `gifty_access=${recipient.access}`);

    // Act
    const unpurchase = await request(app)
      .post(`/items/${itemId}/unpurchase`)
      .set('Cookie', `gifty_access=${recipient.access}`);

    const unclaim = await request(app)
      .post(`/items/${itemId}/unclaim`)
      .set('Cookie', `gifty_access=${recipient.access}`);

    // Assert
    expect(unpurchase.body.item.state).toBe('claimed');
    expect(unclaim.body.item.state).toBe('available');
    expect(unclaim.body.item.claimantUserId).toBeNull();
  });

  it('prevents a non-claimant from purchasing a claimed item', async () => {
    // Arrange
    const app = await createApp();
    const owner = await register(app, 'owner', 'Owner');
    const claimant = await register(app, 'claimant', 'Claimant');
    const other = await register(app, 'other', 'Other');
    const { listId, itemId } = await setupSharedList(app, owner, claimant, 'Headphones');

    await request(app)
      .post(`/lists/${listId}/share`)
      .set('Cookie', `gifty_access=${owner.access}`)
      .send({ recipientUserId: other.id, permission: 'shared' as any });

    await request(app)
      .post(`/items/${itemId}/claim`)
      .set('Cookie', `gifty_access=${claimant.access}`)
      .send({ claimantUserId: claimant.id });

    // Act
    const purchase = await request(app)
      .post(`/items/${itemId}/purchase`)
      .set('Cookie', `gifty_access=${other.access}`);

    // Assert
    expect(purchase.status).toBe(403);
    expect(purchase.body.message).toBe('Only the claimant can purchase this item');
  });

  it('rejects a second concurrent claim on the same item with a conflict', async () => {
    // Arrange
    const app = await createApp();
    const owner = await register(app, 'owner', 'Owner');
    const first = await register(app, 'first', 'First');
    const second = await register(app, 'second', 'Second');
    const { listId, itemId } = await setupSharedList(app, owner, first, 'Headphones');

    await request(app)
      .post(`/lists/${listId}/share`)
      .set('Cookie', `gifty_access=${owner.access}`)
      .send({ recipientUserId: second.id, permission: 'shared' as any });

    // Act
    const claimOne = await request(app)
      .post(`/items/${itemId}/claim`)
      .set('Cookie', `gifty_access=${first.access}`)
      .send({ claimantUserId: first.id });

    const claimTwo = await request(app)
      .post(`/items/${itemId}/claim`)
      .set('Cookie', `gifty_access=${second.access}`)
      .send({ claimantUserId: second.id });

    // Assert
    expect(claimOne.status).toBe(200);
    expect(claimTwo.status).toBe(409);
    expect(claimTwo.body.message).toBe('This item is no longer available to claim');
  });
});

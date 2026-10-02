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

describe('User Story 3 - Share a list with trusted recipients', () => {
  beforeEach(async () => {
    process.env.JWT_SECRET = 'test-secret';
    await prisma.sharePermission.deleteMany();
    await prisma.giftItem.deleteMany();
    await prisma.giftList.deleteMany();
    await prisma.user.deleteMany();
  });

  it('shares a list only with the invited recipient and denies access to others', async () => {
    // Arrange
    const app = await createApp();

    const ownerResponse = await request(app).post('/auth/register').send({
      email: uniqueEmail('owner'),
      password: 'Password123!',
      displayName: 'Owner User',
    });

    const recipientResponse = await request(app).post('/auth/register').send({
      email: uniqueEmail('recipient'),
      password: 'Password123!',
      displayName: 'Recipient User',
    });

    const outsiderResponse = await request(app).post('/auth/register').send({
      email: uniqueEmail('outsider'),
      password: 'Password123!',
      displayName: 'Outsider User',
    });

    const listResponse = await request(app)
      .post('/lists')
      .set('Cookie', `gifty_access=${accessCookie(ownerResponse.headers['set-cookie'])}`)
      .send({ title: 'Shared Wedding List', description: 'List for friends' });

    // Act
    const shareResponse = await request(app)
      .post(`/lists/${listResponse.body.list.id}/share`)
      .set('Cookie', `gifty_access=${accessCookie(ownerResponse.headers['set-cookie'])}`)
      .send({ recipientUserId: recipientResponse.body.user.id, permission: 'shared' as any });

    const ownerLists = await request(app)
      .get('/lists')
      .set('Cookie', `gifty_access=${accessCookie(ownerResponse.headers['set-cookie'])}`);

    const recipientLists = await request(app)
      .get('/lists')
      .set('Cookie', `gifty_access=${accessCookie(recipientResponse.headers['set-cookie'])}`);

    const outsiderLists = await request(app)
      .get('/lists')
      .set('Cookie', `gifty_access=${accessCookie(outsiderResponse.headers['set-cookie'])}`);

    const recipientDetail = await request(app)
      .get(`/lists/${listResponse.body.list.id}`)
      .set('Cookie', `gifty_access=${accessCookie(recipientResponse.headers['set-cookie'])}`);

    const outsiderDetail = await request(app)
      .get(`/lists/${listResponse.body.list.id}`)
      .set('Cookie', `gifty_access=${accessCookie(outsiderResponse.headers['set-cookie'])}`);

    // Assert
    expect(shareResponse.status).toBe(201);
    expect(shareResponse.body.sharePermission.recipientUserId).toBe(recipientResponse.body.user.id);

    expect(ownerLists.body.lists.some((list: any) => list.id === listResponse.body.list.id)).toBe(true);
    expect(recipientLists.body.lists.some((list: any) => list.id === listResponse.body.list.id)).toBe(true);
    expect(outsiderLists.body.lists.some((list: any) => list.id === listResponse.body.list.id)).toBe(false);

    expect(recipientDetail.status).toBe(200);
    expect(outsiderDetail.status).toBe(403);
    expect(outsiderDetail.body.message).toBe('You do not have access to this list');
  });

  it('allows an invited recipient to claim an item without revealing the claimant to the list owner', async () => {
    // Arrange
    const app = await createApp();

    const ownerResponse = await request(app).post('/auth/register').send({
      email: uniqueEmail('owner-two'),
      password: 'Password123!',
      displayName: 'Owner Two',
    });

    const recipientResponse = await request(app).post('/auth/register').send({
      email: uniqueEmail('recipient-two'),
      password: 'Password123!',
      displayName: 'Recipient Two',
    });

    const listResponse = await request(app)
      .post('/lists')
      .set('Cookie', `gifty_access=${accessCookie(ownerResponse.headers['set-cookie'])}`)
      .send({ title: 'Claim Test List', description: 'For claim testing' });

    await request(app)
      .post(`/lists/${listResponse.body.list.id}/share`)
      .set('Cookie', `gifty_access=${accessCookie(ownerResponse.headers['set-cookie'])}`)
      .send({ recipientUserId: recipientResponse.body.user.id, permission: 'shared' as any });

    const itemResponse = await request(app)
      .post(`/lists/${listResponse.body.list.id}/items`)
      .set('Cookie', `gifty_access=${accessCookie(ownerResponse.headers['set-cookie'])}`)
      .send({ name: 'Headphones', quantity: 1, description: 'Noise cancelling' });

    // Act
    const claimResponse = await request(app)
      .post(`/items/${itemResponse.body.item.id}/claim`)
      .set('Cookie', `gifty_access=${accessCookie(recipientResponse.headers['set-cookie'])}`)
      .send({ claimantUserId: recipientResponse.body.user.id });

    const ownerView = await request(app)
      .get(`/lists/${listResponse.body.list.id}`)
      .set('Cookie', `gifty_access=${accessCookie(ownerResponse.headers['set-cookie'])}`);

    const recipientView = await request(app)
      .get(`/lists/${listResponse.body.list.id}`)
      .set('Cookie', `gifty_access=${accessCookie(recipientResponse.headers['set-cookie'])}`);

    // Assert
    expect(claimResponse.status).toBe(200);
    expect(claimResponse.body.item.state).toBe('claimed');
    expect(claimResponse.body.item.claimantUserId).toBe(recipientResponse.body.user.id);

    expect(ownerView.status).toBe(200);
    expect(ownerView.body.list.items[0].state).toBe('available');
    expect(ownerView.body.list.items[0].claimantUserId).toBeUndefined();

    expect(recipientView.status).toBe(200);
    expect(recipientView.body.list.items[0].state).toBe('claimed');
    expect(recipientView.body.list.items[0].claimantUserId).toBe(recipientResponse.body.user.id);
  });
});

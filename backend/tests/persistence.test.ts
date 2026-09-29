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

describe('Storage persistence', () => {
  beforeEach(async () => {
    process.env.JWT_SECRET = 'test-secret';
    await prisma.sharePermission.deleteMany();
    await prisma.giftItem.deleteMany();
    await prisma.giftList.deleteMany();
    await prisma.user.deleteMany();
  });

  it('keeps list data after the server restarts', async () => {
    // Arrange
    const firstApp = await createApp();

    const owner = await request(firstApp).post('/auth/register').send({
      email: uniqueEmail('persisted'),
      password: 'Password123!',
      displayName: 'Persisted User',
    });

    const cookie = accessCookie(owner.headers['set-cookie']);

    const listResponse = await request(firstApp)
      .post('/lists')
      .set('Cookie', `gifty_access=${cookie}`)
      .send({
        title: 'Persistent List',
        description: 'Should survive restart',
      });

    // Act
    const secondApp = await createApp();
    const dashboardResponse = await request(secondApp)
      .get('/lists')
      .set('Cookie', `gifty_access=${cookie}`);

    // Assert
    expect(listResponse.status).toBe(201);
    expect(dashboardResponse.status).toBe(200);
    expect(dashboardResponse.body.lists).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: listResponse.body.list.id,
          title: 'Persistent List',
        }),
      ]),
    );
  });
});

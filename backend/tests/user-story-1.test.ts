import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../src/prisma.js';
import { createApp } from '../src/app.js';

const uniqueEmail = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`;

describe('User Story 1 MVP', () => {
  beforeEach(async () => {
    process.env.JWT_SECRET = 'test-secret';
    await prisma.sharePermission.deleteMany();
    await prisma.giftItem.deleteMany();
    await prisma.giftList.deleteMany();
    await prisma.user.deleteMany();
  });

  it('registers a user, creates a list, and adds items to it', async () => {
    // Arrange
    const app = await createApp();
    const registerPayload = {
      email: uniqueEmail('owner'),
      password: 'Password123!',
      displayName: 'Owner User',
    };

    // Act
    const registerResponse = await request(app)
      .post('/auth/register')
      .send(registerPayload);

    const token = registerResponse.body.token;
    const listResponse = await request(app)
      .post('/lists')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: 'Birthday Wishlist',
        description: 'Fun gifts for my birthday',
      });

    const itemOneResponse = await request(app)
      .post(`/lists/${listResponse.body.list.id}/items`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Camera',
        description: 'Pocket camera',
        quantity: 1,
      });

    const itemTwoResponse = await request(app)
      .post(`/lists/${listResponse.body.list.id}/items`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Books',
        description: 'A stack of good reads',
        quantity: 2,
      });

    const detailResponse = await request(app)
      .get(`/lists/${listResponse.body.list.id}`)
      .set('Authorization', `Bearer ${token}`);

    // Assert
    expect(registerResponse.status).toBe(201);
    expect(registerResponse.body.user.email).toBe(registerPayload.email);
    expect(token).toBeTruthy();

    expect(listResponse.status).toBe(201);
    expect(listResponse.body.list.title).toBe('Birthday Wishlist');

    expect(itemOneResponse.status).toBe(201);
    expect(itemTwoResponse.status).toBe(201);

    expect(detailResponse.status).toBe(200);
    expect(detailResponse.body.list.items).toHaveLength(2);
    expect(detailResponse.body.list.items.map((item: any) => item.name)).toEqual(
      expect.arrayContaining(['Camera', 'Books']),
    );
  });

  it('prevents the owner from updating or deleting an item after it is created', async () => {
    // Arrange
    const app = await createApp();
    const registerPayload = {
      email: uniqueEmail('owner2'),
      password: 'Password123!',
      displayName: 'Owner Two',
    };

    // Act
    const registerResponse = await request(app)
      .post('/auth/register')
      .send(registerPayload);

    const token = registerResponse.body.token;
    const listResponse = await request(app)
      .post('/lists')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Wedding ideas' });

    const itemResponse = await request(app)
      .post(`/lists/${listResponse.body.list.id}/items`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Coffee Maker',
        description: 'For the kitchen',
        quantity: 1,
      });

    const itemId = itemResponse.body.item.id;
    const updateResponse = await request(app)
      .patch(`/items/${itemId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Espresso Machine',
        description: 'Gift for the kitchen',
      });

    const deleteResponse = await request(app)
      .delete(`/items/${itemId}`)
      .set('Authorization', `Bearer ${token}`);

    // Assert
    expect(updateResponse.status).toBe(403);
    expect(updateResponse.body.message).toBe('Gift items are immutable once created');

    expect(deleteResponse.status).toBe(403);
    expect(deleteResponse.body.message).toBe('Gift items are immutable once created');
  });

  it('allows the owner to rename a list and the updated title round-trips (US1/AC2)', async () => {
    // Arrange
    const app = await createApp();
    const registerPayload = {
      email: uniqueEmail('owner-rename'),
      password: 'Password123!',
      displayName: 'Rename Owner',
    };

    const registerResponse = await request(app)
      .post('/auth/register')
      .send(registerPayload);

    const token = registerResponse.body.token;

    const listResponse = await request(app)
      .post('/lists')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Original Title', description: 'Original desc' });

    const listId = listResponse.body.list.id;

    // Arrange: add an item so we can assert renaming never drops items.
    await request(app)
      .post(`/lists/${listId}/items`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Existing Item' });

    // Act: rename the list
    const renameResponse = await request(app)
      .patch(`/lists/${listId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Renamed Title', description: 'Updated description' });

    // Assert: rename succeeded and the updated title is returned
    expect(renameResponse.status).toBe(200);
    expect(renameResponse.body.list.title).toBe('Renamed Title');
    expect(renameResponse.body.list.description).toBe('Updated description');

    // Regression: the rename response must still include the existing items —
    // a bare list payload (no items) caused the UI to appear to wipe the list.
    expect(renameResponse.body.list.items).toHaveLength(1);
    expect(renameResponse.body.list.items[0].name).toBe('Existing Item');

    // Assert: the updated title round-trips through GET /lists/:listId
    const detailResponse = await request(app)
      .get(`/lists/${listId}`)
      .set('Authorization', `Bearer ${token}`);

    expect(detailResponse.status).toBe(200);
    expect(detailResponse.body.list.title).toBe('Renamed Title');
  });

  it('rejects a non-owner from renaming a list (US1/AC2, authorization)', async () => {
    // Arrange: two users, first owns a list
    const app = await createApp();

    const ownerReg = await request(app)
      .post('/auth/register')
      .send({ email: uniqueEmail('owner-r2'), password: 'Password123!', displayName: 'Owner R2' });
    const ownerToken = ownerReg.body.token;

    const listResponse = await request(app)
      .post('/lists')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ title: 'Protected List' });
    const listId = listResponse.body.list.id;

    // A second, non-owner user attempts the rename
    const intruderReg = await request(app)
      .post('/auth/register')
      .send({ email: uniqueEmail('intruder-r2'), password: 'Password123!', displayName: 'Intruder R2' });
    const intruderToken = intruderReg.body.token;

    // Act
    const renameResponse = await request(app)
      .patch(`/lists/${listId}`)
      .set('Authorization', `Bearer ${intruderToken}`)
      .send({ title: 'Hacked Title' });

    // Assert
    expect(renameResponse.status).toBe(403);
    expect(renameResponse.body.message).toBe('You do not have access to this list');
  });

  it('rejects stale JWTs when the user no longer exists', async () => {
    // Arrange
    const app = await createApp();
    const registerPayload = {
      email: uniqueEmail('stale-user'),
      password: 'Password123!',
      displayName: 'Stale User',
    };

    const registerResponse = await request(app)
      .post('/auth/register')
      .send(registerPayload);

    const token = registerResponse.body.token;
    await prisma.user.delete({ where: { id: registerResponse.body.user.id } });

    // Act
    const response = await request(app)
      .post('/lists')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Should fail' });

    // Assert
    expect(response.status).toBe(401);
    expect(response.body.message).toBe('Your account is no longer active.');
  });
});

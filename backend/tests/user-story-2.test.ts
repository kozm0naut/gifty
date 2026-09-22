import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../src/prisma.js';
import { createApp } from '../src/app.js';

const uniqueEmail = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`;

describe('User Story 2 - Item Management', () => {
  beforeEach(async () => {
    process.env.JWT_SECRET = 'test-secret';
    await prisma.sharePermission.deleteMany();
    await prisma.giftItem.deleteMany();
    await prisma.giftList.deleteMany();
    await prisma.user.deleteMany();
  });

  it('validates creation of a gift item', async () => {
    // Arrange
    const app = await createApp();

    const ownerResponse = await request(app).post('/auth/register').send({
      email: uniqueEmail('owner'),
      password: 'Password123!',
      displayName: 'Owner',
    });

    const listResponse = await request(app)
      .post('/lists')
      .set('Authorization', `Bearer ${ownerResponse.body.token}`)
      .send({ title: 'Validation List' });

    // Act
    // Invalid: Missing name
    const invalidNameResponse = await request(app)
      .post(`/lists/${listResponse.body.list.id}/items`)
      .set('Authorization', `Bearer ${ownerResponse.body.token}`)
      .send({
        description: 'No name',
        quantity: 1,
      });

    // Invalid: Quantity < 1
    const invalidQuantityResponse = await request(app)
      .post(`/lists/${listResponse.body.list.id}/items`)
      .set('Authorization', `Bearer ${ownerResponse.body.token}`)
      .send({
        name: 'Invalid Quantity',
        quantity: 0,
      });

    // Invalid: Negative unit price
    const invalidPriceResponse = await request(app)
      .post(`/lists/${listResponse.body.list.id}/items`)
      .set('Authorization', `Bearer ${ownerResponse.body.token}`)
      .send({
        name: 'Invalid Price',
        quantity: 1,
        unitPrice: -5,
      });

    // Valid: quantity is optional (FR-003) — omitting it must succeed
    const noQuantityResponse = await request(app)
      .post(`/lists/${listResponse.body.list.id}/items`)
      .set('Authorization', `Bearer ${ownerResponse.body.token}`)
      .send({
        name: 'No Quantity',
      });

    // Assert
    expect(invalidNameResponse.status).toBe(400);
    expect(invalidNameResponse.body.message).toBe('Gift item name is required');

    expect(invalidQuantityResponse.status).toBe(400);
    expect(invalidQuantityResponse.body.message).toBe('Quantity must be at least 1');

    expect(invalidPriceResponse.status).toBe(400);
    expect(invalidPriceResponse.body.message).toBe('Unit price must be a non-negative number');

    expect(noQuantityResponse.status).toBe(201);
    expect(noQuantityResponse.body.item.quantity ?? null).toBeNull();
  });

  it('enforces item immutability', async () => {
    // Arrange
    const app = await createApp();

    const ownerResponse = await request(app).post('/auth/register').send({
      email: uniqueEmail('owner'),
      password: 'Password123!',
      displayName: 'Owner',
    });

    const listResponse = await request(app)
      .post('/lists')
      .set('Authorization', `Bearer ${ownerResponse.body.token}`)
      .send({ title: 'Immutability List' });

    const itemResponse = await request(app)
      .post(`/lists/${listResponse.body.list.id}/items`)
      .set('Authorization', `Bearer ${ownerResponse.body.token}`)
      .send({
        name: 'Immutable Item',
        quantity: 1,
      });

    const itemId = itemResponse.body.item.id;

    // Act
    // Attempt to update
    const updateResponse = await request(app)
      .patch(`/items/${itemId}`)
      .set('Authorization', `Bearer ${ownerResponse.body.token}`)
      .send({
        name: 'Changed Name',
      });

    // Attempt to delete
    const deleteResponse = await request(app)
      .delete(`/items/${itemId}`)
      .set('Authorization', `Bearer ${ownerResponse.body.token}`);

    // Assert
    expect(updateResponse.status).toBe(403);
    expect(updateResponse.body.message).toBe('Gift items are immutable once created');

    expect(deleteResponse.status).toBe(403);
    expect(deleteResponse.body.message).toBe('Gift items are immutable once created');
  });
});

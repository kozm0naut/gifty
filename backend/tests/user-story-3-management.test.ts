import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../src/prisma.js';
import { createApp } from '../src/app.js';

const uniqueEmail = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`;

describe('User Story 3 - Permission Management', () => {
  beforeEach(async () => {
    process.env.JWT_SECRET = 'test-secret';
    await prisma.sharePermission.deleteMany();
    await prisma.giftItem.deleteMany();
    await prisma.giftList.deleteMany();
    await prisma.user.deleteMany();
  });

  it('lists all share permissions for a list', async () => {
    // Arrange
    const app = await createApp();

    // Setup Owner
    const ownerResponse = await request(app).post('/auth/register').send({
      email: uniqueEmail('owner'),
      password: 'Password123!',
      displayName: 'Owner',
    });
    const ownerToken = ownerResponse.body.token;

    // Setup List
    const listResponse = await request(app)
      .post('/lists')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ title: 'Permissions Test List' });
    const listId = listResponse.body.list.id;

    // Setup Recipient 1
    const recipient1Response = await request(app).post('/auth/register').send({
      email: uniqueEmail('r1'),
      password: 'Password123!',
      displayName: 'Recipient 1',
    });
    const r1Id = recipient1Response.body.user.id;

    // Setup Recipient 2
    const recipient2Response = await request(app).post('/auth/register').send({
      email: uniqueEmail('r2'),
      password: 'Password123!',
      displayName: 'Recipient 2',
    });
    const r2Id = recipient2Response.body.user.id;

    // Create Permissions
    await request(app)
      .post(`/lists/${listId}/share`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ recipientUserId: r1Id, permission: 'shared' as any });

    await request(app)
      .post(`/lists/${listId}/share`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ recipientUserId: r2Id, permission: 'shared' as any });

    // Act
    const getResponse = await request(app)
      .get(`/lists/${listId}/share-permissions`)
      .set('Authorization', `Bearer ${ownerToken}`);

    // Assert
    expect(getResponse.status).toBe(200);
    expect(getResponse.body.permissions).toHaveLength(2);
    
    const permissions = getResponse.body.permissions;
    expect(permissions.some((p: any) => p.recipientUserId === r1Id && p.permission === 'shared')).toBe(true);
    expect(permissions.some((p: any) => p.recipientUserId === r2Id && p.permission === 'shared')).toBe(true);
  });

  it('revokes a permission', async () => {
    // Arrange
    const app = await createApp();

    // Setup Owner
    const ownerResponse = await request(app).post('/auth/register').send({
      email: uniqueEmail('owner'),
      password: 'Password123!',
      displayName: 'Owner',
    });
    const ownerToken = ownerResponse.body.token;

    // Setup List
    const listResponse = await request(app)
      .post('/lists')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ title: 'Revocation Test List' });
    const listId = listResponse.body.list.id;

    // Setup Recipient
    const recipientResponse = await request(app).post('/auth/register').send({
      email: uniqueEmail('r1'),
      password: 'Password123!',
      displayName: 'Recipient 1',
    });
    const r1Id = recipientResponse.body.user.id;

    // Create Permission
    const shareResponse = await request(app)
      .post(`/lists/${listId}/share`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ recipientUserId: r1Id, permission: 'shared' });
    const permissionId = shareResponse.body.sharePermission.id;

    // Act
    const deleteResponse = await request(app)
      .delete(`/lists/${listId}/share/${permissionId}`)
      .set('Authorization', `Bearer ${ownerToken}`);

    // Verify revocation
    const getResponse = await request(app)
      .get(`/lists/${listId}/share-permissions`)
      .set('Authorization', `Bearer ${ownerToken}`);

    // Assert
    expect(deleteResponse.status).toBe(204);
    expect(getResponse.body.permissions).toHaveLength(0);
  });
});

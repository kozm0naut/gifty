import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../src/prisma.js';
import { createApp } from '../src/app.js';

const uniqueEmail = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`;

/** Extract the `gifty_access` value from a supertest Set-Cookie header. */
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

async function createList(app: any, owner: User, title: string) {
  const res = await request(app)
    .post('/lists')
    .set('Cookie', `gifty_access=${owner.access}`)
    .send({ title });
  return res.body.list.id as string;
}

beforeEach(async () => {
  process.env.JWT_SECRET = 'test-secret-32-characters-long-0000';
  await prisma.pendingInvitation.deleteMany();
  await prisma.sharePermission.deleteMany();
  await prisma.giftItem.deleteMany();
  await prisma.giftList.deleteMany();
  await prisma.userSession.deleteMany();
  await prisma.user.deleteMany();
});

describe('pending invitations (T032, 003 FR-010/003 FR-011, 003 SC-009)', () => {
  it('sharing to an unregistered email returns the same success shape as a registered share, with no 404 (003 FR-010, 003 SC-009)', async () => {
    const app = await createApp();
    const owner = await register(app, 'p1-owner', 'Owner');
    const registered = await register(app, 'p1-reg', 'Registered Recip');
    const listId = await createList(app, owner, 'Pending List');
    const unknownEmail = uniqueEmail('p1-unknown');

    const registeredShare = await request(app)
      .post(`/lists/${listId}/share`)
      .set('Cookie', `gifty_access=${owner.access}`)
      .send({ recipientUserId: registered.id, permission: 'shared' });
    expect(registeredShare.status).toBe(201);

    const pendingShare = await request(app)
      .post(`/lists/${listId}/share`)
      .set('Cookie', `gifty_access=${owner.access}`)
      .send({ recipientEmail: unknownEmail, permission: 'shared' });

    // Same status…
    expect(pendingShare.status).toBe(registeredShare.status);
    // …same body shape (sharePermission object with id + permission)…
    expect(pendingShare.status).toBe(201);
    expect(pendingShare.body.sharePermission).toBeTruthy();
    expect(pendingShare.body.sharePermission.permission).toBe('shared');
    expect(pendingShare.body.sharePermission.id).toBeTruthy();
    // …and no recipientUserId — the invitee does not exist yet.
    expect(pendingShare.body.sharePermission.recipientUserId).toBeNull();
    // …and the invite email is recorded.
    expect(pendingShare.body.sharePermission.recipientEmail).toBe(unknownEmail);
  });

  it('records a pending invitation with a normalized email (003 FR-010)', async () => {
    const app = await createApp();
    const owner = await register(app, 'p2-owner', 'Owner');
    const listId = await createList(app, owner, 'Pending List 2');
    const unknownEmail = uniqueEmail('p2-unknown');

    const res = await request(app)
      .post(`/lists/${listId}/share`)
      .set('Cookie', `gifty_access=${owner.access}`)
      .send({ recipientEmail: `  ${unknownEmail.toUpperCase()}  `, permission: 'shared' });
    expect(res.status).toBe(201);

    const invitation = await prisma.pendingInvitation.findUnique({
      where: { giftListId_inviteeEmail: { giftListId: listId, inviteeEmail: unknownEmail } },
    });
    expect(invitation).toBeTruthy();
    expect(invitation?.status).toBe('pending');
    expect(invitation?.ownerUserId).toBe(owner.id);
  });

  it('a pending invitation grants no access before the account exists (003 FR-010)', async () => {
    const app = await createApp();
    const owner = await register(app, 'p3-owner', 'Owner');
    const listId = await createList(app, owner, 'Pending List 3');
    const unknownEmail = uniqueEmail('p3-unknown');

    await request(app)
      .post(`/lists/${listId}/share`)
      .set('Cookie', `gifty_access=${owner.access}`)
      .send({ recipientEmail: unknownEmail, permission: 'shared' });

    // No share permission exists yet — the email alone is not an identity.
    const permission = await prisma.sharePermission.findFirst({
      where: { giftListId: listId, recipientEmail: unknownEmail },
    });
    expect(permission).toBeNull();

    // The owner's list view is unaffected (no extra recipient entry).
    const ownerLists = await request(app)
      .get('/lists')
      .set('Cookie', `gifty_access=${owner.access}`);
    const entry = ownerLists.body.lists.find((l: any) => l.id === listId);
    const recipients = entry.recipients ?? [];
    expect(recipients.some((r: any) => r.recipientEmail === unknownEmail || r.email === unknownEmail)).toBe(false);
  });

  it('registration of the invitee email converts the pending invitation into a share permission transactionally (003 FR-011, 003 SC-009)', async () => {
    const app = await createApp();
    const owner = await register(app, 'p4-owner', 'Owner');
    const listId = await createList(app, owner, 'Pending List 4');
    const inviteeEmail = uniqueEmail('p4-invitee');

    const shareRes = await request(app)
      .post(`/lists/${listId}/share`)
      .set('Cookie', `gifty_access=${owner.access}`)
      .send({ recipientEmail: inviteeEmail, permission: 'shared' });
    expect(shareRes.status).toBe(201);
    const pendingRow = await prisma.pendingInvitation.findFirst({ where: { inviteeEmail } });
    expect(pendingRow?.status).toBe('pending');

    // The invitee registers with the same email (uppercased + padded, to prove
    // normalization on match).
    const regRes = await request(app)
      .post('/auth/register')
      .send({ email: ` ${inviteeEmail.toUpperCase()} `, password: 'Password123!', displayName: 'New Invitee' });
    expect(regRes.status).toBe(201);
    const invitee = { id: regRes.body.user.id, access: accessCookie(regRes.headers['set-cookie']) };

    // Transactional conversion: permission exists, invitation matched.
    const permission = await prisma.sharePermission.findFirst({ where: { giftListId: listId, recipientUserId: invitee.id } });
    expect(permission).toBeTruthy();
    expect(permission?.recipientEmail).toBe(inviteeEmail);
    expect(permission?.nameDisclosureConsent).toBe('pending');
    const invitation = await prisma.pendingInvitation.findUnique({
      where: { giftListId_inviteeEmail: { giftListId: listId, inviteeEmail: inviteeEmail } },
    });
    expect(invitation?.status).toBe('matched');

    // The new user immediately has access to the list.
    const listsRes = await request(app)
      .get('/lists')
      .set('Cookie', `gifty_access=${invitee.access}`);
    expect(listsRes.status).toBe(200);
    expect(listsRes.body.lists.some((l: any) => l.id === listId)).toBe(true);

    const detailRes = await request(app)
      .get(`/lists/${listId}`)
      .set('Cookie', `gifty_access=${invitee.access}`);
    expect(detailRes.status).toBe(200);
  });

  it('re-shares to the same unregistered email do not duplicate pending invitations (edge case)', async () => {
    const app = await createApp();
    const owner = await register(app, 'p5-owner', 'Owner');
    const listId = await createList(app, owner, 'Pending List 5');
    const unknownEmail = uniqueEmail('p5-unknown');

    const first = await request(app)
      .post(`/lists/${listId}/share`)
      .set('Cookie', `gifty_access=${owner.access}`)
      .send({ recipientEmail: unknownEmail, permission: 'shared' });
    expect(first.status).toBe(201);
    const second = await request(app)
      .post(`/lists/${listId}/share`)
      .set('Cookie', `gifty_access=${owner.access}`)
      .send({ recipientEmail: unknownEmail, permission: 'shared' });
    expect(second.status).toBe(201);

    const rows = await prisma.pendingInvitation.findMany({ where: { inviteeEmail: unknownEmail } });
    expect(rows).toHaveLength(1);
  });

  it('discards pending invitations when the list is deleted (edge case)', async () => {
    const app = await createApp();
    const owner = await register(app, 'p6-owner', 'Owner');
    const listId = await createList(app, owner, 'Pending List 6');
    const unknownEmail = uniqueEmail('p6-unknown');

    await request(app)
      .post(`/lists/${listId}/share`)
      .set('Cookie', `gifty_access=${owner.access}`)
      .send({ recipientEmail: unknownEmail, permission: 'shared' });

    await request(app)
      .delete(`/lists/${listId}`)
      .set('Cookie', `gifty_access=${owner.access}`);

    const remaining = await prisma.pendingInvitation.findMany({ where: { inviteeEmail: unknownEmail } });
    expect(remaining).toHaveLength(0);
  });
});

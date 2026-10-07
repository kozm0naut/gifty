/**
 * T013 — US1: Recipient Invite Email
 *
 * Tests (test-first, MUST fail before T014):
 *  1. Share with registered recipient → exactly one invite OutboxMessage
 *  2. Share with unregistered email → same one invite; response indistinguishable (004 FR-002)
 *  3. Revoke + re-share → no second OutboxMessage (dedup, 004 FR-005)
 *  4. Different list, same recipient → new invite (dedup is per-list)
 *  5. Owner-facing response body unchanged (uniform share body from feature 003)
 */
import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../src/prisma.js';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config/index.js';

const uniqueEmail = (prefix: string) =>
  `${prefix.toLowerCase()}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`;

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

async function register(app: any, displayName: string) {
  const email = uniqueEmail(displayName);
  const res = await request(app)
    .post('/auth/register')
    .send({ email, password: 'Password123!', displayName });
  const cookie = accessCookie(res.headers['set-cookie']);
  // Email is enabled in this suite, so the account is unconfirmed and the
  // gate (004 FR-012) blocks list routes. Confirm it directly (the confirmation
  // mechanics are exercised in T015); this leaves no extra confirmation
  // outbox row so the invite-dedup counts below stay exact.
  const user = await prisma.user.findUnique({ where: { email } });
  if (user && user.verifiedAt == null) {
    await prisma.user.update({ where: { id: user.id }, data: { verifiedAt: new Date() } });
  }
  return { email, cookie };
}

async function createList(app: any, cookie: string, title: string) {
  const res = await request(app)
    .post('/lists')
    .set('Cookie', `gifty_access=${cookie}`)
    .send({ title });
  return res.body.list.id as string;
}

async function share(
  app: any,
  ownerCookie: string,
  listId: string,
  recipientEmail: string,
) {
  return request(app)
    .post(`/lists/${listId}/share`)
    .set('Cookie', `gifty_access=${ownerCookie}`)
    .send({ recipientEmail, permission: 'shared' });
}

describe('US1 — Recipient Invite Email (004 FR-001, 004 FR-002, 004 FR-005)', () => {
  let app: any;

  beforeEach(async () => {
    process.env.JWT_SECRET = 'test-secret';
    process.env.EMAIL_ENABLED = 'true';
    delete process.env.RESEND_API_KEY;
    delete process.env.RESEND_FROM;

    await prisma.outboxMessage.deleteMany();
    await prisma.auditEvent.deleteMany();
    await prisma.sharePermission.deleteMany();
    await prisma.pendingInvitation.deleteMany();
    await prisma.giftItem.deleteMany();
    await prisma.giftList.deleteMany();
    await prisma.user.deleteMany();

    app = await createApp();
  });

  it('T013.1: share with registered recipient → one invite outbox row', async () => {
    const { cookie: ownerCookie } = await register(app, 'Owner');
    const { email: recipientEmail } = await register(app, 'Recipient');
    const listId = await createList(app, ownerCookie, 'Invite List');

    const shareRes = await share(app, ownerCookie, listId, recipientEmail);
    expect(shareRes.status).toBe(201);

    const inviteLink = `${loadConfig().email.publicOrigin}/`;

    const rows = await prisma.outboxMessage.findMany({
      where: { listId, recipientEmail },
    });

    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.kind).toBe('invite');
    expect(row.recipientEmail).toBe(recipientEmail);
    expect(row.status).toBe('queued');
    expect(row.subject).toBeTruthy();
    expect(row.bodyText).toBeTruthy();
    expect(row.bodyText).toContain(inviteLink);
    expect(row.bodyHtml).toBeTruthy();
    expect(row.bodyHtml).toContain(inviteLink);
    // Invite link is the home page — no token, no deep-link (004 FR-013)
    expect(row.bodyText).not.toContain('token=');
  });

  it('T013.2: share with unregistered email → one invite, response indistinguishable (004 FR-002)', async () => {
    const { cookie: ownerCookie } = await register(app, 'Owner');
    const listId = await createList(app, ownerCookie, 'Invite List');

    const unregEmail = uniqueEmail('unreg');
    const unregRes = await share(app, ownerCookie, listId, unregEmail);
    expect(unregRes.status).toBe(201);

    const rows = await prisma.outboxMessage.findMany({
      where: { listId, recipientEmail: unregEmail },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('invite');
    expect(rows[0].status).toBe('queued');

    // Response shape must be identical to a registered-recipient share
    expect(unregRes.body.sharePermission).toBeDefined();
    expect(unregRes.body.sharePermission.permission).toBe('shared');
    expect(unregRes.body.sharePermission.recipientUserId).toBeNull();
    expect(unregRes.body.sharePermission.recipientEmail).toBe(unregEmail);
    expect(unregRes.body.sharePermission.id).toMatch(/^sp_/);
  });

  it('T013.3: revoke + re-share → no second outbox row (004 FR-005 dedup)', async () => {
    const { cookie: ownerCookie } = await register(app, 'Owner');
    const { email: recipientEmail } = await register(app, 'Recipient');
    const listId = await createList(app, ownerCookie, 'Dedup List');

    // First share → 1 outbox row
    const firstShare = await share(app, ownerCookie, listId, recipientEmail);
    expect(firstShare.status).toBe(201);
    expect(await prisma.outboxMessage.count({ where: { listId, recipientEmail } })).toBe(1);

    // Revoke via the owner's share-permissions view
    const permRes = await request(app)
      .get(`/lists/${listId}/share-permissions`)
      .set('Cookie', `gifty_access=${ownerCookie}`);
    expect(permRes.status).toBe(200);
    const permId = permRes.body.permissions[0].id as string;

    const revokeRes = await request(app)
      .delete(`/lists/${listId}/share/${permId}`)
      .set('Cookie', `gifty_access=${ownerCookie}`);
    expect(revokeRes.status).toBe(204);

    // Re-share → enqueueInvite hits P2002 → no-op
    const secondShare = await share(app, ownerCookie, listId, recipientEmail);
    expect(secondShare.status).toBe(201);

    // Still exactly one outbox row
    expect(await prisma.outboxMessage.count({ where: { listId, recipientEmail } })).toBe(1);
  });

  it('T013.4: different list, same recipient → new invite per list (per-list dedup)', async () => {
    const { cookie: ownerCookie } = await register(app, 'Owner');
    const { email: recipientEmail } = await register(app, 'Recipient');

    const list1 = await createList(app, ownerCookie, 'List A');
    const list2 = await createList(app, ownerCookie, 'List B');

    await share(app, ownerCookie, list1, recipientEmail);
    await share(app, ownerCookie, list2, recipientEmail);

    expect(await prisma.outboxMessage.count({ where: { listId: list1, recipientEmail } })).toBe(1);
    expect(await prisma.outboxMessage.count({ where: { listId: list2, recipientEmail } })).toBe(1);
    // Count invites only — the recipient's own email also receives a
    // confirmation row (US2) with listId null, which is out of scope here.
    expect(await prisma.outboxMessage.count({ where: { recipientEmail, kind: 'invite' } })).toBe(2);
  });

  it('T013.5: owner-facing response body unchanged (uniform share body from feature 003)', async () => {
    const { cookie: ownerCookie } = await register(app, 'owner');
    const { email: regEmail } = await register(app, 'recipreg');
    const unregEmail = uniqueEmail('unreg2');

    const listReg = await createList(app, ownerCookie, 'Uniform A');
    const listUnreg = await createList(app, ownerCookie, 'Uniform B');

    const regShare = await share(app, ownerCookie, listReg, regEmail);
    const unregShare = await share(app, ownerCookie, listUnreg, unregEmail);

    // Both 201, same shape (004 FR-002 / feature 003 FR-010)
    expect(regShare.status).toBe(201);
    expect(unregShare.status).toBe(201);

    const rb = regShare.body.sharePermission;
    const ub = unregShare.body.sharePermission;

    expect(rb.permission).toBe('shared');
    expect(rb.recipientUserId).toBeNull();
    expect(rb.recipientEmail).toBe(regEmail);
    expect(rb.id).toMatch(/^sp_/);

    expect(ub.permission).toBe('shared');
    expect(ub.recipientUserId).toBeNull();
    expect(ub.recipientEmail).toBe(unregEmail);
    expect(ub.id).toMatch(/^sp_/);
  });
});

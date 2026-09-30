import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../../src/prisma.js';
import { createApp } from '../../src/app.js';

/**
 * T041 — Share enumeration tests (FR-010, SC-009, US6 scenario 1).
 *
 * US6 independent test, contract form:
 *   - `POST /lists/:listId/share` to a **registered** email and to an
 *     **unregistered** email return an INDISTINGUISHABLE outcome — same
 *     status code and an identical response body — so a probe cannot tell
 *     whether an account exists for a given email;
 *   - the registered share is still held as a real `SharePermission` (so the
 *     recipient gets access immediately) while the unregistered one is held
 *     as a `PendingInvitation` — the *underlying* record differs, but the
 *     *response* never reveals which;
 *   - neither response carries a fingerprint in the returned `id` (the
 *     registered record id is `share_*`, the invitation id is `invite_*`;
 *     echoing the real id would leak registration), so the email path
 *     returns a uniform, neutral id.
 *
 * This test drives the T042 hardening: it FAILS against the pre-fix router,
 * which returned `200` (re-share) / a full `SharePermission` row for a
 * registered recipient but `201` / a synthetic body for an unregistered one.
 */

const uniqueEmail = (p: string) =>
  `${p}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`;

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

beforeEach(async () => {
  process.env.JWT_SECRET = 'test-secret-32-characters-long-0000';
  process.env.NODE_ENV = 'test';
  await prisma.pendingInvitation.deleteMany();
  await prisma.sharePermission.deleteMany();
  await prisma.giftItem.deleteMany();
  await prisma.giftList.deleteMany();
  await prisma.userSession.deleteMany();
  await prisma.user.deleteMany();
});

describe('T041 share enumeration (FR-010, SC-009)', () => {
  it('a registered email and an unregistered email produce an indistinguishable share response (FR-010)', async () => {
    const app = await createApp();
    const owner = await register(app, 't41-owner', 'Owner');
    const unknownEmail = uniqueEmail('t41-unknown');

    const listRes = await request(app)
      .post('/lists')
      .set('Cookie', `gifty_access=${owner.access}`)
      .send({ title: 'T41 List' });
    const listId = listRes.body.list.id;

    // A registered email we control the value of (the enumeration vector is
    // the email), plus an unregistered one.
    const regEmail = uniqueEmail('t41-regemail');
    await request(app)
      .post('/auth/register')
      .send({ email: regEmail, password: 'Password123!', displayName: 'RegEmail' });

    const byRegisteredEmail = await request(app)
      .post(`/lists/${listId}/share`)
      .set('Cookie', `gifty_access=${owner.access}`)
      .send({ recipientEmail: regEmail, permission: 'shared' });

    const byUnknownEmail = await request(app)
      .post(`/lists/${listId}/share`)
      .set('Cookie', `gifty_access=${owner.access}`)
      .send({ recipientEmail: unknownEmail, permission: 'shared' });

    // Same status code (FR-010): no 404 / no 200-vs-201 distinction.
    expect(byRegisteredEmail.status).toBe(201);
    expect(byUnknownEmail.status).toBe(byRegisteredEmail.status);

    const a = byRegisteredEmail.body.sharePermission;
    const b = byUnknownEmail.body.sharePermission;

    // Identical body SHAPE: the same set of keys on both (the only fields that
    // may legitimately differ between two distinct shares are the unique `id`
    // and the `recipientEmail` — the input).
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
    expect(a.permission).toBe(b.permission);
    expect(a.permission).toBe('shared');
    // No account-existence signal: recipientUserId is null on both.
    expect(a.recipientUserId).toBeNull();
    expect(b.recipientUserId).toBeNull();

    // Neither response leaks the underlying record's real id prefix
    // (registered = `share_*`, invitation = `invite_*`) — a neutral id.
    expect(typeof a.id).toBe('string');
    expect(typeof b.id).toBe('string');
    expect(a.id).not.toMatch(/^share_/);
    expect(a.id).not.toMatch(/^invite_/);
    expect(b.id).not.toMatch(/^share_/);
    expect(b.id).not.toMatch(/^invite_/);
  });

  it('the registered email share is held as a SharePermission, the unregistered as a PendingInvitation', async () => {
    const app = await createApp();
    const owner = await register(app, 't41b-owner', 'Owner');
    const regEmail = uniqueEmail('t41b-reg');
    await request(app).post('/auth/register').send({ email: regEmail, password: 'Password123!', displayName: 'RegB' });

    const listRes = await request(app)
      .post('/lists').set('Cookie', `gifty_access=${owner.access}`).send({ title: 'T41b List' });
    const listId = listRes.body.list.id;

    await request(app).post(`/lists/${listId}/share`).set('Cookie', `gifty_access=${owner.access}`).send({ recipientEmail: regEmail, permission: 'shared' });
    await request(app).post(`/lists/${listId}/share`).set('Cookie', `gifty_access=${owner.access}`).send({ recipientEmail: uniqueEmail('t41b-unknown'), permission: 'shared' });

    // The underlying records differ (that is correct) — the response just must
    // not reveal which is which.
    const permission = await prisma.sharePermission.findFirst({ where: { giftListId: listId, recipientEmail: regEmail } });
    expect(permission).toBeTruthy();
    const invitation = await prisma.pendingInvitation.findMany({ where: { giftListId: listId } });
    expect(invitation.some((i) => i.inviteeEmail.endsWith('@example.com'))).toBe(true);
  });

  it('a re-share to the same (registered) email is still indistinguishable from a first unregistered share', async () => {
    const app = await createApp();
    const owner = await register(app, 't41c-owner', 'Owner');
    const regEmail = uniqueEmail('t41c-reg');
    await request(app).post('/auth/register').send({ email: regEmail, password: 'Password123!', displayName: 'RegC' });

    const listRes = await request(app)
      .post('/lists').set('Cookie', `gifty_access=${owner.access}`).send({ title: 'T41c List' });
    const listId = listRes.body.list.id;

    const first = await request(app)
      .post(`/lists/${listId}/share`).set('Cookie', `gifty_access=${owner.access}`)
      .send({ recipientEmail: regEmail, permission: 'shared' });
    const again = await request(app)
      .post(`/lists/${listId}/share`).set('Cookie', `gifty_access=${owner.access}`)
      .send({ recipientEmail: regEmail, permission: 'shared' });

    // A re-share must not downgrade to a 200 / different shape that a probe
    // could use to infer the account already exists (SC-009).
    expect(first.status).toBe(201);
    expect(again.status).toBe(first.status);
    // Same shape and fixed values (the per-call neutral `id` may differ).
    expect(Object.keys(again.body.sharePermission).sort()).toEqual(Object.keys(first.body.sharePermission).sort());
    expect(again.body.sharePermission.recipientUserId).toBeNull();
    expect(again.body.sharePermission.permission).toBe('shared');
  });
});

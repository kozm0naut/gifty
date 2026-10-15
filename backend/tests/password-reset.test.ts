/**
 * T009 — US1: Consume a reset link (`POST /auth/reset`).
 *
 * Test-first (Constitution III) — MUST FAIL before T011–T013 implement the
 * endpoint. `POST /auth/reset` does not exist yet, so every assertion on the
 * pinned success body / cookie pair / password rewrite fails.
 *
 * US1 coverage (005 FR-003, FR-008, FR-013, FR-014; SC-004, SC-006):
 *   T009.1  Happy path consumes the token + rewrites `passwordHash`: the old
 *           password is 401 and the new password logs in (SC-004).
 *   T009.2  Success returns `200 S` (`verified: true`) **and** sets the
 *           `gifty_access` + `gifty_refresh` cookie pair (FR-014).
 *   T009.3  A previously-unconfirmed account has `verifiedAt` set after the
 *           reset (FR-013, SC-006).
 *   T009.4  The endpoint requires no prior session (unauthenticated, FR-014).
 *   T009.5  An unknown token returns the pinned `400 I` body (FR-004).
 *
 * (US2 hardening — replay / expiry / sibling invalidation / session revocation
 *  / FR-010 smoke — is added by T017.)
 */
import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../src/prisma.js';
import { createApp } from '../src/app.js';
import { __resetRateLimitersForTesting } from '../src/auth/rate-limit.js';

/** Pinned invalid-link body (contracts/api.md, FR-004). */
const I_BODY = { message: 'This reset link is invalid or has expired.' };

const OLD_PASSWORD = 'Password123!';
const NEW_PASSWORD = 'NewPassword123!';

const uniqueEmail = (prefix: string) =>
  `${prefix.toLowerCase()}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`;

function cookieValue(setCookieHeader: unknown, name: string): string | null {
  const arr = Array.isArray(setCookieHeader)
    ? setCookieHeader
    : setCookieHeader
      ? [setCookieHeader]
      : [];
  for (const c of arr) {
    const s = String(c);
    if (s.startsWith(`${name}=`)) {
      return s.split(';')[0].slice(`${name}=`.length);
    }
  }
  return null;
}

async function register(app: any, email: string, password: string = OLD_PASSWORD) {
  const res = await request(app)
    .post('/auth/register')
    .send({ email, password, displayName: 'Reset Tester' });
  expect(res.status).toBe(201);
  return { email };
}

/** Request a reset and pull the raw token out of the captured outbox link. */
async function requestResetToken(app: any, email: string): Promise<string> {
  const res = await request(app).post('/auth/reset-request').send({ email });
  expect(res.status).toBe(200);
  const row = await prisma.outboxMessage.findFirst({
    where: { recipientEmail: email, kind: 'reset' },
  });
  expect(row).not.toBeNull();
  const m = row!.bodyText.match(/\/reset\/([A-Za-z0-9\-_~=%]+)/);
  if (!m) throw new Error('no /reset/<token> link in the reset outbox body');
  return decodeURIComponent(m[1]);
}

async function resetDb() {
  await prisma.outboxMessage.deleteMany();
  await prisma.auditEvent.deleteMany();
  await prisma.passwordResetToken.deleteMany();
  await prisma.pendingInvitation.deleteMany();
  await prisma.sharePermission.deleteMany();
  await prisma.giftItem.deleteMany();
  await prisma.giftList.deleteMany();
  await prisma.userSession.deleteMany();
  await prisma.user.deleteMany();
}

describe('T009 — Consume a reset link (005 FR-003, FR-008, FR-013, FR-014, SC-004, SC-006)', () => {
  let app: any;

  beforeEach(async () => {
    process.env.JWT_SECRET = 'test-secret-32-characters-long-0000';
    process.env.EMAIL_ENABLED = 'true';
    delete process.env.RESEND_API_KEY;
    delete process.env.RESEND_FROM;

    __resetRateLimitersForTesting();
    await resetDb();
    app = await createApp();
  });

  it('T009.1: happy path — old password rejected (401), new password logs in (SC-004)', async () => {
    const email = uniqueEmail('recovery');
    await register(app, email);
    const token = await requestResetToken(app, email);

    const res = await request(app)
      .post('/auth/reset')
      .send({ token, newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD });
    expect(res.status).toBe(200);

    // Old password is immediately rejected (FR-008).
    const oldLogin = await request(app)
      .post('/auth/login')
      .send({ email, password: OLD_PASSWORD });
    expect(oldLogin.status).toBe(401);

    // New password is accepted (SC-004).
    const newLogin = await request(app)
      .post('/auth/login')
      .send({ email, password: NEW_PASSWORD });
    expect(newLogin.status).toBe(200);
    expect(newLogin.body.user.email).toBe(email);
    expect(cookieValue(newLogin.headers['set-cookie'], 'gifty_access')).not.toBeNull();
  });

  it('T009.2: success returns 200 S (verified:true) and the gifty_access + gifty_refresh cookie pair (FR-014)', async () => {
    const email = uniqueEmail('cookies');
    await register(app, email);
    const token = await requestResetToken(app, email);

    const res = await request(app)
      .post('/auth/reset')
      .send({ token, newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('reset');
    expect(res.body.user).toBeDefined();
    expect(res.body.user.email).toBe(email);
    expect(res.body.user.verified).toBe(true);

    // FR-014: a fresh session cookie pair is set on the resetting device.
    const access = cookieValue(res.headers['set-cookie'], 'gifty_access');
    const refresh = cookieValue(res.headers['set-cookie'], 'gifty_refresh');
    expect(access).not.toBeNull();
    expect(refresh).not.toBeNull();
  });

  it('T009.3: a previously-unconfirmed account gets verifiedAt set after the reset (FR-013, SC-006)', async () => {
    const email = uniqueEmail('unconfirmed');
    // Email enabled + capture mode ⇒ the freshly registered account is
    // unconfirmed (verifiedAt null).
    await register(app, email);
    const before = await prisma.user.findUnique({ where: { email } });
    expect(before?.verifiedAt).toBeNull();

    const token = await requestResetToken(app, email);
    const res = await request(app)
      .post('/auth/reset')
      .send({ token, newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD });
    expect(res.status).toBe(200);

    const after = await prisma.user.findUnique({ where: { email } });
    expect(after?.verifiedAt).not.toBeNull();
  });

  it('T009.4: the endpoint requires no prior session (unauthenticated, FR-014)', async () => {
    const email = uniqueEmail('nosession');
    await register(app, email);
    const token = await requestResetToken(app, email);

    // No cookie is sent at all — the reset must still succeed.
    const res = await request(app)
      .post('/auth/reset')
      .set('Cookie', '')
      .send({ token, newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('reset');
  });

  it('T009.5: an unknown token returns the pinned 400 I body (FR-004)', async () => {
    const email = uniqueEmail('badtoken');
    await register(app, email);

    const res = await request(app)
      .post('/auth/reset')
      .send({
        token: 'does-not-exist-0000000000000000000000000000',
        newPassword: NEW_PASSWORD,
        confirmPassword: NEW_PASSWORD,
      });
    expect(res.status).toBe(400);
    expect(res.body).toEqual(I_BODY);
  });
});

/**
 * T017 — US2 hardening (005 FR-004, FR-005, FR-010, FR-012, FR-014, SC-003).
 *
 * These tests lock in US2 behaviors already present in `POST /auth/reset`
 * (replay, expiry, sibling invalidation, session revocation, FR-010 smoke).
 * Written test-first per Constitution III; expected to PASS against the
 * current implementation.
 */

/** Pull ALL raw reset tokens for an email (insertion order). */
async function allResetTokens(app: any, email: string): Promise<string[]> {
  const rows = await prisma.outboxMessage.findMany({
    where: { recipientEmail: email, kind: 'reset' },
    orderBy: { createdAt: 'asc' },
  });
  return rows
    .map((r) => {
      const m = r.bodyText.match(/\/reset\/([A-Za-z0-9\-_~=%]+)/);
      return m ? decodeURIComponent(m[1]) : null;
    })
    .filter((t): t is string => t !== null);
}

describe('T017 — US2 hardening (005 FR-004, FR-005, FR-010, FR-012, FR-014, SC-003)', () => {
  let app: any;

  beforeEach(async () => {
    process.env.JWT_SECRET = 'test-secret-32-characters-long-0000';
    process.env.EMAIL_ENABLED = 'true';
    delete process.env.RESEND_API_KEY;
    delete process.env.RESEND_FROM;
    __resetRateLimitersForTesting();
    await resetDb();
    app = await createApp();
  });

  it('T017.1: replay — a consumed token returns 400 I on second use; original new password unaffected (SC-003)', async () => {
    const email = uniqueEmail('replay');
    await register(app, email);
    const token = await requestResetToken(app, email);

    const first = await request(app)
      .post('/auth/reset')
      .send({ token, newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD });
    expect(first.status).toBe(200);

    const replay = await request(app)
      .post('/auth/reset')
      .send({ token, newPassword: 'AnotherPass123!', confirmPassword: 'AnotherPass123!' });
    expect(replay.status).toBe(400);
    expect(replay.body).toEqual(I_BODY);

    // Original new password still valid — the replay did NOT overwrite it.
    const login = await request(app)
      .post('/auth/login')
      .send({ email, password: NEW_PASSWORD });
    expect(login.status).toBe(200);
  });

  it('T017.2: expired token — 400 I body, no state change (FR-005)', async () => {
    const email = uniqueEmail('expired');
    await register(app, email);
    const token = await requestResetToken(app, email);

    const user = await prisma.user.findUnique({ where: { email } });
    await prisma.passwordResetToken.updateMany({
      where: { userId: user!.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const res = await request(app)
      .post('/auth/reset')
      .send({ token, newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD });
    expect(res.status).toBe(400);
    expect(res.body).toEqual(I_BODY);

    // Password unchanged — the expired token consumed nothing.
    const login = await request(app)
      .post('/auth/login')
      .send({ email, password: OLD_PASSWORD });
    expect(login.status).toBe(200);
  });

  it('T017.3: sibling invalidation — consuming token A invalidates pending token B (FR-012)', async () => {
    const email = uniqueEmail('siblings');
    await register(app, email);

    // Two reset requests → two tokens in the outbox.
    await request(app).post('/auth/reset-request').send({ email });
    await request(app).post('/auth/reset-request').send({ email });

    const tokens = await allResetTokens(app, email);
    expect(tokens).toHaveLength(2);
    const [tokenA, tokenB] = tokens;

    const consumeA = await request(app)
      .post('/auth/reset')
      .send({ token: tokenA, newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD });
    expect(consumeA.status).toBe(200);

    // Token B is now invalidated by sibling-invalidation (FR-012).
    const consumeB = await request(app)
      .post('/auth/reset')
      .send({ token: tokenB, newPassword: 'AnotherPass123!', confirmPassword: 'AnotherPass123!' });
    expect(consumeB.status).toBe(400);
    expect(consumeB.body).toEqual(I_BODY);

    // Password from token A is the active one.
    const login = await request(app)
      .post('/auth/login')
      .send({ email, password: NEW_PASSWORD });
    expect(login.status).toBe(200);
  });

  it('T017.4: session revocation — pre-reset session is 401 after reset; new session works (FR-012, FR-014)', async () => {
    const email = uniqueEmail('revoked');

    const regRes = await request(app)
      .post('/auth/register')
      .send({ email, password: OLD_PASSWORD, displayName: 'Reset Tester' });
    expect(regRes.status).toBe(201);
    const oldCookie = cookieValue(regRes.headers['set-cookie'], 'gifty_access');
    expect(oldCookie).not.toBeNull();

    // Old session is live.
    const before = await request(app)
      .get('/account')
      .set('Cookie', `gifty_access=${oldCookie}`);
    expect(before.status).toBe(200);

    // Perform a reset (no prior session).
    const token = await requestResetToken(app, email);
    const resetRes = await request(app)
      .post('/auth/reset')
      .set('Cookie', '')
      .send({ token, newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD });
    expect(resetRes.status).toBe(200);

    // New session cookie is set.
    const newCookie = cookieValue(resetRes.headers['set-cookie'], 'gifty_access');
    expect(newCookie).not.toBeNull();

    // Old session is now revoked → 401.
    const oldAfter = await request(app)
      .get('/account')
      .set('Cookie', `gifty_access=${oldCookie}`);
    expect(oldAfter.status).toBe(401);

    // New session works.
    const newAfter = await request(app)
      .get('/account')
      .set('Cookie', `gifty_access=${newCookie}`);
    expect(newAfter.status).toBe(200);
  });

  it('T017.5: FR-010 smoke — reset does not alter gift lists, items, or ownership (FR-010)', async () => {
    const email = uniqueEmail('fr010');
    const regRes = await request(app)
      .post('/auth/register')
      .send({ email, password: OLD_PASSWORD, displayName: 'FR-010 Tester' });
    expect(regRes.status).toBe(201);

    const user = await prisma.user.findUnique({ where: { email } });
    const list = await prisma.giftList.create({
      data: { ownerUserId: user!.id, title: 'FR-010 Test List' },
    });
    const item = await prisma.giftItem.create({
      data: { giftListId: list.id, name: 'Test Item' },
    });

    // Perform the reset.
    const token = await requestResetToken(app, email);
    const resetRes = await request(app)
      .post('/auth/reset')
      .set('Cookie', '')
      .send({ token, newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD });
    expect(resetRes.status).toBe(200);

    // List and item are unchanged.
    const listAfter = await prisma.giftList.findUnique({ where: { id: list.id } });
    expect(listAfter).not.toBeNull();
    expect(listAfter!.ownerUserId).toBe(user!.id);
    expect(listAfter!.title).toBe('FR-010 Test List');
    expect(listAfter!.status).toBe('active');

    const itemAfter = await prisma.giftItem.findUnique({ where: { id: item.id } });
    expect(itemAfter).not.toBeNull();
    expect(itemAfter!.name).toBe('Test Item');
    expect(itemAfter!.state).toBe('available');

    // Owner can still access the list with the new session cookie.
    const newCookie = cookieValue(resetRes.headers['set-cookie'], 'gifty_access')!;
    const getRes = await request(app)
      .get(`/lists/${list.id}`)
      .set('Cookie', `gifty_access=${newCookie}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.list.id).toBe(list.id);
    expect(getRes.body.list.items).toHaveLength(1);
    expect(getRes.body.list.items[0].name).toBe('Test Item');
    expect(getRes.body.list.items[0].state).toBe('available');
  });
});

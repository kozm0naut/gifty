/**
 * T015 — US2: Account Confirmation Email
 *
 * Tests (test-first, MUST fail before T016–T020):
 *   1. register → one confirmation OutboxMessage (kind=confirmation, body has
 *      a /confirm?token= link); 201 body gains `verified: false`.
 *   2. GET /confirm?token=<valid> → 200 {status:'confirmed'}; verifiedAt set;
 *      verificationTokenHash cleared; gate lifted.
 *   3. Same token again → same 200 body (FR-004, idempotent).
 *   4. Expired token → same 200 body (FR-010).
 *   5. Unknown token → same 200 body (FR-010).
 *   6. No token → same 200 body (FR-010).
 *   7. Unconfirmed hits GET /lists → 403 stable body (FR-012 gate).
 *   8. Unconfirmed hits GET /account → 200 (allow-list).
 *   9. Unconfirmed POST /auth/refresh → 200 (allow-list).
 *  10. Unconfirmed POST /auth/logout → 204 (allow-list).
 *  11. Resend (unconfirmed) → 202; new token supersedes; new OutboxMessage.
 *  12. 4th resend within window (budget 3) → 429 (FR-014).
 *  13. Resend on confirmed account → 403.
 *  14. disabled mode: register → verified:true, no OutboxMessage, no gate.
 */
import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../src/prisma.js';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config/index.js';
import { __resetRateLimitersForTesting } from '../src/auth/rate-limit.js';

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

async function register(app: any, displayName: string, email?: string) {
  const e = email ?? uniqueEmail(displayName);
  const res = await request(app)
    .post('/auth/register')
    .send({ email: e, password: 'Password123!', displayName });
  return { email: e, cookie: accessCookie(res.headers['set-cookie']), res };
}

/** Extract the raw token from a confirmation body's /confirm?token= link. */
function tokenFromBody(bodyText: string): string {
  const m = bodyText.match(/\/confirm\?token=([^&\s]+)/);
  if (!m) throw new Error('no /confirm?token= link in body');
  return decodeURIComponent(m[1]);
}

/** A uniform, non-error body: exactly `{ status: 'confirmed' }`. */
function expectUniformConfirm(res: any) {
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ status: 'confirmed' });
}

async function resetDb() {
  await prisma.outboxMessage.deleteMany();
  await prisma.auditEvent.deleteMany();
  await prisma.sharePermission.deleteMany();
  await prisma.pendingInvitation.deleteMany();
  await prisma.giftItem.deleteMany();
  await prisma.giftList.deleteMany();
  await prisma.user.deleteMany();
}

describe('US2 — Account Confirmation (FR-003, FR-004, FR-010, FR-012, FR-014)', () => {
  let app: any;

  beforeEach(async () => {
    process.env.JWT_SECRET = 'test-secret';
    process.env.EMAIL_ENABLED = 'true';
    delete process.env.RESEND_API_KEY;
    delete process.env.RESEND_FROM;

    __resetRateLimitersForTesting();
    await resetDb();
    app = await createApp();
  });

  it('T015.1: register → one confirmation outbox row; 201 body has verified:false', async () => {
    const { email, res } = await register(app, 'Newbie');

    // 201 body gains the `verified` field (false when email enabled)
    expect(res.status).toBe(201);
    expect(res.body.user.verified).toBe(false);

    const rows = await prisma.outboxMessage.findMany({ where: { recipientEmail: email } });
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.kind).toBe('confirmation');
    expect(row.listId).toBeNull();
    expect(row.status).toBe('queued');
    expect(row.subject).toBeTruthy();
    expect(row.bodyText).toContain('/confirm?token=');
  });

  it('T015.2: valid token → confirmed; gate lifted; hash cleared', async () => {
    const { email, cookie } = await register(app, 'ConfirmMe');
    const row = await prisma.outboxMessage.findFirst({ where: { recipientEmail: email } });
    const token = tokenFromBody(row!.bodyText);

    const res = await request(app).get(`/confirm?token=${encodeURIComponent(token)}`);
    expectUniformConfirm(res);

    const user = await prisma.user.findUnique({ where: { email } });
    expect(user?.verifiedAt).not.toBeNull();
    expect(user?.verificationTokenHash).toBeNull();

    // Gate lifted: the same access cookie now reaches a gated route.
    const listRes = await request(app)
      .get('/lists')
      .set('Cookie', `gifty_access=${cookie}`);
    expect(listRes.status).toBe(200);
  });

  it('T015.3: same token again → same uniform 200 body (idempotent, FR-004)', async () => {
    const { email } = await register(app, 'Repeat');
    const row = await prisma.outboxMessage.findFirst({ where: { recipientEmail: email } });
    const token = tokenFromBody(row!.bodyText);

    const first = await request(app).get(`/confirm?token=${encodeURIComponent(token)}`);
    const second = await request(app).get(`/confirm?token=${encodeURIComponent(token)}`);
    expectUniformConfirm(first);
    expectUniformConfirm(second);
    expect(second.body).toEqual(first.body);
  });

  it('T015.4: expired token → same uniform 200 body (FR-010)', async () => {
    const { email } = await register(app, 'Expired');
    const row = await prisma.outboxMessage.findFirst({ where: { recipientEmail: email } });
    const token = tokenFromBody(row!.bodyText);

    // Force-expire the token directly on the user row.
    await prisma.user.update({
      where: { email },
      data: { verificationExpiresAt: new Date(Date.now() - 60_000) },
    });

    const res = await request(app).get(`/confirm?token=${encodeURIComponent(token)}`);
    expectUniformConfirm(res);

    // No state change: still unconfirmed.
    const user = await prisma.user.findUnique({ where: { email } });
    expect(user?.verifiedAt).toBeNull();
  });

  it('T015.5: unknown token → same uniform 200 body (FR-010)', async () => {
    const res = await request(app).get('/confirm?token=garbage-token-that-matches-nothing');
    expectUniformConfirm(res);
  });

  it('T015.6: no token → same uniform 200 body (FR-010)', async () => {
    const res = await request(app).get('/confirm');
    expectUniformConfirm(res);
  });

  it('T015.7: unconfirmed GET /lists → 403 stable body (gate)', async () => {
    const { cookie } = await register(app, 'Gated');
    const res = await request(app)
      .get('/lists')
      .set('Cookie', `gifty_access=${cookie}`);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ message: 'Please confirm your email to continue.' });
  });

  it('T015.8: unconfirmed GET /account → 200 (allow-list)', async () => {
    const { cookie } = await register(app, 'Allow');
    const res = await request(app)
      .get('/account')
      .set('Cookie', `gifty_access=${cookie}`);
    expect(res.status).toBe(200);
    expect(res.body.user.verified).toBe(false);
  });

  it('T015.9: unconfirmed POST /auth/refresh → 200 (allow-list)', async () => {
    const { email, res: regRes } = await register(app, 'RefreshAllow');
    const setCookieRaw = regRes.headers['set-cookie'] as unknown;
    const setCookies: string[] = Array.isArray(setCookieRaw)
      ? setCookieRaw
      : setCookieRaw
        ? [setCookieRaw]
        : [];
    const refreshCookie = setCookies
      .map((s) => String(s))
      .find((s) => s.startsWith('gifty_refresh='))!
      .split(';')[0]
      .slice('gifty_refresh='.length);

    const res = await request(app)
      .post('/auth/refresh')
      .set('Cookie', `gifty_refresh=${refreshCookie}`);
    expect(res.status).toBe(200);
    void email;
  });

  it('T015.10: unconfirmed POST /auth/logout → 204 (allow-list)', async () => {
    const { cookie } = await register(app, 'LogoutAllow');
    const res = await request(app)
      .post('/auth/logout')
      .set('Cookie', `gifty_access=${cookie}`);
    expect(res.status).toBe(204);
  });

  it('T015.11: resend (unconfirmed) → 202; new token supersedes; new row', async () => {
    const { email, cookie } = await register(app, 'ResendMe');
    const before = await prisma.outboxMessage.count({ where: { recipientEmail: email } });
    const oldRow = await prisma.outboxMessage.findFirst({ where: { recipientEmail: email } });
    const oldToken = tokenFromBody(oldRow!.bodyText);

    const res = await request(app)
      .post('/auth/resend-confirmation')
      .set('Cookie', `gifty_access=${cookie}`);
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ message: 'A new confirmation email is on its way.' });

    const after = await prisma.outboxMessage.count({ where: { recipientEmail: email } });
    expect(after).toBe(before + 1);

    // New token supersedes the old: old token no longer confirms.
    const newRow = await prisma.outboxMessage.findFirst({
      where: { recipientEmail: email },
      orderBy: { createdAt: 'desc' },
    });
    const newToken = tokenFromBody(newRow!.bodyText);
    expect(newToken).not.toBe(oldToken);

    // Old token is now invalid (hash was overwritten by the re-issue).
    const oldUse = await request(app).get(`/confirm?token=${encodeURIComponent(oldToken)}`);
    expectUniformConfirm(oldUse);
    const user = await prisma.user.findUnique({ where: { email } });
    expect(user?.verifiedAt).toBeNull();

    // New token still works.
    const newUse = await request(app).get(`/confirm?token=${encodeURIComponent(newToken)}`);
    expectUniformConfirm(newUse);
    const user2 = await prisma.user.findUnique({ where: { email } });
    expect(user2?.verifiedAt).not.toBeNull();
  });

  it('T015.12: 4th resend within window (budget 3) → 429 (FR-014)', async () => {
    const { cookie } = await register(app, 'FloodMe');

    // Budget is 3 (RESEND_MAX_PER_ACCOUNT default). First 3 succeed...
    for (let i = 0; i < 3; i++) {
      const ok = await request(app)
        .post('/auth/resend-confirmation')
        .set('Cookie', `gifty_access=${cookie}`);
      expect(ok.status).toBe(202);
    }
    // ...the 4th is throttled.
    const throttled = await request(app)
      .post('/auth/resend-confirmation')
      .set('Cookie', `gifty_access=${cookie}`);
    expect(throttled.status).toBe(429);
    expect(throttled.body).toEqual({
      message: 'Too many confirmation requests. Please wait a moment and try again.',
    });
  });

  it('T015.13: resend on a confirmed account → 403', async () => {
    const { email, cookie } = await register(app, 'AlreadyOk');
    const row = await prisma.outboxMessage.findFirst({ where: { recipientEmail: email } });
    const token = tokenFromBody(row!.bodyText);
    await request(app).get(`/confirm?token=${encodeURIComponent(token)}`);

    const res = await request(app)
      .post('/auth/resend-confirmation')
      .set('Cookie', `gifty_access=${cookie}`);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ message: 'Your email is already confirmed.' });
  });

  it('T015.14: disabled mode → register auto-confirms; no outbox row; no gate', async () => {
    process.env.EMAIL_ENABLED = 'false';
    await resetDb();
    const disabledApp = await createApp();

    const email = uniqueEmail('disabled');
    const res = await request(disabledApp)
      .post('/auth/register')
      .send({ email, password: 'Password123!', displayName: 'Disabled' });
    expect(res.status).toBe(201);
    expect(res.body.user.verified).toBe(true);

    const cookie = accessCookie(res.headers['set-cookie']);

    // No confirmation email was enqueued.
    expect(await prisma.outboxMessage.count({ where: { recipientEmail: email } })).toBe(0);

    // Account is confirmed server-side.
    const user = await prisma.user.findUnique({ where: { email } });
    expect(user?.verifiedAt).not.toBeNull();

    // No gate: a gated route is reachable.
    const listRes = await request(disabledApp)
      .get('/lists')
      .set('Cookie', `gifty_access=${cookie}`);
    expect(listRes.status).toBe(200);
  });
});

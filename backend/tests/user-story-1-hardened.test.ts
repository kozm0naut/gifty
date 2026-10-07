import request from 'supertest';
import jwt from 'jsonwebtoken';
import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../src/prisma.js';
import { createApp } from '../src/app.js';

const uniqueEmail = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`;

function parseSetCookies(res: any): string[] {
  const raw = res.headers['set-cookie'];
  return Array.isArray(raw) ? raw : raw ? [raw] : [];
}

beforeEach(async () => {
  process.env.JWT_SECRET = 'test-secret-32-characters-long-0000';
  await prisma.sharePermission.deleteMany();
  await prisma.giftItem.deleteMany();
  await prisma.giftList.deleteMany();
  await prisma.userSession.deleteMany();
  await prisma.user.deleteMany();
});

describe('US1 hardened sign-in flow (T012, 003 FR-020)', () => {
  it('returns a uniform 401 for an unknown email and a wrong password', async () => {
    const app = await createApp();
    const known = uniqueEmail('uniform');
    await request(app)
      .post('/auth/register')
      .send({ email: known, password: 'Password123!', displayName: 'U' });

    const unknown = await request(app)
      .post('/auth/login')
      .send({ email: uniqueEmail('ghost'), password: 'Whatever1!' });
    const wrong = await request(app)
      .post('/auth/login')
      .send({ email: known, password: 'WrongPass1!' });

    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(unknown.body).toEqual(wrong.body);
  });

  it('keeps unknown-email and wrong-password responses in the same timing class (003 FR-020)', async () => {
    const app = await createApp();
    const known = uniqueEmail('timing');
    await request(app)
      .post('/auth/register')
      .send({ email: known, password: 'Password123!', displayName: 'T' });

    const tUnknown = Date.now();
    await request(app)
      .post('/auth/login')
      .send({ email: uniqueEmail('ghost-timing'), password: 'Whatever1!' });
    const dUnknown = Date.now() - tUnknown;

    const tWrong = Date.now();
    await request(app)
      .post('/auth/login')
      .send({ email: known, password: 'WrongPass1!' });
    const dWrong = Date.now() - tWrong;

    // Same order of magnitude — one path must not be 10x faster than the other.
    const max = Math.max(dUnknown, dWrong);
    const min = Math.min(dUnknown, dWrong);
    expect(max).toBeLessThanOrEqual(min * 10 + 50);
  });

  it('issues HttpOnly cookies on successful login and no longer returns a token field (US4 bridge retired)', async () => {
    const app = await createApp();
    const email = uniqueEmail('cookies');
    await request(app)
      .post('/auth/register')
      .send({ email, password: 'Password123!', displayName: 'C' });

    const res = await request(app)
      .post('/auth/login')
      .send({ email, password: 'Password123!' });

    expect(res.status).toBe(200);
    expect(res.body.user).toEqual(
      expect.objectContaining({ id: expect.any(String), email }),
    );

    const cookies = parseSetCookies(res);
    const access = cookies.find((c) => c.startsWith('gifty_access='));
    const refresh = cookies.find((c) => c.startsWith('gifty_refresh='));
    expect(access).toBeTruthy();
    expect(refresh).toBeTruthy();
    expect(access).toMatch(/HttpOnly/);
    expect(access).toMatch(/SameSite=Lax/i);
    expect(access).toMatch(/Path=\//);
    expect(refresh).toMatch(/HttpOnly/);
    expect(refresh).toMatch(/Path=\/auth\/refresh/i);
    // The refresh credential is an opaque 256-bit random token (64 hex chars).
    expect(refresh).toMatch(/gifty_refresh=[a-f0-9]{64}/);

    // The session row exists and the access JWT carries a sid claim.
    const session = await prisma.userSession.findFirst({
      where: { userId: res.body.user.id },
    });
    expect(session).toBeTruthy();

    // US4 (T012/T017/003 SC-007): the legacy `token` bridge field is formally
    // retired — the credential is now exclusively the HttpOnly cookie pair.
    expect(res.body.token).toBeUndefined();
  });

  it('no longer accepts the legacy Authorization: Bearer header (US4 bridge retired)', async () => {
    const app = await createApp();
    const email = uniqueEmail('bearer');
    await request(app)
      .post('/auth/register')
      .send({ email, password: 'Password123!', displayName: 'B' });

    const login = await request(app)
      .post('/auth/login')
      .send({ email, password: 'Password123!' });
    expect(login.status).toBe(200);

    // Even a well-formed JWT presented via the retired Bearer header is
    // rejected — authentication is now exclusively the gifty_access cookie.
    const legacy = jwt.sign({ sub: login.body.user.id }, process.env.JWT_SECRET!, { expiresIn: '7d' });
    const res = await request(app)
      .get('/lists')
      .set('Authorization', `Bearer ${legacy}`);
    expect(res.status).toBe(401);
  });

  it('creates exactly one account under concurrent duplicate registration', async () => {
    const app = await createApp();
    const email = uniqueEmail('races');
    const [first, second] = await Promise.all([
      request(app)
        .post('/auth/register')
        .send({ email, password: 'Password123!', displayName: 'Race 1' }),
      request(app)
        .post('/auth/register')
        .send({ email, password: 'Password123!', displayName: 'Race 2' }),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([201, 409]);
    expect(await prisma.user.count({ where: { email } })).toBe(1);
  });
});

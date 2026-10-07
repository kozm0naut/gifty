import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import bcrypt from 'bcryptjs';
import { prisma } from '../../src/prisma.js';
import { createApp } from '../../src/app.js';
import { __resetRateLimitersForTesting } from '../../src/auth/rate-limit.js';

const uniqueEmail = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`;

const SOURCE_A = '203.0.113.10';
const SOURCE_B = '203.0.113.20';

/**
 * The stable, user-facing failed sign-in body (003 FR-020). The 429 body must be
 * byte-identical to this, so we assert against the literal contract value
 * rather than issuing another (rate-limit-able) request from an exhausted source.
 */
const LOGIN_FAILURE_BODY = { message: 'Invalid email or password' };
const PASSWORD = 'Password123!';

/** Seed an account directly so budget tests are not confounded by /register limits. */
async function seedUser(email: string): Promise<void> {
  await prisma.user.create({
    data: { email, passwordHash: await bcrypt.hash(PASSWORD, 10), displayName: 'Seed' },
  });
}

beforeEach(async () => {
  process.env.JWT_SECRET = 'test-secret-32-characters-long-0000';
  __resetRateLimitersForTesting();
  await prisma.sharePermission.deleteMany();
  await prisma.giftItem.deleteMany();
  await prisma.giftList.deleteMany();
  await prisma.userSession.deleteMany();
  await prisma.user.deleteMany();
});

describe('rate limiting contract (T010, 003 FR-001 / 003 FR-020 / 003 SC-002)', () => {
  it('exhausts the per-source sign-in budget and returns 429 with a body identical to a failed sign-in', async () => {
    const app = await createApp();
    // Distinct accounts so only the per-source dimension (budget 10) is exercised.
    const emails: string[] = [];
    for (let i = 0; i < 11; i++) {
      const email = uniqueEmail(`rl-src-${i}`);
      emails.push(email);
      await seedUser(email);
    }

    // The per-source sign-in budget (default 10) is fully consumed by failures.
    for (let i = 0; i < 10; i++) {
      const res = await request(app)
        .post('/auth/login')
        .set('X-Forwarded-For', SOURCE_A)
        .send({ email: emails[i], password: 'Wrong123!' });
      expect(res.status).toBe(401);
    }

    const limited = await request(app)
      .post('/auth/login')
      .set('X-Forwarded-For', SOURCE_A)
      .send({ email: emails[10], password: PASSWORD });

    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBeTruthy();
    // The 429 body MUST be indistinguishable from a failed sign-in (003 FR-020/003 SC-002).
    expect(limited.body).toEqual(LOGIN_FAILURE_BODY);
  });

  it('holds a per-account budget even when the source IP rotates', async () => {
    const app = await createApp();
    // The per-account budget (default 5) is strictly smaller than the
    // per-source budget, so five distinct sources each stay under the source
    // cap while the single account trips its own cap.
    const email = uniqueEmail('rl-account');
    await seedUser(email);

    for (let i = 1; i <= 5; i++) {
      const res = await request(app)
        .post('/auth/login')
        .set('X-Forwarded-For', `198.51.100.${i}`)
        .send({ email, password: 'Wrong123!' });
      expect(res.status).toBe(401);
    }

    const limited = await request(app)
      .post('/auth/login')
      .set('X-Forwarded-For', '198.51.100.6')
      .send({ email, password: PASSWORD });
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual(LOGIN_FAILURE_BODY);
  });

  it('does not affect a different source once one source is exhausted', async () => {
    const app = await createApp();
    const emails: string[] = [];
    for (let i = 0; i < 11; i++) {
      const email = uniqueEmail(`rl-fresh-${i}`);
      emails.push(email);
      await seedUser(email);
    }

    for (let i = 0; i < 10; i++) {
      await request(app)
        .post('/auth/login')
        .set('X-Forwarded-For', SOURCE_A)
        .send({ email: emails[i], password: 'Wrong123!' });
    }
    expect(
      (
        await request(app)
          .post('/auth/login')
          .set('X-Forwarded-For', SOURCE_A)
          .send({ email: emails[10], password: 'Wrong123!' })
      ).status,
    ).toBe(429);

    // A second source is untouched by SOURCE_A's exhaustion.
    const fresh = await request(app)
      .post('/auth/login')
      .set('X-Forwarded-For', SOURCE_B)
      .send({ email: emails[10], password: PASSWORD });
    expect(fresh.status).toBe(200);
  });

  it('caps registration failures per source at the registration budget', async () => {
    // 003 FR-001: the per-source registration budget counts FAILURES (the 409
    // "already exists" signal is the enumeration vector). Successful
    // registrations do not consume the budget.
    const app = await createApp();
    const email = uniqueEmail('rl-reg');

    const first = await request(app)
      .post('/auth/register')
      .set('X-Forwarded-For', SOURCE_A)
      .send({ email, password: PASSWORD, displayName: 'Reg' });
    expect(first.status).toBe(201);

    // Three duplicate registrations (failures) exhaust the budget (default 3).
    for (let i = 0; i < 3; i++) {
      const res = await request(app)
        .post('/auth/register')
        .set('X-Forwarded-For', SOURCE_A)
        .send({ email, password: PASSWORD, displayName: 'Reg' });
      expect(res.status).toBe(409);
    }

    // The 4th failure is throttled with a body indistinguishable from a
    // failed registration (003 FR-020/003 SC-002).
    const limited = await request(app)
      .post('/auth/register')
      .set('X-Forwarded-For', SOURCE_A)
      .send({ email, password: PASSWORD, displayName: 'Reg' });
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBeTruthy();
  });
});

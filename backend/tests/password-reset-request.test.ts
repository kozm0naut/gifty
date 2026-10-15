/**
 * T008 — US1: Request a password reset (`POST /auth/reset-request`).
 *
 * Test-first (Constitution III) — MUST FAIL before T011–T013 implement the
 * endpoint. The `/auth/reset-request` route does not exist yet, so every
 * assertion on a 200 + the pinned uniform body fails.
 *
 * Coverage (005 FR-001, 005 FR-002, 005 FR-006, 005 FR-009, 005 SC-002):
 *   T008.1  Registered email   → 200 uniform `U`; one `kind=reset` outbox row
 *           whose body has a `/reset/<token>` link + an expiry notice (FR-002).
 *   T008.2  Unregistered email → 200 uniform `U`; NO outbox row (FR-002, SC-002).
 *   T008.3  Malformed email    → 200 uniform `U` (non-enumeration, FR-002).
 *   T008.4  Missing email      → 200 uniform `U` (non-enumeration, FR-002).
 *   T008.5  Raw token absent   → from the response body AND from the
 *           `password_reset_requested` audit `detail` (FR-006, FR-009).
 *   T008.6  Disabled mode      → 200 uniform `U`, no outbox row (Assumptions).
 */
import request from 'supertest';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { prisma } from '../src/prisma.js';
import { createApp } from '../src/app.js';
import { __resetRateLimitersForTesting } from '../src/auth/rate-limit.js';

/** The single stable reset-request body, pinned in contracts/api.md (FR-002). */
const U_BODY = { message: 'Please check your email for the password reset link' };

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

async function register(app: any, email: string) {
  const res = await request(app)
    .post('/auth/register')
    .send({ email, password: 'Password123!', displayName: 'Reset Tester' });
  expect(res.status).toBe(201);
  return { email, cookie: accessCookie(res.headers['set-cookie']) };
}

/** Extract the raw reset token from a `/reset/<token>` link in a body. */
function tokenFromLink(bodyText: string): string {
  const m = bodyText.match(/\/reset\/([A-Za-z0-9\-_~=%]+)/);
  if (!m) throw new Error('no /reset/<token> link in body');
  return decodeURIComponent(m[1]);
}

/** Poll (bounded) for an audit row matching `action`. */
async function awaitAudit(
  action: string,
  timeoutMs = 5000,
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await prisma.auditEvent.findMany({
      where: { action },
      orderBy: { createdAt: 'desc' },
    });
    if (rows.length > 0) return rows[0];
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for audit row: ${action}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
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

describe('T008 — Request a password reset (005 FR-001, FR-002, FR-006, FR-009, SC-002)', () => {
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

  it('T008.1: registered email → 200 uniform U; one kind=reset outbox row with a /reset/<token> link + expiry notice', async () => {
    const email = uniqueEmail('alice');
    await register(app, email);

    const res = await request(app).post('/auth/reset-request').send({ email });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(U_BODY);

    const rows = await prisma.outboxMessage.findMany({
      where: { recipientEmail: email, kind: 'reset' },
    });
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.listId).toBeNull();
    expect(row.status).toBe('queued');
    expect(row.subject).toBeTruthy();
    expect(row.bodyText).toContain('/reset/');
    // FR-002: the reset email MUST include a notice that the link expires.
    expect(/expir/i.test(row.bodyText)).toBe(true);
  });

  it('T008.2: unregistered email → 200 uniform U; no outbox row (FR-002, SC-002)', async () => {
    const email = uniqueEmail('ghost');
    const res = await request(app).post('/auth/reset-request').send({ email });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(U_BODY);

    const rows = await prisma.outboxMessage.findMany({
      where: { recipientEmail: email },
    });
    expect(rows).toHaveLength(0);
  });

  it('T008.3: malformed email → 200 uniform U (no enumeration, FR-002)', async () => {
    const res = await request(app)
      .post('/auth/reset-request')
      .send({ email: 'not-an-email' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(U_BODY);
  });

  it('T008.4: missing email → 200 uniform U (no enumeration, FR-002)', async () => {
    const res = await request(app).post('/auth/reset-request').send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual(U_BODY);
  });

  it('T008.5: raw token absent from the response body and the password_reset_requested audit detail (FR-006, FR-009)', async () => {
    const email = uniqueEmail('secret');
    await register(app, email);

    const res = await request(app).post('/auth/reset-request').send({ email });
    expect(res.status).toBe(200);

    const row = await prisma.outboxMessage.findFirst({
      where: { recipientEmail: email, kind: 'reset' },
    });
    expect(row).not.toBeNull();
    const rawToken = tokenFromLink(row!.bodyText);
    expect(rawToken.length).toBeGreaterThan(10);

    // FR-006: the raw token must not leak in the response body.
    expect(JSON.stringify(res.body)).not.toContain(rawToken);

    // FR-009: the audit row exists and its scrubbed detail never holds the
    // raw token (the audit scrub is the enforcement mechanism, 003 FR-013).
    const audit = await awaitAudit('password_reset_requested');
    expect(JSON.stringify(audit.detail ?? null)).not.toContain(rawToken);
  });

  it('T008.6: disabled mode (EMAIL_ENABLED=false) → 200 uniform U, no outbox row (Assumptions)', async () => {
    process.env.EMAIL_ENABLED = 'false';
    delete process.env.RESEND_API_KEY;
    await resetDb();
    const disabledApp = await createApp();

    const email = uniqueEmail('disabled');
    await register(disabledApp, email);

    const res = await request(disabledApp).post('/auth/reset-request').send({ email });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(U_BODY);

    const rows = await prisma.outboxMessage.findMany({
      where: { recipientEmail: email, kind: 'reset' },
    });
    expect(rows).toHaveLength(0);
  });
});

/**
 * T018 — US2: rate-limiting + non-enumeration (005 FR-007, FR-002, SC-002).
 *
 * Test-first (Constitution III) — these MUST FAIL before T019 wires the
 * rate-limiter into `POST /auth/reset-request`. The 429 responses do not
 * exist yet, so the throttle assertions are the genuine red state.
 */
describe('T018 — US2: rate-limiting + non-enumeration (005 FR-007, FR-002, SC-002)', () => {
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

  // Restore default budgets so these tests don't leak into other files running
  // in the same process (vitest threads pool shares `process.env`).
  afterEach(() => {
    delete process.env.RESET_MAX_PER_SOURCE;
    delete process.env.RESET_MAX_PER_ACCOUNT;
    __resetRateLimitersForTesting();
  });

  it('T018.1: per-source throttle — 3 different unregistered emails (same IP), budget=2 → 3rd is 429 + Retry-After (FR-007)', async () => {
    // Tighten source budget; widen account budget so it never triggers.
    process.env.RESET_MAX_PER_SOURCE = '2';
    process.env.RESET_MAX_PER_ACCOUNT = '100';
    __resetRateLimitersForTesting();

    const e1 = uniqueEmail('src1');
    const e2 = uniqueEmail('src2');
    const e3 = uniqueEmail('src3');

    const r1 = await request(app).post('/auth/reset-request').send({ email: e1 });
    const r2 = await request(app).post('/auth/reset-request').send({ email: e2 });
    expect(r1.status).not.toBe(429);
    expect(r2.status).not.toBe(429);

    // Third request from the same source IP → 429.
    const r3 = await request(app).post('/auth/reset-request').send({ email: e3 });
    expect(r3.status).toBe(429);
    expect(r3.headers['retry-after']).toBeTruthy();
    expect(r3.body).toEqual(U_BODY);
  });

  it('T018.2: per-account throttle — 3 requests for the same registered email, budget=2 → 3rd is 429 + Retry-After (FR-007)', async () => {
    process.env.RESET_MAX_PER_SOURCE = '100';
    process.env.RESET_MAX_PER_ACCOUNT = '2';
    __resetRateLimitersForTesting();

    const email = uniqueEmail('acct');
    await register(app, email);

    const r1 = await request(app).post('/auth/reset-request').send({ email });
    const r2 = await request(app).post('/auth/reset-request').send({ email });
    expect(r1.status).not.toBe(429);
    expect(r2.status).not.toBe(429);

    const r3 = await request(app).post('/auth/reset-request').send({ email });
    expect(r3.status).toBe(429);
    expect(r3.headers['retry-after']).toBeTruthy();
    expect(r3.body).toEqual(U_BODY);
  });

  it('T018.3: non-enumeration — registered vs unregistered return identical status + byte-identical body (FR-002, SC-002)', async () => {
    // High budgets so neither throttle triggers during this test.
    process.env.RESET_MAX_PER_SOURCE = '1000';
    process.env.RESET_MAX_PER_ACCOUNT = '1000';
    __resetRateLimitersForTesting();

    const regEmail = uniqueEmail('enum-registered');
    await register(app, regEmail);

    const unregEmail = uniqueEmail('enum-unregistered');

    const regRes = await request(app).post('/auth/reset-request').send({ email: regEmail });
    const unregRes = await request(app).post('/auth/reset-request').send({ email: unregEmail });

    // Identical status.
    expect(regRes.status).toBe(unregRes.status);
    expect(regRes.status).toBe(200);

    // Byte-identical body (no enumeration leak, FR-002, SC-002).
    expect(JSON.stringify(regRes.body)).toBe(JSON.stringify(unregRes.body));
    expect(regRes.body).toEqual(U_BODY);
    expect(unregRes.body).toEqual(U_BODY);
  });
});

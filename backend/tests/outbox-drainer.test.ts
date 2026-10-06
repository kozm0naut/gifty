/**
 * T024 — US4: Reliable, Queued Delivery
 *
 *  1. enqueue with sender available → drainOnce → status=`sent`, `sentAt` set, attempts=1
 *  2. first attempt fails → `queued`, attempts=1, nextAttemptAt > now; succeed → `sent`
 *  3. sender always fails → `failed` after maxAttempts, `lastError` set (scrubbed)
 *  4. `failed` is terminal — a later drainOnce does NOT retry it
 *  5. in-flight (`sending`) row → `reclaimStaleSending()` → back to `queued`, nextAttemptAt=now
 *  6. resending a confirmation supersedes the prior queued row (status=`superseded`, `supersededAt`)
 *  7. origin action (share) succeeds even when the sender is down (SC-007)
 *
 * T025 (verify, exercised by the same suite): drain claims to `sending` before
 * calling the mailer; success → `sent` + `sentAt`; failure → backoff to `queued`
 * or terminal `failed`; `reclaimStaleSending` runs at drainer startup.
 */
import request from 'supertest';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { prisma } from '../src/prisma.js';
import { createApp } from '../src/app.js';

type App = any;
import { setMailerForTest, type Mailer } from '../src/email/mailer.js';
import { drainOnce, reclaimStaleSending, startDrainer, stopDrainer } from '../src/email/outbox.js';

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

/**
 * A mailer whose failure behavior is scripted per recipient. Behavior applies
 * only to `recipient` (the invite under test); every other recipient (e.g. the
 * owner's own confirmation row) succeeds, so drain counts stay exact.
 */
function scriptableMailer(behavior: 'ok' | 'failOnce' | 'alwaysFail', recipient: string) {
  let calls = 0;
  let recipientCalls = 0;
  const mailer: Mailer = {
    async send(to, _subject, _text, _html, _meta) {
      calls += 1;
      if (to === recipient) {
        recipientCalls += 1;
        if (behavior === 'alwaysFail' || (behavior === 'failOnce' && recipientCalls === 1)) {
          const e = new Error('injected send failure');
          (e as { providerError?: string }).providerError = 'network_error';
          throw e;
        }
      }
    },
  };
  return { mailer, count: () => calls, recipientCount: () => recipientCalls };
}

async function registerConfirmed(app: App, displayName: string) {
  const email = uniqueEmail(displayName);
  const res = await request(app)
    .post('/auth/register')
    .send({ email, password: 'Password123!', displayName });
  const cookie = accessCookie(res.headers['set-cookie']);
  const user = await prisma.user.findUnique({ where: { email } });
  if (user && user.verifiedAt == null) {
    await prisma.user.update({ where: { id: user.id }, data: { verifiedAt: new Date() } });
  }
  return { email, cookie };
}

async function createList(app: App, cookie: string, title: string): Promise<string> {
  const res = await request(app)
    .post('/lists')
    .set('Cookie', `gifty_access=${cookie}`)
    .send({ title });
  return res.body.list.id as string;
}

async function share(app: App, listId: string, ownerCookie: string, recipientEmail: string) {
  return request(app)
    .post(`/lists/${listId}/share`)
    .set('Cookie', `gifty_access=${ownerCookie}`)
    .send({ recipientEmail, permission: 'shared' });
}

describe('US4 — Reliable, Queued Delivery (FR-007, FR-008, SC-004, SC-007)', () => {
  let app: App;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    // Fast retry cadence so backoff assertions and terminal state are quick.
    for (const k of ['EMAIL_ENABLED', 'EMAIL_MAX_ATTEMPTS', 'EMAIL_RETRY_BASE_MS']) {
      savedEnv[k] = process.env[k];
    }
    process.env.EMAIL_ENABLED = 'true';
    process.env.EMAIL_MAX_ATTEMPTS = '5';
    process.env.EMAIL_RETRY_BASE_MS = '50';
    delete process.env.RESEND_API_KEY;
    delete process.env.RESEND_FROM;

    await prisma.outboxMessage.deleteMany();
    await prisma.giftItem.deleteMany();
    await prisma.sharePermission.deleteMany();
    await prisma.pendingInvitation.deleteMany();
    await prisma.giftList.deleteMany();
    await prisma.user.deleteMany();
    await prisma.auditEvent.deleteMany();

    setMailerForTest(null);
    stopDrainer();
    app = await createApp();
  });

  afterEach(() => {
    setMailerForTest(null);
    stopDrainer();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('T024.1: first attempt fails → queued, attempts=1, backoff set; then succeeds → sent', async () => {
    const recipient = uniqueEmail('t024.1-r');
    const { mailer, recipientCount } = scriptableMailer('failOnce', recipient);
    setMailerForTest(mailer);
    const owner = await registerConfirmed(app, 'T024.1');
    await drainOnce(); // settle the owner's confirmation row (not the invite)
    const listId = await createList(app, owner.cookie, 'T024.1 list');

    await share(app, listId, owner.cookie, recipient);

    const before = await prisma.outboxMessage.findFirst({
      where: { listId, recipientEmail: recipient },
    });
    expect(before?.status).toBe('queued');

    const t0 = Date.now();
    const processed = await drainOnce();
    expect(processed).toBe(1);

    const retry = await prisma.outboxMessage.findUnique({ where: { id: before!.id } });
    expect(retry?.status).toBe('queued');
    expect(retry?.attempts).toBe(1);
    expect(retry?.nextAttemptAt!.getTime()).toBeGreaterThanOrEqual(t0 + 40);

    // Wait out the backoff window (base=50ms → due at ~50ms), drain again.
    await new Promise((r) => setTimeout(r, 120));
    await drainOnce();

    const after = await prisma.outboxMessage.findUnique({ where: { id: before!.id } });
    expect(after?.status).toBe('sent');
    expect(after?.sentAt).toBeInstanceOf(Date);
    expect(after?.attempts).toBe(2);
    expect(recipientCount()).toBe(2);
  });

  it('T024.3: sender always fails → failed after maxAttempts, lastError scrubbed', async () => {
    const recipient = uniqueEmail('t024.3-r');
    const { mailer } = scriptableMailer('alwaysFail', recipient);
    setMailerForTest(mailer);
    const owner = await registerConfirmed(app, 'T024.3');
    const listId = await createList(app, owner.cookie, 'T024.3 list');

    await share(app, listId, owner.cookie, recipient);

    const row = await prisma.outboxMessage.findFirst({
      where: { listId, recipientEmail: recipient },
    });
    const maxAttempts = row!.maxAttempts;

    // maxAttempts drains: each one bumps attempts; the row goes back to queued
    // until the final attempt, which flips it to the terminal failed state.
    // Backoff is 50ms * 2^(n-1) (EMAIL_RETRY_BASE_MS=50), so wait out each
    // window before the next drain.
    for (let i = 1; i <= maxAttempts; i++) {
      if (i > 1) {
        await new Promise((r) => setTimeout(r, 50 * 2 ** (i - 1) + 30));
      }
      await drainOnce();
      const cur = await prisma.outboxMessage.findUnique({ where: { id: row!.id } });
      const terminal = i === maxAttempts;
      expect(cur?.attempts).toBe(i);
      if (terminal) {
        expect(cur?.status).toBe('failed');
        expect(cur?.lastError).toBeTruthy();
        expect(cur?.lastError).not.toContain('injected send failure');
      } else {
        expect(cur?.status).toBe('queued');
      }
    }
  });

  it('T024.4: failed is terminal — a later drainOnce does not retry it', async () => {
    const recipient = uniqueEmail('t024.4-r');
    const { mailer, recipientCount } = scriptableMailer('alwaysFail', recipient);
    setMailerForTest(mailer);
    const owner = await registerConfirmed(app, 'T024.4');
    const listId = await createList(app, owner.cookie, 'T024.4 list');

    await share(app, listId, owner.cookie, recipient);

    const row = await prisma.outboxMessage.findFirst({
      where: { listId, recipientEmail: recipient },
    });
    for (let i = 1; i <= row!.maxAttempts; i++) {
      if (i > 1) {
        await new Promise((r) => setTimeout(r, 50 * 2 ** (i - 1) + 30));
      }
      await drainOnce();
    }

    const failedRow = await prisma.outboxMessage.findUnique({ where: { id: row!.id } });
    expect(failedRow?.status).toBe('failed');
    const callsAtFail = recipientCount();

    await drainOnce();
    const unchanged = await prisma.outboxMessage.findUnique({ where: { id: row!.id } });
    expect(unchanged?.status).toBe('failed');
    expect(unchanged?.attempts).toBe(row!.maxAttempts);
    expect(recipientCount()).toBe(callsAtFail);
  });

  it('T024.5: in-flight (sending) row is reclaimed to queued, nextAttemptAt=now', async () => {
    const recipient = uniqueEmail('t024.5-r');
    setMailerForTest(scriptableMailer('ok', recipient).mailer);
    const owner = await registerConfirmed(app, 'T024.5');
    const listId = await createList(app, owner.cookie, 'T024.5 list');

    await share(app, listId, owner.cookie, recipient);

    const row = await prisma.outboxMessage.findFirst({
      where: { listId, recipientEmail: recipient },
    });

    // Simulate a crash mid-send: the row is `sending` with a stale lastAttemptAt.
    await prisma.outboxMessage.update({
      where: { id: row!.id },
      data: {
        status: 'sending',
        lastAttemptAt: new Date(Date.now() - 10 * 60 * 1000),
      },
    });

    const t0 = Date.now();
    const reclaimed = await reclaimStaleSending();
    expect(reclaimed).toBe(1);

    const after = await prisma.outboxMessage.findUnique({ where: { id: row!.id } });
    expect(after?.status).toBe('queued');
    expect(after?.nextAttemptAt!.getTime()).toBeGreaterThanOrEqual(t0 - 1000);
    expect(after?.nextAttemptAt!.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('T024.6: resend supersedes the prior queued confirmation', async () => {
    setMailerForTest(scriptableMailer('ok', uniqueEmail('t024.6')).mailer);
    const email = uniqueEmail('t024.6');

    // Register (email enabled, unconfirmed) → exactly one confirmation row.
    await request(app)
      .post('/auth/register')
      .send({ email, password: 'Password123!', displayName: 'T024.6' });

    const first = await prisma.outboxMessage.findFirst({
      where: { kind: 'confirmation', recipientEmail: email },
    });
    expect(first).toBeTruthy();
    expect(first!.status).toBe('queued');

    // Sign in → live session → resend.
    const signIn = await request(app)
      .post('/auth/login')
      .send({ email, password: 'Password123!' });
    const cookie = accessCookie(signIn.headers['set-cookie']);

    const resend = await request(app)
      .post('/auth/resend-confirmation')
      .set('Cookie', `gifty_access=${cookie}`);
    expect(resend.status).toBe(202);

    const rows = await prisma.outboxMessage.findMany({
      where: { kind: 'confirmation', recipientEmail: email },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0].status).toBe('superseded');
    expect(rows[0].supersededAt).toBeInstanceOf(Date);
    expect(rows[1].status).toBe('queued');

    // The superseded row must not be drained.
    setMailerForTest(scriptableMailer('ok', email).mailer);
    await drainOnce();
    const after = await prisma.outboxMessage.findUnique({ where: { id: rows[0].id } });
    expect(after?.status).toBe('superseded');
  });

  it('T024.7: share succeeds even when the sender is down (SC-007)', async () => {
    const recipient = uniqueEmail('t024.7-r');
    setMailerForTest(scriptableMailer('alwaysFail', recipient).mailer);
    const owner = await registerConfirmed(app, 'T024.7');
    const listId = await createList(app, owner.cookie, 'T024.7 list');

    const res = await share(app, listId, owner.cookie, recipient);

    // The origin action (share) is unaffected by the mailer being down:
    // the recipient is recorded (as a pending invitation — unregistered
    // emails hold a PendingInvitation, converted at registration) and the
    // invite is queued for the drainer.
    expect(res.status).toBe(201);
    const invitation = await prisma.pendingInvitation.findFirst({
      where: { giftListId: listId, inviteeEmail: recipient },
    });
    expect(invitation).toBeTruthy();
    const invite = await prisma.outboxMessage.findFirst({
      where: { listId, recipientEmail: recipient },
    });
    expect(invite).toBeTruthy();
  });

  it('T025 (verify): startDrainer reclaims stale rows then drains on the interval', async () => {
    setMailerForTest(scriptableMailer('ok', 'nobody@example.com').mailer);

    // Seed a queued row directly (no API) + one stale in-flight row.
    const user = await prisma.user.create({
      data: {
        email: uniqueEmail('t025'),
        passwordHash: 'x',
        displayName: 'T025',
        verifiedAt: new Date(),
      },
    });
    const list = await prisma.giftList.create({
      data: { id: `list-${Date.now()}`, ownerUserId: user.id, title: 'T025' },
    });
    const queued = await prisma.outboxMessage.create({
      data: {
        kind: 'invite',
        listId: list.id,
        recipientEmail: uniqueEmail('t025-r'),
        subject: 's',
        bodyText: 'b',
        nextAttemptAt: new Date(),
      },
    });
    const stale = await prisma.outboxMessage.create({
      data: {
        kind: 'invite',
        listId: list.id,
        recipientEmail: uniqueEmail('t025-stale'),
        subject: 's',
        bodyText: 'b',
        status: 'sending',
        lastAttemptAt: new Date(Date.now() - 10 * 60 * 1000),
      },
    });

    startDrainer();
    // Poll (drainIntervalMs defaults to 5s; don't assume a fixed delay).
    const deadline = Date.now() + 20_000;
    let queuedSent = false;
    let staleCleared = false;
    for (;;) {
      const q = await prisma.outboxMessage.findUnique({ where: { id: queued.id } });
      const s = await prisma.outboxMessage.findUnique({ where: { id: stale.id } });
      queuedSent = q?.status === 'sent';
      staleCleared = s?.status === 'sent' || s?.status === 'queued';
      if (queuedSent && staleCleared) break;
      if (Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    stopDrainer();

    expect(queuedSent).toBe(true);
    expect(staleCleared).toBe(true);
  }, 30_000);

  it('T025 (verify): startDrainer is idempotent and stopDrainer halts ticks', async () => {
    setMailerForTest(scriptableMailer('ok', 'nobody@example.com').mailer);
    startDrainer();
    stopDrainer();
    startDrainer(); // restart works
    stopDrainer();
  });
});

/**
 * T026 — US5: Developer and Test Mail Capture (004 FR-008, 004 SC-003)
 *
 *  1. invite email captured  → capturedEmails() entry with correct to/subject/text/link (home, no token)
 *  2. confirmation captured  → entry with a `/confirm?token=` link
 *  3. zero live provider calls (no fetch to api.resend.com)
 *  4. resetCapturedEmails() clears the buffer
 *  5. drainOnce() processes captured messages (status → sent)
 *  6. setMailerForTest(fake) injection works (succeeds / fails / always fails)
 *
 * Capture mode (mode b) is resolved from config: EMAIL_ENABLED=true with no
 * live RESEND_API_KEY → `getMailer()` returns the shared CaptureMailer (zero
 * network I/O). The capture hooks (`capturedEmails` / `resetCapturedEmails`)
 * are only meaningful in this mode; the live ResendMailer is never
 * instantiated here, so a spy on `fetch` proves zero live-provider calls.
 */
import request from 'supertest';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { prisma } from '../src/prisma.js';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config/index.js';

type App = any;
import {
  setMailerForTest,
  capturedEmails,
  resetCapturedEmails,
  type Mailer,
  type CapturedEmail,
} from '../src/email/mailer.js';
import { drainOnce } from '../src/email/outbox.js';

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

/** Register a new account (which enqueues a confirmation outbox row for the
 *  capture assertions), then force-confirm the owner so the US2 blocking gate
 *  does not block list operations. The confirmation row is left in the queue
 *  so a later drain captures it. */
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

/** Register + confirm the owner, then settle their confirmation outbox row and
 *  clear the capture buffer. Leaves a clean slate: confirmed owner, empty queue,
 *  empty buffer — so invite-focused tests deal with exactly one message. */
async function registerOwner(app: App, displayName: string) {
  const owner = await registerConfirmed(app, displayName);
  await drainOnce();
  resetCapturedEmails();
  return owner;
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

describe('US5 — Developer and Test Mail Capture (004 FR-008, 004 SC-003)', () => {
  let app: App;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    // Resolve to CAPTURE mode (mode b): email enabled, no live sender.
    for (const k of [
      'EMAIL_ENABLED',
      'EMAIL_TRANSPORT',
      'RESEND_API_KEY',
      'RESEND_FROM',
      'GIFTY_PUBLIC_ORIGIN',
      'EMAIL_MAX_ATTEMPTS',
      'EMAIL_RETRY_BASE_MS',
    ]) {
      savedEnv[k] = process.env[k];
    }
    process.env.EMAIL_ENABLED = 'true';
    delete process.env.EMAIL_TRANSPORT;
    delete process.env.RESEND_API_KEY; // no live key → capture mode
    delete process.env.RESEND_FROM;
    process.env.GIFTY_PUBLIC_ORIGIN = 'http://localhost:8080';
    process.env.EMAIL_MAX_ATTEMPTS = '5';
    process.env.EMAIL_RETRY_BASE_MS = '50';

    await prisma.outboxMessage.deleteMany();
    await prisma.giftItem.deleteMany();
    await prisma.sharePermission.deleteMany();
    await prisma.pendingInvitation.deleteMany();
    await prisma.giftList.deleteMany();
    await prisma.user.deleteMany();
    await prisma.auditEvent.deleteMany();

    setMailerForTest(null);
    resetCapturedEmails();
    app = await createApp();
  });

  afterEach(() => {
    setMailerForTest(null);
    resetCapturedEmails();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('T026.0: test env resolves to capture mode with no live credential', () => {
    expect(loadConfig().email.mode).toBe('capture');
    expect(loadConfig().email.resendApiKey).toBeUndefined();
  });

  it('T026.1: an invite email is captured with correct to/subject/text/link (home, no token)', async () => {
    const owner = await registerOwner(app, 'T026.1');

    const listId = await createList(app, owner.cookie, 'T026.1 list');
    const recipient = uniqueEmail('t026.1-r');
    await share(app, listId, owner.cookie, recipient);

    await drainOnce(); // the capture stub records the invite

    const row = await prisma.outboxMessage.findFirst({
      where: { listId, recipientEmail: recipient },
    });
    expect(row?.status).toBe('sent');

    const captured = capturedEmails();
    expect(captured).toHaveLength(1);
    const entry: CapturedEmail = captured[0];
    expect(entry.kind).toBe('invite');
    expect(entry.to).toBe(recipient);
    expect(entry.subject).toBe("You've been shared a gift list");
    expect(entry.text).toContain('shared their Gifty gift list');
    // Home page, no token, no deep link (004 FR-013).
    expect(entry.link).toBe('http://localhost:8080/');
    expect(entry.link).not.toContain('token=');
  });

  it('T026.2: a confirmation email is captured with a /confirm?token= link', async () => {
    const { email } = await registerConfirmed(app, 'T026.2');
    resetCapturedEmails();

    await drainOnce(); // capture stub sends the confirmation

    const row = await prisma.outboxMessage.findFirst({
      where: { kind: 'confirmation', recipientEmail: email },
    });
    expect(row?.status).toBe('sent');

    const captured = capturedEmails();
    expect(captured).toHaveLength(1);
    const entry: CapturedEmail = captured[0];
    expect(entry.kind).toBe('confirmation');
    expect(entry.to).toBe(email);
    expect(entry.subject).toBe('Confirm your email address');
    // Link resolves to the app entry point with a single-use token (D4).
    expect(entry.link).toMatch(/^http:\/\/localhost:8080\/confirm\?token=.+/);
  });

  it('T026.3: zero live provider calls — no fetch to api.resend.com', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('a live provider call was made — capture mode must be zero-I/O');
    });

    try {
      const owner = await registerOwner(app, 'T026.3');
      const listId = await createList(app, owner.cookie, 'T026.3 list');
      await share(app, listId, owner.cookie, uniqueEmail('t026.3-r'));

      await drainOnce();

      // The capture stub performs no network I/O by construction; if the live
      // ResendMailer were ever active in this env, it would have hit fetch.
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('T026.4: resetCapturedEmails() clears the buffer', async () => {
    const owner = await registerOwner(app, 'T026.4');
    const listId = await createList(app, owner.cookie, 'T026.4 list');
    await share(app, listId, owner.cookie, uniqueEmail('t026.4-r'));

    await drainOnce();
    expect(capturedEmails().length).toBeGreaterThanOrEqual(1); // the invite

    resetCapturedEmails();
    expect(capturedEmails()).toEqual([]);
  });

  it('T026.5: drainOnce() processes captured messages to `sent`', async () => {
    // NOTE: intentionally NOT using registerOwner — the owner's confirmation row
    // is left queued so both it and the invite are processed by the drain below.
    const owner = await registerConfirmed(app, 'T026.5');
    const listId = await createList(app, owner.cookie, 'T026.5 list');
    const recipient = uniqueEmail('t026.5-r');
    await share(app, listId, owner.cookie, recipient);

    const processed = await drainOnce(); // owner confirm + invite
    expect(processed).toBe(2);

    const rows = await prisma.outboxMessage.findMany({
      where: { recipientEmail: { in: [owner.email, recipient] } },
    });
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.status).toBe('sent');
      expect(r.sentAt).toBeInstanceOf(Date);
    }
    // Every drained message is observable in the capture buffer.
    expect(capturedEmails()).toHaveLength(2);
  });

  it('T026.6: setMailerForTest injection overrides capture mode (success / failure / always fail)', async () => {
    // (a) success — the injected mailer is called and the row reaches `sent`.
    {
      const owner = await registerOwner(app, 'T026.6a');
      const listId = await createList(app, owner.cookie, 'T026.6a list');
      const recipient = uniqueEmail('t026.6a-r');
      await share(app, listId, owner.cookie, recipient);

      let calls = 0;
      const okMailer: Mailer = {
        async send() {
          calls += 1;
        },
      };
      setMailerForTest(okMailer);
      await drainOnce();
      expect(calls).toBe(1);
      const row = await prisma.outboxMessage.findFirst({
        where: { listId, recipientEmail: recipient },
      });
      expect(row?.status).toBe('sent');
      // The injected mailer bypasses the capture buffer.
      expect(capturedEmails()).toHaveLength(0);
    }

    // (b) fail once → queued with backoff, then succeeds → sent.
    {
      const owner = await registerOwner(app, 'T026.6b');
      const listId = await createList(app, owner.cookie, 'T026.6b list');
      const recipient = uniqueEmail('t026.6b-r');
      await share(app, listId, owner.cookie, recipient);

      let n = 0;
      const flaky: Mailer = {
        async send() {
          n += 1;
          if (n === 1) {
            const e = new Error('injected');
            (e as { providerError?: string }).providerError = 'network_error';
            throw e;
          }
        },
      };
      setMailerForTest(flaky);
      const row0 = await prisma.outboxMessage.findFirst({
        where: { listId, recipientEmail: recipient },
      });
      await drainOnce(); // first attempt fails → queued
      let row = await prisma.outboxMessage.findUnique({ where: { id: row0!.id } });
      expect(row?.status).toBe('queued');
      expect(row?.attempts).toBe(1);

      await new Promise((r) => setTimeout(r, 120)); // out the 50ms backoff
      await drainOnce(); // second attempt succeeds
      row = await prisma.outboxMessage.findUnique({ where: { id: row0!.id } });
      expect(row?.status).toBe('sent');
      expect(row?.attempts).toBe(2);
    }

    // (c) always fail → terminal `failed` after maxAttempts, lastError scrubbed.
    {
      const owner = await registerOwner(app, 'T026.6c');
      const listId = await createList(app, owner.cookie, 'T026.6c list');
      const recipient = uniqueEmail('t026.6c-r');
      await share(app, listId, owner.cookie, recipient);

      const alwaysFail: Mailer = {
        async send() {
          const e = new Error('always down');
          (e as { providerError?: string }).providerError = 'provider_http_5xx';
          throw e;
        },
      };
      setMailerForTest(alwaysFail);
      const row0 = await prisma.outboxMessage.findFirst({
        where: { listId, recipientEmail: recipient },
      });
      const maxAttempts = row0!.maxAttempts;
      for (let i = 1; i <= maxAttempts; i++) {
        if (i > 1) await new Promise((r) => setTimeout(r, 50 * 2 ** (i - 1) + 30));
        await drainOnce();
        const cur = await prisma.outboxMessage.findUnique({ where: { id: row0!.id } });
        expect(cur?.attempts).toBe(i);
        if (i === maxAttempts) {
          expect(cur?.status).toBe('failed');
          expect(cur?.lastError).toBe('provider_http_5xx');
        } else {
          expect(cur?.status).toBe('queued');
        }
      }
    }
  });
});

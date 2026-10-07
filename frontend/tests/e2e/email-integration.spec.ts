import { test, expect, Page } from '@playwright/test';
import { E2E_PASSWORD, uniqueEmail } from './helpers';

/**
 * T030 — E2E spec for the email-integration feature (feature 004).
 *
 * Drives the real React UI (served by the containerized app) against the real
 * Express + Prisma + PostgreSQL backend, in **capture mode** (US5/004 SC-003): no
 * live provider is ever contacted, every message lands in the process output
 * and the durable OutboxMessage row. The suite is run against the Docker stack
 * (BASE_URL=http://localhost:8080), so the API is same-origin.
 *
 * Scenarios (tasks.md T030):
 *   1. register → confirmation page → follow the captured link → dashboard → verified.
 *   2. unconfirmed account is gated (server-side 403) → confirm → gate lifts.
 *   3. disabled mode → register → immediately usable (no gate).  [conditional]
 *   4. invite email is captured in the outbox (home link, no token).
 *
 * How the confirmation token is obtained: the token is server-generated and
 * only persisted in the OutboxMessage row (and the capture log), both of which
 * are inside the container. We read it straight from the DB via
 * `docker compose exec -T postgres psql` — the same inspection path the
 * quickstart (US2/US4) uses. This is the only reliable handle a black-box e2e
 * harness has on the "captured email" (the in-memory buffer is process-internal
 * and only reachable through the backend test hooks, not the HTTP surface).
 *
 * Scenarios 1 and 2 register through the real UI so the browser holds the
 * HttpOnly session cookie; the server-side assertions (the 403 gate, the
 * post-confirmation 200, the verified flag) then go through `page.request`,
 * which shares that page's cookie jar — keeping the whole flow on one real
 * session end-to-end. (The standalone `request` fixture is a separate
 * APIRequestContext with no session cookie, so it is deliberately not used.)
 *
 * Scenario 3 (disabled mode) is conditional: it is only meaningful when the
 * stack under test actually boots with EMAIL_ENABLED=false. When the e2e suite
 * runs against the capture-mode stack (the default for this feature) it is
 * skipped, because the same invariant is already proven at the API level in
 * the backend suite (confirmation.test.ts T015.14) against a real disabled-mode
 * app instance. To exercise it here, stand up a disabled-mode stack and set
 * `E2E_EMAIL_MODE=disabled`.
 */

const API_BASE = process.env.BASE_URL || 'http://localhost:8080';
const GATE_MSG = 'Please confirm your email to continue.';
const REPO_ROOT = process.env.GIFTY_REPO_ROOT || '';

/**
 * Run a read-only SQL query against the stack's internal Postgres container.
 * `docker compose exec -T postgres psql -U gifty -d gifty -tA -c <q>`.
 * Requires Docker + the compose project on PATH (true for this suite's target).
 */
async function runPsql(query: string): Promise<string> {
  const { execFile } = await import('node:child_process');
  const args = [
    'compose',
    ...(REPO_ROOT ? ['-f', `${REPO_ROOT}/docker-compose.yml`, '--project-directory', REPO_ROOT] : []),
    'exec', '-T', 'postgres', 'psql', '-U', 'gifty', '-d', 'gifty', '-tA', '-c', query,
  ];
  return new Promise<string>((resolve, reject) => {
    execFile('docker', args, { maxBuffer: 1024 * 1024, timeout: 30_000 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`psql failed: ${err.message}\n${stderr || ''}`));
        return;
      }
      resolve(stdout);
    });
  });
}

/**
 * Pull the most recent confirmation token for `email` from the OutboxMessage
 * row (capture mode persists every message). Retries a few times to absorb the
 * (rare) enqueue→commit timing gap.
 */
async function fetchConfirmationToken(email: string): Promise<string> {
  const q = `SELECT "bodyText" FROM "OutboxMessage" WHERE "kind" = 'confirmation' AND lower("recipientEmail") = lower('${email}') ORDER BY "createdAt" DESC LIMIT 1;`;
  let last = '';
  for (let i = 0; i < 6; i++) {
    try {
      const out = await runPsql(q);
      const link = out.match(/confirm\?token=([^\s&"'<]+)/);
      if (link) return decodeURIComponent(link[1]);
      last = out;
    } catch {
      /* retry on transient exec failure */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`no confirmation token found for ${email}; last body: ${last}`);
}

/** Latest invite (kind='invite') to `email` for `listId`, from the outbox row. */
async function fetchInviteRow(email: string, listId: string): Promise<{ subject: string; bodyText: string } | null> {
  const q = `SELECT json_build_object('subject', "subject", 'bodyText', "bodyText") FROM "OutboxMessage" WHERE "kind" = 'invite' AND lower("recipientEmail") = lower('${email}') AND "listId" = '${listId}' ORDER BY "createdAt" DESC LIMIT 1;`;
  const out = await runPsql(q);
  const m = out.match(/\{.*\}/);
  if (!m) return null;
  return JSON.parse(m[0]) as { subject: string; bodyText: string };
}

/** Register a new account through the real UI and land on the confirmation page. */
async function registerViaUI(page: Page, email: string, displayName: string): Promise<void> {
  await page.goto('/auth');
  await page.getByRole('button', { name: /don't have an account/i }).click();
  await page.fill('#auth-email', email);
  await page.fill('#auth-password', E2E_PASSWORD);
  await page.fill('#auth-name', displayName);
  await page.getByRole('button', { name: 'Register', exact: true }).click();
  // US2: an unconfirmed sign-up is routed to the confirmation page.
  await page.waitForSelector('text=Confirm your email', { timeout: 20000 });
}

test.describe('email integration (feature 004)', () => {
  test('register → confirm via captured link → dashboard (verified)', async ({ page }) => {
    const email = uniqueEmail('confirm-flow');
    await registerViaUI(page, email, 'Confirm Flow');

    const token = await fetchConfirmationToken(email);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);

    // Follow the captured link in the SAME browser (the session cookie from
    // registration is present, so the page adopts the now-verified account).
    await page.goto(`/confirm?token=${encodeURIComponent(token)}`);
    await page.waitForSelector('[data-testid="confirm-success"]', { timeout: 20000 });

    // Gate is lifted: land on the dashboard.
    await page.getByRole('button', { name: /go to your lists/i }).click();
    await page.waitForSelector('text=My Lists', { timeout: 20000 });

    // Server-side confirmation is durable (same session, via the browser context).
    const account = await page.request.get('/account');
    expect(account.ok()).toBeTruthy();
    expect((await account.json()).user.verified).toBe(true);
  });

  test('unconfirmed account is gated; confirm lifts the gate', async ({ page }) => {
    const email = uniqueEmail('gated');
    await registerViaUI(page, email, 'Gated');

    // Server-side gate: the unconfirmed session is held (stable, non-leaking 403).
    const gated = await page.request.get('/lists');
    expect(gated.status()).toBe(403);
    expect((await gated.json()).message).toBe(GATE_MSG);

    // Confirm, then the same call that 403'd now succeeds (gate lifted).
    const token = await fetchConfirmationToken(email);
    await page.goto(`/confirm?token=${encodeURIComponent(token)}`);
    await page.waitForSelector('[data-testid="confirm-success"]', { timeout: 20000 });
    expect((await page.request.get('/lists')).status()).toBe(200);

    // 004 FR-010: re-following the same single-use link is a no-op, not an error.
    await page.goto(`/confirm?token=${encodeURIComponent(token)}`);
    await page.waitForSelector('[data-testid="confirm-success"]', { timeout: 20000 });
    const account = await page.request.get('/account');
    expect((await account.json()).user.verified).toBe(true);
  });

  test('disabled mode: register is immediately usable (no gate)', async () => {
    // Only meaningful when the stack under test runs in disabled mode.
    test.skip(
      process.env.E2E_EMAIL_MODE !== 'disabled',
      'requires a disabled-mode stack (E2E_EMAIL_MODE=disabled); covered at the API level by the backend suite (T015.14)',
    );

    const email = uniqueEmail('disabled-e2e');
    const res = await fetch(`${API_BASE}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: E2E_PASSWORD, displayName: 'Disabled E2E' }),
    });
    expect(res.status).toBe(201);
    const data = (await res.json()) as { user: { verified?: boolean } };
    expect(data.user.verified).toBe(true, 'disabled mode auto-confirms on register');

    const setCookie = res.headers.get('set-cookie') || '';
    const cookie = `gifty_access=${(setCookie.match(/(?:^|,)\s*gifty_access=([^;]*)/) || [])[1]}`;
    expect((await fetch(`${API_BASE}/lists`, { headers: { Cookie: cookie } })).status).toBe(
      200,
      'no gate in disabled mode',
    );
  });

  test('invite email is captured for a shared list (home link, no token)', async () => {
    // Owner: register + confirm (so the gated list routes work).
    const ownerEmail = uniqueEmail('invite-owner');
    const regRes = await fetch(`${API_BASE}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: ownerEmail, password: E2E_PASSWORD, displayName: 'Invite Owner' }),
    });
    expect(regRes.status).toBe(201);
    const ownerCookie = `gifty_access=${(
      (regRes.headers.get('set-cookie') || '').match(/(?:^|,)\s*gifty_access=([^;]*)/) || []
    )[1]}`;

    const ownerToken = await fetchConfirmationToken(ownerEmail);
    const confirmRes = await fetch(`${API_BASE}/confirm?token=${encodeURIComponent(ownerToken)}`);
    expect(confirmRes.status).toBe(200);

    // Create a list and share it with a fresh (unregistered) guest.
    const listRes = await fetch(`${API_BASE}/lists`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
      body: JSON.stringify({ title: 'E2E Invite List' }),
    });
    expect(listRes.status).toBe(201);
    const { list } = (await listRes.json()) as { list: { id: string } };

    const guestEmail = uniqueEmail('invite-guest');
    const shareRes = await fetch(`${API_BASE}/lists/${list.id}/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
      body: JSON.stringify({ recipientEmail: guestEmail, permission: 'shared' }),
    });
    expect(shareRes.status).toBe(201, 'share never fails because of email');

    // The invite is captured in the outbox: the home link, no token (D9/004 FR-013).
    const row = await fetchInviteRow(guestEmail, list.id);
    expect(row).not.toBeNull();
    expect(row!.subject).toBe("You've been shared a gift list");
    expect(row!.bodyText).toContain('http://localhost:8080/');
    expect(row!.bodyText).not.toContain('token=');
  });
});

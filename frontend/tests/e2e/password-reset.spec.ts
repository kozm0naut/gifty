import { test, expect } from '@playwright/test';
import { uniqueEmail } from './helpers';

/**
 * T021 — E2E spec for the password-reset feature (feature 005).
 *
 * Drives the real React UI (served by the containerized app) against the real
 * Express + Prisma + PostgreSQL backend, in **capture mode** (005 FR-002): no
 * live provider is ever contacted — every reset email lands in the durable
 * `OutboxMessage` row. The suite is run against the Docker stack
 * (`BASE_URL=http://localhost:8080`), so the API is same-origin.
 *
 * Flow (tasks.md T021):
 *   1. request a reset (via the `/forgot-password` UI) — uniform `200 U`;
 *   2. read the captured outbox link (token pulled from the `OutboxMessage`
 *      row via `docker compose exec postgres psql`, the only black-box handle
 *      on a capture-mode email — same inspection path as 004's e2e);
 *   3. follow `/reset/<token>`, set a new password → `200 S`;
 *   4. land signed in on the app home (a fresh session is issued, FR-014);
 *   5. the OLD password is `401` on re-login (the credential is gone);
 *   6. a REPLAY of the consumed link shows the invalid-link copy (`400 I`,
 *      FR-004/FR-005 — single-use, atomic claim).
 *
 * The account is deliberately left UNCONFIRMED after registration: a successful
 * reset confirms an unconfirmed account (005 FR-013), so this exercises the
 * confirm-on-reset path AND proves the post-reset session is immediately usable
 * (dashboard reachable, no confirmation gate).
 */

const API_BASE = process.env.BASE_URL || 'http://localhost:8080';
const REPO_ROOT = process.env.GIFTY_REPO_ROOT || '';
const E2E_OLD_PASSWORD = 'OldPassword123!';
const E2E_NEW_PASSWORD = 'NewPassword456!';
const INVALID_LINK_COPY = 'This reset link is invalid or has expired.';

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
 * Pull the most recent reset token for `email` from the `OutboxMessage` row
 * (capture mode persists every message). Retries a few times to absorb the
 * (rare) enqueue→commit timing gap.
 */
async function fetchResetToken(email: string): Promise<string> {
  const q = `SELECT "bodyText" FROM "OutboxMessage" WHERE "kind" = 'reset' AND lower("recipientEmail") = lower('${email}') ORDER BY "createdAt" DESC LIMIT 1;`;
  let last = '';
  for (let i = 0; i < 8; i++) {
    try {
      const out = await runPsql(q);
      const m = out.match(/reset\/([A-Za-z0-9_-]+)/);
      if (m) return m[1];
      last = out;
    } catch {
      /* retry on transient exec failure */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`no reset token found for ${email}; last body: ${last}`);
}

/**
 * Register a fresh account via the API. Left UNCONFIRMED (capture mode yields
 * an unconfirmed account; the reset under test is what confirms it — 005 FR-013).
 */
async function registerAccount(email: string, password: string, displayName: string): Promise<void> {
  const res = await fetch(`${API_BASE}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, displayName }),
  });
  if (res.status !== 201) {
    const body = await res.text().catch(() => '');
    throw new Error(`register failed: ${res.status} ${body}`);
  }
}

test.describe('password reset (feature 005)', () => {
  test('request → follow captured link → reset → signed in; old pw 401; replay invalid', async ({ page }) => {
    const email = uniqueEmail('reset-flow');

    // 1. Register (unconfirmed) so there is a real account to reset.
    await registerAccount(email, E2E_OLD_PASSWORD, 'Reset Flow');

    // 2. Request a reset through the real UI. The endpoint is uniform (200 U)
    //    regardless of registration (005 FR-002 / SC-002).
    await page.goto('/forgot-password');
    await page.fill('#forgot-email', email);
    await page.getByRole('button', { name: 'Send reset link' }).click();
    await page.waitForSelector('[data-testid="forgot-sent"]', { timeout: 15000 });

    // 3. Read the captured reset link from the outbox (capture mode).
    const token = await fetchResetToken(email);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);

    // 4. Follow the link and set a new password → 200 S (fresh session issued).
    await page.goto(`/reset/${encodeURIComponent(token)}`);
    await page.fill('#reset-new-password', E2E_NEW_PASSWORD);
    await page.fill('#reset-confirm-password', E2E_NEW_PASSWORD);
    await page.getByRole('button', { name: 'Reset password' }).click();

    // 5. Land signed in on the app home (dashboard reachable — the reset also
    //    confirmed the unconfirmed account, 005 FR-013).
    await page.waitForSelector('text=My Lists', { timeout: 20000 });

    // 6. The OLD password is 401 on re-login (the credential was replaced).
    const oldLogin = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: E2E_OLD_PASSWORD }),
    });
    expect(oldLogin.status).toBe(401);

    // Sanity: the NEW password is accepted (the reset actually took effect).
    const newLogin = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: E2E_NEW_PASSWORD }),
    });
    expect(newLogin.status).toBe(200);

    // 7. REPLAY of the consumed link → invalid-link copy (400 I, single-use).
    await page.goto(`/reset/${encodeURIComponent(token)}`);
    await page.fill('#reset-new-password', E2E_NEW_PASSWORD);
    await page.fill('#reset-confirm-password', E2E_NEW_PASSWORD);
    await page.getByRole('button', { name: 'Reset password' }).click();
    await expect(page.getByRole('alert')).toContainText(INVALID_LINK_COPY);
    // Recoverable affordance (not a dead end).
    await expect(page.getByRole('link', { name: /request a new link/i })).toBeVisible();
  });
});

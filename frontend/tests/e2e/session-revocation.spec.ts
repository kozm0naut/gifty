import { test, expect, BrowserContext } from '@playwright/test';
import {
  E2E_PASSWORD,
  apiCreateList,
  confirmAccountIfUnverified,
  logoutViaUI,
  uniqueEmail,
} from './helpers';

/**
 * T026 — E2E spec for the session lifecycle (FR-026 / FR-027, SC-005).
 *
 * Covers the four lifecycle guarantees:
 *   1. Sign-in issues HttpOnly cookies that are NOT readable by page script.
 *   2. Sign-out invalidates both credentials immediately.
 *   3. A revoked session forces re-authentication with the PLAIN notice
 *      (no security-variant wording).
 *   4. A stale refresh-token replay revokes the session family and the app
 *      shows the SECURITY notice recommending a password change.
 *
 * The tests drive the real browser against the real backend (via the Vite
 * proxy on :5173). Session cookies are planted into the browser context via
 * `context.addCookies` so that the HttpOnly flag is exercised end-to-end.
 *
 * To force the in-app 401 → refresh → notice path (rather than a full page
 * reload, which would bypass the refresh dance via bootstrap), tests 3 and 4
 * click the dashboard list card — a client-side React Router navigation that
 * mounts ListPage and fires a fresh `fetchListById` (apiFetch) which 401s
 * after the harness has revoked the session.
 */

// API origin for harness-side calls (Node fetch, no cookie jar).
const API_BASE = process.env.BASE_URL || 'http://localhost:4000';
const ORIGIN = 'http://localhost:5173';

/** Extract the gifty_access and gifty_refresh cookie values from a Set-Cookie header. */
function parseSessionCookies(setCookieHeader: string): { access: string; refresh: string } {
  const accessMatch = setCookieHeader.match(/(?:^|,)\s*gifty_access=([^;]*)/);
  const refreshMatch = setCookieHeader.match(/(?:^|,)\s*gifty_refresh=([^;]*)/);
  if (!accessMatch) throw new Error('no gifty_access in Set-Cookie');
  if (!refreshMatch) throw new Error('no gifty_refresh in Set-Cookie');
  return { access: accessMatch[1], refresh: refreshMatch[1] };
}

/** Register + login via raw fetch, returning the cookie values and the Set-Cookie header. */
async function harnessLogin(email: string, password: string, displayName: string) {
  const regRes = await fetch(`${API_BASE}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, displayName }),
  });
  if (regRes.status !== 201 && regRes.status !== 409) {
    const body = await regRes.text();
    throw new Error(`register failed: ${regRes.status} ${body}`);
  }
  const loginRes = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!loginRes.ok) {
    const body = await loginRes.text();
    throw new Error(`login failed: ${loginRes.status} ${body}`);
  }
  const setCookie = loginRes.headers.get('set-cookie') || '';
  const cookies = parseSessionCookies(setCookie);
  const data = (await loginRes.json()) as { user: { id: string; email: string; displayName: string } };
  // Email is enabled (capture mode): registration yields an unconfirmed account
  // and the dashboard (gated routes) 403s until it confirms. Confirm here so the
  // session-lifecycle flows these tests exercise start from a usable account.
  await confirmAccountIfUnverified(email, `gifty_access=${cookies.access}`);
  return { user: data.user, cookies, setCookieHeader: setCookie };
}

/** Plant both session cookies into the browser context (HttpOnly). */
async function plantCookies(context: BrowserContext, cookies: { access: string; refresh: string }) {
  // Playwright's addCookies accepts `url` OR (`domain` + `path`).
  // The access cookie is path-`/` (sent on every request); the refresh cookie
  // is scoped to `/auth/refresh` by the server. Planting them at their real
  // paths means the server's sign-out clear (max-age=0 at those paths) applies
  // to the exact cookie instances the browser holds — so the browser-jar
  // assertion after sign-out is meaningful.
  await context.addCookies([
    {
      name: 'gifty_access',
      value: cookies.access,
      domain: 'localhost',
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
    },
    {
      name: 'gifty_refresh',
      value: cookies.refresh,
      domain: 'localhost',
      path: '/auth/refresh',
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);
}

async function clearCookies(context: BrowserContext) {
  await context.clearCookies();
}

/** Call the API from the Node harness with a specific access cookie value. */
async function harnessGetAccount(accessCookie: string) {
  const res = await fetch(`${API_BASE}/account`, {
    headers: { Cookie: `gifty_access=${accessCookie}` },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

/** Refresh via the Node harness with a specific refresh cookie value. */
async function harnessRefresh(refreshCookie: string) {
  const res = await fetch(`${API_BASE}/auth/refresh`, {
    method: 'POST',
    headers: { Cookie: `gifty_refresh=${refreshCookie}` },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body, setCookie: res.headers.get('set-cookie') || '' };
}

/** Logout via the Node harness with a specific access cookie value. */
async function harnessLogout(accessCookie: string) {
  const res = await fetch(`${API_BASE}/auth/logout`, {
    method: 'POST',
    headers: { Cookie: `gifty_access=${accessCookie}` },
  });
  return { status: res.status };
}

/**
 * Click the dashboard list card to trigger a client-side navigation to
 * /list/:id. This mounts ListPage and fires a fresh fetchListById (apiFetch)
 * which will 401 after the harness has revoked the session, driving the
 * in-app refresh flow (rather than a full page reload, which would bypass it
 * via the bootstrap 401 → immediate redirect).
 */
async function clickListCard(page, listTitle: string) {
  const card = page.locator('.list-card', { hasText: listTitle });
  await card.locator('.list-card-title').click();
}

test.describe('T026: Session revocation & lifecycle (FR-026/FR-027)', () => {
  test('sign-in issues HttpOnly cookies that are NOT readable by page script', async ({ context, page }) => {
    const email = uniqueEmail('httpOnly');
    const { cookies, setCookieHeader } = await harnessLogin(email, E2E_PASSWORD, 'E2E HttpOnly');

    // The server MUST set the HttpOnly flag on both cookies.
    expect(setCookieHeader).toContain('HttpOnly');
    expect(setCookieHeader).toContain('gifty_access=');
    expect(setCookieHeader).toContain('gifty_refresh=');

    // Plant the cookies in the browser and verify the dashboard loads.
    await plantCookies(context, cookies);
    await page.goto('/');
    await page.waitForSelector('text=My Lists', { timeout: 15000 });

    // HttpOnly cookies are invisible to document.cookie.
    const visibleCookies = await page.evaluate(() => document.cookie);
    expect(visibleCookies).not.toContain('gifty_access');
    expect(visibleCookies).not.toContain('gifty_refresh');

    await clearCookies(context);
  });

  test('sign-out invalidates both credentials immediately', async ({ context, page }) => {
    const email = uniqueEmail('signOut');
    const { cookies } = await harnessLogin(email, E2E_PASSWORD, 'E2E SignOut');

    await plantCookies(context, cookies);
    await page.goto('/');
    await page.waitForSelector('text=My Lists', { timeout: 15000 });

    // Sign out via the UI nav button.
    await logoutViaUI(page);
    await expect(page).toHaveURL(/\/auth/);

    // The browser's session cookies must be cleared by the server's Set-Cookie
    // (max-age=0). Check the Playwright context's cookie jar directly.
    const remaining = await context.cookies();
    const activeCookies = remaining.filter((c) =>
      (c.name === 'gifty_access' || c.name === 'gifty_refresh') && c.value.length > 0,
    );
    expect(activeCookies).toHaveLength(0);

    // The access cookie must now be rejected by the API (session revoked).
    const account = await harnessGetAccount(cookies.access);
    expect(account.status).toBe(401);

    // The refresh cookie must also be rejected (session revoked).
    const refresh = await harnessRefresh(cookies.refresh);
    expect(refresh.status).toBe(401);
    expect(refresh.body.reason).toBe('revoked');

    await clearCookies(context);
  });

  test('revoked session forces re-auth with the plain notice (NO security notice)', async ({ context, page }) => {
    const email = uniqueEmail('revoked');
    const { cookies } = await harnessLogin(email, E2E_PASSWORD, 'E2E Revoked');

    // Create a list so the dashboard has a card to click (client-side nav trigger).
    await apiCreateList(`gifty_access=${cookies.access}`, {
      title: 'E2E Revoked List',
    });

    await plantCookies(context, cookies);
    await page.goto('/');
    await page.waitForSelector('text=My Lists', { timeout: 15000 });

    // Revoke the session from the harness (simulates sign-out elsewhere).
    const logout = await harnessLogout(cookies.access);
    expect(logout.status).toBe(204);

    // Click the list card → client-side nav to /list/:id → fetchListById 401s
    // → in-app refresh with the (now revoked) refresh cookie → 401 'revoked'
    // → PLAIN notice dispatched → redirect to sign-in.
    await clickListCard(page, 'E2E Revoked List');
    await expect(page).toHaveURL(/\/auth/, { timeout: 15000 });

    // The sign-in page must show the plain notice (alert-warning, not alert-error).
    const plainNotice = page.locator('.alert-warning');
    await expect(plainNotice).toBeVisible({ timeout: 10000 });
    const noticeText = (await plainNotice.textContent()) || '';
    expect(noticeText).toContain('Your session has expired. Please log in again.');

    // The security-variant notice must NOT appear anywhere on the page.
    const body = (await page.locator('body').textContent()) || '';
    expect(body).not.toContain('ended for security reasons');
    expect(body).not.toContain('change your password');

    await clearCookies(context);
  });

  test('stale refresh replay revokes the family and shows the security notice', async ({ context, page }) => {
    const email = uniqueEmail('stale');
    const { cookies } = await harnessLogin(email, E2E_PASSWORD, 'E2E Stale');

    // Rotate the refresh token from the harness (R1 → R2). After this, R1 is
    // stale (rotated out) and R2 is current. Capture the new access cookie.
    const rotate1 = await harnessRefresh(cookies.refresh);
    expect(rotate1.status).toBe(200);
    const newCookies = parseSessionCookies(rotate1.setCookie);

    // Create a list using the new (valid) access cookie.
    await apiCreateList(`gifty_access=${newCookies.access}`, {
      title: 'E2E Stale List',
    });

    // Plant the NEW access cookie (still valid) + the STALE refresh cookie (R1)
    // in the browser. The app boots successfully (access cookie is valid).
    await plantCookies(context, { access: newCookies.access, refresh: cookies.refresh });
    await page.goto('/');
    await page.waitForSelector('text=My Lists', { timeout: 15000 });

    // Revoke the session from the harness (makes the access cookie invalid
    // for data calls, forcing the 401 → refresh flow).
    const logout = await harnessLogout(newCookies.access);
    expect(logout.status).toBe(204);

    // Click the list card → client-side nav → fetchListById 401s → in-app
    // refresh with the STALE R1 → rotateSession can't find R1's row (rotated
    // out) → 'stale_refresh' → SECURITY notice → redirect to sign-in.
    await clickListCard(page, 'E2E Stale List');
    await expect(page).toHaveURL(/\/auth/, { timeout: 15000 });

    // The sign-in page must show the security notice (recommending a password change).
    const securityNotice = page.locator('.alert-error');
    await expect(securityNotice).toBeVisible({ timeout: 10000 });
    const noticeText = (await securityNotice.textContent()) || '';
    expect(noticeText).toContain('ended for security reasons');
    expect(noticeText).toContain('change your password');

    // Family-dead assertion: the new access cookie is also rejected, proving
    // the entire session family was revoked.
    const familyCheck = await harnessGetAccount(newCookies.access);
    expect(familyCheck.status).toBe(401);

    // The stale refresh token (R1) is also rejected — it's no longer current.
    const staleCheck = await harnessRefresh(cookies.refresh);
    expect(staleCheck.status).toBe(401);
    expect(staleCheck.body.reason).toBe('stale_refresh');

    await clearCookies(context);
  });
});

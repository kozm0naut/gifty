import { Page } from '@playwright/test';

// API origin for the e2e helpers. Defaults to the dev backend (:4000); when the
// suite targets the containerized app (BASE_URL set, e.g. http://localhost:8080)
// the API is served same-origin, so use that origin instead.
const API_BASE = process.env.BASE_URL || 'http://localhost:4000';
export const E2E_PASSWORD = 'Password123!';

// --- Types ---

export interface ApiUser {
  id: string;
  email: string;
  displayName: string;
}

export interface ApiSession {
  user: ApiUser;
  /** Serialized `Cookie` request-header value (gifty_access only — the
   *  gifty_refresh cookie is Path=/auth/refresh and never needed by the API). */
  cookie: string;
}

/** Extract the `gifty_access=...` pair from a Node fetch Set-Cookie header
 *  (multiple cookies arrive as one comma-joined string). */
function accessCookie(setCookieHeader: string | null | undefined): string {
  if (!setCookieHeader) throw new Error('no Set-Cookie header in response');
  const m = setCookieHeader.match(/(?:^|,)\s*gifty_access=([^;]*)/);
  if (!m) throw new Error('no gifty_access cookie in response');
  return `gifty_access=${m[1]}`;
}

/** Build the `Cookie` request header from an access cookie + the session user. */
function sessionFrom(response: Response, user: ApiUser): ApiSession {
  return { user, cookie: accessCookie(response.headers.get('set-cookie')) };
}

export interface ApiItem {
  id: string;
  giftListId: string;
  name: string;
  description?: string;
  quantity: number;
  unitPrice?: number;
  state: 'available' | 'claimed' | 'purchased';
  claimantUserId?: string;
  claimantDisplayName?: string | null;
}

export interface ApiList {
  id: string;
  title: string;
  description?: string;
  owner?: { id: string; displayName: string; email: string };
  items?: ApiItem[];
}

export interface ApiSharePermission {
  id: string;
  giftListId: string;
  /** Present only on the recipient-facing `/recipients` shape; the owner's
   *  uniform share-permissions view omits it (it would fingerprint
   *  registration status) and carries the invite email instead. */
  recipientUserId?: string | null;
  recipientDisplayName: string | null;
  permission: string;
  /** Invite email — the owner's source of truth for every uniform entry. */
  recipientEmail?: string | null;
}

// --- API helpers ---

async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`API ${response.status}: ${data.message || response.statusText}`);
  }
  return data as T;
}

/**
 * Run a read-only SQL query against the stack's internal Postgres container.
 * `docker compose exec -T postgres psql -U gifty -d gifty -tA -c <q>`.
 * Used only by tests that must read server-side state (the captured
 * confirmation token lives in the outbox row, inside the container).
 */
async function runPsql(query: string): Promise<string> {
  const { execFile } = await import('node:child_process');
  const repoRoot = process.env.GIFTY_REPO_ROOT || '';
  const args = [
    'compose',
    ...(repoRoot ? ['-f', `${repoRoot}/docker-compose.yml`, '--project-directory', repoRoot] : []),
    'exec', '-T', 'postgres', 'psql', '-U', 'gifty', '-d', 'gifty', '-tA', '-c', query,
  ];
  return new Promise<string>((resolve, reject) => {
    execFile('docker', args, { maxBuffer: 1024 * 1024, timeout: 30_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`psql failed: ${err.message}\n${stderr || ''}`));
      else resolve(stdout);
    });
  });
}

/**
 * Confirm a freshly-registered account by following its captured confirmation
 * link (the token is read from the durable outbox row). No-op when the account
 * is already verified (email disabled → register auto-confirms, no outbox row).
 *
 * With email enabled (capture/live mode) registration now yields an UNCONFIRMED
 * account and the gated list routes 403 until it confirms. The pre-email e2e
 * specs assume confirmed accounts, so we confirm here to keep them green against
 * a capture-mode stack — this only adds a confirmation step and does not change
 * the session/consent/claim flows those specs exercise.
 */
export async function confirmAccountIfUnverified(email: string, cookie?: string): Promise<void> {
  let token = '';
  for (let i = 0; i < 6 && !token; i++) {
    try {
      // The backend normalizes emails to lowercase; compare case-insensitively.
      const q = `SELECT "bodyText" FROM "OutboxMessage" WHERE "kind" = 'confirmation' AND lower("recipientEmail") = lower('${email}') ORDER BY "createdAt" DESC LIMIT 1;`;
      const out = await runPsql(q);
      const m = out.match(/confirm\?token=([^\s&"'<>]+)/);
      if (m) token = decodeURIComponent(m[1]);
    } catch {
      /* retry on transient exec failure */
    }
    if (!token) await new Promise((r) => setTimeout(r, 400));
  }
  if (!token) return; // no captured confirmation email → already verified (email disabled)
  await apiFetch<unknown>(`/confirm?token=${encodeURIComponent(token)}`, {
    method: 'GET',
    cookie,
  });
}

export async function apiRegister(
  email: string,
  password: string,
  displayName: string,
): Promise<ApiSession> {
  const response = await fetch(`${API_BASE}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, displayName }),
  });
  const data = (await response.json().catch(() => ({}))) as { user: ApiUser };
  if (!response.ok || !data?.user) {
    throw new Error(`API ${response.status}: registration failed`);
  }
  if (data.user.verified !== true) {
    const cookie = sessionFrom(response, data.user).cookie;
    await confirmAccountIfUnverified(email, cookie);
    try {
      const acct = await apiFetch<{ user?: ApiUser }>('/account', { method: 'GET', cookie });
      if (acct.user) data.user = acct.user;
    } catch {
      /* keep the registration response's user if the refresh fails */
    }
  }
  return sessionFrom(response, data.user);
}

export async function apiLogin(email: string, password: string): Promise<ApiSession> {
  const response = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data = (await response.json().catch(() => ({}))) as { user: ApiUser };
  if (!response.ok || !data?.user) {
    throw new Error(`API ${response.status}: login failed`);
  }
  return sessionFrom(response, data.user);
}

export function apiCreateList(
  cookie: string,
  payload: { title: string; description?: string },
): Promise<{ list: ApiList }> {
  return apiFetch('/lists', {
    method: 'POST',
    headers: { Cookie: cookie },
    body: JSON.stringify(payload),
  });
}

export function apiCreateItem(
  cookie: string,
  listId: string,
  payload: { name: string; description?: string; quantity?: number; unitPrice?: number },
): Promise<{ item: ApiItem }> {
  return apiFetch(`/lists/${listId}/items`, {
    method: 'POST',
    headers: { Cookie: cookie },
    body: JSON.stringify({ quantity: 1, ...payload }),
  });
}

export function apiShareList(
  cookie: string,
  listId: string,
  recipientEmail: string,
): Promise<{ sharePermission: ApiSharePermission }> {
  return apiFetch(`/lists/${listId}/share`, {
    method: 'POST',
    headers: { Cookie: cookie },
    body: JSON.stringify({ recipientEmail, permission: 'shared' }),
  });
}

export function apiClaimItem(cookie: string, itemId: string): Promise<{ item: ApiItem }> {
  return apiFetch(`/items/${itemId}/claim`, {
    method: 'POST',
    headers: { Cookie: cookie },
  });
}

export function apiPurchaseItem(cookie: string, itemId: string): Promise<{ item: ApiItem }> {
  return apiFetch(`/items/${itemId}/purchase`, {
    method: 'POST',
    headers: { Cookie: cookie },
  });
}

export function apiUnclaimItem(cookie: string, itemId: string): Promise<{ item: ApiItem }> {
  return apiFetch(`/items/${itemId}/unclaim`, {
    method: 'POST',
    headers: { Cookie: cookie },
  });
}

export function apiUnpurchaseItem(cookie: string, itemId: string): Promise<{ item: ApiItem }> {
  return apiFetch(`/items/${itemId}/unpurchase`, {
    method: 'POST',
    headers: { Cookie: cookie },
  });
}

export function apiFetchList(cookie: string, listId: string): Promise<{ list: ApiList }> {
  return apiFetch(`/lists/${listId}`, {
    headers: { Cookie: cookie },
  });
}

export function apiFetchLists(cookie: string): Promise<{ lists: ApiList[] }> {
  return apiFetch('/lists', {
    headers: { Cookie: cookie },
  });
}

export function apiFetchSharePermissions(
  cookie: string,
  listId: string,
): Promise<{ permissions: ApiSharePermission[] }> {
  return apiFetch(`/lists/${listId}/share-permissions`, {
    headers: { Cookie: cookie },
  });
}

export function apiRevokePermission(cookie: string, listId: string, permissionId: string): Promise<void> {
  return apiFetch(`/lists/${listId}/share/${permissionId}`, {
    method: 'DELETE',
    headers: { Cookie: cookie },
  });
}

// --- UI helpers ---

/**
 * Logs in via the UI auth page and waits for the dashboard to load.
 */
export async function loginViaUI(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/auth');
  await page.fill('#auth-email', email);
  await page.fill('#auth-password', password);
  await page.click('button[type="submit"]');
  await page.waitForSelector('text=My Lists', { timeout: 15000 });
}

/**
 * Logs out via the nav bar and waits for the auth page to load.
 */
export async function logoutViaUI(page: Page): Promise<void> {
  await page.click('.nav-user-cluster');
  await page.click('button.nav-logout');
  await page.waitForSelector('#auth-email', { timeout: 10000 });
}

/**
 * Dismiss the US5 name-disclosure consent prompt (if shown) by revealing the
 * recipient's name. Recipients see this one-time prompt on first open of a
 * shared list (consent `pending`); pre-US5 recipient flows that then interact
 * with the list (e.g. click "Claim") must acknowledge it first. No-op when no
 * prompt is visible (e.g. owner views, or consent already acted on).
 */
export async function dismissConsentPromptIfPresent(page: Page): Promise<void> {
  const dialog = page.getByRole('dialog', { name: /name disclosure/i });
  if (await dialog.count()) {
    // Scope to the dialog: the share-section's self-serve control also has a
    // "Reveal my name" button, so an unscoped role query would be ambiguous.
    await dialog.getByRole('button', { name: 'Reveal my name' }).click();
    await dialog.waitFor({ state: 'detached', timeout: 10000 });
  }
}

/**
 * Generates a unique email address for e2e test users.
 */
export function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@e2e.test`;
}

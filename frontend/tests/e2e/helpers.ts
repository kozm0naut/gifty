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
  recipientUserId: string;
  recipientDisplayName: string;
  permission: string;
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
  await page.click('button.nav-logout');
  await page.waitForSelector('#auth-email', { timeout: 10000 });
}

/**
 * Generates a unique email address for e2e test users.
 */
export function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@e2e.test`;
}

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

export interface ApiToken {
  user: ApiUser;
  token: string;
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

export function apiRegister(email: string, password: string, displayName: string): Promise<ApiToken> {
  return apiFetch<ApiToken>('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password, displayName }),
  });
}

export function apiLogin(email: string, password: string): Promise<ApiToken> {
  return apiFetch<ApiToken>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
}

export function apiCreateList(
  token: string,
  payload: { title: string; description?: string },
): Promise<{ list: ApiList }> {
  return apiFetch('/lists', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
}

export function apiCreateItem(
  token: string,
  listId: string,
  payload: { name: string; description?: string; quantity?: number; unitPrice?: number },
): Promise<{ item: ApiItem }> {
  return apiFetch(`/lists/${listId}/items`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ quantity: 1, ...payload }),
  });
}

export function apiShareList(
  token: string,
  listId: string,
  recipientEmail: string,
): Promise<{ sharePermission: ApiSharePermission }> {
  return apiFetch(`/lists/${listId}/share`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ recipientEmail, permission: 'shared' }),
  });
}

export function apiClaimItem(token: string, itemId: string): Promise<{ item: ApiItem }> {
  return apiFetch(`/items/${itemId}/claim`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
}

export function apiPurchaseItem(token: string, itemId: string): Promise<{ item: ApiItem }> {
  return apiFetch(`/items/${itemId}/purchase`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
}

export function apiUnclaimItem(token: string, itemId: string): Promise<{ item: ApiItem }> {
  return apiFetch(`/items/${itemId}/unclaim`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
}

export function apiUnpurchaseItem(token: string, itemId: string): Promise<{ item: ApiItem }> {
  return apiFetch(`/items/${itemId}/unpurchase`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
}

export function apiFetchList(token: string, listId: string): Promise<{ list: ApiList }> {
  return apiFetch(`/lists/${listId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export function apiFetchLists(token: string): Promise<{ lists: ApiList[] }> {
  return apiFetch('/lists', {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export function apiFetchSharePermissions(
  token: string,
  listId: string,
): Promise<{ permissions: ApiSharePermission[] }> {
  return apiFetch(`/lists/${listId}/share-permissions`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export function apiRevokePermission(token: string, listId: string, permissionId: string): Promise<void> {
  return apiFetch(`/lists/${listId}/share/${permissionId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
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

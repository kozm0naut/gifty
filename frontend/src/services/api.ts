const AUTH_TOKEN_KEY = 'gift-list-token';
const USER_KEY = 'gift-list-user';
export const SESSION_EXPIRED_EVENT = 'gift-list:session-expired';
// API base URL. Defaults to same-origin (relative paths) so the containerized
// single-origin deployment (SPA + API on one host/port) works without config;
// set VITE_API_URL to point at a different API origin (e.g. dev on :4000).
const API_BASE_URL = import.meta.env.VITE_API_URL || '';

export type AuthPayload =
  | { email: string; password: string }
  | { email: string; password: string; displayName: string };

export type ListOwner = {
  id: string;
  displayName: string;
  email: string;
};

export type GiftList = {
  id: string;
  title: string;
  description?: string;
  owner?: ListOwner | null;
  createdAt: string;
  updatedAt: string;
};

export type GiftItem = {
  id: string;
  giftListId: string;
  name: string;
  description?: string;
  quantity?: number | null;
  unitPrice?: number;
  state: 'available' | 'claimed' | 'purchased';
  claimantUserId?: string;
  /** Resolved display name of the claimant (recipient-facing only; FR-009).
   *  The purchaser is always the claimant, so this single name covers both. */
  claimantDisplayName?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type DashboardList = GiftList & {
  items?: GiftItem[];
};

export type SharePermission = {
  id: string;
  recipientUserId: string;
  recipientDisplayName: string;
  permission: 'shared';
};

function getAuthHeaders(): HeadersInit {
  const token = localStorage.getItem(AUTH_TOKEN_KEY);
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function handleResponse<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) {
      // The stored session is no longer valid — clear it so the app
      // redirects to the auth page instead of showing a broken dashboard.
      localStorage.removeItem(AUTH_TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
      const message = data.message || 'Your session has expired. Please log in again.';
      window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT, { detail: { message } }));
    }
    throw new Error(data.message || 'API request failed');
  }
  return data;
}

// Auth endpoints (login/register) are unauthenticated by definition, so a 401
// here means "bad credentials", NOT an expired session. Using handleResponse
// would wrongly dispatch the session-expired event and surface a duplicate
// message on the auth page.
async function handleAuthResponse<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.message || 'Authentication failed');
  }
  return data;
}

export async function register(payload: AuthPayload) {
  const response = await fetch(`${API_BASE_URL}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return handleAuthResponse<any>(response);
}

export async function login(payload: AuthPayload) {
  const response = await fetch(`${API_BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return handleAuthResponse<any>(response);
}

export async function fetchLists(): Promise<DashboardList[]> {
  const response = await fetch(`${API_BASE_URL}/lists`, {
    headers: getAuthHeaders(),
  });
  const data = await handleResponse<{ lists: DashboardList[] }>(response);
  return data.lists ?? [];
}

export async function fetchListById(listId: string): Promise<DashboardList> {
  const response = await fetch(`${API_BASE_URL}/lists/${listId}`, {
    headers: getAuthHeaders(),
  });
  const data = await handleResponse<{ list: DashboardList }>(response);
  return data.list;
}

/**
 * Fetch the recipients shared on a list. Accessible to any authorized viewer
 * (owner or recipient) — returns minimal identity info (display names only)
 * so the avatar stack can be rendered in both views.
 */
export async function fetchListRecipients(listId: string): Promise<SharePermission[]> {
  const response = await fetch(`${API_BASE_URL}/lists/${listId}/recipients`, {
    headers: getAuthHeaders(),
  });
  const data = await handleResponse<{ recipients: SharePermission[] }>(response);
  return data.recipients ?? [];
}

export async function createList(payload: { title: string; description?: string }): Promise<DashboardList> {
  const response = await fetch(`${API_BASE_URL}/lists`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify(payload),
  });
  const data = await handleResponse<{ list: DashboardList }>(response);
  return data.list;
}

export async function shareList(listId: string, payload: { recipientUserId?: string; recipientEmail?: string; permission: 'shared' }) {
  const response = await fetch(`${API_BASE_URL}/lists/${listId}/share`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify(payload),
  });
  const data = await handleResponse<any>(response);
  return data.sharePermission;
}

export async function updateList(listId: string, payload: { title: string; description?: string | null }): Promise<DashboardList> {
  const response = await fetch(`${API_BASE_URL}/lists/${listId}`, {
    method: 'PATCH',
    headers: getAuthHeaders(),
    body: JSON.stringify(payload),
  });
  const data = await handleResponse<{ list: DashboardList }>(response);
  return data.list;
}

export async function deleteList(listId: string) {
  const response = await fetch(`${API_BASE_URL}/lists/${listId}`, {
    method: 'DELETE',
    headers: getAuthHeaders(),
  });
  return handleResponse<any>(response);
}

export async function createGiftItem(listId: string, payload: { name: string; description?: string; quantity?: number; unitPrice?: number }) {
  const response = await fetch(`${API_BASE_URL}/lists/${listId}/items`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify(payload),
  });
  const data = await handleResponse<{ item: GiftItem }>(response);
  return data.item;
}

export async function claimGiftItem(itemId: string) {
  const response = await fetch(`${API_BASE_URL}/items/${itemId}/claim`, {
    method: 'POST',
    headers: getAuthHeaders(),
  });
  const data = await handleResponse<{ item: GiftItem }>(response);
  return data.item;
}

export async function purchaseGiftItem(itemId: string) {
  const response = await fetch(`${API_BASE_URL}/items/${itemId}/purchase`, {
    method: 'POST',
    headers: getAuthHeaders(),
  });
  const data = await handleResponse<{ item: GiftItem }>(response);
  return data.item;
}

export async function unclaimGiftItem(itemId: string) {
  const response = await fetch(`${API_BASE_URL}/items/${itemId}/unclaim`, {
    method: 'POST',
    headers: getAuthHeaders(),
  });
  const data = await handleResponse<{ item: GiftItem }>(response);
  return data.item;
}

export async function unpurchaseGiftItem(itemId: string) {
  const response = await fetch(`${API_BASE_URL}/items/${itemId}/unpurchase`, {
    method: 'POST',
    headers: getAuthHeaders(),
  });
  const data = await handleResponse<{ item: GiftItem }>(response);
  return data.item;
}

export async function fetchSharePermissions(listId: string): Promise<SharePermission[]> {
  const response = await fetch(`${API_BASE_URL}/lists/${listId}/share-permissions`, {
    headers: getAuthHeaders(),
  });
  const data = await handleResponse<{ permissions: SharePermission[] }>(response);
  return data.permissions ?? [];
}

export async function revokePermission(listId: string, permissionId: string): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/lists/${listId}/share/${permissionId}`, {
    method: 'DELETE',
    headers: getAuthHeaders(),
  });
  if (!response.ok) {
    throw new Error('Failed to revoke permission');
  }
}

export const SESSION_EXPIRED_EVENT = 'gift-list:session-expired';

/** Detail payload of SESSION_EXPIRED_EVENT (FR-027). */
export interface SessionExpiredDetail {
  message: string;
  /** True when the termination was triggered by refresh-token reuse (theft signal, FR-026). */
  security?: boolean;
}

/** Plain notice: session expired or revoked — no theft signal (FR-027). */
export const SESSION_EXPIRED_MESSAGE = 'Your session has expired. Please log in again.';

/** Security notice: refresh-token reuse detected — recommend a password change (FR-027). */
export const SESSION_SECURITY_MESSAGE =
  'Your session was ended for security reasons. For your safety, please change your password and sign in again.';

export type AccountUser = {
  id: string;
  email: string;
  displayName: string;
};
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

/** Name-disclosure consent state on a list (US5, FR-021–FR-024). */
export type ConsentState = 'pending' | 'revealed' | 'declined';

export type SharePermission = {
  id: string;
  /** Null for a pending invitation (shared to an unregistered email). */
  recipientUserId: string | null;
  recipientDisplayName: string;
  permission: 'shared';
  /** Invite email — owner-only visibility (FR-010/FR-025). */
  recipientEmail?: string | null;
  /** The recipient's name-disclosure consent on this list (US5). */
  consent?: ConsentState;
};

// Session termination (FR-027): the session was ended — either expired,
// revoked by the user elsewhere, or by refresh-token reuse (theft signal).
// `security` drives the stronger FR-027 notice on the sign-in page.
function dispatchSessionExpired(detail: SessionExpiredDetail): void {
  window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT, { detail }));
}

// Single-flight guard: concurrent 401s must trigger exactly one refresh.
let refreshPromise: Promise<Response> | null = null;

// Transparent session refresh (T028): try POST /auth/refresh ONCE. The
// server rotates the refresh cookie and issues a new access cookie; the
// browser stores both automatically (HttpOnly — never read here).
function refreshOnce(): Promise<Response> {
  if (!refreshPromise) {
    refreshPromise = fetch(`${API_BASE_URL}/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
    }).finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

// Authenticated request wrapper (T028): the browser sends the HttpOnly
// gifty_access cookie automatically (same-origin). On 401 we attempt ONE
// refresh, then retry the original request exactly once. If the refresh
// fails we surface the FR-027 notice:
//   - reason "stale_refresh"  → theft signal → security notice
//   - "expired" / "revoked"   → plain expiry notice
async function handleResponse<T>(response: Response, retry?: () => Promise<Response>): Promise<T> {
  if (!response.ok && response.status === 401 && retry) {
    const refreshed = await refreshOnce().catch(() => null);
    if (refreshed?.ok) {
      const retried = await retry();
      if (retried.ok) {
        const data = await retried.json().catch(() => ({}));
        return data as T;
      }
      return handleResponse(retried);
    }
    let reason: string | undefined;
    try {
      reason = (await refreshed?.json().catch(() => ({}))).reason;
    } catch {
      /* no body — fall through to the plain notice */
    }
    dispatchSessionExpired(
      reason === 'stale_refresh'
        ? { message: SESSION_SECURITY_MESSAGE, security: true }
        : { message: SESSION_EXPIRED_MESSAGE },
    );
    throw new Error(reason === 'stale_refresh' ? SESSION_SECURITY_MESSAGE : SESSION_EXPIRED_MESSAGE);
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.message || 'API request failed');
  }
  return data;
}

/**
 * Authenticated JSON request (T028). The session credential is the HttpOnly
 * `gifty_access` cookie, sent automatically by the browser (same-origin);
 * we never read, store, or log it. `body`, when present, is JSON-encoded.
 */
async function apiFetch<T>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const method = options.method ?? 'GET';
  const doFetch = () =>
    fetch(`${API_BASE_URL}${path}`, {
      method,
      credentials: 'include',
      headers: options.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
  const response = await doFetch();
  // 204 No Content (e.g. DELETE share permission) — no body to parse.
  if (response.status === 204) return undefined as T;
  return handleResponse<T>(response, doFetch);
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
    credentials: 'include',
    body: JSON.stringify(payload),
  });
  return handleAuthResponse<any>(response);
}

export async function login(payload: AuthPayload) {
  const response = await fetch(`${API_BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(payload),
  });
  return handleAuthResponse<any>(response);
}

/**
 * Bootstrap the session from the HttpOnly `gifty_access` cookie (T027).
 * 200 → `{ user }`; 401 → no active session.
 */
export async function fetchAccount(): Promise<AccountUser> {
  const response = await fetch(`${API_BASE_URL}/account`, {
    credentials: 'include',
  });
  if (response.status === 401) {
    throw new Error('no active session');
  }
  const data = await handleResponse<{ user: AccountUser }>(response);
  if (!data?.user) {
    throw new Error('no active session');
  }
  return data.user;
}

/**
 * Sign out (FR-008): the server revokes the session family and clears both
 * cookies. A 401 here simply means the session was already gone — treat as
 * success so the UI can always complete a clean sign-out.
 */
export async function logoutSession(): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/auth/logout`, {
    method: 'POST',
    credentials: 'include',
  });
  if (response.status !== 204 && response.status !== 401) {
    throw new Error('Failed to sign out');
  }
}

/**
 * Remove the account (feature 003, US7, FR-014 / FR-028). Irreversible: the
 * server atomically deletes the user, their owned lists, recipient-side
 * permissions, sessions, and pending invitations, and reverts their claims on
 * others' items. Both session cookies are cleared. 204 on success; 401 if the
 * session is already gone.
 */
export async function deleteAccount(): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/account`, {
    method: 'DELETE',
    credentials: 'include',
  });
  if (response.status !== 204 && response.status !== 401) {
    throw new Error('Failed to remove account');
  }
}

export async function fetchLists(): Promise<DashboardList[]> {
  const data = await apiFetch<{ lists: DashboardList[] }>('/lists');
  return data.lists ?? [];
}

export async function fetchListById(listId: string): Promise<DashboardList> {
  const data = await apiFetch<{ list: DashboardList }>(`/lists/${listId}`);
  return data.list;
}

/**
 * Fetch the recipients shared on a list. Accessible to any authorized viewer
 * (owner or recipient) — returns minimal identity info (display names only)
 * so the avatar stack can be rendered in both views.
 */
export async function fetchListRecipients(listId: string): Promise<SharePermission[]> {
  const data = await apiFetch<{ recipients: SharePermission[] }>(`/lists/${listId}/recipients`);
  return data.recipients ?? [];
}

export async function createList(payload: { title: string; description?: string }): Promise<DashboardList> {
  const data = await apiFetch<{ list: DashboardList }>('/lists', { method: 'POST', body: payload });
  return data.list;
}

export async function shareList(listId: string, payload: { recipientUserId?: string; recipientEmail?: string; permission: 'shared' }) {
  const data = await apiFetch<any>(`/lists/${listId}/share`, { method: 'POST', body: payload });
  return data.sharePermission;
}

export async function updateList(listId: string, payload: { title: string; description?: string | null }): Promise<DashboardList> {
  const data = await apiFetch<{ list: DashboardList }>(`/lists/${listId}`, { method: 'PATCH', body: payload });
  return data.list;
}

export async function deleteList(listId: string): Promise<void> {
  await apiFetch<{ ok: boolean }>(`/lists/${listId}`, { method: 'DELETE' });
}

export async function createGiftItem(listId: string, payload: { name: string; description?: string; quantity?: number; unitPrice?: number }): Promise<GiftItem> {
  const data = await apiFetch<{ item: GiftItem }>(`/lists/${listId}/items`, { method: 'POST', body: payload });
  return data.item;
}

export async function claimGiftItem(itemId: string): Promise<GiftItem> {
  const data = await apiFetch<{ item: GiftItem }>(`/items/${itemId}/claim`, { method: 'POST' });
  return data.item;
}

export async function purchaseGiftItem(itemId: string): Promise<GiftItem> {
  const data = await apiFetch<{ item: GiftItem }>(`/items/${itemId}/purchase`, { method: 'POST' });
  return data.item;
}

export async function unclaimGiftItem(itemId: string): Promise<GiftItem> {
  const data = await apiFetch<{ item: GiftItem }>(`/items/${itemId}/unclaim`, { method: 'POST' });
  return data.item;
}

export async function unpurchaseGiftItem(itemId: string): Promise<GiftItem> {
  const data = await apiFetch<{ item: GiftItem }>(`/items/${itemId}/unpurchase`, { method: 'POST' });
  return data.item;
}

export async function fetchSharePermissions(listId: string): Promise<SharePermission[]> {
  const data = await apiFetch<{ permissions: SharePermission[] }>(`/lists/${listId}/share-permissions`);
  return data.permissions ?? [];
}

/** A pending invitation: shared to an email with no account yet (US5). */
export type PendingInvitation = {
  id: string;
  giftListId: string;
  inviteeEmail: string;
  status: 'pending' | 'matched' | 'discarded';
  createdAt: string;
};

/**
 * Owner-only: the list's pending invitations (shared to emails that have not
 * registered yet). The owner sees the invite email as the source of truth.
 */
export async function fetchPendingInvitations(listId: string): Promise<PendingInvitation[]> {
  const data = await apiFetch<{ pendingInvitations: PendingInvitation[] }>(
    `/lists/${listId}/share-permissions`,
  );
  return data.pendingInvitations ?? [];
}

export async function revokePermission(listId: string, permissionId: string): Promise<void> {
  await apiFetch<unknown>(`/lists/${listId}/share/${permissionId}`, { method: 'DELETE' });
}

// ── US5: name-disclosure consent (FR-021–FR-024) ─────────────────────────────

export type ConsentInfo = {
  consent: ConsentState;
  /** The caller's own display name (always visible to themselves). */
  displayName: string;
};

/**
 * Read the caller's consent state on a list. Recipient-only (the list owner
 * gets a 403 — consent is not owner-queryable data).
 */
export async function fetchConsent(listId: string): Promise<ConsentInfo> {
  const data = await apiFetch<ConsentInfo>(`/lists/${listId}/consent`);
  return data;
}

/**
 * Set the caller's consent to reveal or hide their display name on a list
 * (FR-023). Idempotent and reversible at any time.
 */
export async function setConsent(listId: string, consent: ConsentState): Promise<{ consent: ConsentState }> {
  const data = await apiFetch<{ consent: ConsentState }>(`/lists/${listId}/consent`, {
    method: 'POST',
    body: { consent },
  });
  return data;
}

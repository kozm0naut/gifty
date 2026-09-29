import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SESSION_EXPIRED_EVENT,
  SESSION_EXPIRED_MESSAGE,
  SESSION_SECURITY_MESSAGE,
  fetchAccount,
  fetchLists,
  logoutSession,
} from './api';

function jsonResponse(status: number, body?: unknown, headers: Record<string, string> = {}): Response {
  const ok = status >= 200 && status < 300;
  return {
    ok,
    status,
    statusText: '',
    headers: new Headers(headers),
    json: async () => (body === undefined ? {} : body),
  } as Response;
}

describe('api.ts session handling (T028)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    vi.stubGlobal('fetch', fetchMock);
  });

  it('on 401 → refreshes once, retries once, and succeeds without any Authorization header', async () => {
    let listsCalls = 0;
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/lists')) {
        listsCalls += 1;
        if (listsCalls === 1) {
          return jsonResponse(401, { error: 'Authentication required' });
        }
        return jsonResponse(200, { lists: [{ id: 'l1' }] });
      }
      if (url.includes('/auth/refresh')) {
        return jsonResponse(
          200,
          { user: { id: 'u1' } },
          { 'set-cookie': 'gifty_access=fresh-jwt; Path=/; HttpOnly; SameSite=Lax' },
        );
      }
      return jsonResponse(200, {});
    });

    const lists = await fetchLists();

    expect(lists).toEqual([{ id: 'l1' }]);
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.filter((u) => u.includes('/lists'))).toHaveLength(2); // original + exactly one retry
    expect(urls.filter((u) => u.includes('/auth/refresh'))).toHaveLength(1);
    // No request may ever carry an Authorization header (T012).
    for (const call of fetchMock.mock.calls) {
      const headers = call[1]?.headers as Record<string, string> | undefined;
      expect(headers?.Authorization).toBeUndefined();
    }
  });

  it('stale_refresh → dispatches a security notice and throws the security message', async () => {
    const listener = vi.fn();
    window.addEventListener(SESSION_EXPIRED_EVENT, listener);

    let listsCalls = 0;
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/lists')) {
        listsCalls += 1;
        return jsonResponse(401, { error: 'Authentication required' });
      }
      if (url.includes('/auth/refresh')) {
        return jsonResponse(401, { error: 'Session is no longer active.', reason: 'stale_refresh' });
      }
      return jsonResponse(200, {});
    });

    await expect(fetchLists()).rejects.toThrow(SESSION_SECURITY_MESSAGE);

    expect(listsCalls).toBe(1); // the refresh failed, so the retry never happens
    const detail = (listener.mock.calls[0]?.[0] as CustomEvent).detail;
    expect(detail).toEqual({ message: SESSION_SECURITY_MESSAGE, security: true });
    window.removeEventListener(SESSION_EXPIRED_EVENT, listener);
  });

  it('revoked → dispatches the PLAIN notice (no security signal) and throws the plain message', async () => {
    const listener = vi.fn();
    window.addEventListener(SESSION_EXPIRED_EVENT, listener);

    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/lists')) {
        return jsonResponse(401, { error: 'Authentication required' });
      }
      if (url.includes('/auth/refresh')) {
        return jsonResponse(401, { error: 'Session is no longer active.', reason: 'revoked' });
      }
      return jsonResponse(200, {});
    });

    await expect(fetchLists()).rejects.toThrow(SESSION_EXPIRED_MESSAGE);

    const detail = (listener.mock.calls[0]?.[0] as CustomEvent).detail;
    expect(detail).toEqual({ message: SESSION_EXPIRED_MESSAGE }); // security absent, not true
    window.removeEventListener(SESSION_EXPIRED_EVENT, listener);
  });

  it('never reads a credential from script storage', async () => {
    const getItemSpy = vi.spyOn(Storage.prototype, 'getItem');
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
    const removeItemSpy = vi.spyOn(Storage.prototype, 'removeItem');

    let listsCalls = 0;
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/lists')) {
        listsCalls += 1;
        if (listsCalls === 1) return jsonResponse(401, { error: 'Authentication required' });
        return jsonResponse(200, { lists: [] });
      }
      if (url.includes('/auth/refresh')) {
        return jsonResponse(200, { user: { id: 'u1' } });
      }
      return jsonResponse(200, {});
    });

    await fetchLists();

    expect(getItemSpy).not.toHaveBeenCalled();
    expect(setItemSpy).not.toHaveBeenCalled();
    expect(removeItemSpy).not.toHaveBeenCalled();
  });

  it('fetchAccount: 401 → throws "no active session"', async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, { error: 'Authentication required' }));
    await expect(fetchAccount()).rejects.toThrow('no active session');
  });

  it('logoutSession: 204 and 401 are both success; other statuses throw', async () => {
    fetchMock.mockResolvedValue(jsonResponse(204, undefined));
    await expect(logoutSession()).resolves.toBeUndefined();

    fetchMock.mockResolvedValue(jsonResponse(401, { error: 'Session is no longer active.' }));
    await expect(logoutSession()).resolves.toBeUndefined();

    fetchMock.mockResolvedValue(jsonResponse(500, { error: 'boom' }));
    await expect(logoutSession()).rejects.toThrow('Failed to sign out');
  });
});

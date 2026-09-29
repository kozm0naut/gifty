import React, { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ReactDOM from 'react-dom/client';
import {
  SESSION_EXPIRED_EVENT,
  SESSION_EXPIRED_MESSAGE,
  SESSION_SECURITY_MESSAGE,
  fetchAccount,
  logoutSession,
} from '../services/api';
import { AuthProvider, useAuth } from './AuthContext';
import type { User } from './AuthContext';

vi.mock('../services/api', () => ({
  SESSION_EXPIRED_EVENT: 'gift-list:session-expired',
  SESSION_EXPIRED_MESSAGE: 'Your session has expired. Please log in again.',
  SESSION_SECURITY_MESSAGE:
    'Your session was ended for security reasons. For your safety, please change your password and sign in again.',
  fetchAccount: vi.fn(),
  logoutSession: vi.fn(),
}));

const ALICE: User = { id: 'user_alice', email: 'alice@example.com', displayName: 'Alice' };

interface Mount {
  /** The latest context value (probe re-renders on every state change). */
  value: () => ReturnType<typeof useAuth> | undefined;
  /** Resolve pending microtasks (bootstrap promise) and flush React updates. */
  flush: () => Promise<void>;
  unmount: () => void;
}

function mount(): Mount {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = ReactDOM.createRoot(container);

  let current: ReturnType<typeof useAuth> | undefined;
  const Probe = () => {
    current = useAuth();
    return null;
  };

  act(() => {
    root.render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
  });

  return {
    value: () => current,
    flush: async () => {
      await act(async () => {
        await Promise.resolve();
      });
    },
    unmount: () => act(() => root.unmount()),
  };
}

/** Fire a session-expired event with the given detail. */
function expireSession(detail: { message: string; security?: boolean }): void {
  act(() => {
    window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT, { detail }));
  });
}

describe('AuthContext (T027)', () => {
  beforeEach(() => {
    vi.mocked(fetchAccount).mockReset();
    vi.mocked(logoutSession).mockReset();
    document.body.innerHTML = '';

    // jsdom has no localStorage; the login test asserts nothing is written
    // to script storage, so provide a fresh in-memory stub (same pattern as
    // App.test.tsx).
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => (store.has(key) ? store.get(key) ?? null : null),
      setItem: (key: string, value: string) => {
        store.set(key, String(value));
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
      clear: () => {
        store.clear();
      },
      key: (index: number) => Array.from(store.keys())[index] ?? null,
      get length() {
        return store.size;
      },
    } as unknown as Storage;
    Object.defineProperty(window, 'localStorage', { value: storage, configurable: true });
    Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
  });

  it('bootstraps the user from GET /account and clears isInitializing', async () => {
    vi.mocked(fetchAccount).mockResolvedValue(ALICE);
    const m = mount();
    await m.flush();

    expect(fetchAccount).toHaveBeenCalledTimes(1);
    expect(m.value()).toMatchObject({ user: ALICE, isAuthenticated: true, isInitializing: false });
  });

  it('stays signed out when the bootstrap fails (no session cookie)', async () => {
    vi.mocked(fetchAccount).mockRejectedValue(new Error('no active session'));
    const m = mount();
    await m.flush();

    expect(m.value()).toMatchObject({ user: null, isAuthenticated: false, isInitializing: false });
  });

  it('login() adopts the user, clears any pending notice, and writes nothing to localStorage', async () => {
    vi.mocked(fetchAccount).mockRejectedValue(new Error('no active session'));
    const m = mount();
    await m.flush();

    // A prior stolen-session event may have left a security notice behind.
    expireSession({ message: SESSION_SECURITY_MESSAGE, security: true });
    expect(m.value()?.sessionNotice).toEqual({ message: SESSION_SECURITY_MESSAGE, security: true });

    // The sign-in form already set the cookies server-side; login() only
    // adopts the user into React state.
    act(() => {
      m.value()?.login(ALICE);
    });

    expect(m.value()).toMatchObject({ user: ALICE, isAuthenticated: true, sessionNotice: null });

    // T025 contract: no credential ever written to script storage.
    expect(localStorage.getItem('gift-list-token')).toBeNull();
    expect(localStorage.length).toBe(0);
  });

  it('logout() calls POST /auth/logout and clears state — even when the request fails', async () => {
    vi.mocked(fetchAccount).mockResolvedValue(ALICE);
    vi.mocked(logoutSession).mockRejectedValue(new Error('network'));
    const m = mount();
    await m.flush();
    expect(m.value()?.user).toEqual(ALICE);

    await act(async () => {
      await m.value()?.logout();
    });

    expect(logoutSession).toHaveBeenCalledTimes(1);
    expect(m.value()).toMatchObject({ user: null, isAuthenticated: false, sessionNotice: null });
  });

  it('logout() still succeeds when the server says the session is already gone (401)', async () => {
    vi.mocked(fetchAccount).mockResolvedValue(ALICE);
    vi.mocked(logoutSession).mockResolvedValue(undefined);
    const m = mount();
    await m.flush();

    await act(async () => {
      await m.value()?.logout();
    });

    expect(logoutSession).toHaveBeenCalledTimes(1);
    expect(m.value()?.user).toBeNull();
  });

  it('a security session-expired event sets the security notice and clears the user', async () => {
    vi.mocked(fetchAccount).mockResolvedValue(ALICE);
    const m = mount();
    await m.flush();
    expect(m.value()?.user).toEqual(ALICE);

    expireSession({ message: SESSION_SECURITY_MESSAGE, security: true });

    expect(m.value()?.user).toBeNull();
    expect(m.value()?.sessionNotice).toEqual({ message: SESSION_SECURITY_MESSAGE, security: true });
  });

  it('a plain session-expired event sets a non-security notice', async () => {
    vi.mocked(fetchAccount).mockResolvedValue(ALICE);
    const m = mount();
    await m.flush();

    expireSession({ message: SESSION_EXPIRED_MESSAGE });

    expect(m.value()?.user).toBeNull();
    expect(m.value()?.sessionNotice).toEqual({ message: SESSION_EXPIRED_MESSAGE, security: false });
  });

  it('clearSessionNotice() removes the pending notice', async () => {
    vi.mocked(fetchAccount).mockResolvedValue(ALICE);
    const m = mount();
    await m.flush();

    expireSession({ message: SESSION_SECURITY_MESSAGE, security: true });
    expect(m.value()?.sessionNotice).not.toBeNull();

    act(() => {
      m.value()?.clearSessionNotice();
    });

    expect(m.value()?.sessionNotice).toBeNull();
  });
});

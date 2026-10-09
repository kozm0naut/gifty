import React from 'react';
import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';

describe('App login flow', () => {
  beforeEach(() => {
    const storage = (() => {
      const store = new Map<string, string>();
      return {
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
      } as Storage;
    })();

    Object.defineProperty(window, 'localStorage', {
      value: storage,
      configurable: true,
    });
    Object.defineProperty(globalThis, 'localStorage', {
      value: storage,
      configurable: true,
    });

    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('shows the logged-in username immediately after auth succeeds', async () => {
    // Arrange
    let logged = false;
    const ALICE = { id: 'user_alice', email: 'alice@example.com', displayName: 'Alice' };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);

        // The session now lives in the HttpOnly cookie the server sets on
        // sign-in; once that has happened, /account resolves the user.
        if (url.includes('/account')) {
          if (logged) {
            return { ok: true, json: async () => ({ user: ALICE }) } as Response;
          }
          return { ok: false, status: 401, json: async () => ({ error: 'Authentication required' }) } as Response;
        }

        if (url.includes('/auth/login')) {
          logged = true;
          return {
            ok: true,
            json: async () => ({ user: ALICE }),
          } as Response;
        }

        if (url.includes('/lists')) {
          return { ok: true, json: async () => ({ lists: [] }) } as Response;
        }

        return { ok: true, json: async () => ({}) } as Response;
      }),
    );

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = ReactDOM.createRoot(container);

    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/auth']}>
          <App />
        </MemoryRouter>,
      );
    });

    const emailInput = container.querySelector('input[type="email"]') as HTMLInputElement;
    const passwordInput = container.querySelector('input[type="password"]') as HTMLInputElement;
    const form = container.querySelector('form') as HTMLFormElement;

    // Act
    fireEvent.change(emailInput, { target: { value: 'alice@example.com' } });
    fireEvent.change(passwordInput, { target: { value: 'secret' } });

    await act(async () => {
      fireEvent.submit(form);
    });

    // Assert
    expect(container.textContent).toContain('Alice');
  });

  it('redirects to the auth page when the session is no longer valid', async () => {
    // Arrange: a session that the server has revoked (e.g. signed out
    // elsewhere). Model the realistic mid-page termination: bootstrap OK,
    // then /lists 401s, the single refresh attempt is rejected with
    // reason "revoked", and the app must route to sign-in with the plain
    // (non-security) notice.
    const ALICE = { id: 'user_1', email: 'alice@example.com', displayName: 'Alice' };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);

        if (url.includes('/account')) {
          return { ok: true, json: async () => ({ user: ALICE }) } as Response;
        }

        if (url.includes('/lists')) {
          return {
            ok: false,
            status: 401,
            json: async () => ({ error: 'Authentication required' }),
          } as Response;
        }

        if (url.includes('/auth/refresh')) {
          return {
            ok: false,
            status: 401,
            json: async () => ({ error: 'Session is no longer active.', reason: 'revoked' }),
          } as Response;
        }

        return { ok: true, json: async () => ({}) } as Response;
      }),
    );

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = ReactDOM.createRoot(container);

    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/']}>
          <App />
        </MemoryRouter>,
      );
    });

    // Act
    // The dashboard's initial load receives a 401; the single refresh
    // attempt is rejected ("revoked"), the app clears its session state
    // and redirects to the sign-in page with the plain (non-security)
    // 003 FR-027 notice.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    // Assert
    expect(container.textContent).toContain('Login');
    expect(container.textContent).toContain('Your session has expired. Please log in again.');
    // The revoked reason must NOT surface the security-variant notice.
    expect(container.textContent).not.toContain('ended for security reasons');
  });

  it('shows the password-policy requirement on a weak sign-up password (T018)', async () => {
    const POLICY_MESSAGE =
      'Password must be at least 8 characters and include an uppercase letter, a lowercase letter, a number, and a symbol.';

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/auth/register')) {
          return {
            ok: false,
            status: 400,
            json: async () => ({ message: POLICY_MESSAGE }),
          } as Response;
        }
        return { ok: true, json: async () => ({}) } as Response;
      }),
    );

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = ReactDOM.createRoot(container);

    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/auth']}>
          <App />
        </MemoryRouter>,
      );
    });

    // Switch from the default login mode to register mode.
    const toggle = Array.from(container.querySelectorAll('button')).find((b) =>
      /don't have an account/i.test(b.textContent ?? ''),
    );
    await act(async () => {
      fireEvent.click(toggle as HTMLButtonElement);
    });

    const emailInput = container.querySelector('input[type="email"]') as HTMLInputElement;
    const passwordInput = container.querySelector('#auth-password') as HTMLInputElement;
    // The register form requires the confirm field to match before the server
    // is called; fill it with the same weak value so the client-side
    // "Passwords do not match" guard passes and the server's policy 400
    // surfaces (the assertion target).
    const confirmInput = container.querySelector('#auth-password-confirm') as HTMLInputElement;
    const nameInput = container.querySelector('#auth-name') as HTMLInputElement;
    const form = container.querySelector('form') as HTMLFormElement;

    fireEvent.change(emailInput, { target: { value: 'weak@example.com' } });
    fireEvent.change(passwordInput, { target: { value: 'short' } });
    fireEvent.change(confirmInput, { target: { value: 'short' } });
    fireEvent.change(nameInput, { target: { value: 'Weak User' } });

    await act(async () => {
      fireEvent.submit(form);
    });

    expect(container.textContent).toContain(POLICY_MESSAGE);
  });
});

describe('ConfirmPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  // Render the App at /confirm with /account resolving to `account`.
  const renderConfirm = async (account: () => Response) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/account')) return account();
        if (url.includes('/auth/refresh')) {
          return { ok: false, status: 401, json: async () => ({ error: 'Authentication required' }) } as Response;
        }
        return { ok: true, json: async () => ({}) } as Response;
      }),
    );

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = ReactDOM.createRoot(container);
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/confirm']}>
          <App />
        </MemoryRouter>,
      );
    });
    return container;
  };

  it('does not flash "You are confirmed" to a logged-out visitor', async () => {
    const container = await renderConfirm(() =>
      ({ ok: false, status: 401, json: async () => ({ error: 'Authentication required' }) } as Response),
    );
    // Without a session the success card must NOT appear (the old bug).
    expect(container.querySelector('[data-testid="confirm-success"]')).toBeNull();
    expect(container.textContent).not.toContain("You're confirmed!");
    // Instead the visitor is told to sign in.
    expect(container.textContent).toContain('Sign in to your account');
  });

  it('shows the resend card for a signed-in but unconfirmed account', async () => {
    const container = await renderConfirm(() =>
      ({ ok: true, json: async () => ({ user: { id: 'u1', email: 'a@b.com', displayName: 'A', verified: false } }) } as Response),
    );
    expect(container.querySelector('[data-testid="confirm-success"]')).toBeNull();
    expect(container.textContent).toContain('A link is on its way');
  });

  it('shows the success card only for a signed-in, confirmed account', async () => {
    const container = await renderConfirm(() =>
      ({ ok: true, json: async () => ({ user: { id: 'u1', email: 'a@b.com', displayName: 'A', verified: true } }) } as Response),
    );
    expect(container.querySelector('[data-testid="confirm-success"]')).not.toBeNull();
    expect(container.textContent).toContain("You're confirmed!");
  });

  it('logging out from /confirm navigates to /auth with the logged-out notice', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/auth/logout')) return { ok: true, status: 204 } as Response;
        if (url.includes('/account')) {
          return {
            ok: true,
            json: async () => ({ user: { id: 'u1', email: 'a@b.com', displayName: 'A', verified: false } }),
          } as Response;
        }
        return { ok: true, json: async () => ({}) } as Response;
      }),
    );

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = ReactDOM.createRoot(container);
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/confirm']}>
          <App />
        </MemoryRouter>,
      );
    });

    // Signed-in but unconfirmed → the resend card is up and the header user
    // cluster is present.
    expect(container.textContent).toContain('A link is on its way');
    const userCluster = container.querySelector('.nav-user-cluster') as HTMLButtonElement;
    expect(userCluster).not.toBeNull();

    // Log out lives inside the user menu — open the menu first.
    await act(async () => {
      fireEvent.click(userCluster);
    });
    const logoutButton = container.querySelector('.nav-logout') as HTMLButtonElement;
    expect(logoutButton).not.toBeNull();

    // Act: click logout.
    await act(async () => {
      fireEvent.click(logoutButton);
      // Let the async logout() promise + the navigation it triggers settle.
      await Promise.resolve();
    });

    // Expectation: we are now on the sign-in page with the logged-out notice,
    // NOT stuck on the /confirm no-session card (the old bug).
    expect(container.querySelector('.nav-logout')).toBeNull(); // signed-out: nav gone
    expect(container.textContent).toContain('You are now logged out.');
    expect(container.textContent).not.toContain("This link didn't complete confirmation");
  });

  it('keeps the Account link inside the user menu rather than as a standalone nav link', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/account')) {
          return {
            ok: true,
            json: async () => ({ user: { id: 'u1', email: 'a@b.com', displayName: 'A', verified: true } }),
          } as Response;
        }
        return { ok: true, json: async () => ({}) } as Response;
      }),
    );

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = ReactDOM.createRoot(container);
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/confirm']}>
          <App />
        </MemoryRouter>,
      );
    });

    // Menu closed by default: no standalone Account nav link, no menu items.
    expect(container.querySelector('.nav-link')).toBeNull();
    expect(container.querySelector('.nav-user-menu-panel')).toBeNull();
    expect(container.querySelector('.nav-logout')).toBeNull();

    // Clicking the avatar/name opens the menu with Account + Log out.
    await act(async () => {
      fireEvent.click(container.querySelector('.nav-user-cluster') as HTMLElement);
    });
    const accountLink = container.querySelector('.nav-user-menu-panel a') as HTMLAnchorElement;
    expect(accountLink).not.toBeNull();
    expect(accountLink.textContent).toContain('Account');
    expect(accountLink.getAttribute('href')).toBe('/me');
    expect(container.querySelector('.nav-logout')).not.toBeNull();
  });
});

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
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);

        if (url.includes('/auth/login')) {
          return {
            ok: true,
            json: async () => ({
              token: 'abc123',
              user: { displayName: 'Alice' },
            }),
          } as Response;
        }

        if (url.includes('/lists')) {
          return {
            ok: true,
            json: async () => ({ lists: [] }),
          } as Response;
        }

        return {
          ok: true,
          json: async () => ({}),
        } as Response;
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
    // Arrange
    const storage = window.localStorage;
    storage.setItem('gift-list-token', 'expired-token');
    storage.setItem('gift-list-user', JSON.stringify({ id: 'user_1', email: 'alice@example.com', displayName: 'Alice' }));

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);

        if (url.includes('/lists')) {
          return {
            ok: false,
            status: 401,
            json: async () => ({ message: 'Your account is no longer active.' }),
          } as Response;
        }

        return {
          ok: true,
          json: async () => ({}),
        } as Response;
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
    // The dashboard's initial load receives a 401; the app should clear
    // the stored session and redirect to the auth page.
    await act(async () => {
      await Promise.resolve();
    });

    // Assert
    expect(container.textContent).toContain('Login');
    expect(container.textContent).toContain('Your account is no longer active.');
    expect(storage.getItem('gift-list-token')).toBeNull();
    expect(storage.getItem('gift-list-user')).toBeNull();
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
    const passwordInput = container.querySelector('input[type="password"]') as HTMLInputElement;
    const nameInput = container.querySelector('#auth-name') as HTMLInputElement;
    const form = container.querySelector('form') as HTMLFormElement;

    fireEvent.change(emailInput, { target: { value: 'weak@example.com' } });
    fireEvent.change(passwordInput, { target: { value: 'short' } });
    fireEvent.change(nameInput, { target: { value: 'Weak User' } });

    await act(async () => {
      fireEvent.submit(form);
    });

    expect(container.textContent).toContain(POLICY_MESSAGE);
  });
});

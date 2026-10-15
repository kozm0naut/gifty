import React from 'react';
import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ResetPage } from './ResetPage';
import { AuthPage } from './AuthPage';
import { AuthProvider, useAuth } from '../context/AuthContext';

/**
 * T010 — US1 frontend coverage for the password-reset flow.
 *
 * Pinned copy (contracts/api.md, 005):
 *  - `P` (policy/mismatch, 400): reuses the registration policy message.
 *  - `I` (invalid link, 400): the uniform "invalid or expired" copy (005 FR-004).
 *  - `S` (success, 200): `{"status":"reset","user":{…,"verified":true}}`.
 *
 * These tests MUST FAIL before T015 (ResetPage) and T014 (the AuthPage
 * "Forgot password?" link) exist — `ResetPage` is not yet importable.
 */

const P_COPY =
  'Password must be at least 8 characters and include an uppercase letter, a lowercase letter, a number, and a symbol.';
const I_COPY = 'This reset link is invalid or has expired.';

const VALID_USER = {
  id: 'user_alice',
  email: 'alice@example.com',
  displayName: 'Alice',
  verified: true,
};

/** Writes the current router pathname to a DOM node so navigation is assertable. */
function LocationProbe() {
  const { pathname } = useLocation();
  return <div data-testid="loc-probe">{pathname}</div>;
}

/** Exposes the auth session so post-reset session adoption is assertable (005 FR-014). */
function AuthProbe() {
  const { isAuthenticated, user } = useAuth();
  return (
    <div data-testid="auth-probe">
      {isAuthenticated ? 'in' : 'out'}|{user?.email ?? '-'}
    </div>
  );
}

function renderAt(path: string, render: (path: string) => React.ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = ReactDOM.createRoot(container);

  return {
    container,
    root,
    async render() {
      await act(async () => {
        root.render(
          <MemoryRouter initialEntries={[path]}>
            <AuthProvider>
              <LocationProbe />
              <AuthProbe />
              {render(path)}
            </AuthProvider>
          </MemoryRouter>,
        );
      });
    },
    async unmount() {
      await act(async () => {
        root.unmount();
      });
    },
  };
}

describe('ResetPage (005 US1)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('renders new-password and confirm-password fields', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({}) }) as Response),
    );

    const { container, render } = renderAt('/reset/test-token-123', () => (
      <Routes>
        <Route path="/reset/:token" element={<ResetPage />} />
        <Route path="/" element={<div data-testid="home">home</div>} />
        <Route path="*" element={<div />} />
      </Routes>
    ));
    await render();

    const passwordFields = container.querySelectorAll('input[type="password"]');
    expect(passwordFields.length).toBeGreaterThanOrEqual(2);

    // A submit affordance is present so the form can be driven.
    const form = container.querySelector('form');
    expect(form).toBeTruthy();
  });

  it('rejects a confirm mismatch with the 400 `P` copy', async () => {
    // The mismatch is a client-side guard, but the surfaced copy is the
    // uniform `P` policy message (005 FR-003, contracts/api.md `P`).
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({}) }) as Response),
    );

    const { container, render } = renderAt('/reset/test-token-123', () => (
      <Routes>
        <Route path="/reset/:token" element={<ResetPage />} />
        <Route path="/" element={<div data-testid="home">home</div>} />
        <Route path="*" element={<div />} />
      </Routes>
    ));
    await render();

    const [pw, confirm] = Array.from(container.querySelectorAll('input[type="password"]')) as HTMLInputElement[];
    fireEvent.change(pw, { target: { value: 'ValidPass1!' } });
    fireEvent.change(confirm, { target: { value: 'Different1!' } });

    await act(async () => {
      fireEvent.submit(container.querySelector('form') as HTMLFormElement);
    });

    expect(container.textContent).toContain(P_COPY);
  });

  it('navigates to the app home on a successful reset', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/auth/reset')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ status: 'reset', user: VALID_USER }),
          } as Response;
        }
        return { ok: true, json: async () => ({}) } as Response;
      }),
    );

    const { container, render } = renderAt('/reset/test-token-123', () => (
      <Routes>
        <Route path="/reset/:token" element={<ResetPage />} />
        <Route path="/" element={<div data-testid="home">home</div>} />
        <Route path="*" element={<div />} />
      </Routes>
    ));
    await render();

    const [pw, confirm] = Array.from(container.querySelectorAll('input[type="password"]')) as HTMLInputElement[];
    fireEvent.change(pw, { target: { value: 'ValidPass1!' } });
    fireEvent.change(confirm, { target: { value: 'ValidPass1!' } });

    await act(async () => {
      fireEvent.submit(container.querySelector('form') as HTMLFormElement);
    });

    // The router location must have advanced to the app home.
    const probe = container.querySelector('[data-testid="loc-probe"]');
    expect(probe?.textContent).toBe('/');

    // The fresh session must be adopted into auth state (005 FR-014), otherwise
    // the route guard would bounce the user straight back to sign-in.
    const auth = container.querySelector('[data-testid="auth-probe"]');
    expect(auth?.textContent).toBe(`in|${VALID_USER.email}`);
  });

  it('surfaces the 400 `I` invalid-link copy with a "request a new link" affordance', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/auth/reset')) {
          return {
            ok: false,
            status: 400,
            json: async () => ({ message: I_COPY }),
          } as Response;
        }
        return { ok: true, json: async () => ({}) } as Response;
      }),
    );

    const { container, render } = renderAt('/reset/test-token-123', () => (
      <Routes>
        <Route path="/reset/:token" element={<ResetPage />} />
        <Route path="/" element={<div data-testid="home">home</div>} />
        <Route path="*" element={<div />} />
      </Routes>
    ));
    await render();

    const [pw, confirm] = Array.from(container.querySelectorAll('input[type="password"]')) as HTMLInputElement[];
    fireEvent.change(pw, { target: { value: 'ValidPass1!' } });
    fireEvent.change(confirm, { target: { value: 'ValidPass1!' } });

    await act(async () => {
      fireEvent.submit(container.querySelector('form') as HTMLFormElement);
    });

    expect(container.textContent).toContain(I_COPY);

    // A "request a new link" affordance must route to the forgot-password page.
    const link = Array.from(container.querySelectorAll('a')).find(
      (a) => (a.getAttribute('href') ?? '').includes('/forgot-password'),
    );
    expect(link).toBeTruthy();
    expect(link?.textContent).toMatch(/request a new link/i);
  });
});

describe('AuthPage "Forgot password?" link (005 US1)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('exposes a "Forgot password?" link targeting /forgot-password', async () => {
    // No live session — the sign-in form renders.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/account')) {
          return {
            ok: false,
            status: 401,
            json: async () => ({ error: 'Authentication required' }),
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
          <AuthProvider>
            <AuthPage />
          </AuthProvider>
        </MemoryRouter>,
      );
    });

    const link = Array.from(container.querySelectorAll('a')).find(
      (a) => (a.getAttribute('href') ?? '').includes('/forgot-password'),
    );
    expect(link).toBeTruthy();
    expect(link?.textContent).toMatch(/forgot password/i);
  });
});

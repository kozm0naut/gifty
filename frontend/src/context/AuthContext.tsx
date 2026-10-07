import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import {
  SESSION_EXPIRED_EVENT,
  fetchAccount,
  logoutSession,
  resendConfirmation,
} from '../services/api';
import type { SessionExpiredDetail } from '../services/api';

export type User = {
  id: string;
  email: string;
  displayName: string;
  /** Feature 004 (US2): email confirmed. Undefined → treated as confirmed
   *  (backward compatible with a response that predates the field). */
  verified?: boolean;
};

/** 003 FR-027 notice surfaced on the sign-in page after a session termination. */
export interface SessionNotice {
  message: string;
  /** True when the termination was a refresh-token-reuse (theft) signal (003 FR-026). */
  security: boolean;
  /**
   * Presentation hint for the sign-in page. 'security' (red, 003 FR-027 theft
   * signal), 'warning' (yellow, expired session), 'info' (green, positive
   * confirmations: signed out / account removed).
   */
  tone: 'security' | 'warning' | 'info';
}

interface AuthContextType {
  user: User | null;
  isAuthenticated: boolean;
  /** True until the initial `GET /account` bootstrap resolves (cookie-backed). */
  isInitializing: boolean;
  sessionNotice: SessionNotice | null;
  login: (user: User) => void;
  logout: () => Promise<void>;
  /** US7: the account was removed server-side — drop local auth state. */
  removeAccount: () => void;
  clearSessionNotice: () => void;
  /** Feature 004 (US2): true when the account's email is confirmed (or the
   *  field is absent). Drives the confirmation gate on the client side. */
  isVerified: boolean;
  /** Feature 004 (US2): request a fresh confirmation email. Re-fetches the
   *  account afterward so `verified` reflects the latest server state. */
  resendConfirmation: () => Promise<void>;
  /** Re-read `GET /account` to pick up a newly-confirmed `verified` flag. */
  refreshAccount: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  // The session now lives entirely in the HttpOnly `gifty_access` cookie —
  // nothing is readable from (or storable in) page script storage. On mount
  // we bootstrap the user from `GET /account`; `isInitializing` stays true
  // until that resolves so the route guards can wait instead of bouncing.
  const [user, setUser] = useState<User | null>(null);
  const [isInitializing, setIsInitializing] = useState<boolean>(true);
  const [sessionNotice, setSessionNotice] = useState<SessionNotice | null>(null);

  const isAuthenticated = user !== null;
  // Feature 004 (US2): the gate is off when the flag is absent (older
  // response) — only an explicit `verified: false` means unconfirmed.
  const isVerified = user == null || user.verified !== false;

  useEffect(() => {
    let cancelled = false;
    fetchAccount()
      .then((bootstrapUser) => {
        if (cancelled) return;
        setUser(bootstrapUser);
      })
      .catch(() => {
        // No active session (401) — stay signed out.
        if (!cancelled) setUser(null);
      })
      .finally(() => {
        if (!cancelled) setIsInitializing(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // The sign-in form already set the session cookies server-side; here we
  // only adopt the returned user into React state (T027).
  const login = useCallback((newUser: User) => {
    setUser(newUser);
    setSessionNotice(null);
  }, []);

  // Sign out (003 FR-008): the server revokes the session family and clears
  // both HttpOnly cookies; we clear local state regardless so the UI lands
  // on the sign-in page even if the request fails.
  const logout = useCallback(async () => {
    try {
      await logoutSession();
    } catch {
      // already invalid — still clear locally
    }
    setUser(null);
    setSessionNotice({ message: 'You are now logged out.', security: false, tone: 'info' });
  }, []);

  // Account removal (US7): the server has already deleted the user and cleared
  // both cookies; here we only drop the local auth state so the UI lands on the
  // sign-in page. No further server call is needed (the account is gone).
  const removeAccount = useCallback(() => {
    setUser(null);
    setSessionNotice({
      message: 'Your account was successfully deleted.',
      security: false,
      tone: 'info',
    });
  }, []);

  const clearSessionNotice = useCallback(() => setSessionNotice(null), []);

  // Re-read `GET /account` so a newly-confirmed `verified` flag is adopted
  // without a full page reload. A 401 (session gone) clears local state.
  const refreshAccount = useCallback(async () => {
    try {
      const fresh = await fetchAccount();
      setUser(fresh);
    } catch {
      setUser(null);
    }
  }, []);

  // Re-request the confirmation email (US2). Always re-reads the account so
  // the UI reflects the latest `verified` state (a 403 "already confirmed"
  // should lift the gate), then rethrows any server message (403/429/401) so
  // the caller can surface it.
  const resend = useCallback(async () => {
    let error: Error | undefined;
    try {
      await resendConfirmation();
    } catch (err) {
      error = err as Error;
    }
    await refreshAccount();
    if (error) throw error;
  }, [refreshAccount]);

  // If the API reports the session is no longer valid (401 that survived a
  // refresh), drop the local auth state so ProtectedRoute redirects to the
  // sign-in page, and surface the 003 FR-027 notice (strong wording when the
  // termination was a refresh-token-reuse / theft signal).
  useEffect(() => {
    const handleSessionExpired = (event: Event) => {
      const detail = (event as CustomEvent).detail as
        | SessionExpiredDetail
        | undefined;
      setSessionNotice({
        message: detail?.message || 'Your session has expired. Please log in again.',
        security: detail?.security === true,
        tone: detail?.security ? 'security' : 'warning',
      });
      setUser(null);
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, handleSessionExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, handleSessionExpired);
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user,
        isAuthenticated,
        isInitializing,
        sessionNotice,
        login,
        logout,
        removeAccount,
        clearSessionNotice,
        isVerified,
        resendConfirmation: resend,
        refreshAccount,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

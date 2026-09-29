import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import {
  SESSION_EXPIRED_EVENT,
  fetchAccount,
  logoutSession,
} from '../services/api';
import type { SessionExpiredDetail } from '../services/api';

export type User = {
  id: string;
  email: string;
  displayName: string;
};

/** FR-027 notice surfaced on the sign-in page after a session termination. */
export interface SessionNotice {
  message: string;
  /** True when the termination was a refresh-token-reuse (theft) signal (FR-026). */
  security: boolean;
}

interface AuthContextType {
  user: User | null;
  isAuthenticated: boolean;
  /** True until the initial `GET /account` bootstrap resolves (cookie-backed). */
  isInitializing: boolean;
  sessionNotice: SessionNotice | null;
  login: (user: User) => void;
  logout: () => Promise<void>;
  clearSessionNotice: () => void;
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

  // Sign out (FR-008): the server revokes the session family and clears
  // both HttpOnly cookies; we clear local state regardless so the UI lands
  // on the sign-in page even if the request fails.
  const logout = useCallback(async () => {
    try {
      await logoutSession();
    } catch {
      // already invalid — still clear locally
    }
    setUser(null);
    setSessionNotice(null);
  }, []);

  const clearSessionNotice = useCallback(() => setSessionNotice(null), []);

  // If the API reports the session is no longer valid (401 that survived a
  // refresh), drop the local auth state so ProtectedRoute redirects to the
  // sign-in page, and surface the FR-027 notice (strong wording when the
  // termination was a refresh-token-reuse / theft signal).
  useEffect(() => {
    const handleSessionExpired = (event: Event) => {
      const detail = (event as CustomEvent).detail as
        | SessionExpiredDetail
        | undefined;
      setSessionNotice({
        message: detail?.message || 'Your session has expired. Please log in again.',
        security: detail?.security === true,
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
        clearSessionNotice,
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

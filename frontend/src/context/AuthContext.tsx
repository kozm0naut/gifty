import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { SESSION_EXPIRED_EVENT } from '../services/api';

export type User = {
  id: string;
  email: string;
  displayName: string;
};

interface AuthContextType {
  user: User | null;
  isAuthenticated: boolean;
  sessionExpiredMessage: string | null;
  login: (user: User, token: string) => void;
  logout: () => void;
  clearSessionMessage: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const AUTH_TOKEN_KEY = 'gift-list-token';
const USER_KEY = 'gift-list-user';

export function AuthProvider({ children }: { children: ReactNode }) {
  // Initialize auth state synchronously from localStorage so that
  // ProtectedRoute / PublicRoute see the correct value on the very first
  // render.  Using a useEffect (as before) caused a race condition on full
  // page loads: the first render saw isAuthenticated === false, redirected
  // to /auth, and then the effect flipped the flag, bouncing the user to
  // the dashboard.
  const [user, setUser] = useState<User | null>(() => {
    const token = localStorage.getItem(AUTH_TOKEN_KEY);
    const userData = localStorage.getItem(USER_KEY);
    if (token && userData) {
      try {
        return JSON.parse(userData) as User;
      } catch (e) {
        console.error('Failed to parse user from localStorage', e);
        localStorage.removeItem(AUTH_TOKEN_KEY);
        localStorage.removeItem(USER_KEY);
        return null;
      }
    }
    return null;
  });
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(user !== null);
  const [sessionExpiredMessage, setSessionExpiredMessage] = useState<string | null>(null);

  const login = (newUser: User, token: string) => {
    localStorage.setItem(AUTH_TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(newUser));
    setUser(newUser);
    setIsAuthenticated(true);
    setSessionExpiredMessage(null);
  };

  const clearSession = useCallback(() => {
    localStorage.removeItem(AUTH_TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    setUser(null);
    setIsAuthenticated(false);
  }, []);

  const logout = clearSession;

  const clearSessionMessage = useCallback(() => setSessionExpiredMessage(null), []);

  // If the API reports the session is no longer valid (401), drop the
  // local auth state so ProtectedRoute redirects to the auth page, and
  // surface a message telling the user they were logged out.
  useEffect(() => {
    const handleSessionExpired = (event: Event) => {
      const detail = (event as CustomEvent).detail as { message?: string } | undefined;
      setSessionExpiredMessage(detail?.message || 'Your session has expired. Please log in again.');
      clearSession();
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, handleSessionExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, handleSessionExpired);
  }, [clearSession]);

  return (
    <AuthContext.Provider value={{ user, isAuthenticated, sessionExpiredMessage, login, logout, clearSessionMessage }}>
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

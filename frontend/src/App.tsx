import { Link, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useEffect, useRef, useState } from 'react';
import { AuthPage } from './pages/AuthPage';
import { ConfirmPage } from './pages/ConfirmPage';
import { Dashboard } from './pages/DashboardPage';
import { ListPage } from './pages/ListPage';
import { AccountPage } from './pages/AccountPage';
import { AuthProvider, useAuth } from './context/AuthContext';
import { BrandMark } from './components/BrandMark';
import { getInitials } from './utils/avatar';
import { getNameColors } from './utils/colors';

export default function App() {
  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  );
}

function AppContent() {
  const { user, isAuthenticated, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const isAuthRoute = location.pathname === '/auth';
  const [currentUserName, setCurrentUserName] = useState(user?.displayName || 'User');

  useEffect(() => {
    if (user) {
      setCurrentUserName(user.displayName);
    } else {
      setCurrentUserName('User');
    }
  }, [user]);

  // The user menu (avatar/name → Account, Log out) starts closed.
  const [menuOpen, setMenuOpen] = useState(false);
  const userMenuRef = useRef<HTMLDivElement | null>(null);

  // Close the menu on outside click or Escape.
  useEffect(() => {
    if (!menuOpen) {
      return;
    }
    const onPointerDown = (event: MouseEvent) => {
      if (userMenuRef.current && !userMenuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

  // Never leave the menu open if the session ends.
  useEffect(() => {
    if (!isAuthenticated) {
      setMenuOpen(false);
    }
  }, [isAuthenticated]);

  return (
    <div className="app-shell">
      <header className="app-header">
        <Link to="/" className="brand">
          <BrandMark className="brand-mark" />
          Gifty
        </Link>

        {isAuthenticated && (
          <nav className="app-nav">
            {/* Clicking the avatar/name opens the user menu (Account, Log out). */}
            <div className="nav-user-menu" ref={userMenuRef}>
              <button
                type="button"
                className="nav-user-cluster"
                onClick={() => setMenuOpen((open) => !open)}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                title={`${currentUserName} — open menu`}
              >
                <span
                  className="nav-avatar"
                  style={{ background: getNameColors(currentUserName, true).primary }}
                >
                  {getInitials(currentUserName)}
                </span>
                <span className="nav-user">{currentUserName}</span>
              </button>
              {menuOpen && (
                <div className="nav-user-menu-panel">
                  <Link
                    to="/me"
                    className="nav-user-menu-item"
                    title="Account settings"
                    onClick={() => setMenuOpen(false)}
                  >
                    Account
                  </Link>
                  {/* Log out always lands on /auth. Protected routes would bounce
                      there via the guard, but /confirm is unguarded — navigate
                      explicitly so the logged-out notice is shown everywhere. */}
                  <button
                    type="button"
                    className="nav-logout"
                    onClick={() => {
                      setMenuOpen(false);
                      void logout().then(() => navigate('/auth', { replace: true }));
                    }}
                    title="Log out"
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                      <polyline points="16 17 21 12 16 7" />
                      <line x1="21" y1="12" x2="9" y2="12" />
                    </svg>
                    <span>Log out</span>
                  </button>
                </div>
              )}
            </div>
          </nav>
        )}
      </header>

      <main className={isAuthRoute ? 'app-main app-main--bare' : 'app-main'}>
        <Routes>
          <Route path="/auth" element={<PublicRoute><AuthPage /></PublicRoute>} />
          {/* US2: the confirmation page handles its own auth state — it renders
              for both an unconfirmed-with-session and a no-session (cold link)
              visitor, and redirects to the dashboard once verified. */}
          <Route path="/confirm" element={<ConfirmPage />} />
          <Route path="/" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
          {/* The account area lives at /me — /account is taken by the API
              session-bootstrap endpoint (GET /account), and Express serves
              that route before the SPA fallback, so a /account SPA route would
              be unreachable by hard navigation. */}
          <Route path="/me" element={<ProtectedRoute><AccountPage /></ProtectedRoute>} />
          <Route path="/list/:listId" element={<ProtectedRoute><ListPage /></ProtectedRoute>} />
          <Route path="/list/:listId/add-item" element={<ProtectedRoute><ListPage initialModal="add-item" /></ProtectedRoute>} />
          <Route path="/list/:listId/sharing" element={<ProtectedRoute><ListPage initialModal="sharing" /></ProtectedRoute>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isVerified, isInitializing } = useAuth();
  // Wait for the cookie-backed bootstrap (GET /account) before deciding —
  // otherwise an authenticated user is bounced to /auth on first paint and
  // back again once the session resolves (the race the old comment warned about).
  if (isInitializing) {
    return <div className="loading-row">Loading…</div>;
  }
  if (!isAuthenticated) {
    return <Navigate to="/auth" replace />;
  }
  // US2: authenticated but unconfirmed (email feature on) → confirmation page.
  if (!isVerified) {
    return <Navigate to="/confirm" replace />;
  }

  return <>{children}</>;
}

function PublicRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isInitializing } = useAuth();
  if (isInitializing) {
    return <div className="loading-row">Loading…</div>;
  }
  if (isAuthenticated) {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
}


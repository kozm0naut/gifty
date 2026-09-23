import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { AuthPage } from './pages/AuthPage';
import { Dashboard } from './pages/DashboardPage';
import { ListPage } from './pages/ListPage';
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
  const isAuthRoute = location.pathname === '/auth';
  const [currentUserName, setCurrentUserName] = useState(user?.displayName || 'User');

  useEffect(() => {
    if (user) {
      setCurrentUserName(user.displayName);
    } else {
      setCurrentUserName('User');
    }
  }, [user]);

  return (
    <div className="app-shell">
      <header className="app-header">
        <Link to="/" className="brand">
          <BrandMark className="brand-mark" />
          Gifty
        </Link>

        {isAuthenticated && (
          <nav className="app-nav">
            <div className="nav-user-cluster">
              <span
                className="nav-avatar"
                style={{ background: getNameColors(currentUserName, true).primary }}
                title={currentUserName}
              >
                {getInitials(currentUserName)}
              </span>
              <span className="nav-user">{currentUserName}</span>
              <button type="button" className="nav-logout" onClick={logout} title="Log out">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                  <polyline points="16 17 21 12 16 7" />
                  <line x1="21" y1="12" x2="9" y2="12" />
                </svg>
              </button>
            </div>
          </nav>
        )}
      </header>

      <main className={isAuthRoute ? 'app-main app-main--bare' : 'app-main'}>
        <Routes>
          <Route path="/auth" element={<PublicRoute><AuthPage /></PublicRoute>} />
          <Route path="/" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
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
  const { isAuthenticated } = useAuth();
  if (!isAuthenticated) {
    return <Navigate to="/auth" replace />;
  }

  return <>{children}</>;
}

function PublicRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated } = useAuth();
  if (isAuthenticated) {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
}


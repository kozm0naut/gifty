import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AuthPayload, login, register } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { BrandMark } from '../components/BrandMark';

interface AuthPageProps {
}

export function AuthPage() {
  const { login: authLogin, sessionExpiredMessage, clearSessionMessage } = useAuth();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError(null);

    const payload: AuthPayload = mode === 'register' 
      ? { email, password, displayName } 
      : { email, password };

    try {
      const data = await (mode === 'login' ? login(payload) : register(payload));
      
      authLogin(data.user, data.token);
      navigate('/');
    } catch (err: any) {
      setError(err.message || 'Authentication failed');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div>
      <div className="auth-brand">
        <BrandMark className="auth-brand-mark" />
        <h1 className="auth-brand-title">Gifty</h1>
      </div>
      <div className="card card-pad auth-card">
      <h2 className="auth-card-title">{mode === 'login' ? 'Login' : 'Register'}</h2>
      {sessionExpiredMessage && (
        <div className="alert alert-warning">{sessionExpiredMessage}</div>
      )}
      {error && <div className="alert alert-error">{error}</div>}
      <form onSubmit={handleSubmit} className="form-stack">
        <div className="field">
          <label className="field-label" htmlFor="auth-email">Email</label>
          <input
            id="auth-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className="input"
          />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="auth-password">Password</label>
          <input
            id="auth-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            className="input"
          />
        </div>
        {mode === 'register' && (
          <div className="field">
            <label className="field-label" htmlFor="auth-name">Display Name</label>
            <input
              id="auth-name"
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              required
              className="input"
            />
          </div>
        )}
        <button type="submit" className="btn btn-primary btn-block" disabled={isLoading}>
          {isLoading ? 'Processing...' : mode === 'login' ? 'Login' : 'Register'}
        </button>
      </form>
      <div className="auth-toggle">
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => {
            setError(null);
            clearSessionMessage();
            setMode(mode === 'login' ? 'register' : 'login');
          }}
        >
          {mode === 'login' ? 'Don\'t have an account? Register' : 'Already have an account? Login'}
        </button>
      </div>
      </div>
    </div>
  );
}

import React, { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { resetPassword } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { BrandMark } from '../components/BrandMark';

/**
 * US1 — Reset-password page (feature 005, T015), public route `/reset/:token`.
 *
 * New-password + confirm fields with a client-side confirm-match check and a
 * policy hint. On submit it calls `resetPassword(token, newPassword,
 * confirmPassword)`:
 *   - `200 S`  → the server has set a fresh session; navigate to the app home.
 *   - `400 I`  → surface the invalid-link copy with a "request a new link"
 *                affordance (→ `/forgot-password`).
 *   - `400 P`  → surface the policy/mismatch copy (uniform `P`, 005 FR-003).
 *
 * The confirm-match guard is client-side (a quick, clear signal); the surfaced
 * copy for a mismatch is the uniform `P` policy message (contracts/api.md).
 */
const POLICY_HINT =
  'Password must be at least 8 characters and include an uppercase letter, a lowercase letter, a number, and a symbol.';

export function ResetPage() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const { login: adoptSession } = useAuth();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    // Client-side confirm-match guard. The surfaced copy is the uniform `P`
    // policy message (005 FR-003) so the user sees the exact requirement.
    if (newPassword !== confirmPassword) {
      setError(POLICY_HINT);
      return;
    }

    setIsLoading(true);
    try {
      // The server sets a fresh HttpOnly session and returns the signed-in user.
      const result = await resetPassword(token ?? '', newPassword, confirmPassword);
      // Adopt that session into auth state so the route guard doesn't bounce the
      // user back to sign-in (005 FR-014). Mirrors the AuthPage login flow.
      adoptSession(result.user);
      navigate('/', { replace: true });
    } catch (err: any) {
      setError(err?.message || 'Something went wrong. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="confirm-page confirm-page--center">
      <div className="confirm-card">
        <BrandMark className="confirm-brand" />
        <h1 className="confirm-title">Reset your password</h1>

        {error && (
          <div className="alert alert-error" role="alert">
            {error}
          </div>
        )}
        {error && (
          <p className="confirm-body">
            <Link to="/forgot-password" className="confirm-link">
              Request a new link
            </Link>
          </p>
        )}

        <form onSubmit={handleSubmit} className="form-stack">
          <div className="field">
            <label className="field-label" htmlFor="reset-new-password">
              New password
            </label>
            <input
              id="reset-new-password"
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              required
              className="input"
            />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="reset-confirm-password">
              Confirm new password
            </label>
            <input
              id="reset-confirm-password"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
              className="input"
            />
          </div>
          <p className="confirm-note">{POLICY_HINT}</p>
          <button type="submit" className="btn btn-primary btn-block" disabled={isLoading}>
            {isLoading ? 'Resetting…' : 'Reset password'}
          </button>
        </form>
      </div>
    </div>
  );
}

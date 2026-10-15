import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { requestPasswordReset } from '../services/api';
import { BrandMark } from '../components/BrandMark';

/**
 * US1 — Forgot-password entry page (feature 005, T014).
 *
 * A single email field that calls `requestPasswordReset(email)`. The endpoint
 * ALWAYS returns the uniform `200` `U` body — it never distinguishes a
 * registered vs unregistered address (non-enumeration oracle, 005 FR-002 /
 * SC-002), so on `200` we show the single "check your inbox" message either
 * way. A `429` (rate-limited, 005 FR-007) is surfaced as a recoverable message
 * ("Too many recent requests, please try again later") — the throttle is
 * presented as recoverable, never a dead end, and no specific wait time is
 * shown.
 */
export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sentMessage, setSentMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setSentMessage(null);
    setError(null);
    try {
      const message = await requestPasswordReset(email);
      setSentMessage(message);
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
        <h1 className="confirm-title">Forgot your password?</h1>

        {sentMessage ? (
          <>
            <p className="confirm-body" data-testid="forgot-sent">
              {sentMessage}
            </p>
            <p className="confirm-body">
              <Link to="/auth" className="confirm-link">
                Back to sign in
              </Link>
            </p>
          </>
        ) : (
          <>
            <p className="confirm-body">
              Enter the email address on your account and we&apos;ll send you a
              link to reset your password.
            </p>
            {error && (
              <div className="alert alert-error" role="alert">
                {error}
              </div>
            )}
            <form onSubmit={handleSubmit} className="form-stack">
              <div className="field">
                <label className="field-label" htmlFor="forgot-email">
                  Email
                </label>
                <input
                  id="forgot-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  className="input"
                />
              </div>
              <button type="submit" className="btn btn-primary btn-block" disabled={isLoading}>
                {isLoading ? 'Sending…' : 'Send reset link'}
              </button>
            </form>
            <p className="confirm-body">
              <Link to="/auth" className="confirm-link">
                Back to sign in
              </Link>
            </p>
          </>
        )}
      </div>
    </div>
  );
}

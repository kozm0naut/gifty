import React, { useCallback, useEffect, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { BrandMark } from '../components/BrandMark';

/**
 * US2 — Account confirmation page (feature 004, T021).
 *
 * The page keys off `GET /account` → `user.verified` (exposed by the auth
 * context as `isVerified`), NEVER off the `/confirm` response body: the
 * server returns a uniform `{status:"confirmed"}` for every outcome so the
 * link click closes the oracle and is uninformative for UX (FR-010 / SC-006).
 *
 * States (T021):
 *  - initializing            → wait for the cookie-backed bootstrap.
 *  - verified                → redirect to the dashboard (gate lifted).
 *  - unconfirmed + session   → "a link is on its way" + expiry note + resend.
 *  - unconfirmed + no session→ cold visit (dead/expired link, fresh browser):
 *                              sign-in prompt (resend needs a session).
 */

type ConfirmState = 'loading' | 'unconfirmed' | 'no-session';

export function ConfirmPage() {
  const { isAuthenticated, isInitializing, isVerified, resendConfirmation, refreshAccount } =
    useAuth();
  const [state, setState] = useState<ConfirmState>('loading');
  const [resendMsg, setResendMsg] = useState<string | null>(null);
  const [resendError, setResendError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const email = useAuth().user?.email;

  // Derive the display state from the live auth context whenever it settles.
  useEffect(() => {
    if (isInitializing) return;
    if (isVerified) return; // → <Navigate> below
    if (isAuthenticated) setState('unconfirmed');
    else setState('no-session');
  }, [isInitializing, isVerified, isAuthenticated]);

  // After the /confirm link has been consumed (the page is loaded via the SPA
  // hand-off), the account may already be confirmed — re-check so a fresh
  // confirmation takes effect without a manual reload.
  const check = useCallback(() => {
    void refreshAccount();
  }, [refreshAccount]);
  useEffect(() => {
    check();
  }, [check]);

  const handleResend = async () => {
    setBusy(true);
    setResendMsg(null);
    setResendError(null);
    try {
      await resendConfirmation();
      setResendMsg('A new confirmation email is on its way.');
    } catch (err: any) {
      setResendError(err?.message || 'Something went wrong. Please try again.');
      // A 403 means it was already confirmed — refresh so the gate lifts.
      if (err?.message && /already confirmed/i.test(err.message)) {
        void refreshAccount();
      }
    } finally {
      setBusy(false);
    }
  };

  if (isInitializing) {
    return (
      <div className="confirm-page confirm-page--center">
        <div className="loading-row">Loading…</div>
      </div>
    );
  }

  if (isVerified) {
    // Email confirmed — the gate is lifted. Land in the app.
    return <Navigate to="/" replace />;
  }

  // No live session (cold visit to a dead/expired link in a fresh browser).
  if (state === 'no-session') {
    return (
      <div className="confirm-page confirm-page--center">
        <div className="confirm-card card card-pad">
          <BrandMark className="confirm-brand" />
          <h1 className="confirm-title">Confirm your email</h1>
          <p className="confirm-body">
            This link didn't complete confirmation.{' '}
            <Link to="/auth" className="confirm-link">
              Sign in to your account
            </Link>{' '}
            and resend a fresh link.
          </p>
        </div>
      </div>
    );
  }

  // Unconfirmed with a live session: the main confirmation screen.
  return (
    <div className="confirm-page confirm-page--center">
      <div className="confirm-card card card-pad">
        <BrandMark className="confirm-brand" />
        <h1 className="confirm-title">Confirm your email</h1>
        <p className="confirm-body">
          A link is on its way to{' '}
          <span className="confirm-email" data-testid="confirm-email">
            {email || 'your inbox'}
          </span>
          .
        </p>

        <p className="confirm-note">
          Confirmation links expire after 24 hours. If your link isn't working,
          resend a new one.
        </p>

        <button
          type="button"
          className="btn btn-primary confirm-resend"
          onClick={handleResend}
          disabled={busy}
        >
          {busy ? 'Sending…' : 'Resend confirmation email'}
        </button>

        {resendMsg && <p className="confirm-msg confirm-msg--ok">{resendMsg}</p>}
        {resendError && <p className="confirm-msg confirm-msg--err" role="alert">{resendError}</p>}

        <div className="confirm-actions">
          <Link to="/auth" className="confirm-link">
            Open the app
          </Link>
        </div>
      </div>
    </div>
  );
}

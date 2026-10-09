import React, { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { BrandMark } from '../components/BrandMark';

/**
 * US2 — Account confirmation page (feature 004, T021).
 *
 * The page keys off `GET /account` → `user.verified` (exposed by the auth
 * context as `isVerified`), NEVER off the `/confirm` response body: the
 * server returns a uniform `{status:"confirmed"}` for every outcome so the
 * link click closes the oracle and is uninformative for UX (004 FR-004 / 004 FR-010).
 *
 * States (T021):
 *  - initializing            → wait for the cookie-backed bootstrap.
 *  - verified                → success message + short auto-redirect to the
 *                              dashboard (gate lifted).
 *  - unconfirmed + session   → "a link is on its way" + expiry note + resend.
 *  - unconfirmed + no session→ cold visit (dead/expired link, fresh browser):
 *                              sign-in prompt (resend needs a session).
 */

export function ConfirmPage() {
  const { isAuthenticated, isInitializing, isVerified, resendConfirmation, refreshAccount } =
    useAuth();
  const [resendMsg, setResendMsg] = useState<string | null>(null);
  const [resendError, setResendError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const email = useAuth().user?.email;
  const navigate = useNavigate();

  // Success requires BOTH a live session AND a confirmed account. `isVerified`
  // alone is true whenever the user is null (no session), which would wrongly
  // flash "You're confirmed!" to a logged-out / cold visitor before bouncing
  // them to /auth. Gating on `isAuthenticated` fixes that.
  const showSuccess = isAuthenticated && isVerified;

  // After the /confirm link has been consumed (the page is loaded via the SPA
  // hand-off), the account may already be confirmed — re-check so a fresh
  // confirmation takes effect without a manual reload.
  const check = useCallback(() => {
    void refreshAccount();
  }, [refreshAccount]);
  useEffect(() => {
    check();
  }, [check]);

  // Once confirmed with a live session, show the success message, then land in
  // the app. The timer is cancelled if the user navigates away earlier.
  useEffect(() => {
    if (!showSuccess) return;
    const t = window.setTimeout(() => navigate('/', { replace: true }), 3000);
    return () => window.clearTimeout(t);
  }, [showSuccess, navigate]);

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

  if (showSuccess) {
    // Confirmed + live session — the gate is lifted. Show a brief success
    // confirmation, then land in the app (the auto-redirect timer handles it).
    return (
      <div className="confirm-page confirm-page--center">
        <div className="confirm-card">
          <BrandMark className="confirm-brand" />
          <h1 className="confirm-title">You're confirmed!</h1>
          <p className="confirm-body" data-testid="confirm-success">
            Thanks for confirming your email.
          </p>
          <button
            type="button"
            className="btn btn-primary confirm-resend"
            onClick={() => navigate('/', { replace: true })}
          >
            Go to your lists
          </button>
        </div>
      </div>
    );
  }

  // No live session (cold visit to a confirmation link in a fresh browser).
  // Without a session we can't confirm or resend, so point them at sign-in.
  if (!isAuthenticated) {
    return (
      <div className="confirm-page confirm-page--center">
        <div className="confirm-card">
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
      <div className="confirm-card">
        <BrandMark className="confirm-brand" />
        <h1 className="confirm-title">Confirm your email</h1>
        <p className="confirm-body">A link is on its way to</p>
        <span className="confirm-email" data-testid="confirm-email">
          {email || 'your inbox'}
        </span>

        <p className="confirm-note">
          Confirmation links expire after 24 hours.
          <br />
          If your link isn't working, resend a new one.
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
      </div>
    </div>
  );
}

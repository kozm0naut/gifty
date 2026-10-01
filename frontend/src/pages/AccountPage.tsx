import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { deleteAccount } from '../services/api';
import { Modal } from '../components/Modal';
import { BrandMark } from '../components/BrandMark';

/**
 * T049 [US7] — Account area (FR-014 / FR-028).
 *
 * Shows the signed-in user's profile and offers a single, explicit,
 * IRREVERSIBLE "Remove account" action. The confirmation names the finality —
 * owned lists permanently deleted, claims on others' lists cleared — and makes
 * clear there is no grace period and no undo. On success the session is ended
 * and the user lands on the sign-in page. No "undo" / "restore" affordance is
 * offered anywhere.
 */
export function AccountPage() {
  const { user, removeAccount } = useAuth();
  const navigate = useNavigate();
  const [showConfirm, setShowConfirm] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleRemove = async () => {
    setWorking(true);
    setError(null);
    try {
      await deleteAccount();
      // The server has deleted the account and cleared both cookies.
      removeAccount();
      navigate('/auth', { replace: true });
    } catch (err: any) {
      setError(err?.message || 'Could not remove your account. Please try again.');
      setWorking(false);
    }
  };

  return (
    <div className="account-page">
      <section className="section-gap">
        <div className="page-header">
          <h1>Account</h1>
        </div>

        <div className="card card-pad account-profile">
          <h2 className="section-title"><BrandMark /> Your profile</h2>
          <dl className="account-fields">
            <div className="account-field">
              <dt>Display name</dt>
              <dd>{user?.displayName ?? '—'}</dd>
            </div>
            <div className="account-field">
              <dt>Email</dt>
              <dd>{user?.email ?? '—'}</dd>
            </div>
          </dl>
        </div>
      </section>

      <section className="section-gap">
        <div className="card card-pad account-danger">
          <h2 className="section-title">Danger zone</h2>
          <p className="muted account-danger-desc">
            Removing your account is permanent. This action cannot be undone.
          </p>
          {error && (
            <div className="alert alert-error" role="alert">
              {error}
            </div>
          )}
          <button
            type="button"
            className="btn btn-danger-outline"
            disabled={working}
            onClick={() => {
              setError(null);
              setShowConfirm(true);
            }}
          >
            {working ? 'Removing…' : 'Remove account'}
          </button>
        </div>
      </section>

      {showConfirm && (
        <Modal title="Remove account" onClose={() => !working && setShowConfirm(false)}>
          <div className="account-confirm">
            <p>
              This <strong>permanently deletes</strong> your Gifty account. The
              following will be lost immediately and cannot be recovered:
            </p>
            <ul className="account-confirm-list">
              <li>Every gift list you own, and all the items on those lists.</li>
              <li>
                Your access to lists other people shared with you.
              </li>
              <li>
                Any gift you have claimed on someone else's list — your claim is
                cleared and the item returns to <em>available</em> for them.
              </li>
            </ul>
            <p>
              There is <strong>no grace period and no way to undo this</strong>.
              Your audit history is kept on the server, but your identity will
              no longer be attached to it.
            </p>
            <div className="account-confirm-actions">
              <button
                type="button"
                className="btn btn-ghost"
                disabled={working}
                onClick={() => setShowConfirm(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-danger"
                disabled={working}
                onClick={handleRemove}
              >
                {working ? 'Removing…' : 'Permanently remove account'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

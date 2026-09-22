import React, { useEffect, useState } from 'react';
import * as api from '../services/api';
import { getInitials } from '../utils/avatar';
import { getNameColors } from '../utils/colors';

interface PermissionManagerProps {
  listId: string;
  onPermissionsUpdated: (permissions: api.SharePermission[]) => void;
  compact?: boolean;
}

export function PermissionManager({ listId, onPermissionsUpdated, compact }: PermissionManagerProps) {
  const [permissions, setPermissions] = useState<api.SharePermission[]>([]);
  const [email, setEmail] = useState('');
  const [isInviting, setIsInviting] = useState(false);
  const [isRevoking, setIsRevoking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadPermissions = async () => {
    setLoadError(null);
    try {
      const data = await api.fetchSharePermissions(listId);
      setPermissions(data);
      onPermissionsUpdated(data);
    } catch (err: any) {
      setLoadError(err.message || 'Failed to load permissions');
    }
  };

  useEffect(() => {
    loadPermissions();
  }, [listId]);

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email) return;

    setIsInviting(true);
    setError(null);
    setSuccess(null);

    try {
      await api.shareList(listId, {
        recipientEmail: email,
        permission: 'shared',
      });
      setEmail('');
      setSuccess('Invitation sent successfully!');
      await loadPermissions();
      setTimeout(() => setSuccess(null), 3000);
    } catch (err: any) {
      setError(err.message || 'Failed to send invitation');
    } finally {
      setIsInviting(false);
    }
  };

  const handleRevoke = async (permissionId: string) => {
    if (!window.confirm('Are you sure you want to revoke access for this user?')) return;

    setIsRevoking(permissionId);
    setError(null);

    try {
      await api.revokePermission(listId, permissionId);
      await loadPermissions();
    } catch (err: any) {
      setError(err.message || 'Failed to revoke access');
    } finally {
      setIsRevoking(null);
    }
  };

  return (
    <div className={compact ? undefined : 'card card-pad'}>
      {error && <div className="alert alert-error">{error}</div>}
      {success && <div className="alert alert-success">{success}</div>}

      <form onSubmit={handleInvite} className="invite-row">
        <input
          type="email"
          placeholder="Recipient email address"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          className="input grow-1"
        />
        <button type="submit" className="btn btn-primary" disabled={isInviting}>
          {isInviting ? 'Inviting...' : 'Invite'}
        </button>
      </form>

      <div>
        <h4 className="muted recipient-heading">
          Shared with
        </h4>
        {loadError ? (
          <div className="alert alert-error alert-row">
            <span>Couldn't load recipients: {loadError}</span>
            <button type="button" className="btn btn-danger btn-sm" onClick={loadPermissions}>
              Retry
            </button>
          </div>
        ) : permissions.length === 0 ? (
          <p className="faint recipient-empty">No one has access to this list yet.</p>
        ) : (
          <ul className="recipient-list">
            {permissions.map((p) => (
              <li
                key={p.id}
                className="recipient-row"
              >
                <span className="recipient-name">
                  <span
                    className="avatar recipient-avatar"
                    style={{ background: getNameColors(p.recipientDisplayName).primary }}
                    title={p.recipientDisplayName}
                  >
                    {getInitials(p.recipientDisplayName)}
                  </span>
                  {p.recipientDisplayName}
                </span>
                <button
                  className="btn btn-danger-outline btn-sm"
                  onClick={() => handleRevoke(p.id)}
                  disabled={isRevoking === p.id}
                >
                  {isRevoking === p.id ? '...' : 'Revoke'}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

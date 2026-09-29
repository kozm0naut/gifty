import React, { useState } from 'react';
import * as api from '../services/api';

interface ConsentControlProps {
  listId: string;
  /** The caller's current consent state (owned by the parent). */
  consent: api.ConsentState;
  /** Persist a new consent choice and report it back to the parent. */
  onChange: (consent: api.ConsentState) => void;
}

/**
 * US5 (FR-023): self-serve control in a recipient's list view to identify
 * themselves (reveal their display name) or hide it again. Visible only to
 * recipients (the owner is not subject to name-disclosure consent).
 *
 * - consent `revealed` → "Hide my name" (click → `declined`)
 * - consent `pending`/`declined` → "Reveal my name" (click → `revealed`)
 *
 * The consent state is owned by the parent (ListPage) so this control and the
 * one-time prompt always agree.
 */
export function ConsentControl({ listId, consent, onChange }: ConsentControlProps) {
  const [acting, setActing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const revealed = consent === 'revealed';

  const toggle = async () => {
    const next: api.ConsentState = revealed ? 'declined' : 'revealed';
    setActing(true);
    setError(null);
    try {
      await api.setConsent(listId, next);
      onChange(next);
    } catch (err: any) {
      setError(err.message || 'Failed to update your preference');
    } finally {
      setActing(false);
    }
  };

  return (
    <div className="consent-control">
      <button
        type="button"
        className="btn btn-outline btn-sm"
        onClick={() => void toggle()}
        disabled={acting}
      >
        {acting ? 'Updating…' : revealed ? 'Hide my name' : 'Reveal my name'}
      </button>
      {error && <span className="alert alert-error alert-inline">{error}</span>}
    </div>
  );
}

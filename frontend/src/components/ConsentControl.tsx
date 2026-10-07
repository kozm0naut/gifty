import React, { useState } from 'react';
import * as api from '../services/api';
import { ConsentModal } from './ConsentModal';

interface ConsentControlProps {
  listId: string;
  /** The caller's current consent state (owned by the parent). */
  consent: api.ConsentState;
  /** Persist a new consent choice and report it back to the parent. */
  onChange: (consent: api.ConsentState) => void;
}

/**
 * US5 (003 FR-023): self-serve control in a recipient's list view to identify
 * themselves (reveal their display name) or hide it again. Visible only to
 * recipients (the owner is not subject to name-disclosure consent).
 *
 * - consent `revealed` → "Hide my name"; `pending`/`declined` → "Reveal my name".
 * - Clicking the button reopens the identity-consent prompt (the same modal
 *   as the first-open prompt) so the user can make the decision with full
 *   context — reveal or keep anonymous — instead of a blind one-click toggle.
 *
 * The consent state is owned by the parent (ListPage) so this control and the
 * one-time prompt always agree.
 */
export function ConsentControl({ listId, consent, onChange }: ConsentControlProps) {
  const revealed = consent === 'revealed';
  const [open, setOpen] = useState(false);

  return (
    <div className="consent-control">
      <button
        type="button"
        className="btn btn-outline btn-sm"
        onClick={() => setOpen(true)}
      >
        {revealed ? 'Hide my name' : 'Reveal my name'}
      </button>
      <ConsentModal
        listId={listId}
        consent={consent}
        onChange={onChange}
        open={open}
        onClose={() => setOpen(false)}
      />
    </div>
  );
}

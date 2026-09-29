import React, { useState } from 'react';
import * as api from '../services/api';
import { Modal } from './Modal';

interface ConsentPromptProps {
  listId: string;
  /** The caller's current consent state (owned by the parent). */
  consent: api.ConsentState;
  /** Persist a new consent choice and report it back to the parent. */
  onChange: (consent: api.ConsentState) => void;
}

/**
 * US5 (FR-022): one-time name-disclosure consent prompt, shown to a recipient
 * on the first open of a shared list they have not yet consented on.
 *
 * - The prompt appears only when `consent === 'pending'`.
 * - "Reveal my name" → `revealed` (FR-023). "Keep me anonymous" → `declined`.
 * - Once the recipient acts, the prompt is never repeated (FR-022).
 *
 * The consent state is owned by the parent (ListPage) so the prompt and the
 * self-serve control always agree.
 */
export function ConsentPrompt({ listId, consent, onChange }: ConsentPromptProps) {
  const [acting, setActing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (consent !== 'pending') return null;

  const handleAction = async (choice: api.ConsentState) => {
    setActing(true);
    setError(null);
    try {
      await api.setConsent(listId, choice);
      onChange(choice);
    } catch (err: any) {
      setError(err.message || 'Failed to update your preference');
    } finally {
      setActing(false);
    }
  };

  return (
    <Modal
      title="Name disclosure"
      subtitle="Would you like to reveal your display name to the other people sharing this list?"
      onClose={() => void handleAction('declined')}
    >
      {error && <div className="alert alert-error">{error}</div>}
      <p className="muted">
        If you choose to reveal your name, it will be visible to the owner and
        other recipients of this list. You can change this choice at any time
        from the list's Sharing section.
      </p>
      <div className="consent-actions">
        <button
          className="btn btn-primary"
          onClick={() => void handleAction('revealed')}
          disabled={acting}
        >
          {acting ? 'Updating…' : 'Reveal my name'}
        </button>
        <button
          className="btn btn-outline"
          onClick={() => void handleAction('declined')}
          disabled={acting}
        >
          Keep me anonymous
        </button>
      </div>
    </Modal>
  );
}

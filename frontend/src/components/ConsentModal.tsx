import React, { useEffect, useState } from 'react';
import * as api from '../services/api';
import { Modal } from './Modal';

interface ConsentModalProps {
  listId: string;
  /** The caller's current consent state (owned by the parent). */
  consent: api.ConsentState;
  /** Persist a new consent choice and report it back to the parent. */
  onChange: (consent: api.ConsentState) => void;
  /** Whether the modal is shown. The parent owns visibility. */
  open: boolean;
  /** Dismissed without a choice (X / backdrop / Escape) — consent is unchanged. */
  onClose: () => void;
}

/**
 * US5 (FR-022/FR-023): the name-disclosure consent dialog, shared by the
 * first-open prompt (`ConsentPrompt`) and the self-serve control
 * (`ConsentControl`) so both give the user the same contextual choice.
 *
 * - "Reveal my name" → `revealed`. "Keep me anonymous" → `declined`.
 * - Dismissing without choosing (X / backdrop / Escape) is NOT a choice:
 *   it leaves consent unchanged and only closes the modal.
 *
 * The consent state is owned by the parent (ListPage) so the prompt and the
 * self-serve control always agree.
 */
export function ConsentModal({ listId, consent, onChange, open, onClose }: ConsentModalProps) {
  const [acting, setActing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setError(null);
    }
  }, [open]);

  if (!open) return null;

  const handleAction = async (choice: api.ConsentState) => {
    setActing(true);
    setError(null);
    try {
      await api.setConsent(listId, choice);
      onChange(choice);
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to update your preference');
    } finally {
      setActing(false);
    }
  };

  const revealed = consent === 'revealed';

  return (
    <Modal
      title="Name disclosure"
      subtitle={
        revealed
          ? 'Your name is currently visible on this list.'
          : 'Reveal your name to others on this list?'
      }
      onClose={onClose}
    >
      {error && <div className="alert alert-error">{error}</div>}
      <p className="muted">
        {revealed
          ? "Your name is currently visible to the owner and other recipients of this list, but you may hide it if you prefer to stay anonymous. You can change this at any time."
          : "If you reveal your name, it will be visible to the owner and other recipients of this list. You can change this at any time from the list's Sharing section."}
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
          {acting ? 'Updating…' : 'Keep me anonymous'}
        </button>
      </div>
    </Modal>
  );
}

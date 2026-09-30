import React, { useState } from 'react';
import * as api from '../services/api';
import { ConsentModal } from './ConsentModal';

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
 * - Dismissing without choosing (X / backdrop / Escape) is NOT a choice: it
 *   leaves consent `pending` (no POST), dismisses the modal for this session,
 *   and the prompt reappears the next time the list is opened (the local
 *   dismissed state resets on remount).
 *
 * The consent state is owned by the parent (ListPage) so the prompt and the
 * self-serve control always agree.
 */
export function ConsentPrompt({ listId, consent, onChange }: ConsentPromptProps) {
  // Closing without choosing is not a consent decision — keep the state
  // `pending` and simply hide the modal until the list is opened again.
  const [dismissed, setDismissed] = useState(false);

  if (consent !== 'pending' || dismissed) return null;

  return (
    <ConsentModal
      listId={listId}
      consent={consent}
      onChange={onChange}
      open
      onClose={() => setDismissed(true)}
    />
  );
}

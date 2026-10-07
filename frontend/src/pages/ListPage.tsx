import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import * as api from '../services/api';
import { GiftItemForm } from '../components/GiftItemForm';
import { GiftItemList } from '../components/GiftItemList';
import { PermissionManager } from '../components/PermissionManager';
import { RenameListForm } from '../components/RenameListForm';
import { Modal } from '../components/Modal';
import { ConsentPrompt } from '../components/ConsentPrompt';
import { ConsentControl } from '../components/ConsentControl';
import { useAuth } from '../context/AuthContext';
import { getInitials } from '../utils/avatar';
import { getNameColors } from '../utils/colors';

type ListModal = 'add-item' | 'sharing' | 'rename';

export function ListPage({ initialModal }: { initialModal?: ListModal }) {
  const { listId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [list, setList] = useState<api.DashboardList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [recipients, setRecipients] = useState<api.SharePermission[]>([]);
  const [loadingRecipients, setLoadingRecipients] = useState(false);
  const [showRecipients, setShowRecipients] = useState(false);
  const [modal, setModal] = useState<ListModal | null>(initialModal ?? null);
  // US5: the caller's name-disclosure consent on this list. Owned here so the
  // one-time prompt and the self-serve control always agree. `null` means
  // "not a recipient" (the owner, or the consent read failed / 403) and the
  // consent UI is hidden entirely.
  const [consent, setConsent] = useState<api.ConsentState | null>(null);
  // Ref lives on the wrapper so the popover (a sibling of the stack inside the
  // wrapper) counts as "inside" — otherwise touching the popover to scroll it
  // would be read as an outside click and close it.
  const avatarStackRef = React.useRef<HTMLDivElement>(null);

  // Close the recipients popover on outside click or Escape.
  useEffect(() => {
    if (!showRecipients) return;
    const onPointerDown = (e: PointerEvent) => {
      if (avatarStackRef.current && !avatarStackRef.current.contains(e.target as Node)) {
        setShowRecipients(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowRecipients(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [showRecipients]);

  // Sync modal when the route changes (e.g. /list/:id → /list/:id/add-item).
  // React Router reuses the same ListPage instance, so the useState initializer
  // above only ran on first mount. This effect catches subsequent prop changes.
  useEffect(() => {
    if (initialModal) {
      setModal(initialModal);
    }
  }, [initialModal]);

  const closeModal = () => {
    setModal(null);
    // If we arrived via a deep link (e.g. dashboard quick action), land on the list page.
    if (window.location.pathname.endsWith('/add-item') || window.location.pathname.endsWith('/sharing')) {
      navigate(`/list/${listId}`);
    }
  };

  useEffect(() => {
    if (!listId) return;

    const loadList = async () => {
      try {
        setIsLoading(true);
        const data = await api.fetchListById(listId);
        setList(data);
      } catch (err: any) {
        setError(err.message || 'Failed to load list');
      } finally {
        setIsLoading(false);
      }
    };

    loadList();
  }, [listId]);

  useEffect(() => {
    if (!listId || !list) return;
    const isOwner = list.owner?.id === user?.id;
    let cancelled = false;
    setLoadingRecipients(true);
    // Owner uses the full permission endpoint (also feeds PermissionManager).
    // Recipients use the lighter /recipients endpoint (display names only).
    const fetcher = isOwner ? api.fetchSharePermissions : api.fetchListRecipients;
    fetcher(listId)
      .then((perms) => {
        if (!cancelled) setRecipients(perms);
      })
      .catch(() => {
        /* recipient list is non-critical */
      })
      .finally(() => {
        if (!cancelled) setLoadingRecipients(false);
      });
    return () => {
      cancelled = true;
    };
  }, [listId, list, user?.id]);

  // US5 (003 FR-021/003 FR-022): load the caller's consent state for this list once
  // the list and viewer are known. Recipients get a `pending`/`revealed`/
  // `declined` state; the owner (or a non-recipient) gets a 403 → `null`,
  // which hides all consent UI.
  useEffect(() => {
    if (!listId || !list) return;
    if (list.owner?.id === user?.id) {
      setConsent(null);
      return;
    }
    let cancelled = false;
    api
      .fetchConsent(listId)
      .then((info) => {
        if (!cancelled) setConsent(info.consent);
      })
      .catch(() => {
        if (!cancelled) setConsent(null);
      });
    return () => {
      cancelled = true;
    };
  }, [listId, list, user?.id]);

  const handleConsentChange = (next: api.ConsentState) => {
    setConsent(next);
  };

  const handleItemAdded = (newItem: api.GiftItem) => {
    if (!list) return;
    setList({ ...list, items: [...(list.items || []), newItem] });
  };

  const handleItemUpdated = (updatedItem: api.GiftItem) => {
    if (!list) return;
    const newItems = list.items?.map((item) => 
      item.id === updatedItem.id ? updatedItem : item
    );
    setList({ ...list, items: newItems || [] });
  };

  const handleRenamed = (updated: api.DashboardList) => {
    setList(updated);
    setModal(null);
  };

  if (isLoading) return <p>Loading list...</p>;

  if (error) {
    if (error === 'List not found') {
      return (
        <div className="deleted-wrap">
          <div className="card card-pad deleted-card">
            <div className="deleted-emoji">📋</div>
            <h2 className="muted deleted-title">List Deleted</h2>
            <p className="faint">This list is no longer available.</p>
          </div>
          <button className="backlink" onClick={() => navigate('/')}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M19 12H5" />
              <path d="M12 19l-7-7 7-7" />
            </svg>
            Lists
          </button>
        </div>
      );
    }
    return <div className="alert alert-error">{error}</div>;
  }

  if (!list) return <p>List not found.</p>;

  const isOwner = list.owner?.id === user?.id;

  // US5 (003 FR-023): mirror the co-recipient view for the viewer's OWN entry in
  // the sharing stack. When the viewer has not consented to name disclosure on
  // this list, their own avatar/name render as the anonymous placeholder — the
  // same thing every other non-revealing recipient sees. Purely cosmetic (the
  // API already returns the viewer's own name); it keeps the sharing section
  // honest about what is actually visible to others. Owner (consent === null)
  // and already-revealed recipients are unaffected.
  // Anonymous placeholder (grey circle with "?") — one visual for: the
  // viewer's OWN entry while their consent is not `revealed` (self-mask,
  // 003 FR-023), and every other entry whose recipient has not consented to
  // reveal (unregistered invitees included — indistinguishable, 003 FR-010/003 FR-021).
  const MASK_GREY = '#6b7280';
  // Self-mask (003 FR-023): in the recipient view the API ALWAYS returns the
  // viewer's own name (it is their own identity), so their own entry must be
  // masked client-side to mirror what a co-recipient would see. `null` = not a
  // recipient (owner / consent read failed) → consent UI hidden, no self-mask.
  const maskSelf = consent !== null && consent !== 'revealed';
  // `recipientUserId` exists only on the recipient-facing `/recipients` shape
  // (the owner's uniform view omits it by design). `undefined === user?.id`
  // is always false, so this is safe for both shapes.
  const isOwnEntry = (r: api.SharePermission) => r.recipientUserId === user?.id;
  const anonymous = (r: api.SharePermission) =>
    (maskSelf && isOwnEntry(r)) ||
    !r.recipientDisplayName ||
    r.recipientDisplayName === '????'; // backend ANONYMOUS_DISPLAY_NAME (non-revealed, recipient view)
  const displayName = (r: api.SharePermission) =>
    anonymous(r)
      ? maskSelf && isOwnEntry(r)
        ? '???? (You)'
        : r.recipientEmail ?? '????'
      : r.recipientDisplayName ?? r.recipientEmail ?? '????';
  const displayColor = (r: api.SharePermission) =>
    anonymous(r) ? MASK_GREY : getNameColors(r.recipientDisplayName ?? r.recipientEmail ?? '???', true).primary;
  const displayInitials = (r: api.SharePermission) =>
    anonymous(r) ? '?' : getInitials(r.recipientDisplayName ?? r.recipientEmail ?? '???');

  // Display order for the "Shared with" list (avatar stack + popover):
  //   1. Revealed recipients, alphabetical by display name
  //   2. Self (viewer's own masked entry) — only present in recipient view
  //   3. Remaining unknowns (unregistered or non-revealed others)
  const sortedRecipients = [...recipients].sort((a, b) => {
    const cat = (r: api.SharePermission): number => {
      if (!anonymous(r)) return 0;            // revealed
      if (maskSelf && isOwnEntry(r)) return 1; // self (masked)
      return 2;                                 // other unknown
    };
    const ca = cat(a), cb = cat(b);
    if (ca !== cb) return ca - cb;
    if (ca === 0) {
      // Alphabetical by display name within the revealed group.
      return (a.recipientDisplayName ?? '').localeCompare(b.recipientDisplayName ?? '');
    }
    return 0;
  });

  return (
    <div
      className="list-page"
      style={{
        '--card-accent': getNameColors(list.title).primary,
        '--card-accent-2': getNameColors(list.title).secondary,
      } as React.CSSProperties}
    >
      <button className="backlink list-page-back" onClick={() => navigate('/')}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M19 12H5" />
          <path d="M12 19l-7-7 7-7" />
        </svg>
        Lists
      </button>

      {!isOwner && (
        <p className="faint list-shared-by">
          Shared by <strong>{list.owner?.displayName || 'another user'}</strong>
        </p>
      )}

      <header className="list-header">
        <h1>
          {list.title}
          {isOwner && (
            <button
              className="icon-btn rename-btn"
              onClick={() => setModal('rename')}
              title="Rename list"
              aria-label="Rename list"
            >
              ✎
            </button>
          )}
        </h1>

        {list.description && <p className="muted list-desc">{list.description}</p>}
      </header>

      <hr className="list-divider" aria-hidden="true" />

      <section className="share-section">
        {isOwner && (
          <button
            className="btn btn-primary"
            onClick={() => setModal('add-item')}
          >
            + Add Item
          </button>
        )}

        <div className="avatar-stack-wrap avatar-stack-grow" ref={avatarStackRef}>
        <div
          className="avatar-stack"
          role="button"
          tabIndex={0}
          aria-expanded={showRecipients}
          title={
            loadingRecipients
              ? 'Loading…'
              : recipients.length
                ? `Shared with ${recipients.length} ${recipients.length === 1 ? 'person' : 'people'}`
                : 'Not shared yet'
          }
          onClick={() => recipients.length && !loadingRecipients && setShowRecipients((v) => !v)}
          onKeyDown={(e) => {
            if ((e.key === 'Enter' || e.key === ' ') && recipients.length && !loadingRecipients) {
              e.preventDefault();
              setShowRecipients((v) => !v);
            }
          }}
        >
          {loadingRecipients && (
            <span className="muted avatar-loading">
              Loading…
            </span>
          )}
          {sortedRecipients.slice(0, 8).map((r) => (
            <span
              key={r.id}
              className="avatar"
              style={{ background: displayColor(r) }}
              title={displayName(r)}
            >
              {displayInitials(r)}
            </span>
          ))}
          {sortedRecipients.length > 8 && (
            <span
              className="avatar avatar-more"
              title={sortedRecipients.slice(8).map((r) => displayName(r)).join('\n')}
            >
              +{sortedRecipients.length - 8}
            </span>
          )}
          {isOwner && (
            <button
              className="share-btn"
              onClick={(e) => {
                e.stopPropagation();
                setShowRecipients(false);
                setModal('sharing');
              }}
              title="Manage Sharing"
              aria-label="Manage Sharing"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <line x1="19" x2="19" y1="8" y2="14" />
                <line x1="22" x2="16" y1="11" y2="11" />
              </svg>
            </button>
          )}
        </div>

        {showRecipients && recipients.length > 0 && (
          <div className="avatar-popover" role="dialog" aria-label="Shared with">
            <div className="avatar-popover-title">
              Shared with {recipients.length} {recipients.length === 1 ? 'person' : 'people'}
            </div>
            <ul className="avatar-popover-list">
              {sortedRecipients.map((r) => (
                <li key={r.id} className="avatar-popover-item">
                  <span
                    className="avatar-popover-dot"
                    style={{ background: displayColor(r) }}
                    aria-hidden="true"
                  />
                  {displayName(r)}
                </li>
              ))}
            </ul>
          </div>
        )}
        </div>

        {/* US5 (003 FR-023): self-serve name-disclosure control — recipients only. */}
        {listId && consent !== null && (
          <ConsentControl listId={listId} consent={consent} onChange={handleConsentChange} />
        )}
      </section>

      <section className="items-section">
        <GiftItemList
          items={list.items || []}
          onItemUpdated={handleItemUpdated}
          isOwner={isOwner}
        />
      </section>

      {/* US5 (003 FR-022): one-time name-disclosure consent prompt — recipients only. */}
      {listId && consent === 'pending' && (
        <ConsentPrompt listId={listId} consent={consent} onChange={handleConsentChange} />
      )}

      {modal === 'add-item' && listId && (
        <Modal title="Add Gift Item" subtitle={`to “${list.title}”`} onClose={closeModal}>
          <GiftItemForm
            listId={listId}
            onItemAdded={(item) => {
              handleItemAdded(item);
              setModal(null);
            }}
          />
        </Modal>
      )}

      {modal === 'sharing' && listId && (
        <Modal title="Manage Sharing" subtitle={`for “${list.title}”`} onClose={closeModal}>
          <PermissionManager
            listId={listId}
            compact
            onPermissionsUpdated={(perms) => setRecipients(perms)}
          />
        </Modal>
      )}

      {modal === 'rename' && listId && (
        <Modal title="Rename List" subtitle={`Update the title of “${list.title}”`} onClose={closeModal}>
          <RenameListForm
            listId={listId}
            initialTitle={list.title}
            initialDescription={list.description ?? ''}
            onRenamed={handleRenamed}
          />
        </Modal>
      )}
    </div>
  );
}

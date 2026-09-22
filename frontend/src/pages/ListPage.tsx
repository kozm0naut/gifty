import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import * as api from '../services/api';
import { GiftItemForm } from '../components/GiftItemForm';
import { GiftItemList } from '../components/GiftItemList';
import { PermissionManager } from '../components/PermissionManager';
import { RenameListForm } from '../components/RenameListForm';
import { Modal } from '../components/Modal';
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
          {recipients.slice(0, 8).map((r) => (
            <span
              key={r.id}
              className="avatar"
              style={{ background: getNameColors(r.recipientDisplayName).primary }}
              title={r.recipientDisplayName}
            >
              {getInitials(r.recipientDisplayName)}
            </span>
          ))}
          {recipients.length > 8 && (
            <span
              className="avatar avatar-more"
              title={recipients.slice(8).map((r) => r.recipientDisplayName).join('\n')}
            >
              +{recipients.length - 8}
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
              {recipients.map((r) => (
                <li key={r.id} className="avatar-popover-item">
                  <span
                    className="avatar-popover-dot"
                    style={{ background: getNameColors(r.recipientDisplayName).primary }}
                    aria-hidden="true"
                  />
                  {r.recipientDisplayName}
                </li>
              ))}
            </ul>
          </div>
        )}
        </div>
      </section>

      <section className="items-section">
        <GiftItemList
          items={list.items || []}
          onItemUpdated={handleItemUpdated}
          isOwner={isOwner}
        />
      </section>

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

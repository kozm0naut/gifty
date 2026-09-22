import React, { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import * as api from '../services/api';
import { useAuth } from '../context/AuthContext';
import { Modal } from '../components/Modal';
import { NewListForm } from '../components/NewListForm';
import { BrandMark } from '../components/BrandMark';
import { getNameColors } from '../utils/colors';

export function Dashboard() {
  const [lists, setLists] = useState<api.DashboardList[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showNewList, setShowNewList] = useState(false);
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user } = useAuth();
  const currentUserId = user?.id;

  useEffect(() => {
    if (searchParams.has('new')) {
      setShowNewList(true);
      searchParams.delete('new');
      setSearchParams(searchParams, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    if (!currentUserId) {
      setLists([]);
      setError(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    const loadLists = async () => {
      try {
        const data = await api.fetchLists();
        if (!cancelled) setLists(data);
      } catch (err: any) {
        if (!cancelled) setError(err.message || 'Failed to load lists');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    loadLists();
    return () => {
      cancelled = true;
    };
  }, [currentUserId]);

  const isMine = (list: api.DashboardList) => list.owner?.id === currentUserId;
  const byCreatedAt = (a: api.DashboardList, b: api.DashboardList) =>
    new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  const myLists = lists.filter(isMine).sort(byCreatedAt);
  const sharedLists = lists.filter((list) => !isMine(list)).sort(byCreatedAt);

  const handleDeleteList = async (listId: string) => {
    const confirmed = window.confirm('Delete this list? This will remove the list and any shared access for recipients.');
    if (!confirmed) {
      return;
    }

    try {
      await api.deleteList(listId);
      setLists((currentLists) => currentLists.filter((list) => list.id !== listId));
    } catch (deleteError: any) {
      alert(deleteError.message || 'Could not delete list');
    }
  };

  const renderListCard = (list: api.DashboardList, mine: boolean) => {
    const itemCount = list.items?.length ?? 0;
    const { primary, secondary } = getNameColors(list.title);
    return (
      <div
        key={list.id}
        className={`card list-card${mine ? '' : ' list-card-shared'}`}
        style={{
          '--card-accent': primary,
          '--card-accent-2': secondary,
        } as React.CSSProperties}
        onClick={() => navigate(`/list/${list.id}`)}
      >
        <div className="list-card-main">
          {!mine && (
            <div className="faint list-card-shared-by">
              Shared by {list.owner?.displayName || 'another user'}
            </div>
          )}
          <div className="list-card-title">{list.title}</div>
          {list.description && (
            <div className="muted list-card-desc">
              {list.description}
            </div>
          )}
        </div>

        <div className="badge badge-neutral card-badge">
          {itemCount} item{itemCount === 1 ? '' : 's'}
        </div>

        {mine ? (
          <div className="card-actions">
            <button
              type="button"
              className="icon-btn icon-btn-accent"
              aria-label="Add new item"
              title="Add new item"
              onClick={(e) => {
                e.stopPropagation();
                navigate(`/list/${list.id}/add-item`);
              }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
            <button
              type="button"
              className="icon-btn icon-btn-danger"
              aria-label="Delete list"
              title="Delete list"
              onClick={(e) => {
                e.stopPropagation();
                handleDeleteList(list.id);
              }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M3 6h18" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                <line x1="10" y1="11" x2="10" y2="17" />
                <line x1="14" y1="11" x2="14" y2="17" />
              </svg>
            </button>
            <button
              type="button"
              className="icon-btn icon-btn-accent"
              aria-label="Share list"
              title="Share list"
              onClick={(e) => {
                e.stopPropagation();
                navigate(`/list/${list.id}/sharing`);
              }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <line x1="19" x2="19" y1="8" y2="14" />
                <line x1="22" x2="16" y1="11" y2="11" />
              </svg>
            </button>
          </div>
        ) : (
          <div className="card-actions">
            <span className="badge badge-neutral">Shared with you</span>
          </div>
        )}
      </div>
    );
  };

  return (
    <div>
      {error && <div className="alert alert-error">{error}</div>}

      <div className="page-header">
        <h1>Lists</h1>
        <button className="btn btn-primary" onClick={() => setShowNewList(true)}>
          + New List
        </button>
      </div>

      <section className="section-gap">
        <h2 className="section-title"><BrandMark /> My Lists</h2>
        {loading ? (
          <div className="muted loading-row">Loading lists…</div>
        ) : myLists.length === 0 ? (
          <div className="empty-state">
            <p>You haven't created any gift lists yet.</p>
            <button className="btn btn-primary" onClick={() => setShowNewList(true)}>
              Create Your First List
            </button>
          </div>
        ) : (
          <div className="flex-col col-gap-1">
            {myLists.map((list) => renderListCard(list, true))}
          </div>
        )}
      </section>

      {sharedLists.length > 0 && (
        <section>
          <h2 className="section-title"><BrandMark /> Shared with me</h2>
          <div className="flex-col col-gap-1">
            {sharedLists.map((list) => renderListCard(list, false))}
          </div>
        </section>
      )}

      {showNewList && (
        <Modal title="Create New List" onClose={() => setShowNewList(false)}>
          <NewListForm
            onListCreated={(list) => {
              setLists((prev) => [list, ...prev]);
              setShowNewList(false);
            }}
          />
        </Modal>
      )}
    </div>
  );
}

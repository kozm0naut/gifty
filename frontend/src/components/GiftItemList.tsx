import React, { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { GiftItem, claimGiftItem, purchaseGiftItem, unclaimGiftItem, unpurchaseGiftItem } from '../services/api';
import { useAuth } from '../context/AuthContext';

interface GiftItemListProps {
  items: GiftItem[];
  onItemUpdated: (updatedItem: GiftItem) => void;
  isOwner?: boolean;
}

export function GiftItemList({ items, onItemUpdated, isOwner }: GiftItemListProps) {
  const { user } = useAuth();
  const { listId } = useParams();
  const navigate = useNavigate();
  const currentUserId = user?.id;

  const [isProcessing, setIsProcessing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleClaim = async (itemId: string) => {
    setIsProcessing(itemId);
    setError(null);
    try {
      const updatedItem = await claimGiftItem(itemId);
      onItemUpdated(updatedItem);
    } catch (err: any) {
      setError(err.message || 'Failed to claim item');
    } finally {
      setIsProcessing(null);
    }
  };

  const handlePurchase = async (itemId: string) => {
    setIsProcessing(itemId);
    setError(null);
    try {
      const updatedItem = await purchaseGiftItem(itemId);
      onItemUpdated(updatedItem);
    } catch (err: any) {
      setError(err.message || 'Failed to mark item as purchased');
    } finally {
      setIsProcessing(null);
    }
  };

  const handleUnclaim = async (itemId: string) => {
    if (!window.confirm('Revert your claim on this item? It will become available again.')) return;
    setIsProcessing(itemId);
    setError(null);
    try {
      const updatedItem = await unclaimGiftItem(itemId);
      onItemUpdated(updatedItem);
    } catch (err: any) {
      setError(err.message || 'Failed to revert claim');
    } finally {
      setIsProcessing(null);
    }
  };

  const handleUnpurchase = async (itemId: string) => {
    if (!window.confirm('Revert the purchase on this item? It will return to a claimed state.')) return;
    setIsProcessing(itemId);
    setError(null);
    try {
      const updatedItem = await unpurchaseGiftItem(itemId);
      onItemUpdated(updatedItem);
    } catch (err: any) {
      setError(err.message || 'Failed to revert purchase');
    } finally {
      setIsProcessing(null);
    }
  };

  if (items.length === 0) {
    return (
      <div className="empty-state">
        <p>No items in this list yet.</p>
        {isOwner && (
          <button className="btn btn-primary" onClick={() => navigate(`/list/${listId}/add-item`)}>
            Add Your First Item
          </button>
        )}
      </div>
    );
  }

  const stateBadge = (
    state: string,
    claimantLabel: string | null,
    dismiss?: { onClick: () => void; title: string; loading: boolean }
  ) => {
    const cls =
      state === 'available' ? 'badge-success' : state === 'claimed' ? 'badge-warning' : 'badge-danger';
    const label = claimantLabel ? `${state} BY ${claimantLabel}` : state;
    return (
      <span className={`badge ${cls}`}>
        {label}
        {dismiss ? (
          <button
            className="badge-x"
            onClick={dismiss.onClick}
            disabled={dismiss.loading}
            title={dismiss.title}
          >
            {dismiss.loading ? '…' : '✕'}
          </button>
        ) : claimantLabel === 'YOU' ? null : (
          <span className="badge-dot" />
        )}
      </span>
    );
  };

  return (
    <div>
      {error && <div className="alert alert-error">{error}</div>}
      <ul className="item-list">
        {items.map((item) => (
          <li
            key={item.id}
            className="card item-card"
          >
            <div className="list-card-main">
              <div className="item-name">
                {item.name}
                {item.quantity !== undefined && item.quantity !== null && (
                  <span className="faint item-qty">
                    (x{item.quantity})
                  </span>
                )}
              </div>
              {item.description && <div className="muted item-desc">{item.description}</div>}
              {(() => {
                const hasPrice = item.unitPrice !== undefined && item.unitPrice !== null;
                if (!hasPrice) return null;
                return (
                  <div className="faint item-meta">
                    ${Number(item.unitPrice).toFixed(2)}
                  </div>
                );
              })()}
            </div>

            {!isOwner && (
              <div className="item-side">
                <div className="flex-row row-gap-1">
                  {stateBadge(
                    item.state,
                    item.claimantUserId === currentUserId
                      ? 'YOU'
                      : item.claimantDisplayName || null,
                    item.state === 'claimed' && item.claimantUserId === currentUserId
                      ? { onClick: () => handleUnclaim(item.id), title: 'Cancel', loading: isProcessing === item.id }
                      : item.state === 'purchased' && item.claimantUserId === currentUserId
                        ? { onClick: () => handleUnpurchase(item.id), title: 'Cancel', loading: isProcessing === item.id }
                        : undefined
                  )}
                </div>
                {item.state === 'available' && (
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={() => handleClaim(item.id)}
                    disabled={isProcessing === item.id}
                  >
                    {isProcessing === item.id ? '...' : 'Claim'}
                  </button>
                )}
                {item.state === 'claimed' && item.claimantUserId === currentUserId && (
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={() => handlePurchase(item.id)}
                    disabled={isProcessing === item.id}
                  >
                    {isProcessing === item.id ? '...' : 'Purchased'}
                  </button>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

import React, { useState } from 'react';
import { GiftItem, createGiftItem } from '../services/api';
import { NumberStepper } from './NumberStepper';

interface GiftItemFormProps {
  listId: string;
  onItemAdded: (item: GiftItem) => void;
}

export function GiftItemForm({ listId, onItemAdded }: GiftItemFormProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [quantity, setQuantity] = useState<number | ''>('');
  const [unitPrice, setUnitPrice] = useState<number | ''>('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setError(null);

    try {
      const newItem = await createGiftItem(listId, {
        name,
        description: description || undefined,
        quantity: quantity === '' ? undefined : quantity,
        unitPrice: unitPrice === '' ? undefined : unitPrice,
      });
      onItemAdded(newItem);
      setName('');
      setDescription('');
      setQuantity('');
      setUnitPrice('');
    } catch (err: any) {
      setError(err.message || 'Failed to add item');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="form-stack"
    >
      {error && <div className="alert alert-error">{error}</div>}
      <div className="form-stack">
        <div className="field">
          <label className="field-label" htmlFor="item-name">Name</label>
          <input
            id="item-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            className="input"
          />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="item-desc">Description (optional)</label>
          <textarea
            id="item-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="textarea"
          />
        </div>
        <div className="form-row">
          <div className="field field-fixed">
            <label className="field-label" htmlFor="item-qty">Quantity (optional)</label>
            <NumberStepper
              id="item-qty"
              value={quantity}
              onChange={setQuantity}
              min={1}
              step={1}
            />
          </div>
          <div className="field field-fill">
            <label className="field-label" htmlFor="item-price">Price (optional)</label>
            <input
              id="item-price"
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              placeholder="0.00"
              value={unitPrice}
              onChange={(e) => setUnitPrice(e.target.value === '' ? '' : Number(e.target.value))}
              className="input no-spinner"
            />
          </div>
        </div>
        <button type="submit" className="btn btn-primary" disabled={isSubmitting}>
          {isSubmitting ? 'Adding...' : 'Add Item'}
        </button>
      </div>
    </form>
  );
}

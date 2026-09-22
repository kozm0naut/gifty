import React, { useState } from 'react';
import * as api from '../services/api';

interface RenameListFormProps {
  listId: string;
  initialTitle: string;
  initialDescription: string;
  onRenamed: (list: api.DashboardList) => void;
}

export function RenameListForm({
  listId,
  initialTitle,
  initialDescription,
  onRenamed,
}: RenameListFormProps) {
  const [title, setTitle] = useState(initialTitle);
  const [description, setDescription] = useState(initialDescription);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setError(null);

    try {
      const updated = await api.updateList(listId, {
        title,
        description: description || undefined,
      });
      onRenamed(updated);
    } catch (err: any) {
      setError(err.message || 'Failed to update list');
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
      <div className="field">
        <label className="field-label" htmlFor="rename-title">
          Title
        </label>
        <input
          id="rename-title"
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
          className="input"
        />
      </div>
      <div className="field">
        <label className="field-label" htmlFor="rename-desc">
          Description (optional)
        </label>
        <input
          id="rename-desc"
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="input"
        />
      </div>
      <button type="submit" className="btn btn-primary btn-block" disabled={isSubmitting}>
        {isSubmitting ? 'Saving...' : 'Save Changes'}
      </button>
    </form>
  );
}

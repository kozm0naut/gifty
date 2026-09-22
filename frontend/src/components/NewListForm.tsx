import React, { useState } from 'react';
import * as api from '../services/api';

interface NewListFormProps {
  onListCreated: (list: api.DashboardList) => void;
}

export function NewListForm({ onListCreated }: NewListFormProps) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setError(null);

    try {
      const newList = await api.createList({
        title,
        description: description || undefined,
      });
      onListCreated(newList);
      setTitle('');
      setDescription('');
    } catch (err: any) {
      setError(err.message || 'Failed to create list');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="form-stack">
      {error && <div className="alert alert-error">{error}</div>}
      <div className="field">
        <label className="field-label" htmlFor="list-title">Title</label>
        <input
          id="list-title"
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
          className="input"
        />
      </div>
      <div className="field">
        <label className="field-label" htmlFor="list-desc">Description (optional)</label>
        <input
          id="list-desc"
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="input"
        />
      </div>
      <button type="submit" className="btn btn-primary btn-block" disabled={isSubmitting}>
        {isSubmitting ? 'Creating...' : 'Create List'}
      </button>
    </form>
  );
}

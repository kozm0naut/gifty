import React from 'react';

interface LoadingSpinnerProps {
  /** Accessible label announced to screen readers. Defaults to "Loading". */
  label?: string;
  /** Extra className applied to the wrapper (e.g. a centering modifier). */
  className?: string;
}

/**
 * Small, centered loading indicator.
 *
 * Accessibility: the wrapper is a `role="status"` live region, so assistive
 * tech announces the (visually hidden) label when it appears. The rotating
 * ring is purely decorative and hidden from the accessibility tree. Motion is
 * disabled under `prefers-reduced-motion` (see index.css) while the static arc
 * and the announced label still convey "loading".
 */
export function LoadingSpinner({ label = 'Loading', className }: LoadingSpinnerProps) {
  return (
    <div
      className={className ? `loading-spinner ${className}` : 'loading-spinner'}
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <span className="loading-spinner__ring" aria-hidden="true" />
      <span className="sr-only">{label}…</span>
    </div>
  );
}

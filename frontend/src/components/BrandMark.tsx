interface BrandMarkProps {
  className?: string;
}

/**
 * Isometric, minimal gift box built from 8 rhomboid pieces.
 * The ribbon is negative space — the gaps between the pieces let whatever
 * sits behind the mark (header glass, page background) show through.
 *
 *   4 top pieces  (split by a crossing ribbon)
 *   2 left pieces (split by the ribbon running down the left face)
 *   2 right pieces (split by the ribbon running down the right face)
 */
export function BrandMark({ className }: BrandMarkProps) {
  return (
    <svg className={className} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      {/* ---- Top face (4 pieces) ---- */}
      <polygon points="6,11.5 10,9.3 14,11.5 10,13.7" fill="#e879f9" />
      <polygon points="12,8.2 16,6 20,8.2 16,10.4" fill="#e879f9" />
      <polygon points="12,14.8 16,12.6 20,14.8 16,17" fill="#e879f9" />
      <polygon points="18,11.5 22,9.3 26,11.5 22,13.7" fill="#e879f9" />

      {/* ---- Left face (2 pieces) ---- */}
      <polygon points="6,11.5 10,13.7 10,23.7 6,21.5" fill="#a855f7" />
      <polygon points="12,14.8 16,17 16,27 12,24.8" fill="#a855f7" />

      {/* ---- Right face (2 pieces) ---- */}
      <polygon points="16,17 20,14.8 20,24.8 16,27" fill="#7c3aed" />
      <polygon points="22,13.7 26,11.5 26,21.5 22,23.7" fill="#7c3aed" />
    </svg>
  );
}

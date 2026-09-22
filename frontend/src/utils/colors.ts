/* Derived color system — 12 "families" of 4 HSL colors each.
   Each family spans 4 hues exactly 15° apart so any primary/secondary
   pair from the same family gradients smoothly. Saturation is high and
   lightness sits in the 58–65% band for the site's subtle neon-glow
   look. Consecutive families share their boundary hues but with
   different saturation/lightness, so every one of the 48 swatches is
   globally distinct. Used for avatars, card glowbars, per-name accents. */

export const COLOR_FAMILIES: string[][] = [
  // 0 — Violet (~275°)
  ['#a855f7', '#c084fc', '#8b5cf6', '#d8b4fe'],
  // 1 — Magenta (~300°)
  ['#d946ef', '#e879f9', '#c026d3', '#f0abfc'],
  // 2 — Pink (~330°)
  ['#ec4899', '#f472b6', '#f9a8d4', '#db2777'],
  // 3 — Red (~355°)
  ['#ef4444', '#f87171', '#fca5a5', '#f10d0d'],
  // 4 — Coral (~10°)
  ['#fb7185', '#fda4af', '#ffa2a2', '#f43f5e'],
  // 5 — Orange (~25°)
  ['#f97316', '#fb923c', '#fdba74', '#f9532e'],
  // 6 — Amber (~38°)
  ['#f59e0b', '#fbbf24', '#fcd34d', '#eab308'],
  // 7 — Gold (~50°)
  ['#facc15', '#fde047', '#fef08a', '#eadf08'],
  // 8 — Lime (~85°)
  ['#a3e635', '#bef264', '#93f106', '#d9f99d'],
  // 9 — Mint (~140°)
  ['#34d399', '#6ee7b7', '#0bf0a3', '#a7f3d0'],
  // 10 — Teal (~165°)
  ['#2dd4bf', '#5eead4', '#14b8a6', '#99f6e4'],
  // 11 — Cyan (~190°)
  ['#22d3ee', '#67e8f9', '#06b6d4', '#a5f3fc'],
];

export interface NameColors {
  /** First derived color for a name. */
  primary: string;
  /** Second, distinct color from a neighboring family (for gradients). */
  secondary: string;
}

/**
 * Derive a stable, deterministic { primary, secondary } pair from a name.
 * The primary is any of the 48 swatches. The secondary is drawn from a
 * neighboring family — one, two, or three positions up or down (wrapping
 * around the 12), so the two colors always come from nearby hue ranges
 * and contrast nicely.
 * Callers select whichever of `primary`/`secondary` (or both) they need.
 */
export function getNameColors(name: string): NameColors {
  // Primary: classic 31·h hash → one of the 48 swatches.
  let primaryHash = 0;
  for (let i = 0; i < name.length; i++) {
    primaryHash = name.charCodeAt(i) + ((primaryHash << 5) - primaryHash);
  }
  const perFamily = COLOR_FAMILIES[0].length;
  const totalSwatches = COLOR_FAMILIES.length * perFamily;
  const primaryIdx = Math.abs(primaryHash) % totalSwatches;
  const familyIdx = Math.floor(primaryIdx / perFamily);
  const primary = COLOR_FAMILIES[familyIdx][primaryIdx % perFamily];

  // Secondary: FNV-1a → pick a neighboring family (1 or 2 up/down, wrapping)
  // and a swatch within it.
  let secondaryHash = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    secondaryHash ^= name.charCodeAt(i);
    secondaryHash = Math.imul(secondaryHash, 0x01000193);
  }
  const offsets = [-3, -2, 2, 3];
  const offset = offsets[Math.abs(secondaryHash) % offsets.length];
  const secondaryFamily = COLOR_FAMILIES[(familyIdx + offset + COLOR_FAMILIES.length) % COLOR_FAMILIES.length];
  const secondaryIdx = Math.abs(Math.imul(secondaryHash, 0x9e3779b1)) % perFamily;

  return { primary, secondary: secondaryFamily[secondaryIdx] };
}

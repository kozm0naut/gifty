/* Derived color system — 12 "families" of 4 HSL colors each.
   Each family spans 4 hues exactly 15° apart so any primary/secondary
   pair from the same family gradients smoothly. Within a family the 4
   swatches are ordered darkest → lightest by HSL lightness, so the first
   half is the darker end (used for dark-mode avatars). Consecutive
   families share their boundary hues but with different
   saturation/lightness, so every one of the 48 swatches is globally
   distinct. Used for avatars, card glowbars, per-name accents. */

export const COLOR_FAMILIES: string[][] = [
  // 0 — Violet (~275°)
  ['#a855f7', '#8b5cf6', '#c084fc', '#d8b4fe'],
  // 1 — Magenta (~300°)
  ['#c026d3', '#d946ef', '#e879f9', '#f0abfc'],
  // 2 — Pink (~330°)
  ['#db2777', '#ec4899', '#f472b6', '#f9a8d4'],
  // 3 — Red (~355°)
  ['#f10d0d', '#ef4444', '#f87171', '#fca5a5'],
  // 4 — Coral (~10°)
  ['#f43f5e', '#fb7185', '#fda4af', '#ffa2a2'],
  // 5 — Orange (~25°)
  ['#f97316', '#f9532e', '#fb923c', '#fdba74'],
  // 6 — Amber (~38°)
  ['#eab308', '#f59e0b', '#fbbf24', '#fcd34d'],
  // 7 — Gold (~50°)
  ['#eadf08', '#facc15', '#fde047', '#fef08a'],
  // 8 — Lime (~85°)
  ['#93f106', '#a3e635', '#bef264', '#d9f99d'],
  // 9 — Mint (~140°)
  ['#0bf0a3', '#34d399', '#6ee7b7', '#a7f3d0'],
  // 10 — Teal (~165°)
  ['#14b8a6', '#2dd4bf', '#5eead4', '#99f6e4'],
  // 11 — Cyan (~190°)
  ['#06b6d4', '#22d3ee', '#67e8f9', '#a5f3fc'],
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
 *
 * Pass `isDark` to constrain the primary to the darker half of its family
 * (families are ordered darkest → lightest) — used for avatars so initials
 * always sit on a deep-enough background.
 */
export function getNameColors(name: string, isDark = false): NameColors {
  // Primary: classic 31·h hash → one of the 48 swatches.
  let primaryHash = 0;
  for (let i = 0; i < name.length; i++) {
    primaryHash = name.charCodeAt(i) + ((primaryHash << 5) - primaryHash);
  }
  const perFamily = COLOR_FAMILIES[0].length;
  const totalSwatches = COLOR_FAMILIES.length * perFamily;
  const primaryIdx = Math.abs(primaryHash) % totalSwatches;
  const familyIdx = Math.floor(primaryIdx / perFamily);
  // When isDark, keep the primary within the darker half of the family.
  const darkHalf = perFamily >> 1;
  const swatchIdx = isDark ? Math.abs(primaryHash) % darkHalf : primaryIdx % perFamily;
  const primary = COLOR_FAMILIES[familyIdx][swatchIdx];

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

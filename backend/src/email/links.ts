/**
 * Link builders for the email-integration feature (research D9).
 *
 * Links are built from `GIFTY_PUBLIC_ORIGIN` (the public base URL). When the
 * operator has not set it, the origin falls back to the app's default public
 * origin (the Docker deployment's `http://localhost:8080`) so local dev still
 * produces a working link — the spec's "request origin" fallback is approximated
 * by a fixed default because the link is rendered *out of band* (in the outbox
 * row), not within a request that has a live origin.
 *
 *   - `buildConfirmationLink(token)` → `{origin}/confirm?token=<raw>` (D4)
 *   - `buildInviteLink()`            → `{origin}/`  (home page; no token, no
 *     deep link — FR-013)
 */

import { loadConfig } from '../config/index.js';

function origin(): string {
  // `email.publicOrigin` is already normalized (trailing slash stripped, a
  // sensible default applied) by `loadConfig()` (T008).
  return loadConfig().email.publicOrigin;
}

/** The single-use confirmation link: `{origin}/confirm?token=<raw>`. */
export function buildConfirmationLink(token: string): string {
  // The token is opaque base64url (256-bit random) — URL-safe by construction,
  // but encode defensively in case a future token format is not.
  return `${origin()}/confirm?token=${encodeURIComponent(token)}`;
}

/** The invite link: the app home page, `{origin}/` (no token, no deep link). */
export function buildInviteLink(): string {
  return `${origin()}/`;
}

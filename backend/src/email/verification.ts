/**
 * Verification-token logic for the email-integration feature (research D4, D7).
 *
 * - 256-bit random tokens (`crypto.randomBytes(32)`) — high-entropy, not
 *   guessable (004 FR-010).
 * - Only the SHA-256 **hash** is persisted to `User.verificationTokenHash`;
 *   the raw token is returned once (to embed in the link) and never stored.
 * - Single use + 24 h TTL (004 FR-010). `consumeToken` is atomic via the
 *   unique `verificationTokenHash` column + an expiry check.
 * - Every failure mode (not found, expired, already used) is indistinguishable
 *   (004 FR-010): `consumeToken` returns a bare boolean with no reason codes.
 */

import { randomBytes, createHash } from 'crypto';
import { prisma } from '../prisma.js';
import { loadConfig } from '../config/index.js';

/** Generate a 256-bit opaque, URL-safe random token. */
export function generateVerificationToken(): string {
  return randomBytes(32).toString('base64url');
}

/** SHA-256 hex digest of a raw token (the value that is persisted). */
export function hashToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/**
 * Issue a new verification token for an unverified account. Returns the **raw**
 * token (to embed in the confirmation link). The SHA-256 hash, the expiry
 * (now + TTL), and the issue time are persisted; the raw token is not.
 *
 * Re-issuing (resend) replaces any prior unverified token — the new hash
 * overwrites the old, invalidating it (004 FR-010).
 */
export async function issueToken(userId: string): Promise<string> {
  const ttlHours = loadConfig().email.tokenTtlHours;
  const raw = generateVerificationToken();
  const hash = hashToken(raw);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlHours * 60 * 60 * 1000);

  await prisma.user.update({
    where: { id: userId },
    data: {
      verificationTokenHash: hash,
      verificationExpiresAt: expiresAt,
      verificationCreatedAt: now,
    },
  });

  return raw;
}

/**
 * Consume a raw verification token. On success the account is marked verified
 * (single use — the stored hash is cleared). Returns `true` iff the token was
 * valid and unexpired. All failure modes are indistinguishable (004 FR-010).
 */
export async function consumeToken(raw: string): Promise<boolean> {
  const hash = hashToken(raw);
  const now = new Date();

  const user = await prisma.user.findFirst({
    where: {
      verificationTokenHash: hash,
      verifiedAt: null,
    },
    select: { id: true, verificationExpiresAt: true },
  });

  if (!user) return false; // not found / already used / not the token holder
  if (!user.verificationExpiresAt || user.verificationExpiresAt.getTime() <= now.getTime()) {
    return false; // expired (004 FR-010)
  }

  // Single use: mark verified and invalidate the token. (The `verifiedAt: null`
  // in the WHERE clause + unique hash column make a double-consume impossible
  // for a second concurrent caller.)
  await prisma.user.update({
    where: { id: user.id },
    data: {
      verifiedAt: now,
      verificationTokenHash: null,
      verificationExpiresAt: null,
      verificationCreatedAt: null,
    },
  });

  return true;
}

/** Whether an account has a confirmed (verified) email on record. */
export async function isVerified(userId: string): Promise<boolean> {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { verifiedAt: true },
  });
  return u?.verifiedAt != null;
}

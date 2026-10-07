import { createHash, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { prisma } from '../prisma.js';
import { loadConfig } from '../config/index.js';

/**
 * Session engine for feature 003 (security hardening) — T004.
 *
 * Responsibilities:
 *   - create a session on sign-in, storing only the **SHA-256 hash** of the
 *     refresh token (003 FR-013: raw tokens are never persisted);
 *   - issue a short-lived access JWT (≤ 1 h, default 10 min) with the `sid`
 *     claim (research D3);
 *   - rotate the refresh token on every refresh, recording the previous
 *     hash for one-step-back reuse detection (003 FR-026);
 *   - enforce the 30-day session cap and immediate revocation (003 FR-007/003 FR-008).
 *
 * Concurrency: `rotateSession` uses a conditional `updateMany`
 * (where `refreshTokenHash = oldHash`) so that concurrent presentations of
 * the same token result in exactly one winner; the loser sees the hash
 * mismatch and, if the token equals `previousRefreshHash`, revokes the
 * session as a theft signal.
 */

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
}

export type SessionRefreshResult =
  | { ok: true; sessionId: string; user: SessionUser; newRefreshToken: string }
  | { ok: false; reason: 'expired' | 'revoked' | 'stale_refresh' };

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function issueAccessToken(
  userId: string,
  sessionId: string,
): string {
  const { session } = loadConfig();
  return jwt.sign(
    { sub: userId, sid: sessionId },
    process.env.JWT_SECRET ?? '',
    { expiresIn: session.accessTtlSeconds },
  );
}

export async function createSession(userId: string): Promise<{
  sessionId: string;
  refreshToken: string;
  accessToken: string;
}> {
  const { session } = loadConfig();
  const refreshToken = randomBytes(32).toString('hex');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + session.maxAgeDays * 86_400_000);

  const created = await prisma.userSession.create({
    data: {
      userId,
      refreshTokenHash: sha256(refreshToken),
      previousRefreshHash: null,
      issuedAt: now,
      lastRefreshAt: now,
      expiresAt,
    },
  });

  const accessToken = issueAccessToken(userId, created.id);
  return { sessionId: created.id, refreshToken, accessToken };
}

export async function rotateSession(
  presentedToken: string,
): Promise<SessionRefreshResult> {
  const presentedHash = sha256(presentedToken);
  const now = new Date();

  // `refreshTokenHash` is indexed, not unique — use findFirst.
  const row = await prisma.userSession.findFirst({
    where: { refreshTokenHash: presentedHash },
  });

  if (!row) {
    return { ok: false, reason: 'stale_refresh' };
  }

  if (row.revokedAt !== null) {
    return { ok: false, reason: 'revoked' };
  }

  if (row.expiresAt <= now) {
    return { ok: false, reason: 'expired' };
  }

  // One-step-back reuse detection (003 FR-026): the presented token matches the
  // *previous* hash, i.e. it has already been rotated out. Treat as a theft
  // signal — revoke the entire session family.
  if (row.previousRefreshHash === presentedHash) {
    await prisma.userSession.update({
      where: { id: row.id },
      data: { revokedAt: now },
    });
    return { ok: false, reason: 'stale_refresh' };
  }

  // Rotate: atomically swap in a new token hash; the conditional where
  // clause guarantees a single winner under concurrent use.
  const newRefreshToken = randomBytes(32).toString('hex');
  const newHash = sha256(newRefreshToken);
  const newExpiry = new Date(now.getTime() + loadConfig().session.maxAgeDays * 86_400_000);

  const { count } = await prisma.userSession.updateMany({
    where: { id: row.id, refreshTokenHash: presentedHash, revokedAt: null },
    data: {
      refreshTokenHash: newHash,
      previousRefreshHash: presentedHash,
      lastRefreshAt: now,
      expiresAt: newExpiry,
    },
  });

  if (count === 0) {
    // Another refresh beat us to it — the presented token is now stale.
    return { ok: false, reason: 'stale_refresh' };
  }

  const user = await prisma.user.findUnique({
    where: { id: row.userId },
    select: { id: true, email: true, displayName: true },
  });
  if (!user) {
    return { ok: false, reason: 'revoked' };
  }

  return {
    ok: true,
    sessionId: row.id,
    user,
    newRefreshToken,
  };
}

export async function revokeSession(sessionId: string): Promise<void> {
  await prisma.userSession.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/**
 * Resolve a `gifty_access` cookie value to a live user, or null.
 * Used by `requireAuth` (T007) and `POST /auth/logout` (T006).
 *
 * Returns null when the token is missing/invalid/expired, the user is
 * gone, or the session row is revoked/expired — in any of those cases the
 * caller must reject the request with a 401 (003 FR-008).
 */
export async function resolveSessionForAccess(
  accessToken: string | undefined,
): Promise<{ userId: string; sessionId: string } | null> {
  if (!accessToken) return null;

  let payload: jwt.JwtPayload;
  try {
    payload = jwt.verify(accessToken, process.env.JWT_SECRET ?? '') as jwt.JwtPayload;
  } catch {
    return null;
  }

  const userId = typeof payload.sub === 'string' ? payload.sub : null;
  const sessionId = typeof payload.sid === 'string' ? payload.sid : null;
  if (!userId || !sessionId) return null;

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return null;

  const row = await prisma.userSession.findUnique({
    where: { id: sessionId },
  });
  if (!row || row.userId !== userId) return null;
  if (row.revokedAt !== null) return null;
  if (row.expiresAt <= new Date()) return null;

  return { userId, sessionId };
}

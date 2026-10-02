import { createHash } from 'node:crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Unit tests for the session engine (T008). The Prisma client is mocked so
// no live database is required.
vi.mock('../../src/prisma.js', () => ({
  prisma: {
    userSession: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
  },
}));

import { prisma } from '../../src/prisma.js';
const {
  createSession,
  rotateSession,
  revokeSession,
  resolveSessionForAccess,
} = await import('../../src/auth/session.js');
const { issueAccessToken } = await import('../../src/auth/session.js');

const TEST_SECRET = 'test-secret-32-characters-long-0000';
beforeEach(() => {
  vi.resetAllMocks();
  process.env.JWT_SECRET = TEST_SECRET;
});

describe('createSession (T008)', () => {
  it('stores the SHA-256 hash of the refresh token, not the raw token', async () => {
    const sessionRow = {
      id: 'sess-1',
      userId: 'user-1',
      refreshTokenHash: 'hashed',
      previousRefreshHash: null,
      issuedAt: new Date(),
      lastRefreshAt: new Date(),
      expiresAt: new Date(),
      revokedAt: null,
    };
    (prisma.userSession.create as any).mockResolvedValue(sessionRow);

    const { sessionId, refreshToken, accessToken } = await createSession('user-1');
    expect(sessionId).toBe('sess-1');
    expect(refreshToken).toMatch(/^[a-f0-9]{64}$/);
    expect(accessToken).toBeTruthy();

    const createCall = (prisma.userSession.create as any).mock.calls[0][0];
    const { createHash } = await import('node:crypto');
    expect(createCall.data.refreshTokenHash).toBe(
      createHash('sha256').update(refreshToken).digest('hex'),
    );
    expect(createCall.data.userId).toBe('user-1');
  });

  it('sets expiresAt to issuedAt + 30 days (default session cap)', async () => {
    const now = new Date();
    (prisma.userSession.create as any).mockImplementation(({ data }: any) =>
      Promise.resolve({ id: 'sess-2', ...data }),
    );

    await createSession('user-1');
    const { data } = (prisma.userSession.create as any).mock.calls[0][0];
    const expected = now.getTime() + 30 * 86_400_000;
    expect(Math.abs(data.expiresAt.getTime() - expected)).toBeLessThan(5_000);
  });
});

describe('rotateSession (T008)', () => {
  // Hash-consistent fixtures: the stored hashes are the SHA-256 of the
  // presented token strings, exactly as the engine persists them.
  const hashOf = (token: string) =>
    createHash('sha256').update(token).digest('hex');

  const activeRow = (currentHash: string, prevHash: string | null) => ({
    id: 'sess-1',
    userId: 'user-1',
    refreshTokenHash: currentHash,
    previousRefreshHash: prevHash,
    issuedAt: new Date(Date.now() - 1000),
    lastRefreshAt: new Date(Date.now() - 1000),
    expiresAt: new Date(Date.now() + 86_400_000),
    revokedAt: null,
  });

  const user = { id: 'user-1', email: 'u@example.com', displayName: 'U' };

  it('rotates on a fresh token and records the previous hash', async () => {
    const current = hashOf('tokenA');
    (prisma.userSession.findFirst as any).mockResolvedValue(activeRow(current, null));
    (prisma.userSession.updateMany as any).mockResolvedValue({ count: 1 });
    (prisma.user.findUnique as any).mockResolvedValue(user);

    const result = await rotateSession('tokenA');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sessionId).toBe('sess-1');
      expect(result.user).toEqual(user);
      expect(result.newRefreshToken).toMatch(/^[a-f0-9]{64}$/);
    }
    const { data, where } = (prisma.userSession.updateMany as any).mock.calls[0][0];
    // The conditional where pins the presented (old) hash — single-winner guard.
    expect(where.refreshTokenHash).toBe(current);
    expect(data.previousRefreshHash).toBe(current);
    expect(data.refreshTokenHash).not.toBe(current);
  });

  it('revokes the session and reports stale_refresh on a replayed (rotated-out) token', async () => {
    // tokenA was already rotated out: current hash is tokenB's, previous is tokenA's.
    (prisma.userSession.findFirst as any).mockResolvedValue(
      activeRow(hashOf('tokenB'), hashOf('tokenA')),
    );
    (prisma.userSession.update as any).mockResolvedValue({});

    const result = await rotateSession('tokenA');
    expect(result).toEqual({ ok: false, reason: 'stale_refresh' });
    const { where, data } = (prisma.userSession.update as any).mock.calls[0][0];
    expect(where.id).toBe('sess-1');
    expect(data.revokedAt).toBeInstanceOf(Date);
  });

  it('reports expired when expiresAt is in the past', async () => {
    const expiredRow = {
      ...activeRow(hashOf('tokenA'), null),
      expiresAt: new Date(Date.now() - 1000),
    };
    (prisma.userSession.findFirst as any).mockResolvedValue(expiredRow);

    const result = await rotateSession('tokenA');
    expect(result).toEqual({ ok: false, reason: 'expired' });
  });

  it('reports revoked when revokedAt is set', async () => {
    const revokedRow = {
      ...activeRow(hashOf('tokenA'), null),
      revokedAt: new Date(),
    };
    (prisma.userSession.findFirst as any).mockResolvedValue(revokedRow);

    const result = await rotateSession('tokenA');
    expect(result).toEqual({ ok: false, reason: 'revoked' });
  });

  it('concurrent same-token use: exactly one winner; the loser sees stale_refresh', async () => {
    (prisma.userSession.findFirst as any).mockResolvedValue(
      activeRow(hashOf('tokenA'), null),
    );
    // Winner: the conditional updateMany matches (count 1).
    // Loser: it no longer matches because the hash rotated (count 0).
    const updateMany = prisma.userSession.updateMany as any;
    updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    (prisma.user.findUnique as any).mockResolvedValue(user);

    const results = await Promise.all([
      rotateSession('tokenA'),
      rotateSession('tokenA'),
    ]);

    const oks = results.map((r) => r.ok);
    expect(oks.filter(Boolean)).toHaveLength(1);
    expect(results.some((r) => (r as { ok: false }).ok === false && (r as { reason: string }).reason === 'stale_refresh')).toBe(true);
  });
});

describe('revokeSession (T008)', () => {
  it('sets revokedAt on the session row', async () => {
    (prisma.userSession.updateMany as any).mockResolvedValue({ count: 1 });
    await revokeSession('sess-1');
    const { data, where } = (prisma.userSession.updateMany as any).mock.calls[0][0];
    expect(where.id).toBe('sess-1');
    expect(where.revokedAt).toBeNull();
    expect(data.revokedAt).toBeInstanceOf(Date);
  });
});

describe('resolveSessionForAccess (T008)', () => {
  it('resolves a valid access token with a live session', async () => {
    const token = issueAccessToken('user-1', 'sess-1');
    (prisma.user.findUnique as any).mockResolvedValue({ id: 'user-1', email: 'u@example.com' });
    (prisma.userSession.findUnique as any).mockResolvedValue({
      id: 'sess-1',
      userId: 'user-1',
      revokedAt: null,
      expiresAt: new Date(Date.now() + 86_400_000),
    });

    const result = await resolveSessionForAccess(token);
    expect(result).toEqual({ userId: 'user-1', sessionId: 'sess-1' });
  });

  it('rejects a token whose session has been revoked (FR-008)', async () => {
    const token = issueAccessToken('user-1', 'sess-1');
    (prisma.user.findUnique as any).mockResolvedValue({ id: 'user-1' });
    (prisma.userSession.findUnique as any).mockResolvedValue({
      id: 'sess-1',
      userId: 'user-1',
      revokedAt: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000),
    });

    const result = await resolveSessionForAccess(token);
    expect(result).toBeNull();
  });

  it('rejects a token whose session has expired (FR-008)', async () => {
    const token = issueAccessToken('user-1', 'sess-1');
    (prisma.user.findUnique as any).mockResolvedValue({ id: 'user-1' });
    (prisma.userSession.findUnique as any).mockResolvedValue({
      id: 'sess-1',
      userId: 'user-1',
      revokedAt: null,
      expiresAt: new Date(Date.now() - 1000),
    });

    const result = await resolveSessionForAccess(token);
    expect(result).toBeNull();
  });

  it('returns null for an invalid or missing token', async () => {
    expect(await resolveSessionForAccess(undefined)).toBeNull();
    expect(await resolveSessionForAccess('garbage-token')).toBeNull();
  });
});

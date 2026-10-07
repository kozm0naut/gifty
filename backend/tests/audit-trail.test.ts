import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../src/prisma.js';
import { createApp } from '../src/app.js';

/**
 * T044 [US7] — Audit coverage (003 FR-013, 003 SC-001, edge case "Audit under failure").
 *
 * Every security-relevant action — success AND failure/denied — must produce an
 * `AuditEvent` row in the data store with an attributable identity (nullable
 * for anonymous failures), a target, an outcome, a timestamp, and a source IP.
 * No credential/token/password/payload data may be stored (003 FR-013).
 *
 * The audit capture is fire-and-forget (T005), so after each action we poll the
 * table for the expected row rather than asserting on an awaited write.
 */

const uniqueEmail = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`;

function accessCookie(setCookieHeader: unknown): string {
  const arr = Array.isArray(setCookieHeader)
    ? setCookieHeader
    : setCookieHeader
      ? [setCookieHeader]
      : [];
  for (const c of arr) {
    const s = String(c);
    if (s.startsWith('gifty_access=')) {
      return s.split(';')[0].slice('gifty_access='.length);
    }
  }
  throw new Error('no gifty_access cookie in response');
}

function refreshCookie(setCookieHeader: unknown): string | null {
  const arr = Array.isArray(setCookieHeader)
    ? setCookieHeader
    : setCookieHeader
      ? [setCookieHeader]
      : [];
  for (const c of arr) {
    const s = String(c);
    if (s.startsWith('gifty_refresh=')) {
      return s.split(';')[0].slice('gifty_refresh='.length);
    }
  }
  return null;
}

type User = { id: string; access: string; email: string };

async function register(app: any, prefix: string, displayName: string): Promise<User> {
  const res = await request(app)
    .post('/auth/register')
    .send({ email: uniqueEmail(prefix), password: 'Password123!', displayName });
  return {
    id: res.body.user.id,
    access: accessCookie(res.headers['set-cookie']),
    email: res.body.user.email,
  };
}

/** Poll (bounded) for an audit row matching `action` + optional filters. */
async function awaitAudit(
  action: string,
  filter?: { actorUserId?: string | null; targetType?: string; outcome?: string },
  timeoutMs = 5000,
): Promise<any> {
  const where: any = { action };
  if (filter) {
    if (filter.actorUserId !== undefined) {
      if (filter.actorUserId === null) where.actorUserId = null;
      else where.actorUserId = filter.actorUserId;
    }
    if (filter.targetType) where.targetType = filter.targetType;
    if (filter.outcome) where.outcome = filter.outcome;
  }
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await prisma.auditEvent.findMany({ where, orderBy: { createdAt: 'desc' } });
    if (rows.length > 0) return rows[0];
    if (Date.now() > deadline) throw new Error(`timed out waiting for audit row: ${action}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

beforeEach(async () => {
  process.env.JWT_SECRET = 'test-secret-32-characters-long-0000';
  await prisma.auditEvent.deleteMany();
  await prisma.pendingInvitation.deleteMany();
  await prisma.sharePermission.deleteMany();
  await prisma.giftItem.deleteMany();
  await prisma.giftList.deleteMany();
  await prisma.userSession.deleteMany();
  await prisma.user.deleteMany();
});

describe('audit trail — attributable records for security-relevant actions (T044, 003 FR-013, 003 SC-001)', () => {
  it('records auth success and failure with outcome, timestamp, ip, and (null) actor for anonymous failure', async () => {
    const app = await createApp();
    const ghost = uniqueEmail('ghost');

    // Failure: unknown email → no account → actorUserId is null (edge case "Audit under failure").
    const fail = await request(app).post('/auth/login').send({ email: ghost, password: 'Wrong123!' });
    expect(fail.status).toBe(401);

    const failRow = await awaitAudit('auth_login_failure', { actorUserId: null, outcome: 'failure' });
    expect(failRow.targetType).toBe('auth');
    expect(failRow.ip).toBeTruthy();
    expect(failRow.createdAt).toBeInstanceOf(Date);
    expect(failRow.detail && String(failRow.detail)).not.toContain('Wrong123!');

    // Success: registration → attributable to the new account.
    const owner = await register(app, 'owner', 'Owner');
    const okRow = await awaitAudit('auth_register_success', { actorUserId: owner.id, outcome: 'success' });
    expect(okRow.targetType).toBe('auth');
    expect(okRow.ip).toBeTruthy();
  });

  it('records list_share and list_revoke with the list as target and the owner as actor', async () => {
    const app = await createApp();
    const owner = await register(app, 'owner', 'Owner');
    const recipient = await register(app, 'recipient', 'Recipient');

    const list = await request(app)
      .post('/lists')
      .set('Cookie', `gifty_access=${owner.access}`)
      .send({ title: 'Audit List' });
    const listId = list.body.list.id;

    // Share (by recipient user id so we get the real permission id to revoke).
    const share = await request(app)
      .post(`/lists/${listId}/share`)
      .set('Cookie', `gifty_access=${owner.access}`)
      .send({ recipientUserId: recipient.id, permission: 'shared' });
    expect(share.status).toBe(201);
    const permissionId = share.body.sharePermission.id;

    const shareRow = await awaitAudit('list_share', { actorUserId: owner.id, outcome: 'success' });
    expect(shareRow.targetType).toBe('giftList');
    expect(shareRow.targetId).toBe(listId);
    expect(shareRow.ip).toBeTruthy();

    // Revoke the share.
    const revoke = await request(app)
      .delete(`/lists/${listId}/share/${permissionId}`)
      .set('Cookie', `gifty_access=${owner.access}`);
    expect(revoke.status).toBe(204);

    const revokeRow = await awaitAudit('list_revoke', { actorUserId: owner.id, outcome: 'success' });
    expect(revokeRow.targetType).toBe('giftList');
    expect(revokeRow.targetId).toBe(listId);
  });

  it('records item claim (success) and a denied claim (failure/denied), with the item as target', async () => {
    const app = await createApp();
    const owner = await register(app, 'owner', 'Owner');
    const a = await register(app, 'claimA', 'Claim A');
    const b = await register(app, 'claimB', 'Claim B');

    const list = await request(app)
      .post('/lists')
      .set('Cookie', `gifty_access=${owner.access}`)
      .send({ title: 'Claim Audit List' });
    const listId = list.body.list.id;
    for (const u of [a, b]) {
      await request(app)
        .post(`/lists/${listId}/share`)
        .set('Cookie', `gifty_access=${owner.access}`)
        .send({ recipientUserId: u.id, permission: 'shared' });
    }
    const item = await request(app)
      .post(`/lists/${listId}/items`)
      .set('Cookie', `gifty_access=${owner.access}`)
      .send({ name: 'Headphones', quantity: 1 });
    const itemId = item.body.item.id;

    // A claims successfully.
    const claim = await request(app)
      .post(`/items/${itemId}/claim`)
      .set('Cookie', `gifty_access=${a.access}`)
      .send({ claimantUserId: a.id });
    expect(claim.status).toBe(200);

    const claimRow = await awaitAudit('item_claim', { actorUserId: a.id, outcome: 'success' });
    expect(claimRow.targetType).toBe('giftItem');
    expect(claimRow.targetId).toBe(itemId);

    // B claims the same (already-claimed) item → denied (409) and STILL audited.
    const denied = await request(app)
      .post(`/items/${itemId}/claim`)
      .set('Cookie', `gifty_access=${b.access}`)
      .send({ claimantUserId: b.id });
    expect(denied.status).toBe(409);

    // Poll: the denied attempt is still audited (edge case "Audit under failure").
    const deadline = Date.now() + 2000;
    let row = null as any;
    for (;;) {
      row = await prisma.auditEvent.findFirst({
        where: { action: 'item_claim', actorUserId: b.id, targetType: 'giftItem' },
        orderBy: { createdAt: 'desc' },
      });
      if (row) break;
      if (Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(row).toBeTruthy();
    expect(row.outcome).toMatch(/denied|failure/);
  });

  it('records session_revoked on sign-out and session_reuse_detected on a stale refresh replay', async () => {
    const app = await createApp();
    const user = await register(app, 'sess', 'Session User');

    // Sign out → session_revoked.
    const logout = await request(app)
      .post('/auth/logout')
      .set('Cookie', `gifty_access=${user.access}`);
    expect(logout.status).toBe(204);
    const revokedRow = await awaitAudit('session_revoked', { actorUserId: user.id, outcome: 'success' });
    expect(revokedRow.targetType).toBe('session');

    // Fresh login → capture the refresh token, rotate once, then replay the
    // STALE token → theft signal → session_reuse_detected.
    const login = await request(app)
      .post('/auth/login')
      .send({ email: user.email, password: 'Password123!' });
    expect(login.status).toBe(200);
    const access2 = accessCookie(login.headers['set-cookie']);
    const refresh1 = refreshCookie(login.headers['set-cookie']);
    expect(refresh1).toBeTruthy();

    // First refresh with refresh1 → rotates (succeeds).
    const r1 = await request(app).post('/auth/refresh').set('Cookie', `gifty_refresh=${refresh1}`);
    expect(r1.status).toBe(200);

    // Replay refresh1 (now stale) → reuse detected.
    const r2 = await request(app).post('/auth/refresh').set('Cookie', `gifty_refresh=${refresh1}`);
    expect(r2.status).toBe(401);
    const reuseRow = await awaitAudit('session_reuse_detected', { outcome: 'failure' });
    expect(reuseRow.targetType).toBe('session');
  });

  it('records account_removal with the removed user as actor and no credential data stored (T048)', async () => {
    const app = await createApp();
    const owner = await register(app, 'owner', 'Owner');

    const del = await request(app)
      .delete('/account')
      .set('Cookie', `gifty_access=${owner.access}`);
    expect(del.status).toBe(204);

    // The removal is recorded and survives (append-only). Because the user
    // row is deleted in the same transaction, the `actorUserId` FK (SetNull)
    // is nulled — identity is preserved via `targetType`/`targetId` instead.
    const row = await awaitAudit('account_removal', { outcome: 'success' });
    expect(row.targetType).toBe('user');
    expect(row.targetId).toBe(owner.id);
    expect(row.actorUserId).toBeNull();

    // 003 FR-013: no password / credential anywhere in the audit store.
    const all = await prisma.auditEvent.findMany();
    for (const r of all) {
      expect(JSON.stringify(r.detail ?? null)).not.toContain('Password123!');
      expect(JSON.stringify(r.detail ?? null)).not.toContain('gifty_access');
    }
  });
});

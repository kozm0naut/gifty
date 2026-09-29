import { describe, it, expect, vi, beforeEach } from 'vitest';

// Unit tests for the audit capture module (T009). Prisma is mocked so no
// live database is required.
vi.mock('../../src/prisma.js', () => ({
  prisma: {
    auditEvent: {
      create: vi.fn(),
    },
  },
}));

import { prisma } from '../../src/prisma.js';
const { recordAuditEvent, AUDIT_ACTIONS } = await import('../../src/audit/events.js');

beforeEach(() => {
  vi.resetAllMocks();
});

describe('recordAuditEvent (T009)', () => {
  it('is fire-and-forget: never rejects the caller even when the insert fails', async () => {
    (prisma.auditEvent.create as any).mockRejectedValue(new Error('db down'));

    // Must not throw / reject into the request path (FR-013).
    await expect(
      recordAuditEvent({
        action: 'auth_login_failure',
        outcome: 'failure',
        actorUserId: 'user-1',
      }),
    ).resolves.toBeUndefined();
  });

  it('writes an AuditEvent row with the provided fields', async () => {
    (prisma.auditEvent.create as any).mockResolvedValue({ id: 'audit-1' });

    await recordAuditEvent({
      actorUserId: 'user-1',
      action: 'list_share',
      targetType: 'gift_list',
      targetId: 'list-1',
      outcome: 'success',
      ip: '203.0.113.5',
      detail: { email: 'invitee@example.com' },
    });

    const { data } = (prisma.auditEvent.create as any).mock.calls[0][0];
    expect(data.actorUserId).toBe('user-1');
    expect(data.action).toBe('list_share');
    expect(data.targetType).toBe('gift_list');
    expect(data.targetId).toBe('list-1');
    expect(data.outcome).toBe('success');
    expect(data.ip).toBe('203.0.113.5');
    expect(data.detail).toEqual({ email: 'invitee@example.com' });
  });

  it('scrubs sensitive keys (password, token, secret, credential) from detail', async () => {
    (prisma.auditEvent.create as any).mockResolvedValue({ id: 'audit-2' });

    await recordAuditEvent({
      action: 'auth_login_failure',
      outcome: 'failure',
      detail: {
        email: 'u@example.com',
        password: 'hunter2',
        token: 'abc',
        secret: 'xyz',
        credential: 'cred',
        nested: { passwordHash: 'h', api_key: 'k', safe: 'ok' },
        list: [{ access_token: 't', safe: 'ok' }],
      },
    });

    const { data } = (prisma.auditEvent.create as any).mock.calls[0][0];
    expect(data.detail.email).toBe('u@example.com');
    expect(data.detail).not.toHaveProperty('password');
    expect(data.detail).not.toHaveProperty('token');
    expect(data.detail).not.toHaveProperty('secret');
    expect(data.detail).not.toHaveProperty('credential');
    expect(data.detail.nested).toEqual({ safe: 'ok' });
    expect(data.detail.list).toEqual([{ safe: 'ok' }]);
  });

  it('accepts every action value in the audit action set', async () => {
    (prisma.auditEvent.create as any).mockResolvedValue({ id: 'audit-3' });

    // 13 actions from the original security-hardening baseline (data-model.md)
    // plus the two US5 (consent) actions: `consent_updated` and
    // `invitation_matched`. Both are security-relevant, so FR-013 requires a
    // recordable audit action for each.
    expect(AUDIT_ACTIONS).toHaveLength(15);
    expect(AUDIT_ACTIONS).toContain('consent_updated');
    expect(AUDIT_ACTIONS).toContain('invitation_matched');
    for (const action of AUDIT_ACTIONS) {
      (prisma.auditEvent.create as any).mockClear();
      await recordAuditEvent({ action, outcome: 'success' });
      const { data } = (prisma.auditEvent.create as any).mock.calls[0][0];
      expect(data.action).toBe(action);
    }
  });

  it('accepts failed/denied outcomes (audit under failure — edge case)', async () => {
    (prisma.auditEvent.create as any).mockResolvedValue({ id: 'audit-4' });
    for (const outcome of ['success', 'denied', 'failure'] as const) {
      (prisma.auditEvent.create as any).mockClear();
      await recordAuditEvent({
        action: 'auth_login_failure',
        outcome,
        actorUserId: null,
      });
      const { data } = (prisma.auditEvent.create as any).mock.calls[0][0];
      expect(data.outcome).toBe(outcome);
    }
  });

  it('supports a null actor (failed/denied attempts have no account)', async () => {
    (prisma.auditEvent.create as any).mockResolvedValue({ id: 'audit-5' });
    await recordAuditEvent({
      action: 'auth_login_failure',
      outcome: 'failure',
      actorUserId: null,
    });
    const { data } = (prisma.auditEvent.create as any).mock.calls[0][0];
    expect(data.actorUserId).toBeNull();
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// Walk a directory tree, yielding every JS/TS source file (used by the
// append-only audit assertions in the FR-013 block below).
function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) yield* walk(p);
    else if (/\.[cm]?tsx?$/.test(entry)) yield p;
  }
}

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
    // recordable audit action for each. Feature 004 (email integration) adds
    // four more (D7): `email_invite_queued`, `email_confirmation_queued`,
    // `email_delivered`, `email_failed` — so the vocabulary is 19.
    expect(AUDIT_ACTIONS).toHaveLength(19);
    expect(AUDIT_ACTIONS).toContain('consent_updated');
    expect(AUDIT_ACTIONS).toContain('invitation_matched');
    expect(AUDIT_ACTIONS).toContain('email_invite_queued');
    expect(AUDIT_ACTIONS).toContain('email_confirmation_queued');
    expect(AUDIT_ACTIONS).toContain('email_delivered');
    expect(AUDIT_ACTIONS).toContain('email_failed');
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

describe('FR-013 append-only audit trail (T064)', () => {
  it('AuditEvent schema is append-only: createdAt present, no updatedAt', () => {
    const schema = readFileSync(
      join(here, '../../prisma/schema.prisma'),
      'utf8',
    );
    // Isolate the AuditEvent model block (from its header to the closing
    // brace at column 0). The split is line-ending-agnostic so it works
    // whether the file uses LF or CRLF.
    const model = schema
      .split('model AuditEvent {')[1]
      .split(/\r?\n}\r?\n/)[0];

    expect(model).toMatch(/createdAt\s+DateTime\s+@default\(now\(\)\)/);
    expect(model).not.toMatch(/updatedAt/);
  });

  it('no backend source mutates or deletes audit rows', () => {
    const srcDir = join(here, '../../src');
    for (const file of walk(srcDir)) {
      const code = readFileSync(file, 'utf8');
      // The audit capture module itself must never call a mutating API.
      expect(code, file).not.toMatch(/prisma\.auditEvent\s*\.\s*(update|updateMany|delete|deleteMany|upsert)\b/);
    }
  });

  it('no route handler is registered against the audit log', () => {
    const appCode = readFileSync(join(here, '../../src/app.ts'), 'utf8');
    expect(appCode).not.toMatch(/audit/i);
  });
});

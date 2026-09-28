import { Prisma } from '@prisma/client';
import { prisma } from '../prisma.js';

/**
 * Audit capture module for feature 003 (security hardening) — T005.
 *
 * - Fire-and-forget: `recordAuditEvent` never rejects into the request
 *   path (FR-013). Insert failures are logged, not thrown.
 * - Sensitive data: any key matching a credential-like pattern is scrubbed
 *   from `detail` before persistence (FR-013).
 * - Append-only: there is no update or delete path — the application never
 *   prunes audit rows (5-year retention, FR-013).
 */

export const AUDIT_ACTIONS = [
  'auth_login_success',
  'auth_login_failure',
  'auth_register_success',
  'auth_register_failure',
  'auth_rate_limited',
  'list_share',
  'list_revoke',
  'item_claim',
  'item_purchase',
  'item_revert',
  'account_removal',
  'session_revoked',
  'session_reuse_detected',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];
export type AuditOutcome = 'success' | 'denied' | 'failure';

const SENSITIVE_KEY_PATTERN =
  /password|passwd|secret|token|credential|authorization|api[_-]?key|refresh[_-]?token|access[_-]?token|jwt|private[_-]?key/i;

function scrub(value: unknown, depth = 0): unknown {
  if (depth > 8) return null;
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((v) => scrub(v, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_PATTERN.test(k)) continue;
      out[k] = scrub(v, depth + 1);
    }
    return out;
  }
  return value;
}

export interface AuditEventInput {
  actorUserId?: string | null;
  action: AuditAction;
  targetType?: string | null;
  targetId?: string | null;
  outcome: AuditOutcome;
  ip?: string | null;
  detail?: Record<string, unknown> | null;
}

/**
 * Record a security-relevant audit event. Fire-and-forget: the returned
 * promise resolves (never rejects) regardless of whether the underlying
 * insert succeeded. Callers MUST NOT await this in a way that blocks the
 * request path (FR-013).
 */
export function recordAuditEvent(input: AuditEventInput): Promise<void> {
  const detail = input.detail ? scrub(input.detail) : null;
  return prisma.auditEvent
    .create({
      data: {
        actorUserId: input.actorUserId ?? null,
        action: input.action,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        outcome: input.outcome,
        ip: input.ip ?? null,
        detail: (detail as any) ?? Prisma.JsonNull,
      },
    })
    .then(() => undefined)
    .catch((err: unknown) => {
      console.error(
        `[audit] failed to record ${input.action}:`,
        err instanceof Error ? err.message : String(err),
      );
    });
}

/**
 * Outbox enqueue + drainer for the email-integration feature (research D3, D8,
 * D11).
 *
 * Enqueue (synchronous, in the caller's transaction):
 *   - `enqueueInvite`      — `@@unique([listId, recipientEmail])`; a duplicate
 *     (P2002) is a **no-op** (FR-012).
 *   - `enqueueConfirmation`— `listId` NULL → unique not enforced → one per
 *     (re)send (FR-011).
 *   - Neither is enqueued in the disabled mode (FR-016) — callers guard.
 *
 * Drainer (in-process, research D8): every `drainIntervalMs`, select
 * due `queued` rows (FOR UPDATE SKIP LOCKED via an atomic status flip), send
 * through the resolved `Mailer`, and record `sent` / `failed` with the
 * attempt count + a scrubbed `lastError`. Backoff is `retryBaseMs * 2^attempt`.
 * Stale `sending` rows (a crashed sender) are reclaimed to `queued`.
 *
 * Audit (T009): `email_delivered` / `email_failed` are recorded here; the
 * `email_invite_queued` / `email_confirmation_queued` actions are recorded by
 * the Phase-3 callers (the request path knows the actor/ip).
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../prisma.js';
import { loadConfig } from '../config/index.js';
import { getMailer, OutboundMeta } from './mailer.js';
import { recordAuditEvent } from '../audit/events.js';

export interface EnqueueResult {
  /** The outbox row id (always present — a duplicate invite is a no-op that
   *  returns the *existing* row id). */
  outboxMessageId: string;
  /** Whether a NEW row was inserted (false → the unique constraint matched an
   *  existing (list, recipient) invite and this was a no-op, FR-012). */
  inserted: boolean;
}

/**
 * Enqueue an invite email for a (list, recipient) pair. A duplicate is a
 * **no-op** (FR-012): the unique constraint rejects it (P2002) and we resolve
 * to the existing row. Never rejects on the duplicate path.
 */
export async function enqueueInvite(
  tx: Prisma.TransactionClient,
  input: { listId: string; recipientEmail: string; subject: string; bodyText: string; bodyHtml?: string },
): Promise<EnqueueResult> {
  try {
    const row = await tx.outboxMessage.create({
      data: {
        kind: 'invite',
        listId: input.listId,
        recipientEmail: input.recipientEmail,
        subject: input.subject,
        bodyText: input.bodyText,
        bodyHtml: input.bodyHtml ?? null,
      },
      select: { id: true },
    });
    return { outboxMessageId: row.id, inserted: true };
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === 'P2002') {
      // Duplicate (list, recipient) — no-op (FR-012). Resolve to the existing
      // row so callers can report a stable id.
      const existing = await tx.outboxMessage.findUnique({
        where: { listId_recipientEmail: { listId: input.listId, recipientEmail: input.recipientEmail } },
        select: { id: true },
      });
      return { outboxMessageId: existing?.id ?? '', inserted: false };
    }
    throw err;
  }
}

/**
 * Enqueue a confirmation email. `listId` is NULL, so the unique constraint does
 * not apply and each (re)send produces a new row (FR-011).
 *
 * Re-issuing supersedes any prior queued/sending confirmation for the same
 * user: the old token is invalid (the new hash overwrites it), so delivering
 * that email would be misleading — mark it `superseded` (terminal) and skip.
 */
export async function enqueueConfirmation(
  tx: Prisma.TransactionClient,
  input: { userId: string; recipientEmail: string; subject: string; bodyText: string; bodyHtml?: string },
): Promise<EnqueueResult> {
  await tx.outboxMessage.updateMany({
    where: {
      kind: 'confirmation',
      userId: input.userId,
      status: { in: ['queued', 'sending'] },
    },
    data: { status: 'superseded', supersededAt: new Date() },
  });
  const row = await tx.outboxMessage.create({
    data: {
      kind: 'confirmation',
      userId: input.userId,
      listId: null,
      recipientEmail: input.recipientEmail,
      subject: input.subject,
      bodyText: input.bodyText,
      bodyHtml: input.bodyHtml ?? null,
    },
    select: { id: true },
  });
  return { outboxMessageId: row.id, inserted: true };
}

/** Extract a stable, scrubbed error class from a mailer failure (never a key). */
function scrubbedError(err: unknown): string {
  const providerError = (err as { providerError?: string })?.providerError;
  if (providerError) return providerError;
  return 'send_failed';
}

/**
 * One drain cycle: select due `queued` rows, atomically flip each to
 * `sending`, send, and record the terminal/retry state. Returns the count of
 * messages processed. A per-row failure never aborts the cycle.
 */
export async function drainOnce(): Promise<number> {
  const { email } = loadConfig();
  const now = new Date();
  let processed = 0;

  for (;;) {
    // Claim a batch of due rows. We flip them to `sending` one at a time so a
    // concurrent drainer (or a manual drain) cannot double-send the same row:
    // the status update is guarded by the current `queued` state.
    const due = await prisma.outboxMessage.findMany({
      where: { status: 'queued', nextAttemptAt: { lte: now } },
      orderBy: { nextAttemptAt: 'asc' },
      take: email.drainBatch,
      select: { id: true },
    });
    if (due.length === 0) break;

    for (const { id } of due) {
      // Atomic claim: only succeeds if the row is still `queued`.
      const claimed = await prisma.outboxMessage.updateMany({
        where: { id, status: 'queued' },
        data: { status: 'sending' },
      });
      if (claimed.count === 0) continue; // another drainer got it
      processed += 1;
      await processRow(id, email.retryBaseMs, email.maxAttempts);
    }

    // A single pass over the due set is enough for the common case; if new due
    // rows appeared while we worked, the interval will catch them next tick.
    break;
  }

  return processed;
}

async function processRow(id: string, retryBaseMs: number, maxAttempts: number): Promise<void> {
  const msg = await prisma.outboxMessage.findUniqueOrThrow({ where: { id } });
  const mailer = getMailer();
  const meta: OutboundMeta = { kind: msg.kind };

  // Re-derive the link for the capture stub's observability (the body already
  // contains it; this just surfaces it in the captured entry).
  if (msg.kind === 'confirmation') {
    // The raw token is NOT recoverable from the outbox row (only its hash is
    // on the user). The body already has the full link, so the capture stub
    // will extract it. Leave meta.link undefined.
  }

  try {
    await mailer.send(msg.recipientEmail, msg.subject, msg.bodyText, msg.bodyHtml ?? undefined, meta);
    await prisma.outboxMessage.update({
      where: { id },
      data: { status: 'sent', sentAt: new Date(), attempts: { increment: 1 } },
    });
    recordAuditEvent({
      actorUserId: msg.userId,
      action: 'email_delivered',
      targetType: 'email',
      targetId: msg.id,
      outcome: 'success',
      detail: { kind: msg.kind, to: msg.recipientEmail },
    });
  } catch (err) {
    const nextAttempts = msg.attempts + 1;
    const terminal = nextAttempts >= msg.maxAttempts;
    const errorClass = scrubbedError(err);
    if (terminal) {
      await prisma.outboxMessage.update({
        where: { id },
        data: {
          status: 'failed',
          attempts: nextAttempts,
          lastError: errorClass,
          lastAttemptAt: new Date(),
        },
      });
      recordAuditEvent({
        actorUserId: msg.userId,
        action: 'email_failed',
        targetType: 'email',
        targetId: msg.id,
        outcome: 'failure',
        detail: { kind: msg.kind, to: msg.recipientEmail, error: errorClass },
      });
    } else {
      const backoff = retryBaseMs * 2 ** (nextAttempts - 1);
      await prisma.outboxMessage.update({
        where: { id },
        data: {
          status: 'queued',
          attempts: nextAttempts,
          nextAttemptAt: new Date(Date.now() + backoff),
          lastError: errorClass,
          lastAttemptAt: new Date(),
        },
      });
    }
  }
}

/**
 * Reclaim rows stuck in `sending` (a crashed sender, a process restart) back to
 * `queued` so they are retried. Called at startup and periodically.
 */
export async function reclaimStaleSending(staleMs = 5 * 60 * 1000): Promise<number> {
  const cutoff = new Date(Date.now() - staleMs);
  const res = await prisma.outboxMessage.updateMany({
    where: { status: 'sending', lastAttemptAt: { lt: cutoff } },
    data: { status: 'queued', nextAttemptAt: new Date() },
  });
  return res.count;
}

let drainerTimer: NodeJS.Timeout | null = null;
let draining = false;
let inFlight: Promise<void> | null = null;

async function tick(): Promise<void> {
  if (draining) return; // avoid overlapping cycles
  draining = true;
  const work = (async () => {
    try {
      const { email } = loadConfig();
      if (email.mode === 'disabled') return;
      await reclaimStaleSending();
      await drainOnce();
    } catch (err) {
      console.error('[email] drainer tick failed:', err instanceof Error ? err.message : String(err));
    } finally {
      draining = false;
    }
  })();
  inFlight = work;
  try {
    await work;
  } finally {
    if (inFlight === work) inFlight = null;
  }
}

/**
 * Start the in-process drainer. No-op in the disabled mode (nothing is ever
 * enqueued there). Idempotent — a second call is ignored. The interval is
 * unref'd so it does not keep the process alive.
 */
export function startDrainer(): void {
  if (drainerTimer) return;
  if (loadConfig().email.mode === 'disabled') return;
  const interval = loadConfig().email.drainIntervalMs;
  drainerTimer = setInterval(() => {
    void tick();
  }, interval);
  (drainerTimer as { unref?: () => void }).unref?.();
}

/**
 * Stop the drainer (graceful shutdown). Idempotent. Awaits any in-flight tick
 * so no send is abandoned mid-flight on shutdown.
 */
export async function stopDrainer(): Promise<void> {
  if (drainerTimer) {
    clearInterval(drainerTimer);
    drainerTimer = null;
  }
  if (inFlight) await inFlight.catch(() => undefined);
}

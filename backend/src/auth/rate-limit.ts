/**
 * In-process rate limiter for feature 003 (security hardening) — T013.
 *
 * Enforces the two independent budgets from 003 FR-001 / research D1 at the two
 * auth entry points (`/auth/login`, `/auth/register`):
 *   - **per-source**  — keyed on the trusted-proxy client IP; defeats mass
 *     enumeration and throwaway-account creation;
 *   - **per-account** — keyed on the normalized email, **sign-in only**;
 *     defeats source-IP rotation (US1 scenario 6).
 *
 * Budgets are fixed **failure** windows (the spec says "N failures / window"):
 *   - ≤ 10 failed sign-ins   / 15 min per source
 *   - ≤ 3  failed registrations / 15 min per source (strictly tighter — the
 *     409 "already exists" response is the enumeration vector, 003 FR-020)
 *   - ≤ 5  failed sign-ins   / 15 min per account (sign-in only)
 *
 * Counters live in a per-process `Map` and reset on restart (the documented
 * single-replica deployment assumption, feature 002). Successful attempts do
 * **not** consume the budget — only failures do — so a legitimate user who
 * mistypes a few times is still protected, while a real account is not locked
 * out merely for signing in.
 *
 * The 429 body is produced by the caller and MUST be indistinguishable from a
 * failed auth attempt (003 FR-020 / 003 SC-002); this module only decides *whether*
 * to throttle and contributes a non-leaking `Retry-After` value.
 */

import type { Request } from 'express';
import { loadConfig } from '../config/index.js';

export type BudgetKind =
  | 'login-source'
  | 'register-source'
  | 'login-account'
  // Feature 004 (US2, 004 FR-014): verification-email resends, keyed per-account
  // (userId) and counted on EVERY successful send (not just failures) so a
  // legitimate user is still capped at a few per window.
  | 'resend-confirmation';

interface WindowCounter {
  /** Failures recorded in the current window. */
  count: number;
  /** Epoch-ms timestamp of the window start. */
  windowStart: number;
}

/** Per-process counter store. Reset on restart (single-replica assumption). */
const counters = new Map<string, WindowCounter>();

function budgetFor(kind: BudgetKind): number {
  const { rateLimit } = loadConfig();
  switch (kind) {
    case 'login-source':
      return rateLimit.loginPerSource;
    case 'register-source':
      return rateLimit.registerPerSource;
    case 'login-account':
      return rateLimit.loginPerAccount;
    // Feature 004 (US2): the per-account resend cap lives on the email config.
    case 'resend-confirmation':
      return loadConfig().email.resendMaxPerAccount;
  }
}

function windowMs(): number {
  return loadConfig().rateLimit.windowMinutes * 60_000;
}

function compositeKey(kind: BudgetKind, source: string): string {
  // `source` is an IP or a normalized email — neither can contain the
  // delimiter in practice, but scope it explicitly for safety.
  return `${kind}::${source}`;
}

/**
 * Fetch a counter, lazily creating it or rolling the window forward when the
 * fixed window has elapsed. Pure w.r.t. the store (mutates only the entry).
 */
function counterFor(kind: BudgetKind, source: string, now: number): WindowCounter {
  const key = compositeKey(kind, source);
  let counter = counters.get(key);
  if (!counter) {
    counter = { count: 0, windowStart: now };
    counters.set(key, counter);
  }
  if (now - counter.windowStart >= windowMs()) {
    counter.count = 0;
    counter.windowStart = now;
  }
  return counter;
}

/**
 * `true` when `source` has already consumed its `kind` budget in the current
 * window and the attempt MUST be throttled (429).
 */
export function isRateLimited(
  kind: BudgetKind,
  source: string,
  now: number = Date.now(),
): boolean {
  if (!source) return false;
  return counterFor(kind, source, now).count >= budgetFor(kind);
}

/**
 * Record a **failed** auth attempt against `source` for the given `kind`.
 * Callers invoke this only after a failure (wrong credentials / 409), never
 * for a success, so legitimate sign-ins do not erode the budget.
 */
export function recordFailure(
  kind: BudgetKind,
  source: string,
  now: number = Date.now(),
): void {
  if (!source) return;
  counterFor(kind, source, now).count += 1;
}

/**
 * A safe, non-leaking `Retry-After` value (seconds). It reflects the full
 * window rather than the specific key's remaining time so its presence and
 * magnitude never hint at *which* source/account is hot (003 SC-002).
 */
export function retryAfterSeconds(): number {
  return Math.ceil(windowMs() / 1000);
}

/**
 * The client IP used as the per-source rate-limit key (003 FR-001, research D1).
 *
 * Delegates to `req.ip`, which honors the app's Express trust-proxy setting
 * (see `createApp`): with trust proxy OFF (default, no fronting proxy) it is
 * the direct TCP peer and a client-supplied `X-Forwarded-For` is IGNORED — so
 * a client cannot rotate the per-source budget by spoofing the header; with
 * trust proxy ON (behind a trusted proxy) it is the original client from the
 * chain. `normalizeIp` strips IPv4-mapped IPv6 prefixes (`::ffff:1.2.3.4`).
 */
export function clientIp(req: Request): string {
  const ip = req.ip ?? req.socket?.remoteAddress ?? 'unknown';
  return normalizeIp(String(ip));
}

function normalizeIp(ip: string): string {
  return ip.replace(/^::ffff:/, '').trim();
}

/**
 * Test hook: clear all counters. Supertest/integration tests invoke this in
 * `beforeEach` so rate-limit state does not leak across test cases (the
 * existing ~80-test suite does not call it and stays under budget by
 * construction — see the US1 analysis in specs/003).
 */
export function __resetRateLimitersForTesting(): void {
  counters.clear();
}

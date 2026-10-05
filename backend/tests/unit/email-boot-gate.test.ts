import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { validateConfig, loadConfig } from '../../src/config/index.js';

/**
 * T002a — Email boot gate + sending-mode resolution (US6 / FR-009, SC-006,
 * FR-015, SC-010).
 *
 * The startup gate (`validateConfig()`) MUST refuse to boot in a production
 * context when email is ENABLED but no live sender (`RESEND_API_KEY`) is
 * configured — the refusal message names `RESEND_API_KEY` and the fix so an
 * operator can remediate without documentation (FR-009). Local development is
 * not blocked: an unconfigured live sender resolves to the capture stub
 * (mode b). When email is DISABLED the app boots and auto-confirms new
 * accounts (mode c, FR-015).
 *
 * These tests exercise the gate + mode resolution directly (no server / DB
 * needed) by driving `validateConfig()` / `loadConfig()` against crafted
 * `process.env` states. Written FIRST (Constitution III) — they fail until the
 * `email` config surface (T008) is implemented.
 */

const ENV_KEYS = [
  'NODE_ENV',
  'JWT_SECRET',
  'JWT_SECRET_MIN_LENGTH',
  'DATABASE_URL',
  'POSTGRES_PASSWORD',
  'CORS_ORIGINS',
  'CSP_FONT_ORIGIN',
  'RATE_LIMIT_WINDOW_MINUTES',
  'LOGIN_MAX_FAILURES_PER_SOURCE',
  'REGISTER_MAX_FAILURES_PER_SOURCE',
  'LOGIN_MAX_FAILURES_PER_ACCOUNT',
  'ACCESS_TOKEN_TTL_MINUTES',
  'SESSION_MAX_AGE_DAYS',
  'EMAIL_ENABLED',
  'EMAIL_TRANSPORT',
  'RESEND_API_KEY',
  'RESEND_FROM',
  'GIFTY_PUBLIC_ORIGIN',
  'EMAIL_MAX_ATTEMPTS',
  'EMAIL_RETRY_BASE_MS',
  'EMAIL_DRAIN_INTERVAL_MS',
  'EMAIL_DRAIN_BATCH',
  'EMAIL_TOKEN_TTL_HOURS',
  'RESEND_MAX_PER_ACCOUNT',
];

const STRONG_SECRET = 'a-very-strong-operator-supplied-secret-0123456789';
const STRONG_DB_PASSWORD = 'a-strong-db-credential-7788';
const RESEND_KEY = 're_live_a1b2c3d4e5f6g7h8i9j0';
const RESEND_FROM = 'confirm@gifty.example';

function strongDatabaseUrl(password: string): string {
  return `postgresql://gifty:${password}@localhost:5432/gifty?schema=public`;
}

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];

  // Baseline: a VALID production configuration (strong secret + non-default
  // DB credential) so the pre-existing boot gate is satisfied; individual
  // tests override the email-related values under test.
  process.env.NODE_ENV = 'production';
  process.env.JWT_SECRET = STRONG_SECRET;
  process.env.DATABASE_URL = strongDatabaseUrl(STRONG_DB_PASSWORD);
  delete process.env.POSTGRES_PASSWORD;
  delete process.env.JWT_SECRET_MIN_LENGTH;
  // Reset the rate-limit / session knobs to their built-in defaults so the
  // FR-001/FR-007 cross-checks in validateConfig() cannot interfere.
  delete process.env.RATE_LIMIT_WINDOW_MINUTES;
  delete process.env.LOGIN_MAX_FAILURES_PER_SOURCE;
  delete process.env.REGISTER_MAX_FAILURES_PER_SOURCE;
  delete process.env.LOGIN_MAX_FAILURES_PER_ACCOUNT;
  delete process.env.ACCESS_TOKEN_TTL_MINUTES;
  delete process.env.SESSION_MAX_AGE_DAYS;
  delete process.env.CORS_ORIGINS;
  delete process.env.CSP_FONT_ORIGIN;
  // Baseline email surface: disabled + no live sender (mode c) so the
  // pre-existing acceptance cases keep passing. Tests override as needed.
  process.env.EMAIL_ENABLED = 'false';
  delete process.env.EMAIL_TRANSPORT;
  delete process.env.RESEND_API_KEY;
  delete process.env.RESEND_FROM;
  delete process.env.GIFTY_PUBLIC_ORIGIN;
  delete process.env.EMAIL_MAX_ATTEMPTS;
  delete process.env.EMAIL_RETRY_BASE_MS;
  delete process.env.EMAIL_DRAIN_INTERVAL_MS;
  delete process.env.EMAIL_DRAIN_BATCH;
  delete process.env.EMAIL_TOKEN_TTL_HOURS;
  delete process.env.RESEND_MAX_PER_ACCOUNT;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('email boot gate — production + enabled + no key (FR-009 / SC-006)', () => {
  it('refuses to boot, naming RESEND_API_KEY and the remedy', () => {
    process.env.EMAIL_ENABLED = 'true';
    delete process.env.RESEND_API_KEY;
    expect(() => validateConfig()).toThrowError(/RESEND_API_KEY/);
    // The message must say what must change (FR-009).
    expect(() => validateConfig()).toThrowError(/set|configur/i);
  });

  it('refuses to boot when EMAIL_ENABLED is true (default) and no key is present', () => {
    // EMAIL_ENABLED defaults to true, so merely omitting the key must fail.
    delete process.env.EMAIL_ENABLED;
    delete process.env.RESEND_API_KEY;
    expect(() => validateConfig()).toThrowError(/RESEND_API_KEY/);
  });
});

describe('email boot gate — production + enabled + valid key (US6 scenario 2)', () => {
  it('boots with a configured live sender', () => {
    process.env.EMAIL_ENABLED = 'true';
    process.env.RESEND_API_KEY = RESEND_KEY;
    expect(() => validateConfig()).not.toThrow();
    // Mode (a): enabled + live sender.
    expect(loadConfig().email.mode).toBe('live');
  });
});

describe('email boot gate — production + disabled (FR-015 / SC-010)', () => {
  it('boots (auto-confirm mode) with no live sender', () => {
    process.env.EMAIL_ENABLED = 'false';
    delete process.env.RESEND_API_KEY;
    expect(() => validateConfig()).not.toThrow();
    // Mode (c): disabled → no emails, auto-confirm.
    expect(loadConfig().email.mode).toBe('disabled');
  });
});

describe('email boot gate — non-production (edge case: dev/test)', () => {
  it('boots with email enabled but no live key, resolving to capture mode (b)', () => {
    process.env.NODE_ENV = 'development';
    process.env.JWT_SECRET = 'short'; // would fail in production — fine here
    process.env.EMAIL_ENABLED = 'true';
    delete process.env.RESEND_API_KEY;
    expect(() => validateConfig()).not.toThrow();
    expect(loadConfig().email.mode).toBe('capture');
  });

  it('boots in development when EMAIL_TRANSPORT=capture is forced', () => {
    process.env.NODE_ENV = 'development';
    process.env.JWT_SECRET = 'short';
    process.env.EMAIL_ENABLED = 'true';
    process.env.EMAIL_TRANSPORT = 'capture';
    delete process.env.RESEND_API_KEY;
    expect(() => validateConfig()).not.toThrow();
    expect(loadConfig().email.mode).toBe('capture');
  });
});

describe('email mode resolution (D8)', () => {
  it('resolves live (a) in production when enabled + key + from are set', () => {
    process.env.EMAIL_ENABLED = 'true';
    process.env.RESEND_API_KEY = RESEND_KEY;
    process.env.RESEND_FROM = RESEND_FROM;
    expect(loadConfig().email.mode).toBe('live');
  });

  it('resolves capture (b) in non-production when enabled without a key', () => {
    process.env.NODE_ENV = 'development';
    process.env.JWT_SECRET = 'short';
    process.env.EMAIL_ENABLED = 'true';
    delete process.env.RESEND_API_KEY;
    expect(loadConfig().email.mode).toBe('capture');
  });

  it('resolves disabled (c) when EMAIL_ENABLED=false regardless of a key', () => {
    process.env.EMAIL_ENABLED = 'false';
    process.env.RESEND_API_KEY = RESEND_KEY;
    process.env.RESEND_FROM = RESEND_FROM;
    expect(loadConfig().email.mode).toBe('disabled');
  });

  it('defaults EMAIL_MAX_ATTEMPTS to 5 and RESEND_MAX_PER_ACCOUNT to 3', () => {
    expect(loadConfig().email.maxAttempts).toBe(5);
    expect(loadConfig().email.resendMaxPerAccount).toBe(3);
    expect(loadConfig().email.tokenTtlHours).toBe(24);
    expect(loadConfig().email.drainIntervalMs).toBe(5000);
    expect(loadConfig().email.drainBatch).toBe(50);
    expect(loadConfig().email.retryBaseMs).toBe(60000);
  });
});

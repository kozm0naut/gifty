import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { validateConfig } from '../../src/config/index.js';

/**
 * T022 — Boot-gate tests (US3, FR-005 / FR-006, SC-004).
 *
 * The startup gate (`validateConfig()`) MUST, in a production context, refuse
 * to boot when the session-signing secret is missing / below the minimum
 * strength / a known default, or when the database credential is a known
 * default. Each refusal message MUST identify WHICH value failed and WHAT MUST
 * CHANGE so an operator can remediate without documentation (FR-005). Local
 * development is NOT blocked by the production-only rules (edge case "Weak
 * secret in a non-production context").
 *
 * These tests exercise the gate directly (no server / DB needed) by driving
 * `validateConfig()` against crafted `process.env` states.
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
];

// A strong, non-default signing secret (>= 32 chars, not on the deny-list).
const STRONG_SECRET = 'a-very-strong-operator-supplied-secret-0123456789';
// A strong, non-default database credential.
const STRONG_DB_PASSWORD = 'a-strong-db-credential-7788';
const DEFAULT_DB_PASSWORD = 'gifty_dev_password';

function strongDatabaseUrl(password: string): string {
  return `postgresql://gifty:${password}@localhost:5432/gifty?schema=public`;
}

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];

  // Baseline: a VALID production configuration (strong secret + non-default
  // DB credential). Individual tests override the one value under test.
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
  // Feature 004: keep the email gate out of scope for this 003 boot-gate suite
  // by disabling email — the production email gate (EMAIL_ENABLED + RESEND_API_KEY)
  // is exercised by tests/unit/email-boot-gate.test.ts.
  process.env.EMAIL_ENABLED = 'false';
  delete process.env.EMAIL_TRANSPORT;
  delete process.env.RESEND_API_KEY;
  delete process.env.RESEND_FROM;
  delete process.env.GIFTY_PUBLIC_ORIGIN;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('boot gate — production refusals (FR-005 / FR-006)', () => {
  it('refuses to boot when JWT_SECRET is missing, naming the value and remedy', () => {
    delete process.env.JWT_SECRET;
    expect(() => validateConfig()).toThrowError(/JWT_SECRET/);
    // The message must say what must change (FR-005).
    expect(() => validateConfig()).toThrowError(/at least \d+ characters|must be set/i);
  });

  it('refuses to boot when JWT_SECRET is below the minimum strength, naming the value and length', () => {
    process.env.JWT_SECRET = 'short'; // < 32 chars
    expect(() => validateConfig()).toThrowError(/JWT_SECRET/);
    expect(() => validateConfig()).toThrowError(/at least 32 characters/);
  });

  it('refuses to boot when JWT_SECRET is a known default, naming the value', () => {
    process.env.JWT_SECRET = 'development-secret'; // on the deny-list
    expect(() => validateConfig()).toThrowError(/JWT_SECRET/);
    expect(() => validateConfig()).toThrowError(/known default/i);
  });

  it('refuses to boot when the POSTGRES_PASSWORD is the known default, naming the credential', () => {
    process.env.POSTGRES_PASSWORD = DEFAULT_DB_PASSWORD;
    expect(() => validateConfig()).toThrowError(/database credential|POSTGRES_PASSWORD/i);
    expect(() => validateConfig()).toThrowError(/known default/i);
  });

  it('refuses to boot when the DATABASE_URL password is the known default, naming the credential', () => {
    process.env.DATABASE_URL = strongDatabaseUrl(DEFAULT_DB_PASSWORD);
    delete process.env.POSTGRES_PASSWORD;
    expect(() => validateConfig()).toThrowError(/database credential|DATABASE_URL|POSTGRES_PASSWORD/i);
    expect(() => validateConfig()).toThrowError(/known default/i);
  });
});

describe('boot gate — production acceptance (US3 scenario 4)', () => {
  it('boots with a strong secret and a non-default database credential', () => {
    // Baseline already sets STRONG_SECRET + STRONG_DB_PASSWORD.
    expect(() => validateConfig()).not.toThrow();
  });

  it('boots when the secret is exactly the 32-character minimum and non-default', () => {
    process.env.JWT_SECRET = 'a'.repeat(32); // exactly 32, not on the deny-list
    expect(() => validateConfig()).not.toThrow();
  });
});

describe('boot gate — non-production is not blocked (edge case)', () => {
  it('does NOT refuse a short secret in a development context', () => {
    process.env.NODE_ENV = 'development';
    process.env.JWT_SECRET = 'short'; // would fail in production
    expect(() => validateConfig()).not.toThrow();
  });

  it('does NOT refuse a known-default secret in a development context', () => {
    process.env.NODE_ENV = 'development';
    process.env.JWT_SECRET = 'development-secret'; // would fail in production
    expect(() => validateConfig()).not.toThrow();
  });

  it('treats an unset NODE_ENV as a non-production (development) context', () => {
    delete process.env.NODE_ENV;
    process.env.JWT_SECRET = 'short'; // would fail in production
    expect(() => validateConfig()).not.toThrow();
  });
});

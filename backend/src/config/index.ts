import 'dotenv/config';

/**
 * Operator-configurable settings for the security-hardening feature
 * (specs/003-security-hardening). Values are parsed from the environment
 * with the defaults documented in the spec / plan; `validateConfig()`
 * enforces the production boot gate (FR-005/FR-006).
 */

const KNOWN_DEFAULT_SECRETS = new Set<string>([
  'development-secret',
  'gifty_dev_password',
  'secret',
  'changeme',
  'password',
  'admin',
  'jwt-secret',
  'super-secret',
]);

function toInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.floor(n) : fallback;
}

export interface RateLimitConfig {
  /** Sliding window for the per-source and per-account budgets (FR-001). */
  windowMinutes: number;
  /** Max failed sign-ins per source (trusted-proxy client IP) within the window. */
  loginPerSource: number;
  /** Max failed registrations per source — strictly tighter than `loginPerSource` (FR-001). */
  registerPerSource: number;
  /** Max failed sign-ins per account (email-keyed) within the window (FR-001). */
  loginPerAccount: number;
}

export interface SessionConfig {
  /** Access-token lifetime in seconds. Spec default ≤ 1 h; implementation default 10 min (research D3). */
  accessTtlSeconds: number;
  /** Hard cap for the overall session, in days. Default 30 (FR-007). */
  maxAgeDays: number;
}

export interface CookieConfig {
  /** Access credential cookie name (contracts/api.md). */
  accessName: string;
  /** Refresh credential cookie name (contracts/api.md). */
  refreshName: string;
  /** Set `Secure` only in production (local dev over http://localhost omits it — Assumptions). */
  secure: boolean;
}

export interface Config {
  isProduction: boolean;
  rateLimit: RateLimitConfig;
  session: SessionConfig;
  jwt: { secret: string | undefined; minLength: number };
  cookies: CookieConfig;
  corsOrigins: string[] | undefined;
  cspFontOrigin: string | undefined;
}

/**
 * Parse the operator environment into a structured config. Pure function of
 * `process.env` — safe to call multiple times (idempotent) and trivially
 * testable.
 */
export function loadConfig(): Config {
  const isProduction = (process.env.NODE_ENV ?? 'development') === 'production';

  const rateLimit: RateLimitConfig = {
    windowMinutes: toInt(process.env.RATE_LIMIT_WINDOW_MINUTES, 15),
    loginPerSource: toInt(process.env.LOGIN_MAX_FAILURES_PER_SOURCE, 10),
    registerPerSource: toInt(process.env.REGISTER_MAX_FAILURES_PER_SOURCE, 3),
    loginPerAccount: toInt(process.env.LOGIN_MAX_FAILURES_PER_ACCOUNT, 5),
  };

  const session: SessionConfig = {
    accessTtlSeconds: toInt(process.env.ACCESS_TOKEN_TTL_MINUTES, 10) * 60,
    maxAgeDays: toInt(process.env.SESSION_MAX_AGE_DAYS, 30),
  };

  const corsOrigins = process.env.CORS_ORIGINS
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean) || undefined;

  return {
    isProduction,
    rateLimit,
    session,
    jwt: {
      secret: process.env.JWT_SECRET,
      minLength: toInt(process.env.JWT_SECRET_MIN_LENGTH, 32),
    },
    cookies: {
      accessName: 'gifty_access',
      refreshName: 'gifty_refresh',
      secure: isProduction,
    },
    corsOrigins,
    cspFontOrigin: process.env.CSP_FONT_ORIGIN || undefined,
  };
}

/**
 * Startup gate (FR-005 / FR-006, US3). In a production context the app
 * MUST refuse to boot when:
 *   - `JWT_SECRET` is missing, below the minimum strength (default 32
 *     characters / 256 bits), or a known default value;
 *   - the database credential is a known default value.
 *
 * Each refusal message identifies **which** configuration value failed and
 * **what must change**, so an operator can remediate without consulting
 * documentation (FR-005). Local development is not blocked by production-only
 * rules (edge case "Weak secret in a non-production context").
 */
export function validateConfig(): void {
  const config = loadConfig();
  const errors: string[] = [];

  if (!process.env.DATABASE_URL) {
    errors.push('DATABASE_URL must be set');
  }

  if (config.isProduction) {
    const secret = config.jwt.secret;
    if (!secret) {
      errors.push(
        'JWT_SECRET must be set in production (at least ' +
          `${config.jwt.minLength} characters / 256 bits, not a known default)`,
      );
    } else if (KNOWN_DEFAULT_SECRETS.has(secret)) {
      errors.push(
        'JWT_SECRET must not be a known default value (e.g. "development-secret"); ' +
          'set a strong, operator-supplied secret (at least ' +
          `${config.jwt.minLength} characters)`,
      );
    } else if (secret.length < config.jwt.minLength) {
      errors.push(
        `JWT_SECRET must be at least ${config.jwt.minLength} characters ` +
          `(256 bits); the configured value is too short`,
      );
    }

    const dbUrl = process.env.DATABASE_URL ?? '';
    const passwordMatch = dbUrl.match(/:[^:@/]+@/);
    const password = passwordMatch ? passwordMatch[0].slice(1, -1) : '';
    if (password && KNOWN_DEFAULT_SECRETS.has(password)) {
      errors.push(
        'The database credential (POSTGRES_PASSWORD / DATABASE_URL password) ' +
          'must not be the known default; set an explicit, operator-supplied credential',
      );
    }
  }

  if (
    config.rateLimit.registerPerSource >= config.rateLimit.loginPerSource
  ) {
    // FR-001: the per-source registration budget MUST be strictly tighter
    // than the per-source sign-in budget (the 409 "already exists"
    // registration signal is an enumeration vector).
    errors.push(
      'REGISTER_MAX_FAILURES_PER_SOURCE must be strictly less than ' +
        'LOGIN_MAX_FAILURES_PER_SOURCE (FR-001)',
    );
  }

  if (config.session.accessTtlSeconds > 3600) {
    // FR-007: access-credential lifetime is bounded to ≤ 1 h by default.
    errors.push('ACCESS_TOKEN_TTL_MINUTES must be at most 60 (1 hour)');
  }

  if (config.session.maxAgeDays < 1) {
    errors.push('SESSION_MAX_AGE_DAYS must be at least 1');
  }

  if (errors.length > 0) {
    throw new Error(`Configuration validation failed: ${errors.join(', ')}`);
  }
}

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

function toBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return !(value === 'false' || value === '0' || value === 'off' || value === 'no');
}

/**
 * Normalize `GIFTY_PUBLIC_ORIGIN` (D9) into a canonical base URL: trim
 * whitespace, strip a trailing slash, and fall back to the Docker deployment's
 * public URL when the operator has not set it.
 */
function normalizeOrigin(value: string | undefined, fallback: string): string {
  const raw = (value ?? '').trim();
  if (raw === '') return fallback;
  return raw.replace(/\/+$/, '');
}

/**
 * Normalize an operator-supplied font-origin value (FR-004) into a valid CSP
 * source list. CSP source expressions MUST be space-separated; operators may
 * write a comma-separated env value (more natural), so accept either and emit
 * the canonical space-separated form. An empty/blank value falls back to the
 * app's default font source (the Vite build's Google Fonts host).
 */
function normalizeCspFontOrigin(value: string | undefined): string {
  // An unset OR blank operator value (e.g. `${CSP_FONT_ORIGIN:-}` from compose)
  // means "use the app's default font source" rather than "allow no fonts".
  const raw =
    value && value.trim() !== ''
      ? value
      : 'https://fonts.googleapis.com,https://fonts.gstatic.com';
  return raw
    .split(',')
    .flatMap((s) => s.split(/\s+/))
    .map((s) => s.trim())
    .filter(Boolean)
    .join(' ');
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

export type EmailMode = 'live' | 'capture' | 'disabled';

export interface EmailConfig {
  /**
   * Resolved sending mode (research D1):
   *   - `live`     — EMAIL_ENABLED and RESEND_API_KEY present → ResendMailer.
   *   - `capture`  — EMAIL_ENABLED but no key, or EMAIL_TRANSPORT=capture →
   *                  CaptureMailer (dev/test stub, US5/SC-003).
   *   - `disabled` — EMAIL_ENABLED=false → no emails; accounts auto-confirm
   *                  (FR-016) and the drainer is not started.
   */
  mode: EmailMode;
  /** `RESEND_API_KEY` (production sender credential; undefined when unset). */
  resendApiKey: string | undefined;
  /** `RESEND_FROM` (verified sender address; required in live mode — boot gate; optional in capture/disabled). */
  resendFrom: string | undefined;
  /**
   * Public base origin used to build the confirmation/invite links
   * (D9). Normalized (no trailing slash); defaults to the Docker deployment's
   * public URL when unset.
   */
  publicOrigin: string;
  /** Max delivery attempts per outbox row before it is marked `failed` (FR-018). */
  maxAttempts: number;
  /** Base backoff (ms); a row's Nth retry waits `retryBaseMs * 2^(N-1)` (FR-017). */
  retryBaseMs: number;
  /** Drainer polling interval (ms). */
  drainIntervalMs: number;
  /** Outbox rows claimed per drain cycle. */
  drainBatch: number;
  /** Verification-token TTL in hours (FR-010). */
  tokenTtlHours: number;
  /** Max verification emails per account per 24 h (FR-003). */
  resendMaxPerAccount: number;
}

export interface Config {
  isProduction: boolean;
  rateLimit: RateLimitConfig;
  session: SessionConfig;
  jwt: { secret: string | undefined; minLength: number };
  cookies: CookieConfig;
  email: EmailConfig;
  corsOrigins: string[] | undefined;
  /** CSP `font-src` permitted origin (FR-004). Defaults to the app's font host. */
  cspFontOrigin: string;
  /**
   * Express trust-proxy mode for client-IP resolution (FR-001). When `true` the
   * app is behind a proxy that sets `X-Forwarded-For` and `req.ip` reflects the
   * original client; when `false` (default) `req.ip` is the direct TCP peer and
   * client-supplied `X-Forwarded-For` is ignored, so a client cannot rotate the
   * per-source rate-limit budget by spoofing the header. Set `TRUST_PROXY=1`
   * when fronting the app with a trusted proxy.
   */
  trustProxy: boolean;
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

  // Email-integration feature (004). The sending mode is derived from the
  // operator's intent (EMAIL_ENABLED) plus the presence of a live credential
  // (RESEND_API_KEY), with EMAIL_TRANSPORT=capture as an explicit override:
  //   - disabled  → EMAIL_ENABLED=false
  //   - capture   → enabled but no key, OR EMAIL_TRANSPORT=capture
  //   - live      → enabled AND a key present
  const emailEnabled = toBool(process.env.EMAIL_ENABLED, true);
  const resendApiKey =
    process.env.RESEND_API_KEY && process.env.RESEND_API_KEY.trim() !== ''
      ? process.env.RESEND_API_KEY.trim()
      : undefined;
  const forceCapture =
    process.env.EMAIL_TRANSPORT === 'capture' || process.env.EMAIL_TRANSPORT === 'test';

  let emailMode: EmailMode;
  if (!emailEnabled) {
    emailMode = 'disabled';
  } else if (forceCapture || !resendApiKey) {
    emailMode = 'capture';
  } else {
    emailMode = 'live';
  }

  const email: EmailConfig = {
    mode: emailMode,
    resendApiKey,
    resendFrom:
      process.env.RESEND_FROM && process.env.RESEND_FROM.trim() !== ''
        ? process.env.RESEND_FROM.trim()
        : undefined,
    publicOrigin: normalizeOrigin(
      process.env.GIFTY_PUBLIC_ORIGIN,
      'http://localhost:8080',
    ),
    maxAttempts: toInt(process.env.EMAIL_MAX_ATTEMPTS, 5),
    retryBaseMs: toInt(process.env.EMAIL_RETRY_BASE_MS, 60_000),
    drainIntervalMs: toInt(process.env.EMAIL_DRAIN_INTERVAL_MS, 5_000),
    drainBatch: toInt(process.env.EMAIL_DRAIN_BATCH, 50),
    tokenTtlHours: toInt(process.env.EMAIL_TOKEN_TTL_HOURS, 24),
    resendMaxPerAccount: toInt(process.env.RESEND_MAX_PER_ACCOUNT, 3),
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
    email,
    corsOrigins,
    // FR-004: the app's font source (the Vite build serves the Google Fonts
    // stylesheet + woff2 binaries). Operator-overridable; both the font
    // *stylesheet* origin and the font-file origin may be allowed. Normalized
    // to a valid, space-separated CSP source list. Default keeps the served
    // app's fonts working.
    cspFontOrigin: normalizeCspFontOrigin(process.env.CSP_FONT_ORIGIN),
    // FR-001: honor X-Forwarded-For only when an operator confirms a fronting
    // proxy; otherwise use the direct TCP peer (the header is untrusted).
    trustProxy: process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true',
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

    // FR-006: the database credential MUST NOT be a known default. The
    // credential may be supplied as the standalone `POSTGRES_PASSWORD` env or
    // embedded in `DATABASE_URL`; check whichever is present and name the
    // offending source in the remedy (FR-005).
    const dbUrl = process.env.DATABASE_URL ?? '';
    const urlPasswordMatch = dbUrl.match(/:[^:@/]+@/);
    const urlPassword = urlPasswordMatch
      ? urlPasswordMatch[0].slice(1, -1)
      : undefined;
    const pgPassword =
      process.env.POSTGRES_PASSWORD &&
      process.env.POSTGRES_PASSWORD.trim() !== ''
        ? process.env.POSTGRES_PASSWORD
        : undefined;

    const credentialSources: { label: string; value: string }[] = [];
    if (pgPassword !== undefined) {
      credentialSources.push({ label: 'POSTGRES_PASSWORD', value: pgPassword });
    }
    if (urlPassword !== undefined && urlPassword !== '') {
      credentialSources.push({
        label: 'DATABASE_URL password',
        value: urlPassword,
      });
    }
    for (const { label, value } of credentialSources) {
      if (KNOWN_DEFAULT_SECRETS.has(value)) {
        errors.push(
          `The database credential (${label}) must not be the known default ` +
            `"${value}"; set an explicit, operator-supplied POSTGRES_PASSWORD`,
        );
      }
    }

    // Feature 004 (email integration): in production, if the operator has
    // enabled email delivery but no live Resend credential is configured, the
    // app MUST refuse to boot — it would otherwise silently emit confirmation
    // links that can never be delivered. The message names the offending key
    // and the remedy (FR-009). An explicit EMAIL_TRANSPORT=capture override
    // is an operator's deliberate choice and does not gate.
    const emailEnabled = toBool(process.env.EMAIL_ENABLED, true);
    const resendApiKey =
      process.env.RESEND_API_KEY && process.env.RESEND_API_KEY.trim() !== ''
        ? process.env.RESEND_API_KEY
        : undefined;
    const forceCapture =
      process.env.EMAIL_TRANSPORT === 'capture' ||
      process.env.EMAIL_TRANSPORT === 'test';

    if (emailEnabled && !resendApiKey && !forceCapture) {
      errors.push(
        'EMAIL_ENABLED is true but RESEND_API_KEY is not set; ' +
          'set RESEND_API_KEY to a valid Resend key (or set EMAIL_ENABLED=false ' +
          'to auto-confirm accounts and skip email delivery)',
      );
    }

    // FR-009 (continued): in live mode (enabled + key + no capture override)
    // the sender address MUST be a valid email — Resend rejects the request
    // otherwise (422 validation_error). Name the offending key and the remedy.
    const resendFrom =
      process.env.RESEND_FROM && process.env.RESEND_FROM.trim() !== ''
        ? process.env.RESEND_FROM.trim()
        : undefined;
    // Resend accepts either `email@domain` or `Name <email@domain>` (422
    // validation_error otherwise). Validate the actual address: extract it from
    // the `<...>` when present, else treat the whole value as the address.
    const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    let fromAddress: string | undefined;
    if (resendFrom) {
      const m = resendFrom.match(/<([^<>\s]+@[^<>\s]+)>/);
      fromAddress = m ? m[1] : /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(resendFrom) ? resendFrom : undefined;
    }
    if (emailEnabled && resendApiKey && !forceCapture && !fromAddress) {
      errors.push(
        resendFrom
          ? `RESEND_FROM is set to "${resendFrom}" which is not a valid email address; ` +
            'set RESEND_FROM to a verified address (e.g. no-reply@example.com or ' +
            '"Gifty <no-reply@example.com>")'
          : 'RESEND_FROM is not set; set RESEND_FROM to a verified sending address ' +
            '(e.g. no-reply@example.com or "Gifty <no-reply@example.com>")',
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

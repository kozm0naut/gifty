import request from 'supertest';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createApp } from '../../src/app.js';

/**
 * T019 — Trust-boundary contract tests (003 FR-003, 003 FR-004, 003 FR-012, 003 SC-003, 003 SC-005).
 *
 * US2 independent test, contract form:
 *   - a page on a non-permitted origin gets NO Access-Control-Allow-Origin
 *     (closed by default in production);
 *   - exactly the listed origins are opened when CORS_ORIGINS is set, with
 *     Access-Control-Allow-Credentials: true, and one allowed origin must not
 *     open the API to all others (edge case "Cross-origin with allowed origin");
 *   - the served document carries a CSP restricting content/scripts/styles to
 *     self + the permitted font source;
 *   - X-Powered-By is absent on every response;
 *   - HSTS is present in production and absent in development.
 *
 * The app reads NODE_ENV / CORS_ORIGINS / CSP_FONT_ORIGIN at createApp() time,
 * so each case sets its environment and builds a fresh app.
 */

const ALLOWED_ORIGIN = 'https://app.example.com';
let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  savedEnv = { ...process.env };
  // Default state for a case: production context, CORS closed by default.
  process.env.NODE_ENV = 'production';
  process.env.JWT_SECRET = 'test-secret-32-characters-long-0000';
  // Feature 004: these cases exercise CORS/CSP/HSTS, not the email boot gate —
  // disable email so the production email gate (EMAIL_ENABLED + RESEND_API_KEY)
  // does not trip.
  process.env.EMAIL_ENABLED = 'false';
  delete process.env.CORS_ORIGINS;
  delete process.env.CSP_FONT_ORIGIN;
});

afterEach(() => {
  process.env = savedEnv;
});

describe('trust boundary: closed-by-default CORS (003 FR-003, 003 SC-003)', () => {
  it('production with CORS_ORIGINS unset sends no Access-Control-Allow-Origin', async () => {
    const app = await createApp();
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('production with CORS_ORIGINS unset refuses a cross-origin request (no ACAO on the origin)', async () => {
    const app = await createApp();
    const res = await request(app)
      .get('/healthz')
      .set('Origin', 'https://evil.example');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('production with CORS_ORIGINS set opens exactly that origin, with credentials', async () => {
    process.env.CORS_ORIGINS = ALLOWED_ORIGIN;
    const app = await createApp();

    const res = await request(app)
      .get('/healthz')
      .set('Origin', ALLOWED_ORIGIN);
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('a single allowed origin does not open the API to all others (edge case)', async () => {
    process.env.CORS_ORIGINS = ALLOWED_ORIGIN;
    const app = await createApp();

    const other = await request(app)
      .get('/healthz')
      .set('Origin', 'https://evil.example');
    expect(other.headers['access-control-allow-origin']).toBeUndefined();

    const allowed = await request(app)
      .get('/healthz')
      .set('Origin', ALLOWED_ORIGIN);
    expect(allowed.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
  });

  it('development keeps the permissive default for the Vite dev flow', async () => {
    process.env.NODE_ENV = 'development';
    const app = await createApp();
    const res = await request(app)
      .get('/healthz')
      .set('Origin', 'https://any-origin.example');
    // The dev flow relies on the cors middleware reflecting the caller origin.
    expect(res.headers['access-control-allow-origin']).toBe(
      'https://any-origin.example',
    );
  });
});

describe('trust boundary: security headers (003 FR-004, 003 FR-012, 003 SC-005)', () => {
  it('X-Powered-By is absent on every response', async () => {
    const app = await createApp();
    const ok = await request(app).get('/healthz');
    expect(ok.headers['x-powered-by']).toBeUndefined();

    const missing = await request(app).get('/no-such-route-xyz');
    expect(missing.headers['x-powered-by']).toBeUndefined();
  });

  it('production serves a CSP restricting content to self + the permitted font source', async () => {
    // The app's fonts are a stylesheet (fonts.googleapis.com) + font binaries
    // (fonts.gstatic.com); the operator may list several permitted origins.
    // CSP source lists MUST be space-separated, so assert the canonical form.
    process.env.CSP_FONT_ORIGIN =
      'https://fonts.googleapis.com,https://fonts.gstatic.com';
    const app = await createApp();
    const res = await request(app).get('/healthz');

    const csp = res.headers['content-security-policy'];
    expect(csp).toBeTruthy();
    // Core restrictions: content/scripts/styles confined to self.
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("img-src 'self' data:");
    expect(csp).toContain("connect-src 'self'");
    // The operator-permitted font source is explicitly allowed (003 FR-004) — both
    // the font binaries (font-src) and the font stylesheet (style-src), since
    // the app loads a <link rel=stylesheet> from the font origin.
    expect(csp).toContain(
      "font-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com",
    );
    expect(csp).toContain(
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://fonts.gstatic.com",
    );
    // A comma-separated operator value must normalize to a valid (space-
    // separated) source list — commas are illegal inside a CSP source list.
    expect(csp).not.toContain(',');
  });

  it('HSTS is present in production and absent in development', async () => {
    const prodApp = await createApp();
    const prod = await request(prodApp).get('/healthz');
    expect(prod.headers['strict-transport-security']).toMatch(
      /max-age=31536000; includeSubDomains/,
    );

    process.env.NODE_ENV = 'development';
    const devApp = await createApp();
    const dev = await request(devApp).get('/healthz');
    expect(dev.headers['strict-transport-security']).toBeUndefined();
  });

  it('the existing hardening headers remain in place', async () => {
    const app = await createApp();
    const res = await request(app).get('/healthz');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  });
});

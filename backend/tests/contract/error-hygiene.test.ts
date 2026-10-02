import request from 'supertest';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/index.js';

/**
 * T040 — Error-hygiene contract tests (FR-011, FR-012, FR-020).
 *
 * US6 independent test, contract form:
 *   - an induced internal (5xx) failure returns the single stable production
 *     body `{ "error": "An internal error occurred." }` with no stack trace,
 *     file path, query, or driver detail (FR-011);
 *   - `X-Powered-By` is absent on every response, including error responses
 *     (FR-012);
 *   - sign-in failures (unknown email vs wrong password vs rate-limited) are
 *     uniform in status + body — no account-existence hint (FR-020, SC-002).
 *
 * The app reads NODE_ENV / rate-limit budgets at createApp() time, so each
 * case sets its environment and builds a fresh app.
 *
 * A 5xx is induced via an opt-in probe route (`POST /__test/internal-error`)
 * that throws a realistic server-side error; it is registered in `app.ts` only
 * when `GIFTY_ENABLE_TEST_PROBES` is set, so it never exists in a normal app.
 */

const INTERNAL_ERROR_BODY = { error: 'An internal error occurred.' };
const SOURCE = '203.0.113.50';
let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  savedEnv = { ...process.env };
  process.env.NODE_ENV = 'production';
  process.env.JWT_SECRET = 'test-secret-32-characters-long-0000';
  // Register the 5xx probe route; tighten the per-source sign-in budget (fast 429).
  // FR-001 invariant: register budget must stay strictly below the login budget.
  process.env.GIFTY_ENABLE_TEST_PROBES = '1';
  process.env.LOGIN_MAX_FAILURES_PER_SOURCE = '2';
  process.env.REGISTER_MAX_FAILURES_PER_SOURCE = '1';
  delete process.env.LOGIN_MAX_FAILURES_PER_ACCOUNT;
  delete process.env.CORS_ORIGINS;
});

afterEach(() => {
  process.env = savedEnv;
});

async function registerUser(app: any, email: string, password = 'Password123!') {
  return request(app)
    .post('/auth/register')
    .send({ email, password, displayName: 'Hygiene' });
}

describe('T040 error hygiene (FR-011, FR-012)', () => {
  it('an induced internal failure returns the single stable body with no internal detail (FR-011)', async () => {
    const app = await createApp();
    const res = await request(app).post('/__test/internal-error');

    expect(res.status).toBe(500);
    expect(res.body).toEqual(INTERNAL_ERROR_BODY);

    // No implementation detail leaks anywhere in the serialized response.
    const raw = JSON.stringify(res.body);
    expect(raw).not.toMatch(/at .+\(.+\)/i); // no "at foo (file:line)" stack frames
    expect(raw).not.toMatch(/\/[a-z0-9_\-./]+\.ts/i); // no source-file path
    expect(raw).not.toMatch(/prisma|ECONNREFUSED|P1001|sqlite|postgres/i); // no driver/lib detail
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('X-Powered-By is absent on every response, including 4xx and 5xx (FR-012)', async () => {
    const app = await createApp();
    const ok = await request(app).get('/healthz');
    // A non-GET to an unregistered path yields a true 404 (the production SPA
    // fallback only matches GETs, so it can't mask this as a 200 index.html).
    const notFound = await request(app).delete('/no-such-route-xyz');
    const serverError = await request(app).post('/__test/internal-error');

    expect(ok.status).toBe(200);
    expect(notFound.status).toBe(404);
    expect(serverError.status).toBe(500);
    for (const res of [ok, notFound, serverError]) {
      expect(res.headers['x-powered-by']).toBeUndefined();
    }
  });

  it('sign-in failures are uniform: unknown email, wrong password, and rate-limited (FR-020)', async () => {
    const app = await createApp();
    const known = `hyg-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`;
    await registerUser(app, known);

    const unknown = await request(app)
      .post('/auth/login')
      .set('X-Forwarded-For', SOURCE)
      .send({ email: `ghost-${Date.now()}@example.com`, password: 'WrongPass1!' });
    const wrong = await request(app)
      .post('/auth/login')
      .set('X-Forwarded-For', SOURCE)
      .send({ email: known, password: 'WrongPass1!' });

    // Budget is 2: exhaust it with two failures, then the third is rate-limited.
    const limited = await request(app)
      .post('/auth/login')
      .set('X-Forwarded-For', SOURCE)
      .send({ email: known, password: 'WrongPass1!' });

    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(limited.status).toBe(429);
    // All three carry the same stable body — no account-existence hint (SC-002).
    expect(unknown.body).toEqual(wrong.body);
    expect(limited.body).toEqual(unknown.body);
  });

  it('does not advertise the framework or server name (FR-012)', async () => {
    const app = await createApp();
    const res = await request(app).get('/healthz');
    // FR-012: the Server header must not fingerprint the stack — no framework
    // (Express) or runtime (Node.js) identifier. It may be absent or a neutral
    // product token; it must not reveal the implementation.
    const server = res.headers['server'];
    if (server !== undefined) {
      expect(server.toLowerCase()).not.toMatch(/express|node/i);
    }
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

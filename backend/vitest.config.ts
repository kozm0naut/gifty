import { defineConfig } from 'vitest/config';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Test-suite isolation (feature 003, spec 003): the backend tests wipe every
 * table in their setup hooks. They MUST target a dedicated `gifty_test`
 * database, never the live `gifty` database the running app uses — otherwise
 * a single `npm test` run destroys demo/dev data.
 *
 * The test URL is derived from `backend/.env`'s `DATABASE_URL` (same server /
 * user / password, DB name suffixed `_test`) and forced onto `process.env`
 * BEFORE the test files (and Prisma) load. `nodeScripts`/env injection here
 * runs once per Vitest worker, so this is safe with `--maxWorkers 1`.
 *
 * Run `node scripts/ensure-test-db.mjs` once to create the DB + schema.
 */
const here = dirname(fileURLToPath(import.meta.url));

function deriveTestUrl(): string | undefined {
  try {
    const envText = readFileSync(resolve(here, '.env'), 'utf8');
    const m = envText.match(/^\s*DATABASE_URL\s*=\s*"?([^"\n]+)"?/m);
    if (!m?.[1]) return undefined;
    const url = new URL(m[1]);
    url.pathname = `/${url.pathname.replace(/^\/?/, '')}_test`;
    return url.toString();
  } catch {
    return undefined;
  }
}

const testDatabaseUrl = deriveTestUrl();
if (testDatabaseUrl) {
  process.env.DATABASE_URL = testDatabaseUrl;
}

// US2 gate default (004 SC-007/004 SC-008): email sending is DISABLED for the test
// suite unless a file explicitly opts in, so legacy 001/003 accounts are
// auto-confirmed (004 FR-015) and unaffected by the confirmation gate. Email
// feature suites (T013 invite, T015 confirmation) set EMAIL_ENABLED='true'
// in their beforeEach and confirm actors via the captured link.
process.env.EMAIL_ENABLED = process.env.EMAIL_ENABLED ?? 'false';

// The per-source rate-limit tests simulate distinct sources with the
// `X-Forwarded-For` header (supertest has no real proxy). Enable Express
// trust-proxy mode so `clientIp()` honors that header and the per-source
// tests keep distinguishing sources. Production default stays OFF (direct TCP
// peer; the header is untrusted and ignored).
process.env.TRUST_PROXY = '1';

export default defineConfig({
  test: {
    environment: 'node',
    // Keep the existing single-worker behaviour (tests share a wiped DB).
    maxWorkers: 1,
    minWorkers: 1,
  },
});

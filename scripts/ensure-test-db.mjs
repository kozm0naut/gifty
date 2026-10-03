#!/usr/bin/env node
/**
 * Ensure an isolated `gifty_test` database exists and has the Prisma schema
 * applied, so the backend test suite can NEVER wipe the live `gifty` data.
 *
 * Background: the backend tests wipe every table in `beforeEach`/`beforeAll`
 * (see `backend/tests/*`). Historically they connected to the SAME `gifty`
 * database the running app uses (both point at `backend/.env`'s `DATABASE_URL`,
 * and the dev overlay shares the `gifty_postgres_data` volume), so a single
 * `npm test` run destroyed demo/dev data. Pointing the tests at a dedicated
 * `_test` database makes that impossible.
 *
 * Credentials are read from `backend/.env` — never hardcoded here.
 *
 * Usage:  node scripts/ensure-test-db.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const backendDir = resolve(root, 'backend');

// 1. Read the app DATABASE_URL from backend/.env
let appUrl;
try {
  const envText = readFileSync(resolve(backendDir, '.env'), 'utf8');
  const m = envText.match(/^\s*DATABASE_URL\s*=\s*"?([^"\n]+)"?/m);
  appUrl = m?.[1];
} catch {
  /* handled below */
}
if (!appUrl) {
  console.error('Could not find DATABASE_URL in backend/.env');
  process.exit(1);
}

// 2. Derive the test URL: same server/user/password, DB name gets `_test`.
function withTestSuffix(url) {
  try {
    const u = new URL(url);
    u.pathname = `/${u.pathname.replace(/^\/?/, '')}_test`;
    return u.toString();
  } catch {
    return url.replace(/\/gifty(\?|$)/, '/gifty_test$1');
  }
}
const testUrl = withTestSuffix(appUrl);
const testDbName = new URL(testUrl).pathname.replace(/^\/?/, '');
const baseDbName = new URL(appUrl).pathname.replace(/^\/?/, '');

function dockerComposeExec(args) {
  return spawnSync('docker', ['compose', 'exec', '-T', 'postgres', ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

// Bring up the dev-overlay Postgres so the port is published to the host.
// The backend tests dial `localhost:5432`, which the PRODUCTION compose
// (internal-only, no port mapping) does NOT expose — the dev overlay adds
// `5432:5432`. This is the single source of truth for "tests can reach the
// DB". Idempotent: `up -d` is a no-op when the container already matches
// this config, so repeated runs are cheap.
function composeUp() {
  const r = spawnSync('docker', [
    'compose', '-f', 'docker-compose.yml', '-f', 'docker-compose.dev.yml',
    'up', '-d', 'postgres',
  ], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) {
    console.error('Failed to start the test Postgres (dev overlay):\n', r.stdout, r.stderr);
    process.exit(1);
  }
}

// 2b. Ensure Docker is running and the dev-overlay Postgres is up + ready so
// host `localhost:5432` is reachable before we create/push the schema.
{
  const docker = spawnSync('docker', ['info'], { cwd: root, encoding: 'utf8' });
  if (docker.status !== 0) {
    console.error('Docker is not running. Start Docker Desktop and re-run.');
    process.exit(1);
  }
  composeUp();
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    const c = spawnSync('docker', [
      'compose', '-f', 'docker-compose.yml', '-f', 'docker-compose.dev.yml',
      'exec', '-T', 'postgres', 'pg_isready', '-U', 'gifty',
    ], { cwd: root, encoding: 'utf8' });
    if (c.status === 0) {
      ready = true;
    } else {
      // Portable 1s sleep (no child process).
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 1000);
    }
  }
  if (!ready) {
    console.error('Postgres did not become ready in time.');
    process.exit(1);
  }
}

// 2c. Reconcile the cluster's `gifty` password with backend/.env.
//
// Postgres bakes `POSTGRES_PASSWORD` into the `gifty` role ONLY when it first
// initializes an empty data volume — a restart never re-reads it. So a
// `down -v` + re-`up` re-initializes the cluster and can bake a DIFFERENT
// password (e.g. a runtime value left over from a CI repro) than the one
// `backend/.env` later points at. That drift breaks EVERY TCP client (the app,
// Prisma, the tests) with a scram-sha-256 P1000, while the local unix-socket
// path (trust) keeps working — a subtle, hard-to-spot failure.
//
// We connect over the socket as `gifty` (no password required there) and force
// the role's password to match `backend/.env`, so the TCP path the tests (and
// the app) actually use is guaranteed to authenticate. Idempotent + cheap: a
// no-op when the password already matches.
{
  let password = '';
  try {
    password = new URL(appUrl).password;
  } catch {
    /* no password in the URL — nothing to reconcile */
  }
  if (password) {
    const escaped = password.replace(/'/g, "''");
    const alter = dockerComposeExec([
      'psql', '-U', 'gifty', '-d', baseDbName, '-v', 'ON_ERROR_STOP=1',
      '-c', `ALTER USER gifty WITH PASSWORD '${escaped}';`,
    ]);
    if (alter.status !== 0) {
      console.error('Failed to reconcile the gifty DB password with backend/.env:\n', alter.stderr || alter.stdout);
      console.error('The cluster may have been initialized with a different POSTGRES_PASSWORD (e.g. after `down -v` + re-up).');
      process.exit(1);
    }
    console.log('✔ reconciled gifty DB password with backend/.env');
  }
}

// 3. Create the test database if it does not already exist (idempotent).
const exists = dockerComposeExec([
  'psql', '-U', 'gifty', '-d', baseDbName, '-tAc',
  `SELECT 1 FROM pg_database WHERE datname='${testDbName}'`,
]);
if (exists.status === 0 && exists.stdout.trim() === '1') {
  console.log(`✔ test database "${testDbName}" already exists`);
} else {
  const mk = dockerComposeExec(['createdb', '-U', 'gifty', testDbName]);
  if (mk.status !== 0) {
    console.error('Failed to create test database:', mk.stderr || mk.stdout);
    process.exit(1);
  }
  console.log(`✔ created test database "${testDbName}"`);
}

// 4. Apply the Prisma schema to the test database.
// `shell: true` is required on Windows: `npx` is a `.cmd` shim that only
// resolves through the shell (a bare spawn('npx') fails with ENOENT).
const push = spawnSync(
  'npx',
  ['prisma', 'db', 'push', '--skip-generate'],
  {
    cwd: backendDir,
    env: { ...process.env, DATABASE_URL: testUrl },
    encoding: 'utf8',
    shell: true,
  },
);
if (push.status !== 0) {
  console.error('prisma db push failed:\n', push.stdout, push.stderr);
  process.exit(1);
}
console.log('✔ applied Prisma schema to test database');
console.log(`\nTests will now target: ${testUrl.replace(/:[^:@/]+@/, ':***@')}`);

#!/usr/bin/env node
// scripts/ensure-env.mjs
//
// One-time, ABSENT-ONLY seeding of the required operator credentials into the
// root `.env`, so a clean machine (or CI) reaches a healthy app with a single
// `npm run docker:up` — no hand-edited .env, no baked/placeholder password.
//
// Why this exists (the app-boot drift bug):
//   docker-compose.yml reads ${POSTGRES_PASSWORD} (and ${JWT_SECRET}) from the
//   root .env / environment. The postgres image bakes POSTGRES_PASSWORD into the
//   `gifty` role ONLY during first init of an EMPTY data volume; a restart never
//   re-reads it. So the value must be STABLE across re-inits (e.g. `down -v` +
//   re-up). If .env is absent/empty at the first `up`, the cluster bakes a
//   garbage password; a real value added to .env later no longer matches, and
//   every TCP client (app, Prisma) fails with P1000 scram-sha-256.
//   Seeding a strong value ONCE — and never overwriting a present one — makes
//   .env the single stable source, so the app path is drift-proof for free.
//
// Safety rules (the only unsafe variant is overwriting a live value):
//   * ABSENT or empty     -> seed a fresh strong random value.
//   * PRESENT (non-empty) -> NEVER touched (the operator's value wins; rewriting
//                            a cluster's source password would desync it).
//   * Idempotent: a re-run is a no-op once both keys are present.
//   * Best-effort 0600 so the secret isn't world-readable (no-op on Windows).
//
// This is the LOCAL / fresh-machine fix. The TEST path (backend/.env DATABASE_URL
// -> gifty_test) is covered separately by scripts/ensure-test-db.mjs, which also
// reconciles the `gifty` role password over the local socket.
//
// Usage: node scripts/ensure-env.mjs [path-to-.env]   (default: <repoRoot>/.env)

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const KEYS = ['POSTGRES_PASSWORD', 'JWT_SECRET'];

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = process.argv[2] ? resolve(process.argv[2]) : resolve(repoRoot, '.env');

/** Parse KEY=VALUE lines (tolerant of whitespace/quotes) into a Map. */
function parseEnv(content) {
  const values = new Map();
  if (!content) return values;
  for (const line of content.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    // Strip a single pair of surrounding quotes, if present.
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values.set(m[1], value);
  }
  return values;
}

/** 64 hex chars — strong, non-default (clears the US3 boot-gate minimums). */
function strongValue() {
  return randomBytes(32).toString('hex');
}

function main() {
  const existing = parseEnv(existsSync(envPath) ? readFileSync(envPath, 'utf8') : '');

  const toSeed = KEYS.filter((k) => existing.get(k) === undefined || existing.get(k) === '')
    .map((k) => [k, strongValue()]);

  if (toSeed.length === 0) {
    console.log(`✔ ${envPath} already has POSTGRES_PASSWORD + JWT_SECRET — nothing to seed (absent-only guard held)`);
    return;
  }

  const dir = dirname(envPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  let out = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
  if (out && !out.endsWith('\n')) out += '\n';
  out += '\n# --- seeded by scripts/ensure-env.mjs (strong random; replace with fixed values if you prefer) ---\n';
  for (const [key, value] of toSeed) out += `${key}=${value}\n`;

  writeFileSync(envPath, out);
  try {
    chmodSync(envPath, 0o600);
  } catch {
    /* Windows: chmod is advisory; ignore. */
  }

  console.log(`✔ seeded ${toSeed.map(([k]) => k).join(', ')} into ${envPath}`);
  console.log('  (absent-only: any already-present values were left untouched)');
}

main();

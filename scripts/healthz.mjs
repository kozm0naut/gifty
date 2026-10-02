/**
 * Polls the app's health endpoint until it reports ok (or the timeout elapses).
 *
 * Used by `npm run verify` to bridge the container-startup race after a
 * `docker compose up --build`: if the very first e2e test runs before the app
 * is ready it fails with `SocketError: other side closed`. Waiting on
 * /healthz first removes that flake.
 *
 * Usage: node scripts/healthz.mjs [url] [timeoutMs]
 *   url        defaults to http://localhost:8080/healthz
 *   timeoutMs  defaults to 60000
 *
 * Exits 0 when healthy, 1 on timeout.
 */
const url = process.argv[2] || 'http://localhost:8080/healthz';
const timeoutMs = Number(process.argv[3] || 60_000);
const startedAt = Date.now();

while (Date.now() - startedAt < timeoutMs) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    if (res.status === 200) {
      console.log(`healthz OK: ${url}`);
      process.exit(0);
    }
  } catch {
    // not up (or not ready) yet — keep polling
  }
  await new Promise((resolve) => setTimeout(resolve, 1_000));
}

console.error(`healthz TIMED OUT after ${timeoutMs}ms: ${url}`);
process.exit(1);

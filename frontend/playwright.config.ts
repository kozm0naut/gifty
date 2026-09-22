import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright e2e configuration for the Gifty frontend.
 *
 * The suite drives the real React UI (served by Vite on :5173) against the
 * real Express + Prisma + PostgreSQL backend (on :4000). Both servers are
 * expected to already be running (e.g. via `npm run dev` at the repo root);
 * `reuseExistingServer: true` lets Playwright attach to them instead of
 * spawning duplicates. If they are not running, Playwright will start them.
 *
 * The backend has no 2xx `GET /` route (it returns 404), which is fine —
 * Playwright's webServer readiness check treats any response with a status
 * code < 500 as "server is up".
 */
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? [['html', { open: 'never' }], ['list']] : 'list',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  // The backend (port 4000) and frontend (port 5173) are expected to already
  // be running (e.g. via `npm run dev` at the repo root). Playwright's
  // `reuseExistingServer` readiness check requires a 2xx response, but the
  // backend returns 404 for `GET /`, so we skip the webServer config.
  // For CI, start the servers before running the tests.
});

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // Dev parity with the containerized single-origin deployment: proxy the
    // API routes to the local backend so the SPA can use relative (same-origin)
    // API paths in dev, exactly like production.
    //
    // `/auth` is BOTH an API prefix (/auth/login, /auth/refresh, …) and the
    // SPA's sign-in route (/auth). A plain string context proxies everything
    // under /auth — including the browser navigating to the sign-in page —
    // to the backend, which has no GET /auth (404). The `bypass` hook keeps
    // browser page navigations (Accept: text/html) on Vite so the SPA renders,
    // while real API calls (Accept: */* or application/json) still proxy.
    proxy: {
      '/auth': {
        target: 'http://localhost:4000',
        changeOrigin: true,
        bypass(req) {
          if (req.headers.accept?.includes('text/html')) {
            return '/'; // serve the SPA entry instead of proxying
          }
          return undefined; // proxy to the backend
        },
      },
      '/lists': 'http://localhost:4000',
      '/items': 'http://localhost:4000',
      '/account': 'http://localhost:4000',
    },
  },
  test: {
    environment: 'jsdom',
    // Scope vitest to unit tests under src/. The Playwright e2e specs under
    // tests/e2e/ are driven by `npm run test:e2e` (Playwright) and use
    // test.describe()/test() from @playwright/test, so they must NOT be picked
    // up by vitest — previously the default include glob matched *.spec.ts and
    // caused false "Playwright Test did not expect test.describe()" failures.
    include: ['src/**/*.{test,spec}.?(c|m)[jt]s?(x)'],
    exclude: ['**/node_modules/**', 'tests/e2e/**'],
  },
});

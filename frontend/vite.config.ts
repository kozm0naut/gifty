import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // Dev parity with the containerized single-origin deployment: proxy the
    // API routes to the local backend so the SPA can use relative (same-origin)
    // API paths in dev, exactly like production.
    proxy: {
      '/auth': 'http://localhost:4000',
      '/lists': 'http://localhost:4000',
      '/items': 'http://localhost:4000',
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

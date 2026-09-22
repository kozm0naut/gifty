import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
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

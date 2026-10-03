import { defineConfig } from '@playwright/test';

/**
 * THE E2E CONFIG, WHICH DID NOT EXIST.
 *
 * `pnpm test:e2e` ran `playwright test` with no config, so Playwright fell back to its default
 * `testDir` -- the repository root -- and swept up every `*.test.ts(x)` under `apps/web/src`. Those are
 * VITEST files, so the run died with "Vitest cannot be imported in a CommonJS module" twenty-odd times
 * and no browser ever opened. A script that fails for a reason unrelated to what it claims to test is
 * worse than a missing script: it looks like coverage.
 *
 * `testDir` is now a directory that holds nothing but e2e specs, so a vitest file dropped in `src/` can
 * never be mistaken for one.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'line' : 'list',
  use: {
    baseURL: 'http://127.0.0.1:3000',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    // The Next dev server, not `next build` -- a production build of the whole app on every e2e run is
    // minutes of work for a test that only needs the shell to serve.
    command: 'pnpm --filter @orrery/web dev',
    url: 'http://127.0.0.1:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});

import { defineConfig } from 'vitest/config';

/**
 * The worker's integration tests, separate from its unit suite.  (P4-T7)
 *
 * The same reason `packages/db` splits them, quoted there: `pnpm test` must pass with no
 * database, or it gets skipped everywhere it is run most often. The outbox drain needs a real
 * `FOR UPDATE SKIP LOCKED` to be worth testing, and a fake would not have caught the stale-claim
 * bug it did catch.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.integration.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});

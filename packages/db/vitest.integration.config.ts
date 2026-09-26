import { defineConfig } from 'vitest/config';

/**
 * Integration tests run separately from the unit suite, and the split is not about speed.
 *
 * `pnpm test` must pass with no database, or it gets skipped on every developer machine and in
 * every pre-commit hook. `pnpm test:integration` needs a real Postgres and is what CI runs
 * before merge. A test that only ever runs in one place is a test nobody runs.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.integration.test.ts'],
    // Migrations and four argon2-class hashes; a cold database is not fast.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});

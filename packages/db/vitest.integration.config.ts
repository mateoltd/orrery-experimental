import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * `.env.test` IS THE SOURCE OF THE DATABASE URL, AND IT WAS NEVER READ.
 *
 * `test:integration` died with `Environment variable not found: DATABASE_URL` while `.env.test` sat in
 * the repository root holding exactly that variable. So the suite only ran for whoever happened to
 * export it first, and a red integration run looked like a schema problem rather than a missing export.
 * The unit suite must still pass with no database -- that is the whole point of the split -- so this
 * loads the file for the INTEGRATION config only.
 *
 * Already-set variables win, so CI can point at its own database without editing anything.
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const envTest = join(repoRoot, '.env.test');
const testEnv: Record<string, string> = {};
if (existsSync(envTest)) {
  for (const line of readFileSync(envTest, 'utf8').split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match && process.env[match[1]] === undefined) {
      testEnv[match[1] as string] = (match[2] as string).replace(/^["']|["']$/g, '');
    }
  }
}

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
    env: testEnv,
  },
});

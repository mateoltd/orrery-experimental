import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The automatic JSX runtime. Next.js uses it, so the test transform must too — otherwise
  // every .tsx test fails with "React is not defined" while the app itself works fine, which is
  // a confusing way to learn that a config is missing the jsx option.
  esbuild: { jsx: 'automatic' },
  resolve: {
    /**
     * `@/` must resolve the same way here as it does under `tsc` and under Next.
     *
     * The app's `tsconfig.json` maps `@/*` to `./src/*`, and Next reads it. Vitest did not, so any
     * test that imported a module which itself used `@/` — a route, a page — failed with a
     * resolution error that looked like a missing file rather than a missing alias. The first
     * tests of the session layer hit it.
     */
    alias: { '@': fileURLToPath(new URL('./src/', import.meta.url)) },
  },
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    // The uniform-response floor is 300ms by design, so a test that submits and waits for the
    // banner is inherently slower than a unit test. 30s is headroom, not a licence to hang.
    testTimeout: 30_000,
  },
});

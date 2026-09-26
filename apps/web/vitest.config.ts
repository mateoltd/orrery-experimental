import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The automatic JSX runtime. Next.js uses it, so the test transform must too — otherwise
  // every .tsx test fails with "React is not defined" while the app itself works fine, which
  // is a confusing way to learn that a config is missing the jsx option.
  esbuild: { jsx: 'automatic' },
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    // The uniform-response floor is 300ms by design, so a test that submits and waits for the
    // banner is inherently slower than a unit test. 30s is headroom, not a licence to hang.
    testTimeout: 30_000,
  },
});

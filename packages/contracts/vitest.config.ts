import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
    // axe needs a DOM. Only the renderer tests need one, and `environmentMatchGlobs` is
    // removed in vitest 3, so the render suite opts in with a docblock pragma instead of
    // paying for jsdom on the schema tests, which are pure and want no DOM at all.
    environment: 'node',
  },
});

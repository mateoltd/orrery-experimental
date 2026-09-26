import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // A test that needs variety takes a seed and PRINTS IT in the failure message
    // (INV-RNG-1). An unreproducible flake is a flake that gets "fixed" by retrying.
    sequence: { shuffle: false },
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      // Thresholds live here and are a GATE FILE. Changing them requires the literal
      // string 'GATE-CHANGE:' in the PR body (plans/00 §6.2 rule 9, R23).
      thresholds: {
        lines: 85,
        branches: 80,
        functions: 85,
        statements: 85,
      },
    },
  },
});

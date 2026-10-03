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
        /**
         * THE GRADING CORE IS AT 100%, PERCENT, NOT ON AVERAGE.
         *
         * `plans/07` §4 asks for "100% branch, enforced by a dedicated coverage threshold that cannot be
         * lowered". A global threshold cannot express that: the module is 3% of the tree, so a repo-wide 85%
         * passes with every branch in it uncovered, and the only way the number could drop is by editing this
         * file -- which the `GATE-CHANGE:` rule above already requires a PR body to justify.
         *
         * Globals are the floor. A per-path floor is the ceiling, and the grading core is the one place where
         * an uncovered branch is a mark a student did not get.
         */
        'packages/contracts/src/grading/index.ts': {
          lines: 100,
          branches: 100,
          functions: 100,
          statements: 100,
        },
        /**
         * The partial-credit methods, for the same reason and with more force: these six formulas decide
         * students' grades, and a seventh policy of the same shape -- a penalty term added to `SU`, a size clause
         * dropped from `RI` -- would change every mark on every affected item while leaving the file's shape
         * untouched. `plans/07` section 3's fixture table is the contract, so the code that implements it is
         * held to the same floor as the dispatcher that calls it.
         */
        'packages/contracts/src/grading/methods.ts': {
          lines: 100,
          branches: 100,
          functions: 100,
          statements: 100,
        },
      },
    },
  },
});

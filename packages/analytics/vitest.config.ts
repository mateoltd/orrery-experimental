import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Pure functions over plain data. Nothing here touches a DOM, and paying for jsdom would be a cost with no
    // benefit -- unlike `contracts`, whose renderer-adjacent tests genuinely need one.
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/index.ts'],
      // The thresholds live in the ROOT config so they are visible with every other floor in one place. This file
      // exists so `vitest run --coverage` can be executed against this package alone; the root config's cross-package
      // threshold entries do not apply to a run scoped to one package, which is why the numbers are repeated here with
      // the same values and the same reasoning.
      /*
       * 100% lines, functions and statements. Branches at 95, and ALL EIGHT of the gap are the SAME construct.
       *
       * Each is a `?? 0`, an `?.`, or an `if (values.length < 2)` on a value that a preceding guard has already proven
       * present:
       *
       *   discrimination.ts 117  `xs[i] ?? 0`          -- `n` is `min(xs.length, ys.length)`, so `i < n` is in range
       *   discrimination.ts 194  `sorted[j + 1]?.y`    -- guarded by `j + 1 < sorted.length` on the same line
       *   discrimination.ts 215  `allRanks.get(..) ?? 0` -- every `y` was ranked a few lines above
       *   time-on-item.ts  40-41 `sorted[middle] ?? null`
       *   time-on-item.ts  48    `sorted[index] ?? null`
       *   reliability.ts   70    `values.length < 2`   -- every caller has already checked n >= 30
       *   reliability.ts  150    `firstRow === undefined ? k : ...` -- `usable` is non-empty past the n >= 30 guard
       *   reliability.ts  153   `scores[index] ?? 0`  -- responses were filtered to `scores.length === k`
       *
       * They are unreachable, so no test can cover them. The alternative is an `as number` / `as T` cast, which is
       * worse on both counts -- and `noNonNullAssertion` is banned outright by `plans/00` §6.2 -- it tells the compiler to stop asking rather than handling the case, and it becomes a lie
       * the moment the guard above it is edited -- and the guards above these lines are exactly the sort of thing that
       * gets edited.
       *
       * So the fallbacks stay, the threshold records the measured ceiling, and every REACHABLE branch in the package
       * is at 100%. A coverage ignore was rejected deliberately: it suppresses real gaps in the same files along with
       * these eight, and the eight are the only ones -- so the ignore would buy nothing and cost the next person's
       * ability to trust the number.
       */
      thresholds: {
        lines: 100,
        // The measured value. It moves when guards are added or removed, which is the point of writing it down: a
        // count that drifts UP means a guard stopped covering something.
        branches: 94,
        functions: 100,
        statements: 100,
      },
    },
  },
});

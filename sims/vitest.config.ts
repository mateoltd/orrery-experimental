import { join, resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const here = import.meta.dirname;
const root = resolve(here, '..');

/**
 * A test root for `sims/`, and NOT a pnpm workspace.
 *
 * ## WHY THESE ARE TWO DIFFERENT THINGS
 *
 * `plans/00` §6.2 rule 10 and `RN-07` say `sims/` resolves nothing but the SDK and the RNG — no per-sim
 * `npm install`, no upgrade path to think about, and a decade-old bundled jQuery impossible rather than
 * merely discouraged. Making `sims/` a pnpm workspace to get a test runner would undo exactly that.
 *
 * So the DEPENDENCY boundary stays where it is, and only a test root is added. The aliases below point at
 * the SDK's SOURCE, exactly as `sim:build` does, because a grader tested against a stale `dist` is a
 * grader tested against something that does not ship.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@orrery/sim-sdk/grader': join(root, 'packages/sim-sdk/src/grader.ts'),
      '@orrery/sim-sdk/protocol': join(root, 'packages/sim-sdk/src/protocol.ts'),
      '@orrery/sim-sdk/params': join(root, 'packages/sim-sdk/src/params.ts'),
      '@orrery/sim-sdk/state': join(root, 'packages/sim-sdk/src/state.ts'),
      '@orrery/sim-sdk/grading': join(root, 'packages/sim-sdk/src/grading.ts'),
      '@orrery/sim-sdk': join(root, 'packages/sim-sdk/src/index.ts'),
      '@orrery/rng': join(root, 'packages/rng/src/index.ts'),
    },
  },
  test: {
    // Absolute, because vitest resolves `include` against the process CWD rather than this file's
    // directory, so a relative glob silently matches nothing when the runner is invoked from the repo
    // root — and "No test files found" looks like an empty suite rather than a wrong path.
    include: [join(here, '*/test/**/*.test.ts')],
    // `_template` and `_fixtures` are SCAFFOLDING, not simulations. The template's grader test is
    // placeholder text that cannot pass, and a permanently red test in the suite is a test people learn
    // to ignore -- which is how the real ones stop being read too.
    exclude: [
      join(here, '_template/**'),
      join(here, '_fixtures/**'),
      '**/node_modules/**',
      '**/dist/**',
    ],
    sequence: { shuffle: false },
  },
});

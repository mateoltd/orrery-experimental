/**
 * `P6-T4`, and `P12-T8`'s second finding about it.
 *
 * ## FILES DO NOT RUN IN PARALLEL HERE, AND THAT IS A CORRECTNESS SETTING RATHER THAN A SPEED ONE
 *
 * `scaffold.test.ts` really scaffolds: it spawns `scripts/sim-new.mjs`, which writes a new directory into the live
 * `sims/` tree. `build.test.ts` really builds: it enumerates `sims/*` and reads each `sim.manifest.json`.
 *
 * **Run concurrently, the first sees the second's half-written directory and fails with
 * `ENOENT ... maths.projectile-motion-2/sim.manifest.json`** — a message about a missing manifest, pointing at
 * `build.test.ts`, caused by a scaffold in a different file that had not finished cleaning up.
 *
 * The first version of this config ran files in parallel and `pnpm test` failed roughly one run in three, which is why
 * `P14-T15`'s "the `test` job cannot go green" was reproducible at all. Cleaning up leftover directories (see
 * `scaffold.test.ts`) fixed the *between-runs* case and did **not** fix this one, because the directory is legitimately
 * present while the other test runs — it took a second look to see that the two cases are different problems.
 *
 * ## WHY NOT MAKE THE SCAFFOLDER WRITE ELSEWHERE UNDER TEST
 *
 * That is the better fix and it is a change to `scripts/sim-new.mjs`, whose `SIMS_DIR` is derived from the script's own
 * location. It is recorded as outstanding rather than smuggled in here, because **this file should not make a
 * production CLI configurable purely so a test can be polite** — and until that change lands, serialising is the honest
 * way to stop two tests fighting over one directory.
 *
 * The same hazard exists one level up and is NOT fixed here: `scripts/sim-build.mjs --check` enumerates the same
 * directory, and CI runs `--check` against a dirty tree, so **a developer's interrupted `pnpm sim:new` breaks the build
 * job.** That is a real robustness gap rather than a test artefact.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // See the header: two files in this package mutate and enumerate the same real directory.
    fileParallelism: false,
  },
});

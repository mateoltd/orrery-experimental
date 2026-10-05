/**
 * `pnpm test:load` -- THE ARTEFACT'S ENTRY POINT.  (P8-T16)
 *
 * ## WHAT IT DOES AND WHAT IT DELIBERATELY DOES NOT
 *
 * It generates the cohort from a seed, prints the PLAN (so the shape can be inspected without a database), and writes
 * a baseline report. **The write-path leg is opt-in** (`LOAD_TARGET=write-path`) because it creates rows in the shared
 * development database, and a load test that quietly inserts 750 students' worth of attempts is a hazard to whoever
 * is working next.
 *
 * `plans/18` §11's sentence is the reason the report leads with correctness rather than latency: *"Latency without
 * correctness assertions is how teams ship a load test that passes while the product loses student answers."*
 *
 * ## THE EXIT CODE IS THE ASSERTION, NOT THE RUN
 *
 * A load test that prints numbers and exits 0 is a report, not a gate. `compareToBaseline` decides, and a correctness
 * regression or a lost acknowledged save exits non-zero.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { planCohort, readBaseline, percentile, thinkTimeMs } = await import(
  join(root, 'packages/load-profile/dist/harness.js')
);
const { PROVENANCE, COHORT, THINK_TIME } = await import(
  join(root, 'packages/load-profile/dist/index.js')
);
const { createRng } = await import(join(root, 'packages/rng/dist/index.js'));

const SEED = process.env.LOAD_SEED ?? 'p8-t16-baseline';
const scale = process.env.LOAD_SCALE === 'full' ? 'full' : 'calibration';
const students = scale === 'full' ? COHORT.full : COHORT.calibration;
const QUESTIONS = Number(process.env.LOAD_QUESTIONS ?? 8);
const target = process.env.LOAD_TARGET === 'write-path' ? 'write-path' : 'plan-only';

console.log('LOAD ARTEFACT (P8-T16)');
console.log(`  provenance   : ${PROVENANCE.kind}`);
if (PROVENANCE.kind === 'SYNTHETIC') console.log(`                 ${PROVENANCE.reason}`);
console.log(
  `  scale        : ${scale} (${String(students)} students, ${String(QUESTIONS)} questions each)`,
);
console.log(`  seed         : ${SEED}`);
console.log(`  target       : ${target}`);
console.log(
  `  think time   : log-normal, median ${String(THINK_TIME.medianMs)} ms, sigma ${String(THINK_TIME.sigma)}`,
);
console.log('');

const started = performance.now();
const plan = planCohort(SEED, students, QUESTIONS);
const durationMs = Math.round(performance.now() - started);

const allSaveTimes = plan.students.flatMap((s) => s.saveTimesMs).sort((a, b) => a - b);
/**
 * ONE rng for the sample, and this is the second time I have written `createRng(seed)` INSIDE the per-draw callback --
 * which returns the same value every time, because a fresh generator at the same seed is the same generator. It
 * printed `p10 69482 ms, p90 69482 ms`, and a spread with a zero width is the shape a reader checks first.
 *
 * The identical mistake was in the harness test ten minutes earlier, and the note there says so. **A seeded
 * requirement that is satisfied by construction is easy to break by accident, and the symptom is a plausible-looking
 * number rather than a crash**, which is the worst kind.
 */
const shapeRng = createRng('shape').fork('y');
const think = Array.from({ length: 5_000 }, () => thinkTimeMs(shapeRng)).sort((a, b) => a - b);

console.log(`  students     : ${String(plan.students.length)}`);
console.log(`  planned saves: ${String(plan.totalSaves)}`);
console.log(
  `  save times   : p50 ${String(percentile(allSaveTimes, 50))} ms, p95 ${String(percentile(allSaveTimes, 95))} ms`,
);
console.log(
  `  think spread : p10 ${String(percentile(think, 10))} ms, p90 ${String(percentile(think, 90))} ms`,
);
console.log(`  generation   : ${String(durationMs)} ms`);
console.log('');

if (target === 'plan-only') {
  console.log('PLAN ONLY. The correctness assertions need a database leg:');
  console.log('  LOAD_TARGET=write-path pnpm test:load');
  console.log('');
  console.log(
    '  Nothing was asserted and nothing was written. A plan-only run exiting 0 is a REPORT, not a gate,',
  );
  console.log('  which is why the exit code below is only consulted on the leg that can assert.');
  console.log('');
  console.log(`  baseline: ${readBaseline() ? 'present' : 'NOT PRESENT'}`);
  process.exit(0);
}

// The database leg is the next increment; until it lands this prints the refusal rather than a fake pass.
console.error('LOAD_TARGET=write-path IS NOT IMPLEMENTED YET.');
console.error(
  '  The plan and the assertions exist and are tested; the leg that drives the write path does not.',
);
console.error(
  '  Exiting non-zero rather than 0, because a green load test that asserted nothing is the exact',
);
console.error('  failure this artefact exists to prevent.');
process.exit(1);

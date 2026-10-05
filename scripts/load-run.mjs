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

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * `.env.test` IS THE SOURCE OF THE DATABASE URL, AND IT WAS NEVER READ — the first run of this leg died with
 * `Environment variable not found: DATABASE_URL`, which `packages/db/vitest.integration.config.ts` had already
 * solved and recorded the same failure for. Loading it here is a copy of that fix rather than a shared helper, which
 * is the small duplication this repo has been eliminating all session; it is recorded rather than pretended away.
 */
const envTest = join(root, '.env.test');
if (existsSync(envTest)) {
  for (const line of readFileSync(envTest, 'utf8').split('\n')) {
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = (match[2] ?? '').replace(/^["']|["']$/g, '');
    }
  }
}
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

// ── the database leg ────────────────────────────────────────────────────────────────────────────────────────
const COMPRESSION = Number(process.env.LOAD_COMPRESSION ?? 50);
const CONCURRENCY = Number(process.env.LOAD_CONCURRENCY ?? 16);
const STAMPEDE = Number(process.env.LOAD_STAMPEDE ?? 0);

console.log(
  `  compression  : ${String(COMPRESSION)}x (contention is preserved; wall-clock latency is NOT meaningful)`,
);
console.log(`  concurrency  : ${String(CONCURRENCY)} writes in flight`);
console.log(`  stampede     : ${String(STAMPEDE)} attempts in the release batch`);
console.log('');

const { runLoadLeg } = await import(join(root, 'packages/load-profile/dist/leg.js'));
const { getPrisma } = await import(join(root, 'packages/db/dist/index.js'));
const db = getPrisma();

const legStart = performance.now();
let leg;
try {
  leg = await runLoadLeg({
    db,
    plan,
    seed: SEED,
    questionsPerStudent: QUESTIONS,
    compression: COMPRESSION,
    concurrency: CONCURRENCY,
    stampede: STAMPEDE,
    now: () => Date.now(),
  });
} finally {
  await db.$disconnect();
}
const legMs = Math.round(performance.now() - legStart);

const { correctness, created, cleanupDeleted } = leg;
console.log(`  attempts     : ${String(created.attempts)}`);
console.log(`  writes       : ${String(correctness.totalSaves)}`);
console.log(`  outcomes     : ${JSON.stringify(correctness.outcomes)}`);
console.log(`  5xx rate     : ${(correctness.errorRate5xx * 100).toFixed(3)}%`);
console.log(
  `  leg duration : ${String(legMs)} ms (COMPRESSED ${String(COMPRESSION)}x -- not a latency figure)`,
);
console.log(`  cleaned up   : ${String(cleanupDeleted)} top-level rows by id`);
console.log('');

/**
 * THE DECISION, AND IT IS CORRECTNESS ONLY.
 *
 * `plans/18` §11: latency without correctness assertions is how teams ship a load test that passes while the product
 * loses student answers. So a lost acknowledged save and a partial release are the two ways this run fails, and the
 * latency above is printed for the record and compared to nothing.
 */
const lost = correctness.lostAcknowledgedSaves;
const partial = correctness.partiallyReleased;
const failures = [];

if (lost.length > 0) {
  failures.push(
    `${String(lost.length)} acknowledged save(s) have no matching revision row. ` +
      `ASSERTIONS.lostAcknowledgedSaves is 0, not a percentage. First three:\n` +
      lost
        .slice(0, 3)
        .map((l) => `      ${l.questionId} rev ${String(l.acknowledgedRevision)} -- ${l.why}`)
        .join('\n'),
  );
}
for (const batch of partial) {
  failures.push(
    `batch ${batch.batchId} is PARTIALLY RELEASED: ${String(batch.released)} of ${String(batch.total)}. ` +
      'Visibility is EXISTS(... status=RELEASED), so half the class can see marks and half cannot.',
  );
}
if (correctness.errorRate5xx > 0.001) {
  failures.push(`5xx rate ${(correctness.errorRate5xx * 100).toFixed(3)}% exceeds 0.1%`);
}

const baseline = readBaseline();
const machine = {
  cpus: (await import('node:os')).availableParallelism?.() ?? 0,
  node: process.version,
  platform: process.platform,
};
const report = {
  schema: 1,
  task: 'P8-T16',
  provenance: PROVENANCE,
  scale,
  students: created.attempts,
  seed: SEED,
  target: 'write-path',
  startedAt: new Date().toISOString(),
  durationMs: legMs,
  compression: COMPRESSION,
  concurrency: CONCURRENCY,
  saves: {
    attempted: correctness.totalSaves,
    acknowledged: correctness.outcomes.saved,
    rejected: correctness.outcomes.rejected,
  },
  lostAcknowledgedSaves: lost.length,
  /** The FIRST FEW, because a count a reader must trust is not a report. */
  lostExamples: lost.slice(0, 10),
  partiallyReleasedMembers: partial.length,
  errorRate5xx: correctness.errorRate5xx,
  latency: {
    p50: percentile(allSaveTimes, 50),
    p95: percentile(allSaveTimes, 95),
    p99: percentile(allSaveTimes, 99),
  },
  machine,
  assertions: {
    lostAcknowledgedSaves: lost.length === 0,
    partiallyReleasedMembers: partial.length === 0,
    errorRate5xx: correctness.errorRate5xx <= 0.001,
  },
  passed: failures.length === 0,
};

console.log('  latency (MODELLED, not measured -- the timeline is compressed)');
console.log(`    p50 ${String(report.latency.p50)} ms, p95 ${String(report.latency.p95)} ms`);
console.log('');

if (process.env.LOAD_WRITE_BASELINE === '1') {
  writeBaseline(report);
  console.log('  baseline: WRITTEN');
} else {
  console.log('  baseline: not written (LOAD_WRITE_BASELINE=1)');
}

if (failures.length > 0) {
  console.error('');
  console.error(`FAILED -- ${String(failures.length)} correctness failure(s):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log('');
console.log('LOAD ARTEFACT PASSED');
console.log(
  '  The latency above describes the SYNTHETIC profile on a compressed timeline. It is not a capacity claim.',
);
process.exit(0);

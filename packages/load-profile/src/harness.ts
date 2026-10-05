/**
 * THE LOAD ARTEFACT.  (P8-T16)
 *
 * ## WHAT THIS IS, AND WHY IT IS AN ARTEFACT AND NOT A SCRIPT SOMEONE RUNS BY HAND
 *
 * `plans/18` §11 requires six properties — realistic, realistic saves, realistic deadline, **assertions**, repeatable,
 * versioned — and then says the thing that matters:
 *
 * > *"Latency without correctness assertions is how teams ship a load test that passes while the product loses
 * > student answers."*
 *
 * So the assertions here are the substance and the latency is a by-product. Three of the four are **counts that must
 * be exactly zero** and one is a bound:
 *
 * | assertion | value | what it catches |
 * |---|---|---|
 * | `lostAcknowledgedSaves` | **0** | an answer the server said it had, and did not |
 * | `partiallyReleasedMembers` | **0** | `B16` — a batch going half-visible |
 * | `max5xxRate` | 0.001 | error handling under contention |
 * | `p99SaveLatencyMs` | *recorded, not asserted* | regression against history |
 *
 * **THE LATENCY ONE IS DELIBERATELY NOT ASSERTED, AND THAT IS THE INTERESTING DECISION.** A committed latency
 * threshold invites somebody to enforce it on hardware weaker than it was taken on, and the suite then fails for a
 * reason that has nothing to do with the product. So the p99 is committed to `baseline.json` and a regression is
 * *visible against history* — which is what "versioned" actually means — while the pass/fail decision belongs to the
 * correctness assertions.
 *
 * ## THE SEEDED REQUIREMENT IS WHAT MAKES A FAILING RUN REPRODUCIBLE
 *
 * Every cohort member, every think time and every save burst comes from `@orrery/rng` forked off one seed. `seed` is
 * in the baseline, so "it failed last Tuesday" is a command rather than an anecdote.
 *
 * ## AND THE SCALE IS EXPLICIT BECAUSE A CALIBRATION IS NOT A SMALLER VERSION OF THE SAME TEST
 *
 * `test:load` runs the **calibration** (40 students) by default, because a 750-student run against a developer's
 * machine is a long job nobody re-runs, and a suite that is only ever run before a release is a suite that is only
 * ever run when something is already wrong. `LOAD_SCALE=full` runs the plan's figure. **The baseline records which ran
 * and the machine**, because a latency number without that pair of facts is not a measurement.
 *
 * ## WHAT IT MEASURES, AND THE LIMIT OF THAT
 *
 * It drives `submitAnswer` — the real write path, including its transaction and its `FOR UPDATE` — rather than making
 * HTTP requests. That is a deliberate trade and it cuts both ways: it measures the thing most likely to lose an answer
 * (the contended write), and it **does not measure the HTTP layer, serialisation, or the framework**. The target is
 * recorded in the baseline so the two are never confused. Measuring the HTTP path is `P15-T1`'s territory.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRng } from '@orrery/rng';

import { type ProfileProvenance, SAVE_SHAPE, THINK_TIME } from './index.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');

export interface LoadReport {
  readonly schema: 1;
  readonly task: 'P8-T16';
  /** The whole point: this number describes the profile, not real students. */
  readonly provenance: ProfileProvenance;
  readonly scale: 'calibration' | 'full';
  readonly students: number;
  readonly seed: string;
  /** What was driven. Recorded so the HTTP path and the write path are never confused. */
  readonly target: 'write-path' | 'http';
  readonly startedAt: string;
  readonly durationMs: number;
  readonly saves: {
    readonly attempted: number;
    readonly acknowledged: number;
    readonly rejected: number;
  };
  /** Everything below is a CORRECTNESS measurement except the last. */
  readonly lostAcknowledgedSaves: number;
  readonly partiallyReleasedMembers: number;
  readonly errorRate5xx: number;
  readonly latency: { readonly p50: number; readonly p95: number; readonly p99: number };
  /** So a latency comparison has the facts it needs to not be nonsense. */
  readonly machine: { readonly cpus: number; readonly node: string; readonly platform: string };
  readonly assertions: {
    readonly lostAcknowledgedSaves: boolean;
    readonly partiallyReleasedMembers: boolean;
    readonly errorRate5xx: boolean;
  };
  readonly passed: boolean;
}

/**
 * THINK TIME FROM A LOG-NORMAL, because `plans/18` §11 asks for a distribution and a uniform loop is not one.
 *
 * The floor and ceiling are not decoration: an unbounded log-normal puts a handful of students in the far tail where
 * they contribute nothing but wall-clock, and an unbounded fast student fires every save in the first second and
 * measures the harness rather than the cohort.
 */
export const thinkTimeMs = (rng: ReturnType<typeof createRng>): number => {
  // Box-Muller, one of the two values discarded: this is a load profile, not a statistics package, and the
  // discarded half costs less than the state it would take to keep it.
  const u1 = Math.max(Number.EPSILON, rng.next());
  const u2 = rng.next();
  const gaussian = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const raw = THINK_TIME.medianMs * Math.exp(THINK_TIME.sigma * gaussian);
  return Math.round(Math.min(THINK_TIME.ceilingMs, Math.max(THINK_TIME.floorMs, raw)));
};

/**
 * THE SAVE TIMES FOR ONE STUDENT, in the shape `plans/09` §9 describes.
 *
 * The burst-then-gap is the point: debounce after the last keystroke, an immediate flush on leaving a question, and a
 * heartbeat while still on one. **A suite that fires one save per question measures a system that never sees the real
 * shape** — the real shape is a cluster, and clusters are what contend.
 */
export const saveScheduleFor = (
  rng: ReturnType<typeof createRng>,
  questions: number,
): readonly number[] => {
  const times: number[] = [];
  let clock = 0;
  for (let question = 0; question < questions; question += 1) {
    clock += thinkTimeMs(rng);
    // One or two saves inside the question: the student typing, then the debounced flush.
    const inside = rng.bool(0.55) ? 2 : 1;
    for (let i = 0; i < inside; i += 1) {
      times.push(clock + (i === 0 ? 0 : SAVE_SHAPE.debounceMs));
    }
    if (SAVE_SHAPE.perAnsweredQuestion) times.push(clock + SAVE_SHAPE.debounceMs);
    if (SAVE_SHAPE.flushOnExit) times.push(clock + SAVE_SHAPE.debounceMs + 40);
  }
  return times.sort((a, b) => a - b);
};

/**
 * THE WHOLE COHORT'S WORK, as data, before anything touches a database.
 *
 * Generated up front and **not** as the run proceeds, because a profile that is computed lazily means the profile is
 * a function of the run's timing — and then the run is not repeatable, which is the one property the seed exists to
 * provide.
 */
export interface CohortPlan {
  readonly students: readonly StudentPlan[];
  readonly totalSaves: number;
}

export interface StudentPlan {
  readonly index: number;
  readonly questions: number;
  readonly saveTimesMs: readonly number[];
}

export const planCohort = (seed: string, students: number, questions: number): CohortPlan => {
  const root = createRng(seed);
  const plans: StudentPlan[] = [];
  let total = 0;
  for (let index = 0; index < students; index += 1) {
    /**
     * `fork` PER STUDENT, so adding a student does not shift every other student's schedule. With one shared stream,
     * changing the cohort size would change what student 400 does, and "the same seed reproduces the run" would hold
     * only for the exact cohort size it was taken at.
     */
    const rng = root.fork(`student:${String(index)}`);
    const saveTimesMs = saveScheduleFor(rng, questions);
    total += saveTimesMs.length;
    plans.push({ index, questions, saveTimesMs });
  }
  return { students: plans, totalSaves: total };
};

/** Percentiles, nearest-rank. Small-n friendly and it cannot invent a value the data does not contain. */
export const percentile = (sorted: readonly number[], p: number): number => {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))] ?? 0;
};

export const decide = (report: LoadReport): boolean =>
  report.assertions.lostAcknowledgedSaves &&
  report.assertions.partiallyReleasedMembers &&
  report.assertions.errorRate5xx;

/**
 * COMPARE AGAINST THE COMMITTED BASELINE AND FAIL ON A REGRESSION.
 *
 * The comparison is on the **correctness** numbers only, and both reports must agree on `provenance.kind`,
 * `scale` and `target` before anything is compared at all. **Comparing a calibration run's p99 against a full cohort's
 * is not a regression, it is two different measurements**, and a suite that reports it as one is worse than no suite.
 */
export const compareToBaseline = (
  report: LoadReport,
  baseline: LoadReport | null,
): { readonly regressions: readonly string[] } => {
  if (baseline === null) return { regressions: [] };
  if (baseline.provenance.kind !== report.provenance.kind) {
    return {
      regressions: [
        `provenance changed (${baseline.provenance.kind} -> ${report.provenance.kind}): a correctness comparison ` +
          'across profiles is not a comparison',
      ],
    };
  }
  if (baseline.scale !== report.scale || baseline.target !== report.target) {
    return {
      regressions: [
        `scale/target changed (${baseline.scale}/${baseline.target} -> ${report.scale}/${report.target}): ` +
          'latency from a different shape is not a regression',
      ],
    };
  }
  const regressions: string[] = [];
  if (report.lostAcknowledgedSaves > baseline.lostAcknowledgedSaves) {
    regressions.push(
      `lostAcknowledgedSaves ${String(report.lostAcknowledgedSaves)} > baseline ` +
        `${String(baseline.lostAcknowledgedSaves)}`,
    );
  }
  if (report.partiallyReleasedMembers > baseline.partiallyReleasedMembers) {
    regressions.push(
      `partiallyReleasedMembers ${String(report.partiallyReleasedMembers)} > baseline ` +
        `${String(baseline.partiallyReleasedMembers)}`,
    );
  }
  return { regressions };
};

export const BASELINE_PATH = join(repoRoot, 'packages', 'load-profile', 'baseline.json');

export const readBaseline = (): LoadReport | null => {
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as LoadReport;
  } catch {
    return null;
  }
};

export const writeBaseline = (report: LoadReport): void => {
  mkdirSync(dirname(BASELINE_PATH), { recursive: true });
  writeFileSync(BASELINE_PATH, `${JSON.stringify(report, null, 2)}\n`);
};

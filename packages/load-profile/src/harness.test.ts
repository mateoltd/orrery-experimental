import { createRng } from '@orrery/rng';
import { describe, expect, it } from 'vitest';
import {
  type CohortPlan,
  compareToBaseline,
  decide,
  type LoadReport,
  percentile,
  planCohort,
  saveScheduleFor,
  thinkTimeMs,
} from './harness.js';
import { THINK_TIME } from './index.js';

const SEED = 'p8-t16-baseline';

describe('the profile is REPEATABLE, which is the only reason a failing run is diagnosable', () => {
  it('the same seed produces the same cohort, byte for byte', () => {
    expect(planCohort(SEED, 40, 8)).toEqual(planCohort(SEED, 40, 8));
  });

  it('a different seed produces a different cohort', () => {
    const a = planCohort('a', 20, 8);
    const b = planCohort('b', 20, 8);
    expect(a).not.toEqual(b);
  });

  /**
   * ADDING A STUDENT MUST NOT CHANGE WHAT THE OTHERS DO.
   *
   * With one shared random stream, growing the cohort from 750 to 751 shifts every subsequent draw, so student 400's
   * think times change -- and "the same seed reproduces the run" would then hold only for the exact cohort size the
   * baseline was taken at. The per-student `fork` is what makes a baseline comparable across a change in scale, which
   * is the whole reason `compareToBaseline` refuses to compare across scales anyway.
   */
  it('a cohort is a PREFIX of a larger one — each student is forked independently', () => {
    const small = planCohort(SEED, 10, 8);
    const large = planCohort(SEED, 40, 8);
    expect(large.students.slice(0, 10)).toEqual(small.students);
    expect(small.totalSaves).toBe(small.students.reduce((sum, s) => sum + s.saveTimesMs.length, 0));
  });

  it('and the profile is generated BEFORE the run, so a run is not a function of its own timing', () => {
    const plan: CohortPlan = planCohort(SEED, 5, 4);
    expect(plan.totalSaves).toBeGreaterThan(0);
    // Every save time is finite and non-negative: a NaN here would become a `setTimeout` that fires immediately.
    for (const student of plan.students) {
      for (const t of student.saveTimesMs) {
        expect(Number.isFinite(t)).toBe(true);
        expect(t).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe('think time is a DISTRIBUTION, not a flat loop', () => {
  it('is bounded at both ends by the declared profile, over 5,000 draws', () => {
    // NOT an `fc.property` over the rng: an rng is not an `Arbitrary`, and passing one is a type error the compiler
    // does not catch because the property's parameter type is inferred. My first version did exactly that and it
    // failed at run time with "not an instance of Arbitrary" -- so the lesson is that a property test whose subject is
    // a SEED wants `fc.integer()` or a constant, not the generator itself.
    const rng = createRng('t').fork('x');
    for (let i = 0; i < 5_000; i += 1) {
      const t = thinkTimeMs(rng);
      expect(t).toBeGreaterThanOrEqual(THINK_TIME.floorMs);
      expect(t).toBeLessThanOrEqual(THINK_TIME.ceilingMs);
      // NaN would pass neither bound, and would become a `setTimeout` that fires immediately.
      expect(Number.isFinite(t)).toBe(true);
    }
  });

  /**
   * A UNIFORM LOOP IS WHAT THE PLAN REJECTS, AND THIS IS HOW IT WOULD SHOW UP.
   *
   * `plans/18` §11 asks for think-time distributions because a cohort where every student acts at the same instant is
   * not a cohort, it is a thundering herd — and the herd is precisely what finds the lock contention worth finding. The
   * assertion is on the SPREAD, not the mean, because a wrong mean and a right spread would both make the load
   * unrepresentative while only one of them shows up in a latency average.
   */
  it('produces a real spread, and the tail is what makes contention visible', () => {
    // ONE rng for the whole sample. My first version created a fresh `Date.now()`-seeded rng PER DRAW, which made the
    // test unrepeatable -- the same defect the seed requirement exists to prevent, inside the test that enforces it.
    const rng = createRng('spread').fork('y');
    const times = Array.from({ length: 5_000 }, () => thinkTimeMs(rng));
    const sorted = [...times].sort((a, b) => a - b);
    const p10 = percentile(sorted, 10);
    const p90 = percentile(sorted, 90);

    /**
     * THE SPREAD IS CHECKED AGAINST THE DECLARED `sigma`, NOT AGAINST A NUMBER I PICKED.
     *
     * For a log-normal, `ln(p90/p10) = 2 * z(0.90) * sigma`, and `z(0.90) = 1.2816`. So the expected ratio is
     * `exp(2 * 1.2816 * 0.55) = 1.857` -- and my first assertion was `expect(p90/p10).toBeGreaterThan(2)`, which this
     * distribution does NOT satisfy. The assertion was wrong and the profile was right, in the way that matters: a
     * hand-picked threshold would have "fixed" the profile by widening its spread, and then the artefact would claim a
     * distribution it does not have. Tying the assertion to the parameter means a change to `sigma` has to change the
     * expectation, which is the point of declaring the parameter at all.
     */
    const expectedRatio = Math.exp(2 * 1.2816 * THINK_TIME.sigma);
    const actualRatio = p90 / p10;
    expect(actualRatio / expectedRatio).toBeGreaterThan(0.9);
    expect(actualRatio / expectedRatio).toBeLessThan(1.1);
    // And some students are genuinely slow, because a cohort where nobody hesitates does not exist.
    expect(sorted.filter((t) => t > THINK_TIME.medianMs).length).toBeGreaterThan(200);
  });

  it('centres near the declared median', () => {
    const rng = createRng('centre').fork('z');
    const times = Array.from({ length: 2_000 }, () => thinkTimeMs(rng));
    const median = percentile(
      [...times].sort((a, b) => a - b),
      50,
    );
    // A log-normal's median is the multiplier, so this should be close; the tolerance is generous on purpose because
    // the assertion is "roughly the declared shape", not a statistical test.
    expect(median).toBeGreaterThan(THINK_TIME.medianMs * 0.7);
    expect(median).toBeLessThan(THINK_TIME.medianMs * 1.4);
  });
});

describe('saves arrive in BURSTS, because clusters are what contend', () => {
  it('produces more than one save per question for most students', () => {
    const rng = createRng('burst').fork('q');
    // `plans/18` §11: "Answer saves at the observed debounce rate, not a synthetic 10 rps". One save per question is
    // the synthetic shape.
    const schedule = saveScheduleFor(rng, 10);
    expect(schedule.length).toBeGreaterThan(10);
  });

  it('is sorted, so the driver can replay it in order without sorting at run time', () => {
    const rng = createRng('sorted').fork('q');
    const schedule = saveScheduleFor(rng, 12);
    for (let i = 1; i < schedule.length; i += 1) {
      expect(schedule[i] ?? 0).toBeGreaterThanOrEqual(schedule[i - 1] ?? 0);
    }
  });
});

const report = (over: Partial<LoadReport> = {}): LoadReport => ({
  schema: 1,
  task: 'P8-T16',
  provenance: { kind: 'SYNTHETIC', reason: 'test' },
  scale: 'calibration',
  students: 40,
  seed: SEED,
  target: 'write-path',
  startedAt: '2026-10-05T00:00:00.000Z',
  durationMs: 1_000,
  saves: { attempted: 100, acknowledged: 100, rejected: 0 },
  lostAcknowledgedSaves: 0,
  partiallyReleasedMembers: 0,
  errorRate5xx: 0,
  latency: { p50: 1, p95: 2, p99: 3 },
  machine: { cpus: 8, node: 'test', platform: 'linux' },
  assertions: { lostAcknowledgedSaves: true, partiallyReleasedMembers: true, errorRate5xx: true },
  passed: true,
  ...over,
});

describe('the DECISION is correctness, and latency is recorded rather than asserted', () => {
  it('passes with a terrible p99 — deliberately', () => {
    // `ASSERTIONS.recordP99SaveLatencyMs` records it; nothing compares it. A committed latency THRESHOLD invites
    // somebody to enforce it on hardware weaker than the baseline was taken on, and the suite then fails for a reason
    // that has nothing to do with the product.
    const slow = report({ latency: { p50: 900, p95: 4_000, p99: 9_000 } });
    expect(decide(slow)).toBe(true);
    // ...but it is IN the report, so a regression is visible against history. That is what "versioned" means.
    expect(slow.latency.p99).toBe(9_000);
  });

  it('fails on ONE lost acknowledged save, because the assertion is a count and not a percentage', () => {
    const lost = report({
      lostAcknowledgedSaves: 1,
      assertions: { ...report().assertions, lostAcknowledgedSaves: false },
    });
    expect(decide(lost)).toBe(false);
    // A percentage threshold would have passed this at 1%. Four students finding out at marking time is the harm.
    expect(lost.lostAcknowledgedSaves).toBeGreaterThan(0);
  });

  it('fails on a PARTIAL release even when every save landed', () => {
    const partial = report({
      partiallyReleasedMembers: 3,
      assertions: { ...report().assertions, partiallyReleasedMembers: false },
    });
    expect(decide(partial)).toBe(false);
  });

  it('fails above the 5xx bound', () => {
    const bad = report({
      errorRate5xx: 0.01,
      assertions: { ...report().assertions, errorRate5xx: false },
    });
    expect(decide(bad)).toBe(false);
  });
});

describe('the baseline refuses to compare things that are not comparable', () => {
  it('refuses across SCALES — a calibration p99 is not a full-cohort p99', () => {
    const result = compareToBaseline(report({ scale: 'full' }), report({ scale: 'calibration' }));
    expect(result.regressions).toHaveLength(1);
    expect(result.regressions[0]).toMatch(/scale\/target changed/);
  });

  it('refuses across TARGETS — the write path and the HTTP path are different measurements', () => {
    const result = compareToBaseline(report({ target: 'http' }), report({ target: 'write-path' }));
    expect(result.regressions[0]).toMatch(/scale\/target changed/);
  });

  /**
   * REFUSES ACROSS PROVENANCE, AND THIS IS THE ONE THAT MATTERS MOST.
   *
   * When `P17-T4` replaces the synthetic profile with measured percentiles, every number in the new report is
   * describing different work. A regression check across that boundary would report a flood of "regressions" that are
   * the profile changing, and the habit of reading a red suite as a red product would be trained exactly when it is
   * most expensive.
   */
  it('refuses across PROVENANCE, and says why', () => {
    const measured = report({
      provenance: { kind: 'MEASURED', source: 'p17', observedAt: '2027-01-01' },
    });
    const result = compareToBaseline(measured, report());
    expect(result.regressions[0]).toMatch(/provenance changed/);
    expect(result.regressions[0]).toMatch(/not a comparison/);
  });

  it('reports a real correctness regression on the SAME shape', () => {
    const result = compareToBaseline(
      report({ lostAcknowledgedSaves: 2, partiallyReleasedMembers: 1 }),
      report(),
    );
    expect(result.regressions).toHaveLength(2);
    expect(result.regressions[0]).toMatch(/lostAcknowledgedSaves 2 > baseline 0/);
  });

  it('does NOT report a latency regression, because latency is recorded rather than asserted', () => {
    const result = compareToBaseline(
      report({ latency: { p50: 1, p95: 2, p99: 99_999 } }),
      report(),
    );
    expect(result.regressions).toEqual([]);
  });

  it('has no baseline to compare against and says so rather than passing silently', () => {
    expect(compareToBaseline(report(), null)).toEqual({ regressions: [] });
  });
});

describe('percentiles cannot invent a value', () => {
  it('returns 0 for an empty sample rather than NaN', () => {
    expect(percentile([], 99)).toBe(0);
  });

  it('nearest-rank: a real value from the data, never an interpolation between them', () => {
    expect(percentile([10, 20, 30, 40], 50)).toBe(20);
    expect(percentile([10, 20, 30, 40], 100)).toBe(40);
    expect(percentile([10, 20, 30, 40], 1)).toBe(10);
  });
});

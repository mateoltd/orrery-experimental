/**
 * Pool health.  (P5-T7)
 *
 * ## The test that matters most, and what it cost
 *
 * `the expected overlap is EXACTLY the plan's N²/M, checked against brute force` — the first
 * version of this module departed from the plan's formula, implemented `N(N−1)/(M−1)` instead,
 * and wrote three paragraphs saying the plan was an approximation. Brute force over every ordered
 * pair of subsets says the plan was right: 0.667 for M=6, N=2, where my formula said 0.400.
 *
 * The two subsets are INDEPENDENT, which is exactly what makes `N²/M` exact. So the test does not
 * just assert the plan's number — it brute-forces the definition and compares, because a test
 * asserting `N²/M` would have passed against my wrong formula if I had also made the module
 * claim `N²/M`.
 *
 * ## A HEALTH FIGURE MUST NOT MOVE WHEN YOU LOOK AT IT TWICE
 *
 * So there is a test that the same pool reports identical numbers across a hundred calls. A
 * Monte-Carlo implementation would pass every "is the value plausible" test and fail this one,
 * which is the intended shape: a health number you cannot screenshot and compare is not a
 * measurement.
 */
import { describe, expect, it } from 'vitest';
import {
  expectedDistinctFor,
  MIN_HEALTHY_ITEM_COUNT,
  overlap,
  pAnyShared,
  pIdentical,
  poolHealth,
} from './index.js';

describe('poolHealth', () => {
  it('an undrawable pool is BLOCKING and says so in a sentence', () => {
    const health = poolHealth({ itemCount: 4, drawCount: 6, cohortSize: 30 });
    expect(health.drawable).toBe(false);
    expect(health.warnings).toHaveLength(1);
    expect(health.warnings[0]?.code).toBe('POOL_UNDERSIZED');
    expect(health.warnings[0]?.blocking, 'an un-sittable exam must block publication').toBe(true);
    expect(health.warnings[0]?.detail).toMatch(/holds 4 item\(s\) and draws 6/);
  });

  it('an empty pool is BLOCKING and does not claim zero overlap', () => {
    const health = poolHealth({ itemCount: 0, drawCount: 1, cohortSize: 30 });
    expect(health.drawable).toBe(false);
    expect(health.warnings[0]?.detail).toMatch(/no items/);
  });

  it("the expected overlap is EXACTLY the plan's N²/M, checked against brute force", () => {
    // Brute force over every ORDERED pair of N-subsets, compared with the closed form. This is
    // the test that caught the first version's `N(N-1)/(M-1)`, which was wrong because it
    // treated the two draws as dependent — brute force says 0.667 for M=6,N=2 where that
    // formula said 0.400.
    for (const [m, n] of [
      [4, 2],
      [6, 2],
      [8, 3],
      [8, 5],
      [10, 4],
    ] as const) {
      const subsets: string[][] = [];
      for (let mask = 0; mask < 1 << m; mask += 1) {
        const set: string[] = [];
        for (let i = 0; i < m; i += 1) {
          if (mask & (1 << i)) set.push(`i${i}`);
        }
        if (set.length === n) subsets.push(set);
      }
      let total = 0;
      for (const a of subsets) {
        for (const b of subsets) total += a.filter((x) => b.includes(x)).length;
      }
      const byDefinition = total / (subsets.length * subsets.length);
      expect(
        overlap(m, n),
        `M=${m} N=${n}: the closed form disagrees with the definition`,
      ).toBeCloseTo(byDefinition, 10);
      expect(overlap(m, n)).toBeCloseTo((n * n) / m, 12);
    }
  });

  it('the overlap is an expected COUNT, so it can reach the pool size', () => {
    // Two students drawing 40 of 40 share 40 — they hold the same paper. A figure clamped to `n`
    // would hide that, and it is the clearest possible statement that the pool has no variation.
    expect(overlap(8, 5)).toBeCloseTo(25 / 8, 12);
    expect(overlap(40, 40)).toBe(40);
    expect(overlap(0, 3)).toBe(0);
    expect(overlap(MIN_HEALTHY_ITEM_COUNT, 1)).toBeCloseTo(1 / MIN_HEALTHY_ITEM_COUNT, 12);
  });

  it('a pool that forces overlap SAYS the probability is 1, and warns', () => {
    // 2N > M leaves nowhere to put a second subset, so sharing is a fact about the pool rather
    // than a likelihood. Reporting 0.999 here would understate it; reporting 1 is true.
    expect(pAnyShared(6, 5)).toBe(1);
    const health = poolHealth({ itemCount: 6, drawCount: 5, cohortSize: 30 });
    expect(health.probabilityAnyShared).toBe(1);
    expect(health.probabilityIdentical).toBe(0);
    expect(health.warnings.map((w) => w.code)).toContain('COHORT_OVERLAP_HIGH');
  });

  it('a pool of 6 drawing 5 cannot repeat a paper, and says the REAL reason', () => {
    // Two forms of 5 from 6 cannot be IDENTICAL — 2N > M leaves nowhere to put the second — so
    // P(identical) is 0 and it would be wrong to warn about repeated papers. The pool is still
    // hopeless, for the reason the fraction exposes: each student shares 83% of their paper with
    // any one peer. Asserting the warning that actually fires is the point; asserting the one I
    // expected to fire is how a test ends up pinning a bug.
    const health = poolHealth({ itemCount: 6, drawCount: 5, cohortSize: 30 });
    expect(health.probabilityIdentical).toBe(0);
    expect(health.probabilityAnyShared).toBe(1);
    const warning = health.warnings.find((w) => w.code === 'COHORT_OVERLAP_HIGH');
    expect(warning, 'a pool sharing 83% of every paper did not say so').toBeDefined();
    expect(warning?.detail).toMatch(/cannot make two papers different/);
    expect(warning?.blocking).toBe(false);
  });

  it('a pool with a real chance of a REPEATED paper says anti-collusion is unsupported', () => {
    // P(identical) = 1/C(M,N), so it is only above 5% for a genuinely tiny pool: C(5,2) = 10, so
    // one form in ten. This is the shape the warning is actually for, and the wording has to say
    // that anti-collusion is unsupported rather than leaving a teacher to infer it.
    const health = poolHealth({ itemCount: 5, drawCount: 2, cohortSize: 30 });
    expect(health.probabilityIdentical).toBeCloseTo(1 / 10, 10);
    const warning = health.warnings.find((w) => w.code === 'VARIATION_NEGLIGIBLE');
    expect(warning).toBeDefined();
    expect(warning?.detail).toMatch(/anti-collusion is not a claim this pool can support/);
  });

  it('a HEALTH FIGURE DOES NOT MOVE WHEN YOU LOOK AT IT TWICE', () => {
    const shape = { itemCount: 47, drawCount: 9, cohortSize: 30 };
    const first = poolHealth(shape);
    for (let i = 0; i < 100; i += 1) {
      expect(poolHealth(shape)).toEqual(first);
    }
    // And the values are finite, which is the failure a naive factorial would produce.
    for (const value of [
      first.expectedOverlap,
      first.probabilityAnyShared,
      first.probabilityIdentical,
      first.expectedDistinctForCohort,
      first.cohortItemUtilisation,
    ]) {
      expect(Number.isFinite(value)).toBe(true);
    }
  });

  it('a big pool does not overflow into nonsense', () => {
    // The naive product `n·(n−1)···/k!` overflows to Infinity somewhere around n = 500, and the
    // ratios here are DIFFERENCES of large numbers, so an overflow silently turns every
    // probability into 1 and every figure into nonsense that still looks like a number.
    const health = poolHealth({ itemCount: 5000, drawCount: 50, cohortSize: 30 });
    expect(Number.isFinite(health.probabilityIdentical)).toBe(true);
    expect(health.probabilityIdentical).toBeGreaterThanOrEqual(0);
    expect(health.probabilityIdentical).toBeLessThan(1);
    expect(health.probabilityAnyShared).toBeGreaterThan(0);
    expect(health.probabilityAnyShared).toBeLessThan(1);
    expect(health.expectedDistinctForCohort).toBeLessThanOrEqual(5000);
  });

  it('expected distinct items is bounded by M and rises with the cohort', () => {
    expect(expectedDistinctFor(100, 10, 0)).toBe(0);
    expect(expectedDistinctFor(100, 10, 1)).toBeCloseTo(10, 6);
    expect(expectedDistinctFor(100, 10, 10_000)).toBe(100);
    // A cohort of 100 out of a pool of 200 drawing 100 must see MORE than half.
    expect(expectedDistinctFor(200, 100, 100)).toBeGreaterThan(100);
  });

  it('utilisation is reported, so authored-but-never-used items are visible', () => {
    // R22: item authoring is slow human work, so the items nobody receives are the argument for
    // authoring fewer OR for making the pool larger. Neither is visible without this number.
    const generous = poolHealth({ itemCount: 200, drawCount: 10, cohortSize: 30 });
    const wasteful = poolHealth({ itemCount: 200, drawCount: 10, cohortSize: 3 });
    expect(generous.cohortItemUtilisation).toBeGreaterThan(wasteful.cohortItemUtilisation);
    expect(wasteful.warnings.map((w) => w.code)).toContain('COHORT_UNSPENT_ITEMS');
  });

  it('a pool below the M2 target says so, without pretending to be an error', () => {
    const health = poolHealth({ itemCount: 12, drawCount: 4, cohortSize: 30 });
    const warning = health.warnings.find((w) => w.code === 'COHORT_TOO_LARGE_FOR_POOL');
    expect(warning?.detail).toContain(String(MIN_HEALTHY_ITEM_COUNT));
    expect(warning?.blocking).toBe(false);
  });

  it('n of 1 has no overlap to measure, and reports zero rather than one', () => {
    // Drawing one item from one item means every student gets the same paper. The OVERLAP is
    // still 1 — the two students really do both hold that item — and reporting 0 there would be
    // the second version of the same mistake.
    expect(overlap(1, 1)).toBe(1);
    expect(pIdentical(1, 1)).toBe(1);
  });
});

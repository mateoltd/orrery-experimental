/**
 * Pool health: what a pool actually buys, measured rather than asserted.  (P5-T7)
 *
 * ## WHY THIS EXISTS, IN THE PLAN'S OWN WORDS
 *
 * `plans/06` §7: "pools are only as good as the item bank behind them, and item authoring is
 * slow human work. The plan's job is to make the *mechanism* correct and to make the shortfall
 * VISIBLE (`poolHealth`, zero-result search logs, `expected overlap`) so the shortfall gets
 * prioritised rather than discovered. Shipping a variation feature over an empty bank would be
 * theatre."
 *
 * And `plans/00` R22: "Item banks may not exist. The anti-collusion claim rests on pools, and
 * nothing authored a single question." This module is the answer to R22 that is actually
 * computable before the authoring work happens: a teacher can see that a pool of 6 items drawing
 * 5 gives two students a one-in-thirty chance of a completely different paper, and decide
 * whether to author more items or to stop claiming anti-collusion.
 *
 * ## `N²/M` IS EXACT, AND I TRIED TO "FIX" IT INTO BEING WRONG
 *
 * `plans/20` P5-T7 asks for "expected overlap **`N²/M`**". The first version of this file
 * departed from the plan: it implemented `N(N−1)/(M−1)` on the reasoning that two items drawn
 * without replacement are not independent, and wrote three paragraphs justifying the departure.
 *
 * **The plan was right and the derivation was wrong.** A and B are two *independent* N-subsets of
 * the same M-set — independence is the property that makes the product rule apply:
 *
 * ```
 * E[|A ∩ B|] = Σ_i P(i ∈ A ∧ i ∈ B) = Σ_i P(i ∈ A)·P(i ∈ B) = M · (N/M)² = N²/M
 * ```
 *
 * The without-replacement correction belongs *within* one draw, and it cancels out of this sum.
 * `N(N−1)/(M−1)` is the expectation for a DIFFERENT experiment — drawing B from the complement of
 * A, so no item can appear in both — which is a pool that guarantees zero overlap, the opposite
 * of what a question pool is for.
 *
 * The brute-force test caught it: for M=6, N=2 the true expected overlap is 0.667 and my formula
 * said 0.400. It is worth recording that the error was dressed up as an improvement, because
 * "the plan is the approximation and I have the exact version" is exactly the sentence that
 * makes a reader stop checking. **A departure from a written plan needs a test that fails on the
 * plan's own formula, not a paragraph about why the plan is wrong.**
 *
 * ## THE PROBABILITIES ARE EXACT, NOT SIMULATED
 *
 * Every number here is closed-form. A Monte-Carlo estimate would be tempting — it is easy, and
 * `resample` looks plausible — and it would make a health figure that changes every time a
 * teacher opens the page, so two screenshots of the same pool would disagree. A health number
 * you cannot screenshot and compare is not a measurement.
 */

export interface PoolShape {
  /** M: items in the pool. */
  readonly itemCount: number;
  /** N: items drawn per form. */
  readonly drawCount: number;
  /** How many students will sit it. Defaults matter: the plan's target cohort is 30 (M10). */
  readonly cohortSize: number;
}

export interface PoolHealth {
  readonly m: number;
  readonly n: number;
  readonly cohortSize: number;
  /** `false` when the pool cannot be drawn at all. Everything below is then advisory. */
  readonly drawable: boolean;
  /** `N²/M`. The expected number of items two students BOTH receive. Exact, not a limit. */
  readonly expectedOverlap: number;
  /**
   * `expectedOverlap / n`, which is exactly `N/M`.
   *
   * THIS is the number a teacher can act on, and it is the reason the module reports a fraction
   * as well as a count. `expectedOverlap` grows with the paper size, so a pool of 120 drawing 20
   * reports 3.33 shared items and a pool of 6 drawing 5 reports 4.17 — which look like the same
   * problem and are not. As a FRACTION each student shares 17% of their paper with a given peer
   * in the first and 83% in the second, and that is the difference between "reasonable" and
   * "the anti-collusion claim is decoration".
   */
  readonly expectedOverlapFraction: number;
  /** P(≥1 shared item) between two students' papers. */
  readonly probabilityAnyShared: number;
  /** P(two students receive IDENTICAL papers). */
  readonly probabilityIdentical: number;
  /** Expected number of DISTINCT items a cohort of `cohortSize` students actually sees. */
  readonly expectedDistinctForCohort: number;
  /** `expectedDistinctForCohort / m`. 1 means every item gets used. */
  readonly cohortItemUtilisation: number;
  readonly warnings: readonly PoolWarning[];
}

export interface PoolWarning {
  readonly code: PoolWarningCode;
  readonly detail: string;
  /**
   * `true` when this BLOCKS publication and `false` when it is advisory.
   *
   * `plans/06` §7's whole argument is that a shortfall should be VISIBLE and prioritised, not
   * that it should stop a teacher teaching. So the only blocking warning is the one that makes the
   * exam un-sittable; everything else is a number a teacher can weigh against their authoring
   * budget.
   */
  readonly blocking: boolean;
}

export type PoolWarningCode =
  | 'POOL_UNDERSIZED'
  | 'VARIATION_NEGLIGIBLE'
  | 'COHORT_OVERLAP_HIGH'
  | 'COHORT_UNSPENT_ITEMS'
  | 'COHORT_TOO_LARGE_FOR_POOL';

/** The M2 target from `plans/06` §7, and the number a "good" pool is measured against. */
export const MIN_HEALTHY_ITEM_COUNT = 40;

export function poolHealth(shape: PoolShape): PoolHealth {
  const m = Math.max(0, Math.trunc(shape.itemCount));
  const n = Math.max(0, Math.trunc(shape.drawCount));
  const cohortSize = Math.max(1, Math.trunc(shape.cohortSize));
  const drawable = m >= n && n > 0;

  const expectedOverlap = overlap(m, n);
  const warnings: PoolWarning[] = [];

  if (!drawable) {
    warnings.push({
      code: 'POOL_UNDERSIZED',
      detail:
        m === 0
          ? 'this pool has no items, so there is nothing to draw'
          : `this pool holds ${m} item(s) and draws ${n}; it cannot be sat`,
      blocking: true,
    });
    return {
      m,
      n,
      cohortSize,
      drawable: false,
      expectedOverlap: 0,
      expectedOverlapFraction: 0,
      probabilityAnyShared: 1,
      probabilityIdentical: 1,
      expectedDistinctForCohort: 0,
      cohortItemUtilisation: 0,
      warnings,
    };
  }

  const probabilityAnyShared = pAnyShared(m, n);
  const probabilityIdentical = pIdentical(m, n);
  const expectedDistinct = expectedDistinctFor(m, n, cohortSize);

  if (probabilityIdentical > 0.05) {
    warnings.push({
      code: 'VARIATION_NEGLIGIBLE',
      detail:
        `two students have a ${pct(probabilityIdentical)} chance of receiving an identical paper; ` +
        'anti-collusion is not a claim this pool can support',
      blocking: false,
    });
  }
  // The threshold is on the FRACTION, not on `probabilityAnyShared`.
  //
  // The first version warned when P(≥1 shared) exceeded 0.7, and that made the warning true for
  // every pool worth having: at M=120, N=20 it is 0.98, because two students drawing 20 items
  // each from 120 almost always overlap SOMEWHERE. A warning that fires on every real pool is
  // noise, and noise in a health figure is how the figure stops being read.
  //
  // "Each student shares more than half their paper with any one peer" is a real threshold, it
  // corresponds to N/M > 0.5, and it is the boundary at which anti-collusion stops being a claim
  // about the paper and starts being a claim about two or three questions.
  if (n / m > 0.5) {
    warnings.push({
      code: 'COHORT_OVERLAP_HIGH',
      detail:
        `each student is expected to share ${pct(n / m)} of their paper with any one peer; ` +
        'a pool this size cannot make two papers different in any meaningful sense',
      blocking: false,
    });
  }
  if (expectedDistinct / m < 0.5) {
    warnings.push({
      code: 'COHORT_UNSPENT_ITEMS',
      detail:
        `a cohort of ${cohortSize} sees about ${expectedDistinct.toFixed(1)} of ${m} items; ` +
        `${(m - expectedDistinct).toFixed(1)} are authored and never used`,
      blocking: false,
    });
  }
  if (m < MIN_HEALTHY_ITEM_COUNT) {
    warnings.push({
      code: 'COHORT_TOO_LARGE_FOR_POOL',
      detail: `${m} items is below the ${MIN_HEALTHY_ITEM_COUNT}-item M2 target for a healthy pool`,
      blocking: false,
    });
  }

  return {
    m,
    n,
    cohortSize,
    drawable: true,
    expectedOverlap,
    expectedOverlapFraction: m === 0 ? 0 : n / m,
    probabilityAnyShared,
    probabilityIdentical,
    expectedDistinctForCohort: expectedDistinct,
    cohortItemUtilisation: expectedDistinct / m,
    warnings,
  };
}

/**
 * Expected number of items two students BOTH receive: `N²/M`, exact.
 *
 * Fix one item `i`. `P(i ∈ A) = N/M` and, because A and B are drawn **independently**,
 * `P(i ∈ B) = N/M` whatever A turned out to be — so `P(i ∈ A ∧ i ∈ B) = (N/M)²`. Summing over
 * the M items gives `M(N/M)² = N²/M`.
 *
 * The without-replacement correction cancels: it changes how likely the second draw is to pick
 * the *same* item as the first draw, but `P(i ∈ B)` is unconditional here, so the correction
 * never enters. The test brute-forces every ordered pair of subsets for small M and this is
 * checked against it.
 *
 * `m === 0` is guarded because `N²/M` divides by M, and an empty pool has no overlap to report
 * in any sense.
 */
export function overlap(m: number, n: number): number {
  if (m <= 0) return 0;
  return (n * n) / m;
}

/**
 * P(two independent N-subsets of an M-set share at least one item).
 *
 * By the complement: the probability of NO shared item is the probability the second subset lies
 * entirely inside the `M−N` items the first did not take, which is `C(M−N, N) / C(M, N)`. When
 * `2N > M` there is nowhere left to put the second subset, so the answer is 1 — and that is a
 * genuine fact about a small pool, not a numeric edge case: a pool of 6 drawing 5 guarantees
 * every pair of students shares at least four items.
 */
export function pAnyShared(m: number, n: number): number {
  if (n >= m) return 1;
  if (2 * n > m) return 1;
  // 1 − C(M−N, N)/C(M−N, N over C(M,N)) — as a RATIO, so the difference has to be inside the
  // exponent. The first version wrote `1 - logChoose(m-n, n) + logChoose(m, n)`, which by
  // precedence is `(1 − lnC(M−N,N)) + lnC(M,N)` — not a probability, and a large positive one.
  // The `2n > m` shortcut above is what kept that bug from being caught: every test case that
  // reached this line returned 1 for the shortcut's reason.
  const disjoint = Math.exp(logChoose(m - n, n) - logChoose(m, n));
  return 1 - disjoint;
}

/** P(two independent N-subsets of an M-set are identical). */
export function pIdentical(m: number, n: number): number {
  if (n >= m) return 1;
  if (2 * n > m) return 0;
  return Math.exp(-logChoose(m, n));
}

/**
 * Expected number of distinct items a cohort of `k` students sees.
 *
 * For one item: the chance it is used by NOBODY in the cohort is `C(M−N, k) / C(M, k)`, because
 * all k students would have to miss it. So the chance it IS used is the complement, and summing
 * over M items gives the expected count.
 */
export function expectedDistinctFor(m: number, n: number, k: number): number {
  if (m === 0) return 0;
  if (k <= 0) return 0;
  if (k >= m) return m;
  // `m - n < k` means there are fewer items OUTSIDE one form than there are students, so the
  // cohort cannot possibly all avoid one item: it is used, and the chance of being unused is 0.
  //
  // This guard was missing, and the arithmetic it replaced was `−∞ − (−∞) = NaN`. The clamp could
  // not rescue it, because `Math.min(1, NaN)` is `NaN` rather than 1. So a pool of 6 drawing 5
  // with a cohort of 30 reported `NaN` distinct items, and `NaN / m` for utilisation — a health
  // figure that is not a number, in the exact configuration a first-term teacher is most likely
  // to build.
  if (m - n < k) return m;
  const chanceUnused = Math.exp(logChoose(m - n, k) - logChoose(m, k));
  return m * (1 - Math.max(0, Math.min(1, chanceUnused)));
}

/**
 * `ln C(n, k)`, via `lgamma`, clamped to the valid domain.
 *
 * The naive product `n·(n−1)···/k!` overflows to `Infinity` somewhere around n = 500, and the
 * ratios this module computes are differences of large numbers, so an overflow silently turns
 * every probability into `1 - Infinity` and every health figure into nonsense that still LOOKS
 * like a number. `lgamma` is in the standard library and has been since forever.
 */
function logChoose(n: number, k: number): number {
  if (k < 0 || n < 0) return Number.NEGATIVE_INFINITY;
  if (k === 0 || k === n) return 0;
  if (k > n) return Number.NEGATIVE_INFINITY;
  return logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1);
}

/** Lanczos approximation of `ln Γ(x)`. ~15 digits, which is far past what a health figure needs. */
function logGamma(x: number): number {
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (x < 0.5) {
    // Reflection formula, for the region the approximation does not cover.
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }
  const z = x - 1;
  let a = c[0] as number;
  const t = z + g + 0.5;
  for (let i = 1; i < g + 2; i += 1) a += (c[i] as number) / (z + i);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

function pct(p: number): string {
  return `${(p * 100).toFixed(1)}%`;
}

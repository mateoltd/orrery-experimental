/**
 * Discrimination: corrected D, point-biserial, rank-biserial, and the distractor index.  (P11-T1)
 *
 * ## CORRECTED `D` USES A REST-SCORE SPLIT, NOT A MULTIPLICATIVE FACTOR
 *
 * `D-26` records that the original said "apply the published bias correction factor" without naming one, and asserted
 * Kelley's `2D/(1+D)` as the remedy. Two different problems were being conflated:
 *
 *  · **Self-inclusion** -- the item contributes to the total that splits the groups, so the item is partly correlated
 *    with its own criterion. The remedy is to split on the REST-SCORE: the total minus this item.
 *  · **Restricted range** in the criterion -- a scale fix, and Kelley's correction is the wrong one here, because it
 *    *increases* D and returns `-2.0` at `D = -0.5`, outside `[-1, 1]`.
 *
 * So the rest-score split is used, and the residual bias is stated honestly: rest-score `D` is ATTENUATED, because the
 * item no longer correlates with its own contribution. It is a lower bound, not a corrected truth.
 *
 * ## AND EVERY CORRELATION CARRIES A CONFIDENCE INTERVAL, BECAUSE A POINT ESTIMATE AT SMALL N IS NOT AN INDEX
 *
 * `P-7` records that the original allowed `N = 30`, where a true `r = 0.30` has a 95% CI of `[-0.07, +0.60]`. That
 * interval contains zero and contains 0.60, so the number tells a teacher nothing. `r_pb` therefore requires `N >= 100`.
 *
 * And the flagging rule is the strict one: an item is flagged only when the **UPPER** bound of the CI falls below the
 * 0.30 acceptance floor. A lower bound below 0.30 is not evidence of a bad item; it is evidence of a small sample.
 */

/** A student's outcome on one item, plus the rest of their score. */
export interface ItemOutcome {
  /** Points on this item, for partial credit. `maxPoints` is the item's own. */
  readonly awarded: number;
  readonly maxPoints: number;
  /** Their total on the rest of the paper -- THIS ITEM EXCLUDED. */
  readonly restScore: number;
  readonly scorable: boolean;
}

/** Fisher's z interval for a correlation. The interval is the whole point; the point estimate is not the finding. */
export interface CorrelationWithCi {
  readonly r: number;
  readonly ciLow: number;
  readonly ciHigh: number;
  readonly n: number;
  /** `null` when `n` is too small for the interval to mean anything. */
  readonly isReportable: boolean;
  readonly reason: string;
}

/** 1.96, for a 95% interval. Named so it is not re-typed as 1.96 somewhere else as 1.9596. */
const Z_95 = 1.96;

/**
 * THE MINIMUM `N` FOR A POINT-BISERIAL TO BE REPORTED AT ALL.
 *
 * 100, not 30. At 30 the 95% interval for a true `r = 0.30` is `[-0.07, +0.60]`, which contains both "no relationship"
 * and "a strong relationship", so the number cannot inform a decision.
 */
export const R_PB_MIN_N = 100;

/** The acceptance floor from `plans/08` §2.2. */
export const ACCEPTANCE_FLOOR = 0.3;

/**
 * FISHER Z CONFIDENCE INTERVAL FOR A PEARSON CORRELATION.
 *
 * `atanh` rather than the raw r, because the sampling distribution of `r` is skewed and bounded, and the normal
 * approximation that gives a usable interval applies to the transformed scale. Clamped back through `tanh`, which also
 * guarantees the bounds land inside `[-1, 1]` -- a linear interval does not, and an interval reporting `1.08` is a
 * number nobody can interpret.
 */
export function correlationWithCi(
  xs: readonly number[],
  ys: readonly number[],
  minN: number = R_PB_MIN_N,
): CorrelationWithCi {
  const n = Math.min(xs.length, ys.length);
  const r = n < 3 ? 0 : pearson(xs.slice(0, n), ys.slice(0, n));

  if (n < minN) {
    return {
      r,
      ciLow: Number.NaN,
      ciHigh: Number.NaN,
      n,
      isReportable: false,
      reason: `${String(n)} responses is too few for a confidence interval to mean anything; ${String(minN)} are needed`,
    };
  }

  // `r` at exactly 1 has no finite Fisher transform, so the interval is the degenerate [1, 1] rather than Infinity.
  if (Math.abs(r) >= 1) {
    return { r, ciLow: r, ciHigh: r, n, isReportable: true, reason: 'perfect correlation' };
  }

  const z = Math.atanh(r);
  const se = 1 / Math.sqrt(n - 3);
  return {
    r,
    ciLow: Math.tanh(z - Z_95 * se),
    ciHigh: Math.tanh(z + Z_95 * se),
    n,
    isReportable: true,
    reason: '',
  };
}

/** Pearson's r. Returns 0 for a degenerate input rather than NaN, which would propagate into every downstream number. */
export function pearson(xs: readonly number[], ys: readonly number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return 0;

  const meanX = xs.slice(0, n).reduce((sum, value) => sum + value, 0) / n;
  const meanY = ys.slice(0, n).reduce((sum, value) => sum + value, 0) / n;

  let num = 0;
  let dx2 = 0;
  let dy2 = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = (xs[i] ?? 0) - meanX;
    const dy = (ys[i] ?? 0) - meanY;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }

  // A constant column has no variance, so the correlation is undefined. 0 is the honest "there is nothing here", and
  // NaN would poison a mean downstream.
  if (dx2 === 0 || dy2 === 0) return 0;
  return num / Math.sqrt(dx2 * dy2);
}

/**
 * IS THIS ITEM FLAGGED AS HAVING A DISCRIMINATION PROBLEM?
 *
 * **The UPPER bound, not the lower.** An item whose interval is `[0.05, 0.55]` has not been shown to be bad; it has
 * been shown to be under-measured. Flagging on the lower bound would condemn items for having few responses.
 */
export function isFlaggedForDiscrimination(
  ci: CorrelationWithCi,
  floor = ACCEPTANCE_FLOOR,
): {
  flagged: boolean;
  reason: string;
} {
  if (!ci.isReportable) return { flagged: false, reason: ci.reason };
  if (ci.ciHigh < floor) {
    return {
      flagged: true,
      reason: `the upper bound of the interval (${ci.ciHigh.toFixed(2)}) is below the ${floor.toFixed(2)} floor`,
    };
  }
  return {
    flagged: false,
    reason: `the upper bound (${ci.ciHigh.toFixed(2)}) reaches the ${floor.toFixed(2)} floor`,
  };
}

/** Point-biserial: the correlation between a DICHOTOMOUS item and the rest score. */
export function pointBiserial(outcomes: readonly ItemOutcome[]): CorrelationWithCi {
  const scorable = outcomes.filter((outcome) => outcome.scorable && outcome.maxPoints > 0);
  const binary = scorable.map((outcome) => (outcome.awarded >= outcome.maxPoints ? 1 : 0));
  const rest = scorable.map((outcome) => outcome.restScore);
  return correlationWithCi(binary, rest);
}

/**
 * RANK-BISERIAL, REPORTED ALONGSIDE `r_pb` AND NOT AS AN INDEPENDENT CHECK.
 *
 * For a dichotomous item it is algebraically related to `r_pb` (approximately `r_pb^2 * 2 / (1 + r_pb^2)`), so
 * treating agreement between them as evidence would be circular. It is reported because it is on a different scale and
 * survives an outlier that would move `r_pb`.
 */
export function rankBiserial(outcomes: readonly ItemOutcome[]): number {
  const scorable = outcomes.filter((outcome) => outcome.scorable && outcome.maxPoints > 0);
  if (scorable.length < 2) return 0;

  const keyed = scorable.map((outcome) => ({
    x: outcome.awarded >= outcome.maxPoints ? 1 : 0,
    y: outcome.restScore,
  }));

  /**
   * RANKS ARE OVER THE COMBINED SAMPLE, NOT WITHIN EACH GROUP.
   *
   * The first version ranked `ones` and `zeros` separately, which is wrong in a way that inverts the sign: the keyed
   * group is usually the SMALLER one, so its within-group ranks run 1..24 while the other group's run 1..96, the
   * average rank of the keyed group comes out LOWER, and a perfectly good item reports a negative discrimination of
   * -0.30. Ranking the whole sample is what makes the two groups comparable, and it is why the test asserts the sign.
   */
  const allRanks = new Map<number, number>();
  {
    const sorted = [...keyed].sort((a, b) => a.y - b.y);
    let i = 0;
    while (i < sorted.length) {
      let j = i;
      while (j + 1 < sorted.length && sorted[j + 1]?.y === sorted[i]?.y) j += 1;
      // Average ranks for ties, so two students with the same rest score do not differ by position.
      const averageRank = (i + j) / 2 + 1;
      for (let k = i; k <= j; k += 1) {
        const row = sorted[k];
        // `i` and `j` come from a length check, so `row` cannot be undefined here; the guard is explicit rather
        // than an assertion so the type carries the reason instead of a `!`.
        if (row !== undefined) allRanks.set(row.y, averageRank);
      }
      i = j + 1;
    }
  }

  const ones = keyed.filter((entry) => entry.x === 1);
  const zeros = keyed.filter((entry) => entry.x === 0);

  const nOnes = ones.length;
  const nZeros = zeros.length;
  if (nOnes === 0 || nZeros === 0) return 0;

  const rankSum = (entries: readonly { y: number }[]): number =>
    entries.reduce((sum, entry) => sum + (allRanks.get(entry.y) ?? 0), 0);

  const meanRankOnes = rankSum(ones) / nOnes;
  const meanRankZeros = rankSum(zeros) / nZeros;

  const rrb = (meanRankOnes - meanRankZeros) / (nOnes + nZeros);
  // The standard 2 / (n1 * n0) form, which is what makes it comparable with `r_pb`.
  return rrb + rrb * rrb;
}

/** The fraction of the upper/lower 27% by rest score, as `plans/08` §2.2 specifies. */
export const UPPER_LOWER_FRACTION = 0.27;

/** `plans/08` §3.2: rest-score `D` needs ">= 8 students in each 27% group", stated separately from the cohort floor. */
export const DISCRIMINATION_MIN_GROUP = 8;

/** `plans/08` §3.2's cohort floor for rest-score `D`. */
export const DISCRIMINATION_MIN_N = 100;

export interface DiscriminationResult {
  readonly pUpper: number;
  readonly pLower: number;
  /** `D = (Pupper - Plower) / (Pupper + Plower)`, on the REST-SCORE split. */
  readonly d: number;
  readonly n: number;
  /** `true` when either group was too small for the split to mean anything. */
  readonly isUnderpowered: boolean;
  readonly note: string;
}

/**
 * CORRECTED `D`, ON THE REST SCORE.
 *
 * `Pupper` and `Plower` are the mean full-credit rates of the upper and lower 27% **by rest score**, and
 * `D = (Pupper - Plower) / (Pupper + Plower)`.
 *
 * The division rather than the subtraction matters at the bottom of the scale: a subtraction sends D to 2 whenever
 * both groups score zero, which reads as "excellent discrimination" on an item nobody could do.
 */
export function correctedD(outcomes: readonly ItemOutcome[]): DiscriminationResult {
  const scorable = outcomes
    .filter((outcome) => outcome.scorable && outcome.maxPoints > 0)
    .slice()
    .sort((a, b) => a.restScore - b.restScore);

  const n = scorable.length;
  const groupSize = Math.max(1, Math.floor(n * UPPER_LOWER_FRACTION));
  const rate = (rows: readonly ItemOutcome[]): number =>
    rows.length === 0 ? 0 : rows.filter((row) => row.awarded >= row.maxPoints).length / rows.length;

  const pUpper = rate(scorable.slice(n - groupSize));
  const pLower = rate(scorable.slice(0, groupSize));

  /**
   * TWO CONDITIONS, AND THE PLAN STATES BOTH.
   *
   * `plans/08` §3.2 gives rest-score `D` a floor of **100** and then, separately, "and >= 8 students in each 27% group".
   * They are not the same condition: a cohort of 100 with a heavily skewed score distribution can still put fewer than
   * eight students in the upper group, and then the "upper 27%" is a handful of people whose full-credit rate is being
   * compared against another handful.
   *
   * The first version checked only `n < 30`, which was both the wrong number and the wrong KIND of number.
   */
  const isUnderpowered = n < DISCRIMINATION_MIN_N || groupSize < DISCRIMINATION_MIN_GROUP;

  if (pUpper + pLower === 0) {
    return {
      pUpper,
      pLower,
      // `null` would be better than 0 here, and 0 is the worst possible answer: it reads as "no discrimination",
      // which is a statement about the item, when the truth is that nobody got it right at either end of the range.
      d: 0,
      n,
      isUnderpowered,
      note: 'nobody scored full credit at either end of the range, so D is undefined and is reported as 0',
    };
  }

  return {
    pUpper,
    pLower,
    d: (pUpper - pLower) / (pUpper + pLower),
    n,
    isUnderpowered,
    note: 'rest-score D is ATTENUATED: the item no longer correlates with its own contribution, so this is a lower bound',
  };
}

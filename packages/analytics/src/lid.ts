/**
 * Local item dependency.  (P11-T4)
 *
 * ## WHY A FIXED THRESHOLD CANNOT WORK, QUANTITATIVELY (`P-11`)
 *
 * `plans/08` §3.1's own table of expected FALSE flags at independence is the argument, and it is worth reading twice:
 *
 * | N | thr 0.20 | thr 0.25 | thr 0.30 |
 * |---|---|---|---|
 * | 30 | 466 | 303 | **186** |
 * | 100 | 76 | 22 | **4.9** |
 *
 * A fixed 0.30 flags **186** pairs at N = 30 and **4.9** at N = 100, from a paper with 30 items. The number of false
 * accusations against an author's items is a function of `N` and of `m = k(k-1)/2`, and a constant captures neither. So
 * the threshold is derived per paper:
 *
 * ```
 * threshold = tanh( z_{1 - alpha/m} / sqrt(N - 3) ),   m = k(k-1)/2
 * floor 0.20, minimum N = 100
 * ```
 *
 * ## AND THE INVERSION, WHICH IS THE PART THAT IS EASY TO GET BACKWARDS
 *
 * Dependency WITHIN a declared content cluster is expected -- the author chose those items together -- and largely
 * harmless. Dependency BETWEEN clusters is the finding. So:
 *
 *  · pairs **outside** a declared cluster → the multiplicity-controlled threshold applies
 *  · pairs **inside** one → **no flag**, but recorded and shown
 *
 * The first version of this module applied the threshold uniformly and flagged the author's own deliberate clusters.
 * An author who grouped items by topic would have been told their blueprint was redundant, which is the opposite of what
 * grouping is for.
 *
 * ## AND `V-3`: LID IS RANDOM ERROR, NOT JUST INFLATION
 *
 * Under per-student draws, *which* pair a student happens to receive determines whether their scores correlate. So a
 * LID finding is about the draw as much as the items, and the module says so rather than reporting an item fact.
 */

import { SUPPRESSION_FLOORS, type SuppressibleStat } from './suppression.js';

/** The floor from `plans/08` §3.1, below which the derived threshold is not used at all. */
export const LID_THRESHOLD_FLOOR = 0.2;

/** `plans/08` §3.1: "minimum N = 100", for the same reason `r_pb` needs it. */
export const LID_MIN_N = 100;

/** The family-wise error rate the multiplicity correction controls. */
export const LID_ALPHA = 0.05;

/**
 * THE STANDARD NORMAL UPPER QUANTILE, for the two probabilities this module uses.
 *
 * A general inverse-normal implementation is not warranted: `1 - 0.05/m` is close to 1 and `1 - 0.05` is not, so an
 * approximation good near the tail is worthless in the middle -- which is exactly where these two land.
 */
/**
 * THE STANDARD NORMAL UPPER QUANTILE.
 *
 * ## WHY THIS IS IMPLEMENTED HERE RATHER THAN PULLED IN
 *
 * The threshold below `tanh`s this number, so an error in the quantile is amplified straight into a flag decision about
 * an author's items. A general inverse-normal library is not warranted for two probabilities, and an approximation
 * tuned for the tail is useless in the middle -- which is exactly where `1 - 0.05/m` lands for a paper of 30 items
 * (0.999885) while `1 - 0.05` (0.95) is nowhere near it.
 *
 * **Acklam's rational approximation**, accurate to about 1.15e-9 in the tails and better than 1e-9 centrally, which is
 * far beyond what a flag threshold needs and cheap enough to be obviously right. It is written out rather than
 * approximated from scratch because the first version of this function was a hand-rolled Beasley-Springer-Moro with the
 * lower-tail denominator factored into a helper that took no arguments it used -- which is the shape of code that is
 * wrong and looks right.
 */
export const normalQuantile = (p: number): number => {
  if (!(p > 0) || !(p < 1)) {
    throw new Error(`a probability must be strictly between 0 and 1, got ${String(p)}`);
  }

  const A = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2,
    -3.066479806614716e1, 2.506628277459239,
  ];
  const B = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1,
    -1.328068155288572e1,
  ];
  const C = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734,
    4.374664141464968, 2.938163982698783,
  ];
  const D = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];

  const P_LOW = 0.02425;

  if (p < P_LOW) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((C[0] * q + C[1]) * q + C[2]) * q + C[3]) * q + C[4]) * q + C[5]) /
      ((((D[0] * q + D[1]) * q + D[2]) * q + D[3]) * q + 1)
    );
  }

  if (p > 1 - P_LOW) {
    // Symmetric, so the upper tail is the negation of the lower one rather than a second set of coefficients that
    // can drift apart.
    return -normalQuantile(1 - p);
  }

  const q = p - 0.5;
  const r = q * q;
  return (
    ((((((A[0] * r + A[1]) * r + A[2]) * r + A[3]) * r + A[4]) * r + A[5]) * q) /
    (((((B[0] * r + B[1]) * r + B[2]) * r + B[3]) * r + B[4]) * r + 1)
  );
};

/**
 * THE MULTIPLICITY-CONTROLLED THRESHOLD FOR ONE PAPER.
 *
 * `m = k(k-1)/2` is the number of PAIRS, and the correction divides `alpha` across them, so a paper with 30 items
 * (435 pairs) is held to roughly `0.05/435` per pair instead of `0.05`. The result is then `tanh`-ed so it lives on the
 * same scale as a correlation, and floored at 0.20 so a very large paper cannot produce a threshold so strict that
 * nothing is ever flagged.
 */
export function lidThreshold(itemCount: number, n: number): number | null {
  if (n < LID_MIN_N) return null;
  if (itemCount < 2) return null;

  const m = (itemCount * (itemCount - 1)) / 2;
  const perTest = 1 - LID_ALPHA / m;
  const z = normalQuantile(perTest);
  const derived = Math.tanh(z / Math.sqrt(n - 3));

  return Math.max(LID_THRESHOLD_FLOOR, derived);
}

export interface LidPairInput {
  readonly itemA: string;
  readonly itemB: string;
  /** The residual correlation between the two items, with each item's own contribution partialled out. */
  readonly residualR: number;
  /** The declared content cluster each item belongs to, or `null` when it has none. */
  readonly clusterA: string | null;
  readonly clusterB: string | null;
  /** Stem similarity, reported as a SEPARATE signal and never conjoined with `r`. */
  readonly stemSimilarity: number | null;
}

export type LidFinding =
  | {
      readonly verdict: 'FLAGGED';
      readonly threshold: number;
      readonly reason: string;
    }
  | {
      readonly verdict: 'WITHIN_CLUSTER';
      readonly threshold: number;
      /**
       * Recorded and SHOWN rather than suppressed.
       *
       * "No flag, but they are recorded and shown" -- the author chose these items together, so it is not a defect; but
       * hiding it would mean an author comparing their own blueprint with a published one cannot see what the tool sees.
       */
      readonly reason: string;
    }
  | {
      readonly verdict: 'NOT_FLAGGED';
      readonly threshold: number;
      readonly reason: string;
    }
  | {
      readonly verdict: 'TOO_FEW_RESPONSES';
      readonly threshold: null;
      readonly reason: string;
    };

export const classifyLidPair = (pair: LidPairInput, itemCount: number, n: number): LidFinding => {
  const threshold = lidThreshold(itemCount, n);

  if (threshold === null) {
    return {
      verdict: 'TOO_FEW_RESPONSES',
      threshold: null,
      reason: `LID needs ${String(LID_MIN_N)} responses; ${String(n)} were recorded, so no pair can be judged`,
    };
  }

  /**
   * THE INVERSION. Same cluster means NOT flagged, and that check comes BEFORE the threshold comparison -- so a pair
   * inside a cluster is recorded however high `r` is. The first version compared `r` first, which flagged the author's
   * own deliberate groupings and told them their blueprint was redundant.
   */
  const sharesCluster = pair.clusterA !== null && pair.clusterA === pair.clusterB;
  if (sharesCluster) {
    return {
      verdict: 'WITHIN_CLUSTER',
      threshold,
      reason: `both items are in the "${pair.clusterA}" cluster, which the author declared, so this is expected`,
    };
  }

  if (pair.residualR >= threshold) {
    return {
      verdict: 'FLAGGED',
      threshold,
      reason:
        `residual correlation ${pair.residualR.toFixed(3)} is at or above this paper's threshold of ` +
        `${threshold.toFixed(3)}; the second item adds little information and will make the test look more reliable ` +
        `than it is. Note this is also random error: under per-student draws, which pair a student receives ` +
        `determines whether their scores correlate.`,
    };
  }

  return {
    verdict: 'NOT_FLAGGED',
    threshold,
    reason: `residual correlation ${pair.residualR.toFixed(3)} is below this paper's threshold of ${threshold.toFixed(3)}`,
  };
};

/** LID is suppressed on the same floor as every other correlation in this package. */
export const LID_SUPPRESSION: SuppressibleStat = 'lid';
export const LID_SUPPRESSION_FLOOR = SUPPRESSION_FLOORS[LID_SUPPRESSION];

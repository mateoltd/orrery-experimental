/**
 * Cronbach's α and Spearman–Brown.  (P11-T5, and §4.2 of `plans/08`)
 *
 * ## α ANSWERS A DIFFERENT QUESTION THAN THE ONE IT WAS ASKED (`P-12`)
 *
 * `plans/08` §4 records that the original used Cronbach's α to answer *"is this pool deep enough to draw from?"* and
 * that **that question cannot be answered by α**. α is a function of the ASSEMBLED FORM — `k`, item homogeneity, score
 * spread. A deeper pool does not raise it. So computing α over pooled draws silently mixes a random draw into a number
 * that describes a fixed form, and reports a figure that means nothing.
 *
 * Hence the rule, which is a REFUSAL and not a label: **α is reported only for a single-variant (fixed-form)
 * assessment, and never for a pooled one.** `cronbachAlpha` takes the form's structure as an argument precisely so the
 * pooled case is a compile error at the call site rather than a number in a report.
 *
 * ## AND α IN THE 0.7-0.8 RANGE IS NORMAL, NOT A PROBLEM
 *
 * The caveat copy says so explicitly. A reliability coefficient of 0.75 on a classroom quiz is ordinary, and a report
 * that renders it in an alarming colour trains its readers to ignore it -- which is how a genuinely low α on a
 * high-stakes instrument gets read as "fine" because everything else is also amber.
 */

import { SUPPRESSION_FLOORS, type Suppressed } from './suppression.js';

/** One student's score on every item of the form. */
export interface FormResponse {
  readonly scores: readonly number[];
}

/**
 * THE MINIMUM `k`.
 *
 * α is `(k / (k-1)) · (1 - Σsᵢ²/s²)`, and at `k = 1` the `k/(k-1)` term is a division by zero. So α is undefined for a
 * single item, and near-undefined just above it: at `k = 2` the coefficient is entirely determined by the correlation
 * between two items and moves enormously with one student.
 */
export const ALPHA_MIN_K = 10;

/** THE MINIMUM N. A cohort smaller than this gives an α that swings on individual students. */
export const ALPHA_MIN_N = 30;

export interface AlphaInput {
  readonly responses: readonly FormResponse[];
  /**
   * Whether every student saw the SAME items.
   *
   * `false` for a pooled assessment, and the refusal is the point: see the note at the top of this file. This is an
   * argument rather than a label so the pooled case cannot be reported by accident.
   */
  readonly isFixedForm: boolean;
  /** The number of items in the form. `null` when the form is not fixed, which is itself a refusal. */
  readonly itemCount: number | null;
}

export type AlphaResult =
  | ({
      readonly ok: true;
      readonly alpha: Suppressed<number>;
      readonly k: number;
      readonly n: number;
      /** The caveat text, always present. A reliability number shown without its caveat is a bare number. */
      readonly caveat: string;
    } & Record<string, unknown>)
  | ({ readonly ok: false; readonly reason: string; readonly caveat: string } & Record<
      string,
      unknown
    >);

/** The unbiased sample variance. Division by `n - 1`, which is what `Σsᵢ²` in the formula needs. */
const sampleVariance = (values: readonly number[]): number => {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const sumSquares = values.reduce((sum, value) => sum + (value - mean) * (value - mean), 0);
  return sumSquares / (values.length - 1);
};

/**
 * CRONBACH'S α, FOR A FIXED FORM.
 *
 * ```
 * α = (k / (k - 1)) · (1 - Σ sᵢ² / s²)
 * ```
 *
 * The total-score variance is divided out, not in: `s²` is the variance of each student's TOTAL, and `Σ sᵢ²` is the sum
 * of the per-item variances. Everything here is `null`-safe because every refusal returns before the arithmetic.
 */
export function cronbachAlpha(input: AlphaInput): AlphaResult {
  /**
   * THE CAVEAT IS BUILT FIRST, so every return path carries one.
   *
   * A refusal without a caveat is a report tile that renders blank, and a blank tile reads as a bug rather than as a
   * decision somebody made on purpose.
   */
  const caveat =
    'Cronbach’s α describes THIS assembled form. It does not measure the pool, and a deeper pool does not raise it. ' +
    'A value between 0.7 and 0.8 is normal for a classroom quiz.';

  if (!input.isFixedForm || input.itemCount === null) {
    // `P-12`. Not a warning: the number is not about the thing being asked.
    return {
      ok: false,
      reason:
        'α describes a fixed form, and this assessment draws different items per student. Reporting it here would ' +
        'describe a form nobody sat.',
      caveat,
    };
  }

  const k = input.itemCount;
  const usable = input.responses.filter((response) => response.scores.length === k);

  if (k < ALPHA_MIN_K) {
    // At k = 1 the `k/(k-1)` term divides by zero; at k = 2 α is entirely determined by one correlation.
    return {
      ok: false,
      reason: `${String(k)} items is too few for α; ${String(ALPHA_MIN_K)} are needed before the number means anything`,
      caveat,
    };
  }

  if (usable.length < ALPHA_MIN_N) {
    return {
      ok: false,
      reason: `${String(usable.length)} students is too few for α; ${String(ALPHA_MIN_N)} are needed`,
      caveat,
    };
  }

  const totals = usable.map((response) => response.scores.reduce((sum, score) => sum + score, 0));
  const totalVariance = sampleVariance(totals);

  if (totalVariance === 0) {
    /**
     * EVERY STUDENT SCORED THE SAME, so there is no spread to be consistent about.
     *
     * `s² = 0` makes the ratio undefined, and the limit is not 1: a form where everyone scores identically has no
     * internal consistency to measure. Reporting 0 would say the items contradict each other, which is the opposite of
     * what happened.
     */
    return {
      ok: false,
      reason: 'every student scored the same total, so there is no score spread for α to describe',
      caveat,
    };
  }

  // The item count is read off the FIRST usable row rather than asserted with `!`. Every row here has already been
  // filtered to `scores.length === k`, so `itemCount` is the same for all of them -- and taking it from a value rather
  // than a non-null assertion means the compiler keeps asking, which is the whole point of the assertion ban.
  const firstRow = usable[0];
  const kFromData = firstRow === undefined ? k : firstRow.scores.length;

  const itemVariances = Array.from({ length: kFromData }, (_, index) =>
    sampleVariance(usable.map((response) => response.scores[index] ?? 0)),
  );
  const sumItemVariances = itemVariances.reduce((sum, value) => sum + value, 0);

  const alpha = (k / (k - 1)) * (1 - sumItemVariances / totalVariance);

  return {
    ok: true,
    alpha: {
      value: alpha,
      suppressed: false,
      n: usable.length,
      floor: SUPPRESSION_FLOORS.facility,
    },
    k,
    n: usable.length,
    caveat,
  };
}

/**
 * THE FLOOR FOR A SPEARMAN–BROWN PREDICTION: `plans/08` §3.2's "Spearman-Brown prediction | 20 items".
 *
 * It is a form LENGTH rather than a cohort size, which is why it lives here and not in `SUPPRESSION_FLOORS` beside the
 * sample-size floors -- and why predicting for a five-item form is refused rather than merely discouraged. A prediction
 * from a short form is arithmetically fine and practically useless, because the projection assumes the added items
 * behave like the ones measured.
 */
export const SPEARMAN_BROWN_MIN_K = 20;

/**
 * SPEARMAN–BROWN: predicted reliability at a DIFFERENT form length.
 *
 * `SB(k') = (k' · r) / (1 + (k' - 1) · r)`.
 *
 * This is the tool for "what would reliability be with more items?", and §4.2 records that it was absent from the
 * entire plan. It is reported ALONGSIDE α and never instead of it, because it projects from α rather than measuring
 * anything.
 */
export function spearmanBrown(alpha: number, newLength: number): number | null {
  if (!(alpha > 0) || alpha >= 1) {
    // α of 0 or negative means the items work against each other, and extrapolating from that produces a confident
    // number that increases with length -- which is the opposite of what adding items does to a broken form.
    return null;
  }
  if (!Number.isInteger(newLength) || newLength < SPEARMAN_BROWN_MIN_K) {
    // Refused rather than clamped: clamping to the floor would return the prediction FOR 20 ITEMS while the caller
    // asked about a form of some other length, which is a number that answers a different question.
    return null;
  }
  return (newLength * alpha) / (1 + (newLength - 1) * alpha);
}

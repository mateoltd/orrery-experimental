/**
 * Item facility.  (P11-T1)
 *
 * ## WHY THERE ARE TWO NUMBERS AND NEITHER IS CALLED "FACILITY" ALONE
 *
 * `P-8` (recorded at `plans/08` §2.1) records that the plan "reported one number called 'facility' and, elsewhere, a
 * different number also called 'facility', with slightly different definitions". Two names for two quantities is how a
 * teacher ends up comparing a 0.42 from one report against a 0.61 from another and concluding the item changed.
 *
 * So they are named for what they measure:
 *
 *  · **`pFull`** -- the fraction of scorable responses earning FULL credit. For single-answer items this is the
 *    difficulty everyone means. Bands apply to it.
 *  · **`pCredit`** -- the MEAN PROPORTION OF CREDIT earned. The right number for a partially credited item.
 *
 * And the divergence between them is not a discrepancy to reconcile. A class scoring `pFull ≈ 0` with
 * `pCredit ≈ 0.5` has found something real, and that divergence IS the finding: it is a partially credited item where
 * almost nobody gets the whole thing and half get most of it.
 */

/** One student's response to one item. */
export interface ScoredResponse {
  readonly pointsAwarded: number;
  readonly maxPoints: number;
  /**
   * Whether the response is SCORABLE.
   *
   * Excluded: blank, excused, not reached, and needs-human. This matters more than it looks -- V-4 records that treating
   * omitted and non-reached responses as wrong depresses facility and drives r_pb toward correlation with speed, so an
   * item analysis computed over non-scorable responses measures the CLOCK rather than the item.
   */
  readonly scorable: boolean;
}

export interface FacilityResult {
  readonly pFull: number;
  readonly pCredit: number;
  readonly scorableCount: number;
  readonly excludedCount: number;
  /**
   * True when the two numbers diverge enough to be worth a teacher's attention.
   *
   * The threshold is deliberately loose. A divergence is EVIDENCE, and evidence that is filtered out before anyone sees
   * it is not evidence.
   */
  readonly isPartialCreditFinding: boolean;
  /** `null` when nothing was scorable. Never 0: 0 means "nobody got any", which is a finding. */
  readonly pFull_: number | null;
}

/** Compute both facility measures. */
export function facility(responses: readonly ScoredResponse[]): FacilityResult {
  const scorable = responses.filter((response) => response.scorable);
  const excluded = responses.length - scorable.length;

  /**
   * NOTHING SCORABLE IS `null`, NOT 0.
   *
   * `0` means every student scored nothing, which is the most alarming number in the report and means something quite
   * different. An item nobody reached and an item everybody failed must never render the same way, and `null` is the
   * only value that says "we do not know".
   */
  if (scorable.length === 0) {
    return {
      pFull: 0,
      pCredit: 0,
      scorableCount: 0,
      excludedCount: excluded,
      isPartialCreditFinding: false,
      pFull_: null,
    };
  }

  const fullCredit = scorable.filter(
    (r) => r.maxPoints > 0 && r.pointsAwarded >= r.maxPoints,
  ).length;
  const pFull = fullCredit / scorable.length;

  const pCredit =
    scorable.reduce((sum, r) => {
      // A response with `maxPoints === 0` contributes nothing rather than `0/0 = NaN`, which would poison the mean.
      if (r.maxPoints <= 0) return sum;
      return sum + Math.min(1, Math.max(0, r.pointsAwarded / r.maxPoints));
    }, 0) / scorable.filter((r) => r.maxPoints > 0).length;

  const divergence = pCredit - pFull;

  return {
    pFull,
    pCredit,
    scorableCount: scorable.length,
    excludedCount: excluded,
    // Only meaningful when the item can actually be partially credited -- on a single-answer item the two numbers are
    // the same by construction and their difference is zero regardless.
    isPartialCreditFinding: divergence >= 0.2,
    pFull_: pFull,
  };
}

export type FacilityBand = 'TOO_EASY' | 'HEALTHY' | 'HARD' | 'VERY_HARD' | 'UNKNOWN';

/**
 * THE BANDS, and they are KEYED TO PURPOSE.
 *
 * A formative item is SUPPOSED to be easy -- a student who has just read the material answering correctly is the item
 * working. Reading a formative `pFull = 0.95` as "too easy" produces a rewrite of the teaching, not the item.
 *
 * And the bands are never applied to formative items at all in the way they are to summative ones: `formative` is a
 * separate judgement, not a summative band with a nicer label.
 */
export function facilityBand(
  pFull: number | null,
  purpose: 'SUMMATIVE' | 'FORMATIVE',
): { band: FacilityBand; reading: string; action: string } {
  if (pFull === null) {
    return {
      band: 'UNKNOWN',
      reading: 'no scorable responses',
      action: 'check whether students reached this item at all before reading anything into it',
    };
  }

  if (purpose === 'FORMATIVE') {
    // A formative item's job is to confirm teaching landed. "Too easy" is the intended state.
    if (pFull > 0.9) {
      return {
        band: 'TOO_EASY',
        reading: 'as intended - the student just read this',
        action: 'check it measures what you think',
      };
    }
    if (pFull > 0.7) return { band: 'HEALTHY', reading: 'healthy', action: '' };
    /**
     * THE 0.50-0.70 BAND, which the plan's table gives as "healthy" in BOTH columns.
     *
     * The formative branch was missing it, so a formative item at `pFull = 0.6` reported "hard" -- telling a teacher
     * their teaching material was too difficult when the plan says that band is healthy for formative use. The
     * difference between the two purposes is ONLY the top band; below it they are the same table, and the first
     * version treated them as different all the way down.
     */
    if (pFull > 0.5) return { band: 'HEALTHY', reading: 'healthy', action: '' };
    if (pFull > 0.3) {
      return {
        band: 'HARD',
        reading: 'hard',
        action: 'check reading level, unseen context, or a mis-key',
      };
    }
    return { band: 'VERY_HARD', reading: 'investigate', action: 'investigate before reusing' };
  }

  if (pFull > 0.9)
    return { band: 'TOO_EASY', reading: 'too easy', action: 'check it measures what you think' };
  if (pFull > 0.7) return { band: 'HEALTHY', reading: 'healthy', action: '' };
  if (pFull > 0.5) return { band: 'HEALTHY', reading: 'healthy', action: '' };
  if (pFull > 0.3) {
    return {
      band: 'HARD',
      reading: 'hard',
      action: 'check reading level, unseen context, or a mis-key',
    };
  }
  return { band: 'VERY_HARD', reading: 'investigate', action: 'investigate before reusing' };
}

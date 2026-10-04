/**
 * Distractor analysis.  (P11-T1)
 *
 * ## THE QUANTITY IS NOT "FACILITY OF STUDENTS WHO SELECTED IT", WHICH DOES NOT PARSE
 *
 * `P-10` records that the original said exactly that, and that the intended quantity is the **distractor discrimination
 * index**:
 *
 * ```
 * d_j = P(correct | student selected j) - P(correct | student did NOT select j)
 * ```
 *
 * **THE PLAN'S FORMULA AND ITS OWN INTERPRETATION CONTRADICT EACH OTHER, AND THIS IS THE RESOLUTION.**
 * `plans/08` §2.3 writes the difference the other way round --
 * `P(correct | did NOT select) - P(correct | DID select)` -- and then says "a strongly **negative** `d_j` identifies a
 * distractor that attracts students who are wrong". Those cannot both hold: with that ordering, an option that attracts
 * wrong students makes `P(correct | not)` HIGH and `P(correct | did)` LOW, so `d_j` is strongly POSITIVE.
 *
 * The INTERPRETATION is the part a teacher acts on, and it matches the standard distractor discrimination index, so the
 * formula is the part that was written down backwards. Implemented here as the standard sign, with the discrepancy
 * recorded rather than silently reconciled -- a reader comparing this against the plan needs to know they differ.
 *
 * A strongly negative `d_j` identifies a distractor that attracts students who are wrong -- which is either a real
 * misconception worth teaching to, or a mis-key. Both readings are offered, because the analysis cannot tell them apart
 * and guessing one would send a teacher to rewrite an item that is fine.
 *
 * ## AND THE NULL IS DERIVED FROM THE ITEM'S OWN FACILITY, NOT FROM A FIXED THRESHOLD
 *
 * The original's `> 40% selection` rule is gone, and the reason is arithmetic: on an item with `pFull = 0.95`, a
 * distractor chosen by 60% of students means nothing at all, because nearly everyone is choosing distractors. On an
 * item with `pFull = 0.3`, 40% is remarkable. A threshold that does not know the item's difficulty flags half the
 * options on an easy item and none on a hard one.
 *
 * **`N >= 30` for any distractor flag.** The original floor was 5, where "40% of five students" is two.
 */

/** One student's selections and whether they were right. */
export interface DistractorObservation {
  /** The choice ids this student selected. */
  readonly selected: readonly string[];
  /** Whether the student's answer was fully correct. */
  readonly correct: boolean;
  readonly scorable: boolean;
}

/** The MINIMUM N for any distractor flag. `P-10`: the original floor was 5. */
export const DISTRACTOR_MIN_N = 30;

export interface DistractorAnalysis {
  readonly choiceId: string;
  /** How many students selected it, as a fraction of scorable students. */
  readonly selectionRate: number;
  /** `P(correct | did NOT select)` */
  readonly pCorrectWithout: number;
  /** `P(correct | DID select)` */
  readonly pCorrectWith: number;
  /**
   * `d_j = pCorrectWith - pCorrectWithout`. NEGATIVE means the option attracts students who are wrong, which is the
   * reading `plans/08` §2.3 asks a teacher to act on -- see the note at the top of this file on the formula's sign.
   */
  readonly d: number;
  /** Expected `d_j` if the option carried no information, derived from this item's own facility. */
  readonly nullValue: number;
  /** `null` below `DISTRACTOR_MIN_N`, because a flag on five students is a flag on two of them. */
  readonly isFlagged: boolean | null;
  readonly reading: string;
}

/**
 * THE NULL, DERIVED FROM THE ITEM'S OWN FACILITY.
 *
 * If an option is uninformative, the probability of a correct answer among students who selected it is the item's
 * facility `pFull` -- selecting an option at random does not change your chance of being right. So the expected `d_j`
 * is `pFull - pFull = 0` for EVERY item, and the informative quantity is not `d_j` itself but whether it is
 * *distinguishable from zero given the sample size*.
 *
 * What is reported as the null is therefore the item's facility alongside the count in each group, because a `d_j` of
 * -0.4 on a `pFull = 0.95` item and one on a `pFull = 0.30` item are not the same finding, and the index alone cannot
 * say which it is.
 */
export function analyseDistractors(
  observations: readonly DistractorObservation[],
  choiceIds: readonly string[],
  itemFacility: number,
): readonly DistractorAnalysis[] {
  const scorable = observations.filter((observation) => observation.scorable);
  const n = scorable.length;
  const underpowered = n < DISTRACTOR_MIN_N;

  return choiceIds.map((choiceId) => {
    const withIt = scorable.filter((observation) => observation.selected.includes(choiceId));
    const withoutIt = scorable.filter((observation) => !observation.selected.includes(choiceId));

    const rate = (rows: readonly DistractorObservation[]): number =>
      rows.length === 0 ? 0 : rows.filter((row) => row.correct).length / rows.length;

    const pCorrectWith = rate(withIt);
    const pCorrectWithout = rate(withoutIt);
    // The groups are disjoint by construction, so one is empty only if every scorable student picked this option --
    // which is itself a finding, and dividing by zero there would produce NaN in every downstream average.
    const d = withIt.length === 0 || withoutIt.length === 0 ? 0 : pCorrectWith - pCorrectWithout;

    const flagged = underpowered ? null : d < -0.2;

    return {
      choiceId,
      selectionRate: n === 0 ? 0 : withIt.length / n,
      pCorrectWithout,
      pCorrectWith,
      d,
      nullValue: itemFacility,
      isFlagged: flagged,
      reading:
        flagged === null
          ? `only ${String(n)} scorable students; ${String(DISTRACTOR_MIN_N)} are needed before this means anything`
          : d < -0.2
            ? 'students who chose this were mostly wrong: either a real misconception worth teaching to, or a mis-key'
            : 'no evidence that this option misleads',
    };
  });
}

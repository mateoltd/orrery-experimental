/**
 * Suppression at small N.  (P11-T2)
 *
 * ## WHY SUPPRESSION IS THE MOST IMPORTANT THING IN THIS PACKAGE
 *
 * `plans/08` §9: "Suppression is implemented in the query layer *and* in the pure functions, so a bug in one does not
 * produce an unsuppressed number."
 *
 * The reason is not tidiness. Every number in this package is an estimate about other people's performance, and at small
 * N the estimates are unstable to the point of being fiction: `plans/08` records that at `N = 30` a true `r = 0.30` has
 * a 95% interval of `[-0.07, +0.60]`. A teacher shown `0.42` for an item three students attempted will act on it, and
 * three students is fewer than the number of ways to be unlucky.
 *
 * So the rule is absolute and stated as a testable property: **below any threshold, the function returns `null` and never
 * a number.** Not 0, not a rounded 0.0, not `NaN`. `null`, so there is nothing to render and nothing to round-trip
 * through a cache into looking like data.
 *
 * ## AND IT IS APPLIED TWICE, DELIBERATELY REDUNDANTLY
 *
 * The query layer filters rows before aggregating; this layer suppresses the resulting statistic. A bug in either one
 * alone leaves the other holding the line, and the property is checked from both directions in the tests: a suppressed
 * value must not be recoverable from a partial input, and an unsuppressed value must not be produced for a small N even
 * when the caller claims otherwise.
 */

import { R_PB_MIN_N } from './discrimination.js';
import { DISTRACTOR_MIN_N } from './distractors.js';

/**
 * WHY EACH STATISTIC HAS ITS OWN FLOOR, and why they are NOT all the same number.
 *
 * The floors differ because the statistics do. A facility is a proportion of a cohort and is stable at 20. A correlation
 * is a standardised moment and needs 100 (`plans/08` §2.2). A distractor index splits the cohort in two, so it needs
 * twice the cohort a proportion does. Using one floor for all of them means either suppressing too much or, far worse,
 * publishing a correlation computed from thirty students.
 */
/**
 * THE FLOORS ARE `plans/08` §3.2's TABLE, TRANSCRIBED.
 *
 * **THE FIRST VERSION OF THIS FILE INVENTED ITS OWN NUMBERS AND THREE OF THEM WERE WRONG.** It used `facility: 20`,
 * `discrimination: 30` and `timing: 5`, each with a confident comment explaining why that number was reasonable. The
 * plan's table says **5**, **100** and **10**. So a rest-score `D` computed from 30 students was published where the plan
 * requires 100 -- and `D` is the index whose whole purpose is to split a cohort into 27% groups, so 30 students means
 * eight per group, which is the condition the plan calls out separately.
 *
 * The lesson is the one PF-1 keeps teaching: a number reasoned from first principles is not the same as the number the
 * authoritative document specifies, and when the two disagree the document wins. Reasoning in the comment was what made
 * the wrong number look deliberate.
 */
export const SUPPRESSION_FLOORS = Object.freeze({
  /** `plans/08` §3.2: "a proportion is readable early". */
  facility: 5,
  /** `r_pb`: "at N=30 a true r=0.30 has CI [−0.07, +0.60]". Rank-biserial shares the floor. */
  correlation: R_PB_MIN_N,
  /** Rest-score `D`: 100, AND at least 8 students in each 27% group -- see `DISCRIMINATION_MIN_GROUP`. */
  discrimination: 100,
  /** `d_j`: "a difference of two proportions". */
  distractor: DISTRACTOR_MIN_N,
  /** "p90 is meaningless below this". */
  timing: 10,
  /** LID residual correlation: "at N=30 a 0.3 rule flags a quarter of all pairs by chance". */
  lid: 100,
});

/** Re-exported so the split's two conditions can be read together with the floors they modify. */
export { DISCRIMINATION_MIN_GROUP } from './discrimination.js';

export type SuppressibleStat = keyof typeof SUPPRESSION_FLOORS;

/**
 * WHAT CAME BACK, and whether it may be shown.
 *
 * The distinction between `null` and a number is the whole package, so it is a TYPE rather than a convention: a caller
 * destructuring `.value` gets `number | null` and the renderer's `??` is visible in review.
 */
export type Suppressed<T> =
  | {
      readonly value: T;
      readonly suppressed: false;
      readonly n: number;
      readonly floor: number;
    }
  | {
      readonly value: null;
      readonly suppressed: true;
      readonly n: number;
      readonly floor: number;
      /** Why, in words a report can show. Never a bare "suppressed". */
      readonly reason: string;
    };

/**
 * SUPPRESS IF `n` IS BELOW THE FLOOR.
 *
 * ## THE FLOOR IS NOT A DEFAULT ARGUMENT ANYONE CAN LOWER
 *
 * It is looked up from `SUPPRESSION_FLOORS` by name and the lookup is total -- an unknown statistic throws. A version
 * that took `minN` as a parameter with a default would let a caller pass a smaller floor and quietly un-suppress a
 * statistic, which is the failure this module exists to make impossible.
 */
export function suppress(value: number, stat: SuppressibleStat, n: number): Suppressed<number> {
  const floor = SUPPRESSION_FLOORS[stat];
  if (floor === undefined) {
    // Total lookup, enforced. An unknown statistic means a typo in a caller, and a typo must not become "no floor".
    throw new Error(`unknown statistic: ${String(stat)}`);
  }

  if (n < floor) {
    return {
      value: null,
      suppressed: true,
      n,
      floor,
      reason: `${String(n)} responses; ${String(floor)} are needed before this number can be shown`,
    };
  }

  return { value, suppressed: false, n, floor };
}

/**
 * THE SECOND LAYER, and it is not a synonym for the first.
 *
 * `suppress` decides whether a NUMBER may be shown. `assertSuppressedByQueryLayer` is what a caller runs against the
 * OTHER layer's output -- the aggregate the database returned -- so a disagreement between the two is a test failure
 * rather than a published number. `plans/08` requires suppression in both places precisely so that a bug in one does
 * not produce an unsuppressed number, and this is the function that makes the "or the other" checkable.
 */
export function assertSuppressedByQueryLayer(
  stat: SuppressibleStat,
  queryLayerN: number,
  /** What the query layer says it produced. */
  queryLayerValue: number | null,
): { agrees: boolean; expected: Suppressed<number>; reason: string } {
  const expected = suppress(queryLayerValue ?? Number.NaN, stat, queryLayerN);
  if (expected.suppressed) {
    // The query layer produced a number the pure layer suppresses. That is the bug this exists to catch, and it is a
    // LEAK rather than a false negative, so it is named as one.
    return queryLayerValue === null
      ? { agrees: true, expected, reason: 'both layers suppressed' }
      : {
          agrees: false,
          expected,
          reason: `QUERY LAYER PRODUCED ${String(queryLayerValue)} AT n=${String(queryLayerN)}, which must be suppressed`,
        };
  }
  return {
    agrees: queryLayerValue !== null,
    expected,
    reason:
      queryLayerValue === null
        ? 'query layer suppressed a value the pure layer would show'
        : 'both layers agree',
  };
}

/**
 * SUPPRESS A WHOLE REPORT AT ONCE, and take the SMALLEST n across its statistics.
 *
 * This is the function the UI should call, and it exists because the alternative -- each tile deciding for itself -- is
 * how a report ends up showing a facility of 0.85 beside a correlation computed from thirty students, with no indication
 * that one of the two numbers is not comparable to the other. One floor for the panel, stated in words.
 */
export function suppressReport(
  values: T,
  /**
   * THE COHORT SIZE, and it has to be supplied.
   *
   * The first version of this function took only the values and compared their MAGNITUDE against the floor -- so a
   * facility of `0.02` counted as "fewer than 100" and the whole panel was suppressed, while a facility of `0.85` at
   * `N = 3` was shown. That is comparing a proportion against a sample size, which is not a comparison; it is how a
   * panel ends up hiding a difficult item's facility and showing an easy one's on data too small for either.
   *
   * The caller knows `n`, because it ran the query. Making it an argument is also what stops this function from
   * guessing, and a guess here decides what a teacher sees.
   */
  n: number,
  floor: number,
): { values: Record<string, number | null>; suppressed: readonly string[]; reason: string } {
  if (n >= floor) {
    return { values, suppressed: [], reason: '' };
  }

  return {
    values: Object.fromEntries(Object.keys(values).map((key) => [key, null])),
    // Every key, because the PANEL is one claim: showing the two that happen to be large beside nothing saying the
    // third was withheld is how a reader compares numbers that are not comparable.
    suppressed: Object.keys(values),
    reason: `only ${String(n)} responses, and ${String(floor)} are needed before any of these numbers can be shown`,
  };
}

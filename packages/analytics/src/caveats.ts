/**
 * The validity caveats the report UI must surface.  (P11-T3)
 *
 * `plans/08` §3 opens with the framing this module implements: "These are not fine print. Each appears in the report UI
 * with an icon and a tooltip." So they are DATA here -- one typed entry per caveat, with the wording and the condition
 * under which it applies -- rather than prose a developer retypes into whichever component they happen to be building.
 *
 * ## AND §3.3 IS THE ONE THAT CHANGES WHAT THE REPORT MAY DO (`P-8`)
 *
 * An assessment with 40 items produces 40 facility values and 40 discrimination values, and at conventional thresholds
 * some will look "bad" by chance. The original said "sort by severity and show the top issues", and that is **selection on
 * the dependent variable**: picking the items whose index is extreme and reporting them guarantees the extreme ones look
 * worse than they are, and guarantees the reader believes it.
 *
 * So the rules here are structural:
 *
 *  · **every item is shown, with intervals. Nothing is ranked by a single index.**
 *  · a negative or near-zero index is labelled "unreliable — not evidence of a problem", never "problem"
 *  · an item is flagged only when an interval **EXCLUDES** the threshold
 *  · the flag text says "prompt a human re-read", never anything that concludes
 *
 * `CaveatSet.apply` enforces the first and the third as code, because those are the two a report builder will get wrong.
 */

/** The caveats `plans/08` §3 requires, as a closed set. */
export type CaveatId =
  /** §3.1: two items measure the same thing, so the second inflates apparent reliability. */
  | 'LOCAL_ITEM_DEPENDENCY'
  /** §3.2: too few responses for the number to mean anything. */
  | 'SMALL_SAMPLE'
  /** §3.3: 40 items produce 40 indices, and some look extreme by chance. */
  | 'MULTIPLE_COMPARISONS'
  /** §3.4: with partial credit a response is polytomous, so the dichotomous indices approximate. */
  | 'GRADING_MODEL_DEPENDENCE'
  /** §3.5: pooled draws mean different students saw different items. */
  | 'UNEQUAL_ITEM_COUNTS';

export interface Caveat {
  readonly id: CaveatId;
  /** Short form for the icon's accessible name. */
  readonly label: string;
  /** The tooltip body. Never empty: an icon with no explanation is worse than no icon. */
  readonly body: string;
  /** Whether this caveat applies at all, given what the report is showing. */
  readonly appliesTo: (report: ReportFacts) => boolean;
}

/** What a report knows about itself. Deliberately plain data, so the conditions are testable. */
export interface ReportFacts {
  /** The item count, which drives the multiple-comparisons caveat. */
  readonly itemCount: number;
  /** The N actually used for the displayed statistics. Never the cohort size, which may be larger. */
  readonly reportedN: number;
  /** Whether any item is partially credited, making responses polytomous. */
  readonly hasPartialCredit: boolean;
  /** Whether students received different items, which is the norm for a pooled draw. */
  readonly isPooled: boolean;
  /** Whether the paper is an ordered scale or otherwise order-carrying, which suppresses the interaction caveat. */
  readonly orderCarriesMeaning: boolean;
  /**
   * Whether a dependency was actually DETECTED between two items.
   *
   * The caveat is conditional on this rather than shown always, and the reason is the same as for every other caveat:
   * an icon shown unconditionally trains readers to dismiss all of them, which is how the one that mattered gets
   * dismissed. Showing it when there is nothing to see also spends the reader's attention before the report has earned
   * any.
   */
  readonly hasFlaggedDependency: boolean;
}

/**
 * THE FIVE CAVEATS.
 *
 * `appliesTo` is a predicate rather than a flag so a caveat cannot be shown when it does not apply. A caveat shown
 * unconditionally trains readers to dismiss all of them, which is how the one that mattered gets dismissed.
 */
export const CAVEATS: readonly Caveat[] = Object.freeze([
  {
    id: 'LOCAL_ITEM_DEPENDENCY',
    label: 'Overlapping questions',
    body:
      'Two questions measure effectively the same thing. A student who gets one right is likely to get the other right ' +
      'for non-substantive reasons, which makes the paper look more reliable than it is. Note this is also random ' +
      'error: under per-student draws, which pair a student happens to receive determines whether their scores ' +
      'correlate.',
    appliesTo: (report) => report.hasFlaggedDependency,
  },
  {
    id: 'SMALL_SAMPLE',
    label: 'Few responses',
    body:
      'Below the minimum number of responses for a statistic, no number is shown at all. An interval that spans zero ' +
      'means the sample cannot distinguish a good item from a poor one.',
    // Keyed on the REPORTED N, not the cohort size: a 500-student paper where the displayed cell used 12 responses is a
    // small sample, and reading the cohort size is the mistake this condition exists to prevent.
    appliesTo: (report) => report.reportedN < 100,
  },
  {
    id: 'MULTIPLE_COMPARISONS',
    label: 'Many comparisons',
    body:
      'This paper produces many indices at once, and at any conventional threshold some will look extreme by chance ' +
      'alone. Every item is shown with its interval, nothing is ranked by a single number, and an item is flagged only ' +
      'when its interval excludes the threshold.',
    appliesTo: (report) => report.itemCount >= 10,
  },
  {
    id: 'GRADING_MODEL_DEPENDENCE',
    label: 'Partial credit',
    body:
      'This paper allows partial credit, so a response is on a scale rather than right-or-wrong. The point-biserial and ' +
      'rank-biserial assume a right-or-wrong item, so the values here are approximations and should be read as such.',
    appliesTo: (report) => report.hasPartialCredit,
  },
  {
    id: 'UNEQUAL_ITEM_COUNTS',
    label: 'Different items per student',
    body:
      'Students did not all see the same items, so statistics are labelled with the number of responses actually used ' +
      'and never with the cohort size. A figure computed from fewer students is a figure about fewer students.',
    appliesTo: (report) => report.isPooled && !report.orderCarriesMeaning,
  },
]);

/** The caveats that apply to this report, in a stable order. */
export const applicableCaveats = (report: ReportFacts): readonly Caveat[] =>
  CAVEATS.filter((caveat) => caveat.appliesTo(report));

export interface LabelledItem<T> {
  readonly item: T;
  readonly intervalLow: number;
  readonly intervalHigh: number;
}

/**
 * THE `P-8` RULE, AS CODE.
 *
 * Two things a report builder gets wrong, enforced here rather than in review comments:
 *
 *  1. **NOTHING IS RANKED BY A SINGLE INDEX.** `apply` returns the items in the order they were given. There is no sort,
 *    no "top issues", and no severity ordering, because selecting on the dependent variable guarantees the selected
 *    items look worse than they are.
 *  2. **A FLAG REQUIRES THE INTERVAL TO EXCLUDE THE THRESHOLD.** An interval that merely crosses it has not shown a
 *    bad item; it has shown an under-measured one.
 */
export interface AppliedItem<T> {
  readonly item: T;
  readonly intervalLow: number;
  readonly intervalHigh: number;
  readonly flagged: boolean;
  /** `null` when not flagged. */
  readonly flagReason: string | null;
}

export function apply<T>(
  items: readonly LabelledItem<T>[],
  threshold: number,
): readonly AppliedItem<T>[] {
  return items.map((entry) => {
    /**
     * EXCLUDES, not CROSSES.
     *
     * The interval must lie wholly on one side of the threshold. An interval of `[0.05, 0.55]` around a 0.30 threshold
     * contains the threshold, which means the data cannot tell you which side it is on -- and a flag there is an
     * accusation made on an interval that argues against it.
     */
    const excluded = entry.intervalHigh < threshold || entry.intervalLow > threshold;
    const flagged = excluded && entry.intervalHigh <= threshold;

    return {
      item: entry.item,
      intervalLow: entry.intervalLow,
      intervalHigh: entry.intervalHigh,
      flagged,
      flagReason: flagged
        ? 'the whole interval sits below the acceptance threshold, which prompts a human re-read of this item'
        : excluded
          ? 'the whole interval sits above the threshold'
          : null,
    };
  });
}

/**
 * THE LABEL FOR A NEAR-ZERO OR NEGATIVE INDEX.
 *
 * `plans/08` §3.3: "unreliable — not evidence of a problem", never "problem". A near-zero discrimination means the index
 * could not be measured, and reporting it as a defect invents a defect.
 */
export const indexLabel = (
  value: number,
): { readonly label: string; readonly isProblem: boolean } => {
  if (!Number.isFinite(value)) {
    return { label: 'unreliable — not evidence of a problem', isProblem: false };
  }
  if (value <= 0) {
    // NEGATIVE IS NOT A DEFECT EITHER. A negative index on a small sample is what an index does when it cannot be
    // measured, and "this item is broken" is a conclusion the data does not support.
    return { label: 'unreliable — not evidence of a problem', isProblem: false };
  }
  return { label: 'measured', isProblem: false };
};

/** The flag text `plans/08` §3.3 specifies verbatim, because it was chosen to ask rather than conclude. */
export const FLAG_COPY =
  'Prompt a human re-read of this item. This is not a finding about the item’s quality.';

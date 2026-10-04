/**
 * Hand-computed item-analysis fixtures.  (P11-T12)
 *
 * ## WHY THESE EXIST AT ALL, GIVEN THERE ARE 192 PROPERTY TESTS
 *
 * A property test establishes that the implementation is *internally* consistent: it does not diverge from itself,
 * it is monotone, it is symmetric. It cannot establish that it agrees with the PUBLISHED FORMULA. A property that
 * encodes a wrong definition of point-biserial passes forever.
 *
 * So every number below is computed BY HAND from the formula in `plans/08`, written out, and then asserted against the
 * implementation. When the two disagree, one of them is wrong and the fixture says which is which -- the hand
 * computation is not derived from the code, so it can catch the code being wrong.
 *
 * ## AND THEY CARRY THE SAME REVIEW HONESTY AS THE ANSWER FIXTURES
 *
 * `P7-T5`'s fixtures are marked unreviewed because "reviewed" and "not reviewed" must not look the same in a file
 * whose numbers decide students' grades. These numbers decide whether an author is told to rewrite an item, which is
 * the same class of consequence, so `reviewedBy` is here too -- and `REVIEW_IS_COMPLETE()` is false until a second
 * person signs it.
 *
 * ## THE HAND COMPUTATIONS ARE WRITTEN OUT, NOT JUST THE RESULTS
 *
 * Each fixture records `worked` showing the arithmetic. A fixture whose expected value is a bare number is a number
 * nobody can check, and the whole point of this file is that a reader can check it.
 */

/** Per-fixture review state. `null` means unreviewed, which is NOT the same as approved. */
export interface FixtureReview {
  readonly reviewedBy: string | null;
  readonly reviewedAt: string | null;
}

export const NOT_REVIEWED: FixtureReview = { reviewedBy: null, reviewedAt: null };

export interface ItemAnalysisFixture {
  readonly id: string;
  /** What the fixture is constructed to exercise. */
  readonly purpose: string;
  /**
   * THE HAND COMPUTATION, written out.
   *
   * `null` where the case is about a refusal rather than a number -- and that distinction is the point, because a
   * refusal with an expected number attached would be asking the implementation to produce one.
   */
  readonly worked: string | null;
  /** One student's score on every item, in item order. */
  readonly scores: readonly (readonly number[])[];
  /** The expected indices, `null` for the refused ones. */
  readonly expected: {
    readonly pFull: number | null;
    readonly pCredit: number | null;
    readonly restScoreD: number | null;
    readonly dIsUndefined: boolean;
  };
  readonly review: FixtureReview;
}

/**
 * THE COHORT SHAPE EVERY FIXTURE USES.
 *
 * `k = 5` items, `n = 30` students, `maxPoints = 5`. Thirty because the 27% split is then `floor(30 x 0.27) = 8`
 * exactly, so the groups can be counted by hand; five because five is small enough to write a row out.
 *
 * `restScore` is the row SUM, which is what the corrected-D split sorts on.
 */
const K = 5;
const N = 30;
/** `floor(30 x 0.27) = floor(8.1) = 8`. Written as an expression so the rounding is visible. */
const GROUP = Math.floor(N * 0.27);

const row = (value: number): readonly number[] => Array.from({ length: K }, () => value);
const repeat = (value: number, count: number): readonly (readonly number[])[] =>
  Array.from({ length: count }, () => row(value));

const concat = (
  ...groups: readonly (readonly (readonly number[])[])[]
): readonly (readonly number[])[] => [...groups.flat()];

export const ITEM_ANALYSIS_FIXTURES: readonly ItemAnalysisFixture[] = Object.freeze([
  {
    id: 'homogeneous-form',
    purpose:
      'The arithmetic check. The two 27% groups are built to differ on every item, so D reaches its maximum of 1 ' +
      'without a calculator, and pFull and pCredit are both simple fractions of 30.',
    worked:
      'Rows: 8 scoring 5 (full credit), 14 scoring 3, 8 scoring 0. ' +
      'pFull = 8/30, because only the all-5 rows earn full credit. ' +
      'pCredit = (8x1 + 14x(3/5) + 8x0)/30 = (8 + 8.4)/30 = 16.4/30 = 82/150, so the divergence from pFull is ' +
      '0.28, comfortably over the 0.2 finding threshold. (The middle rows were originally 2, which gives 0.187 -- ' +
      'UNDER the threshold, so the fixture did not exercise the divergence its own comment claimed.) ' +
      'The 27% split is floor(30 x 0.27) = floor(8.1) = 8. Sorted by rest score, the lowest 8 are the all-0 rows ' +
      '(pLower = 0) and the highest 8 are the all-5 rows (pUpper = 1). ' +
      'D = (1 - 0)/(1 + 0) = 1.',
    scores: concat(repeat(5, GROUP), repeat(3, N - GROUP * 2), repeat(0, GROUP)),
    expected: {
      pFull: 8 / N,
      pCredit: 82 / 150,
      restScoreD: 1,
      dIsUndefined: false,
    },
    review: NOT_REVIEWED,
  },
  {
    id: 'no-one-scored-full-credit',
    purpose:
      'The refusal case. Nobody earns full credit at either end of the range, so pUpper + pLower = 0 and the ratio ' +
      'for D is undefined.',
    worked:
      'All 30 rows score 4 of 5, so every rest score is equal and the sorted order is arbitrary but harmless. ' +
      'pFull = 0, because no row is all-5. ' +
      'pCredit = 30 x (4/5) / 30 = 4/5. ' +
      'Both 27% groups have full-credit rate 0, so pUpper + pLower = 0 and D = 0/0, which is undefined. Reported ' +
      'as 0 WITH a note: the subtraction variant gives NaN and the multiplicative variant gives 2, and 2 reads as ' +
      'excellent discrimination on an item nobody could do.',
    scores: repeat(4, N),
    expected: { pFull: 0, pCredit: 4 / 5, restScoreD: 0, dIsUndefined: true },
    review: NOT_REVIEWED,
  },
  {
    id: 'unreadable-row-is-zero-not-absent',
    purpose:
      'A present-but-unreadable response contributes 0, NOT as if the row were absent. 29/30 and 1 differ by a ' +
      'single row, and that row is the whole finding.',
    worked:
      'One row scores 0 of 5 and the other 29 score 5 of 5. ' +
      'pFull = 29/30 exactly, and pCredit = (29x1 + 1x0)/30 = 29/30, because the zero row contributed nothing to ' +
      'either. Had the row been ABSENT rather than zero, both would be exactly 1. ' +
      'For D, the single zero row sorts alone at the bottom; the lower group of 8 is that row plus 7 full rows, ' +
      'so pLower = 7/8 and pUpper = 1, giving D = (1 - 7/8)/(1 + 7/8) = (1/8)/(15/8) = 1/15.',
    scores: concat(repeat(0, 1), repeat(5, N - 1)),
    expected: { pFull: 29 / N, pCredit: 29 / N, restScoreD: 1 / 15, dIsUndefined: false },
    review: NOT_REVIEWED,
  },
  {
    id: 'a-perfect-item-is-both-easy-and-discriminating',
    purpose:
      'WHY D MUST NOT BE READ AS DIFFICULTY. A textbook item can be perfectly discriminating (D = 1) AND far too easy ' +
      '(11 of 30 students at full credit). Discrimination and difficulty are separate questions, and an author shown ' +
      'only D would keep an item that measures nothing.',
    worked:
      'Rows: 11 scoring 5 and 19 scoring 3. ' +
      'pFull = 11/30. ' +
      'pCredit = (11x1 + 19x(3/5))/30 = (11 + 11.4)/30 = 22.4/30 = 112/150. ' +
      'Rest scores are 25 for the all-5 rows and 15 for the all-3 rows. Sorted ASCENDING, the lowest 8 are all-3 ' +
      'rows -- so pLower = 0 -- and the highest 8 are all-5 rows, so pUpper = 1. ' +
      'D = (1 - 0)/(1 + 0) = 1. The maximum. ' +
      'My first version of this fixture asserted D = 0 on the reasoning that both groups sat inside the all-5 block, ' +
      'which has the sort order backwards: LOW rest scores are the LOW group. The implementation was right.',
    scores: concat(repeat(5, 11), repeat(3, N - 11)),
    expected: { pFull: 11 / N, pCredit: 112 / 150, restScoreD: 1, dIsUndefined: false },
    review: NOT_REVIEWED,
  },
]);

/** The fixtures a second person still has to sign. */
export const unreviewedItemAnalysisFixtures = (): readonly ItemAnalysisFixture[] =>
  ITEM_ANALYSIS_FIXTURES.filter((fixture) => fixture.review.reviewedBy === null);

/**
 * FALSE UNTIL A SECOND PERSON SIGNS.
 *
 * Deliberately a function rather than a constant, so it cannot be optimised away or asserted once and forgotten -- and
 * so the day somebody signs, the change is visible in a diff rather than invisible in a running process.
 */
export const REVIEW_IS_COMPLETE = (): boolean => unreviewedItemAnalysisFixtures().length === 0;

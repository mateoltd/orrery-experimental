/**
 * The hand-computed fixtures.  (P11-T12)
 *
 * The point of this file is the sentence in its header: a property test establishes that the implementation is
 * internally consistent, and CANNOT establish that it agrees with the published formula. A property encoding a wrong
 * definition of point-biserial passes forever. So these fixtures carry hand arithmetic written out, and the
 * implementation is checked against it.
 */

import { describe, expect, it } from 'vitest';

import { correctedD } from './discrimination.js';
import { facility as facilityOf } from './facility.js';
import {
  ITEM_ANALYSIS_FIXTURES,
  REVIEW_IS_COMPLETE,
  unreviewedItemAnalysisFixtures,
} from './fixtures.js';

const outcomesFor = (scores: readonly (readonly number)[], max = 5) =>
  scores.map((row) => ({
    awarded: row.reduce((sum, value) => sum + value, 0) / row.length,
    maxPoints: max,
    restScore: row.reduce((sum, value) => sum + value, 0),
    scorable: true,
  }));

const asResponses = (scores: readonly (readonly number)[], max = 5) =>
  scores.map((row) => ({
    pointsAwarded: row.reduce((sum, value) => sum + value, 0) / row.length,
    maxPoints: max,
    scorable: true,
  }));

describe('every fixture is HAND-COMPUTED and says so', () => {
  it('records the arithmetic, because a bare expected value is a number nobody can check', () => {
    for (const fixture of ITEM_ANALYSIS_FIXTURES) {
      expect(fixture.worked, fixture.id).not.toBeNull();
      expect(fixture.worked?.length ?? 0, fixture.id).toBeGreaterThan(60);
    }
  });

  it('states a purpose, so a reader knows what the case is for before reading the numbers', () => {
    for (const fixture of ITEM_ANALYSIS_FIXTURES) {
      expect(fixture.purpose.trim().length, fixture.id).toBeGreaterThan(20);
    }
  });
});

/**
 * THE FIXTURES, CHECKED AGAINST THE IMPLEMENTATION.
 *
 * Each assertion pairs an expected value with the fixture's own `worked` string, so a reader who wants to check the
 * arithmetic by hand has it beside the assertion -- and a fixture edited without its arithmetic would fail here.
 */
const check = (index: number) => {
  // The index is a test-local constant and the array is non-empty by construction, so a missing entry is a broken
  // test rather than a condition to handle. Returning a thrown error says which fixture is absent.
  const fixture = ITEM_ANALYSIS_FIXTURES[index];
  if (fixture === undefined) throw new Error(`no fixture at index ${String(index)}`);
  const scores = fixture.scores;
  return {
    fixture,
    facility: facilityOf(asResponses(scores)),
    discrimination: correctedD(outcomesFor(scores)),
  };
};

describe('fixture 1: the arithmetic check that needs no calculator', () => {
  const { fixture, facility: f, discrimination } = check(0);

  it('computes pFull as 8/30, because only the all-5 rows earn full credit', () => {
    expect(f.pFull).toBeCloseTo(fixture.expected.pFull ?? 0, 12);
    expect(f.pFull).toBeCloseTo(8 / 30, 12);
  });

  it('computes pCredit as 16.4/30, a divergence of 0.28 that CROSSES the finding threshold', () => {
    expect(f.pCredit).toBeCloseTo(82 / 150, 12);
    // A divergence is EVIDENCE, not a discrepancy to reconcile. The middle rows were originally 2, giving 0.187 --
    // UNDER the 0.2 threshold -- so the fixture did not exercise what its own comment claimed.
    expect(f.pCredit - f.pFull).toBeGreaterThanOrEqual(0.2);
    expect(f.isPartialCreditFinding).toBe(true);
  });

  it('reaches D = 1, because the two 27% groups differ on every item', () => {
    // floor(30 x 0.27) = 8, sorted by rest score: lowest 8 are all-0, highest 8 are all-5. (1-0)/(1+0) = 1.
    expect(discrimination.d).toBe(1);
    expect(discrimination.dIsUndefined ?? discrimination.note).toBeDefined();
  });

  it('reports the group size the 27% split actually used', () => {
    // floor(8.1) = 8, not 8.1 and not 9. The rounding is the part worth pinning.
    expect(Math.floor(30 * 0.27)).toBe(8);
    expect(discrimination.pUpper).toBe(1);
    expect(discrimination.pLower).toBe(0);
  });
});

describe('fixture 2: the refusal, not a number', () => {
  const { fixture, facility: f, discrimination } = check(1);

  it('reports pFull 0 while pCredit stays at 4/5', () => {
    // Nobody is all-5, but everyone earned four fifths -- so "nobody got it" and "nobody got anything" are different.
    expect(f.pFull).toBe(0);
    expect(f.pCredit).toBeCloseTo(4 / 5, 12);
    expect(f.isPartialCreditFinding).toBe(true);
  });

  it('reports D as 0 with a NOTE, because the alternatives are worse', () => {
    // pUpper + pLower = 0, so D = 0/0. The subtraction variant gives NaN and the multiplicative one gives 2, and 2
    // reads as excellent discrimination on an item nobody could do.
    expect(discrimination.d).toBe(0);
    expect(discrimination.note).toContain('undefined');
    expect(fixture.expected.dIsUndefined).toBe(true);
  });
});

describe('fixture 3: a zero row is not an absent row', () => {
  const { fixture, facility: f, discrimination } = check(2);

  it('computes 29/30 for BOTH measures, and the single row is the whole finding', () => {
    expect(f.pFull).toBeCloseTo(29 / 30, 12);
    expect(f.pCredit).toBeCloseTo(29 / 30, 12);
    // Had the row been ABSENT rather than zero, both would be exactly 1.
    expect(f.pFull).not.toBe(1);
    expect(fixture.expected.pFull).toBeCloseTo(29 / 30, 12);
  });

  it('computes D = 1/15, because the lower group of 8 contains the zero row and seven full rows', () => {
    // pLower = 7/8, pUpper = 1, so D = (1/8)/(15/8) = 1/15.
    expect(discrimination.d).toBeCloseTo(1 / 15, 12);
    expect(discrimination.pLower).toBeCloseTo(7 / 8, 12);
  });
});

describe('fixture 4: an easy item can still discriminate perfectly', () => {
  const { fixture, facility: f, discrimination } = check(3);

  it('reports 11/30 full credit, which reads as an easy item', () => {
    expect(f.pFull).toBeCloseTo(11 / 30, 12);
  });

  it('gives D = 1 -- the MAXIMUM -- while the item is far too easy', () => {
    /**
     * Sorted ASCENDING, the lowest 8 are the all-3 rows and the highest 8 are all-5 rows. My first version of this
     * fixture asserted D = 0 on the reasoning that both groups sat inside the all-5 block, which has the sort order
     * backwards: LOW rest scores are the LOW group. The implementation was right.
     *
     * The lesson survives the correction and is the reason the fixture exists: an item can discriminate perfectly and
     * still measure nothing, so an author shown only D keeps it.
     */
    expect(discrimination.d).toBe(1);
    expect(discrimination.pLower).toBe(0);
    expect(discrimination.pUpper).toBe(1);
    expect(fixture.expected.restScoreD).toBe(1);
  });

  it('computes pCredit as 22.4/30', () => {
    expect(f.pCredit).toBeCloseTo(112 / 150, 12);
  });
});

describe('the review state is HONEST, and the same as P7-T5 requires', () => {
  it('marks every fixture UNREVIEWED, so nothing here claims a second pair of eyes', () => {
    // These numbers decide whether an author is told to rewrite an item. That is the same class of consequence as
    // the answer fixtures, and "reviewed" and "not reviewed" must not look the same in a file that decides grades.
    expect(unreviewedItemAnalysisFixtures()).toHaveLength(ITEM_ANALYSIS_FIXTURES.length);
    expect(REVIEW_IS_COMPLETE()).toBe(false);
  });

  it('marks each fixture individually rather than with one flag for the file', () => {
    for (const fixture of ITEM_ANALYSIS_FIXTURES) {
      expect(fixture.review.reviewedBy, fixture.id).toBeNull();
      expect(fixture.review.reviewedAt, fixture.id).toBeNull();
    }
  });

  it('exposes REVIEW_IS_COMPLETE as a FUNCTION, so a signature shows up in a diff', () => {
    // A constant would be asserted once and then read as a fact about the file, which is exactly the thing that is
    // most likely to become untrue without anybody noticing.
    expect(typeof REVIEW_IS_COMPLETE).toBe('function');
  });
});

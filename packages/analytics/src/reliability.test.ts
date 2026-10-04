/**
 * Cronbach's α and Spearman–Brown.  (P11-T5)
 *
 * The refusals are the tests that matter here. `P-12` records that α was originally used to answer "is this pool deep
 * enough?", and that the question **cannot be answered by α** -- so the pooled case must be a refusal rather than a
 * number, and the only way to test that is to pass a pooled form and check nothing comes back.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { ALPHA_MIN_K, ALPHA_MIN_N, cronbachAlpha, spearmanBrown } from './reliability.js';

/** Deterministic, homogeneous-ish responses: no `Math.random` (INV-RNG-1). */
const cohort = (n: number, k: number, spread = 1) =>
  Array.from({ length: n }, (_, student) => ({
    // A student-level offset plus a per-item wobble, so items correlate without being identical.
    scores: Array.from({ length: k }, (_, item) =>
      Math.max(
        0,
        Math.min(
          4,
          2 +
            ((student * 7 + item * 3) % 5) -
            2 +
            (student % (spread + 1)) -
            Math.floor(spread / 2),
        ),
      ),
    ),
  }));

describe('α is REFUSED for a pooled assessment, which is the correction P-12 exists for', () => {
  it('returns nothing at all when the form is not fixed', () => {
    const result = cronbachAlpha({
      responses: cohort(60, 12),
      isFixedForm: false,
      itemCount: null,
    });
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.reason).toContain('fixed form');
      // The specific wrong reading this prevents: someone treating a pooled α as a statement about the pool.
      expect(result.reason).toContain('nobody sat');
    }
  });

  it('gives EVERY refusal a caveat, because a blank tile reads as a bug rather than a decision', () => {
    const pooled = cronbachAlpha({
      responses: cohort(60, 12),
      isFixedForm: false,
      itemCount: null,
    });
    const tooFewK = cronbachAlpha({ responses: cohort(60, 4), isFixedForm: true, itemCount: 4 });
    const tooFewN = cronbachAlpha({ responses: cohort(10, 12), isFixedForm: true, itemCount: 12 });
    for (const result of [pooled, tooFewK, tooFewN]) {
      if (result.ok === false) expect(result.caveat.length, result.reason).toBeGreaterThan(40);
    }
  });
});

describe('α is gated on k and N', () => {
  it('refuses below 10 items, where `k/(k-1)` is a division by zero or nearly one', () => {
    for (const k of [1, 2, 5, 9]) {
      const result = cronbachAlpha({ responses: cohort(60, k), isFixedForm: true, itemCount: k });
      expect(result.ok, String(k)).toBe(false);
      if (result.ok === false) expect(result.reason).toContain(String(ALPHA_MIN_K));
    }
  });

  it('refuses below 30 students, where one student swings the number', () => {
    const result = cronbachAlpha({
      responses: cohort(ALPHA_MIN_N - 1, 12),
      isFixedForm: true,
      itemCount: 12,
    });
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.reason).toContain(String(ALPHA_MIN_N));
  });

  it('reports a number at and above both floors', () => {
    const result = cronbachAlpha({
      responses: cohort(ALPHA_MIN_N, ALPHA_MIN_K),
      isFixedForm: true,
      itemCount: ALPHA_MIN_K,
    });
    expect(result.ok).toBe(true);
    if (result.ok === true) {
      expect(result.alpha.value).not.toBeNull();
      expect(result.alpha.value).toBeGreaterThan(-1);
    }
  });

  it('IGNORES responses whose score count does not match `k`, rather than padding them', () => {
    // A short row means the student did not see this form. Including it with implicit zeros would lower α for a
    // reason that has nothing to do with the items.
    const mixed = [...cohort(40, 12), { scores: [1, 2] }];
    const result = cronbachAlpha({ responses: mixed, isFixedForm: true, itemCount: 12 });
    expect(result.ok).toBe(true);
    if (result.ok === true) expect(result.n).toBe(40);
  });
});

describe('the degenerate case where everybody scored the same', () => {
  it('refuses rather than reporting 0, which would say the items CONTRADICT each other', () => {
    const identical = Array.from({ length: 40 }, () => ({
      scores: Array.from({ length: 12 }, () => 3),
    }));
    const result = cronbachAlpha({ responses: identical, isFixedForm: true, itemCount: 12 });
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      // `s² = 0` makes the ratio undefined, and the limit is not 1: a form where everyone scores identically has no
      // internal consistency to measure. Zero would be the opposite claim.
      expect(result.reason).toContain('no score spread');
    }
  });
});

describe('the 0.7-0.8 range is NORMAL, and the caveat says so', () => {
  it('says a classroom value is not a problem', () => {
    const result = cronbachAlpha({ responses: cohort(60, 12), isFixedForm: true, itemCount: 12 });
    expect(result.caveat).toContain('0.7 and 0.8');
    // A coefficient rendered in an alarming colour trains its readers to ignore it, which is how a genuinely low α on
    // a high-stakes instrument gets read as "fine".
    expect(result.caveat).toContain('normal');
  });

  it('always carries the "does not measure the pool" line', () => {
    for (const pooled of [true, false]) {
      const result = cronbachAlpha({
        responses: cohort(60, 12),
        isFixedForm: pooled,
        itemCount: pooled ? 12 : null,
      });
      expect(result.caveat).toContain('does not measure the pool');
    }
  });
});

describe('Spearman–Brown, which §4.2 records was absent from the entire plan', () => {
  it('predicts a HIGHER reliability for a longer form', () => {
    expect(spearmanBrown(0.7, 20)).toBeGreaterThan(0.7);
    expect(spearmanBrown(0.7, 40)).toBeGreaterThan(spearmanBrown(0.7, 20) ?? 0);
  });

  it('refuses a form shorter than the plan’s 20 ITEMS rather than clamping to it', () => {
    // `plans/08` §3.2 gives "Spearman-Brown prediction | 20 items". Clamping would return the prediction FOR 20 ITEMS
    // while the caller asked about a different length, which is a number answering a different question.
    for (const k of [2, 5, 19]) expect(spearmanBrown(0.7, k), String(k)).toBeNull();
    expect(spearmanBrown(0.7, 20)).not.toBeNull();
  });

  it('approaches 1 as the form grows, and never exceeds it', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.05, max: 0.95, noNaN: true }),
        // Starts at the plan's floor of 20 ITEMS: below it the function REFUSES, which is the behaviour the
        // previous fixture was accidentally contradicting by generating lengths the function no longer answers for.
        fc.integer({ min: 20, max: 500 }),
        (alpha, k) => {
          const predicted = spearmanBrown(alpha, k);
          return predicted !== null && predicted > alpha && predicted <= 1;
        },
      ),
      { numRuns: 200 },
    );
  });

  it('returns null rather than extrapolating from a NON-POSITIVE α', () => {
    // α of 0 means the items work against each other, and the formula then predicts a reliability that INCREASES with
    // length -- the opposite of what adding items does to a broken form.
    expect(spearmanBrown(0, 20)).toBeNull();
    expect(spearmanBrown(-0.2, 20)).toBeNull();
    expect(spearmanBrown(1, 20)).toBeNull();
  });

  it('does NOT clamp a short form to the floor', () => {
    // The property above now starts at 20, and this is why: below it the function refuses.
    expect(spearmanBrown(0.8, 19)).toBeNull();
  });

  it('returns null for a form length that cannot exist', () => {
    expect(spearmanBrown(0.8, 1)).toBeNull();
    expect(spearmanBrown(0.8, 0)).toBeNull();
  });
});

/**
 * The validity caveats.  (P11-T3)
 *
 * §3.3 is the one that changes what a report is ALLOWED to do, so most of these tests are about `apply` rather than
 * about the caveat text. `P-8` records that the original said "sort by severity and show the top issues", which is
 * selection on the dependent variable -- it guarantees the selected items look worse than they are and guarantees the
 * reader believes it.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  applicableCaveats,
  apply,
  CAVEATS,
  type CaveatId,
  FLAG_COPY,
  indexLabel,
  type ReportFacts,
} from './caveats.js';

const report = (over: Partial<ReportFacts> = {}): ReportFacts => ({
  itemCount: 4,
  reportedN: 500,
  hasPartialCredit: false,
  isPooled: false,
  orderCarriesMeaning: false,
  hasFlaggedDependency: false,
  ...over,
});

describe('every caveat has wording, because an icon with no explanation is worse than no icon', () => {
  it('covers the five `plans/08` §3 requires', () => {
    const ids = CAVEATS.map((caveat) => caveat.id).sort();
    expect(ids).toEqual([
      'GRADING_MODEL_DEPENDENCE',
      'LOCAL_ITEM_DEPENDENCY',
      'MULTIPLE_COMPARISONS',
      'SMALL_SAMPLE',
      'UNEQUAL_ITEM_COUNTS',
    ]);
  });

  it('gives each one a label and a substantial body', () => {
    for (const caveat of CAVEATS) {
      expect(caveat.label.trim().length, caveat.id).toBeGreaterThan(0);
      expect(caveat.body.trim().length, caveat.id).toBeGreaterThan(40);
    }
  });
});

describe('a caveat is SHOWN only when it applies', () => {
  const shown = (facts: ReportFacts): CaveatId[] =>
    applicableCaveats(facts).map((caveat) => caveat.id);

  it('shows no caveats for a small, unpooled, all-or-nothing paper', () => {
    expect(shown(report())).toEqual([]);
  });

  it('keys SMALL_SAMPLE on the REPORTED N, not the cohort size', () => {
    /**
     * A 500-student paper whose displayed cell used 12 responses IS a small sample. Reading the cohort size here is
     * the mistake the condition exists to prevent, and it is the one a reader makes too.
     */
    expect(shown(report({ reportedN: 12 }))).toContain('SMALL_SAMPLE');
    expect(shown(report({ reportedN: 500 }))).not.toContain('SMALL_SAMPLE');
  });

  it('shows MULTIPLE_COMPARISONS once a paper produces many indices', () => {
    expect(shown(report({ itemCount: 4 }))).not.toContain('MULTIPLE_COMPARISONS');
    expect(shown(report({ itemCount: 40 }))).toContain('MULTIPLE_COMPARISONS');
  });

  it('shows GRADING_MODEL_DEPENDENCE exactly when partial credit exists', () => {
    // With partial credit a response is polytomous, so the dichotomous indices approximate -- and the report has to
    // say so rather than presenting an approximation as a measurement.
    expect(shown(report({ hasPartialCredit: true }))).toContain('GRADING_MODEL_DEPENDENCE');
    expect(shown(report({ hasPartialCredit: false }))).not.toContain('GRADING_MODEL_DEPENDENCE');
  });

  it('shows UNEQUAL_ITEM_COUNTS for a pooled draw, but NOT for an ordered scale', () => {
    expect(shown(report({ isPooled: true }))).toContain('UNEQUAL_ITEM_COUNTS');
    // An ordered scale also gives students different items, and it is deliberate -- flagging it would be noise.
    expect(shown(report({ isPooled: true, orderCarriesMeaning: true }))).not.toContain(
      'UNEQUAL_ITEM_COUNTS',
    );
  });

  it('shows LOCAL_ITEM_DEPENDENCY only when a dependency was DETECTED', () => {
    // Conditional for the same reason as every other caveat: an icon shown unconditionally trains readers to dismiss
    // all of them, and showing it when there is nothing to see spends attention the report has not earned.
    expect(shown(report({ hasFlaggedDependency: false }))).not.toContain('LOCAL_ITEM_DEPENDENCY');
    expect(shown(report({ hasFlaggedDependency: true }))).toContain('LOCAL_ITEM_DEPENDENCY');
  });

  it('is stable in order, so a report does not reshuffle its icons between page loads', () => {
    const facts = report({ itemCount: 40, reportedN: 12, hasPartialCredit: true, isPooled: true });
    expect(JSON.stringify(applicableCaveats(facts))).toBe(JSON.stringify(applicableCaveats(facts)));
  });
});

describe('§3.3: NOTHING IS RANKED BY A SINGLE INDEX', () => {
  const items = [
    { item: 'worst-on-paper', intervalLow: -0.1, intervalHigh: 0.1 },
    { item: 'best-on-paper', intervalLow: 0.6, intervalHigh: 0.8 },
    { item: 'middle', intervalLow: 0.2, intervalHigh: 0.5 },
  ];

  it('returns items in the ORDER GIVEN, with no severity sort', () => {
    // Sorting here is `P-8`'s original design: selecting on the dependent variable guarantees the selected items
    // look worse than they are, and the reader believes it.
    expect(apply(items, 0.3).map((entry) => entry.item)).toEqual([
      'worst-on-paper',
      'best-on-paper',
      'middle',
    ]);
  });

  it('is order-independent in what it decides, so a re-sort cannot change which items are flagged', () => {
    const forward = apply(items, 0.3)
      .filter((entry) => entry.flagged)
      .map((entry) => entry.item);
    const reversed = apply([...items].reverse(), 0.3)
      .filter((entry) => entry.flagged)
      .map((entry) => entry.item);
    expect([...reversed].sort()).toEqual([...forward].sort());
  });
});

describe('a flag requires the interval to EXCLUDE the threshold', () => {
  it('flags when the WHOLE interval sits below it', () => {
    const [entry] = apply([{ item: 'a', intervalLow: 0.05, intervalHigh: 0.25 }], 0.3);
    expect(entry?.flagged).toBe(true);
    expect(entry?.flagReason).toContain('human re-read');
  });

  it('does NOT flag when the interval CONTAINS the threshold', () => {
    /**
     * `[0.05, 0.55]` around a 0.30 threshold contains it, which means the data cannot tell you which side it is on.
     * A flag there is an accusation made on an interval that argues against it.
     */
    const [entry] = apply([{ item: 'a', intervalLow: 0.05, intervalHigh: 0.55 }], 0.3);
    expect(entry?.flagged).toBe(false);
    expect(entry?.flagReason).toBeNull();
  });

  it('does NOT flag when the interval straddles the threshold from above', () => {
    const [entry] = apply([{ item: 'a', intervalLow: 0.25, intervalHigh: 0.45 }], 0.3);
    expect(entry?.flagged).toBe(false);
  });

  it('never flags an interval that EXCLUDES the threshold only by sitting ABOVE it', () => {
    // "Flagged" means "needs a re-read", and a well-measured STRONG item does not.
    const [entry] = apply([{ item: 'a', intervalLow: 0.7, intervalHigh: 0.9 }], 0.3);
    expect(entry?.flagged).toBe(false);
    expect(entry?.flagReason).toContain('above the threshold');
  });

  it('flags exactly when the upper bound is below the threshold, for any interval', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -1, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 0.001, noNaN: true }),
        (low, span) => {
          const high = Math.min(1, low + span);
          return (
            apply([{ item: 'a', intervalLow: low, intervalHigh: high }], 0.3)[0]?.flagged ===
            high < 0.3
          );
        },
      ),
      { numRuns: 300 },
    );
  });

  it('flags NOTHING for an empty report rather than throwing', () => {
    expect(apply([], 0.3)).toEqual([]);
  });
});

describe('a near-zero or negative index is UNRELIABLE, not a problem', () => {
  it('labels zero and below as "not evidence of a problem"', () => {
    // §3.3's exact wording. A near-zero index means the index could not be measured, and reporting it as a defect
    // INVENTS a defect.
    for (const value of [0, -0.001, -0.4]) {
      expect(indexLabel(value).label, String(value)).toBe('unreliable — not evidence of a problem');
      expect(indexLabel(value).isProblem, String(value)).toBe(false);
    }
  });

  it('never ASSERTS a problem, for any value at all', () => {
    /**
     * The pattern matches an ASSERTION, not the word. My first version was `/problem/i`, which flagged the plan's own
     * wording -- "unreliable -- not evidence of a problem" -- because "problem" appears inside a phrase that denies
     * one. That is the same mistake as the hardening hatch copy earlier: matching a word near a negation tests nothing.
     */
    fc.assert(
      fc.property(fc.double({ min: -1e6, max: 1e6, noNaN: true }), (value) => {
        const label = indexLabel(value);
        return (
          !label.isProblem &&
          !/\b(is|has|shows) a problem\b|\b(broken|defect|poor|b)\b/i.test(label.label)
        );
      }),
      { numRuns: 400 },
    );
  });

  it('treats a NON-FINITE index as unreliable rather than crashing a report', () => {
    expect(indexLabel(Number.NaN).label).toContain('unreliable');
    expect(indexLabel(Number.POSITIVE_INFINITY).label).toContain('unreliable');
  });

  it('calls a measured positive index "measured", which claims nothing either way', () => {
    expect(indexLabel(0.5)).toEqual({ label: 'measured', isProblem: false });
  });
});

describe('the flag copy ASKS rather than concludes', () => {
  it('prompts a human re-read and states it is not a finding about quality', () => {
    expect(FLAG_COPY).toContain('Prompt a human re-read');
    expect(FLAG_COPY).toContain('not a finding');
  });

  it('contains no word that concludes', () => {
    expect(FLAG_COPY.toLowerCase()).not.toMatch(/broken|defect|poor|bad|problem with|fail/);
  });
});

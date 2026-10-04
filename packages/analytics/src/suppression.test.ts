/**
 * Suppression at small N.  (P11-T2)
 *
 * The property `plans/08` §9 states is absolute: "Below any threshold, the function returns `null`, never a number."
 * So it is tested as a property over the whole floor table rather than case by case, and the two-layer requirement is
 * tested from both directions -- because a suppression rule that only one layer enforces is one bug away from a
 * published number.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  assertSuppressedByQueryLayer,
  SUPPRESSION_FLOORS,
  type SuppressibleStat,
  suppress,
  suppressReport,
} from './suppression.js';

const STATS = Object.keys(SUPPRESSION_FLOORS) as readonly SuppressibleStat[];

describe('below any threshold, the value is null and NEVER a number', () => {
  it('holds for every statistic and every n below its floor', () => {
    fc.assert(
      fc.property(fc.constantFrom(...STATS), fc.integer({ min: 0, max: 400 }), (stat, n) => {
        const result = suppress(0.87, stat, n);
        if (n < SUPPRESSION_FLOORS[stat]) {
          // Not 0, not 0.0, not NaN. `null`, so there is nothing to render and nothing to round-trip through a cache
          // into looking like data.
          return result.value === null && result.suppressed === true;
        }
        return result.value === 0.87 && result.suppressed === false;
      }),
      { numRuns: 400 },
    );
  });

  it('suppresses at exactly one below the floor and shows at exactly the floor', () => {
    // An off-by-one here either publishes a number computed from 99 students or hides one computed from 100.
    for (const stat of STATS) {
      const floor = SUPPRESSION_FLOORS[stat];
      expect(suppress(0.5, stat, floor - 1).suppressed, stat).toBe(true);
      expect(suppress(0.5, stat, floor).suppressed, stat).toBe(false);
    }
  });

  it('gives every suppression a REASON a report can show', () => {
    // A bare "suppressed" leaves a teacher unable to tell a small cohort from a broken query.
    const result = suppress(0.5, 'correlation', 12);
    expect(result.suppressed).toBe(true);
    if (result.suppressed) {
      expect(result.reason).toContain('12');
      expect(result.reason).toContain('100');
    }
  });

  it('reports the floor it applied, so the two layers can be compared', () => {
    expect(suppress(0.5, 'distractor', 100).floor).toBe(SUPPRESSION_FLOORS.distractor);
  });

  it('THROWS on an unknown statistic rather than defaulting to no floor', () => {
    // A typo in a caller must not become "no floor", which would un-suppress the statistic it names.
    expect(() => suppress(0.5, 'nonsense' as SuppressibleStat, 1_000)).toThrow(/unknown statistic/);
  });

  it('CANNOT be un-suppressed by asking for a smaller floor', () => {
    // The floor is looked up by name, not passed in. A version taking `minN` as a parameter would let any caller lower
    // it, which is the failure this module exists to make impossible.
    expect(suppress.length).toBe(3);
    const result = suppress(0.42, 'correlation', 3);
    expect(result.floor).toBe(SUPPRESSION_FLOORS.correlation);
    expect(result.value).toBeNull();
  });
});

describe('the floors DIFFER, and the difference is reasoned', () => {
  it('holds a correlation to a much higher N than a facility', () => {
    // A proportion is stable early; a standardised moment is not. Using one floor for both means either suppressing too
    // much or publishing a correlation computed from thirty students.
    expect(SUPPRESSION_FLOORS.correlation).toBeGreaterThan(SUPPRESSION_FLOORS.facility);
    expect(SUPPRESSION_FLOORS.distractor).toBeGreaterThanOrEqual(SUPPRESSION_FLOORS.discrimination);
  });

  it('derives the correlation floor from the plan rather than re-typing 100', () => {
    expect(SUPPRESSION_FLOORS.correlation).toBe(100);
    expect(SUPPRESSION_FLOORS.distractor).toBe(30);
  });
});

describe('suppression is in BOTH layers, so a bug in one does not publish a number', () => {
  it('catches the QUERY LAYER producing a value the pure layer suppresses -- a LEAK', () => {
    const verdict = assertSuppressedByQueryLayer('correlation', 20, 0.42);
    expect(verdict.agrees).toBe(false);
    // The dangerous direction: the pure layer suppressed it and the query layer did not.
    expect(verdict.reason).toContain('QUERY LAYER PRODUCED');
  });

  it('agrees when both layers suppress', () => {
    const verdict = assertSuppressedByQueryLayer('correlation', 20, null);
    expect(verdict.agrees).toBe(true);
    expect(verdict.reason).toBe('both layers suppressed');
  });

  it('catches the OTHER direction too -- the query layer hiding what the pure layer would show', () => {
    const verdict = assertSuppressedByQueryLayer('correlation', 500, null);
    expect(verdict.agrees).toBe(false);
    expect(verdict.reason).toContain('would show');
  });

  it('agrees when both layers show the value', () => {
    const verdict = assertSuppressedByQueryLayer('correlation', 500, 0.42);
    expect(verdict.agrees).toBe(true);
    expect(verdict.reason).toBe('both layers agree');
  });
});

describe('a report panel shares ONE floor', () => {
  it('suppresses EVERYTHING below the floor, not just the weakest tile', () => {
    // The alternative -- each tile deciding for itself -- is how a report ends up showing a facility of 0.85 beside a
    // correlation from thirty students with nothing saying the two are not comparable.
    const result = suppressReport({ facility: 0.85, rPb: null, d: 0.4 }, 30, 100);
    expect(Object.values(result.values).every((value) => value === null)).toBe(true);
    expect(result.suppressed).toContain('rPb');
    expect(result.reason).toContain('before any of these numbers');
  });

  it('suppresses everything when the floor is met, since the panel is one claim', () => {
    const result = suppressReport({ facility: 0.85, rPb: 0.42 }, 500, 100);
    expect(result.suppressed).toEqual([]);
    expect(result.values).toEqual({ facility: 0.85, rPb: 0.42 });
  });

  it('uses the COHORT SIZE and never the magnitude of a statistic', () => {
    // The first version compared the values against the floor, so a facility of 0.02 read as "fewer than 100
    // responses" and the whole panel was suppressed, while a facility of 0.85 on THREE students was shown. That is
    // comparing a proportion against a sample size, and it hides a difficult item's facility while showing an easy
    // one's on data too small for either.
    const difficult = suppressReport({ facility: 0.02, rPb: 0.9 }, 500, 100);
    expect(Object.values(difficult.values)).toEqual([0.02, 0.9]);

    const tinyCohort = suppressReport({ facility: 0.85, rPb: 0.9 }, 3, 100);
    expect(Object.values(tinyCohort.values)).toEqual([null, null]);
  });

  it('suppresses EVERY key below the floor, because the panel is one claim', () => {
    const result = suppressReport({ facility: null, rPb: 0.42 }, 30, 100);
    // Showing the one that happens to be present, with nothing saying the others were withheld, is how a reader
    // compares numbers that are not comparable.
    expect(result.suppressed).toEqual(['facility', 'rPb']);
    expect(result.reason).toContain('30');
  });
});

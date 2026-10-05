/**
 * No breach without an event.  (`ADV-A2`)
 *
 * `adversarial/non-accusation.test.ts` pins the defect as it was found: a threshold of `0`, a count of zero. The fix
 * could have been `threshold === 0 && count === 0`, which turns that test green and leaves the rule false for every
 * other number at or below zero. So this states the rule over the whole domain, and then pins the two things the fix
 * must not have done: made zero tolerance mean "never", and made "never" mean zero.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { classifyBreaches, evaluateEscalation, LADDER, type ViolationKind } from './escalation.js';

const RUNS = 300;

const KINDS: readonly ViolationKind[] = [
  'fullscreenExit',
  'focusLoss',
  'tabHide',
  'pointerLockLoss',
  'copyAttempt',
];

const thresholdsOf = (value: number | null) => ({
  fullscreenExits: value,
  focusLosses: value,
  tabHides: value,
  pointerLockLosses: value,
  copyAttempts: value,
});

/** Anything a caller could put in a threshold, including what the schema forbids: this function takes plain numbers. */
const anyThreshold = fc.oneof(
  fc.constant(null),
  fc.integer({ min: -5, max: 20 }),
  fc.double({ min: -2, max: 2, noNaN: true }),
  fc.constantFrom(0, -0, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY),
);

const anyThresholds = fc.record({
  fullscreenExits: anyThreshold,
  focusLosses: anyThreshold,
  tabHides: anyThreshold,
  pointerLockLosses: anyThreshold,
  copyAttempts: anyThreshold,
});

describe('a student who has done nothing is in breach of nothing', () => {
  it('breaches no kind at a count of zero, for ANY thresholds at all', () => {
    // What breaks without it: zero tolerance on four kinds puts every student on `FREEZE_AND_SUBMIT` at the first
    // evaluation. Absent counts and explicit zeros are both "nothing happened", so both are driven.
    fc.assert(
      fc.property(anyThresholds, fc.boolean(), (thresholds, explicitZeros) => {
        const counts = explicitZeros ? Object.fromEntries(KINDS.map((kind) => [kind, 0])) : {};
        const report = classifyBreaches({ counts, thresholds, ladder: LADDER });
        expect(report.breached).toEqual([]);
        expect(report.worstKind).toBeNull();
        expect(report.worstOvershoot).toBe(0);

        const verdict = evaluateEscalation({ counts, thresholds, ladder: LADDER });
        expect(verdict.rung).toBe('NONE');
        expect(verdict.freezesAttempt).toBe(false);
      }),
      { numRuns: RUNS },
    );
  });

  it('breaches only kinds that have a count, whatever the thresholds are', () => {
    // The same rule per kind: a kind nobody has an event for cannot be among the reasons.
    fc.assert(
      fc.property(
        anyThresholds,
        fc.subarray([...KINDS]),
        fc.integer({ min: 1, max: 30 }),
        (thresholds, happened, count) => {
          const counts = Object.fromEntries(happened.map((kind) => [kind, count]));
          const report = classifyBreaches({ counts, thresholds, ladder: LADDER });
          for (const kind of report.breached) expect(happened).toContain(kind);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('ignores a NEGATIVE count rather than reading it as progress towards a threshold', () => {
    const report = classifyBreaches({
      counts: { copyAttempt: -3 },
      thresholds: thresholdsOf(0),
      ladder: LADDER,
    });
    expect(report.breached).toEqual([]);
  });
});

describe('zero tolerance is still zero tolerance', () => {
  it('is breached by the FIRST event of a kind, and by that kind alone', () => {
    // The obvious wrong fix is `count > threshold`, under which zero would need one event and three would need four.
    for (const kind of KINDS) {
      const verdict = evaluateEscalation({
        counts: { [kind]: 1 },
        thresholds: thresholdsOf(0),
        ladder: LADDER,
      });
      expect(verdict.reasons, kind).toEqual([kind]);
      // One kind breached is the FIRST rung. Before the fix all five were breached before anything happened.
      expect(verdict.rung, kind).toBe('WARN');
      expect(verdict.freezesAttempt, kind).toBe(false);
    }
  });

  it('keeps every threshold above zero where it was: the Nth event is the breach', () => {
    for (const threshold of [1, 2, 3, 8, 25]) {
      const at = (count: number) =>
        classifyBreaches({
          counts: { tabHide: count },
          thresholds: { ...thresholdsOf(null), tabHides: threshold },
          ladder: LADDER,
        }).breached;
      expect(at(threshold - 1), String(threshold)).toEqual([]);
      expect(at(threshold), String(threshold)).toEqual(['tabHide']);
    }
  });
});

describe('`null` is still NOT POLICED, and is still not zero', () => {
  it('is never breached at any count, where zero is breached at every count but none', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10_000 }), (count) => {
        const counts = Object.fromEntries(KINDS.map((kind) => [kind, count]));

        const unpoliced = classifyBreaches({
          counts,
          thresholds: thresholdsOf(null),
          ladder: LADDER,
        });
        expect(unpoliced.breached).toEqual([]);
        expect(unpoliced.unpoliced).toEqual(KINDS);

        const forbidden = classifyBreaches({ counts, thresholds: thresholdsOf(0), ladder: LADDER });
        expect(forbidden.breached).toEqual(KINDS);
        expect(forbidden.unpoliced).toEqual([]);
      }),
      { numRuns: RUNS },
    );
  });

  it('reports a zero threshold as POLICED even while nothing has happened', () => {
    // The distinction has to survive the case where the two produce the same `breached`: a teacher reading "not
    // policed" for a kind they forbade outright has been told the opposite of their own policy.
    const report = classifyBreaches({ counts: {}, thresholds: thresholdsOf(0), ladder: LADDER });
    expect(report.breached).toEqual([]);
    expect(report.unpoliced).toEqual([]);
  });
});

describe('a consequence of the fix, pinned as it is', () => {
  it('makes a threshold of `0` and a threshold of `1` the same policy', () => {
    /**
     * STATED RATHER THAN HIDDEN. Under `>=` a threshold of 1 has always meant "the first event is the breach", and
     * that is also the only thing zero tolerance can mean once a breach needs an event. So the schema now admits two
     * spellings of one behaviour, which PF-8 names as the sign of a term that has stopped carrying information.
     *
     * It is not resolved here. Rejecting `0`, or redefining thresholds as "the number tolerated", is a change to
     * `@orrery/contracts` and to `plans/09` §7.2's `strikes >= thresholds.X`, and neither is this file's to make.
     */
    fc.assert(
      fc.property(
        fc.record({
          fullscreenExit: fc.nat({ max: 30 }),
          focusLoss: fc.nat({ max: 30 }),
          tabHide: fc.nat({ max: 30 }),
          pointerLockLoss: fc.nat({ max: 30 }),
          copyAttempt: fc.nat({ max: 30 }),
        }),
        (counts) => {
          expect(classifyBreaches({ counts, thresholds: thresholdsOf(0), ladder: LADDER })).toEqual(
            classifyBreaches({ counts, thresholds: thresholdsOf(1), ladder: LADDER }),
          );
        },
      ),
      { numRuns: RUNS },
    );
  });
});

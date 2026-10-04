/**
 * What a rung DOES, and what a teacher can do about it.  (P8-T11)
 *
 * The ladder decides which rung; these are the platform consequences, and they are the part `V-12` is actually about.
 * A rung the code reaches is not the same thing as an attempt a student can still recover from, so both halves are
 * asserted -- the rung AND the reversibility, because either alone is satisfiable by wrong code.
 */

import { describe, expect, it } from 'vitest';

import {
  applyRung,
  countStrike,
  effectOf,
  evaluateEscalation,
  LADDER,
  type Rung,
  reinstate,
  survivesShedding,
  type ViolationCounts,
} from './escalation.js';

const reached = (kinds: number): ViolationCounts =>
  Object.fromEntries(
    (['fullscreenExit', 'tabHide', 'focusLoss', 'copyAttempt'] as const).map((kind, index) => [
      kind,
      index < kinds ? 3 : 0,
    ]),
  ) as ViolationCounts;

const allThree = {
  fullscreenExits: 3,
  tabHides: 3,
  focusLosses: 3,
  copyAttempts: 3,
  pointerLockLosses: null,
};

describe('V-12: THERE IS NO TERMINATE, AND THE LADDER SAYS SO', () => {
  it('has no `TERMINATE` rung in the type or the table', () => {
    // `V-12` is not a style preference: the original TERMINATE set the attempt to TERMINATED, submitted "held
    // answers", and so irreversibly discarded every unwritten item.
    expect([...LADDER]).toEqual([
      'WARN',
      'BLOCK_UNTIL_RELOCK',
      'REQUIRE_RELOCK',
      'FREEZE_AND_SUBMIT',
    ]);
    expect(LADDER).not.toContain('TERMINATE' as Rung);
  });

  it('has NO RUNG that ends an attempt, so there is no code path to irreversible', () => {
    // Every rung's effect is either NONE or FROZEN, and both are reversible. Asserting the VALUE rather than the
    // absence of a string is what makes this a real constraint: adding a terminal rung later fails this test.
    for (const rung of [...LADDER, 'NONE'] as const) {
      const effect = effectOf(rung);
      expect(['NONE', 'FROZEN'], rung).toContain(effect.attemptEffect);
      expect(effect.reversible, rung).toBe(true);
    }
  });

  it('submits ONLY what was written, and never anything else', () => {
    // The original submitted "held answers" -- which is where the grade reduction came from.
    for (const rung of [...LADDER, 'NONE'] as const) {
      const effect = effectOf(rung);
      if (effect.submitsWrittenAnswers) {
        expect(effect.rung, rung).toBe('FREEZE_AND_SUBMIT');
      }
    }
  });
});

describe('the freeze is the reversible one, and it says what happened to the ANSWERS', () => {
  const freeze = effectOf('FREEZE_AND_SUBMIT');

  it('tells the student their written work was NOT discarded', () => {
    /**
     * `V-12`'s whole correction was that the previous version silently discarded unwritten answers. A student who has
     * just been told "this attempt has been stopped" is owed the answer to "did I lose my work" immediately -- so the
     * reassurance belongs in the message, not in a policy document they will never read.
     */
    expect(freeze.studentMessage).toContain('Nothing you have written has been discarded');
    expect(freeze.studentMessage).toContain('teacher will review');
  });

  it('freezes rather than terminating, and marks the transition reversible', () => {
    expect(freeze.attemptEffect).toBe('FROZEN');
    expect(applyRung(freeze, 'IN_PROGRESS')).toEqual({
      kind: 'FROZEN',
      to: 'FROZEN',
      submitsWrittenAnswers: true,
      reversible: true,
    });
  });

  it('leaves the attempt untouched below the freeze rung', () => {
    for (const rung of ['NONE', 'WARN', 'BLOCK_UNTIL_RELOCK', 'REQUIRE_RELOCK'] as const) {
      expect(applyRung(effectOf(rung), 'IN_PROGRESS'), rung).toEqual({
        kind: 'UNCHANGED',
        to: 'IN_PROGRESS',
      });
    }
  });

  it('gives every REACHED rung a message the student can act on', () => {
    // A rung the student cannot act on teaches them the messages are noise, and then the freeze message is noise too.
    for (const depth of [1, 2, 3, 4]) {
      const verdict = evaluateEscalation({
        counts: reached(depth),
        thresholds: allThree,
        ladder: LADDER,
      });
      expect(effectOf(verdict.rung).studentMessage.length, verdict.rung).toBeGreaterThan(0);
    }
  });

  it('says NOTHING at `NONE`, because silence is the honest state', () => {
    expect(effectOf('NONE').studentMessage).toBe('');
  });
});

describe('reinstatement is what makes a freeze SAFE, so it is stricter than it looks', () => {
  it('reinstates a frozen attempt with a reason and an author', () => {
    const result = reinstate(
      true,
      'the fullscreen exits were a browser bug on this model',
      'teacher-1',
    );
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.transition).toMatchObject({ decision: 'REINSTATE', authorId: 'teacher-1' });
  });

  it('refuses a reversal with no author, because only a human disposes', () => {
    expect(reinstate(true, 'a perfectly good long reason here', '   ').ok).toBe(false);
  });

  it('refuses a short reason', () => {
    // A reversal with no record is indistinguishable from a freeze that never happened -- and an unrecorded
    // reinstatement is indistinguishable from collusion, which is the accusation this whole screen avoids making.
    expect(reinstate(true, 'oops', 'teacher-1').ok).toBe(false);
  });

  it('refuses to reinstate an attempt that is NOT frozen', () => {
    expect(reinstate(false, 'a perfectly good long reason here', 'teacher-1').ok).toBe(false);
  });

  it('trims the reason, so a record is not stored padded', () => {
    const result = reinstate(
      true,
      `   ${'the exits were a browser bug '.repeat(2)}   `,
      'teacher-1',
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.transition.decision === 'REINSTATE') {
      expect(result.transition.reason).not.toMatch(/^\s|\s$/);
    }
  });
});

describe('B11: strikes are counted PER KIND, and never mutated in place', () => {
  it('counts into the named kind only', () => {
    expect(countStrike({ tabHide: 2 }, 'tabHide')).toEqual({ tabHide: 3 });
  });

  it('does NOT let a fullscreen count trip the tab-hide threshold', () => {
    // `plans/09` §7.1: with one counter, "a student who left fullscreen 12 times would trip the `tabHides: 3`
    // threshold". One counter does not under-count -- it MIS-ATTRIBUTES, and a student is escalated for something they
    // did not do.
    const strikes = { fullscreenExit: 12 };
    const verdict = evaluateEscalation({
      counts: strikes,
      thresholds: { ...allThree, fullscreenExits: null, tabHides: 3 },
      ladder: LADDER,
    });
    expect(verdict.rung).toBe('NONE');
    expect(verdict.reasons).toEqual([]);
  });

  it('does not mutate the counts it was given', () => {
    // A counter writable from both the evidence writer and the ladder is a counter whose total cannot be trusted.
    const before: ViolationCounts = { tabHide: 2 };
    countStrike(before, 'tabHide');
    expect(before.tabHide).toBe(2);
  });
});

describe('U-2: a threshold crossing survives telemetry shedding', () => {
  it('keeps the crossing and may drop the events underneath it', () => {
    // The escalation was COMPUTED from the crossing, so a lost crossing with surviving events leaves a teacher
    // looking at a counter that rose with nothing to explain it.
    expect(survivesShedding('VIOLATION_THRESHOLD_REACHED')).toBe(true);
    expect(survivesShedding('TAB_HIDDEN')).toBe(false);
  });
});

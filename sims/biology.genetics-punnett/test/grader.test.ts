/**
 * The model and the grader, in bare Node.  (P12-T2, card 14 `biology.genetics-punnett`)
 *
 * ## WHAT THESE ASSERT, AND WHY IT IS NOT "THE ANSWER IS 1:2:1"
 *
 * The cross `Aa × Aa` is the one every genetics course uses, so a test that types `1:2:1` proves only that
 * the author can spell a ratio. The cases below are the ones a lookup table gets wrong: a cross where the
 * answer is not `1:2:1`, a cross where a genotype count is ZERO, and a recessive answer that must not be
 * accepted as the dominant one.
 */

import { gradeStoredState } from '@orrery/sim-sdk/grader';
import { describe, expect, it } from 'vitest';
import sim, { MAX_POINTS, OFFSPRING_MARKS } from '../src/grader.js';
import {
  canonicalRatio,
  cells,
  clamp,
  describeCross,
  offspring,
  type PunnettParams,
  ratio,
  trimEntries,
} from '../src/model.js';

const CROSS: PunnettParams = { parentA: 'Aa', parentB: 'Aa' };

/** `grade(state, params, answer)` -- three positional arguments, in that order (`define.ts:269`). */
const grade = (answer: unknown, params: PunnettParams = CROSS, state: unknown = { probe: true }) =>
  sim.grader.grade(state, params, answer);

const answer = (list: string, ratioText: string) => ({ offspring: list, ratio: ratioText });

describe('the model', () => {
  it('enumerates four cells for a monohybrid cross and one for a homozygous pair', () => {
    expect(cells(CROSS).flat()).toEqual(['AA', 'Aa', 'Aa', 'aa']);
    expect(cells({ parentA: 'AA', parentB: 'aa' }).flat()).toEqual(['Aa']);
    expect(offspring(CROSS)).toEqual(['AA', 'Aa', 'Aa', 'aa']);
  });

  it('counts the ratio off the cells rather than looking it up', () => {
    expect(ratio(CROSS)).toBe('1:2:1');
    // A homozygous parent has ONE gamete, so the square is 1x2 and the counts are 1:1:0 -- which is the
    // claim a lookup table cannot make, because `1:1` is what the textbook prints.
    expect(ratio({ parentA: 'AA', parentB: 'Aa' })).toBe('1:1:0');
    // AND THE ZERO IS SHOWN, because dropping it turns `0:1:1` into the different claim `1:1`.
    expect(ratio({ parentA: 'Aa', parentB: 'aa' })).toBe('0:1:1');
    expect(ratio({ parentA: 'aa', parentB: 'aa' })).toBe('0:0:1');
  });

  it('treats `aA` and `Aa` as the same genotype, because that is handwriting and not the question', () => {
    expect(cells({ parentA: 'aA', parentB: 'aa' }).flat()).toEqual(['aa', 'Aa']);
  });

  it('is PURE: the same parameters give the same cells however often they are asked for', () => {
    expect(cells(CROSS)).toEqual(cells(CROSS));
    expect(ratio(CROSS)).toBe(ratio(CROSS));
  });

  it('describes the cross it is actually describing', () => {
    expect(describeCross(CROSS)).toContain('1:2:1');
    expect(describeCross({ parentA: 'Aa', parentB: 'aa' })).toContain('0:1:1');
  });
});

describe('normalisation', () => {
  it('strips the keyboard and keeps the biology', () => {
    // The space is the keyboard's; the case is the question's. `setMatch` with `caseSensitive: true` drops
    // BOTH because it swaps `canonicalText` for the identity (`grading.ts:370`), so the simulation puts the
    // whitespace back by hand.
    expect(trimEntries('AA, Aa, aa, Aa')).toEqual(['AA', 'Aa', 'aa', 'Aa']);
    expect(trimEntries('AA,Aa,aa,Aa')).toEqual(['AA', 'Aa', 'aa', 'Aa']);
    expect(trimEntries('AA,Aa,aa,Aa'.toLowerCase())).toEqual(['aa', 'aa', 'aa', 'aa']);
    expect(canonicalRatio('1 : 2 : 1')).toBe('1:2:1');
  });
});

describe('the grader', () => {
  it('awards full marks for the cross the cells give', () => {
    const graded = grade(answer('AA,Aa,aa,Aa', '1:2:1'));
    expect(graded.points).toBe(MAX_POINTS);
    expect(graded.code).toBe('CORRECT');
  });

  it('accepts the spaced ratio a student actually types', () => {
    // An `EXACT` string comparison here would mark this wrong for a keyboard habit. This is the false wrong
    // answer the card's tolerance policy exists to prevent, in a text answer rather than in a float.
    expect(grade(answer('AA, Aa, aa, Aa', '1 : 2 : 1')).points).toBe(MAX_POINTS);
  });

  it('does NOT fold case: `aa` is not `AA`', () => {
    // The false RIGHT answer. `grading.ts:260-263` records that folding case marked a recessive genotype
    // correct, and `caseSensitive: true` is the only thing standing between this grader and that defect.
    const recessive = grade(answer('aa,aa,aa,aa', '0:0:4'));
    expect(recessive.points).toBeLessThan(MAX_POINTS);
    expect(recessive.points).toBeLessThanOrEqual(OFFSPRING_MARKS);
  });

  it('awards nothing for a blank answer, which is not a numeric comparison', () => {
    expect(grade(null).points).toBe(0);
    expect(grade(null).code).toBe('UNPARSEABLE');
    expect(grade({ ratio: '1:2:1' }).code).toBe('UNPARSEABLE');
  });

  it('is DETERMINISTIC: three runs, identical output', () => {
    const runs = [0, 1, 2].map(() => JSON.stringify(grade(answer('AA,Aa,aa,Aa', '1:2:1'))));
    expect(runs[1]).toBe(runs[0]);
    expect(runs[2]).toBe(runs[0]);
  });

  it('tolerates a state it does not recognise, because the determinism probe sends one', () => {
    // `runDeterminism` (`sim-validate.mjs:306-323`) grades `{ probe: true }`. A grader that destructured
    // `state.parentA` would throw there and be reported as GRADER_FAILED rather than as a non-answer.
    expect(() => grade(answer('AA,Aa,aa,Aa', '1:2:1'), CROSS, { probe: true })).not.toThrow();
  });

  it('REPLAYS: re-grading the stored state reproduces the stored mark', () => {
    const state = { parentA: 'Aa', parentB: 'aa' };
    const submitted = answer('Aa,aa', '0:1:1');
    const once = sim.grader.grade(state, state, submitted);
    const twice = gradeStoredState(sim.grader, { state, params: state, answer: submitted });
    expect(twice.points).toBe(once.points);
    expect(twice.code).toBe(once.code);
  });

  it('`gradeStoredState` is what REFUSES a bad state, not `grade`', () => {
    const validator = sim.grader.validateState;
    if (validator === undefined) throw new Error('this simulation declares no validateState');
    expect(validator({ parentA: 'Aa', parentB: 'Aa' })).toBeNull();
    expect(validator({ parentA: 'Aa' })).toMatch(/parentB/u);
    expect(validator({ parentA: 1, parentB: 'Aa' })).toMatch(/parentA/u);
    expect(validator('not an object')).toMatch(/not an object/u);
    expect(() =>
      gradeStoredState(sim.grader, {
        state: { parentA: 1 },
        params: CROSS,
        answer: answer('AA', '1:0:0'),
      }),
    ).toThrow(/STATE_INVALID/u);
  });

  it('grades the RESOLVED VARIANT, not whatever the browser last drew', () => {
    // The parameters are the question. A state claiming a different cross must not change the mark.
    const lie = { parentA: 'AA', parentB: 'aa' };
    expect(grade(answer('AA,Aa,aa,Aa', '1:2:1'), CROSS, lie).points).toBe(MAX_POINTS);
  });

  it('clamps a parent the host invented, so a nonsense genotype cannot make the item ungradable', () => {
    expect(clamp({ parentA: 'Qq', parentB: 'Aa' }).parentA).toBe('Aa');
    expect(grade(answer('AA,Aa,aa,Aa', '1:2:1'), { parentA: 'Qq', parentB: 'Aa' }).points).toBe(
      MAX_POINTS,
    );
  });
});

/**
 * THE REGRESSION TESTS FOR A FALSE-POSITIVE MARK.
 *
 * Every one of these describes an answer that scored **full marks while being wrong**, found by planting rather than by
 * reading the code. They live here rather than in the SDK because the bug was not in the SDK's arithmetic -- `setMatch`
 * did exactly what it says -- it was in choosing a SET primitive for a question whose answer is a COUNT.
 */
describe('THE COUNT IS THE ANSWER, AND A SET LOSES IT', () => {
  it('does NOT award full marks for omitting a heterozygote from a cross that yields two', () => {
    // THE PLANT. `Aa x Aa` gives `AA, Aa, Aa, aa`. Under `setMatch` the three-entry answer collapsed to the same
    // three-element set as the correct four-entry answer and scored CORRECT 4/4 -- **a student told they were right
    // when their Punnett square was wrong.** Omitting the second heterozygote is the whole exercise.
    const threeEntries = grade(answer('AA,Aa,aa', '1:2:1'), CROSS);
    expect(threeEntries.points).toBeLessThan(MAX_POINTS);
    expect(threeEntries.code).not.toBe('CORRECT');
  });

  it('still awards full marks for the correct four cells in ANY order', () => {
    // The set primitive was not wrong for order -- only for count. Reordering must not lose a mark.
    expect(grade(answer('aa,Aa,AA,Aa', '1:2:1'), CROSS).points).toBe(MAX_POINTS);
  });

  it('does NOT let a repeated answer inflate the score', () => {
    // Multiset Jaccard adds to the denominator and never to the numerator, so repeating an entry is self-defeating.
    const padded = grade(answer('AA,Aa,Aa,aa,aa,aa', '1:2:1'), CROSS);
    expect(padded.points).toBeLessThanOrEqual(MAX_POINTS);
    const correct = grade(answer('AA,Aa,Aa,aa', '1:2:1'), CROSS);
    expect(padded.points).toBeLessThan(correct.points);
  });

  it('CREDITS the two heterozygotes separately, which is the distinction being tested', () => {
    // One of two correct → some credit. Under the set primitive this was all-or-nothing, because there was no way to
    // say "one of the two".
    const oneHeterozygote = grade(answer('AA,Aa,aa,AA', '1:2:1'), CROSS);
    expect(oneHeterozygote.points).toBeGreaterThan(0);
    expect(oneHeterozygote.points).toBeLessThan(MAX_POINTS);
  });

  it('is still case-SENSITIVE, so `aa` is never the recessive stand-in for `Aa`', () => {
    // The other false-positive this grader exists to prevent, and the reason for `caseSensitive: true`.
    expect(grade(answer('AA,Aa,aa,AA', '1:2:1'), CROSS).code).not.toBe('CORRECT');
  });
});

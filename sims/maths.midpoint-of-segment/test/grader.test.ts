/**
 * The grader, in bare Node.  (P6-T11, gold sim 17)
 *
 * This is the first gold sim whose answer is an ORDERED PAIR, and the first that asks for a negative
 * number. So the cases that matter are: the right numbers in the wrong order, one coordinate right, a
 * blank box, and the wrong SIGN on a coordinate that is otherwise right.
 */
import { describe, expect, it } from 'vitest';
import sim, { checkComponents, parseAnswer } from '../src/grader.js';
import { describeSegment, liesBetween, midpoint, type Segment } from '../src/model.js';

const PARAMS: Segment = { x1: -4, y1: 7, x2: 2, y2: -1 };

const grade = (answer: unknown, params: Segment = PARAMS) => sim.grader.grade(null, params, answer);

describe('maths.midpoint-of-segment grading', () => {
  it('awards full marks for both coordinates', () => {
    // (-4 + 2) / 2 = -1, and (7 + -1) / 2 = 3.
    expect(grade([-1, 3]).points).toBe(4);
    expect(grade([-1, 3]).code).toBe('CORRECT');
  });

  it('THE ORDER IS PART OF THE ANSWER, and swapping it is not a rounding error', () => {
    // `(3, -1)` is two numbers, not a midpoint. A `{set: [...]}` expectation would pass this, and the
    // whole reason this simulation exists is that it must not.
    const swapped = grade([3, -1]);
    expect(swapped.points).toBe(0);
    expect(midpoint(PARAMS)).toEqual({ x: -1, y: 3 });
  });

  it('awards HALF for one correct coordinate, because the work shown is real work', () => {
    const result = grade([-1, 9]);
    expect(result.points).toBe(2);
    expect(result.code).toBe('PARTIAL');
    // The feedback NAMES the wrong one. "Wrong" gives a student nothing to act on.
    expect(result.feedback).toMatch(/y-coordinate is 9/u);
    expect(result.feedback).toMatch(/x-coordinate is correct/u);
  });

  it('CATCHES THE DROPPED MINUS SIGN, which is the actual difficulty', () => {
    // Averaging the magnitudes of the x-coordinates gives 3. Everything else about the answer is right.
    const result = grade([3, 3]);
    expect(result.points).toBe(2);
    expect(result.feedback).toMatch(/x-coordinate is 3, and it should be -1/u);
  });

  it('CREDITS THE HALF THAT WAS DONE, and never scores a blank box as 0', () => {
    // `Number('')` is 0, and 0 is a plausible midpoint coordinate. A parser built on `Number` alone turns
    // `[-1, null]` into `(-1, 0)` -- which on a segment whose midpoint really does contain a 0 awards the
    // whole 4 for a coordinate nobody typed. So a blank box stays missing, and the half the student DID
    // compute is still credited: real arithmetic should not be thrown away because a box is empty.
    const half = grade([-1, null]);
    expect(half.points).toBe(2);
    expect(half.code).toBe('PARTIAL');
    expect(half.feedback).toMatch(/x-coordinate is correct/u);
    expect(half.feedback).toMatch(/y-coordinate is empty/u);
  });

  it('scores nothing for a blank half whose companion is ALSO wrong', () => {
    // There is no work here to credit: the one number given is not right and the other was never attempted.
    const half = grade([9, null]);
    expect(half.points).toBe(0);
    expect(half.code).toBe('MIDPOINT_INCOMPLETE');
  });

  it('A BLANK BOX AND A BOX HOLDING A WORD ARE DIFFERENT MISTAKES', () => {
    // "You left a coordinate empty" is advice that does not exist in the situation of a student who typed
    // "banana", so the two must not collapse into one message even though both score zero.
    expect(grade([-1, null]).code).toBe('PARTIAL');
    expect(grade([-1, 'banana']).code).toBe('UNPARSEABLE');
  });

  it('rejects a SINGLE number, because half an answer is not half of one box', () => {
    expect(grade([-1]).points).toBe(0);
    expect(grade([-1]).code).toBe('MIDPOINT_INCOMPLETE');
  });

  it('rejects an unparseable answer instead of coercing it', () => {
    expect(grade(['left', 'three']).code).toBe('UNPARSEABLE');
    expect(grade(['banana', 'banana']).points).toBe(0);
    expect(grade(7).points).toBe(0);
    expect(grade(null).points).toBe(0);
  });

  it('rejects a bare number, because half an answer is not one box', () => {
    // `-1` alone does not say which coordinate it was meant to be, and guessing would mark a student
    // right for a guess.
    expect(grade(-1).code).toBe('UNPARSEABLE');
  });

  it('reads the answer as an object pair as well as a list', () => {
    expect(grade({ x: -1, y: 3 }).points).toBe(4);
    expect(grade({ x: -1, y: 9 }).points).toBe(2);
  });

  it('ignores EXTRA numbers rather than rewarding them', () => {
    // A spread of values and a lucky landing is not more right than a single value.
    expect(grade([-1, 3, 17, 99]).points).toBe(4);
  });

  it('tolerates a coordinate given to two decimal places', () => {
    expect(grade([-1.004, 3.0]).points).toBe(4);
  });

  it('checks the two coordinates SEPARATELY', () => {
    expect(checkComponents([-1, 3], { x: -1, y: 3 })).toEqual({ x: true, y: true });
    expect(checkComponents([3, 3], { x: -1, y: 3 })).toEqual({ x: false, y: true });
    expect(checkComponents([-1, -3], { x: -1, y: 3 })).toEqual({ x: true, y: false });
  });

  it('distinguishes a blank pair from a missing one', () => {
    // An empty SUBMISSION is not half an answer, so it must not read as two unattempted boxes.
    expect(parseAnswer([]).kind).toBe('INVALID');
    // A blank component is `undefined`, never `NaN` and never `0`. `NaN` would be honest about "not a
    // number" but would also compare false against every expectation including a NaN one, and `0` is the
    // bug: it would let a box nobody filled in pass as an answer of zero.
    expect(parseAnswer([-1, null])).toEqual({
      kind: 'PARTIAL_MISSING',
      given: [-1, undefined],
    });
    expect(parseAnswer([-1, 'banana']).kind).toBe('INVALID');
  });

  it('THE MIDPOINT LIES BETWEEN THE ENDPOINTS, whatever the signs', () => {
    // The property is the checkable fact, not three example answers.
    const cases: Segment[] = [
      PARAMS,
      { x1: -8, y1: 6, x2: -2, y2: -10 },
      { x1: 5, y1: 5, x2: 5, y2: -5 },
      { x1: -20, y1: -20, x2: 20, y2: 20 },
    ];
    for (const segment of cases) {
      expect(liesBetween(segment, midpoint(segment))).toBe(true);
    }
    // And averaging the MAGNITUDUES leaves the segment, which is the mistake this simulation is about.
    const magnitudes = {
      x: (Math.abs(PARAMS.x1) + Math.abs(PARAMS.x2)) / 2,
      y: (Math.abs(PARAMS.y1) + Math.abs(PARAMS.y2)) / 2,
    };
    expect(liesBetween(PARAMS, magnitudes)).toBe(false);
    // AND IT EARNS NOTHING, which is worth stating: averaging magnitudes gives (3, 4), and BOTH of those
    // are wrong -- the y was wrong too, because the segment spans zero in y and the magnitudes average to
    // 4 rather than 3. So this is not "half the marks for a sign error"; it is a wrong answer, and the
    // diagram exists to let the student see that before submitting it.
    expect(magnitudes).toEqual({ x: 3, y: 4 });
    const carelessGrade = grade([magnitudes.x, magnitudes.y]);
    expect(carelessGrade.points).toBe(0);
    expect(carelessGrade.code).toBe('WRONG');

    // A dropped minus sign ALONE does earn half, which is the case the test above about the sign covers.
    expect(grade([3, 3]).points).toBe(2);
  });

  it('NEVER PUTS THE MIDPOINT IN THE TEXT ALTERNATIVE', () => {
    const text = describeSegment(PARAMS);
    // The ENDPOINTS are the question and belong in the alternative. The midpoint is the answer: the
    // alternative may say what is drawn, never what it works out to.
    expect(text).toContain('(-4, 7)');
    expect(text).not.toMatch(/midpoint is \(/u);
    expect(text).not.toMatch(/\(-1, 3\)/u);
  });
});

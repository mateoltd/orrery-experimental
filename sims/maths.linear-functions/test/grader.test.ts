/**
 * The grader, in bare Node.  (P6-T11, gold sim 2)
 *
 * The cases that matter are the awkward ones, not the happy path: a flat line has no intercept, and
 * "there is no answer" is an answer a student can be right about.
 */
import { describe, expect, it } from 'vitest';
import sim, { type LineAnswer } from '../src/grader.js';
import type { LineParams } from '../src/model.js';

// `defineSim` returns `{ grader, browser }`, so the grading half is on `.grader`. Importing the default and
// calling `grade` on it directly fails with "default.grade is not a function", which is the shape every
// simulator author will hit first.

// The parameters the SIM was given, not a tolerance: `grade(state, params, answer)` has no tolerance
// argument, because the tolerance belongs to the simulation rather than to the caller. See the note on
// `TOLERANCE` in the grader.
const params = (over: Partial<LineParams> = {}): LineParams => ({
  m: 2,
  c: -4,
  span: 5,
  ...over,
});

const grade = (answer: unknown, over: Record<string, unknown> = {}) =>
  sim.grader.grade(null, params(over), answer);

describe('maths.linear-functions grading', () => {
  it('awards full marks for the x-intercept', () => {
    // y = 2x - 4 crosses at x = 2.
    expect(grade({ xIntercept: 2 }).points).toBe(4);
  });

  it('awards partial credit that shrinks with the error', () => {
    const near = grade({ xIntercept: 2.2 }).points;
    const far = grade({ xIntercept: 9 }).points;
    expect(near).toBeGreaterThan(0);
    expect(near).toBeLessThan(4);
    expect(far).toBeLessThan(near);
    // ...but a guess that cannot be right is still worth nothing, however wide the band.
    expect(grade({ xIntercept: 9000 }).points).toBe(0);
  });

  it('GRADES "there is no crossing" AS AN ANSWER, because a flat line has none', () => {
    // A student who correctly says "it never crosses" should not be marked wrong for declining to type
    // a number into a box that has no number in it.
    expect(grade({ xIntercept: null }, { m: 0, c: 3 }).points).toBe(4);
  });

  it('marks a number wrong when the line is flat', () => {
    expect(grade({ xIntercept: 0 }, { m: 0, c: 3 }).points).toBe(0);
  });

  it('marks an empty answer wrong when the line DOES cross', () => {
    expect(grade({ xIntercept: null }).points).toBe(0);
  });

  it('rejects an unparseable answer instead of coercing it', () => {
    // "about 3" is not 3, and grading it as 3 teaches a student the field ignores them.
    expect(grade({ xIntercept: 'about 3' }).points).toBe(0);
    expect(grade(null).points).toBe(0);
    expect(grade(7).points).toBe(0);
  });

  it('is symmetric in its tolerance, so 1.999 and 2.001 are treated alike', () => {
    expect(grade({ xIntercept: 1.999 }).points).toBe(4);
    expect(grade({ xIntercept: 2.001 }).points).toBe(4);
  });

  it('accepts a well-formed answer shape', () => {
    const answer: LineAnswer = { xIntercept: -0.5 };
    expect(grade(answer, { m: 2, c: 1 }).points).toBe(4);
  });
});

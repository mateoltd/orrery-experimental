/**
 * The grader, in bare Node.  (P6-T11, gold sim 7)
 *
 * This is the first gold sim with MORE THAN ONE GRADED QUANTITY, so the cases that matter are the ones
 * about partial credit: one root found, both roots found in the wrong order, and a quadratic with no real
 * roots at all.
 */
import { describe, expect, it } from 'vitest';
import sim, { countMatched } from '../src/grader.js';
import { describeQuadratic, discriminant, roots } from '../src/model.js';

const grade = (answer: unknown, params: Record<string, unknown> = { a: 1, b: -4, c: 3 }) =>
  sim.grader.grade(null, params, answer);

describe('maths.quadratic-roots grading', () => {
  it('awards full marks for both roots', () => {
    expect(grade({ roots: [1, 3] }).points).toBe(4);
  });

  it('DOES NOT CARE WHAT ORDER THE ROOTS ARE IN', () => {
    // `-1` and `3` are the roots in either order, and marking the second one wrong would be pedantry
    // dressed as rigour.
    expect(grade({ roots: [3, 1] }).points).toBe(4);
  });

  it('awards HALF for one correct root, because the work shown is real work', () => {
    const result = grade({ roots: [1] });
    expect(result.points).toBe(2);
    expect(result.feedback).toMatch(/1 of 2/u);
  });

  it('awards full marks for a REPEATED root, entered once', () => {
    // x² - 4x + 4 is (x - 2)². The first version compared a one-element answer against a two-element
    // expectation and marked a perfect answer half right.
    const result = grade({ roots: [2] }, { a: 1, b: -4, c: 4 });
    expect(result.points).toBe(4);
    expect(result.feedback).toMatch(/Correct/u);
  });

  it('GRADES "no real roots" AS THE ONLY CORRECT ANSWER', () => {
    const result = grade(null, { a: 1, b: 0, c: 4 });
    expect(discriminant({ a: 1, b: 0, c: 4 })).toBeLessThan(0);
    expect(result.points).toBe(4);
    expect(result.feedback).toMatch(/no real roots/u);
  });

  it('marks a number wrong when there are no real roots to give', () => {
    const result = grade({ roots: [1, 3] }, { a: 1, b: 0, c: 4 });
    expect(result.points).toBe(0);
    expect(result.feedback).toMatch(/leave both boxes empty/u);
  });

  it('marks a wrong root wrong, and does not award partial credit for it', () => {
    expect(grade({ roots: [1, 7] }).points).toBe(2);
    expect(grade({ roots: [7, 8] }).points).toBe(0);
    expect(grade({ roots: [7] }).feedback).toMatch(/is not a root/u);
  });

  it('rejects an unparseable answer instead of coercing it', () => {
    expect(grade({ roots: 'two' }).points).toBe(0);
    expect(grade({ roots: ['big'] }).points).toBe(0);
    expect(grade(7).points).toBe(0);
  });

  it('matches each given root against the nearest UNUSED expected root', () => {
    // One expected root cannot be "found" twice, which a naive per-value comparison would allow.
    expect(countMatched([1, 1], [1])).toBe(1);
    expect(countMatched([1, 3], [1, 3])).toBe(2);
    expect(countMatched([3, 1], [1, 3])).toBe(2);
    expect(countMatched([2], [1, 3])).toBe(0);
  });

  it('NEVER PUTS THE ROOTS IN THE TEXT ALTERNATIVE', () => {
    const params = { a: 1, b: -4, c: 3 };
    const text = describeQuadratic(params);
    // The equation itself is the QUESTION and belongs in the alternative, so a naive "does the string
    // contain the value 3" check fails on the constant term. What must not appear is a statement OF THE
    // ANSWER -- the alternative may say how MANY crossings there are, never where they are.
    expect(text).toContain('y = 1x²');
    expect(text).not.toMatch(/roots? (are|is|:)/u);
    expect(text).toContain('twice');
    // And the shape claim is real: this one genuinely has two distinct roots.
    expect(roots(params)).toHaveLength(2);
  });
});

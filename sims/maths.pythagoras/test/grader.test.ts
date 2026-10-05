/**
 * The grader, in bare Node.  (P6-T11, gold sim 5)
 *
 * SET grading, which is the point of this sim: "which side is the longest?" has three answers, and in an
 * isosceles right triangle TWO of them are correct. A grader that compared one string would mark a student
 * who answered either of them wrong, and would have no way to notice.
 */
import { describe, expect, it } from 'vitest';
import sim from '../src/grader.js';
import type { TriangleParams } from '../src/model.js';

const grade = (answer: unknown, params: TriangleParams = { a: 3, b: 4, c: 5, giveLengths: true }) =>
  sim.grader.grade(null, params, answer);

describe('maths.pythagoras grading', () => {
  it('awards full marks for naming the longest side by letter', () => {
    expect(grade('c').points).toBe(4);
  });

  it('accepts every NAME for the same side, because refusing them is pedantry', () => {
    for (const name of ['c', 'C', 'hypotenuse', 'hyp', ' hyp ']) {
      expect(grade(name).points, name).toBe(4);
    }
  });

  it('AWARDS FULL MARKS FOR EITHER OF TWO EQUAL LONGEST SIDES — the set case', () => {
    // `a` and `b` are both 6 and `c` is 5, so there are TWO longest sides and either answer is complete.
    //
    // The first version of this test used 5, 5, 7.07 — an isosceles RIGHT triangle, where the hypotenuse
    // is longest on its own and the "tie" does not exist. The test passed for the wrong reason on the
    // cases that did not check the tie, and failed on the one that did.
    const params = { a: 6, b: 6, c: 5, giveLengths: true };
    expect(grade('a', params).points).toBe(4);
    expect(grade('b', params).points).toBe(4);
    expect(grade(['a', 'b'], params).points).toBe(4);
    expect(grade('c', params).points).toBe(0);
  });

  it('takes a LIST of answers, comma or space separated', () => {
    // Order must not matter, and it must not matter through a wrapper object either — the sim sends
    // `{name}` when the student typed more than one thing.
    expect(grade(['a', 'b'], { a: 6, b: 6, c: 5, giveLengths: true }).points).toBe(4);
    expect(grade(['b', 'a'], { a: 6, b: 6, c: 5, giveLengths: true }).points).toBe(4);
    expect(grade({ name: ['a', 'b'] }, { a: 6, b: 6, c: 5, giveLengths: true }).points).toBe(4);
  });

  it('marks naming a NON-longest side wrong, and says why', () => {
    const result = grade('a');
    expect(result.points).toBe(0);
    expect(result.feedback).toMatch(/not the longest side/u);
  });

  it('marks naming TOO MANY sides wrong, however right they are', () => {
    // "a, b and c" is not a better answer than "a"; it is not an answer.
    const result = grade(['a', 'b', 'c']);
    expect(result.points).toBe(0);
    expect(result.feedback).toMatch(/not an answer to "which is longest"/u);
  });

  it('refuses lengths that cannot form a triangle, before grading anything', () => {
    const result = grade('c', { a: 1, b: 1, c: 5, giveLengths: true });
    expect(result.points).toBe(0);
    expect(result.feedback).toMatch(/cannot be the sides of a triangle/u);
  });

  it('marks an empty answer zero rather than guessing', () => {
    expect(grade('').points).toBe(0);
    expect(grade(null).points).toBe(0);
    expect(grade({}).points).toBe(0);
  });
});

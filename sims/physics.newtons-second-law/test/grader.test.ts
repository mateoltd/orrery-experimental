/**
 * The grader, in bare Node.  (P6-T11, gold sim 4)
 *
 * The interesting cases are the ones a single-shape grader would get wrong: the answer's SHAPE follows
 * `solveFor`, and answering the right NUMBER for the wrong quantity is not a near miss.
 */
import { describe, expect, it } from 'vitest';
import sim from '../src/grader.js';
import type { NewtonParams } from '../src/model.js';

const grade = (
  answer: unknown,
  params: NewtonParams = { force: 12, mass: 3, accel: 4, solveFor: 'acceleration' },
) => sim.grader.grade(null, params, answer);

describe('physics.newtons-second-law grading', () => {
  it('awards full marks for the acceleration, F / m', () => {
    expect(grade({ quantity: 'acceleration', value: 4 }).points).toBe(4);
  });

  it('awards full marks for the FORCE, m × a, with acceleration as a given', () => {
    // 3 kg at 4 m/s² is 12 N. Using acceleration as the ANSWER here was the circular bug the declared
    // `expect.grade` caught: it returned the mass it had been handed.
    expect(
      grade({ quantity: 'force', value: 12 }, { mass: 3, accel: 4, force: 0, solveFor: 'force' })
        .points,
    ).toBe(4);
  });

  it('awards full marks for the MASS, F / a', () => {
    expect(
      grade({ quantity: 'mass', value: 6 }, { force: 24, accel: 4, mass: 9, solveFor: 'mass' })
        .points,
    ).toBe(4);
  });

  it('MARKS THE RIGHT NUMBER FOR THE WRONG QUANTITY AS ZERO', () => {
    // Asking for mass, answering the force. Generously grading this would look like kindness and would
    // teach a student that the label on the question does not matter.
    const result = grade(
      { quantity: 'force', value: 24 },
      { force: 24, accel: 4, mass: 9, solveFor: 'mass' },
    );
    expect(result.points).toBe(0);
    expect(result.feedback).toMatch(/asked for the mass/u);
  });

  it('grades "there is no answer" as an answer', () => {
    // A zero acceleration carries no force, and a mass of zero is not a mass.
    expect(
      grade({ quantity: 'mass', value: null }, { force: 0, accel: 4, mass: 9, solveFor: 'mass' })
        .points,
    ).toBe(4);
    expect(
      grade({ quantity: 'mass', value: 5 }, { force: 0, accel: 4, mass: 9, solveFor: 'mass' })
        .points,
    ).toBe(0);
  });

  it('rejects an empty answer rather than reading it as zero', () => {
    expect(grade({ quantity: 'acceleration', value: Number.NaN }).points).toBe(0);
    expect(grade({ quantity: 'acceleration', value: 'fast' }).points).toBe(0);
    expect(grade(null).points).toBe(0);
  });

  it('names the GIVENS in its feedback, so a wrong answer can be worked at', () => {
    const result = grade(
      { quantity: 'acceleration', value: 40 },
      { force: 12, mass: 3, accel: 4, solveFor: 'acceleration' },
    );
    expect(result.feedback).toMatch(/net force of 12 newtons/u);
    expect(result.feedback).toMatch(/mass of 3 kilograms/u);
  });
});

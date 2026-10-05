/**
 * The grader half. Node, no DOM, deterministic.  (P6-T11, gold sim 7)
 *
 * ## THE FIRST GOLD SIM WITH MORE THAN ONE GRADED QUANTITY
 *
 * Two roots, so partial credit has to work ACROSS PARTS — and that is the path `plans/20` needs in P7 for
 * every multi-part question. Built here rather than first discovered in P7, because a grading service that
 * only ever sees single-value answers is a grading service whose first multi-part question is a
 * production incident.
 *
 * ## A CORRECT ROOT EARNS HALF, AND WHICH HALF DOES NOT MATTER
 *
 * Finding `-1` for `(x+1)(x-3)` is half the answer, and half marks are the honest award: the work shown is
 * real work. But the two halves must be worth the same, which is why the matching is done against the
 * EXPECTED set rather than positionally — a student who writes `-1, 3` and one who writes `3, -1` have
 * both found both roots.
 */

import { defineSim, num, tolerance } from '@orrery/sim-sdk/grader';
import {
  describeQuadratic,
  discriminant,
  format,
  parseAnswer,
  type QuadraticParams,
  roots,
} from './model.js';

const TOLERANCE = { absolute: 0.01, relative: 0.005 } as const;

/**
 * How many of the expected roots the student found.
 *
 * A greedy match, and greedy is RIGHT here rather than merely convenient: every root is graded against
 * the nearest unmatched expected root, and because every root is worth the same, any maximal matching
 * gives the same total. A Hungarian assignment would be more machinery than the problem admits.
 */
export function countMatched(given: readonly number[], expected: readonly number[]): number {
  const remaining = [...expected];
  let matched = 0;
  for (const value of given) {
    let best = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < remaining.length; index += 1) {
      const distance = Math.abs((remaining[index] ?? 0) - value);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = index;
      }
    }
    const withinTolerance = tolerance(value, remaining[best] ?? Number.NaN, {
      abs: TOLERANCE.absolute,
      rel: TOLERANCE.relative,
      maxPoints: 1,
    });
    // The tolerance call asks a yes/no question about ONE root, so it is scaled to 1 and compared to 1.
    // The final award is proportional to the number of roots asked for -- see the note in `grade`.
    if (withinTolerance.points === 1) {
      remaining.splice(best, 1);
      matched += 1;
    }
  }
  return matched;
}

export default defineSim({
  meta: {
    id: 'maths.quadratic-roots',
    title: 'Roots of a quadratic',
    version: '1.0.0',
    subjects: ['maths'],
    licence: 'CC-BY-4.0',
    provenance: 'ORIGINAL',
    protocol: 1,
  },
  params: {
    a: num({ name: 'a', label: 'x² coefficient', unit: '', min: -5, max: 5, default: 1 }),
    b: num({ name: 'b', label: 'x coefficient', unit: '', min: -12, max: 12, default: -4 }),
    c: num({ name: 'c', label: 'constant', unit: '', min: -12, max: 12, default: 3 }),
  },
  controls: { params: true, state: true, scenarios: [] },
  accessibility: {
    keyboard: true,
    screenReaderSummary: 'A parabola drawn on axes, with two boxes for the roots.',
    reducedMotion: true,
    // NO ROOTS HERE. The alternative describes the curve and how many crossings there are; the roots are
    // the answer, and a printed worksheet that prints them has printed its own solution.
    textAlternative:
      'A parabola drawn on a pair of axes, and a statement of how many times it crosses the x-axis. The task is to work out where.',
    summary: 'Read the coefficients of a quadratic, look at its curve, and type the roots it has.',
  },
  // `grade(state, params, answer)` -- three positional arguments; `defineSim` checks the arity at load.
  grade(_state: unknown, params: QuadraticParams, answer: unknown) {
    const expected = roots(params);

    if (expected === null) {
      // No real roots is an ANSWER, and it is the only correct one.
      if (answer === null || answer === undefined) {
        return {
          points: 4,
          maxPoints: 4,
          code: 'CORRECT_NO_ROOTS',
          feedback: `Correct. ${describeQuadratic(params)}`,
        };
      }
      return {
        points: 0,
        maxPoints: 4,
        code: 'SHOULD_BE_NULL',
        feedback: `There are no real roots here, so leave both boxes empty. ${describeQuadratic(params)}`,
      };
    }

    const given = parseAnswer(answer);
    if (given === 'INVALID') {
      return {
        points: 0,
        maxPoints: 4,
        code: 'UNPARSEABLE',
        feedback: 'Enter one number per box, or leave both empty if there are no real roots.',
      };
    }
    if (given === null) {
      return {
        points: 0,
        maxPoints: 4,
        code: 'MISSING',
        feedback: `This one has real roots: ${expected.map((r) => format(r)).join(' and ')}.`,
      };
    }

    // A repeated root is worth its full marks ONCE. The first version compared against a two-element
    // expectation for a one-element answer and marked a perfect answer half right.
    const matched = countMatched(given, expected);
    /**
     * PROPORTIONAL TO WHAT WAS ASKED FOR, NOT A FIXED PRICE PER ROOT.
     *
     * A fixed price marked a REPEATED root half right: `x² - 4x + 4` is `(x - 2)²`, the student types
     * `2`, they are completely correct, and there is one root to find — so the single root is the whole
     * question and earns the whole 4.
     */
    const points = Math.round((matched / Math.max(expected.length, 1)) * 4);
    const wrongRoot = given.find(
      (value) =>
        !expected.some(
          (root) =>
            tolerance(value, root, {
              abs: TOLERANCE.absolute,
              rel: TOLERANCE.relative,
              maxPoints: 1,
            }).points === 1,
        ),
    );
    return {
      points,
      maxPoints: 4,
      code: points === 4 ? 'CORRECT' : points > 0 ? 'PARTIAL' : 'WRONG',
      feedback:
        points === 4
          ? `Correct: ${expected.map((r) => format(r)).join(' and ')}.`
          : wrongRoot === undefined
            ? `Partly right. You found ${String(matched)} of ${String(expected.length)}.`
            : `${format(wrongRoot)} is not a root of this quadratic. ${describeQuadratic(params)}`,
    };
  },
  validateState(state) {
    if (state === null || typeof state !== 'object') return 'the state is not an object';
    const a = (state as { a?: unknown }).a;
    return typeof a === 'number' && Number.isFinite(a) ? null : 'the state has no finite `a`';
  },
});

export { discriminant };

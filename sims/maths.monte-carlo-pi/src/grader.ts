/**
 * The grader half. Node, no DOM, deterministic.  (P6-T11, gold sim 21)
 *
 * ## THE BAND IS DERIVED FROM THE SAMPLE SIZE, NOT FROM THE MANIFEST
 *
 * The whole point of the exercise is that a sample estimate is accurate to about `1 / sqrt(n)`. So the
 * marking band has to be `1 / sqrt(n)` too, or the simulation teaches the opposite of its own lesson: four
 * times the points would be worth four times the marks, and a student who believes that has learned the wrong
 * thing about convergence.
 *
 * The manifest declares `tolerance: {absolute: 0.05}` for the CONFORMANCE answer, which is a single fixed
 * value for a known seed and a known count. A general answer is graded against the sample, so the two bands
 * differ on purpose, and `toleranceFor` is what a general answer uses.
 *
 * ## PI IS IN THE GRADER, AND THAT IS A DESIGN CHOICE, NOT A SPOILER
 *
 * The student is estimating pi, so the grader knows pi. That is not the same as showing the student pi: it
 * is the definition of an estimated quantity, and a grader that does not know the true value is grading the
 * method rather than the result.
 */

import { defineSim, num } from '@orrery/sim-sdk/grader';
import {
  clamp,
  countInside,
  describeTask,
  estimatePi,
  format,
  type MonteParams,
  PI,
  round,
  sample,
  toleranceFor,
} from './model.js';

const MAX = 4;

/**
 * MARKS AS A FUNCTION OF HOW MANY STANDARD ERRORS OUT THE ANSWER IS.
 *
 * Full marks inside one band, a half for the second band, nothing beyond. The step is a whole band rather
 * than a smooth decay because the quantity is already in units of its own uncertainty — "within 1.5 sigma" is
 * a sentence a teacher can use, and "3.1 out of 4" is not.
 */
export function marksForSigmas(sigmas: number): number {
  if (sigmas <= 1) return MAX;
  if (sigmas <= 2) return MAX / 2;
  return 0;
}

export default defineSim({
  meta: {
    id: 'maths.monte-carlo-pi',
    title: 'Estimating pi by throwing points',
    version: '1.0.0',
    subjects: ['maths'],
    license: 'CC-BY-4.0',
    provenance: 'ORIGINAL',
    protocol: 1,
  },
  params: {
    samples: num({
      name: 'samples',
      label: 'points',
      unit: '',
      min: 100,
      max: 20000,
      default: 2000,
    }),
    dropped: num({
      name: 'dropped',
      label: 'points drawn',
      unit: '',
      min: 0,
      max: 20000,
      default: 2000,
    }),
    seed: num({ name: 'seed', label: 'seed', unit: '', min: 0, max: 999999, default: 4242 }),
  },
  controls: { params: true, state: true, scenarios: [] },
  accessibility: {
    keyboard: true,
    screenReaderSummary:
      'A square with a quarter circle, a scatter of thrown points, a running count, and a box for the estimate.',
    reducedMotion: true,
    // THE COUNTS ARE IN HERE AND THE ESTIMATE IS NOT. The counts are the question — they are what the
    // student is shown — and pi is the answer. An alternative that gave the estimate would answer it in the
    // one place a screen-reader user is told to look.
    textAlternative:
      'A square one unit on each side with a quarter circle of radius one at its lower-left corner, and a ' +
      'scatter of plotted points, some inside the curve and some outside. The task is to use the proportion ' +
      'of points that landed inside to work out an estimate of pi.',
    summary:
      'Throw points at a quarter circle and estimate pi from the proportion that land inside.',
  },
  // `grade(state, params, answer)` -- three positional arguments; `defineSim` checks the arity at load.
  grade(_state: unknown, rawParams: MonteParams, answer: unknown) {
    const params = clamp(rawParams);

    /**
     * NOTHING DRAWN IS A DIFFERENT FACT FROM "DRAWN AND ESTIMATED".
     *
     * A sample of zero points has no proportion in it, so any number a student typed came from memory rather
     * than from the experiment. A grader that treats that as "a bad estimate" misses the actual mistake, which
     * is that the method was not used at all.
     */
    if (params.dropped === 0) {
      return {
        points: 0,
        max: MAX,
        code: 'NOTHING_DRAWN',
        feedback: `Draw some points into the square before estimating from them. ${describeTask(params)}`,
      };
    }

    if (answer === null || answer === undefined || String(answer).trim() === '') {
      return {
        points: 0,
        max: MAX,
        code: 'MISSING',
        feedback: `Type your estimate for pi. ${describeTask(params)}`,
      };
    }

    const given = Number(answer);
    if (!Number.isFinite(given)) {
      return {
        points: 0,
        max: MAX,
        code: 'UNPARSEABLE',
        feedback: `Type a single number, with no units. ${describeTask(params)}`,
      };
    }

    /**
     * THE BAND IS THE SAMPLE'S OWN UNCERTAINTY, NOT A CONSTANT.
     *
     * This is the simulation's whole lesson expressed in one line of grading code. A student who throws ten
     * times as many points has earned about `sqrt(10)` times the precision -- not ten times -- and a fixed
     * band would award them ten times the marks for three times the accuracy.
     */
    const band = toleranceFor(params.dropped);
    const sigmas = Math.abs(given - PI) / band;
    const points = marksForSigmas(sigmas);

    if (points === MAX) {
      return {
        points,
        max: MAX,
        code: 'CORRECT',
        feedback:
          `${format(given)} is within the uncertainty of ${String(params.dropped)} points, which is about ` +
          `±${format(band)}. A better estimate comes from MORE points, and the gain shrinks as the square ` +
          `root — four times the points buys about twice the precision.`,
      };
    }

    /**
     * THE FEEDBACK SHOWS THE PROPORTION, so the student can see WHICH step went wrong.
     *
     * Saying "you should have got 3.14" teaches nothing. Saying "1,568 of 2,000 landed inside, so 4 x that
     * fraction is 3.14" is the whole calculation, and it is the calculation they are being asked to do.
     */
    const inside = countInside(sample(params.seed, params.dropped));
    const proportion = params.dropped === 0 ? 0 : inside / params.dropped;
    return {
      points,
      max: MAX,
      code: points > 0 ? 'PARTIAL' : 'WRONG',
      feedback:
        `You estimated ${format(given)}. ${String(inside)} of ${String(params.dropped)} points landed inside ` +
        `the curve, so the proportion is ${format(proportion)}, and four times that is ` +
        `${format(round(4 * proportion))}. ${String(params.dropped)} points resolve pi to about ±${format(band)}.`,
    };
  },
  validateState(state) {
    if (state === null || typeof state !== 'object') return 'the state is not an object';
    const s = state as { seed?: unknown; dropped?: unknown };
    if (typeof s.seed !== 'string' || s.seed === '') return 'the state has no seed';
    if (typeof s.dropped !== 'number' || !Number.isFinite(s.dropped))
      return 'the state has no finite `dropped`';
    /**
     * POINTS CANNOT BE UN-THROWN.
     *
     * A negative `dropped` passed `Number.isFinite`, so the validator accepted a state describing a
     * negative number of sampled points. `sample(seed, -1)` then returns an empty array, so the experiment
     * silently became "no points" while the state claimed otherwise — and the student who had actually thrown
     * 2,000 would be shown an empty square. A validator that accepts a state it cannot honour is worse than
     * one that refuses it, because the failure surfaces as a wrong question rather than an error.
     */
    if (s.dropped < 0)
      return 'the state has a negative `dropped` count, and points cannot be un-thrown';
    return null;
  },
});

/**
 * HOW MANY BANDS WIDE AN ERROR IS.
 *
 * Exported because "is this answer within one band" is a question a marker asks, and a marker who has to
 * reimplement the division to ask it will get it subtly wrong. `NaN` is infinitely many bands rather than
 * zero: an unreadable estimate is not a small error, and `Math.abs(NaN) / band` is `NaN`, which compares
 * false against every threshold and so falls through every guard written as `sigmas <= 1`.
 */
export function bandsFrom(error: number, tolerance: number): number {
  if (!Number.isFinite(error)) return Number.POSITIVE_INFINITY;
  return Math.abs(error) / Math.max(tolerance, 1e-12);
}

export { estimatePi, toleranceFor };

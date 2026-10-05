/**
 * The grader half. Node, no DOM, deterministic.  (P6-T11, gold sim 19)
 *
 * ## THE ANSWER IS A DAY COUNT, AND THE HOST'S SLIDER SETS IT
 *
 * The student has already positioned the planet by dragging time; the question is when it will next be at
 * that same place. That is the period, and it is a number the student can read off the sim — which is the
 * point: this simulation grades a reading, and everything interesting about it is elsewhere.
 *
 * ## WHY THE CORRECTNESS LIVES IN THE MODEL AND NOT HERE
 *
 * `positionAt` is the single source of truth for where the planet is, and this grader never recomputes a
 * position. The failure mode it is avoiding is a grader with its own copy of the maths that agrees with the
 * drawing until the two implementations diverge — and they always diverge eventually, at an eccentric
 * orbit, at a large t, or on a platform with different float behaviour.
 */

import { defineSim, num, tolerance } from '@orrery/sim-sdk/grader';
import {
  clampTime,
  describeOrbit,
  format,
  type OrreryParams,
  radiusAt,
  round,
  step,
} from './model.js';

/**
 * How many days of slop.
 *
 * A day is 0.27% of a year, so this is tighter than the smallest unit the sim displays and looser than
 * float noise at any t the slider can reach. Stated as a RELATIVE tolerance because the answer scales with
 * the period, and an absolute band would mark a 5-day orbit and a 5-year orbit on the same terms.
 */
const TOLERANCE = { absolute: 0.01, relative: 0.001 } as const;

export default defineSim({
  meta: {
    id: 'astronomy.orrery',
    title: 'An orrery',
    version: '1.0.0',
    subjects: ['astronomy'],
    licence: 'CC-BY-4.0',
    provenance: 'ORIGINAL',
    protocol: 1,
  },
  params: {
    a: num({ name: 'a', label: 'orbit radius', unit: 'AU', min: 0.1, max: 40, default: 1 }),
    e: num({ name: 'e', label: 'eccentricity', unit: '', min: 0, max: 0.9, default: 0.017 }),
    period: num({
      name: 'period',
      label: 'period',
      unit: 'days',
      min: 1,
      max: 5000,
      default: 365.25,
    }),
  },
  // A STEPPER, because a time axis needs step buttons as well as a slider — and the step is SATURATING, so
  // holding the button down cannot walk the clock past `maxTime` and accumulate error on the way.
  controls: {
    params: true,
    state: true,
    stepper: true,
    stepSize: 7,
    maxTime: 3652.5,
    scenarios: [],
  },
  accessibility: {
    keyboard: true,
    screenReaderSummary:
      'A planet on its orbit around the Sun, a slider for the day, a number box for the answer, and step buttons.',
    reducedMotion: true,
    // THE TEXT ALTERNATIVE GIVES THE PERIOD AWAY, and that is deliberate and different from every other
    // simulation in this set.
    //
    // A WebGL canvas cannot be described by "here is a picture of a planet". The alternative has to carry
    // the numbers, and the numbers ARE the question here: the student reads the period off the sim, so
    // stating it in the alternative gives a screen-reader user the same route to the answer that a sighted
    // user has by reading the panel. Denying them that is not rigour, it is a wall.
    textAlternative:
      'A planet on its orbit around the Sun, and a table of the orbit: the distance from the Sun in ' +
      'astronomical units, and how many days one complete orbit takes. The task is to work out how many ' +
      'days the planet takes to return to the same point.',
    summary: "Read a planet's orbit and work out how long it takes to go round once.",
  },
  // `grade(state, params, answer)` -- three positional arguments; `defineSim` checks the arity at load.
  grade(_state: unknown, params: OrreryParams, answer: unknown) {
    const expected = params.period;
    // THE ANSWER IS KEYED, because the box on screen is labelled in DAYS and a bare number off a wire
    // does not say so. Reading `answer` directly rather than `answer.days` is what made the first version
    // mark every submission UNPARSEABLE.
    const submitted =
      answer !== null && typeof answer === 'object' ? (answer as { days?: unknown }).days : answer;
    const question = describeOrbit(params);

    if (submitted === null || submitted === undefined || String(submitted).trim() === '') {
      return {
        points: 0,
        maxPoints: 4,
        code: 'MISSING',
        feedback: `Enter a number of days. ${question}`,
      };
    }

    const given = Number(submitted);
    if (!Number.isFinite(given)) {
      return {
        points: 0,
        maxPoints: 4,
        code: 'UNPARSEABLE',
        feedback: `Enter a number of days, with no units. ${question}`,
      };
    }

    /**
     * A RELATIVE TOLERANCE, because the answer scales with the orbit.
     *
     * An absolute band of a tenth of a day marks a 5-day orbit right to 2% and a 4000-day orbit right to
     * nothing. The relative form is the one that means "to the precision the sim displays" at every scale.
     */
    const result = tolerance(given, expected, {
      abs: TOLERANCE.absolute,
      rel: TOLERANCE.relative,
      maxPoints: 4,
    });

    if (result.points === 4) {
      return {
        points: 4,
        maxPoints: 4,
        code: 'CORRECT',
        feedback: `Correct: ${format(expected)} days, at ${format(radiusAt(params))} AU. ${question}`,
      };
    }

    /**
     * THE FEEDBACK GIVES THE ROUTE, NOT JUST THE ANSWER.
     *
     * "Not quite" teaches nothing. Saying the orbit radius is a third of the way round and that a planet
     * further out takes longer turns a wrong number into the beginning of a correction, and it is the same
     * sentence a teacher would write.
     */
    return {
      points: result.points,
      maxPoints: 4,
      code: result.points > 0 ? 'PARTIAL' : 'WRONG',
      feedback:
        `You said ${format(given)} days; the orbit takes ${format(expected)}. The planet is ` +
        `${format(radiusAt(params))} AU from the Sun, and further out means slower, so a longer year. ` +
        question,
    };
  },
  validateState(state) {
    if (state === null || typeof state !== 'object') return 'the state is not an object';
    const t = (state as { t?: unknown }).t;
    if (typeof t !== 'number' || !Number.isFinite(t)) return 'the state has no finite `t`';
    if (t < 0) return 'the state has a negative time, and time cannot run backwards';
    return null;
  },
});

export { clampTime, radiusAt, round, step };

/**
 * The grader half. Node, no DOM, deterministic.  (P6-T11, gold sim 22)
 *
 * ## THE ANSWER IS A MEASURED PERIOD, AND THE FORMULA IS THE MARKING KEY
 *
 * The student is asked for one full swing of a pendulum of a given length. The small-angle formula
 * `2 * pi * sqrt(L/g)` gives it, and the simulation's own trajectory agrees with that formula to a few parts
 * in a thousand — which is the point of the exercise, and the reason the start angle is capped at 60 degrees
 * (`MAX_START_DEG`). Past about 70 degrees the formula is far enough off that a student checking their
 * arithmetic against the simulation concludes the formula is wrong.
 *
 * ## AND THE ANSWER IS NOT PI-ADJACENT, IT IS THE SAME FOR EVERY SEED
 *
 * There is no seed here. Unlike Monte Carlo, the period is a property of the LENGTH, not of a sample, so this
 * simulation is the control for the randomised one: two students with the same length must get the same
 * answer, and a grader that disagreed with itself between runs would be the bug.
 */

import { defineSim, num, tolerance } from '@orrery/sim-sdk/grader';
import {
  clamp,
  degToRad,
  describeTask,
  format,
  G,
  MAX_START_DEG,
  measuredPeriod,
  type PendulumParams,
  round,
  smallAnglePeriod,
} from './model.js';

const MAX = 4;

/**
 * THE BAND IS A PERCENTAGE PLUS A SMALL FLOOR.
 *
 * A percentage, because the answer scales as `sqrt(L)`: 0.02 s on a 0.5 m pendulum is 4% and on a 4 m
 * pendulum it is 0.5%. A fixed absolute band would be tight on the long ones and absurd on the short ones.
 *
 * The floor is 0.01 s because a student types two decimals, and a band narrower than their precision would
 * reject an answer they had no way to express.
 */
/**
 * AND THE BAND IS TIGHTER THAN THE `g = 10` MISTAKE ON PURPOSE.
 *
 * Using `g = 10` instead of 9.81 is 0.96% out at `L = 1` -- which is INSIDE a 1% band. So a grader with a 1%
 * band cannot tell "used g = 10" from "used g = 9.81", and the `G_TEN` branch below never fires: the exact
 * answer wins first and the student who rounded `g` is told they are correct.
 *
 * The band is therefore 0.2%, comfortably tighter than 0.96% and comfortably looser than the 0.11% spread
 * between this simulation's measured period and the formula. It is a genuine discrimination problem rather
 * than a tolerance preference: without it, two different wrong answers receive the same mark, and one of them
 * is the most common rounding error in the subject.
 */
const RELATIVE = 0.002;
const FLOOR = 0.01;

/**
 * EXPORTED because the band is the grading contract and a reader should not have to reimplement it to know
 * what the grader will accept. A test that recomputes `expected * 0.01` separately is a test that will
 * disagree with the grader when one of them is edited, which is the same drift this file exists to prevent.
 */
export function bandFor(expected: number): number {
  return Math.max(expected * RELATIVE, FLOOR);
}

export default defineSim({
  meta: {
    id: 'physics.pendulum',
    title: 'How long is one swing?',
    version: '1.0.0',
    subjects: ['physics'],
    license: 'CC-BY-4.0',
    provenance: 'ORIGINAL',
    protocol: 1,
  },
  params: {
    length: num({ name: 'length', label: 'length', unit: 'm', min: 0.2, max: 4, default: 1 }),
    // DEGREES IN THE DECLARATION, RADIANS IN THE MODEL, AND THE CONVERSION IS IN `paramsFrom`.
    //
    // A student thinks in degrees and a parameter panel is labelled in degrees, but `Math.sin` wants radians
    // and the model stores radians. Declaring degrees and converting at the boundary means the conversion
    // happens in exactly one place, and cannot drift between the drawing and the grader -- which is what
    // happened when this first declared `start` in radians and the manifest declared `startDeg` in degrees.
    startDeg: num({
      name: 'startDeg',
      label: 'start angle',
      unit: '°',
      min: -MAX_START_DEG,
      max: MAX_START_DEG,
      default: 40,
    }),
  },
  controls: { params: true, state: true, scenarios: [] },
  accessibility: {
    keyboard: true,
    screenReaderSummary:
      'A swinging pendulum drawn as a line, with step and play buttons, an energy graph, and a box for the period.',
    reducedMotion: true,
    // THE LENGTH IS GIVEN AND THE PERIOD IS NOT. The length is the question's own input; the period is the
    // answer. A text alternative that said "one swing takes two seconds" would hand over half the task in the
    // one place a screen-reader user is told to look.
    textAlternative:
      'A pendulum swings back and forth on a line of a given length, released from an angle given in ' +
      'degrees. The task is to work out how many seconds one complete swing takes.',
    summary: 'Work out the period of a pendulum from its length, watching it swing.',
  },
  // `grade(state, params, answer)` -- three positional arguments; `defineSim` checks the arity at load.
  grade(_state: unknown, params: PendulumParams, answer: unknown) {
    /**
     * THE MARKING KEY IS THE SIMULATION'S OWN PERIOD, NOT THE FORMULA.
     *
     * The student is told "watch the pendulum and work out how long one swing takes", so the thing they are
     * estimating is what the pendulum does -- and at 40 degrees that is 2.07 s while the textbook says 2.01 s.
     * Grading against the formula marked every correct answer wrong by 3%, and the message it produced
     * ("one swing takes 2.01 s") contradicted the picture on screen, which is the one artefact the student can
     * see.
     *
     * So the grader runs the same integrator the simulation runs. The formula is still computed, because
     * reporting the gap between them is the single most useful thing the feedback can say: the difference is
     * the small-angle approximation, and naming it is the physics.
     */
    const measured = measuredPeriod(clamp(params));
    const expected = smallAnglePeriod(params.length);
    /**
     * IF THE MEASUREMENT FAILED, SAY SO INSTEAD OF FALLING BACK TO THE FORMULA.
     *
     * A silent fallback marks a student against a number the simulation never showed them, and the failure
     * surfaces as a wrong mark rather than as a broken measurement. `measuredPeriod` returns NaN only when
     * the trajectory does not reverse within four nominal periods, which is itself worth reporting.
     */
    if (!Number.isFinite(measured)) {
      return {
        points: 0,
        max: MAX,
        code: 'NO_PERIOD',
        feedback:
          `This pendulum's period could not be measured from its own trajectory, so there is nothing to mark ` +
          `against. The small-angle formula gives ${format(expected)} s for reference.`,
      };
    }

    if (answer === null || answer === undefined || String(answer).trim() === '') {
      return {
        points: 0,
        max: MAX,
        code: 'MISSING',
        feedback: `Type the number of seconds one full swing takes. ${describeTask(params)}`,
      };
    }

    const given = Number(answer);
    if (!Number.isFinite(given)) {
      return {
        points: 0,
        max: MAX,
        code: 'UNPARSEABLE',
        feedback: `Type a single number, in seconds and with no units. ${describeTask(params)}`,
      };
    }

    /**
     * PARTIAL CREDIT FOR THE TWO FAILURES A STUDENT ACTUALLY MAKES.
     *
     * Either they used `g = 10` instead of 9.81 — a school convention, not a mistake, and a 1% error — or they
     * halved it, having counted half a swing as one. Both are worth marks, and the feedback names which,
     * because the correction is different in each case.
     */
    const band = bandFor(measured);
    const exact = tolerance(given, measured, {
      abs: band,
      rel: RELATIVE,
      maxPoints: MAX,
      partialCredit: true,
    });
    if (exact.points === MAX) {
      return {
        points: MAX,
        max: MAX,
        code: 'CORRECT',
        feedback:
          `Correct: one swing of a ${format(params.length)} m pendulum takes ` +
          `${format(measured)} s. The period is 2 pi times the square root of L over g, which gives ` +
          `${format(expected)} s -- close, but the formula assumes a small swing and this one starts at 40 ` +
          `degrees, where it is ${format(Math.abs((100 * (measured - expected)) / expected))}% out.`,
      };
    }

    /**
     * `g = 10` IS THE SCHOOL CONVENTION, and it lands 0.96% low.
     *
     * Checked AFTER the exact comparison and not before, deliberately. If this ran first then a student who
     * used 9.81 and typed 1.99 for a 2.006 s pendulum would be told they had used g = 10 -- and the message
     * would name a mistake they did not make. The band is 0.2% precisely so that these two answers are
     * distinguishable here at all.
     */
    const withG10 = tolerance(given, 2 * Math.PI * Math.sqrt(params.length / 10), {
      abs: band,
      rel: RELATIVE,
      maxPoints: MAX,
      partialCredit: true,
    });
    if (withG10.points === MAX) {
      return {
        points: MAX / 2,
        max: MAX,
        code: 'G_TEN',
        feedback:
          `You used g = 10, which many schools round to. Using the accurate 9.81 gives ` +
          `${format(expected)} s, so yours is close but reads as a rounding error rather than the right answer.`,
      };
    }

    /**
     * THE HALF-SWING CHECK IS AGAINST THE **MEASURED** PERIOD, NOT THE FORMULA.
     *
     * The first version compared against `expected / 2`, where `expected` is the small-angle value. At 40
     * degrees the two differ by 3%, so a student who halved the simulation's own reading — which is exactly
     * what they did — fell outside the band and was told they were wrong for counting correctly. That is the
     * failure a rubric is supposed to prevent: the grader disagreeing with the thing it is marking.
     */
    if (Math.abs(given - measured / 2) <= band) {
      return {
        points: MAX / 2,
        max: MAX,
        code: 'HALF_SWING',
        feedback:
          `That is half a swing. A full swing is there and back, so it is twice this: ` +
          `${format(measured)} s. The period also grows as the square root of the length, so a pendulum four ` +
          `times as long takes twice as long to swing.`,
      };
    }

    return {
      points: exact.points,
      max: MAX,
      code: exact.points > 0 ? 'PARTIAL' : 'WRONG',
      feedback:
        `You said ${format(given)} s; one swing takes ${format(measured)} s. The period is ` +
        `2 pi times the square root of the length over g, and it does not depend on the angle you released ` +
        `it from. ${describeTask(params)}`,
    };
  },
  validateState(state) {
    if (state === null || typeof state !== 'object') return 'the state is not an object';
    const s = state as { steps?: unknown; length?: unknown };
    if (typeof s.steps !== 'number' || !Number.isFinite(s.steps))
      return 'the state has no finite `steps`';
    // STEPS CANNOT BE NEGATIVE. `runTo(params, -1)` returns the initial state, so a negative count would
    // restore to "step 0" while the checksum said otherwise — a state that cannot be honoured is worse than
    // one that is refused.
    if (s.steps < 0) return 'the state has a negative step count, and time does not run backwards';
    return null;
  },
});

export { degToRad, G, type radToDeg, round, smallAnglePeriod };

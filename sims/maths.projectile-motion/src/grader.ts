/**
 * The grader half. Node, no DOM, deterministic.  (P6-T4, P6-T5, gold sim 1)
 *
 * `B14`: the esbuild metafile asserts this bundle imports zero Node builtins. This file is where
 * that promise is either kept or broken, and the build is the thing that checks it.
 */

import { defineSim, num, numeric, tolerance } from '@orrery/sim-sdk/grader';
import { flightTime, type ProjectileParams, type ProjectileState, range } from './model.js';

/** The answer a student submits: a range, and optionally the flight time. */
export interface ProjectileAnswer {
  readonly range: number;
  readonly time?: number;
}

const parseAnswer = (answer: unknown): ProjectileAnswer | null => {
  if (answer === null || typeof answer !== 'object') return null;
  const record = answer as Record<string, unknown>;
  const r = numeric(record.range, Number.NaN, 1);
  if (r.points === 0 && !Number.isFinite(Number(record.range))) return null;
  const t = record.time === undefined ? undefined : Number(record.time);
  return { range: Number(record.range), ...(t === undefined ? {} : { time: t }) };
};

export default defineSim({
  meta: {
    id: 'maths.projectile-motion',
    title: 'Projectile motion',
    version: '1.0.0',
    subjects: ['maths'],
    licence: 'CC-BY-4.0',
    provenance: 'ORIGINAL',
    protocol: 1,
  },
  params: {
    speed: num({ min: 5, max: 60, default: 25, unit: 'm/s' }),
    angle: num({ min: 5, max: 85, default: 45, unit: 'degrees' }),
    gravity: num({ min: 1.6, max: 24.8, default: 9.81, unit: 'm/s2' }),
  },
  controls: { stepper: true, stepSize: 1 / 60, scenarios: ['no-air'], maxTime: 30 },
  accessibility: {
    keyboard: true,
    screenReaderSummary:
      'A thrown ball in side view, a slider for the launch speed and angle, and a box for the range.',
    reducedMotion: true,
    textAlternative:
      'At 25 m/s and 45 degrees the ball lands about 64 m away after 3.6 seconds, peaking at 32 m.',
    summary: 'A side view of a thrown ball, with the ground, its arc and a range marker.',
    readyAnnouncement: 'Projectile motion ready. Space plays and pauses, arrow keys step.',
  },
  simulate: (params, state: ProjectileState) => ({ t: state.t, ...params }),

  // `state` is part of the required signature and is genuinely UNUSED here: a projectile's range does
  // not depend on when the student looked at it. Naming it `_state` says that deliberately rather than
  // inventing grading behaviour to consume it — a sim that graded on `state` for its own sake would be
  // grading something the student cannot control.
  grade: (_state: ProjectileState, params: ProjectileParams, answer: unknown) => {
    const parsed = parseAnswer(answer);
    if (parsed === null) {
      // NO ANSWER IS NOT A NUMERIC COMPARISON. This called `tolerance(0, 0, { abs: 0 })`, which asks
      // "is 0 within zero of 0" -- and the answer is yes, so `withinTolerance` returned true and a BLANK
      // SUBMISSION SCORED THE FULL 4. `abs: 0` is a real tolerance of zero, and 0 really is inside it; the
      // mistake was routing "nothing was submitted" through a comparator that needs two numbers.
      //
      // A `ToleranceSpec.rationale` was also passed here and silently DISCARDED, because no such field
      // existed -- the grade came back saying "0 is within tolerance of 0". So the intended sentence was
      // never shown and the mark was wrong. Returning the grade directly is what the other twenty-three
      // simulations do, and it puts `UNPARSEABLE` in the `code` the host reads
      // (`packages/contracts/src/grading/simulation.ts:241`).
      return {
        points: 0,
        maxPoints: 4,
        code: 'UNPARSEABLE',
        feedback:
          'No range was submitted, so there is nothing to score. Enter the distance in metres.',
      };
    }
    // The RANGE is the graded answer; it is what the manifest declares and what the rationale template
    // quotes. Partial credit, so a student 2% out is not the same as a student who guessed.
    return tolerance(parsed.range, range(params), {
      abs: 0.5,
      rel: 0.02,
      maxPoints: 4,
      partialCredit: true,
    });
  },

  validateState: (state: unknown) => {
    if (state === null || typeof state !== 'object') return 'the state is not an object';
    const t = (state as { t?: unknown }).t;
    return typeof t === 'number' && Number.isFinite(t) ? null : 'the state has no finite `t`';
  },
});

export { flightTime, range };

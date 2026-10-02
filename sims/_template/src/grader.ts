/**
 * The grader half. Node, no DOM, deterministic.
 *
 * `B14`: the build's metafile asserts this bundle imports ZERO Node builtins, and
 * `tsconfig.grader.json` in `@orrery/sim-sdk` typechecks the same closure with no `dom` lib. So a
 * `document` reference here is a compile error in your editor, not a production incident.
 */

import { defineSim, num, tolerance } from '@orrery/sim-sdk/grader';
import {
  expected,
  initialState,
  MAX_TIME,
  type ModelParams,
  type ModelState,
  simulate,
} from './model.js';

/** The answer a student submits. Keep it small: every field is something they can be asked for. */
export interface Answer {
  readonly value: number;
}

const parse = (answer: unknown): Answer | null => {
  if (answer === null || typeof answer !== 'object') return null;
  const record = answer as Record<string, unknown>;
  return typeof record.value === 'number' && Number.isFinite(record.value)
    ? { value: record.value }
    : null;
};

export default defineSim({
  meta: {
    id: 'SUBJECT.slug',
    title: 'SUBJECT Title',
    version: '0.1.0',
    subjects: ['maths'],
  },
  // Every parameter needs a range. A slider with no limits is a slider a teacher will complain about,
  // and an unbounded one can produce a state the renderer cannot draw.
  params: {
    value: num({ min: 0, max: 100, default: 10, unit: 'm' }),
  },
  controls: {
    // `stepper: true` REQUIRES `maxTime`; `defineSim` throws without it, because a scrubber with no
    // range has nothing to scrub.
    stepper: false,
    scenarios: [],
    maxTime: MAX_TIME,
  },
  accessibility: {
    textAlternative:
      'REPLACE: the numbers this sentence quotes, which must match what the sim displays.',
    summary: 'REPLACE: one or two sentences for the catalogue and for a screen reader.',
    readyAnnouncement: 'SUBJECT Title ready.',
  },
  simulate: (params, state: ModelState) => simulate(params as ModelParams, state, state.t),

  grade: (_state: ModelState, params: ModelParams, answer: unknown) => {
    const parsed = parse(answer);
    if (parsed === null) {
      return tolerance(0, 0, {
        abs: 0,
        maxPoints: 4,
        rationale: 'no value was submitted, so there is nothing to score',
      });
    }
    // Choose a strategy deliberately and say why in the rationale. `tolerance` is symmetric: a student
    // 2% high and a student 2% low earn the same partial credit, which an asymmetric formula would not.
    return tolerance(parsed.value, expected(params as ModelParams), {
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

export { expected, initialState, simulate };

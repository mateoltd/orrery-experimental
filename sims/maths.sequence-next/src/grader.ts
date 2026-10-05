/**
 * The grader half. Node, no DOM, deterministic.  (P6-T11, gold sim 6)
 *
 * ## THE SEQUENCE IS RECONSTRUCTED FROM THE SEED, NOT FROM THE BROWSER
 *
 * The grader receives `state`, which carries the seed. Everything else is derived from it, so a grade can
 * be recomputed on a server that has never seen the student's browser and has no memory of what was on
 * screen. A grader that trusted a value the page sent would be trusting the page.
 */

import { defineSim, exact, num } from '@orrery/sim-sdk/grader';
import { describeSequence, nextTerm, paramsFromSeed, type SequenceParams } from './model.js';

export interface SequenceState {
  readonly seed: number;
  readonly shown: number;
}

const paramsOf = (raw: Readonly<Record<string, unknown>>): SequenceParams => {
  const read = (value: unknown, fallback: number): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  return paramsFromSeed(read(raw.seed, 0), read(raw.shown, 5));
};

export default defineSim({
  meta: {
    id: 'maths.sequence-next',
    title: 'Next in the sequence',
    version: '1.0.0',
    subjects: ['maths'],
    licence: 'CC-BY-4.0',
    provenance: 'ORIGINAL',
    protocol: 1,
  },
  params: {
    shown: num({ name: 'shown', label: 'Terms shown', unit: '', min: 3, max: 8, default: 5 }),
  },
  controls: { params: true, state: true, scenarios: [] },
  accessibility: {
    keyboard: true,
    screenReaderSummary: 'A row of numbers, and a box to type the one that comes next.',
    reducedMotion: true,
    // NO NEXT TERM. The alternative describes the sequence; naming the answer would hand a blocked
    // student the answer and a printed worksheet the exercise's solution.
    textAlternative:
      'A sequence of five numbers with the first named, and the rule that each step changes by. The task is to work out the number that comes next.',
    summary: 'Read a sequence of numbers, find the rule, and type the term that comes next.',
  },
  // `grade(state, params, answer)` -- three positional arguments. `defineSim` checks this arity at load.
  grade(state: SequenceState | unknown, _params: unknown, answer: unknown) {
    const seed = Number((state as SequenceState | null)?.seed);
    if (!Number.isFinite(seed)) {
      return {
        points: 0,
        maxPoints: 4,
        code: 'NO_STATE',
        feedback: 'This answer cannot be graded without the sequence it belongs to.',
      };
    }
    const params = paramsOf({
      seed,
      shown: (state as SequenceState | null)?.shown,
    });

    // EXACT, and the reason is stated on the manifest too: a student's answer is a whole number, and a
    // floating-point tolerance invites an argument about whether 30.0000001 is 30.
    const judged = exact(answer, nextTerm(params), 4);
    if (judged.points === 4) {
      return {
        points: 4,
        maxPoints: 4,
        code: 'CORRECT',
        feedback: `Correct. ${describeSequence(params)}`,
      };
    }
    return {
      points: judged.points,
      maxPoints: 4,
      code: 'WRONG',
      feedback: `Not quite. ${describeSequence(params)}`,
    };
  },
  validateState(state) {
    if (state === null || typeof state !== 'object') return 'the state is not an object';
    const seed = (state as { seed?: unknown }).seed;
    return typeof seed === 'number' && Number.isFinite(seed)
      ? null
      : 'the state has no finite `seed`';
  },
});

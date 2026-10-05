/**
 * The grader half. Node, no DOM, deterministic.  (P6-T11, gold sim 10)
 */

import { defineSim, num, tolerance } from '@orrery/sim-sdk/grader';
import { comparisonCount, describeSearch, format, type SearchParams } from './model.js';

export default defineSim({
  meta: {
    id: 'computing.binary-search',
    title: 'Counting binary search comparisons',
    version: '1.0.0',
    subjects: ['computing'],
    licence: 'CC-BY-4.0',
    provenance: 'ORIGINAL',
    protocol: 1,
  },
  params: {
    target: num({ name: 'target', label: 'Search for', unit: '', min: -99, max: 99, default: 8 }),
    length: num({ name: 'length', label: 'List length', unit: '', min: 1, max: 64, default: 8 }),
  },
  // THE STEPPER IS DECLARED HERE, NOT ONLY IN THE MANIFEST.
  //
  // The manifest said `stepper: true` and this said nothing, so `defineSim`'s own check -- which is the
  // thing that refuses a stepper with no `maxTime` -- never fired, and the manifest was free to claim a
  // capability the simulation had not declared. Two declarations of the same fact, one enforced.
  controls: { params: true, state: true, stepper: true, stepSize: 1, scenarios: [], maxTime: 7 },
  accessibility: {
    keyboard: true,
    screenReaderSummary:
      'A row of numbered cells that are searched one at a time, and a box for the number of comparisons.',
    reducedMotion: true,
    // The count is the answer and no count appears here. The inputs are named, because they are the
    // question -- the same distinction the titration simulation turned on.
    textAlternative:
      'A sorted list of numbers and a value to search for are given, together with the rule for choosing ' +
      'the middle of the remaining range. The task is to work out how many comparisons the search makes.',
    summary: 'Watch a binary search narrow a list, and count how many comparisons it takes.',
  },
  grade(_state: unknown, params: SearchParams, answer: unknown) {
    // `Number('')` is 0, and zero comparisons is a real answer for an empty list but never for a
    // non-empty one, so an empty box must not be read as zero.
    const blank =
      answer === null ||
      answer === undefined ||
      (typeof answer === 'string' && answer.trim() === '');
    const given = Number(answer);
    if (blank || !Number.isFinite(given) || !Number.isInteger(given)) {
      return {
        points: 0,
        maxPoints: 4,
        code: 'UNPARSEABLE',
        feedback: 'Enter the number of comparisons, as a whole number.',
      };
    }
    const expected = comparisonCount(Number(params.target), Number(params.length));
    // A COUNT IS AN INTEGER, so one step out is 25% on a four-mark answer. The band is narrow: counting
    // is not a magnitude estimate, and a tolerance that forgave three steps would forgive not counting.
    const judged = tolerance(given, expected, {
      abs: 0,
      rel: 0,
      maxPoints: 4,
      partialCredit: false,
    });
    return {
      points: judged.points,
      maxPoints: 4,
      code: judged.points === 4 ? 'CORRECT' : 'WRONG',
      feedback:
        judged.points === 4
          ? 'Correct.'
          : `You said ${format(given)}. ${describeSearch(Number(params.target), Number(params.length))} ` +
            `It makes ${format(expected)} comparison${expected === 1 ? '' : 's'}.`,
    };
  },
  validateState(state) {
    if (state === null || typeof state !== 'object') return 'the state is not an object';
    const step = (state as { step?: unknown }).step;
    return typeof step === 'number' && Number.isInteger(step)
      ? null
      : 'the state has no step number';
  },
});

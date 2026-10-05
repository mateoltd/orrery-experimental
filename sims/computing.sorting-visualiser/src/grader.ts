/**
 * The grader half. Node, no DOM, deterministic.  (P6-T11, gold sim 23)
 *
 * ## THE MARKING KEY IS THE SIMULATION'S OWN COUNT
 *
 * `runTo(params, maxPassesFor(size)).comparisons.length` runs the sort to completion, so no expected value is
 * written into this file that could drift away from the sort. Change the algorithm and the key moves with it
 * in the same edit — the only way a marking key stays true as a simulation is revised.
 *
 * ## AND THE BAND IS ONE COMPARISON, NOT A PERCENTAGE
 *
 * The answer is an integer count of discrete events, so a percentage is the wrong unit. Two percent of 28 is
 * 0.56, which would mark a student who was one out as correct; two percent of 4 is 0.08, which would mark a
 * student who was four out as one-comparison-close. The precision this question has is exactly one event, so
 * the band is one comparison — and for the smallest lists that is deliberately generous rather than strict.
 */

import { defineSim, num } from '@orrery/sim-sdk/grader';
import {
  clampParams,
  describeList,
  format,
  maxComparisons,
  maxPassesFor,
  runTo,
  type SortParams,
} from './model.js';

const MAX = 4;
/** ONE COMPARISON, in the unit the answer is measured in. See the header. */
const SLACK = 1;

export default defineSim({
  meta: {
    id: 'computing.sorting-visualiser',
    title: 'How many comparisons?',
    version: '1.0.0',
    subjects: ['computing'],
    licence: 'CC-BY-4.0',
    provenance: 'ORIGINAL',
    protocol: 1,
  },
  // TWO SCALAR PARAMETERS, because the schema's `paramProperty` allows only number, integer, boolean, string
  // and enum — there is no array form, so a `number[]` of values could never be delivered by a host. The
  // list is DERIVED from `(size, seed)` instead, which is also the better question: see model.ts.
  params: {
    size: num({ name: 'size', label: 'numbers', unit: '', min: 5, max: 14, default: 9 }),
    seed: num({ name: 'seed', label: 'list', unit: '', min: 0, max: 999, default: 7 }),
  },
  controls: { params: true, state: true, scenarios: [] },
  accessibility: {
    keyboard: true,
    screenReaderSummary:
      'A row of numbered blocks that reorder as the sort runs, a running comparison count, a pass slider, ' +
      'and a box for the total.',
    reducedMotion: true,
    // THE NUMBERS ARE HERE. THE COUNT IS NOT. The numbers are the question's input; the total is the answer,
    // and an alternative that printed the running count would hand over the answer in the one place a
    // screen-reader user is told to look.
    textAlternative:
      'A list of numbers is sorted into order by repeatedly comparing each pair of neighbours and ' +
      'swapping them when the left is bigger, stopping once a whole pass swaps nothing. The numbers being ' +
      'sorted are given. The task is to work out how many comparisons the whole sort makes.',
    summary: 'Watch bubble sort run, and count the comparisons the whole sort takes.',
  },
  // `grade(state, params, answer)` — three positional arguments; `defineSim` checks the arity when loaded.
  grade(_state: unknown, rawParams: SortParams, answer: unknown) {
    const params = clampParams(rawParams);
    const end = runTo(params, maxPassesFor(params.size));
    const expected = end.comparisons.length;
    const worst = maxComparisons(params.size);
    const task = 'Bubble sort stops as soon as a whole pass swaps nothing.';

    if (answer === null || answer === undefined || String(answer).trim() === '') {
      return {
        points: 0,
        maxPoints: MAX,
        code: 'MISSING',
        feedback: `Type how many comparisons the sort makes before it stops. ${task}`,
      };
    }

    const given = Number(answer);
    if (!Number.isFinite(given)) {
      return {
        points: 0,
        maxPoints: MAX,
        code: 'UNPARSEABLE',
        feedback: `Type a single whole number — a count of comparisons, not a list. ${task}`,
      };
    }

    /**
     * CORRECT IS CHECKED FIRST, AND THE ORDER IS LOAD-BEARING.
     *
     * With `SLACK` of 1, when the true count and `n(n-1)/2` are ADJACENT -- 35 against 36 for nine numbers --
     * the two bands OVERLAP and a perfectly counted answer lands inside both. Testing the ceiling first
     * awarded 2 of 4 to a student who had counted correctly, because their answer was within one of the
     * number this branch exists to catch them using. Four grader tests reported "expected 2 to be 4", which
     * reads like a broken marking key rather than two branches competing for one number. Correctness is the
     * tolerance around the truth, so the truth is tested first; the worst case is a diagnosis for the rest.
     */
    if (Math.abs(given - expected) <= SLACK) {
      return {
        points: MAX,
        maxPoints: MAX,
        code: 'CORRECT',
        feedback:
          `Correct: ${String(expected)} comparisons, over ${String(end.passes)} ` +
          `${end.passes === 1 ? 'pass' : 'passes'}, of which ${String(end.swaps.length)} swapped a pair. ` +
          `The count depends on this list and not only on how many numbers are in it — a list already in ` +
          `order of ${String(params.size)} finishes in ${String(params.size - 1)}, because the first ` +
          `pass finds nothing to do.`,
      };
    }

    /**
     * `n(n-1)/2` IS WHAT EVERY STUDENT WRITES FIRST, AND IT IS A REAL COUNT — FOR A DIFFERENT LIST.
     *
     * It is the count when EVERY comparison swaps, which happens only for a list in exact reverse order. Half
     * marks rather than zero, because the reasoning behind it is sound and the only missing piece is the
     * early exit. The feedback has to carry both numbers, or the student cannot tell whether to re-run the
     * sort or to abandon the method — and a bare "wrong" teaches nothing they did not already suspect.
     */
    if (Math.abs(given - worst) <= SLACK && expected !== worst) {
      return {
        points: MAX / 2,
        maxPoints: MAX,
        code: 'WORST_CASE',
        feedback:
          `You used n(n-1)/2 = ${String(worst)}, which is the count for a list in REVERSE order, where ` +
          `every single comparison swaps. This list stops after ${String(expected)} comparisons, because ` +
          `pass ${String(end.passes)} swapped nothing at all, and that is what ends the sort. ${task}`,
      };
    }

    /**
     * THE CORRECT ANSWER IS CHECKED **BEFORE** THE WORST-CASE EXPLANATION.
     *
     * The order is load-bearing. For a nine-item list whose true cost is 35, the ceiling is 36 — one apart —
     * so the two one-comparison bands OVERLAP, and a grader that tests the worst case first hands out half
     * marks to a student who was exactly right. Four of the grader tests failed on that, all reporting
     * "expected 2 to be 4", which reads like a broken key rather than two branches overlapping.
     *
     * Correctness wins the tie. The cost is that a student answering 36 for this particular list is also
     * within the band and is marked right, which is honest: they were one comparison out, and one comparison
     * is what this question is worth.
     */
    /**
     * THE FEEDBACK GIVES TWO NUMBERS THE STUDENT CAN CHECK AGAIN, not "try again".
     *
     * The true count and the ceiling beside it are the whole explanation. Over-estimating means the early
     * exit was missed; under-estimating usually means comparisons were confused with swaps, which is the one
     * distinction the simulation exists to make visible.
     */
    return {
      points: 0,
      maxPoints: MAX,
      code: 'WRONG',
      feedback:
        `You said ${format(given)}. ${describeList(params)} It takes ${String(expected)} comparisons, ` +
        `against a worst case of ${String(worst)} for ${String(params.size)} numbers. Run the sort to the ` +
        `end and read the counter at the moment it stops: everything after the last swap is the final ` +
        `pass, which compared its pairs and swapped none. ${task}`,
    };
  },
  validateState(state) {
    if (state === null || typeof state !== 'object') return 'the state is not an object';
    const s = state as { passes?: unknown; comparisons?: unknown };
    // A PASS COUNT IS VALIDATED AS A WHOLE NUMBER, because the state indexes a trace and half a pass would
    // address a comparison that never happened. `Number.isFinite(2.5)` is true, so the first version of this
    // accepted half a pass and the picture offered to show it.
    if (typeof s.passes !== 'number' || !Number.isFinite(s.passes))
      return 'the state has no finite `passes` count';
    if (!Number.isInteger(s.passes))
      return 'the state has a fractional `passes` count, and a pass cannot be half-done';
    if (s.passes < 0)
      return 'the state has a negative `passes` count, and comparisons cannot be un-made';
    if (typeof s.comparisons !== 'number' || !Number.isInteger(s.comparisons))
      return 'the state has no whole-number `comparisons` count';
    if (s.comparisons < 0) return 'the state has a negative `comparisons` count';
    return null;
  },
});

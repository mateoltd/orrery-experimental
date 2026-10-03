/**
 * The model. Pure, DOM-free, deterministic.  (P6-T11, gold sim 10)
 *
 * ## THE ANSWER IS A COUNT OF SOMETHING THAT NEVER APPEARS ON SCREEN
 *
 * Every other simulation's answer is a value: a distance, a temperature, a concentration, a root. This
 * one's answer is HOW MANY COMPARISONS the algorithm made, and no number on the display is that number.
 * The student has to count events, which is a different cognitive act from reading a magnitude, and it is
 * the first simulation in the platform where the answer is a property of a PROCESS.
 *
 * `plans/20` gives every computing question a simulator. An algorithms topic that only ever grades
 * "what the array contains" has not tested whether a student can reason about the algorithm at all.
 *
 * ## THE MIDPOINT CONVENTION IS THE WHOLE QUESTION
 *
 * Binary search on an even-length array has two defensible midpoints, and they give different comparison
 * counts. `Math.floor` and `Math.ceil` are both "correct", so a grader that assumes one of them marks a
 * correct trace wrong. The first version used `floor((lo + hi) / 2)` -- which for `lo=0, hi=7` gives
 * index 3, the FOURTH element -- and a student's trace that split the other way was wrong for a reason
 * the question never stated. The convention is declared in the manifest and drawn on screen, and the
 * grader uses the same one.
 *
 * The count is also compared INCLUDES the final failed comparison. An array searched for a value it does
 * not contain still ends in a comparison against something, and stopping one step early is the most common
 * trace error there is.
 */

/** Declared, and drawn on screen, and used by the grader: the LOWER middle element. */
export const MIDPOINT = 'lower' as const;

export interface SearchParams {
  /** The value being searched for. */
  readonly target: number;
  /** How many elements the array holds. Must be >= 1. */
  readonly length: number;
}

export const clamp = (params: SearchParams): SearchParams => ({
  target: Math.min(
    99,
    Math.max(-99, Math.round(Number.isFinite(params.target) ? params.target : 8)),
  ),
  length: Math.min(64, Math.max(1, Math.round(Number.isFinite(params.length) ? params.length : 8))),
});

/** The array is 1..length, so "is it sorted" is true by construction rather than by assertion. */
export const haystack = (length: number): number[] =>
  Array.from({ length }, (_, index) => index + 1);

/** ONE STEP: the midpoint examined, and where the search went next. */
export interface Step {
  readonly index: number;
  readonly value: number;
  readonly outcome: 'less' | 'greater' | 'found' | 'exhausted';
  readonly comparisons: number;
}

/**
 * The trace, step by step.
 *
 * The comparison that ends an unsuccessful search is INCLUDED, marked `exhausted`: the loop compares
 * against one final element and only then gives up.
 */
export function trace(target: number, length: number): Step[] {
  const steps: Step[] = [];
  let low = 0;
  let high = length - 1;
  let comparisons = 0;
  while (low <= high) {
    const mid = low + Math.floor((high - low) / 2);
    const value = mid + 1;
    comparisons += 1;
    if (value === target) {
      steps.push({ index: mid, value, outcome: 'found', comparisons });
      return steps;
    }
    if (value < target) {
      steps.push({ index: mid, value, outcome: 'less', comparisons });
      low = mid + 1;
    } else {
      steps.push({ index: mid, value, outcome: 'greater', comparisons });
      high = mid - 1;
    }
  }
  // Reached only when the loop cannot run again. `low` is one past the last midpoint examined, and the
  // element there is what a final comparison would have been against.
  const index = Math.min(low, length - 1);
  steps.push({ index, value: index + 1, outcome: 'exhausted', comparisons });
  return steps;
}

/** THE ANSWER. A count, and not any value in the array. */
export const comparisonCount = (target: number, length: number): number =>
  trace(target, length).length;

/** An unsuccessful search is a legitimate answer, not a failure to answer. */
export const found = (target: number, length: number): boolean =>
  trace(target, length).at(-1)?.outcome === 'found';

export function describeSearch(target: number, length: number): string {
  const steps = trace(target, length);
  const hit = steps.at(-1)?.outcome === 'found';
  return (
    `A sorted list of ${String(length)} numbers, 1 to ${String(length)}, is searched for ` +
    `${String(target)} by binary search. Each step compares the target with the MIDDLE of the remaining ` +
    `range, taking the lower of the two middles when the range has an even number of elements, and keeps ` +
    `the half that could contain the target. The task is to work out how many comparisons are made before ` +
    `the search ${hit ? 'finds it' : 'gives up'}.`
  );
}

export const format = (value: number): string =>
  Number.isFinite(value) ? String(value) : 'undefined';

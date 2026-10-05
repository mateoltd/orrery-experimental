/**
 * The grader, in bare Node.  (P6-T11, gold sim 10)
 *
 * The cases that matter are about the MIDPOINT CONVENTION and about a count being a different KIND of
 * answer from a magnitude.
 */
import { describe, expect, it } from 'vitest';
import sim from '../src/grader.js';
import {
  comparisonCount,
  describeSearch,
  haystack,
  type SearchParams,
  trace,
} from '../src/model.js';

const grade = (answer: unknown, params: SearchParams = { target: 8, length: 8 }) =>
  sim.grader.grade(null, params, answer);

describe('computing.binary-search', () => {
  it('walks the list in the declared order and finds the target', () => {
    expect(trace(8, 8).map((step) => step.value)).toEqual([4, 6, 7, 8]);
    expect(comparisonCount(8, 8)).toBe(4);
    expect(grade(4)).toMatchObject({ points: 4, code: 'CORRECT' });
  });

  // THE CONVENTION IS THE WHOLE QUESTION.
  //
  // Binary search on an even-length range has two defensible midpoints, and they give different counts.
  // `low + floor((high - low) / 2)` on 0..7 is index 3 -- the FOURTH element -- and a student's trace that
  // split the other way was wrong for a reason the question never stated. The convention is declared in
  // the manifest, drawn on screen, and used by the grader, and this is the test that keeps them together.
  it('takes the LOWER middle, and says so in the text the student reads', () => {
    expect(trace(8, 8)[0]?.index).toBe(3);
    expect(describeSearch(8, 8)).toContain('lower');
  });

  it('takes the only middle when the range has an odd length', () => {
    expect(trace(7, 7).map((step) => step.value)).toEqual([4, 6, 7]);
    expect(comparisonCount(7, 7)).toBe(3);
  });

  // THE COMPARISON THAT ENDS AN UNSUCCESSFUL SEARCH IS INCLUDED.
  //
  // An array searched for a value it does not contain still ends in a comparison against something, and
  // stopping one step early is the most common trace error there is.
  it('counts the final comparison of an UNSUCCESSFUL search', () => {
    const steps = trace(50, 8);
    expect(steps.at(-1)?.outcome).toBe('exhausted');
    expect(comparisonCount(50, 8)).toBe(steps.length);
    expect(grade(comparisonCount(50, 8), { target: 50, length: 8 })).toMatchObject({ points: 4 });
  });

  it('treats "not in the list" as an ANSWER, not a failure to answer', () => {
    expect(comparisonCount(50, 8)).toBeGreaterThan(0);
    expect(grade(0, { target: 50, length: 8 }).points).toBe(0);
  });

  it('grows no faster than the halving it is based on', () => {
    // 64 elements needs at most 7 comparisons: ceil(log2(64)) + 1 for the final failed comparison.
    expect(comparisonCount(1, 64)).toBeLessThanOrEqual(7);
    expect(comparisonCount(1, 1024)).toBeLessThanOrEqual(12);
  });

  it('is exact: a COUNT is not a magnitude estimate', () => {
    // One step out of four is 25% wrong, and a tolerance that forgave it would forgive not counting.
    expect(grade(3, { target: 8, length: 8 }).points).toBe(0);
    expect(grade(5, { target: 8, length: 8 }).points).toBe(0);
    expect(grade(4, { target: 8, length: 8 }).points).toBe(4);
  });

  // A ZERO TOLERANCE USED TO MEAN "NOTHING IS WITHIN TOLERANCE".
  //
  // `withinTolerance(4, 4, {abs: 0, rel: 0})` returned false, so every correct answer scored zero in any
  // simulation that graded a count exactly. Nine gold simulations and a green matrix never declared a zero
  // tolerance; the tenth did, immediately, and it failed.
  it('grades an exact count CORRECTLY, which a zero tolerance used to forbid', () => {
    expect(grade(4).points).toBe(4);
  });

  it('rejects an empty box, a fraction, and a non-number', () => {
    for (const bad of ['', '  ', null, undefined, Number.NaN, 3.5, 'four', {}]) {
      expect(grade(bad)).toMatchObject({ points: 0, code: 'UNPARSEABLE' });
    }
  });

  it('builds an array that is sorted by construction, not by assertion', () => {
    const array = haystack(8);
    expect(array).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect([...array].sort((a, b) => a - b)).toEqual(array);
    expect(haystack(1)).toEqual([1]);
  });

  it('keeps the count out of the text alternative', () => {
    expect(sim.grader.accessibility.textAlternative).not.toMatch(
      /\bcomparisons?\b\s+(is|are)\s+\d/,
    );
    expect(sim.grader.accessibility.textAlternative.length).toBeGreaterThan(20);
    // The inputs ARE named, deliberately: they are the question.
    expect(describeSearch(8, 8)).toContain('8');
  });

  it('declares the stepper AND a maxTime, or the simulation is refused at load', () => {
    expect(sim.grader.controls.stepper).toBe(true);
    expect(sim.grader.controls.maxTime).toBeGreaterThan(0);
    // The trace is at most 7 comparisons for any list this size, so a timeline longer than that would
    // let the student scrub past the end of the search.
    expect(sim.grader.controls.maxTime).toBeGreaterThanOrEqual(comparisonCount(1, 64));
  });

  it('gives feedback that states the count rather than only the verdict', () => {
    const result = grade(9) as { feedback: string };
    expect(result.feedback).toContain('4 comparison');
  });
});

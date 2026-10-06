/**
 * The model and the grader, in bare Node.  (P12-T2, card 70 `computing.search-algorithms`)
 *
 * ## THE ASSERTION THAT MATTERS IS THE PRECONDITION
 *
 * Every other test here is about a number, and a number is easy to get right by writing the algorithm the
 * obvious way. The precondition is the part that is easy to get wrong *silently*: a binary search over an
 * unsorted list returns a plausible count, a plausible index, and nothing anywhere says it was never a
 * search. So the model refuses, and the refusal is asserted here rather than assumed.
 */

import { gradeStoredState } from '@orrery/sim-sdk/grader';
import { describe, expect, it } from 'vitest';
import sim, { COUNT_MARKS, MAX_POINTS } from '../src/grader.js';
import {
  asBoolean,
  binarySearch,
  clamp,
  describeSearch,
  haystack,
  INDEX_WHEN_ABSENT,
  isAscending,
  linearSearch,
  type SearchParams,
  search,
  worstCase,
} from '../src/model.js';

const BINARY: SearchParams = { algorithm: 'binary', size: 16, target: 9, ascending: true };
const LINEAR: SearchParams = { algorithm: 'linear', size: 16, target: 9, ascending: true };

const grade = (answer: unknown, params: SearchParams = BINARY, state: unknown = { probe: true }) =>
  sim.grader.grade(state, params, answer);

const correct = (params: SearchParams = BINARY) => {
  const result = search(params);
  return {
    comparisons: result.comparisons,
    found: result.found,
    index: result.index ?? INDEX_WHEN_ABSENT,
    worstCase: worstCase(params),
  };
};

describe('the model', () => {
  it('binary search is never worse than linear for a target that IS present', () => {
    for (let size = 4; size <= 64; size += 4) {
      // The list is 1..size, so the target has to be inside it or nothing here is about a hit.
      const target = Math.min(7, size);
      const params: SearchParams = { algorithm: 'binary', size, target, ascending: true };
      const bin = binarySearch(haystack(params), params.target);
      const lin = linearSearch(haystack(params), params.target);
      expect(bin.found, `size ${String(size)}`).toBe(true);
      expect(lin.found, `size ${String(size)}`).toBe(true);
      expect(bin.comparisons, `size ${String(size)}`).toBeLessThanOrEqual(lin.comparisons);
      // AND THE WORST-CASE BOUND IS NOT A LIE: no target anywhere produces more comparisons than it claims.
      for (let target = 1; target <= size; target += 1) {
        const found = binarySearch(haystack(params), target);
        expect(
          found.comparisons,
          `size ${String(size)} target ${String(target)}`,
        ).toBeLessThanOrEqual(worstCase(params));
      }
    }
  });

  it('a linear search is FASTER for a target at the front, which is misconception (2)', () => {
    const front: SearchParams = { ...BINARY, target: 1 };
    // 16 elements, target 1: the lower-midpoint convention examines positions 7, 3, 1 and 0 before it finds
    // it -- four comparisons against a linear search's one, which is the misconception stated as arithmetic.
    expect(binarySearch(haystack(front), 1).comparisons).toBe(4);
    expect(linearSearch(haystack(front), 1).comparisons).toBe(1);
    expect(linearSearch(haystack(front), 1).comparisons).toBeLessThan(
      binarySearch(haystack(front), 1).comparisons,
    );
  });

  it('the trace has one row per comparison, which is what a student counts', () => {
    for (const params of [BINARY, LINEAR, { ...BINARY, target: 900 }]) {
      const result = search(params);
      expect(result.steps.length, JSON.stringify(params)).toBe(result.comparisons);
    }
  });

  it('REFUSES a binary search on a list that is not ascending, rather than returning a wrong count', () => {
    const unsorted: SearchParams = { ...BINARY, ascending: false };
    const list = haystack(unsorted);
    expect(isAscending(list)).toBe(false);
    // STILL CONTAINS EVERY VALUE, which is exactly why misconception (3) is tempting.
    expect([...list].sort((left, right) => left - right)).toEqual(haystack(BINARY));
    const result = search(unsorted);
    expect(result.refusal).not.toBeNull();
    expect(result.comparisons).toBe(0);
    expect(result.found).toBe(false);
    expect(result.steps).toEqual([]);
    // AND A LINEAR SEARCH ON THE SAME LIST RUNS, because it has no precondition.
    expect(search({ ...unsorted, algorithm: 'linear' }).refusal).toBeNull();
  });

  it('clamps size, target and the precondition, because a host can send anything', () => {
    expect(clamp({ size: 0, target: Number.NaN, algorithm: 'quicksort' as never })).toEqual({
      algorithm: 'binary',
      size: 4,
      target: 9,
      ascending: true,
    });
    expect(clamp({ size: 1000 }).size).toBe(64);
  });

  it('describes the search it is describing, refusals included', () => {
    expect(describeSearch(BINARY)).toContain('ascending order');
    expect(describeSearch({ ...BINARY, ascending: false })).toContain('NOT in ascending order');
  });
});

describe('the grader', () => {
  it('awards full marks for the counts the trace gives', () => {
    const graded = grade(correct());
    expect(graded.points).toBe(MAX_POINTS);
    expect(graded.code).toBe('CORRECT');
  });

  it('grades EXACTLY: a count one out is wrong, which is what T-A means', () => {
    // A `rel: 0.02` band would accept 11.76 to 12.24 on a count of 12, and the two algorithms differ by about
    // one comparison on most targets -- so a band here is a mark for the wrong algorithm.
    const off = grade({ ...correct(), comparisons: correct().comparisons + 1 });
    expect(off.points).toBeLessThan(MAX_POINTS);
    expect(off.points).toBeLessThanOrEqual(MAX_POINTS - COUNT_MARKS);
    // AND THE ERROR IS EXACTLY ONE MARK, not a fraction of one.
    expect(MAX_POINTS - off.points).toBe(COUNT_MARKS);
  });

  it('reports UNSORTED_PRECONDITION at zero marks for the refused combination', () => {
    const graded = grade(correct(), { ...BINARY, ascending: false });
    expect(graded.code).toBe('UNSORTED_PRECONDITION');
    expect(graded.points).toBe(0);
    expect(graded.feedback).toMatch(/ascending order/u);
  });

  it('scores -1 for the position of a target that is not there', () => {
    const missing: SearchParams = { ...BINARY, target: 900 };
    expect(grade(correct(missing), missing).points).toBe(MAX_POINTS);
    // A student who types 0 has not answered, because the sentinel is declared.
    expect(grade({ ...correct(missing), index: 0 }, missing).points).toBe(MAX_POINTS - COUNT_MARKS);
  });

  it('reads a yes/no answer in the spellings a select, a checkbox and a text box produce', () => {
    for (const spoken of ['yes', 'true', '1']) {
      expect(asBoolean(spoken), spoken).toBe(true);
    }
    for (const spoken of ['no', 'false', '0']) {
      expect(asBoolean(spoken), spoken).toBe(false);
    }
    expect(asBoolean('maybe')).toBeNull();
  });

  it('awards nothing for a blank answer', () => {
    expect(grade(null).points).toBe(0);
    expect(grade(null).code).toBe('UNPARSEABLE');
    expect(grade({}).code).toBe('UNPARSEABLE');
  });

  it('is DETERMINISTIC: three runs, identical output', () => {
    const runs = [0, 1, 2].map(() => JSON.stringify(grade(correct())));
    expect(runs[1]).toBe(runs[0]);
    expect(runs[2]).toBe(runs[0]);
  });

  it('tolerates the determinism probe state, and every legal parameter combination', () => {
    expect(() => grade(correct(), BINARY, { probe: true })).not.toThrow();
    for (const algorithm of ['binary', 'linear'] as const) {
      for (const size of [4, 7, 16, 64]) {
        for (const ascending of [true, false]) {
          const params: SearchParams = { algorithm, size, target: 3, ascending };
          expect(() => grade(correct(params), params), JSON.stringify(params)).not.toThrow();
        }
      }
    }
  });

  it('REPLAYS: re-grading the stored state reproduces the stored mark', () => {
    const state = { ...BINARY };
    const once = sim.grader.grade(state, state, correct());
    const twice = gradeStoredState(sim.grader, { state, params: state, answer: correct() });
    expect(twice.points).toBe(once.points);
    expect(twice.code).toBe(once.code);
  });

  it('`gradeStoredState` is what REFUSES a bad state', () => {
    const validator = sim.grader.validateState;
    if (validator === undefined) throw new Error('this simulation declares no validateState');
    expect(validator(BINARY)).toBeNull();
    expect(validator({ size: 4 })).toMatch(/algorithm/u);
    expect(validator({ algorithm: 'binary', size: Number.NaN })).toMatch(/size/u);
    expect(() =>
      gradeStoredState(sim.grader, { state: { size: 4 }, params: BINARY, answer: correct() }),
    ).toThrow(/STATE_INVALID/u);
  });
});

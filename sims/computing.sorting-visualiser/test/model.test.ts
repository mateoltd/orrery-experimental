import { describe, expect, it } from 'vitest';
// `defineSim` returns `{ grader, browser }`, not the grader itself, so the callable halves are reached
// through `sim.grader`. A first version imported `grade` as a named export and called `sim.validateState`
// directly, and every grader test failed with "grade is not a function" -- which reads like a broken
// grader rather than a wrong property path, and sent the next person looking in the wrong file.
import sim from '../src/grader.js';

const { grade } = sim.grader;

import {
  type Comparison,
  clampParams,
  initialState,
  isSorted,
  MAX_SEED,
  MAX_SIZE,
  MIN_SIZE,
  maxComparisons,
  maxPassesFor,
  pass,
  runTo,
  totalComparisons,
  valuesOf,
} from '../src/model.js';

const PARAMS = { size: 9, seed: 7 };
const OTHER = { size: 9, seed: 8 };

/**
 * A SEED WHERE THE TRUTH AND THE CEILING ARE FAR APART.
 *
 * `seed: 7` costs 35 comparisons on nine numbers, and the ceiling is 36 — one apart, so the two one-comparison
 * bands OVERLAP and `n(n-1)/2` is indistinguishable from a correct count. That is a true property of this
 * question, not a defect, and a test written against it fails for a reason that has nothing to do with the
 * grader. The `WORST_CASE` diagnosis is only meaningful when the numbers are far enough apart to tell apart,
 * so these tests use a seed with a real gap.
 */
const WIDE = { size: 9, seed: 4 };

/** Every parameter pair a host could legally deliver. The invariants must hold across all of them. */
function everyParams(): Array<{ size: number; seed: number }> {
  const out: Array<{ size: number; seed: number }> = [];
  for (const size of [MIN_SIZE, 8, 11, MAX_SIZE]) {
    for (const seed of [0, 1, 7, 42, 500, MAX_SEED]) out.push({ size, seed });
  }
  return out;
}

describe('the list a seed produces', () => {
  it('is the right length, and its values are DISTINCT', () => {
    // Distinctness is not cosmetic. Two equal neighbours make bubble sort's decision unobservable: the pair
    // is compared, nothing moves, and a student cannot tell a working sort from one that skipped the check.
    for (const params of everyParams()) {
      const values = valuesOf(params.seed, params.size);
      expect(values).toHaveLength(params.size);
      expect(new Set(values).size).toBe(values.length);
    }
  });

  it('is a permutation of consecutive integers, so no value is out of range', () => {
    for (const params of everyParams()) {
      const values = [...valuesOf(params.seed, params.size)].sort((a, b) => a - b);
      expect(values).toEqual(Array.from({ length: params.size }, (_, index) => index));
    }
  });

  it('is the same list every time, or the question cannot be answered', () => {
    // `Math.random()` here would make the marking key unreproducible for the student as well as for us.
    for (const params of everyParams()) {
      expect(valuesOf(params.seed, params.size)).toEqual(valuesOf(params.seed, params.size));
    }
  });

  it('gives neighbouring seeds DIFFERENT lists, or every seed would be the same question', () => {
    for (let seed = 0; seed < 40; seed += 1) {
      const here = valuesOf(seed, 9);
      const next = valuesOf(seed + 1, 9);
      expect(here).not.toEqual(next);
    }
  });

  it('does not hand out already-sorted lists often enough to give the answer away', () => {
    // The INITIAL list is what matters, and the first version of this checked the list AFTER running the
    // sort — which is sorted by construction, so the assertion saw 200 out of 200 "already sorted" and would
    // have failed for the wrong reason. `initialState` is the pre-sort picture; `isSorted` on it is the real
    // question.
    //
    // A sorted seed makes the count trivially n-1, which is a legitimate question but an easy one. If the
    // shuffle were broken it would hand out hundreds of them.
    let sortedCount = 0;
    for (let seed = 0; seed < 200; seed += 1) {
      if (isSorted(initialState({ size: 9, seed }).items)) sortedCount += 1;
    }
    expect(sortedCount).toBeLessThan(5);
  });
});

describe('a pass', () => {
  it('counts every pair it looks at, whether or not it swaps them', () => {
    // THIS IS THE WHOLE POINT of the simulation. A count of swaps is a different event from a count of
    // comparisons, and a pass that skipped unswapped pairs would answer a different question.
    const state = runTo(PARAMS, 1);
    expect(state.comparisons).toHaveLength(PARAMS.size - 1);
  });

  it('swaps exactly the pairs that were out of order', () => {
    const state = runTo(PARAMS, 1);
    for (const swap of state.swaps) {
      const left = state.comparisons.find((c) => c.pass === swap.pass && c.left === swap.left);
      expect(left).toBeDefined();
    }
    expect(state.swaps.length).toBeLessThanOrEqual(state.comparisons.length);
  });

  it('puts the largest remaining value at the end of the list', () => {
    // The one guarantee bubble sort makes per pass, and it is what makes the early exit possible.
    const values = valuesOf(PARAMS.seed, PARAMS.size);
    const state = runTo(PARAMS, 1);
    expect(state.items[state.items.length - 1]?.value).toBe(Math.max(...values));
  });

  it('is finished after a single pass when the list started sorted', () => {
    const sorted = { size: 6, seed: 0 };
    const state = runTo({ ...sorted, size: 6 }, 1, maxPassesFor(6));
    const asList = valuesOf(sorted.seed, 6);
    const alreadySorted = asList.every(
      (value, index) => index === 0 || (asList[index - 1] ?? 0) <= value,
    );
    // Whatever this seed gives, the property under test is that a clean pass sets `finished` and never more.
    expect(state.finished).toBe(alreadySorted);
  });

  it('does nothing once finished, so extra passes cannot change the count', () => {
    const end = runTo(PARAMS, 99);
    const again = pass(end, maxPassesFor(PARAMS.size));
    expect(again).toBe(end);
  });
});

describe('running to a pass count', () => {
  it('is PURE: the same step gives the same history however it was reached', () => {
    // This is the only reason the scrub slider can exist. A stepper whose state accumulates cannot go back.
    const direct = runTo(PARAMS, 3);
    const fromFive = runTo(PARAMS, 5);
    const fromTen = runTo(PARAMS, 10);
    expect(fromFive.comparisons.slice(0, direct.comparisons.length)).toEqual(direct.comparisons);
    expect(fromTen.comparisons.slice(0, direct.comparisons.length)).toEqual(direct.comparisons);
  });

  it('never counts more comparisons than there are pairs', () => {
    for (const params of everyParams()) {
      const total = totalComparisons(params);
      expect(total).toBeLessThanOrEqual(maxComparisons(params.size));
    }
  });

  it('ends SORTED for every legal parameter pair', () => {
    // A visualiser that draws an unsorted list at the end is worse than none: the student is shown a claim
    // the code does not support.
    for (const params of everyParams()) {
      expect(isSorted(runTo(params, 99).items)).toBe(true);
    }
  });

  it('ends FINISHED for every legal parameter pair', () => {
    for (const params of everyParams()) {
      expect(runTo(params, 99).finished).toBe(true);
    }
  });

  it('counts MORE comparisons than swaps on at least some lists, or counting swaps would pass unnoticed', () => {
    // If these were equal for every list, the distinction the simulation teaches would be invisible.
    let strictlyFewer = 0;
    for (const params of everyParams()) {
      const end = runTo(params, 99);
      if (end.comparisons.length > end.swaps.length) strictlyFewer += 1;
    }
    expect(strictlyFewer).toBeGreaterThan(0);
  });

  it('gives a DIFFERENT count for different lists of the same size', () => {
    // If the count depended only on the size, `n(n-1)/2` would be right most of the time and the early exit
    // would be a footnote instead of the lesson.
    const counts = new Set<number>();
    for (let seed = 0; seed < 30; seed += 1) counts.add(totalComparisons({ size: 9, seed }));
    expect(counts.size).toBeGreaterThan(3);
  });

  it('gives the SAME count for the same list whatever path the student took', () => {
    expect(totalComparisons(PARAMS)).toBe(totalComparisons(PARAMS));
    expect(runTo(PARAMS, 99).comparisons).toEqual(runTo(PARAMS, 99).comparisons);
  });

  it('keeps the comparison history a prefix of the longer one', () => {
    const short = runTo(PARAMS, 2);
    const long = runTo(PARAMS, 6);
    expect(long.comparisons.slice(0, short.comparisons.length)).toEqual(short.comparisons);
  });

  it('records which pass made each comparison, so a repeat is visible', () => {
    const comparisons: readonly Comparison[] = runTo(PARAMS, 4).comparisons;
    const passes = new Set(comparisons.map((c) => c.pass));
    // A pair is looked at on every pass until it is in order, so passes must be represented more than once
    // for a list this size — otherwise the pass number is decoration.
    expect(passes.size).toBeGreaterThanOrEqual(comparisons.length / PARAMS.size);
  });
});

describe('clamping', () => {
  it('keeps the size inside the range the bars can actually show', () => {
    expect(clampParams({ size: 2 }).size).toBe(MIN_SIZE);
    expect(clampParams({ size: 999 }).size).toBe(MAX_SIZE);
  });

  it('falls back to whole numbers when the host sends nonsense', () => {
    // `Number(undefined)` is NaN and `Math.round(NaN)` is NaN, so an unclamped size reaches the layout as NaN
    // and every width becomes NaN — which renders as nothing at all, silently.
    expect(clampParams({ size: Number.NaN }).size).toBeGreaterThanOrEqual(MIN_SIZE);
    expect(clampParams({ size: 8.6 }).size).toBe(9);
  });

  it('keeps the seed in range so the hash cannot produce a negative state', () => {
    expect(clampParams({ seed: -5 }).seed).toBe(0);
    expect(clampParams({ seed: 1e9 }).seed).toBe(MAX_SEED);
  });
});

describe('the grader', () => {
  const answer = (params: { size: number; seed: number }, given: unknown) =>
    grade({}, params, given);

  it('awards full marks for the count the simulation reaches', () => {
    const result = answer(PARAMS, totalComparisons(PARAMS));
    expect(result.points).toBe(result.max);
  });

  it('awards full marks one comparison either side, because the answer is an integer count', () => {
    const expected = totalComparisons(PARAMS);
    expect(answer(PARAMS, expected - 1).points).toBe(answer(PARAMS, expected).max);
    expect(answer(PARAMS, expected + 1).points).toBe(answer(PARAMS, expected).max);
  });

  it('awards nothing two comparisons out, so the band is not doing the grading', () => {
    // `WIDE`, because with `PARAMS` the answer two out is 37 and the ceiling is 36: still inside the
    // worst-case band, so it earns the half mark that branch exists to award, and the assertion below would
    // be testing the overlap rather than the width of the tolerance.
    const expected = totalComparisons(WIDE);
    expect(answer(WIDE, expected + 2).points).toBe(0);
  });

  it('gives half marks for the worst case, and says how far off it was', () => {
    // `n(n-1)/2` is what a student writes without running the sort. The reasoning is sound and only the
    // missing early exit is not, so zero would tell them their method was wrong when it was nearly right.
    const worst = maxComparisons(WIDE.size);
    const expected = totalComparisons(WIDE);
    if (expected === worst) return; // A reverse-ordered list makes the two indistinguishable.
    const result = answer(WIDE, worst);
    expect(result.points).toBeGreaterThan(0);
    expect(result.points).toBeLessThan(result.max);
    expect(result.feedback).toContain(String(expected));
    expect(result.feedback).toContain(String(worst));
  });

  it('marks the ceiling correct when the truth is one comparison below it', () => {
    // The overlap is a real property and it is pinned deliberately. `PARAMS` costs 35 on nine numbers and the
    // ceiling is 36, so answering 36 is one comparison out -- which is exactly what this question's
    // tolerance buys. Correctness is checked first, so it is right that this scores full marks rather than
    // being read as the n(n-1)/2 mistake. What it must NOT do is score half: the student counted correctly.
    const expected = totalComparisons(PARAMS);
    const worst = maxComparisons(PARAMS.size);
    if (expected !== worst - 1) return; // Only meaningful for a seed this close to the ceiling.
    expect(answer(PARAMS, worst).points).toBe(answer(PARAMS, expected).max);
  });

  it('does NOT give half marks for the worst case when it happens to be right', () => {
    let sawReverse = false;
    for (let seed = 0; seed < 60 && !sawReverse; seed += 1) {
      const params = { size: 8, seed };
      if (totalComparisons(params) !== maxComparisons(params.size)) continue;
      sawReverse = true;
      expect(answer(params, maxComparisons(params.size)).points).toBe(4);
    }
    expect(sawReverse).toBe(true);
  });

  it('marks a blank answer missing rather than wrong', () => {
    expect(answer(PARAMS, '').code).toBe('MISSING');
    expect(answer(PARAMS, null).code).toBe('MISSING');
    expect(answer(PARAMS, '   ').code).toBe('MISSING');
  });

  it('rejects text that is not a number, without awarding a stray point', () => {
    expect(answer(PARAMS, 'lots').code).toBe('UNPARSEABLE');
    expect(answer(PARAMS, 'lots').points).toBe(0);
  });

  it('does not treat the words "no" or "n/a" as zero', () => {
    // `Number('no')` is NaN and `Number('')` is 0, so a blank box and a typed "n/a" must not both grade as 0
    // out of 4 — one is a student who gave up and one is a student who never answered.
    expect(answer(PARAMS, 'n/a').code).toBe('UNPARSEABLE');
  });

  it('keeps the count beside the ceiling in the wrong-answer feedback', () => {
    const result = answer(PARAMS, totalComparisons(PARAMS) + 9);
    expect(result.feedback).toContain(String(totalComparisons(PARAMS)));
    expect(result.feedback).toContain(String(maxComparisons(PARAMS.size)));
  });

  it('never puts the count in the question', () => {
    // The task text is shown before and after grading, so if it leaked the answer the feedback would be a
    // second, quieter copy of the marking key.
    expect(answer(PARAMS, 0).feedback).not.toContain(`Correct:`);
  });

  it('uses the params it is given, so two students at one size are marked differently', () => {
    expect(answer(PARAMS, totalComparisons(PARAMS)).points).toBe(4);
    const other = answer(OTHER, totalComparisons(PARAMS));
    // Only asserted when the two lists really do differ in cost, which the earlier test proves happens.
    if (totalComparisons(PARAMS) === totalComparisons(OTHER)) return;
    expect(other.points).toBe(0);
  });

  it('grades against a clamped size, so a host sending 999 cannot mark on 999 numbers', () => {
    const expected = totalComparisons({ size: MAX_SIZE, seed: 7 });
    expect(answer({ size: 9999, seed: 7 }, expected).points).toBe(4);
  });
});

describe('state validation', () => {
  it('rejects a fractional pass count', () => {
    // The state indexes a trace, so a half-pass addresses a comparison that never happened. `Number.isFinite`
    // accepts 2.5, which is why this check exists separately.
    expect(sim.grader.validateState({ passes: 1.5, comparisons: 10 })).toMatch(/fractional/);
  });

  it('rejects a negative count, because comparisons cannot be un-made', () => {
    expect(sim.grader.validateState({ passes: 0, comparisons: -1 })).toMatch(/negative/);
  });

  it('rejects a fractional comparison count', () => {
    expect(sim.grader.validateState({ passes: 1, comparisons: 8.5 })).toMatch(/whole-number/);
  });

  it('accepts the states this simulation actually produces', () => {
    for (const passes of [0, 1, 4, 9]) {
      const state = runTo(PARAMS, passes);
      expect(
        sim.grader.validateState({ passes: state.passes, comparisons: state.comparisons.length }),
      ).toBeNull();
    }
  });

  it('rejects a state that is not an object at all', () => {
    expect(sim.grader.validateState(null)).toMatch(/not an object/);
    expect(sim.grader.validateState('state')).toMatch(/not an object/);
  });
});

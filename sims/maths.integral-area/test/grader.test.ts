/**
 * The model and the grader, in bare Node.  (P12-T2, card 135 `maths.integral-area`)
 *
 * ## THE ASSERTION THAT MATTERS IS THE RATE OF CONVERGENCE
 *
 * A Riemann sum is easy to implement wrongly in a way that still produces a plausible number — an off-by-one
 * in the right endpoint, a width of 1 instead of (b−a)/n, a midpoint where a left endpoint was declared. Every
 * one of those returns something finite and close. What none of them can fake is the ORDER: doubling `n`
 * halves the error of the endpoint sums and quarters the error of the midpoint sum, so the rate is the
 * property under test and the values are only ever compared against `exactIntegral`.
 */

import { asNumber, gradeStoredState } from '@orrery/sim-sdk/grader';
import { describe, expect, it } from 'vitest';
import sim, { AREA_MARKS, MAX_POINTS, SUM_MARKS, TOLERANCE } from '../src/grader.js';
import {
  clamp,
  describeSums,
  exactIntegral,
  f,
  type IntegralParams,
  leftSum,
  MAX_RECTANGLES,
  midpointSum,
  normaliseNumber,
  rightSum,
  truncationError,
} from '../src/model.js';

const PARAMS: IntegralParams = { rectangles: 8 };
const EXACT = exactIntegral();

const grade = (
  answer: unknown,
  params: IntegralParams = PARAMS,
  state: unknown = { probe: true },
) => sim.grader.grade(state, params, answer);

const correct = () => ({ leftSum: leftSum(8), rightSum: rightSum(8), signedArea: EXACT });

describe('the model', () => {
  it('integrates the declared function in closed form, and it is NEGATIVE', () => {
    // ∫₀² (x² − 2) dx = 8/3 − 4 = −4/3. The curve is below the axis for most of the interval, so the
    // signed area subtracts it. An author who wanted a comfortable positive number has picked the wrong
    // integrand and misconception (1) survives.
    expect(EXACT).toBeCloseTo(-4 / 3, 12);
    expect(f(0)).toBe(-2);
    expect(f(Math.SQRT2)).toBeCloseTo(0, 12);
  });

  it('the endpoint sums BRACKET the exact value, in the right order', () => {
    for (const n of [2, 3, 4, 8, 16, 32, 64]) {
      const left = leftSum(n);
      const right = rightSum(n);
      expect(left, `n=${String(n)}`).toBeLessThan(EXACT);
      expect(right, `n=${String(n)}`).toBeGreaterThan(EXACT);
    }
  });

  it('the endpoint sums converge at FIRST order: doubling n HALVES the error', () => {
    // ASSERTED AS A RATE AND NOT AS `error(2n) === error(n)/2`, because first-order convergence is
    // ASYMPTOTIC: the ratio is 0.55 at n = 2 and 0.5013 at n = 64. A test demanding exactly one half would be
    // a test of the first correction term, and it would fail on a correct implementation.
    for (const n of [8, 16, 32]) {
      const ratio =
        Math.abs(truncationError(leftSum(n * 2))) / Math.abs(truncationError(leftSum(n)));
      expect(ratio, `n=${String(n)}`).toBeGreaterThan(0.49);
      expect(ratio, `n=${String(n)}`).toBeLessThan(0.52);
    }
  });

  it('the midpoint sum converges at SECOND order, which is what misconception (2) gets wrong', () => {
    // Midpoint on a quadratic is EXACT to third order, so the ratio is a quarter at every n here -- which is
    // why this assertion can be exact, and why the two rates are visibly different rather than both "faster".
    for (const n of [2, 4, 8, 16, 32]) {
      const ratio =
        Math.abs(truncationError(midpointSum(n * 2))) / Math.abs(truncationError(midpointSum(n)));
      expect(ratio, `n=${String(n)}`).toBeCloseTo(0.25, 10);
    }
  });

  it('reports the error as a DIFFERENCE, and survives a sum near zero', () => {
    // A percentage of the sum is not a quantity at n where the left sum crosses zero. The difference always is.
    expect(truncationError(leftSum(8))).toBeCloseTo(EXACT - leftSum(8), 12);
    const crossings = [2, 3, 4, 5, 6, 7, 8].filter((n) => Math.abs(leftSum(n)) < 0.5);
    for (const n of crossings) {
      expect(Number.isFinite(truncationError(leftSum(n))), `n=${String(n)}`).toBe(true);
    }
  });

  it('clamps the rectangle count, because a host can send anything', () => {
    expect(clamp({ rectangles: 0 }).rectangles).toBe(2);
    expect(clamp({ rectangles: 1000 }).rectangles).toBe(MAX_RECTANGLES);
    expect(clamp({ rectangles: Number.NaN }).rectangles).toBe(8);
  });

  it('describes the sums it is describing', () => {
    expect(describeSums(PARAMS)).toContain('-1.81');
    expect(describeSums(PARAMS)).toContain('-0.81');
    expect(describeSums(PARAMS)).toContain('-1.33');
  });
});

describe('the answer a student types', () => {
  it('accepts the TRUE MINUS SIGN, which `asNumber` would otherwise DELETE', () => {
    // `asNumber` strips everything outside [0-9.eE+-] (`grading.ts:155`), so U+2212 is removed rather than
    // translated and a correct −1.8125 arrives as 1.8125: a false wrong for a student who did nothing wrong.
    expect(normaliseNumber('−1.8125')).toBe('-1.8125');
    // THE HAZARD ITSELF, MEASURED: `asNumber` on the raw string loses the sign, so a correct negative sum
    // arrives positive. That is what the repair in the model is for.
    expect(asNumber('−1.8125')).toBe(1.8125);
    expect(asNumber('-1.8125')).toBe(-1.8125);
    // AND THE REPAIR, which is the only reason a correct answer is not a false wrong.
    expect(grade({ ...correct(), leftSum: '−1.8125' }).points).toBe(MAX_POINTS);
  });

  it('does NOT hide a genuinely different number', () => {
    // The unit trap the card names: `asNumber` turns `2x10^-3` into 210, and this function must not rescue it.
    expect(normaliseNumber('2x10^-3')).toBe('2x10^-3');
    expect(grade({ ...correct(), signedArea: '2x10^-3' }).points).toBeLessThan(MAX_POINTS);
  });
});

describe('the grader', () => {
  it('awards full marks for the sums the model produces', () => {
    const graded = grade(correct());
    expect(graded.points).toBe(MAX_POINTS);
    expect(graded.code).toBe('CORRECT');
  });

  it('accepts a rounded answer to the declared precision, which is what `abs` is FOR', () => {
    // 0.005 is the two decimal places the question asks for. Without it, a student who rounded to 2 dp --
    // exactly as instructed -- would lose every mark on an item that told them to.
    expect(grade({ leftSum: -1.81, rightSum: -0.81, signedArea: -1.33 }).points).toBe(MAX_POINTS);
  });

  it('says which bound binds, and the two are NOT interchangeable', () => {
    // `withinTolerance` takes the LARGER of `abs` and `rel x max(|given|,|expected|)` (`grading.ts:190`), so
    // a declared band is the WIDER of the two. Both are asserted at a magnitude where each is the one in
    // force, because a card that declares both and never says which binds has declared a band it cannot
    // account for.
    expect(TOLERANCE.abs).toBe(0.005);
    expect(TOLERANCE.rel).toBe(0.005);
    // rightSum is -0.8125, where `rel` alone gives 0.0041 and `abs` gives 0.005. A 0.0045 error is INSIDE
    // the band only because `abs` is the binding bound -- so this mark would be lost without it.
    expect(grade({ ...correct(), rightSum: rightSum(8) + 0.0045 }).points).toBe(MAX_POINTS);
    // leftSum is -1.8125, where `rel` gives 0.0091 and `abs` gives 0.005. A 0.008 error is INSIDE the band
    // only because `rel` is the binding bound -- so declaring `abs` alone would have narrowed the item.
    expect(grade({ ...correct(), leftSum: leftSum(8) - 0.008 }).points).toBe(MAX_POINTS);
    // AND AN ERROR OUTSIDE BOTH IS PARTIAL CREDIT, NOT A CLIFF.
    const beyond = grade({ ...correct(), leftSum: leftSum(8) - 0.02 });
    expect(beyond.points).toBeLessThan(MAX_POINTS);
    expect(beyond.points).toBeGreaterThan(MAX_POINTS - SUM_MARKS);
  });

  it('marks a positive signed area wrong, because misconception (1) is the point', () => {
    // |1.33 − (−1.333)| is 2.66, which is 200% of the expected value, so the mark is LOST rather than
    // reduced: the student has taken the magnitude of an area, which is the misconception, not a slip.
    const positive = grade({ ...correct(), signedArea: 1.33 });
    expect(positive.points).toBe(MAX_POINTS - AREA_MARKS);
    expect(positive.code).toBe('PARTIAL');
  });

  it('awards nothing for a blank answer, and says UNPARSEABLE when nothing could be read', () => {
    expect(grade(null).code).toBe('UNPARSEABLE');
    expect(grade({}).code).toBe('UNPARSEABLE');
    expect(grade({}).points).toBe(0);
  });

  it('is DETERMINISTIC: three runs, identical output', () => {
    const runs = [0, 1, 2].map(() => JSON.stringify(grade(correct())));
    expect(runs[1]).toBe(runs[0]);
    expect(runs[2]).toBe(runs[0]);
  });

  it('tolerates the determinism probe state and every legal rectangle count', () => {
    expect(() => grade(correct(), PARAMS, { probe: true })).not.toThrow();
    for (let n = 2; n <= 64; n += 1) {
      const params: IntegralParams = { rectangles: n };
      const graded = grade(
        { leftSum: leftSum(n), rightSum: rightSum(n), signedArea: EXACT },
        params,
      );
      expect(graded.points, `n=${String(n)}`).toBe(MAX_POINTS);
    }
  });

  it('REPLAYS: re-grading the stored state reproduces the stored mark', () => {
    const state = { rectangles: 16 };
    const submitted = { leftSum: leftSum(16), rightSum: rightSum(16), signedArea: EXACT };
    const once = sim.grader.grade(state, state, submitted);
    const twice = gradeStoredState(sim.grader, { state, params: state, answer: submitted });
    expect(twice.points).toBe(once.points);
    expect(twice.code).toBe(once.code);
  });

  it('`gradeStoredState` is what REFUSES a bad state', () => {
    const validator = sim.grader.validateState;
    if (validator === undefined) throw new Error('this simulation declares no validateState');
    expect(validator(PARAMS)).toBeNull();
    expect(validator({ rectangles: Number.NaN })).toMatch(/rectangles/u);
    expect(() =>
      gradeStoredState(sim.grader, {
        state: { rectangles: 'eight' },
        params: PARAMS,
        answer: correct(),
      }),
    ).toThrow(/STATE_INVALID/u);
  });
});

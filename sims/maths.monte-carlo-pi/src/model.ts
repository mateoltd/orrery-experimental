/**
 * The model. Pure, DOM-free, deterministic.  (P6-T11, gold sim 21)
 *
 * ## THE FIRST SIMULATION WHERE THE SEED IS LOAD-BEARING
 *
 * Nineteen simulations in, nothing depended on a random number generator, so `randomised: true` was asserted
 * by exactly one simulation and the suite's determinism cell had nothing to prove. This one makes the seed
 * the whole experiment.
 *
 * ## AND THAT MEANS THE SEED MUST BE IN THE STATE
 *
 * A Monte Carlo run of 4,000 points cannot be recomputed from a parameter, because it cannot be recomputed
 * at all — it is a SAMPLE, and the only record of which sample is the sequence of numbers that produced it.
 * So the seed goes in the state, and a restored attempt regenerates the identical cloud. Without that, a
 * student who saved at 4,000 points and came back to 1,000 would see a different experiment and a different
 * answer, and the checkpoint would be worthless.
 *
 * ## `Math.random()` IS NOT AVAILABLE AND IS NOT WANTED
 *
 * A simulation that calls `Math.random()` puts a different question in front of every student, breaks save
 * and restore, and makes its own tests impossible — while declaring `randomised: true` throughout, so nothing
 * anywhere reports the difference. Every draw here comes from `createRng(seed)`, which is reproducible for a
 * given seed and different for a different one.
 */

import { createRng, type Rng } from '@orrery/sim-sdk/grader';

export interface MonteParams {
  /** How many points to drop. A sample size, and the only knob that matters. */
  readonly samples: number;
  /** How many points have been dropped SO FAR, which is the state, not a parameter. */
  readonly dropped: number;
  readonly seed: string;
}

export const MIN_SAMPLES = 100;
export const MAX_SAMPLES = 20000;

export const clamp = (params: Partial<MonteParams>): MonteParams => {
  const bounded = (value: unknown, fallback: number, min: number, max: number): number => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, Math.round(parsed)));
  };
  return {
    samples: bounded(params.samples, 2000, MIN_SAMPLES, MAX_SAMPLES),
    dropped: bounded(params.dropped, 0, 0, MAX_SAMPLES),
    // THE SEED IS A STRING AND IS NEVER REPLACED BY A NUMBER. `createRng` hashes a string into its state, so
    // two students whose seeds are `"7"` and `"7.0"` get different questions -- which is correct, and means a
    // seed is an identity rather than a magnitude. Coercing one to a number would quietly merge them.
    seed:
      typeof params.seed === 'string' && params.seed.trim() !== ''
        ? params.seed.trim()
        : 'orrery-1',
  };
};

export interface Point {
  readonly x: number;
  readonly y: number;
  /** Whether the point landed inside the unit quarter-circle. */
  readonly inside: boolean;
}

/**
 * THE SAMPLE, REGENERATED FROM THE SEED EVERY TIME.
 *
 * Regenerated rather than accumulated, for the same reason the orrery's `positionAt` is a function of `t`:
 * an accumulator cannot be replayed, cannot be restored from a seed, and cannot be checked against a
 * hand-computed value. A function of `(seed, dropped)` can do all three, and it costs one loop over 20,000
 * points — which is nothing, and which means `getState` stays a pure getter.
 *
 * ## THE FIRST `n` POINTS OF A SEED ARE THE SAME WHATEVER `n` IS
 *
 * That is the property the whole simulation rests on, and it is a property of `createRng` being a proper
 * generator rather than a hash of its inputs. A student who drops 100 points, reopens the tab, and asks for
 * 4,000 must see their first 100 points in exactly the same places.
 */
export function sample(seed: string, dropped: number): readonly Point[] {
  const rng: Rng = createRng(seed);
  const points: Point[] = [];
  for (let index = 0; index < dropped; index += 1) {
    const x = rng.next();
    const y = rng.next();
    points.push({ x, y, inside: x * x + y * y <= 1 });
  }
  return points;
}

/** The estimate of pi: four times the fraction that landed inside the quarter-circle. */
export function estimatePi(points: readonly Point[]): number {
  if (points.length === 0) return 0;
  let inside = 0;
  for (const point of points) if (point.inside) inside += 1;
  return (4 * inside) / points.length;
}

export const countInside = (points: readonly Point[]): number =>
  points.reduce((total, point) => (point.inside ? total + 1 : total), 0);

/** True pi, to the precision a student could read off a display. */
export const PI = Math.PI;

/**
 * THE ERROR IN A SAMPLE ESTIMATE, AND IT IS ABOUT `1 / sqrt(n)` — NOT `1 / n`.
 *
 * ## THE FACTOR OF FOUR IS THE WHOLE POINT
 *
 * The student estimates `4p`, where `p` is the fraction inside. So `Var(4p_hat) = 16 p(1-p)/n`, and the
 * standard error is `4 * sqrt(p(1-p)/n)` — FOUR TIMES the standard error of `p` itself. An earlier draft
 * returned `3 / sqrt(n)`, which is a band on `p` and not on the answer, and was therefore four times too
 * tight: at 2,000 points it allowed 0.067 where the honest three-sigma band is 0.25. A grading tolerance that
 * rejects correct estimates is not strict, it is broken.
 *
 * ## WHY `1 / sqrt(n)` MATTERS MORE THAN THE NUMBERS
 *
 * Ten times the points is about three times the accuracy, not ten times. A student who doubles the sample
 * twice and finds the answer barely moved has learned the thing this simulation exists to teach, and a
 * tolerance that shrank linearly with `n` would hide it.
 *
 * `p(1-p)` is evaluated at the worst case, `p = 1/2`, where the variance is largest — so the band does not
 * shrink just because the student got lucky, which is the behaviour a grading tolerance needs.
 */
export function toleranceFor(samples: number): number {
  const n = Math.max(samples, 1);
  const WORST_CASE_VARIANCE = 0.25;
  const threeSigma = 3 * 4 * Math.sqrt(WORST_CASE_VARIANCE / n);
  // A floor for the smallest sample sizes, where the normal approximation to a binomial is poor enough that
  // the interval is too narrow in practice. At 100 points the three-sigma band is already 1.2, so the floor
  // only bites below about 40 — which `clamp` forbids. The floor is here so that a caller who bypasses
  // `clamp` still cannot produce a tolerance that rejects every estimate.
  return Math.max(threeSigma, 0.05);
}

export const round = (value: number): number => {
  const rounded = Math.round(value * 1e6) / 1e6;
  return Object.is(rounded, -0) ? 0 : rounded;
};

export function format(value: number): string {
  if (!Number.isFinite(value)) return 'undefined';
  return String(Number(value.toFixed(4)));
}

/** The convergence, as a student reads it off the panel: the estimate at each doubling of the sample. */
export function convergence(seed: string, samples: number): { n: number; estimate: number }[] {
  const points = sample(seed, samples);
  const series: { n: number; estimate: number }[] = [];
  for (let n = 100; n <= points.length; n *= 2) {
    series.push({ n, estimate: round(estimatePi(points.slice(0, n))) });
  }
  return series;
}

/**
 * THE QUESTION, and it does not contain the answer.
 *
 * It asks for the ESTIMATE, not for pi, because a student who types 3.14159 has not run an experiment and
 * the marker should be able to tell the difference.
 */
export function describeTask(params: MonteParams): string {
  return (
    `${String(params.dropped)} points have been dropped at random into the unit square, and ` +
    `${String(countInside(sample(params.seed, params.dropped)))} of them landed inside the quarter-circle. ` +
    `Work out an estimate of pi from that, and type it in the box.`
  );
}

/** FOR THE TEXT ALTERNATIVE. Counts, not the estimate — the estimate is what the student is being asked for. */
export function describeAlternative(params: MonteParams): string {
  const points = sample(params.seed, params.dropped);
  return (
    `A square one unit on each side contains a quarter-circle of radius one in its lower left corner. ` +
    `${String(points.length)} points have been dropped into the square at random, and ` +
    `${String(countInside(points))} of them landed inside the quarter-circle. The ratio of the areas of a ` +
    `circle and a square is pi, and the fraction of points that land inside is an estimate of that ratio. ` +
    `The task is to work out the estimate.`
  );
}

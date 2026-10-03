/**
 * The model and grader, in bare Node.  (P6-T11, gold sim 21)
 *
 * The property under test is the one the whole simulation rests on: **the same seed gives the same sample**,
 * and **the same sample gives the same estimate**. Everything else here is arithmetic the platform's own
 * tolerance tests already cover.
 */
import { describe, expect, it } from 'vitest';
import sim, { marksForSigmas } from '../src/grader.js';
import {
  clamp,
  convergence,
  countInside,
  describeAlternative,
  estimatePi,
  MAX_SAMPLES,
  PI,
  round,
  sample,
  toleranceFor,
} from '../src/model.js';

const SEED = '4242';
const P = clamp({ samples: 2000, dropped: 2000, seed: SEED });
const grade = (answer: unknown, params = P) => sim.grader.grade(null, params, answer);

describe('the SEED reproduces, which is the entire point', () => {
  // Without this the determinism cell has nothing to check, and `randomised: true` is a comment.
  it('THE SAME SEED GIVES THE SAME SAMPLE, twice', () => {
    expect(sample(SEED, 500)).toEqual(sample(SEED, 500));
  });

  it('AND GIVES THE SAME ESTIMATE, twice', () => {
    expect(estimatePi(sample(SEED, 2000))).toBe(estimatePi(sample(SEED, 2000)));
  });

  it('DIFFERENT SEEDS GIVE DIFFERENT SAMPLES', () => {
    // A seeded simulation whose output did not depend on its seed could be broken and still reproduce, so
    // this is the test that makes the previous two mean something.
    expect(sample('4242', 500)).not.toEqual(sample('4243', 500));
    expect(estimatePi(sample('4242', 2000))).not.toBe(estimatePi(sample('4243', 2000)));
  });

  it('THE FIRST n POINTS ARE THE SAME WHATEVER n IS, so "throw more" EXTENDS the cloud', () => {
    // This is what makes the button mean anything. If raising `dropped` re-rolled the sample, the old dots
    // would move and the estimate would jump around for no reason.
    const many = sample(SEED, 800);
    const few = sample(SEED, 200);
    expect(many.slice(0, 200)).toEqual(few);
  });

  it('A SEED IS AN IDENTITY, NOT A MAGNITUDE', () => {
    // `createRng` hashes a string, so "7" and "7.0" are different seeds. That is correct -- two students who
    // typed the same-looking thing should not be forced into the same experiment -- and it is why the seed
    // must never be normalised on the way through the simulation.
    expect(sample('7', 100)).not.toEqual(sample('7.0', 100));
  });

  it('REFUSES A STATE WITH NO SEED, because a checkpoint that cannot regenerate its sample is nothing', () => {
    expect(sim.grader.validateState({ dropped: 2000, seed: SEED })).toBeNull();
    expect(sim.grader.validateState({ dropped: 2000 })).toMatch(/no seed/u);
    expect(sim.grader.validateState({ dropped: -1, seed: SEED })).toMatch(/negative/u);
  });
});

describe('the BAND follows the sample size, and that is the lesson', () => {
  // Ten times the points is about three times the accuracy, NOT ten times. A fixed band would teach the
  // opposite, which is the misconception Monte Carlo exists to correct.
  it('SHRINKS AS 1 OVER THE SQUARE ROOT OF n', () => {
    const at = (n: number): number => toleranceFor(n);
    // 100 -> 2000 is twenty times the points, so the band should fall by about sqrt(20) ~ 4.5.
    expect(at(100) / at(2000)).toBeGreaterThan(4);
    expect(at(100) / at(2000)).toBeLessThan(5);
  });

  it('IS AT LEAST THREE SIGMAS, so a correct answer is not rejected for an unlucky seed', () => {
    // The band has to cover the ~99% of honest runs, or a student is marked wrong for their luck.
    // 3 * 4 * sqrt(0.25 / 2000) = 0.13416..., and asserting against a hand-rounded 0.134 was asking the
    // test to fail on the fourth decimal. The RELATIONSHIP is what matters.
    const threeSigma = 3 * 4 * Math.sqrt(0.25 / 2000);
    expect(toleranceFor(2000)).toBeGreaterThanOrEqual(threeSigma);
    expect(toleranceFor(2000)).toBeLessThanOrEqual(threeSigma);
  });

  it('THE BAND IS FACTUALLY FOUR TIMES THE ONE FOR p, because the answer is 4p', () => {
    // Var(4p) = 16 Var(p). A band computed on p and applied to 4p is four times too tight, and rejects
    // correct estimates. The first draft did exactly this.
    const threeSigmaOnP = 3 * Math.sqrt(0.25 / 2000);
    expect(toleranceFor(2000)).toBeCloseTo(4 * threeSigmaOnP, 4);
  });

  it('NEVER GOES BELOW A FLOOR, so a caller bypassing `clamp` cannot get an impossible band', () => {
    expect(toleranceFor(1)).toBeGreaterThanOrEqual(0.05);
    expect(toleranceFor(0)).toBeGreaterThanOrEqual(0.05);
    expect(toleranceFor(-100)).toBeGreaterThanOrEqual(0.05);
  });

  it('THE MARKS ARE A FUNCTION OF SIGMAS, AND REACH ZERO', () => {
    expect(marksForSigmas(0)).toBe(4);
    expect(marksForSigmas(1)).toBe(4);
    expect(marksForSigmas(1.5)).toBe(2);
    expect(marksForSigmas(3)).toBe(0);
    expect(marksForSigmas(100)).toBe(0);
    // A NaN or infinite sigma is infinitely many bands out, not zero -- and the marks reach zero rather than
    // falling through to `undefined`. `Math.min(4, NaN)` is NaN, so an unguarded version would have returned
    // NaN points to the host and rendered as nothing at all.
    expect(marksForSigmas(Number.NaN)).toBe(0);
    expect(marksForSigmas(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('the estimate converges on pi', () => {
  it('AND IS CLOSE AT THE DEFAULT SAMPLE SIZE', () => {
    expect(Math.abs(estimatePi(sample(SEED, 2000)) - PI)).toBeLessThan(toleranceFor(2000));
  });

  it('AND IMPROVES AS THE SAMPLE GROWS', () => {
    const errors = [100, 400, 1600, 6400].map((n) => Math.abs(estimatePi(sample(SEED, n)) - PI));
    // Not strictly monotonic -- a random estimate can get worse -- but the LARGEST sample is the best.
    expect(Math.abs(estimatePi(sample(SEED, 6400)) - PI)).toBeLessThan(
      Math.abs(estimatePi(sample(SEED, 100)) - PI),
    );
    expect(errors.every((error) => Number.isFinite(error))).toBe(true);
  });

  it('AND THE CONVERGENCE SERIES IS THE ESTIMATE AT EACH DOUBLING', () => {
    const series = convergence(SEED, 1600);
    expect(series.map((row) => row.n)).toEqual([100, 200, 400, 800, 1600]);
    expect(series[0]?.estimate).toBe(estimatePi(sample(SEED, 100)));
    expect(series[4]?.estimate).toBe(estimatePi(sample(SEED, 1600)));
  });
});

describe('grading', () => {
  it('AWARDS FULL MARKS FOR AN ESTIMATE INSIDE THE BAND', () => {
    // A rounded pi, not pi itself: a student reading a grid types 3.14, and that must earn full marks
    // against a band of 0.134 at 2,000 points. Written as an OFFSET from PI so the test states the
    // relationship it is checking rather than a number typed in by hand.
    const rounded = round(PI * 100) / 100;
    expect(grade(rounded).points).toBe(4);
    expect(grade(rounded).code).toBe('CORRECT');
  });

  it('AWARDS NOTHING FOR A NUMBER FROM MEMORY THAT HAPPENS TO BE FAR OFF', () => {
    // Deliberately far from pi, expressed as offsets so the test is about DISTANCE not about typed literals.
    expect(grade(PI - 0.64).points).toBe(0);
    expect(grade(PI + 0.76).points).toBe(0);
  });

  it('THE FEEDBACK SHOWS THE PROPORTION, so the student can see WHICH step went wrong', () => {
    // "You should have got 3.14" teaches nothing; the proportion IS the calculation they were asked to do.
    expect(grade(PI - 0.6).feedback).toMatch(/landed inside/u);
    expect(grade(PI - 0.6).feedback).toMatch(/four times that is/u);
  });

  it('DISTINGUISHES NOTHING-DRAWN from A-BAD-ESTIMATE', () => {
    // With no points drawn, any number came from memory rather than from the experiment. That is a different
    // mistake from estimating badly, and the two need different advice.
    expect(grade(PI, clamp({ samples: 100, dropped: 0, seed: SEED })).code).toBe('NOTHING_DRAWN');
    expect(grade(PI).code).toBe('CORRECT');
  });

  it('DISTINGUISHES EMPTY from UNREADABLE', () => {
    expect(grade(null).code).toBe('MISSING');
    expect(grade('').code).toBe('MISSING');
    expect(grade('about three point one').code).toBe('UNPARSEABLE');
  });
});

describe('the parameters are bounded and the sample is well formed', () => {
  it('CLAMPS THE SAMPLE SIZE TO THE RANGE THE MANIFEST DECLARES', () => {
    expect(clamp({ samples: 999999 }).samples).toBe(MAX_SAMPLES);
    expect(clamp({ samples: 1 }).samples).toBe(100);
    expect(clamp({ samples: Number.NaN }).samples).toBe(2000);
  });

  it('EVERY POINT IS INSIDE THE UNIT SQUARE', () => {
    // A point outside the square would be counted neither inside nor out, and the proportion would be wrong
    // in a way no test of the estimate alone would catch.
    for (const point of sample(SEED, 500)) {
      expect(point.x).toBeGreaterThanOrEqual(0);
      expect(point.x).toBeLessThanOrEqual(1);
      expect(point.y).toBeGreaterThanOrEqual(0);
      expect(point.y).toBeLessThanOrEqual(1);
    }
  });

  it('THE `inside` FLAG MATCHS THE CIRCLE, recomputed independently', () => {
    // `inside` is what the drawing, the grader and the student all rely on. Checking it against the same
    // formula it was built from would be circular, so this recomputes it from x and y.
    for (const point of sample(SEED, 500)) {
      expect(point.inside).toBe(point.x * point.x + point.y * point.y <= 1);
    }
  });

  it('THE PROPORTION INSIDE IS NEARLY A QUARTER, which is what makes the estimate pi', () => {
    // The AREA FRACTION is pi/4 = 0.7854, and the SAMPLING standard deviation of the proportion is about
    // 0.0093 at 2,000 points. So 0.804 is roughly two sigma -- a normal fluctuation, not a bug. The first
    // bound was `< 0.8`, which rejected the second worst sample in twenty -- i.e. it rejected correct answers
    // one time in fifty, which is exactly the failure this suite exists to prevent.
    const proportion = countInside(sample(SEED, 2000)) / 2000;
    expect(proportion).toBeGreaterThan(PI / 4 - 0.05);
    expect(proportion).toBeLessThan(PI / 4 + 0.05);
  });
});

describe('the text alternative gives the COUNTS and not the estimate', () => {
  it('which is the difference between a description and the answer', () => {
    const text = describeAlternative(P);
    expect(text).toMatch(/inside the quarter-circle/u);
    // It must not state pi, or an estimate of it, in the one place a screen-reader user is told to look.
    expect(text).not.toMatch(/3\.14/u);
    expect(text).not.toContain('estimate of pi is');
  });
});

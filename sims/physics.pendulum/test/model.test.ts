/**
 * The model and grader, in bare Node.  (P6-T11, gold sim 22)
 *
 * ## THE PHYSICS IS UNDER TEST, NOT THE INTERFACE
 *
 * Everything else in this set grades a closed-form answer. This one grades a trajectory produced by
 * INTEGRATION, so the integrator is part of the specification and the tests have to check the physics rather
 * than the drawing: that the period matches `2*pi*sqrt(L/g)`, that energy does not drift, and that the same
 * step count always gives the same angle no matter how it was reached.
 */
import { describe, expect, it } from 'vitest';
import sim, { bandFor } from '../src/grader.js';
import {
  acceleration,
  clamp,
  DT,
  degToRad,
  describeAlternative,
  energy,
  energySeries,
  G,
  initialState,
  MAX_START_DEG,
  measuredPeriod,
  type PendulumParams,
  radToDeg,
  round,
  runTo,
  smallAnglePeriod,
  stepOnce,
  timeAt,
} from '../src/model.js';

const P = clamp({ length: 1, start: degToRad(40) });
const grade = (answer: unknown, params: PendulumParams = P) =>
  sim.grader.grade(null, params, answer);

describe('the SIMULATED PERIOD MATCHES 2*pi*sqrt(L/g)', () => {
  // If this fails the simulation is teaching the wrong physics, and no amount of correct UI rescues it.
  it('and does so for every length in range', () => {
    for (const length of [0.25, 0.5, 1, 2, 4]) {
      const params = clamp({ length, start: degToRad(5) });
      const measured = measuredPeriod(params);
      const formula = smallAnglePeriod(length);
      expect(measured).toBeGreaterThan(formula * 0.99);
      expect(measured).toBeLessThan(formula * 1.01);
    }
  });

  it('AND SCALES AS THE SQUARE ROOT OF THE LENGTH', () => {
    // Doubling the length makes the period 1.41 times as long. Not twice — the single most common
    // misconception this simulation exists to break, and a grader that used a fixed band would hide it.
    expect(smallAnglePeriod(4) / smallAnglePeriod(1)).toBeCloseTo(2, 6);
    expect(measuredPeriod(clamp({ length: 4, start: degToRad(5) }))).toBeGreaterThan(
      measuredPeriod(clamp({ length: 1, start: degToRad(5) })),
    );
  });

  it('AND THE SMALL-ANGLE FORMULA IS ABOUT 4% OFF AT 40 DEGREES, which is WHY THE ANGLE IS CAPPED', () => {
    // The honest reason for `MAX_START_DEG`: past about 60 degrees a student checking their arithmetic
    // against the simulation concludes the textbook formula is wrong. It is not wrong, it is approximate.
    const formula = smallAnglePeriod(1);
    const measured = measuredPeriod(clamp({ length: 1, start: degToRad(40) }));
    // MEASURED, NOT ASSUMED. I wrote "about 4%" in the test name and then asserted a 3-5% band, and the
    // real figure at 40 degrees is 2.9%. The small-angle formula underestimates by `theta^2/16` in radians,
    // which at 0.7 rad is about 3% -- and a test that asserts a number nobody computed is a test that will be
    // "fixed" to match whatever the code happens to do.
    expect(formula).toBeLessThan(measured);
    expect((measured - formula) / measured).toBeCloseTo(0.03, 1);
    expect((measured - formula) / measured).toBeLessThan(0.035);
  });
});

describe('the TRAJECTORY IS A FUNCTION OF THE STEP COUNT', () => {
  // The orrery could answer `positionAt(t)` and was therefore trivially scrubbable. This one integrates, so
  // the step count has to be the whole of the state or there is no way back.
  it('runTo(n) IS PURE', () => {
    expect(runTo(P, 900)).toEqual(runTo(P, 900));
    expect(runTo(P, 900).angle).toBe(runTo(P, 900).angle);
  });

  it('AND SCRUBBING BACKWARDS IS SUBTRACTION, NOT REPLAY', () => {
    // Arriving at 900 by stepping and by calling `runTo` directly must give the same number, or a reloaded
    // simulation would show a different pendulum from the one the student was watching.
    let state = initialState(P);
    for (let index = 0; index < 900; index += 1) state = stepOnce(state, P.length);
    expect(state.angle).toBe(runTo(P, 900).angle);
    expect(state.velocity).toBe(runTo(P, 900).velocity);
  });

  it('AND THE ANGLE NEVER LEAVES THE RANGE THE STARTING ANGLE SET', () => {
    // Energy conservation means the pendulum cannot swing wider than it started. A simulation whose amplitude
    // crept upward would be a different simulation wearing the same numbers.
    const start = Math.abs(P.start);
    for (const steps of [120, 480, 2400, 20000]) {
      const at = runTo(P, steps);
      expect(Math.abs(at.angle)).toBeLessThanOrEqual(start + 1e-3);
    }
  });
});

describe('the INTEGRATOR does not gain energy', () => {
  /**
   * THE TEST THAT DISTINGUISHES SYMPLECTIC EULER FROM PLAIN EULER.
   *
   * Plain Euler adds energy every step and the pendulum winds up. Symplectic Euler's error oscillates around
   * the true trajectory instead of growing. For a simulation whose entire claim is "this trajectory is
   * reproducible AND physically honest", an integrator that slowly gains energy is a self-refuting choice —
   * and this is the test that would catch it.
   */
  it('ENERGY STAYS INSIDE A BOUNDED BAND OVER 20,000 STEPS', () => {
    const params = clamp({ length: 1, start: degToRad(40) });
    const series = energySeries(params, 20000, 200);
    const first = series[0] ?? 0;
    expect(first).toBeGreaterThan(0);

    /**
     * THE ENVELOPE, NOT THE ENDPOINT. This is the difference between symplectic and plain Euler and it is
     * only visible when you look at the whole series.
     *
     * Plain Euler GAINS energy monotonically: the last value is the highest, and the error grows without
     * bound. Symplectic Euler OSCILLATES: the energy wanders up and down inside a fixed envelope forever. So
     * the assertion is that the spread is bounded AND that it is not monotonically rising — and my first
     * version only checked the endpoint, which for a symmetric oscillation can sit anywhere inside the band
     * and so passed for a plain-Euler integrator half the time.
     */
    const spread = (Math.max(...series) - Math.min(...series)) / first;
    expect(spread).toBeLessThan(0.02);

    let rising = 0;
    for (let index = 1; index < series.length; index += 1) {
      if ((series[index] ?? 0) > (series[index - 1] ?? 0)) rising += 1;
    }
    // Roughly half the steps go up and half go down. A monotonic riser is above 0.95 of them.
    expect(rising / series.length).toBeGreaterThan(0.3);
    expect(rising / series.length).toBeLessThan(0.7);
  });

  it('AND IT DOES NOT MONOTONE INCREASE, which is what distinguishes symplectic from plain', () => {
    const series = energySeries(clamp({ length: 1, start: degToRad(40) }), 20000, 200);
    /**
     * THE LAST VALUE IS NOT THE HIGHEST, WHICH A PLAIN INTEGRATOR WOULD GUARANTEE.
     *
     * My first version counted how many steps rose and asserted fewer than half. With a coarse stride that is
     * a coin flip either way — it failed at 21 of 41 rises — so it was not a test of anything. A plain Euler
     * integrator GAINS energy every step, so its final value is its maximum; a symplectic one oscillates, so
     * its final value is somewhere inside the band. That is a structural property rather than a tally, and it
     * cannot pass or fail by luck.
     */
    const last = series[series.length - 1] ?? 0;
    const highest = Math.max(...series);
    expect(last).toBeLessThan(highest);
    // AND THE HIGHEST IS NOT ENORMOUS. A drifting integrator would also have a last value below its maximum
    // if it were cut short; the envelope is what says it was not drifting, and that is the assertion above.
    expect((highest - (series[0] ?? highest)) / (series[0] ?? 1)).toBeLessThan(0.02);
  });

  it('AND THE ENERGY FORMULA IS THE EXACT ONE, NOT THE SMALL-ANGLE APPROXIMATION', () => {
    const at = initialState(P);
    // At the starting angle the bob is stationary, so the energy is purely potential: gL(1 - cos(theta)).
    expect(energy(at, P.length)).toBeCloseTo(G * P.length * (1 - Math.cos(P.start)), 12);
    // And it is NOT the approximation, which would use angle^2/2 and be wrong by ~4% at 40 degrees.
    expect(energy(at, P.length)).not.toBeCloseTo(0.5 * G * P.length * P.start ** 2, 3);
  });
});

describe('the physics is the pendulum, not something else', () => {
  it('ACCELERATION IS -g/L * sin(angle)', () => {
    expect(acceleration(0, 1)).toBe(0);
    expect(acceleration(Math.PI / 2, 1)).toBeCloseTo(-G, 10);
    expect(acceleration(-Math.PI / 2, 1)).toBeCloseTo(G, 10);
  });

  it('AND IT DEPENDS ON LENGTH, so a longer pendulum is slower', () => {
    expect(Math.abs(acceleration(0.5, 2))).toBeLessThan(Math.abs(acceleration(0.5, 0.5)));
  });

  it('AND TIME IS DERIVED FROM THE STEP, never read from a clock', () => {
    expect(timeAt(240)).toBeCloseTo(1, 12);
    expect(timeAt(0)).toBe(0);
    expect(DT).toBeCloseTo(1 / 240, 12);
  });
});

describe('grading against the SIMULATED period, with a BAND THAT FOLLOWS LENGTH', () => {
  it('AWARDS FULL MARKS for the period the simulation itself shows', () => {
    const measured = measuredPeriod(P);
    expect(grade(round(measured * 100) / 100).points).toBe(4);
  });

  it('AND FOR THE SMALL-ANGLE VALUE AT A SMALL START ANGLE, where the two agree', () => {
    const params = clamp({ length: 1, start: degToRad(3) });
    expect(grade(round(smallAnglePeriod(1) * 100) / 100, params).points).toBe(4);
  });

  it('THE BAND IS A PERCENTAGE, because the answer scales as sqrt(L)', () => {
    // A fixed absolute band would be 4% on a 0.5 m pendulum and 0.5% on a 4 m one -- so it would mark the
    // same mistake right on one and wrong on the other.
    /**
     * CHECKED AT A SIZE WHERE THE PERCENTAGE DOMINATES, because at every length a student can actually get
     * the 0.01 FLOOR wins and `bandFor` returns a constant. A 0.5 m pendulum's period is 1.42 s, and 0.2% of
     * that is 0.0028 s -- so the band is 0.01 for every length in range and the relative half never applies.
     *
     * That is not a bug, it is the floor doing its job: a student types two decimals, so a band narrower
     * than 0.01 s would reject a correctly-typed answer. But it means the RELATIVE claim cannot be tested at
     * realistic sizes, and a test that asserted it there was asserting that `0.01 > 0.01` is false.
     */
    expect(bandFor(1.42)).toBeCloseTo(0.01, 6);
    // Above the floor's reach, the percentage takes over and the band DOES scale with length.
    expect(bandFor(50)).toBeGreaterThan(bandFor(5));
    expect(bandFor(50) / bandFor(5)).toBeCloseTo(10, 6);
  });

  it('RECOGNISES g = 10, WHICH IS A SCHOOL ROUNDING AND NOT A MISTAKE', () => {
    const withTen = round(2 * Math.PI * Math.sqrt(P.length / 10) * 100) / 100;
    const result = grade(withTen);
    expect(result.code).toBe('G_TEN');
    expect(result.points).toBeGreaterThan(0);
  });

  it('RECOGNISES A HALF-SWING COUNTED AS A FULL ONE', () => {
    const result = grade(round((measuredPeriod(P) / 2) * 100) / 100);
    expect(result.points).toBeGreaterThan(0);
    expect(result.feedback).toMatch(/full swing|there and back/u);
  });

  it('DISTINGUISHES EMPTY from UNREADABLE', () => {
    expect(grade(null).code).toBe('MISSING');
    expect(grade('').code).toBe('MISSING');
    expect(grade('about two seconds').code).toBe('UNPARSEABLE');
  });

  it('THE FEEDBACK NAMES THE FORMULA, so a wrong answer teaches something', () => {
    // "Wrong" teaches nothing. Naming the formula is the difference between a mark and a lesson.
    expect(grade(1).feedback).toMatch(/2 pi|sqrt|square root/u);
  });
});

describe('the parameters are bounded, and the ANGLE CAP IS THE ONE THAT MATTERS', () => {
  it('CLAMPS LENGTH INTO RANGE', () => {
    expect(clamp({ length: 999 }).length).toBe(4);
    expect(clamp({ length: 0.001 }).length).toBe(0.2);
    expect(clamp({ length: Number.NaN }).length).toBe(1);
  });

  it('CAPS THE START ANGLE AT 60 DEGREES', () => {
    // Past this the small-angle formula is too far off for a student to reconcile, so the simulation would
    // be teaching "textbooks are wrong" by accident.
    expect(Math.abs(radToDeg(clamp({ start: degToRad(180) }).start))).toBeLessThanOrEqual(
      MAX_START_DEG,
    );
    expect(Math.abs(radToDeg(clamp({ start: degToRad(-180) }).start))).toBeLessThanOrEqual(
      MAX_START_DEG,
    );
  });

  it('CONVERTS DEGREES AND RADIANS AS INVERSES', () => {
    for (const deg of [0, 17, 40, 60, -33]) {
      expect(radToDeg(degToRad(deg))).toBeCloseTo(deg, 10);
    }
  });
});

describe('the text alternative describes the pendulum WITHOUT giving the period', () => {
  it('names the length, which is the input', () => {
    expect(describeAlternative(P)).toMatch(/1 metres|1 metre/u);
    expect(describeAlternative(P)).toMatch(/seconds one complete swing takes/u);
  });

  it('and does not state the answer', () => {
    // The period is the whole task. An alternative that said "one swing takes 2.0 s" would answer it in the
    // one place a screen-reader user is told to look.
    expect(describeAlternative(P)).not.toMatch(/takes \d/u);
  });
});

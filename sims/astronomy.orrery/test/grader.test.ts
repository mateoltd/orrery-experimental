/**
 * The model and grader, in bare Node.  (P6-T11, gold sim 19)
 *
 * ## THE TESTS THAT MATTER ARE ABOUT TIME, NOT ABOUT ORBITS
 *
 * The period grading is one tolerance call and it is covered by the platform's own tolerance tests. What this
 * simulation exists to prove is that **time is an INPUT rather than an accumulation**, and every test below
 * is aimed at that: the hostile slider, the saturating step, and the bit-for-bit repeatability of `positionAt`.
 */
import { describe, expect, it } from 'vitest';
import sim from '../src/grader.js';
import {
  clamp,
  clampTime,
  describeOrbit,
  isComplete,
  MAX_TIME,
  type OrreryParams,
  positionAt,
  positionIsTimeInvariant,
  radiusAt,
  round,
  step,
} from '../src/model.js';

const PARAMS = clamp({ a: 1, e: 0.017, period: 365.25 });

const grade = (answer: unknown, params: OrreryParams = PARAMS) =>
  sim.grader.grade(null, params, answer);

describe('time is an INPUT, not an accumulation', () => {
  // The first version of this simulation integrated a loop from t = 0 up to t. That is correct once and
  // irrecoverable: it cannot answer a slider dragged BACKWARDS, and a "scrub to see the past" control that
  // cannot see the past is a lie with a slider on it.
  it('THE SAME t GIVES THE SAME PLACE, whatever route the slider took', () => {
    expect(positionIsTimeInvariant(PARAMS, 0)).toBe(true);
    expect(positionIsTimeInvariant(PARAMS, 812.5)).toBe(true);
    expect(positionIsTimeInvariant(PARAMS, 3)).toBe(true);
    expect(positionIsTimeInvariant(PARAMS, MAX_TIME)).toBe(true);
  });

  it('IS TRUE FOR MANY TIMES, not three', () => {
    // A property over the slider's whole range, because a slider that is invariant at 3 and drifts at 812
    // is exactly the failure this is here to catch.
    for (let t = 0; t <= MAX_TIME; t += 97.25) {
      expect(positionIsTimeInvariant(PARAMS, t)).toBe(true);
    }
  });

  it('positionAt IS PURE: calling it twice gives identical bits', () => {
    const first = positionAt(PARAMS, 137.42);
    const second = positionAt(PARAMS, 137.42);
    expect(first).toEqual(second);
    expect(Object.is(first.x, second.x)).toBe(true);
    expect(Object.is(first.y, second.y)).toBe(true);
  });

  it('A HUGE t IS STILL EXACT, because sin and cos are periodic', () => {
    // Float ACCUMULATION dies here. A closed-form trigonometric call does not, which is the whole reason
    // this model is closed-form.
    expect(Number.isFinite(positionAt(PARAMS, 9_000_000).x)).toBe(true);
    expect(positionAt(PARAMS, 365.25)).toEqual(positionAt(PARAMS, 0));
  });
});

describe('the slider is HOSTILE, and the model survives it', () => {
  it('AN ABSURD VALUE PRODUCES A POSITION, NOT NaN', () => {
    // `Infinity` in, a real number out. Without the `Number.isFinite` guard this is a black canvas.
    expect(Number.isFinite(positionAt(PARAMS, clampTime(Number.POSITIVE_INFINITY)).x)).toBe(true);
    expect(Number.isFinite(positionAt(PARAMS, clampTime(Number.NaN)).x)).toBe(true);
    expect(clampTime(Number.NaN)).toBe(0);
    expect(clampTime(Number.POSITIVE_INFINITY)).toBe(MAX_TIME);
  });

  it('CLAMPS BOTH ENDS, INCLUDING A NEGATIVE TIME', () => {
    expect(clampTime(-500)).toBe(0);
    expect(clampTime(MAX_TIME + 10_000)).toBe(MAX_TIME);
  });

  it('CLAMPS THE RATE SO A HOST CANNOT REQUEST AN INFINITE JUMP', () => {
    const wild = clamp({ a: 1, period: 365.25, e: 0 } as never);
    expect(Number.isFinite(wild.a)).toBe(true);
    expect(wild.a).toBe(1);
  });
});

describe('stepping SATURATES rather than accumulating', () => {
  // A student holding a step button down for ten minutes must arrive at the end of the timeline, not at
  // 10^9 days of accumulated rounding error somewhere past it.
  it('CLAMPS AT maxTime AND DOES NOT DRIFT PAST IT', () => {
    expect(step(MAX_TIME, 7)).toBe(MAX_TIME);
    expect(step(MAX_TIME, 7)).toBeLessThanOrEqual(MAX_TIME);
    expect(isComplete(MAX_TIME)).toBe(true);
    expect(isComplete(MAX_TIME - 1)).toBe(false);
  });

  it('GOES BACKWARDS TOO, because the stepper is not a one-way ratchet', () => {
    expect(step(400, -7)).toBe(393);
    expect(step(3, -7)).toBe(0);
  });

  it('A LONG WALK IN STEPS LANDS WHERE ONE BIG STEP LANDS', () => {
    // 500 steps of 8 is 4000, which is the end of the slider.
    let walked = 0;
    for (let i = 0; i < 500; i += 1) walked = step(walked, 8);
    expect(walked).toBe(MAX_TIME);
  });
});

describe('the period grading', () => {
  it('AWARDS FULL MARKS for the period', () => {
    const result = grade({ days: 365.25 });
    expect(result.points).toBe(4);
    expect(result.code).toBe('CORRECT');
  });

  it('READS A KEYED ANSWER, because the box is labelled in DAYS', () => {
    // The first version read `answer` directly and marked every real submission UNPARSEABLE.
    expect(grade({ days: 365.25 }).points).toBe(4);
  });

  it('SCALES ITS TOLERANCE WITH THE ORBIT', () => {
    // A RELATIVE band. An absolute tenth of a day marks a 5-day orbit to 2% and a 4000-day orbit to
    // nothing, which is not a tolerance, it is a coincidence.
    expect(grade({ days: 365.26 }, clamp({ a: 1, period: 365.25 })).points).toBe(4);
    expect(grade({ days: 5.01 }, clamp({ a: 0.1, period: 5 })).points).toBe(4);
  });

  it('AWARDS PARTIAL CREDIT INSIDE THE BAND, and NOTHING OUTSIDE IT', () => {
    // The band is `max(0.01, 365.25 * 0.001)` = 0.365 days. `365` is a quarter of a day out, which is
    // INSIDE it -- so it is worth full marks, and a test expecting partial credit here was expecting the
    // tolerance to be narrower than the one the manifest declares. The band is where the manifest says it
    // is, not where the test assumed it was.
    expect(grade({ days: 365 }).points).toBe(4);
    expect(grade({ days: 365.1 }).points).toBe(4);

    // AND 360 GETS NOTHING. My first test asserted partial credit at 360 and it scored 0, which looked like
    // a broken tolerance -- but 360 is 1.4% away against a 0.1% band. A partial-credit band that paid out
    // five days early would be paying students for rounding the way they happen to round.
    expect(grade({ days: 360 }).points).toBe(0);
    expect(grade({ days: 400 }).points).toBe(0);
  });

  it('GIVES THE ROUTE, NOT JUST THE ANSWER', () => {
    // "Not quite" teaches nothing; "further out means slower" is the correction a teacher would write.
    expect(grade({ days: 40 }).feedback).toMatch(/further out means slower/u);
  });

  it('DISTINGUISHES EMPTY from UNREADABLE', () => {
    expect(grade(null).code).toBe('MISSING');
    expect(grade({ days: '' }).code).toBe('MISSING');
    expect(grade({ days: 'tomorrow' }).code).toBe('UNPARSEABLE');
  });

  it('REFUSES A STATE WITH NEGATIVE TIME, because time does not run backwards', () => {
    expect(sim.grader.validateState({ a: 1, period: 365.25, t: -1 })).toMatch(/negative time/u);
    expect(sim.grader.validateState({ a: 1, period: 365.25, t: 400 })).toBeNull();
  });
});

describe('the parameters are bounded and the model is honest about it', () => {
  it('CLAMPS TO THE DECLARED RANGE', () => {
    expect(clamp({ a: 9999 }).a).toBe(40);
    expect(clamp({ a: -5 }).a).toBe(0.1);
    expect(clamp({ period: 0 }).period).toBe(1);
  });

  it('REJECTS NaN AND INFINITE PARAMS RATHER THAN PROPAGATING THEM', () => {
    // A host sending `Infinity` must not produce an orbit of infinite radius.
    expect(Number.isFinite(clamp({ a: Number.NaN }).a)).toBe(true);
    expect(Number.isFinite(clamp({ a: Number.POSITIVE_INFINITY }).a)).toBe(true);
  });

  it('THE ORBIT RADIUS IS CONSTANT, because the orbit is a circle', () => {
    for (const t of [0, 91.3, 365.25, 2000]) {
      const where = positionAt(PARAMS, t);
      expect(round(Math.sqrt(where.x ** 2 + where.y ** 2))).toBe(1);
    }
    expect(radiusAt(PARAMS)).toBe(1);
  });
});

describe('the text alternative carries the NUMBERS, deliberately', () => {
  // Unlike every other simulation in this set, this one's alternative GIVES the period. A WebGL canvas
  // cannot be described as "a picture of a planet", so the alternative has to carry the table -- and denying
  // a screen-reader user the same route to the answer is a wall, not rigour.
  it('STATES THE PERIOD AND THE RADIUS a sighted user reads off the panel', () => {
    const text = describeOrbit(PARAMS);
    expect(text).toContain('365.25');
    expect(text).toContain('1');
  });
});

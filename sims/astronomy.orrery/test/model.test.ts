/**
 * The model, in bare Node.  (P6-T11, gold sim 19)
 *
 * The property that matters here is not "does it draw a planet" but "does the same day always give the same
 * place, whatever route the slider took to get there". A simulation that integrates time cannot answer that,
 * and a slider that cannot be dragged backwards is a control that lies about what it is.
 */
import { describe, expect, it } from 'vitest';
import {
  clampTime,
  describeOrbit,
  isComplete,
  MAX_TIME,
  positionAt,
  positionIsTimeInvariant,
  radiusAt,
  round,
  step,
} from '../src/model.js';

const P = { a: 1, e: 0.017, period: 365.25 };

describe('astronomy.orrery the clock', () => {
  it('POSITION IS A PURE FUNCTION OF t, so the slider can be dragged BACKWARDS', () => {
    // The whole simulation. Wind the clock to day 800, then back to day 3, and the planet is exactly where
    // it was. A simulation that integrated time cannot do this at all, and a "scrub to see the past" control
    // that cannot see the past is a lie with a slider on it.
    const before = positionAt(P, 800);
    const moved = positionAt(P, 900);
    const after = positionAt(P, 3);
    const again = positionAt(P, 3);
    expect(after).toEqual(again);
    expect(before).not.toEqual(moved);
    expect(positionIsTimeInvariant(P, 3)).toBe(true);
  });

  it('Holds for a spread of days, at every orbit size', () => {
    // Checked as a property over many values rather than as three examples, because "the slider goes
    // backwards" is a statement about a function and not about a day.
    for (const t of [0, 1, 7.25, 100, 365.25, 999.999, 4000]) {
      for (const a of [0.1, 1, 12, 40]) {
        expect(positionIsTimeInvariant({ ...P, a }, t)).toBe(true);
      }
    }
  });

  it('IS EXACTLY PERIODIC, because sin and cos are', () => {
    // A function that accumulated error would drift here; this one cannot, because it multiplies.
    expect(positionAt(P, P.period)).toEqual(positionAt(P, 0));
    expect(positionAt(P, P.period * 3)).toEqual(positionAt(P, 0));
  });

  it('SATURATES at the end of the time axis rather than walking past it', () => {
    // A student holding a step button down cannot accumulate error and cannot end up somewhere the host
    // did not expect.
    expect(step(MAX_TIME, 7)).toBe(MAX_TIME);
    expect(step(MAX_TIME - 1, 7)).toBe(MAX_TIME);
    expect(step(0, 7)).toBe(7);
    expect(isComplete(MAX_TIME)).toBe(true);
    expect(isComplete(MAX_TIME - 1)).toBe(false);
  });

  it('REFUSES A HOSTILE TIME rather than producing NaN', () => {
    // `Infinity` in, a real number out. A slider dragged off the end, or a host that sends nonsense, must
    // not put a NaN into a position -- NaN in a canvas coordinate is a silently blank frame.
    // `+Infinity` LANDS AT THE END. Returning 0 for every non-finite value meant a slider dragged as far
    // right as it would go -- or a host computing the end of the timeline as `Infinity` -- silently showed
    // the student day one. `NaN` has no direction at all, so 0 is the only defensible answer there.
    expect(clampTime(Number.POSITIVE_INFINITY)).toBe(MAX_TIME);
    expect(clampTime(Number.NEGATIVE_INFINITY)).toBe(0);
    expect(clampTime(Number.NaN)).toBe(0);
    expect(clampTime(-500)).toBe(0);
    expect(clampTime(1e9)).toBe(MAX_TIME);
    for (const t of [Number.NaN, Number.POSITIVE_INFINITY, 1e9, -5]) {
      const where = positionAt(P, clampTime(t));
      expect(Number.isFinite(where.x)).toBe(true);
      expect(Number.isFinite(where.y)).toBe(true);
    }
  });

  it('REFUSES A DEGENERATE ORBIT rather than dividing by zero', () => {
    // `period: 0` is not reachable through `clamp`, but the grader runs on stored state a host controls.
    const where = positionAt({ ...P, period: 0 }, 10);
    expect(Number.isFinite(where.x)).toBe(true);
    expect(Number.isFinite(where.y)).toBe(true);
  });
});

describe('astronomy.orrery the drawing', () => {
  it('DRAWS THE ORBIT AT THE ORBIT RADIUS, and the planet ON it', () => {
    for (const t of [0, 12.5, 90, 365.25, 3000]) {
      const where = positionAt(P, t);
      const distance = Math.sqrt(where.x ** 2 + where.y ** 2);
      // To FOUR decimals, not six. `positionAt` rounds each axis to 4dp AFTER the trigonometry, so the
      // reconstructed radius carries up to 2 x 1e-4 of error, and asserting 1e-6 tested the rounding rather
      // than the orbit.
      expect(distance).toBeCloseTo(radiusAt(P), 3);
    }
  });

  it('PUTS THE PLANET ON ITS AXIS AT DAY ZERO', () => {
    // The starting position is a convention every other simulation also follows, and a planet that starts
    // somewhere arbitrary makes "how long until it is back here" a harder question than intended.
    expect(positionAt(P, 0).x).toBeCloseTo(1, 6);
    expect(positionAt(P, 0).y).toBeCloseTo(0, 6);
  });

  it('DOES NOT LET A LONG ORBIT LOOK LIKE A FAST ONE', () => {
    // Proportional, and checkable by hand: at a fixed day, a longer period means a smaller angle.
    const fast = positionAt({ ...P, period: 88 }, 10);
    const slow = positionAt({ ...P, period: 4332 }, 10);
    const angle = (p: { x: number; y: number }): number => Math.atan2(p.y, p.x);
    expect(Math.abs(angle(fast))).toBeGreaterThan(Math.abs(angle(slow)));
  });

  it('ROUNDS to four decimals, so a day count is not shown as float noise', () => {
    expect(round(1 / 3)).toBe(0.3333);
    expect(round(-0)).toBe(0);
    // A VALUE EXACTLY ON THE BOUNDARY ROUNDS UP. `2.00005` is `...50000` at five decimals and the fifth
    // decimal is a 5, so 2.0001 is right and asserting 2 would be asserting banker's rounding, which
    // `Math.round` has never done.
    expect(round(2.00005)).toBe(2.0001);
  });
});

describe('astronomy.orrery the text alternative', () => {
  /**
   * THIS ONE DELIBERATELY GIVES THE NUMBERS AWAY, and that is a different rule from every other simulation
   * in this set.
   *
   * The alternative describes a period and a distance. Both are READINGS of the panel, and both are what a
   * sighted student reads in order to answer. A screen-reader user denied the same table is not being
   * protected from the answer, they are being walled out of the question.
   */
  it('carries the orbit table, because that IS the question', () => {
    const text = describeOrbit(P);
    expect(text).toContain('365.25');
    expect(text).toContain('1 astronomical units');
    expect(text).toMatch(/returns to the same point/i);
  });
});

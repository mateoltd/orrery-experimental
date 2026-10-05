/**
 * The grader, in bare Node.  (P6-T11, gold sim 3)
 *
 * The Celsius case is the one worth a test: a student answering 0 °C for a gas at 273 K has not made an
 * arithmetic error, they have answered a different question, and the mark has to say so rather than just
 * being lower.
 */
import { describe, expect, it } from 'vitest';
import sim from '../src/grader.js';
import type { GasParams } from '../src/model.js';

const grade = (answer: unknown, params: GasParams = { p: 101.3, v: 22.4, n: 1 }) =>
  // `grade(state, params, answer)` -- the SDK's real signature, and the one `gradeStoredState` calls.
  sim.grader.grade(null, params, answer);

describe('chem.ideal-gas-law grading', () => {
  it('awards full marks for the temperature in kelvin', () => {
    // T = PV/nR = 101.3 * 22.4 / (1 * 8.314) = 273.15 K
    expect(grade({ kelvin: 273.15 }).points).toBe(4);
  });

  it('is the molar volume at STP, which is the number students already know', () => {
    // 22.4 L of one mole at 101.3 kPa is 273 K. If this drifts, the law is wrong somewhere.
    expect(grade({ kelvin: 273.15 }, { p: 101.3, v: 22.4, n: 1 }).points).toBe(4);
  });

  it('ACCEPTS A CELSIUS READING, and says what it converts to', () => {
    const result = grade({ kelvin: 0 });
    // 0 °C is 273.15 K, which is the answer. Marking that wrong teaches a student the field rejects
    // their unit; accepting it silently teaches them the field ignores it.
    expect(result.points).toBe(4);
    expect(result.feedback).toMatch(/Celsius/u);
  });

  it('awards partial credit that shrinks with the error', () => {
    // The relative tolerance is 0.5%, which on a temperature near 273 K is 1.4 K -- and that is the point
    // of tightening it from the 2% every other sim uses. At 2% a student 5 K out still scores full marks,
    // and on an absolute scale 5 K is not a rounding error.
    const near = grade({ kelvin: 276 }).points;
    const far = grade({ kelvin: 900 }).points;
    expect(near).toBeGreaterThan(0);
    expect(near).toBeLessThan(4);
    expect(far).toBeLessThan(near);
    // Inside the tolerance, therefore full marks.
    expect(grade({ kelvin: 274 }).points).toBe(4);
  });

  it('rejects an empty or unparseable answer rather than reading it as absolute zero', () => {
    // `Number('')` is 0, and 0 K is absolute zero. A blank field must not fall into it.
    expect(grade({ kelvin: Number.NaN }).points).toBe(0);
    expect(grade({ kelvin: 'warm' }).points).toBe(0);
    expect(grade(null).points).toBe(0);
  });

  it('scales with the amount of gas, because T = PV/nR', () => {
    // Doubling n halves the temperature.
    expect(grade({ kelvin: 136.58 }, { p: 101.3, v: 22.4, n: 2 }).points).toBe(4);
  });

  it('names the constant in its feedback, so a wrong answer can be worked at', () => {
    expect(grade({ kelvin: 900 }).feedback).toMatch(/R = 8\.314/u);
  });
});

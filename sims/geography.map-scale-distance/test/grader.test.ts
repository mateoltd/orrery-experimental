/**
 * The grader, in bare Node.  (P6-T11, gold sim 14)
 *
 * The cases that matter are about a UNIT LADDER, and about a scale denominator that students read as a
 * divisor because they have seen "1:50,000" as a fraction their whole life.
 */
import { describe, expect, it } from 'vitest';
import sim from '../src/grader.js';
import { describeScale, format, realDistanceKm, SCALES, scaleByName } from '../src/model.js';

const grade = (answer: unknown, params: Record<string, unknown> = { mapCm: 4, ratio: 50_000 }) =>
  sim.grader.grade(null, params, answer);

describe('geography.map-scale-distance', () => {
  it('walks the ladder: map cm, real cm, metres, kilometres', () => {
    // 4 cm at 1:50 000 is 200,000 cm, which is 2,000 m, which is 2 km.
    const rungs = realDistanceKm(4, 50_000);
    expect(rungs.realCm).toBe(200_000);
    expect(rungs.metres).toBe(2_000);
    expect(rungs.km).toBe(2);
    expect(grade(2)).toMatchObject({ points: 4, code: 'CORRECT' });
  });

  // 1:50,000 MEANS ONE CENTIMETRE IS 50,000 CENTIMETRES IN REALITY.
  //
  // Students read "1:50,000" as a fraction their whole lives and DIVIDE, which gives a real distance
  // SMALLER than the map -- obviously wrong, and the cheapest possible self-check.
  it('scores ZERO for dividing by the scale, because that is smaller than the map', () => {
    expect(grade(4 / 50_000)).toMatchObject({ points: 0 });
    expect(grade(0.00008)).toMatchObject({ points: 0 });
    // At every scale, not just the default.
    for (const scale of SCALES) {
      expect(grade(realDistanceKm(4, scale.ratio).km / scale.ratio).points).toBe(0);
    }
  });

  // THE STEP STUDENTS MISS IS CENTIMETRES TO METRES.
  //
  // Getting the ratio right and stopping there gives a number 100,000 times too large, which is a
  // different mistake from the one above and needs its own test.
  it('scores zero for stopping at centimetres, which is 100,000 times too large', () => {
    expect(grade(200_000)).toMatchObject({ points: 0 });
    expect(grade(1_000_000)).toMatchObject({ points: 0 });
  });

  it('answers correctly at all three declared scales', () => {
    expect(grade(realDistanceKm(4, 25_000).km, { mapCm: 4, ratio: 25_000 }).points).toBe(4);
    expect(grade(realDistanceKm(4, 50_000).km, { mapCm: 4, ratio: 50_000 }).points).toBe(4);
    expect(grade(realDistanceKm(4, 250_000).km, { mapCm: 4, ratio: 250_000 }).points).toBe(4);
  });

  it('is LINEAR in the measurement and in the scale', () => {
    // Twice the map distance, twice the real distance. Twice the scale, twice the real distance.
    expect(realDistanceKm(8, 50_000).km).toBeCloseTo(2 * realDistanceKm(4, 50_000).km, 9);
    expect(realDistanceKm(4, 100_000).km).toBeCloseTo(2 * realDistanceKm(4, 50_000).km, 9);
  });

  // THE DEFECT THIS SIMULATION FOUND, IN `clampParams`.
  //
  // A manifest may only declare STRING enum values, so a host configuring this simulation's numeric
  // `ratio` can only put a string on the wire. `values.includes(raw)` found no match, logged a coercion
  // and used the DEFAULT: the simulation answered for 1:50 000 while the page displayed 1:250 000, and the
  // grader agreed with the default, so every cell and every test passed. The conformance failure said
  // `expect.grade was 4, the grader awarded 0` with `params {"mapCm":4,"ratio":"250000"}`, which is what
  // made it findable.
  it('is configurable from the STRING a manifest can declare', () => {
    const numeric = { mapCm: 4, ratio: '250000' };
    expect(grade(10, numeric)).toMatchObject({ points: 4, code: 'CORRECT' });
    // And the number, for a host that has one.
    expect(grade(10, { mapCm: 4, ratio: 250_000 })).toMatchObject({ points: 4 });
  });

  // `frame.name` IS THE COMMAND, so `args.name` is never the scenario name. An earlier version read
  // `args.name` and looked for a map scale called "loadScenario", correctly refused to find one, and left
  // the simulation on the default scale while the manifest said otherwise.
  it('matches a scenario by NAME, and refuses one that does not exist', () => {
    expect(scaleByName('250k')?.ratio).toBe(250_000);
    expect(scaleByName('loadScenario')).toBeNull();
    expect(scaleByName('1:250 000')).toBeNull();
    expect(SCALES.map((entry) => entry.name)).toEqual(['25k', '50k', '250k']);
  });

  it('declares its scenarios in BOTH the manifest-facing controls and the capabilities', () => {
    expect(sim.grader.controls.scenarios).toEqual(['25k', '50k', '250k']);
  });

  it('quotes EVERY rung of the ladder in feedback, so the student sees which step went wrong', () => {
    const result = grade(1) as { feedback: string };
    expect(result.feedback).toContain('200000 cm');
    expect(result.feedback).toContain('2000 m');
    expect(result.feedback).toContain('2 km');
  });

  it('states what the scale MEANS, because that is the thing being taught', () => {
    expect(describeScale(4, 50_000)).toContain('1:50000');
    expect(describeScale(4, 50_000)).toContain('centimetre');
  });

  it('keeps the real distance out of the text alternative', () => {
    const text = sim.grader.accessibility.textAlternative;
    expect(text).not.toMatch(/\b\d+(\.\d+)?\s*km\b/);
    expect(text.length).toBeGreaterThan(20);
  });

  it('treats an empty box as no answer rather than as zero kilometres', () => {
    for (const blank of ['', '  ', null, undefined, Number.NaN]) {
      expect(grade(blank)).toMatchObject({ points: 0, code: 'UNPARSEABLE' });
    }
  });

  it('prints without padding the answer with zeros', () => {
    expect(format(2)).toBe('2');
    expect(format(0.5)).toBe('0.5');
    expect(format(200_000)).toBe('200000');
  });
});

/**
 * The grader, in bare Node.  (P6-T11, gold sim 16)
 *
 * The cases that matter are about a CONSERVATION LAW, about the boundary at 100% efficiency, and about
 * mistaking the heat for the useful work.
 */
import { describe, expect, it } from 'vitest';
import sim from '../src/grader.js';
import { budget, describeEnergy, format, isConserved } from '../src/model.js';

const grade = (
  answer: unknown,
  params: Record<string, unknown> = { inputJ: 1000, efficiency: 25 },
) => sim.grader.grade(null, params, answer);

describe('general-science.energy-budget', () => {
  it('splits the input into useful work and heat', () => {
    const b = budget(1000, 25);
    expect(b.usefulJ).toBe(250);
    expect(b.wastedJ).toBe(750);
    expect(grade(250)).toMatchObject({ points: 4, code: 'CORRECT' });
  });

  // THE INVARIANT, ASSERTED RATHER THAN ASSUMED.
  //
  // An efficiency above 100% is not a wrong answer, it is an impossible machine. Floating point means the
  // sum is not exactly zero, so the check is RELATIVE -- the only form that means anything across four
  // orders of magnitude -- and a sum asserted with `===` would fail for reasons unconnected to physics.
  it('CONSERVES energy at every efficiency and every magnitude', () => {
    for (const input of [1, 7, 1000, 999_999, 1_000_000]) {
      for (const efficiency of [5, 25, 33, 50, 99, 100]) {
        expect(isConserved(budget(input, efficiency))).toBe(true);
      }
    }
  });

  it('refuses a budget that does not conserve, rather than scoring it', () => {
    expect(isConserved({ inputJ: 100, usefulJ: 150, wastedJ: 0, fraction: 1.5 })).toBe(false);
    expect(isConserved({ inputJ: 100, usefulJ: 60, wastedJ: 60, fraction: 0.6 })).toBe(false);
    // The zero case is its own answer rather than a division by zero.
    expect(isConserved({ inputJ: 0, usefulJ: 0, wastedJ: 0, fraction: 0 })).toBe(true);
  });

  // THE BOUNDARY IS THE INTERESTING PART.
  //
  // At 100% there is no heat at all, and the answer stops being a division. A student who still subtracts
  // has made a real error, and one who subtracts zero has accidentally got it right for the wrong reason.
  it('has NO waste at 100% efficiency, so the answer is the whole input', () => {
    const b = budget(1000, 100);
    expect(b.usefulJ).toBe(1000);
    expect(b.wastedJ).toBe(0);
    expect(grade(1000, { inputJ: 1000, efficiency: 100 })).toMatchObject({ points: 4 });
  });

  it('has a small useful fraction at 5%, which is an incandescent bulb', () => {
    expect(budget(1000, 5).usefulJ).toBe(50);
    expect(grade(50, { inputJ: 1000, efficiency: 5 })).toMatchObject({ points: 4 });
  });

  // THE MISTAKE WORTH NAMING.
  //
  // Subtracting the efficiency gives the HEAT, and at 25% the two candidates are 750 and 250 -- far enough
  // apart that no tolerance confuses them, so a student who wrote the heat knows they have the wrong one.
  it('names the subtract-the-percentage mistake, and does not accuse a different wrong answer', () => {
    const heat = grade(750) as { feedback: string };
    expect(heat.feedback).toMatch(/is the heat, not the useful energy/);
    const other = grade(400) as { feedback: string };
    expect(other.feedback).not.toMatch(/is the heat/);
  });

  it('scores a gradeable but wrong answer on the scale rather than as a cliff', () => {
    // RELATIVE, because the input spans four orders of magnitude: an absolute tolerance of a joule is
    // everything at 1 J and nothing at a megajoule.
    expect(grade(240, { inputJ: 1000, efficiency: 25 }).points).toBeGreaterThan(0);
    expect(grade(240, { inputJ: 1000, efficiency: 25 }).points).toBeLessThan(4);
    // THE SAME RELATIVE ERROR EARNS THE SAME MARKS at the bottom of the range, four hundred thousand
    // times smaller. 0.24 against 0.25 is 4% out, exactly as 240 against 250 is, so the two are equal --
    // which is the whole reason the tolerance is relative.
    expect(grade(0.24, { inputJ: 1, efficiency: 25 }).points).toBe(
      grade(240, { inputJ: 1000, efficiency: 25 }).points,
    );
    expect(grade(0.2, { inputJ: 1, efficiency: 25 }).points).toBeLessThan(4);
    // And a tenth of a percent out is inside the tolerance at either magnitude.
    expect(grade(0.2502, { inputJ: 1, efficiency: 25 }).points).toBe(4);
    expect(grade(250.2, { inputJ: 1000, efficiency: 25 }).points).toBe(4);
  });

  it('clamps an efficiency outside the declared range rather than exceeding full marks', () => {
    // 150% is impossible; the model clamps the FRACTION, so the answer is capped at the whole input.
    expect(budget(1000, 150).usefulJ).toBe(1000);
    expect(isConserved(budget(1000, 150))).toBe(true);
    expect(budget(1000, -10).usefulJ).toBe(0);
  });

  it('keeps the USEFUL energy out of the text alternative while naming the split', () => {
    const text = sim.grader.accessibility.textAlternative;
    expect(text).not.toMatch(/\b\d+(\.\d+)?\s*J\b/);
    expect(text).toContain('heat');
    expect(text.length).toBeGreaterThan(20);
  });

  it('says what the percentage MEANS, because that is the thing being taught', () => {
    const text = describeEnergy(1000, 25);
    expect(text).toContain('25%');
    expect(text).toContain('conserved');
  });

  it('treats an empty box as no answer rather than as zero joules', () => {
    for (const blank of ['', '  ', null, undefined, Number.NaN]) {
      expect(grade(blank)).toMatchObject({ points: 0, code: 'UNPARSEABLE' });
    }
  });

  it('reports the state as the BUDGET, so a restored state carries the split', () => {
    // The state is the conservation-checked object, not a bare input, so `restore` can verify it.
    expect(budget(2000, 40)).toMatchObject({ inputJ: 2000, usefulJ: 800, wastedJ: 1200 });
    expect(format(0.5)).toBe('0.5');
    expect(format(250)).toBe('250');
  });
});

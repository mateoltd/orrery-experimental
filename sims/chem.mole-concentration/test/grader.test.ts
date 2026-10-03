/**
 * The grader, in bare Node.  (P6-T11, gold sim 9)
 *
 * The cases that matter here are about UNITS and about the answer not being on the screen.
 */
import { describe, expect, it } from 'vitest';
import sim from '../src/grader.js';
import { concentration, describeConcentration, toMillilitres } from '../src/model.js';

const grade = (
  answer: unknown,
  params: Record<string, unknown> = { buretteCm: 23.4, flaskMl: 250 },
) => sim.grader.grade(null, params, answer);

describe('chem.mole-concentration', () => {
  it('converts centimetres of burette to MILLILITRES, not to millilitres-with-a-decimal-point', () => {
    // 23.4 cm of a burette is 234 mL. The first version read the reading as millilitres and expected 23.4,
    // so a student who read the burette correctly failed.
    expect(toMillilitres(23.4)).toBe(234);
    expect(toMillilitres(0)).toBe(0);
  });

  // THE BUG THIS SIMULATION FOUND.
  //
  // Moles divided by a volume in MILLILITRES is mol/mL, not mol/L -- a factor of a thousand. The grader
  // would have accepted 9.36e-5 mol/L as the correct answer to a question whose answer is 0.0936 mol/L,
  // and every student would have been graded confidently against a number chemistry has never meant.
  it('answers in MOLES PER LITRE', () => {
    // 234 mL x 0.1 mol/L = 0.0234 mol, into a 0.250 L flask.
    expect(concentration(234, 250, 0.1)).toBeCloseTo(0.0936, 6);
    expect(grade(0.0936)).toMatchObject({ points: 4, code: 'CORRECT' });
  });

  it('rejects the mol/mL answer that the buggy version would have called correct', () => {
    expect(grade(9.36e-5).points).toBeLessThan(4);
  });

  // THE ANSWER IS NOT ON THE SCREEN.
  //
  // A platform that has only ever graded "what the widget says" has not been tested against a student
  // who has to decide what the widget is asking. `plans/20` gives every chemistry question a simulator,
  // and most of them look like this one.
  it('gives three inputs and asks for a number that is none of them', () => {
    const { buretteCm, flaskMl } = { buretteCm: 23.4, flaskMl: 250 };
    const answer = concentration(toMillilitres(buretteCm), flaskMl, 0.1);
    expect(answer).not.toBe(buretteCm);
    expect(answer).not.toBe(flaskMl);
    expect(answer).not.toBe(toMillilitres(buretteCm));
  });

  it('is sensitive to the flask volume, so "is this the right dilution" is answerable', () => {
    const half = concentration(234, 125, 0.1);
    const full = concentration(234, 250, 0.1);
    expect(half).toBeCloseTo(full * 2, 6);
  });

  it('treats an empty box as no answer rather than as zero', () => {
    // `Number('')` is 0, and 0 mol/L is not the answer to any dilution, so an empty box scored a
    // confident zero before. An absent answer and a wrong answer are different events.
    for (const blank of ['', '  ', null, undefined, Number.NaN]) {
      expect(grade(blank)).toMatchObject({ points: 0, code: 'UNPARSEABLE' });
    }
  });

  it('rejects a unit-carrying string as unparseable rather than guessing the unit', () => {
    // Accepting "0.0936 mol/L" by stripping the unit would be guessing. The field is labelled mol/L and
    // a student who types units into a labelled field has made a mistake worth surfacing.
    expect(grade('0.0936 mol/L')).toMatchObject({ points: 0, code: 'UNPARSEABLE' });
  });

  it('gives feedback that shows the intermediate step the student skipped', () => {
    const result = grade(0.05, { buretteCm: 23.4, flaskMl: 250 }) as { feedback: string };
    expect(result.feedback).toContain('234');
    expect(result.feedback).toContain('0.0234');
  });

  it('awards partial credit for a dilution that is close, and none for one that is not', () => {
    const near = grade(0.09);
    expect(near.points).toBeGreaterThan(0);
    expect(near.points).toBeLessThan(4);
    expect(grade(9.36).points).toBe(0);
  });

  it('keeps every number out of the text alternative', () => {
    // The alternative is what a blocked student and a printed worksheet both get instead of the
    // question, so it must describe the TASK. The simulation's own description quotes the three inputs
    // deliberately -- they are the question -- and never the answer.
    expect(sim.grader.accessibility.textAlternative).not.toMatch(/0\.09/);
    expect(describeConcentration(23.4, 250, 0.1)).not.toContain('0.0936');
    expect(describeConcentration(23.4, 250, 0.1)).toContain('23.4');
  });
});

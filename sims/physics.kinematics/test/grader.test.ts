import { clampParams } from '@orrery/sim-sdk';
import { describe, expect, it } from 'vitest';
import sim from '../src/grader.js';
import { displacement, findScenario, SCENARIOS } from '../src/model.js';
import { scenarioParam, simpleParams } from './param-fixture.js';

const grade = (answer: unknown, params: Record<string, unknown> = { scenario: 'dropped', t: 2 }) =>
  sim.grader.grade(null, params, answer) as { points: number; max: number; code: string };

describe('physics.kinematics', () => {
  it('scores a dropped stone correctly at 2 s', () => {
    // s = 0·2 + ½·(-9.81)·4 = -19.62 m
    expect(grade(-19.62)).toMatchObject({ points: 4, code: 'CORRECT' });
  });

  it('scores a thrown ball correctly at 2 s', () => {
    // s = 15·2 + ½·(-9.81)·4 = 30 - 19.62 = 10.38 m. Still rising at 2 s.
    expect(grade(10.38, { scenario: 'thrown', t: 2 })).toMatchObject({
      points: 4,
      code: 'CORRECT',
    });
  });

  it('treats a steady trolley as having no time-squared term at all', () => {
    // a = 0, so s = 6·2 = 12 m exactly, and adding "½at²" changes nothing.
    expect(grade(12, { scenario: 'rolled', t: 2 })).toMatchObject({ points: 4, code: 'CORRECT' });
    expect(grade(18, { scenario: 'rolled', t: 3 })).toMatchObject({ points: 4 });
  });

  // THE REASON THIS SIMULATION EXISTS.
  //
  // `s = ut + ½at²` is one formula and it is useless without knowing which situation the numbers
  // describe. If the three scenarios gave similar answers the `scenarios` capability would be a list of
  // names nobody reads -- a protocol claim that is true and carries no information. This is the test that
  // makes it load-bearing.
  it('gives three different answers for the same time, so the scenario is load-bearing', () => {
    const answers = SCENARIOS.map((scenario) => displacement(scenario, 2));
    expect(new Set(answers.map((value) => Math.round(value * 100))).size).toBe(3);
  });

  it('reports the free-fall acceleration as negative, not as its magnitude', () => {
    // +19.62 is the right NUMBER with the wrong SIGN. A grader that compared magnitudes would award it,
    // so this asserts only that it is not full marks -- and the reason it is not 0 is that partial credit
    // is proportional, which is a decision, not an accident.
    expect(grade(19.62).points).toBeLessThan(4);
  });

  // plans/10 §2.3 has a specific error for this: `loadScenario` naming a scenario the manifest does not
  // list. Silently falling back would put a student in a situation nobody asked for, with numbers that
  // are wrong in a way nothing reports.
  it('refuses a scenario name the manifest does not list instead of falling back', () => {
    const result = grade(10.38, { scenario: 'thrown', t: 2 });
    expect(result.code).toBe('CORRECT');
    expect(findScenario('thrown-up')).toBeNull();
    expect(grade(10.38, { scenario: 'thrown-up', t: 2 })).toMatchObject({
      points: 0,
      code: 'UNKNOWN_SCENARIO',
    });
  });

  it('awards partial credit for a near miss and nothing for a wild guess', () => {
    const near = grade(-20.4);
    expect(near.points).toBeGreaterThan(0);
    expect(near.points).toBeLessThan(4);
    // A wild guess earns NOTHING. It used to earn 0.087 of 4, because partial credit was linear in
    // relative error with no cutoff -- the formula only reached zero at 100% error, and `max(|a|,|b|)`
    // saturated it at 97.8%.
    expect(grade(-900).points).toBe(0);
    expect(grade(-190).points).toBe(0);
  });

  it('rejects a non-numeric answer without throwing', () => {
    for (const bad of ['', 'twelve', null, undefined, Number.NaN, {}]) {
      expect(grade(bad)).toMatchObject({ points: 0, code: 'UNPARSEABLE' });
    }
  });

  it('declares every scenario it claims in capabilities', () => {
    expect(sim.grader.controls.scenarios).toEqual(SCENARIOS.map((scenario) => scenario.name));
  });

  // A grader that does not declare `scenario` DROPS IT at the trust boundary, which is exactly what
  // happened: every answer graded UNKNOWN_SCENARIO because `params.scenario` arrived undefined.
  it('declares scenario as a parameter so it survives clamping', () => {
    // The real boundary is `clampParams`, and dropping an undeclared parameter happens there.
    const clamped = clampParams(simpleParams(scenarioParam), { scenario: 'thrown', t: 2 });
    expect(clamped.values.scenario).toBe('thrown');
  });

  it('keeps the distance out of the text alternative', () => {
    // The manifest's alternative is what a blocked student and a printed worksheet both get instead of
    // the question, so it must describe the TASK and never state the answer.
    expect(sim.grader.accessibility.textAlternative).not.toMatch(/\b\d+(\.\d+)?\s*m\b/);
    expect(sim.grader.accessibility.textAlternative.length).toBeGreaterThan(20);
  });

  it('gives a feedback message that shows the working, not just the verdict', () => {
    const result = grade(-5, { scenario: 'thrown', t: 2 }) as { feedback: string };
    expect(result.feedback).toContain('s = ut');
  });
});

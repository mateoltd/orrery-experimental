/**
 * The model and the grader, in bare Node.  (P12-T2, card 48 `chemistry.solution-concentration`)
 *
 * ## THE FIRST TEST IS THE ONE THAT DECIDES THE TOLERANCE CLASS
 *
 * T-C is "relative only", and the card names its trap: "wrong when the answer can legitimately be 0 for a
 * whole parameter range". So the class is only defensible if NO legal parameter set produces a zero. That is
 * checked by sweeping the corners of every declared range, not asserted.
 */

import { gradeStoredState } from '@orrery/sim-sdk/grader';
import { describe, expect, it } from 'vitest';
import sim, { MAX_POINTS, MOLARITY_MARKS, TOLERANCE } from '../src/grader.js';
import {
  clamp,
  describeSolution,
  dilutedMolarity,
  feasible,
  finalVolumeOf,
  MAX_MOLARITY,
  MAX_VOLUME,
  MIN_MOLARITY,
  MIN_VOLUME,
  MOLAR_MASS,
  moles,
  ppm,
  type SolutionParams,
} from '../src/model.js';

const PARAMS: SolutionParams = {
  molarity: 0.1,
  volume: 50,
  water: 50,
  finalVolume: 100,
  method: 'make-up',
  molarMass: MOLAR_MASS,
};

const grade = (
  answer: unknown,
  params: SolutionParams = PARAMS,
  state: unknown = { probe: true },
) => sim.grader.grade(state, params, answer);

const correct = (params: SolutionParams = PARAMS) => ({
  molarity: dilutedMolarity(params),
  ppm: ppm(params),
  moles: moles(params),
});

describe('the model', () => {
  it('ADD and MAKE UP are two different experiments, which is the focus of the card', () => {
    const added = { ...PARAMS, method: 'add' as const };
    const madeUp = { ...PARAMS, method: 'make-up' as const };
    expect(finalVolumeOf(added)).toBe(100);
    expect(finalVolumeOf(madeUp)).toBe(100);
    // SAME final volume here, so make the volumes differ and the verb becomes the whole question.
    const addedWide = { ...added, water: 150 };
    const madeUpNarrow = { ...madeUp, finalVolume: 200 };
    expect(finalVolumeOf(addedWide)).toBe(200);
    expect(finalVolumeOf(madeUpNarrow)).toBe(200);
    expect(finalVolumeOf({ ...added, water: 150, volume: 50 })).toBe(200);
    expect(finalVolumeOf({ ...madeUp, finalVolume: 200, volume: 50 })).toBe(200);
    // AND THE STUDENT MISTAKE: treating "make up to 100" as "add 100" from 50 gives 150, not 100.
    expect(finalVolumeOf({ ...madeUp, finalVolume: 100, water: 100 })).toBe(100);
    expect(finalVolumeOf({ ...madeUp, water: 100 })).toBe(100);
    expect(dilutedMolarity({ ...madeUp, water: 100 })).not.toBe(
      dilutedMolarity({ ...added, water: 100 }),
    );
  });

  it('DILUTION CHANGES NEITHER THE AMOUNT NOR THE MASS, which is misconception (3)', () => {
    // `add`, so the water really does become part of the volume: 50 + 400 = 450 cm3.
    const wide = { ...PARAMS, method: 'add' as const, water: 400 };
    expect(moles(wide)).toBe(moles(PARAMS));
    expect(feasible(wide)).toBe(true);
    // AND THE CONCENTRATION FALLS BY EXACTLY THE VOLUME RATIO.
    expect(dilutedMolarity(wide)).toBeCloseTo((PARAMS.molarity * PARAMS.volume) / 450, 12);
  });

  it('NO LEGAL PARAMETER SET MAKES AN ANSWER ZERO, which is what T-C requires', () => {
    for (const molarity of [MIN_MOLARITY, MAX_MOLARITY]) {
      for (const volume of [MIN_VOLUME, MAX_VOLUME]) {
        for (const water of [0, MAX_VOLUME]) {
          for (const finalVolume of [volume, MAX_VOLUME]) {
            for (const method of ['add', 'make-up'] as const) {
              for (const molarMass of [1, 200]) {
                const params = clamp({ molarity, volume, water, finalVolume, method, molarMass });
                for (const [name, value] of [
                  ['molarity', dilutedMolarity(params)],
                  ['ppm', ppm(params)],
                  ['moles', moles(params)],
                ] as const) {
                  expect(value, `${name} ${JSON.stringify(params)}`).toBeGreaterThan(0);
                  expect(Number.isFinite(value), `${name} ${JSON.stringify(params)}`).toBe(true);
                }
              }
            }
          }
        }
      }
    }
  });

  it('clamps a make-up target below the starting volume rather than removing solution', () => {
    const impossible = clamp({ volume: 200, finalVolume: 50 });
    expect(impossible.finalVolume).toBe(200);
    expect(feasible(impossible)).toBe(true);
  });

  it('describes the solution it is describing, verbs included', () => {
    expect(describeSolution(PARAMS)).toContain('made up to a total of 100');
    expect(describeSolution({ ...PARAMS, method: 'add' })).toContain('50 cm³ of water added');
  });
});

describe('the grader', () => {
  it('awards full marks for the two concentrations and the amount', () => {
    const graded = grade(correct());
    expect(graded.points).toBe(MAX_POINTS);
    expect(graded.code).toBe('CORRECT');
  });

  it('declares NO absolute bound, because T-C means relative only', () => {
    // `abs: 0` is a different declaration: `spec.abs !== undefined && spec.abs > 0` is the test the
    // partial-credit scaling makes (`grading.ts:262`), so a declared zero would have made `tolerance` report
    // that no tolerance was declared to scale from.
    expect('abs' in TOLERANCE).toBe(false);
    expect(TOLERANCE.rel).toBe(0.005);
  });

  it('grades the OTHER VERB arithmetic wrong, which is the misconception', () => {
    // The add-the-water answer for a make-up question: 0.1 x 50/150 rather than /100.
    const wrongVerb = grade({ molarity: 0.0333, ppm: ppm(PARAMS), moles: moles(PARAMS) });
    expect(wrongVerb.points).toBeLessThan(MAX_POINTS);
    expect(wrongVerb.points).toBeLessThanOrEqual(MAX_POINTS - MOLARITY_MARKS);
    expect(wrongVerb.feedback).toMatch(/made UP TO/u);
  });

  it('accepts a student whose molar-mass table differs by half a per cent', () => {
    // `rel: 0.005` is a DATA-AMBIGUITY band, not slack: the ppm answer inherits the tabulated molar mass.
    const offTable = grade({ ...correct(), ppm: correct().ppm * 1.004 });
    expect(offTable.points).toBe(MAX_POINTS);
    const tooFar = grade({ ...correct(), ppm: correct().ppm * 1.02 });
    expect(tooFar.points).toBeLessThan(MAX_POINTS);
  });

  it('awards nothing for a blank answer, and says UNPARSEABLE when nothing could be read', () => {
    expect(grade(null).code).toBe('UNPARSEABLE');
    expect(grade({}).code).toBe('UNPARSEABLE');
    expect(grade({}).points).toBe(0);
  });

  it('is DETERMINISTIC: three runs, identical output', () => {
    const runs = [0, 1, 2].map(() => JSON.stringify(grade(correct())));
    expect(runs[1]).toBe(runs[0]);
    expect(runs[2]).toBe(runs[0]);
  });

  it('tolerates the determinism probe state and every legal parameter set', () => {
    expect(() => grade(correct(), PARAMS, { probe: true })).not.toThrow();
    for (const method of ['add', 'make-up'] as const) {
      for (const volume of [10, 50, 500]) {
        const params: SolutionParams = { ...PARAMS, method, volume, water: 0, finalVolume: volume };
        expect(() => grade(correct(params), params), JSON.stringify(params)).not.toThrow();
      }
    }
  });

  it('REPLAYS: re-grading the stored state reproduces the stored mark', () => {
    const state = { ...PARAMS };
    const once = sim.grader.grade(state, state, correct());
    const twice = gradeStoredState(sim.grader, { state, params: state, answer: correct() });
    expect(twice.points).toBe(once.points);
    expect(twice.code).toBe(once.code);
  });

  it('`gradeStoredState` is what REFUSES a bad state', () => {
    const validator = sim.grader.validateState;
    if (validator === undefined) throw new Error('this simulation declares no validateState');
    expect(validator(PARAMS)).toBeNull();
    expect(validator({ volume: 50 })).toMatch(/method/u);
    expect(validator({ method: 'add', volume: Number.NaN })).toMatch(/volume/u);
    expect(() =>
      gradeStoredState(sim.grader, { state: { volume: 50 }, params: PARAMS, answer: correct() }),
    ).toThrow(/STATE_INVALID/u);
  });
});

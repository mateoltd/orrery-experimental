/**
 * The grader half. Node, no DOM, deterministic.  (P12-T2, card 48 `chemistry.solution-concentration`)
 *
 * ## TOLERANCE CLASS T-C, WHICH MEANS `absolute` IS OMITTED AND NOT SMALL
 *
 * `withinTolerance` takes `max(abs, rel x max(|given|,|expected|))` (`grading.ts:190`), so declaring an
 * absolute bound beside a relative one WIDENS the band rather than narrowing it, and an absolute bound alone
 * accepts everything near zero. T-C is therefore `rel` with **no `abs` key at all** — `abs: 0` would be a
 * different declaration, because `spec.abs !== undefined && spec.abs > 0` is what the partial-credit scaling
 * tests (`grading.ts:262`), and a declared zero would have made `tolerance` report that no tolerance was
 * declared to scale from.
 *
 * ## AND T-C IS ONLY CORRECT BECAUSE NO LEGAL PARAMETER SET MAKES AN ANSWER ZERO
 *
 * The card names T-C's trap: "wrong when the answer can legitimately be 0 for a whole parameter range —
 * then it is T-D". Here the amount of solute cannot change, so `moles` is bounded below by
 * `0.01 x 0.010 = 1e-4`, and both concentrations scale with it and cannot be zero either. `legal parameter
 * sets never produce a zero` in `test/grader.test.ts` is the evidence for choosing this class, and it is
 * checked by sweeping every corner of the declared ranges rather than asserted.
 */

import { defineSim, tolerance } from '@orrery/sim-sdk/grader';
import {
  clamp,
  describeSolution,
  dilutedMolarity,
  moles,
  ppm,
  type SolutionParams,
} from './model.js';

export const MOLARITY_MARKS = 2;
export const PPM_MARKS = 1;
export const MOLES_MARKS = 1;
export const MAX_POINTS = MOLARITY_MARKS + PPM_MARKS + MOLES_MARKS;

/**
 * The card's T-C declaration: a RELATIVE band and no absolute bound at all.
 *
 * `rel: 0.005` is a data-ambiguity band rather than slack: molar masses are tabulated to varying precision,
 * a student's table will differ, and the ppm answer inherits that. It is not a band for carelessness.
 */
export const TOLERANCE = { rel: 0.005 } as const;

const parse = (answer: unknown) => {
  if (answer === null || typeof answer !== 'object') return null;
  const record = answer as Record<string, unknown>;
  return {
    molarity: record.molarity,
    ppm: record.ppm,
    moles: record.moles,
  };
};

export default defineSim({
  meta: {
    id: 'chemistry.solution-concentration',
    title: 'Solutions and concentration',
    version: '1.0.0',
    subjects: ['chemistry'],
    licence: 'CC-BY-4.0',
    provenance: 'ORIGINAL',
    protocol: 1,
  },
  params: {
    molarity: {
      type: 'number',
      name: 'molarity',
      label: 'Starting molarity',
      unit: 'mol/L',
      min: 0.01,
      max: 2,
      default: 0.1,
    },
    volume: {
      type: 'number',
      name: 'volume',
      label: 'Starting volume',
      unit: 'cm3',
      min: 10,
      max: 500,
      default: 50,
    },
    water: {
      type: 'number',
      name: 'water',
      label: 'Water added',
      unit: 'cm3',
      min: 0,
      max: 500,
      default: 50,
    },
    finalVolume: {
      type: 'number',
      name: 'finalVolume',
      label: 'Volume made up to',
      unit: 'cm3',
      min: 10,
      max: 500,
      default: 100,
    },
    method: {
      type: 'enum',
      name: 'method',
      label: 'Method',
      values: ['add', 'make-up'],
      default: 'make-up',
    },
    molarMass: {
      type: 'number',
      name: 'molarMass',
      label: 'Molar mass',
      unit: 'g/mol',
      min: 1,
      max: 200,
      default: 58.44,
    },
  },
  controls: { params: true, state: false, scenarios: [] },
  accessibility: {
    keyboard: true,
    screenReaderSummary:
      'Two beakers, one starting and one after the dilution, with the method stated as add or make up, and three labelled boxes for the diluted molarity, the concentration in ppm and the amount in moles.',
    reducedMotion: true,
    textAlternative:
      '0.1 moles per litre in 50 cm3 of solution, made up to a total of 100 cm3. That is 0.005 moles in 100 cm3, so the diluted molarity is 0.05 mol per litre and the concentration is 2922 ppm.',
    summary:
      'Dilute a solution by adding water or making it up to a volume, and report molarity, ppm and moles.',
  },

  grade(_state: unknown, rawParams: unknown, answer: unknown) {
    const parsed = parse(answer);
    if (parsed === null) {
      return {
        points: 0,
        maxPoints: MAX_POINTS,
        code: 'UNPARSEABLE',
        feedback:
          'No concentrations were submitted, so there is nothing to score. Enter the diluted molarity, the ' +
          'concentration in ppm and the amount in moles.',
      };
    }
    const params = clamp(rawParams as Partial<SolutionParams>);
    const expected = {
      molarity: dilutedMolarity(params),
      ppm: ppm(params),
      moles: moles(params),
    };
    const parts = [
      {
        key: 'molarity',
        grade: tolerance(parsed.molarity, expected.molarity, {
          ...TOLERANCE,
          maxPoints: MOLARITY_MARKS,
          partialCredit: true,
        }),
      },
      {
        key: 'ppm',
        grade: tolerance(parsed.ppm, expected.ppm, {
          ...TOLERANCE,
          maxPoints: PPM_MARKS,
          partialCredit: true,
        }),
      },
      {
        key: 'moles',
        grade: tolerance(parsed.moles, expected.moles, {
          ...TOLERANCE,
          maxPoints: MOLES_MARKS,
          partialCredit: true,
        }),
      },
    ];
    const points = parts.reduce((sum, part) => sum + part.grade.points, 0);
    if (parts.every((part) => part.grade.code === 'UNPARSEABLE')) {
      return {
        points: 0,
        maxPoints: MAX_POINTS,
        code: 'UNPARSEABLE',
        feedback: `None of the three fields could be read as a number. ${describeSolution(params)}`,
      };
    }
    if (points >= MAX_POINTS) {
      return {
        points: MAX_POINTS,
        maxPoints: MAX_POINTS,
        code: 'CORRECT',
        feedback: `Correct. ${describeSolution(params)}`,
      };
    }
    return {
      points,
      maxPoints: MAX_POINTS,
      code: points > 0 ? 'PARTIAL' : 'INCORRECT',
      feedback:
        parts.map((part) => `${part.key}: ${part.grade.feedback}`).join('. ') +
        `. ${describeSolution(params)} ${params.method === 'add' ? 'Water was ADDED' : 'The solution was made UP TO a total'}, ` +
        'so the two methods give different final volumes and the verb is the whole question. Dilution ' +
        'changes neither the amount of solute nor its mass.',
    };
  },

  validateState(state: unknown) {
    if (state === null || typeof state !== 'object') return 'the state is not an object';
    const record = state as Record<string, unknown>;
    if (typeof record.method !== 'string') return 'the state has no `method` name';
    if (typeof record.volume !== 'number' || !Number.isFinite(record.volume)) {
      return 'the state has no finite `volume`';
    }
    return null;
  },
});

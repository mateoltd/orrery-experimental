/**
 * The grader half. Node, no DOM, deterministic.  (P6-T11, gold sim 3)
 *
 * The arithmetic is shared with `model.ts`, so the screen and the mark cannot disagree — the same reason
 * the projectile grader imports its model rather than repeating the closed form.
 */

import { defineSim, num, tolerance } from '@orrery/sim-sdk/grader';
import { describeGas, format, type GasParams, R, temperature } from './model.js';

/** The answer a student submits: the temperature in KELVIN, which is what the law uses. */
export interface GasAnswer {
  readonly kelvin: number;
}

const parseAnswer = (answer: unknown): GasAnswer | null => {
  if (answer === null || typeof answer !== 'object') return null;
  const value = Number((answer as Record<string, unknown>).kelvin);
  return Number.isFinite(value) ? { kelvin: value } : null;
};

/**
 * Read the stored parameters.
 *
 * `Number(value, fallback)` is not a thing — `Number` takes one argument — and the first version of this
 * graded every answer against `NaN`. The same mistake shape has now appeared in three sims in this phase.
 */
const paramsOf = (raw: Readonly<Record<string, unknown>>): GasParams => {
  const read = (value: unknown, fallback: number): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  return { p: read(raw.p, 101.3), v: read(raw.v, 22.4), n: read(raw.n, 1) };
};

export default defineSim({
  meta: {
    id: 'chem.ideal-gas-law',
    title: 'Ideal gas law',
    version: '1.0.0',
    subjects: ['chemistry'],
    license: 'CC-BY-4.0',
    provenance: 'ORIGINAL',
    protocol: 1,
  },
  params: {
    p: num({ name: 'p', label: 'Pressure', unit: 'kPa', min: 50, max: 300, default: 101.3 }),
    v: num({ name: 'v', label: 'Volume', unit: 'L', min: 1, max: 60, default: 22.4 }),
    n: num({ name: 'n', label: 'Amount', unit: 'mol', min: 0.1, max: 5, default: 1 }),
  },
  controls: { params: true, state: true, scenarios: [] },
  accessibility: {
    keyboard: true,
    screenReaderSummary:
      'Three dials for pressure, volume and amount, with the resulting temperature.',
    reducedMotion: true,
    // `defineSim` REFUSES a grader half without a text alternative, and the error is a `.trim()` on
    // `undefined` with nothing naming the missing field. Both strings match the manifest.
    textAlternative:
      '1 moles of gas at 101.3 kilopascals in 22.4 litres reach 273.15 kelvin, which is 0 degrees Celsius.',
    summary:
      'Set the pressure, volume and amount of a gas, then calculate its temperature in kelvin.',
  },
  grade(answer, context) {
    const parsed = parseAnswer(answer);
    if (parsed === null) {
      return {
        points: 0,
        max: 4,
        code: 'UNPARSEABLE',
        feedback: 'Enter a temperature in kelvin.',
      };
    }
    const params = paramsOf(context.params ?? {});
    const expected = temperature(params);

    // A student who answers in Celsius is not wrong so much as answering a different question, and 100 °C
    // is 373 K. Accepted only if it is unambiguously a Celsius reading, and then told what it converts
    // to — because silently converting for them teaches them the field ignores their unit.
    const asCelsius = parsed.kelvin + 273.15;
    const judged = tolerance(parsed.kelvin, expected, {
      abs: context.tolerance?.absolute,
      rel: context.tolerance?.relative,
      maxPoints: 4,
      partialCredit: true,
    });
    const kelvinJudged = judged;
    const celsiusJudged = tolerance(asCelsius, expected, {
      abs: context.tolerance?.absolute,
      rel: context.tolerance?.relative,
      maxPoints: 4,
      partialCredit: true,
    });

    if (kelvinJudged.points === 4) {
      return {
        points: 4,
        max: 4,
        code: 'CORRECT',
        feedback: `Correct: ${describeGas(params)}`,
      };
    }
    if (celsiusJudged.points > kelvinJudged.points) {
      return {
        points: celsiusJudged.points,
        max: 4,
        code: 'CELSIUS',
        feedback:
          `You entered a Celsius reading. ${format(parsed.kelvin)} °C is ${format(asCelsius)} K, and the ` +
          `law needs kelvin — which is ${format(expected)} K here.`,
      };
    }
    return {
      points: kelvinJudged.points,
      max: 4,
      code: kelvinJudged.points > 0 ? 'CLOSE' : 'WRONG',
      feedback:
        `You said ${format(parsed.kelvin)} K. ${describeGas(params)} ` +
        `Rearranged, T = PV/nR, with R = ${R} J/(mol·K).`,
    };
  },
  validateState(state) {
    if (state === null || typeof state !== 'object') return 'the state is not an object';
    const p = (state as { p?: unknown }).p;
    return typeof p === 'number' && Number.isFinite(p) ? null : 'the state has no finite `p`';
  },
});

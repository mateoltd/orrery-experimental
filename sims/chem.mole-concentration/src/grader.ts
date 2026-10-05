/**
 * The grader half. Node, no DOM, deterministic.  (P6-T11, gold sim 9)
 */

import { defineSim, num, tolerance } from '@orrery/sim-sdk/grader';
import {
  type ConcentrationParams,
  concentration,
  describeConcentration,
  format,
  toMillilitres,
} from './model.js';

const STOCK_MOLAR = 0.1;

export default defineSim({
  meta: {
    id: 'chem.mole-concentration',
    title: 'Concentration by dilution',
    version: '1.0.0',
    subjects: ['chem'],
    licence: 'CC-BY-4.0',
    provenance: 'ORIGINAL',
    protocol: 1,
  },
  params: {
    buretteCm: num({
      name: 'buretteCm',
      label: 'Burette reading',
      unit: 'cm',
      min: 0,
      max: 50,
      default: 23.4,
    }),
    flaskMl: num({
      name: 'flaskMl',
      label: 'Flask volume',
      unit: 'mL',
      min: 1,
      max: 1000,
      default: 250,
    }),
  },
  controls: { params: true, state: true, scenarios: [] },
  accessibility: {
    keyboard: true,
    screenReaderSummary:
      'A burette reading in centimetres, a flask volume in millilitres, and a box for the concentration in moles per litre.',
    reducedMotion: true,
    // The three inputs are described; the answer -- the concentration -- is never named with a number,
    // because a concentration with a unit is the answer and this text is what a blocked student and a
    // printed worksheet both get instead of the question.
    textAlternative:
      'A burette reading and a flask volume are given, together with the concentration of the stock ' +
      'solution. The task is to work out the concentration after the flask is made up to its mark.',
    summary: 'Read a burette, fill a volumetric flask, and calculate the diluted concentration.',
  },
  grade(_state: unknown, params: ConcentrationParams, answer: unknown) {
    // `Number('')` is 0, not NaN, so an empty box would score a confident "0.000000 mol/L" for a
    // question whose answer is never zero. An absent answer and a wrong answer are different events.
    const blank =
      answer === null ||
      answer === undefined ||
      (typeof answer === 'string' && answer.trim() === '');
    const given = Number(answer);
    if (blank || !Number.isFinite(given)) {
      return {
        points: 0,
        maxPoints: 4,
        code: 'UNPARSEABLE',
        feedback: 'Enter the concentration of the diluted solution in mol/L.',
      };
    }
    const millilitres = toMillilitres(params.buretteCm);
    const expected = concentration(millilitres, params.flaskMl, STOCK_MOLAR);
    const judged = tolerance(given, expected, {
      abs: 0.0001,
      rel: 0.01,
      maxPoints: 4,
      partialCredit: true,
      partialCreditBand: 6,
    });
    return {
      points: judged.points,
      maxPoints: 4,
      code: judged.points === 4 ? 'CORRECT' : judged.points > 0 ? 'CLOSE' : 'WRONG',
      feedback:
        judged.points === 4
          ? 'Correct.'
          : `You said ${format(given)} mol/L. ${describeConcentration(params.buretteCm, params.flaskMl, STOCK_MOLAR)} ` +
            `The burette reading is ${format(millilitres)} mL, which carries ${format(millilitres * STOCK_MOLAR * 1e-3)} mol ` +
            `into ${format(params.flaskMl)} mL.`,
    };
  },
  validateState(state) {
    if (state === null || typeof state !== 'object') return 'the state is not an object';
    const reading = (state as { buretteCm?: unknown }).buretteCm;
    return typeof reading === 'number' && Number.isFinite(reading)
      ? null
      : 'the state has no burette reading';
  },
});

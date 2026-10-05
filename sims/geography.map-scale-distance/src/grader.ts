/**
 * The grader half. Node, no DOM, deterministic.  (P6-T11, gold sim 14)
 */

import { choice, defineSim, num, tolerance } from '@orrery/sim-sdk/grader';
import { describeScale, format, realDistanceKm, type ScaleParams } from './model.js';

export default defineSim({
  meta: {
    id: 'geography.map-scale-distance',
    title: 'Real distance from a map scale',
    version: '1.0.0',
    subjects: ['geography'],
    licence: 'CC-BY-4.0',
    provenance: 'ORIGINAL',
    protocol: 1,
  },
  params: {
    mapCm: num({ name: 'mapCm', label: 'On the map', unit: 'cm', min: 0.5, max: 20, default: 4 }),
    ratio: choice({
      name: 'ratio',
      label: 'Scale',
      values: [25_000, 50_000, 250_000],
      default: 50_000,
    }),
  },
  controls: { params: true, state: true, scenarios: ['25k', '50k', '250k'] },
  accessibility: {
    keyboard: true,
    screenReaderSummary:
      'A measured distance on a map, the scale the map is printed at, and a box for the real distance.',
    reducedMotion: true,
    // The real distance is the answer. The measurement and the scale are named because they are the
    // question, and the meaning of the scale is stated rather than left as something the student supplies.
    textAlternative:
      'A route is measured on a map, and the scale the map is printed at is given. The scale means one ' +
      'centimetre on the map is the same number of centimetres in reality. Work out how far the route is ' +
      'in real life, in kilometres.',
    summary: 'Measure a route on a map and work out how far it is in real life.',
  },
  grade(_state: unknown, params: ScaleParams, answer: unknown) {
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
        feedback: 'Enter the real distance in kilometres.',
      };
    }
    const rungs = realDistanceKm(Number(params.mapCm), Number(params.ratio));
    const judged = tolerance(given, rungs.km, {
      abs: 0,
      rel: 0.01,
      maxPoints: 4,
      partialCredit: true,
      partialCreditBand: 3,
    });
    return {
      points: judged.points,
      maxPoints: 4,
      code: judged.points === 4 ? 'CORRECT' : judged.points > 0 ? 'CLOSE' : 'WRONG',
      feedback:
        judged.points === 4
          ? `Correct: ${format(rungs.km)} km.`
          : `You said ${format(given)} km. ${describeScale(Number(params.mapCm), Number(params.ratio))} ` +
            `${format(params.mapCm)} cm is ${format(rungs.realCm)} cm in reality, which is ` +
            `${format(rungs.metres)} m, which is ${format(rungs.km)} km.`,
    };
  },
  validateState(state) {
    if (state === null || typeof state !== 'object') return 'the state is not an object';
    const mapCm = (state as { mapCm?: unknown }).mapCm;
    return typeof mapCm === 'number' && mapCm > 0 ? null : 'the state has no positive map distance';
  },
});

export { realDistanceKm };

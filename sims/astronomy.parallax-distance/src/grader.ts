/**
 * The grader half. Node, no DOM, deterministic.  (P6-T11, gold sim 13)
 */

import { choice, defineSim, num, tolerance } from '@orrery/sim-sdk/grader';
import { describeParallax, format, lightYears, type ParallaxParams, parsecs } from './model.js';

export default defineSim({
  meta: {
    id: 'astronomy.parallax-distance',
    title: 'Distance from annual parallax',
    version: '1.0.0',
    subjects: ['astronomy'],
    license: 'CC-BY-4.0',
    provenance: 'ORIGINAL',
    protocol: 1,
  },
  params: {
    parallax: num({
      name: 'parallax',
      label: 'Annual parallax',
      unit: 'arcsec',
      min: 0.05,
      max: 2,
      default: 0.1,
    }),
    inLightYears: choice({
      name: 'inLightYears',
      label: 'Answer in light years',
      values: [false, true],
      default: false,
    }),
  },
  controls: { params: true, state: true, scenarios: [] },
  accessibility: {
    keyboard: true,
    screenReaderSummary:
      'An annual parallax in arcseconds, a choice of units, and a box for the distance.',
    reducedMotion: true,
    // The distance is the answer. The parallax is named because it is the question, and the text says
    // which way the relationship runs, because "larger means closer" is the thing students get wrong.
    textAlternative:
      'A star is measured to have an annual parallax in arcseconds. Larger parallax means closer. ' +
      'Work out the distance, in parsecs or in light years as selected. One parsec is the distance at ' +
      'which a star has a parallax of exactly one arcsecond.',
    summary: "Measure a star's parallax and work out how far away it is.",
  },
  grade(_state: unknown, params: ParallaxParams, answer: unknown) {
    const blank =
      answer === null ||
      answer === undefined ||
      (typeof answer === 'string' && answer.trim() === '');
    const given = Number(answer);
    if (blank || !Number.isFinite(given)) {
      return {
        points: 0,
        max: 4,
        code: 'UNPARSEABLE',
        feedback: 'Enter the distance as a number.',
      };
    }
    const wantLightYears = params.inLightYears === true;
    const expected = wantLightYears
      ? lightYears(Number(params.parallax))
      : parsecs(Number(params.parallax));
    // RELATIVE, because the answer spans 0.5 to 20 parsecs and an absolute tolerance is a tenth of the
    // range at one end and half the answer at the other.
    const judged = tolerance(given, expected, {
      abs: 0,
      rel: 0.02,
      maxPoints: 4,
      partialCredit: true,
      // Two tolerances: reading a parallax off a diagram is coarse, and the relationship is a reciprocal,
      // so a small error in the parallax is a proportionally larger error in the distance.
      partialCreditBand: 4,
    });
    return {
      points: judged.points,
      max: 4,
      code: judged.points === 4 ? 'CORRECT' : judged.points > 0 ? 'CLOSE' : 'WRONG',
      feedback:
        judged.points === 4
          ? `Correct: ${format(expected)} ${wantLightYears ? 'light years' : 'parsecs'}.`
          : `You said ${format(given)}. ${describeParallax(Number(params.parallax), wantLightYears)} ` +
            `The distance is ${format(expected)} ${wantLightYears ? 'light years' : 'parsecs'}.`,
    };
  },
  validateState(state) {
    if (state === null || typeof state !== 'object') return 'the state is not an object';
    const parallax = (state as { parallax?: unknown }).parallax;
    return typeof parallax === 'number' && parallax > 0
      ? null
      : 'the state has no positive parallax';
  },
});

export { lightYears, type parallaxOf, parsecs };

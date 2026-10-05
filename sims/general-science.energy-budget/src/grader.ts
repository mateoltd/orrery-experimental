/**
 * The grader half. Node, no DOM, deterministic.  (P6-T11, gold sim 16)
 */

import { defineSim, num, tolerance } from '@orrery/sim-sdk/grader';
import { budget, describeEnergy, type EnergyParams, format, isConserved } from './model.js';

export default defineSim({
  meta: {
    id: 'general-science.energy-budget',
    title: 'Where the energy goes',
    version: '1.0.0',
    subjects: ['general-science'],
    licence: 'CC-BY-4.0',
    provenance: 'ORIGINAL',
    protocol: 1,
  },
  params: {
    inputJ: num({
      name: 'inputJ',
      label: 'Energy supplied',
      unit: 'J',
      min: 1,
      max: 1_000_000,
      default: 1000,
    }),
    efficiency: num({
      name: 'efficiency',
      label: 'Efficiency',
      unit: '%',
      min: 5,
      max: 100,
      default: 25,
    }),
  },
  controls: { params: true, state: true, scenarios: [] },
  accessibility: {
    keyboard: true,
    screenReaderSummary:
      'An energy input in joules and an efficiency percentage, a bar split into useful work and heat, and a box for the useful energy.',
    reducedMotion: true,
    // The useful energy is the answer, so no number appears here. The split into work and heat is named
    // because it is the question, and because a student who has not heard of wasted energy cannot attempt it.
    textAlternative:
      'An energy supply in joules and a percentage efficiency are given. The useful work produced and the ' +
      'heat released are shown as parts of the whole. Work out how many joules of useful energy are produced.',
    summary: 'Split an energy supply into useful work and heat, and check the total is conserved.',
  },
  grade(_state: unknown, params: EnergyParams, answer: unknown) {
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
        feedback: 'Enter the useful energy in joules.',
      };
    }
    const b = budget(Number(params.inputJ), Number(params.efficiency));
    // RELATIVE, because the input spans four orders of magnitude: an absolute tolerance of a joule is
    // everything at the bottom of the range and nothing at the top.
    const judged = tolerance(given, b.usefulJ, {
      abs: 0,
      rel: 0.01,
      maxPoints: 4,
      partialCredit: true,
      partialCreditBand: 4,
    });
    return {
      points: judged.points,
      maxPoints: 4,
      code: judged.points === 4 ? 'CORRECT' : judged.points > 0 ? 'CLOSE' : 'WRONG',
      feedback:
        judged.points === 4
          ? `Correct: ${format(b.usefulJ)} J of useful energy, and ${format(b.wastedJ)} J of heat.`
          : `You said ${format(given)} J. ${describeEnergy(Number(params.inputJ), Number(params.efficiency))} ` +
            `${format(params.efficiency)}% of ${format(b.inputJ)} J is ${format(b.usefulJ)} J of useful ` +
            `energy and the remaining ${format(b.wastedJ)} J is heat.` +
            // The failure worth naming: a student who SUBTRACTED the efficiency, treating it as a loss
            // rather than a proportion. At 25% that is 750 J rather than 250 J, and the two are far
            // enough apart that no tolerance confuses them.
            (Math.abs(given - b.wastedJ) <= Math.max(1, b.wastedJ * 0.02)
              ? ` ${format(given)} J is the heat, not the useful energy: the percentage is the part that ` +
                'becomes work, not the part that is lost.'
              : ''),
    };
  },
  validateState(state) {
    if (state === null || typeof state !== 'object') return 'the state is not an object';
    const input = (state as { inputJ?: unknown }).inputJ;
    return typeof input === 'number' && input > 0 ? null : 'the state has no positive energy input';
  },
});

export { budget, isConserved };

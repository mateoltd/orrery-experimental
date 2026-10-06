/**
 * The grader half. Node, no DOM, deterministic.  (P12-T2, card 8 `astronomy.tides`)
 *
 * ## TOLERANCE CLASS T-C, `rel: 0.05` AND NO `absolute` KEY AT ALL
 *
 * T-C means "relative only", and `withinTolerance` takes `max(abs, rel x max(|given|,|expected|))`
 * (`grading.ts:190`) — so an absolute bound declared beside a relative one WIDENS the band rather than
 * narrowing it. `abs` is therefore absent from the spec rather than set to a small number.
 *
 * The card's reason for `rel: 0.05` is unusually good and is the reason this simulation can use T-C at all:
 * the beat period "comes from a DIFFERENCE of two close numbers, so it is poorly conditioned", and a student
 * computing it from two-decimal constituents gets 14.6 days where the three-decimal answer is 14.77. Five per
 * cent is not slack here; it is the width of a legitimate disagreement about a badly conditioned quantity. The
 * beat period is REPORTED rather than graded, and the two ranges are declared separately so a student is
 * graded on the question they were asked.
 *
 * ## T-C IS ONLY CORRECT BECAUSE NO LEGAL PARAMETER SET MAKES AN ANSWER ZERO
 *
 * Its trap is "wrong when the answer can legitimately be 0 for a whole parameter range — then it is T-D". The
 * range is `1` m², the amplitude is bounded below by `A_S2 x amplification > 0` and the period is the constant
 * `T_M2`, so none of the three numeric answers can be zero, and a zero is what an absolute floor would have
 * accepted. The sweep in `test/grader.test.ts` is the evidence.
 */

import { defineSim, tolerance } from '@orrery/sim-sdk/grader';
import {
  amplification,
  asBoolean,
  clamp,
  describeTides,
  MAX_NATURAL,
  MIN_NATURAL,
  resonant,
  semidiurnalPeriod,
  type TideParams,
  tidalRange,
} from './model.js';

export const RANGE_MARKS = 1.5;
export const AMPLIFICATION_MARKS = 0.5;
export const PERIOD_MARKS = 1;
export const RESONANT_MARKS = 1;
export const MAX_POINTS = RANGE_MARKS + AMPLIFICATION_MARKS + PERIOD_MARKS + RESONANT_MARKS;

/** The card's declaration: relative only, and 5% is the conditioning of the answer rather than slack. */
export const TOLERANCE = { rel: 0.05 } as const;

export default defineSim({
  meta: {
    id: 'astronomy.tides',
    title: 'Tides',
    version: '1.0.0',
    subjects: ['astronomy'],
    licence: 'CC-BY-4.0',
    provenance: 'ORIGINAL',
    protocol: 1,
  },
  params: {
    natural: {
      type: 'number',
      name: 'natural',
      label: 'Basin natural period',
      unit: 'h',
      min: MIN_NATURAL,
      max: MAX_NATURAL,
      default: 12.4206012,
    },
    hours: {
      type: 'number',
      name: 'hours',
      label: 'Hours to plot',
      unit: 'h',
      min: 1,
      max: 720,
      default: 168,
    },
    phase: {
      type: 'number',
      name: 'phase',
      label: 'Lunar phase, day of cycle',
      unit: 'd',
      min: 0,
      max: 29.53,
      default: 0,
    },
  },
  controls: { params: true, state: false, scenarios: [] },
  accessibility: {
    keyboard: true,
    screenReaderSummary:
      'A tide curve plotting water height against time for a basin, a table of the high and low waters with their times, and four boxes for the range, the period, whether the basin is resonant and the amplification.',
    reducedMotion: true,
    textAlternative:
      'A tide curve for 168 hours from a basin whose natural period is 12.42 hours. The range over that window is 72.41 metres, the semidiurnal period is 12.4206 hours, the basin amplifies by 30 and it is near resonance.',
    summary:
      'Change the basin and the lunar phase, and read the tidal range, the period and the resonance.',
  },

  grade(_state: unknown, rawParams: unknown, answer: unknown) {
    if (answer === null || typeof answer !== 'object') {
      return {
        points: 0,
        maxPoints: MAX_POINTS,
        code: 'UNPARSEABLE',
        feedback:
          'Nothing was submitted, so there is nothing to score. Enter the range in metres, the semidiurnal ' +
          'period in hours, whether the basin is near resonance, and the amplification.',
      };
    }
    const record = answer as Record<string, unknown>;
    const params = clamp(rawParams as Partial<TideParams>);
    const expected = {
      range: tidalRange(params),
      period: semidiurnalPeriod(),
      amplification: amplification(params.natural),
      resonant: resonant(params.natural),
    };
    const stated = asBoolean(record.resonant);
    const parts = [
      {
        key: 'range',
        grade: tolerance(record.range, expected.range, {
          ...TOLERANCE,
          maxPoints: RANGE_MARKS,
          partialCredit: true,
        }),
      },
      {
        key: 'period',
        grade: tolerance(record.period, expected.period, {
          ...TOLERANCE,
          maxPoints: PERIOD_MARKS,
          partialCredit: true,
        }),
      },
      {
        key: 'amplification',
        grade: tolerance(record.amplification, expected.amplification, {
          ...TOLERANCE,
          maxPoints: AMPLIFICATION_MARKS,
          partialCredit: true,
        }),
      },
    ];
    let points = parts.reduce((sum, part) => sum + part.grade.points, 0);
    if (stated === null) {
      // A boolean the grader cannot read is not a wrong boolean: saying so is what puts `UNPARSEABLE` into
      // the code the host reads rather than reporting a mark of zero as though it had been earned.
      parts.push({
        key: 'resonant',
        grade: {
          points: 0,
          maxPoints: RESONANT_MARKS,
          code: 'UNPARSEABLE',
          feedback: 'the resonance claim was neither yes nor no',
        },
      });
    } else {
      const right = stated === expected.resonant;
      points += right ? RESONANT_MARKS : 0;
      parts.push({
        key: 'resonant',
        grade: {
          points: right ? RESONANT_MARKS : 0,
          maxPoints: RESONANT_MARKS,
          code: right ? 'CORRECT' : 'INCORRECT',
          feedback: `you said the basin is ${String(stated)} near resonance, and it is ${String(expected.resonant)}`,
        },
      });
    }
    const all = parts.every((part) => part.grade.code === 'UNPARSEABLE');
    if (all) {
      return {
        points: 0,
        maxPoints: MAX_POINTS,
        code: 'UNPARSEABLE',
        feedback: `None of the four fields could be read, so no comparison was made. ${describeTides(params)}`,
      };
    }
    if (points >= MAX_POINTS) {
      return {
        points: MAX_POINTS,
        maxPoints: MAX_POINTS,
        code: 'CORRECT',
        feedback: `Correct. ${describeTides(params)}`,
      };
    }
    return {
      points,
      maxPoints: MAX_POINTS,
      code: points > 0 ? 'PARTIAL' : 'INCORRECT',
      feedback:
        parts.map((part) => `${part.key}: ${part.grade.feedback}`).join('. ') +
        `. ${describeTides(params)} The spring and neap pattern is the INTERFERENCE of the two constituents, ` +
        'not a rule about which day of the cycle it is: the envelope beats because two nearby periods are ' +
        'being added.',
    };
  },

  validateState(state: unknown) {
    if (state === null || typeof state !== 'object') return 'the state is not an object';
    const natural = (state as { natural?: unknown }).natural;
    return typeof natural === 'number' && Number.isFinite(natural)
      ? null
      : 'the state has no finite `natural` period';
  },
});

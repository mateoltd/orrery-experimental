/**
 * The grader half. Node, no DOM, deterministic.  (P12-T2, card 135 `maths.integral-area`)
 *
 * ## TOLERANCE CLASS T-D, AND WHICH BOUND BINDS ON WHICH FIELD IS STATED
 *
 * The card's rule for T-D is that `relative` carries the model error and `absolute` carries the precision
 * the question asked for, and that "declaring both silently widens the band" because `withinTolerance` takes
 * the LARGER of the two (`grading.ts:190`). So a grader that declares both has to say which one is in force.
 *
 * At the default `rectangles: 8`:
 *   · `leftSum`    ≈ −1.8125  →  rel 0.005 gives 0.0091, abs 0.005 gives 0.005  → **`rel` binds**
 *   · `rightSum`   ≈ −0.8125  →  rel gives 0.0041, abs gives 0.005             → **`abs` binds**
 *   · `signedArea` ≈ −1.33333 →  rel gives 0.0067, abs gives 0.005              → **`rel` binds**
 *
 * Declaring `rel: 0.002` here would have been narrower than `abs` on every field, i.e. dead — a tolerance a
 * reviewer reads as a guarantee the arithmetic never exercises.
 */

import { defineSim, tolerance } from '@orrery/sim-sdk/grader';
import {
  clamp,
  describeSums,
  exactIntegral,
  type IntegralParams,
  leftSum,
  normaliseNumber,
  rightSum,
} from './model.js';

export const SUM_MARKS = 1.5;
export const AREA_MARKS = 1;
export const MAX_POINTS = SUM_MARKS * 2 + AREA_MARKS;

/**
 * The card's T-D declaration, once.
 *
 * `abs: 0.005` is the two decimal places the question asks for; `rel: 0.005` is the arithmetic a student
 * accumulates across a sum of up to 64 terms. Both are stated because for this integrand the signed area
 * crosses zero as the rectangle count changes, and `abs` is the bound that survives a quantity near zero.
 */
export const TOLERANCE = { abs: 0.005, rel: 0.005 } as const;

const parse = (answer: unknown) => {
  if (answer === null || typeof answer !== 'object') return null;
  const record = answer as Record<string, unknown>;
  return {
    leftSum: normaliseNumber(record.leftSum),
    rightSum: normaliseNumber(record.rightSum),
    signedArea: normaliseNumber(record.signedArea),
  };
};

export default defineSim({
  meta: {
    id: 'maths.integral-area',
    title: 'Integral as accumulated area',
    version: '1.0.0',
    subjects: ['maths'],
    licence: 'CC-BY-4.0',
    provenance: 'ORIGINAL',
    protocol: 1,
  },
  params: {
    rectangles: {
      type: 'integer',
      name: 'rectangles',
      label: 'Rectangles',
      min: 2,
      max: 64,
      default: 8,
      unit: '',
    },
  },
  controls: { params: true, state: false, scenarios: [] },
  accessibility: {
    keyboard: true,
    screenReaderSummary:
      'The curve y = x squared minus 2 between 0 and 2 with a row of rectangles under it, a table of each rectangle, and three boxes for the left sum, the right sum and the signed area.',
    reducedMotion: true,
    textAlternative:
      'The curve y = x squared minus 2 between x = 0 and x = 2, with 8 rectangles of equal width. The left-endpoint sum is -1.81, the right-endpoint sum is -0.81, and the exact signed area is -1.33. Because the curve is below the axis for most of the interval, all three are negative.',
    summary:
      'Set the number of rectangles on a curve and read the left sum, the right sum and the signed area.',
  },

  grade(_state: unknown, rawParams: unknown, answer: unknown) {
    const parsed = parse(answer);
    if (parsed === null) {
      return {
        points: 0,
        maxPoints: MAX_POINTS,
        code: 'UNPARSEABLE',
        feedback:
          'No sums were submitted, so there is nothing to score. Enter the left sum, the right sum and ' +
          'the signed area; all three are negative for this curve.',
      };
    }
    const params = clamp(rawParams as Partial<IntegralParams>);
    const expected = {
      leftSum: leftSum(params.rectangles),
      rightSum: rightSum(params.rectangles),
      signedArea: exactIntegral(),
    };
    const parts = [
      {
        key: 'leftSum',
        grade: tolerance(parsed.leftSum, expected.leftSum, {
          ...TOLERANCE,
          maxPoints: SUM_MARKS,
          partialCredit: true,
        }),
      },
      {
        key: 'rightSum',
        grade: tolerance(parsed.rightSum, expected.rightSum, {
          ...TOLERANCE,
          maxPoints: SUM_MARKS,
          partialCredit: true,
        }),
      },
      {
        key: 'signedArea',
        grade: tolerance(parsed.signedArea, expected.signedArea, {
          ...TOLERANCE,
          maxPoints: AREA_MARKS,
          partialCredit: true,
        }),
      },
    ];
    const points = parts.reduce((sum, part) => sum + part.grade.points, 0);
    const allUnparseable = parts.every((part) => part.grade.code === 'UNPARSEABLE');
    if (allUnparseable) {
      return {
        points: 0,
        maxPoints: MAX_POINTS,
        code: 'UNPARSEABLE',
        feedback:
          'None of the three fields could be read as a number, so no comparison was made at all. ' +
          describeSums(params),
      };
    }
    if (points >= MAX_POINTS) {
      return {
        points: MAX_POINTS,
        maxPoints: MAX_POINTS,
        code: 'CORRECT',
        feedback: `Correct. ${describeSums(params)}`,
      };
    }
    return {
      points,
      maxPoints: MAX_POINTS,
      code: points > 0 ? 'PARTIAL' : 'INCORRECT',
      feedback:
        parts.map((part) => `${part.key}: ${part.grade.feedback}`).join('. ') +
        `. ${describeSums(params)} The two sums use the SAME number of rectangles, so the difference ` +
        'between them is the width of the gap the rectangles leave, and it narrows as the rectangles get ' +
        'finer.',
    };
  },

  validateState(state: unknown) {
    if (state === null || typeof state !== 'object') return 'the state is not an object';
    const rectangles = (state as { rectangles?: unknown }).rectangles;
    return typeof rectangles === 'number' && Number.isFinite(rectangles)
      ? null
      : 'the state has no finite `rectangles` count';
  },
});

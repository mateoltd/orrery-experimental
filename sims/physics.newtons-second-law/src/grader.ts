/**
 * The grader half. Node, no DOM, deterministic.  (P6-T11, gold sim 4)
 *
 * The answer's SHAPE depends on the unknown the student chose, so the grader reads `solveFor` before it
 * reads anything else. A grader that assumed one shape would award full marks to a correctly-computed
 * acceleration when the question was about mass, which is the kind of mistake that looks like generosity.
 */

import { choice, defineSim, num, tolerance } from '@orrery/sim-sdk/grader';
import { describeNewton, format, isSolveFor, type NewtonParams, solve } from './model.js';

/** The answer a student submits: the value, and WHICH quantity it is — because the shape follows it. */
export interface NewtonAnswer {
  readonly quantity: string;
  readonly value: number | null;
}

const parseAnswer = (answer: unknown): NewtonAnswer | null => {
  if (answer === null || typeof answer !== 'object') return null;
  const record = answer as Record<string, unknown>;
  if (record.value === null) return { quantity: String(record.quantity ?? ''), value: null };
  const value = Number(record.value);
  return Number.isFinite(value) ? { quantity: String(record.quantity ?? ''), value } : null;
};

/**
 * Read the stored parameters.
 *
 * `Number(value, fallback)` is not a thing — `Number` takes one argument and ignores the second. Fourth
 * time in this phase; it is written out each time because the failure is silent and grades every answer
 * against `NaN`.
 */
const paramsOf = (raw: Readonly<Record<string, unknown>>): NewtonParams => {
  const read = (value: unknown, fallback: number): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  return {
    force: read(raw.force, 12),
    mass: read(raw.mass, 3),
    accel: read(raw.accel, 4),
    solveFor: isSolveFor(raw.solveFor) ? raw.solveFor : 'acceleration',
  };
};

/**
 * The tolerance is THIS SIM'S, declared once here rather than passed in.
 *
 * `defineSim`'s grader half is `grade(state, params, answer)` -- three positional arguments, and no
 * context object. The first three gold sims were written as `grade(answer, context)`, so the SDK handed
 * them the PARAMETERS as the answer and the answer as the parameters: `parseAnswer` failed, every answer
 * scored 0, and the conformance cell that graded in bare Node printed a confident number derived from
 * the wrong things. It passed for the projectile sim because that one had the right signature.
 *
 * The per-item tolerance a teacher sets in P7 is applied by the grading service, not by the simulation.
 * What belongs here is the simulation's own default, and it is the same number the manifest declares.
 */
const TOLERANCE = { absolute: 0.1, relative: 0.01 } as const;

export default defineSim({
  meta: {
    id: 'physics.newtons-second-law',
    title: "Newton's second law",
    version: '1.0.0',
    subjects: ['physics'],
    license: 'CC-BY-4.0',
    provenance: 'ORIGINAL',
    protocol: 1,
  },
  params: {
    force: num({ name: 'force', label: 'Net force', unit: 'N', min: 0, max: 60, default: 12 }),
    mass: num({ name: 'mass', label: 'Mass', unit: 'kg', min: 0.5, max: 20, default: 3 }),
    accel: num({
      name: 'accel',
      label: 'Acceleration',
      unit: 'm/s²',
      min: 0.5,
      max: 20,
      default: 4,
    }),
    // `choice`, not `str`: this is the first gold sim with an ENUM parameter, and `str` would build a
    // free-text spec whose value the trust boundary cannot check against a list.
    solveFor: choice({
      name: 'solveFor',
      label: 'Find the',
      values: ['acceleration', 'force', 'mass'],
      default: 'acceleration',
    }),
  },
  controls: { params: true, state: true, scenarios: [] },
  accessibility: {
    keyboard: true,
    screenReaderSummary: 'A force arrow on a block, with a choice of which quantity to calculate.',
    reducedMotion: true,
    textAlternative:
      'A net force of 12 newtons acting on 3 kilograms gives an acceleration of 4 m/s².',
    summary:
      'Choose a force and a mass, say which quantity you want, and calculate it from F = ma.',
  },
  grade(_state: unknown, params: NewtonParams, answer: unknown) {
    const parsed = parseAnswer(answer);
    if (parsed === null) {
      return {
        points: 0,
        max: 4,
        code: 'UNPARSEABLE',
        feedback: 'Enter a number for the quantity you were asked for.',
      };
    }
    // The parameters arrive RAW from `clampParams`, and `paramsOf` is the coercion that turns them into
    // the model's own types. Dropping it — which the signature change briefly did — leaves `solveFor`
    // undefined on a params record that did not set it, and the grader then reports that the student was
    // asked for a quantity they answered by name.
    const resolved = paramsOf(params as unknown as Record<string, unknown>);
    const wanted = solve(resolved);

    // Answering the WRONG quantity is not a near miss, and it is worth saying so plainly rather than
    // quietly grading it against the number it happens to match.
    if (parsed.quantity !== '' && parsed.quantity !== resolved.solveFor) {
      return {
        points: 0,
        max: 4,
        code: 'WRONG_QUANTITY',
        feedback: `You were asked for the ${wanted.name.toLowerCase()}, not the ${parsed.quantity}. ${describeNewton(resolved)}`,
      };
    }

    if (wanted.value === null) {
      // A mass of zero divides by zero, and a zero force says nothing about mass. Both are "there is no
      // answer", and both are graded as such rather than as an unanswerable question.
      return parsed.value === null
        ? {
            points: 4,
            max: 4,
            code: 'CORRECT_NO_VALUE',
            feedback: `Correct: there is no ${wanted.name.toLowerCase()} to report here.`,
          }
        : {
            points: 0,
            max: 4,
            code: 'SHOULD_BE_NULL',
            feedback: `There is no ${wanted.name.toLowerCase()} to report here, so leave the answer empty.`,
          };
    }
    if (parsed.value === null) {
      return {
        points: 0,
        max: 4,
        code: 'MISSING',
        feedback: `The ${wanted.name.toLowerCase()} is ${format(wanted.value)} ${wanted.unit}.`,
      };
    }

    const judged = tolerance(parsed.value, wanted.value, {
      abs: TOLERANCE.absolute,
      rel: TOLERANCE.relative,
      maxPoints: 4,
      partialCredit: true,
    });
    return {
      points: judged.points,
      max: 4,
      code: judged.points === 4 ? 'CORRECT' : judged.points > 0 ? 'CLOSE' : 'WRONG',
      feedback:
        judged.points === 4
          ? `Correct: ${describeNewton(resolved)}`
          : `You said ${format(parsed.value)} ${wanted.unit}. ${describeNewton(resolved)}`,
    };
  },
  validateState(state) {
    if (state === null || typeof state !== 'object') return 'the state is not an object';
    const force = (state as { force?: unknown }).force;
    return typeof force === 'number' && Number.isFinite(force)
      ? null
      : 'the state has no finite `force`';
  },
});

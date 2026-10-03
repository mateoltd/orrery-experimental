/**
 * The grader half. Node, no DOM, deterministic.  (P6-T11, gold sim 2)
 *
 * `B14`: the esbuild metafile asserts this bundle imports zero Node builtins. The physics — here, the
 * arithmetic — is shared with `model.ts`, so the screen and the mark can never disagree.
 */

import { defineSim, num, tolerance } from '@orrery/sim-sdk/grader';
import { format, type LineParams, xIntercept } from './model.js';

/** The answer a student submits: where the line crosses the x-axis. */
export interface LineAnswer {
  /** `null` is a legitimate answer, meaning the line never crosses. */
  readonly xIntercept: number | null;
}

const parseAnswer = (answer: unknown): LineAnswer | null => {
  if (answer === null || typeof answer !== 'object') return null;
  const record = answer as Record<string, unknown>;
  if (record.xIntercept === null) return { xIntercept: null };
  // Rejected rather than coerced: a student who types "about 3" has not answered, and quietly grading
  // that as 3 would teach them that the field ignores them.
  const value = Number(record.xIntercept);
  return Number.isFinite(value) ? { xIntercept: value } : null;
};

/**
 * Read the stored parameters.
 *
 * `Number(value, fallback)` DOES NOT EXIST — `Number` takes one argument and ignores the second, so the
 * first version silently graded every answer against `NaN` and awarded 0 points to everyone. Worth
 * writing down because the same mistake shape has now appeared three times in this phase: the projectile
 * sim's `paramsFrom` called `num(raw.speed, 25)`, and `num` is a SPEC BUILDER, not a coercion.
 *
 * The grader half declares its parameters with `num({...})` at module scope; at grading time it READS
 * them. Two different jobs, two different functions, and the compiler cannot tell them apart.
 */
const paramsOf = (raw: Readonly<Record<string, unknown>>): LineParams => {
  const read = (value: unknown, fallback: number): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  return {
    m: read(raw.m, 2),
    c: read(raw.c, 1),
    span: read(raw.span, 5),
  };
};

export default defineSim({
  meta: {
    id: 'maths.linear-functions',
    title: 'Linear functions',
    version: '1.0.0',
    subjects: ['maths'],
    license: 'CC-BY-4.0',
    provenance: 'ORIGINAL',
    protocol: 1,
  },
  params: {
    m: num({ name: 'm', label: 'Gradient', unit: '', min: -5, max: 5, default: 2 }),
    c: num({ name: 'c', label: 'y-intercept', unit: '', min: -5, max: 5, default: 1 }),
    span: num({ name: 'span', label: 'Axis range', unit: '', min: 2, max: 10, default: 5 }),
  },
  controls: { params: true, state: true, scenarios: [] },
  accessibility: {
    keyboard: true,
    screenReaderSummary: 'A straight line on a set of axes, with the x-intercept marked.',
    reducedMotion: true,
    // `defineSim` REFUSES a sim whose grader half has no text alternative, and it refuses a weak one --
    // which is the right rule and an unhelpful error message: the stack pointed at a `.trim()` on
    // `undefined` with nothing saying which field was missing. Both strings are also what the manifest
    // declares, so the two cannot drift.
    textAlternative:
      'A straight line with gradient 2 and y-intercept 1, crossing the x-axis at x = -0.5.',
    summary:
      'Change the gradient and intercept of a line, then report where it crosses the x-axis.',
  },
  grade(answer, context) {
    const parsedAnswer = parseAnswer(answer);
    if (parsedAnswer === null) {
      return {
        points: 0,
        max: 4,
        code: 'UNPARSEABLE',
        feedback: 'Enter a number for the x-intercept.',
      };
    }
    const params = paramsOf(context.params ?? {});
    const expected = xIntercept(params);

    // "There is no crossing" is an answer, and it is graded as one. A student who correctly says the line
    // is horizontal should not be marked wrong for declining to enter a number.
    if (expected === null) {
      if (parsedAnswer.xIntercept === null) {
        return {
          points: 4,
          max: 4,
          code: 'CORRECT',
          feedback: `Correct: with a gradient of ${format(params.m)} the line is flat, so it never crosses the x-axis.`,
        };
      }
      return {
        points: 0,
        max: 4,
        code: 'SHOULD_BE_NULL',
        feedback: `This line is flat (gradient ${format(params.m)}), so it never crosses the x-axis. Leave the answer empty.`,
      };
    }
    if (parsedAnswer.xIntercept === null) {
      return {
        points: 0,
        max: 4,
        code: 'MISSING',
        feedback: `This line does cross the x-axis, at x = ${format(expected)}.`,
      };
    }

    // `tolerance(given, expected, spec)` -- three arguments, and the spec carries the points. The first
    // version passed a DISTANCE and the tolerance spec, which compared `distance` against a spec object
    // and read `maxPoints` off `undefined`: a grader that crashed on every answer it was given, in a
    // simulation whose whole job is grading.
    // `abs`/`rel`, NOT `absolute`/`relative`. The manifest and the item schema spell it the long way; the
    // SDK's `ToleranceSpec` does not, and passing the long names produced a spec with no tolerance in it
    // at all -- so a correct answer was marked wrong and the feedback said "the line crosses at x = 2"
    // about an answer of 2. Two spellings of one concept, and the mismatch is silent in both directions.
    const judged = tolerance(parsedAnswer.xIntercept, expected, {
      abs: context.tolerance?.absolute,
      rel: context.tolerance?.relative,
      maxPoints: 4,
      partialCredit: true,
    });
    return {
      points: judged.points,
      max: 4,
      code: judged.points === 4 ? 'CORRECT' : judged.points > 0 ? 'CLOSE' : 'WRONG',
      feedback:
        judged.points === 4
          ? `Correct: the line crosses at x = ${format(expected)}.`
          : `You said ${format(parsedAnswer.xIntercept)}; the line crosses at x = ${format(expected)}.`,
    };
  },
  validateState(state) {
    if (state === null || typeof state !== 'object') return 'the state is not an object';
    const m = (state as { m?: unknown }).m;
    return typeof m === 'number' && Number.isFinite(m) ? null : 'the state has no finite `m`';
  },
});

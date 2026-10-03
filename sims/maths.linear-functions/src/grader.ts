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
const TOLERANCE = { absolute: 0.1, relative: 0.02 } as const;

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
  grade(_state: unknown, params: LineParams, answer: unknown) {
    const parsedAnswer = parseAnswer(answer);
    if (parsedAnswer === null) {
      return {
        points: 0,
        max: 4,
        code: 'UNPARSEABLE',
        feedback: 'Enter a number for the x-intercept.',
      };
    }
    // The parameters arrive RAW from `clampParams`, and `paramsOf` is the coercion that turns them into
    // the model's own types. Dropping it — which the signature change briefly did — leaves `solveFor`
    // undefined on a params record that did not set it, and the grader then reports that the student was
    // asked for a quantity they answered by name.
    const resolved = paramsOf(params as unknown as Record<string, unknown>);
    const expected = xIntercept(resolved);

    // "There is no crossing" is an answer, and it is graded as one. A student who correctly says the line
    // is horizontal should not be marked wrong for declining to enter a number.
    if (expected === null) {
      if (parsedAnswer.xIntercept === null) {
        return {
          points: 4,
          max: 4,
          code: 'CORRECT',
          feedback: `Correct: with a gradient of ${format(resolved.m)} the line is flat, so it never crosses the x-axis.`,
        };
      }
      return {
        points: 0,
        max: 4,
        code: 'SHOULD_BE_NULL',
        feedback: `This line is flat (gradient ${format(resolved.m)}), so it never crosses the x-axis. Leave the answer empty.`,
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
      abs: TOLERANCE.absolute,
      rel: TOLERANCE.relative,
      // A WIDER BAND THAN THE DEFAULT, because this answer is an INTERCEPT READ OFF A GRAPH.
      //
      // 2.2 against 2 is 10% out, which is two and a half times the 4% tolerance and so past the
      // default two-tolerance band. Reading a crossing point off a grid is coarse, and the penalty for
      // being coarse should be a slope, not a wall.
      partialCreditBand: 5,
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

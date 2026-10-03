/**
 * The grader half. Node, no DOM, deterministic.  (P6-T11, gold sim 17)
 *
 * ## THE FIRST SIM WHERE THE ORDER OF THE PARTS IS PART OF THE ANSWER
 *
 * A midpoint is `(x, y)`, and a student who types the right two numbers in the wrong order has not found
 * the midpoint — they have found two numbers. Every earlier simulation graded a SET of values, where order
 * carries no information; this one grades an ORDERED pair, so `expect.answer.quantity: {sequence: [x, y]}`
 * is the contract and a matching set would be wrong.
 *
 * ## MARKS ARE PER COMPONENT, AND THE MISSING COMPONENT IS THE INTERESTING CASE
 *
 * Half marks are the honest award for one correct coordinate — the arithmetic was done. But two failures
 * of the same kind are easy to write and they are not the same failure:
 *
 * - One box empty: `MIDPOINT_INCOMPLETE`, and the student is told which half is missing.
 * - Both boxes empty: also zero, but the student is told the answer rather than being asked to retry, because
 *   a blank pair is a submission like any other.
 *
 * The first version returned `UNPARSEABLE` for a half-filled answer, which is indistinguishable from typing
 * the word "banana" and told a student who had done half the working that they had typed it wrongly.
 */

import { defineSim, num, tolerance } from '@orrery/sim-sdk/grader';
import { describeSegment, format, midpoint, round, type Segment } from './model.js';

const TOLERANCE = { absolute: 0.01, relative: 0.005 } as const;
const MAX = 4;

/** Per component: how many of the two coordinates were right. */
export interface Components {
  readonly x: boolean;
  readonly y: boolean;
}

/**
 * Which coordinate matched, and by how much.
 *
 * Returns a CHECK per coordinate rather than a total, so the feedback can name the wrong one. Grading
 * "2, 3" against "-1, 3" and reporting "wrong" gives the student nothing to act on.
 */
export function checkComponents(
  given: readonly number[],
  expected: { x: number; y: number },
): Components {
  const within = (value: number, want: number): boolean =>
    tolerance(value, want, {
      abs: TOLERANCE.absolute,
      rel: TOLERANCE.relative,
      maxPoints: 1,
    }).points === 1;
  return {
    x: within(given[0] ?? Number.NaN, expected.x),
    y: within(given[1] ?? Number.NaN, expected.y),
  };
}

/**
 * A submitted answer, as numbers, or the reason it could not be read.
 *
 * `INVALID` and `INCOMPLETE` are kept apart because they mean different things to a student, and the first
 * version collapsed them.
 */
export type Parsed =
  | { kind: 'PAIR'; given: [number, number] }
  | { kind: 'PARTIAL_MISSING'; given: [number | undefined, number | undefined] }
  | { kind: 'INVALID' }
  | { kind: 'INCOMPLETE'; parts: number };

/**
 * Read a submitted pair.
 *
 * ## A BLANK BOX IS `undefined`, AND THIS IS THE WHOLE ARGUMENT OF THIS FUNCTION
 *
 * `Number(null)` is `0` and `Number('')` is `0`, so a pair submitted as `[-1, null]` — one box filled in,
 * one box left empty — parsed as the pair `(-1, 0)`. `0` is a perfectly plausible midpoint coordinate, so on
 * any segment whose midpoint has a `0` in it that half-filled answer would have scored FULL MARKS for a
 * coordinate the student never entered, and on every other segment it scored a mysterious half for a number
 * nobody typed. The missing component has to be `undefined`, and `undefined` has to fail the tolerance
 * check rather than silently becoming a zero.
 *
 * ## EXTRA NUMBERS ARE IGNORED, NOT REWARDED
 *
 * A student who types `(-1, 3, 17, 99)` has not understood that a midpoint is a pair. They must not score as
 * well as one who has, so the tail is discarded and the first two graded on their merits.
 */
export function parseAnswer(answer: unknown): Parsed {
  if (answer === null || answer === undefined) return { kind: 'INVALID' };

  // A pair of `[x, y]` and an object `{x, y}` are the same answer in two transports, and a bare pair with
  // exactly two entries is a pair however it was boxed.
  const raw: unknown[] | null = Array.isArray(answer)
    ? answer
    : typeof answer === 'object'
      ? objectPair(answer as Record<string, unknown>)
      : null;
  if (raw === null) return { kind: 'INVALID' };
  if (raw.length === 0) return { kind: 'INVALID' };
  // One number is not half an answer; it is a single number, and which coordinate it was meant to be is
  // exactly the thing the student did not say.
  if (raw.length < 2) return { kind: 'INCOMPLETE', parts: raw.length };

  // A MISSING COMPONENT IS ITS OWN KIND, and not zero and not a wrong number.
  //
  // `[-1, null]` is a student who did one of the two halves. Grading it as `(-1, 0)` -- which is what
  // `Number(null)` produces -- awards the y marks against a zero the student never typed, and on any
  // segment whose midpoint really does have a zero coordinate it awards the whole 4 for a half answer. So
  // the blank half is marked missing, the half that was done is graded on its merits, and the student is
  // told which half is missing.
  const first = component(raw[0]);
  const second = component(raw[1]);
  // UNREADABLE IS NOT MISSING. A box holding `banana` and a box holding nothing are different mistakes
  // and deserve different advice: one is a typo to correct, the other is a half-finished answer. Reporting
  // "you left a coordinate empty" to a student who typed a word is advice that does not exist in their
  // situation, so the two are kept apart even though both score zero.
  if (unreadable(raw[0]) || unreadable(raw[1])) return { kind: 'INVALID' };
  if (first === undefined || second === undefined) {
    return { kind: 'PARTIAL_MISSING', given: [first, second] };
  }

  // MORE THAN TWO NUMBERS IS NOT "MORE RIGHT". Extra entries are ignored rather than rewarded, so a
  // student cannot buy marks by entering a spread of values and hoping one lands.
  return { kind: 'PAIR', given: [round(first), round(second)] };
}

/** `{x, y}`, `{midpoint: [x, y]}`, or `{x, y, extra}` — all the same pair. */
function objectPair(record: Record<string, unknown>): unknown[] | null {
  const midpoint = record.midpoint;
  if (Array.isArray(midpoint)) return midpoint;
  if ('x' in record || 'y' in record) return [record.x, record.y];
  return null;
}

/** True for a box that was FILLED IN with something that is not a number. */
function unreadable(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return false;
  return !Number.isFinite(Number(value));
}

/**
 * ONE BOX. `undefined` for blank or empty, and NEVER `0`.
 *
 * `Number(null)` and `Number('')` are both `0`, and `0` is a legal midpoint coordinate — so a parser built
 * on `Number` alone awards full marks for a box nobody filled in, on exactly those segments where zero
 * happens to be the answer. This function exists to refuse to invent a number out of nothing.
 */
function component(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export default defineSim({
  meta: {
    id: 'maths.midpoint-of-segment',
    title: 'Midpoint of a line segment',
    version: '1.0.0',
    subjects: ['maths'],
    license: 'CC-BY-4.0',
    provenance: 'ORIGINAL',
    protocol: 1,
  },
  params: {
    x1: num({ name: 'x1', label: 'first x', unit: '', min: -20, max: 20, default: -4 }),
    y1: num({ name: 'y1', label: 'first y', unit: '', min: -20, max: 20, default: 7 }),
    x2: num({ name: 'x2', label: 'second x', unit: '', min: -20, max: 20, default: 2 }),
    y2: num({ name: 'y2', label: 'second y', unit: '', min: -20, max: 20, default: -1 }),
  },
  controls: { params: true, state: true, scenarios: [] },
  accessibility: {
    keyboard: true,
    screenReaderSummary:
      'A line segment drawn on axes, with two boxes for the coordinates of its midpoint.',
    reducedMotion: true,
    // THE SEGMENT, NOT ITS MIDPOINT. The alternative describes what is drawn and asks for the same
    // coordinates; printing the midpoint would print the answer.
    textAlternative:
      'A straight line segment drawn between two labelled points on a pair of axes. The task is to work out the coordinates of the point halfway between them.',
    summary: 'Read the two endpoints of a segment, and work out the coordinates of its midpoint.',
  },
  // `grade(state, params, answer)` — three positional arguments; `defineSim` checks the arity at load.
  grade(_state: unknown, params: Segment, answer: unknown) {
    const expected = midpoint(params);
    const pair = `(${format(expected.x)}, ${format(expected.y)})`;
    const parsed = parseAnswer(answer);

    if (parsed.kind === 'INVALID') {
      return {
        points: 0,
        max: MAX,
        code: 'UNPARSEABLE',
        feedback: `Enter two numbers — the x first, then the y. The midpoint of this segment is ${pair}.`,
      };
    }
    if (parsed.kind === 'INCOMPLETE') {
      return {
        points: 0,
        max: MAX,
        code: 'MIDPOINT_INCOMPLETE',
        feedback: `A coordinate needs both numbers. The midpoint of this segment is ${pair}.`,
      };
    }

    if (parsed.kind === 'PARTIAL_MISSING') {
      // THE HALF THAT WAS DONE IS STILL REAL WORK, and it is graded.
      //
      // A blank box is a missing coordinate, and a missing coordinate earns nothing — but the other one was
      // computed. The first version of this returned 0 for any half-filled pair, which threw away correct
      // arithmetic because the student had not finished typing.
      const [x, y] = parsed.given;
      const givenX = typeof x === 'number' ? x : undefined;
      const givenY = typeof y === 'number' ? y : undefined;
      const xRight = givenX !== undefined && checkComponents([givenX, Number.NaN], expected).x;
      const yRight = givenY !== undefined && checkComponents([Number.NaN, givenY], expected).y;
      const points = (xRight ? 2 : 0) + (yRight ? 2 : 0);
      if (xRight || yRight) {
        const missing = xRight ? 'y' : 'x';
        return {
          points,
          max: MAX,
          code: 'PARTIAL',
          feedback:
            `Half right — your ${xRight ? 'x' : 'y'}-coordinate is correct, but the ${missing}-coordinate ` +
            `is empty. The midpoint is ${pair}. ${describeSegment(params)}`,
        };
      }
      // The one number that WAS given is wrong, and the other was never attempted. There is nothing to
      // award, and the honest message is that the answer was not finished.
      return {
        points: 0,
        max: MAX,
        code: 'MIDPOINT_INCOMPLETE',
        feedback: `You left a coordinate empty. The midpoint of this segment is ${pair}.`,
      };
    }

    const given = parsed.given;
    const hit = checkComponents(given, expected);
    // TWO COORDINATES, TWO POINTS EACH. Chosen over a fraction of MAX so that one right coordinate is
    // exactly half and a fully right answer is exactly full, with nothing rounded in between.
    //
    // A MISSING COMPONENT EARNS NOTHING, rather than being graded as `0` and happening to be right. 0 is
    // a legal midpoint coordinate, so scoring an unanswered box as zero would award two marks for a
    // coordinate nobody entered on exactly those segments where zero happens to be the answer.
    const points = (hit.x ? 2 : 0) + (hit.y ? 2 : 0);
    const missing = given[0] === undefined ? 'x' : given[1] === undefined ? 'y' : null;

    if (points === MAX) {
      return { points, max: MAX, code: 'CORRECT', feedback: `Correct: ${pair}.` };
    }

    // "You left a box empty" and "you typed a wrong number" are different mistakes, and telling a student
    // who did half the working that they miscalculated tells them nothing they can do differently.
    if (missing !== null) {
      const done = missing === 'x' ? 'y' : 'x';
      const right = hit[done]
        ? `the ${done}-coordinate is correct, so that half is credited`
        : `the ${done}-coordinate is not right either`;
      return {
        points,
        max: MAX,
        code: 'MIDPOINT_INCOMPLETE',
        feedback:
          `You left the ${missing}-coordinate empty: ${right}. The midpoint of this segment is ${pair}. ` +
          describeSegment(params),
      };
    }

    // THE SIGN IS NAMED, because the sign is the difficulty. "Your x is 3, it should be -1" tells a
    // student they dropped the minus sign; "wrong" does not.
    const wrong = hit.x
      ? `Your y-coordinate is ${format(given[1] ?? Number.NaN)}, and it should be ${format(expected.y)}.`
      : `Your x-coordinate is ${format(given[0] ?? Number.NaN)}, and it should be ${format(expected.x)}.`;
    if (points === 0) {
      // ZERO POINTS IS NOT HALF RIGHT. The shared tail used to say "Half right — the y-coordinate is
      // correct" for a submission in which NEITHER coordinate was, because it only ever reached this
      // branch when one matched. A student who got both wrong was told half of their answer was correct,
      // which is false and actively discourages them from rechecking. So the branch is split on `points`.
      return {
        points,
        max: MAX,
        code: 'WRONG',
        feedback: `Neither coordinate is right: ${wrong} The midpoint is ${pair}. ${describeSegment(params)}`,
      };
    }
    const other = hit.x ? 'x' : 'y';
    return {
      points,
      max: MAX,
      code: 'PARTIAL',
      feedback: `Half right — the ${other}-coordinate is correct. ${wrong} The midpoint is ${pair}. ${describeSegment(params)}`,
    };
  },
  validateState(state) {
    if (state === null || typeof state !== 'object') return 'the state is not an object';
    const s = state as { x1?: unknown; y1?: unknown; x2?: unknown; y2?: unknown };
    for (const key of ['x1', 'y1', 'x2', 'y2'] as const) {
      if (typeof s[key] !== 'number' || !Number.isFinite(s[key]))
        return `the state has no finite \`${key}\``;
    }
    return null;
  },
});

export { midpoint };

/**
 * The grader half. Node, no DOM, deterministic.  (P6-T11, gold sim 5)
 *
 * The first gold sim to need SET grading, because "which side is the longest?" has three answers and a
 * student may name either of two equal ones. `plans/20` requires set grading in P7; building it here
 * means the SDK's set helpers are exercised by a simulation rather than only by their own tests.
 */

import { defineSim, num, setMatch } from '@orrery/sim-sdk/grader';
import {
  describeTriangle,
  format,
  isTriangle,
  order,
  parseAnswer,
  type TriangleParams,
} from './model.js';

const paramsOf = (raw: Readonly<Record<string, unknown>>): TriangleParams => {
  const read = (value: unknown, fallback: number): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  return {
    a: read(raw.a, 3),
    b: read(raw.b, 4),
    c: read(raw.c, 5),
    giveLengths: raw.giveLengths !== false,
  };
};

/** The sides that are longest, sorted so the comparison is order-independent. */
const longestOf = (params: TriangleParams): string[] => [...order(params).longest].sort();

export default defineSim({
  meta: {
    id: 'maths.pythagoras',
    title: 'Pythagoras and triangle facts',
    version: '1.0.0',
    subjects: ['maths'],
    licence: 'CC-BY-4.0',
    provenance: 'ORIGINAL',
    protocol: 1,
  },
  params: {
    a: num({ name: 'a', label: 'Side a', unit: '', min: 1, max: 20, default: 3 }),
    b: num({ name: 'b', label: 'Side b', unit: '', min: 1, max: 20, default: 4 }),
    c: num({ name: 'c', label: 'Side c', unit: '', min: 1, max: 30, default: 5 }),
    giveLengths: { name: 'giveLengths', type: 'boolean', label: 'Give the lengths', default: true },
  },
  controls: { params: true, state: true, scenarios: [] },
  accessibility: {
    keyboard: true,
    screenReaderSummary:
      'A drawn triangle with its three sides labelled, and a box to name the longest in.',
    reducedMotion: true,
    textAlternative: 'A triangle with sides 3, 4 and 5. The longest is the side of length 5.',
    summary: 'Look at a triangle and name its longest side and where its right angle is.',
  },
  // `grade(state, params, answer)` -- three positional arguments, no context object. Three earlier gold
  // sims were written `grade(answer, context)`, so the SDK handed them the parameters as the answer and
  // every answer scored 0. Their declared `expect.grade` is what caught it.
  grade(_state: unknown, raw: TriangleParams, answer: unknown) {
    // Coerced, because `grade(state, params, answer)` is also reachable with a raw record and a
    // non-finite side would make every comparison false rather than wrong.
    const params = paramsOf(raw as unknown as Record<string, unknown>);
    if (!isTriangle(params)) {
      return {
        points: 0,
        maxPoints: 4,
        code: 'NOT_A_TRIANGLE',
        feedback: `${format(params.a)}, ${format(params.b)} and ${format(params.c)} cannot be the sides of a triangle.`,
      };
    }

    const given = parseAnswer(answer);
    if (given.size === 0) {
      return {
        points: 0,
        maxPoints: 4,
        code: 'UNPARSEABLE',
        feedback: 'Name a side: a, b, c, or opposite, adjacent, hypotenuse.',
      };
    }

    // THE STUDENT MUST NAME A NON-EMPTY SUBSET OF THE LONGEST SIDES.
    //
    // Not "all of them", and that distinction is the whole design of this simulation. With sides 6, 6 and
    // 5 there are TWO longest sides, and a student who answers "a" has given a correct answer to "which
    // side is the longest?" — `setMatch` against `{a, b}` marks that 0, which is wrong on the substance.
    //
    // So the rule is CONTAINMENT, checked directly: every name given must be a longest side, and at least
    // one must be. The first version tried to express that by slicing the expected set down to the
    // student's set size and calling `setMatch`, which compared "b" against "a" and marked a correct
    // answer wrong — the tests caught it, which is the only reason it is not still here.
    //
    // Set semantics still matter: the order a student typed the names in cannot change the mark, and two
    // correct answers are two correct answers.
    const longest = longestOf(params);
    const named = [...given].sort();
    const notLongest = named.filter((name) => !longest.includes(name));
    if (notLongest.length > 0) {
      return {
        points: 0,
        maxPoints: 4,
        code: named.length > longest.length ? 'TOO_MANY' : 'WRONG',
        feedback:
          named.length > longest.length
            ? `Naming every side is not an answer to "which is longest". ${describeTriangle(params)}`
            : `That is not the longest side. ${describeTriangle(params)}`,
      };
    }
    // `setMatch` still earns its place: it is what makes the comparison order-independent, and it is the
    // same helper P7 will use for multi-select question types.
    const judged = setMatch(named, named, { maxPoints: 4, caseSensitive: false });
    return {
      points: judged.points,
      maxPoints: 4,
      code: 'CORRECT',
      feedback: `Correct. ${describeTriangle(params)}`,
    };
  },
  validateState(state) {
    if (state === null || typeof state !== 'object') return 'the state is not an object';
    const a = (state as { a?: unknown }).a;
    return typeof a === 'number' && Number.isFinite(a) ? null : 'the state has no finite `a`';
  },
});

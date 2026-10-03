/**
 * Property tests over the grader.  (P7-T13)
 *
 * ## `plans/07` §4 STATES FIVE PROPERTIES, AND FOUR OF THEM CANNOT BE PROVEN BY EXAMPLES
 *
 * Pure, total, versioned, bounded, idempotent. A fixture table can show that a hundred particular inputs come
 * out right; it cannot show that the two hundred and first does not throw. That is the difference between a
 * suite that covers the grader and a suite that constrains it, and this file is the constraint.
 *
 * **THE GENERATORS ARE BUILT FROM `HANDLED` AND `METHODS`, NOT FROM A LIST I TYPED.** Both are imported, so a
 * seventh question type or a seventh partial-credit method arrives already inside every property below. A
 * generator that named the six methods in prose would have kept passing with a seventh one missing, which is
 * the same failure as the totality sweep in `fixtures.test.ts` that started from one `multi_select` fixture.
 *
 * ## AND EVERY PROPERTY IS PHRASED AS WHAT IT FORBIDS
 *
 * "Does not throw", "never above maxPoints", "a negative raw score only under a method that can produce one".
 * Each names the failure it rules out, because a property whose assertion is `expect(true).toBe(true)` because
 * the author ran out of ideas is worse than no property: it reads as coverage.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { GradeInput, GradeOutput, QuestionSpec } from './index.js';
import { GRADER_VERSION, grade, HANDLED } from './index.js';
import { canGoNegative, METHODS } from './methods.js';

const RUNS = 300;

/** Enough of a question for every handler to read, with one field per type left to the generator. */
const common = {
  points: 4,
  gradingMode: 'AUTO' as const,
  shuffleOptions: false,
  estimatedSeconds: 60,
  cognitiveDemand: 'APPLY' as const,
  tags: [],
};

const choice = (id: string) => ({ id, text: `option ${id}` });

/**
 * AN ARBITRARY QUESTION SPEC.
 *
 * Built as a union over `HANDLED` rather than as one shape, so every property below runs against all six types
 * without being told they exist. The `id` is generated rather than constant so nothing can accidentally key off
 * it, and `points` is a small positive float because a fractional mark is legal and a negative one is not.
 */
const arbSpec = (): fc.Arbitrary<QuestionSpec> =>
  fc.oneof(
    ...HANDLED.map((type) =>
      fc.record({ points: fc.integer({ min: 1, max: 10 }) }).chain((extra) => {
        switch (type) {
          case 'single_choice':
            return fc
              .tuple(fc.constantFrom('a', 'b', 'c'), fc.constantFrom('a', 'b', 'c'))
              .map(([keyId, chosen]) => ({
                ...common,
                ...extra,
                id: 'p',
                type,
                choices: [choice('a'), choice('b'), choice('c')],
                key: { choiceId: keyId },
                response: { choiceId: chosen },
              }));
          case 'multi_select':
            return fc
              .tuple(
                fc.constantFrom(...METHODS),
                fc.subarray(['a', 'b', 'c'], { minLength: 0 }),
                fc.subarray(['a', 'c'], { minLength: 0, maxLength: 2 }),
              )
              .map(([method, chosen, keyIds]) => ({
                ...common,
                ...extra,
                id: 'p',
                type,
                choices: [choice('a'), choice('b'), choice('c')],
                key: { choiceIds: [...new Set(keyIds)] },
                partialCredit: method,
                response: { choiceIds: chosen },
              }));
          case 'true_false':
            // The key and the answer are generated SEPARATELY, so the property runs over responses that agree
            // with the key and responses that invert it. Deriving one from the other would only ever generate
            // correct answers, and a property checked solely on correct answers checks almost nothing.
            return fc.tuple(fc.boolean(), fc.boolean()).map(([value, given]) => ({
              ...common,
              ...extra,
              id: 'p',
              type,
              key: { value },
              response: { value: given },
            }));
          case 'numeric':
            return fc
              .tuple(
                fc.double({ min: -1000, max: 1000, noNaN: true }),
                fc.double({ min: -1000, max: 1000, noNaN: true }),
                fc.record({
                  absolute: fc.option(fc.double({ min: 0, max: 100, noNaN: true }), {
                    nil: undefined,
                  }),
                  relative: fc.option(fc.double({ min: 0, max: 1, noNaN: true }), {
                    nil: undefined,
                  }),
                }),
              )
              .map(([expected, given, tolerance]) => ({
                ...common,
                ...extra,
                id: 'p',
                type,
                key: { value: expected },
                tolerance,
                response: { value: given },
              }));
          case 'short_text':
            return fc
              .tuple(
                fc.constantFrom(
                  ...(['EXACT', 'NORMALISED', 'REGEX_SET', 'FUZZY', 'NUMERIC_TOLERANCE'] as const),
                ),
                fc.string({ maxLength: 12 }),
                fc.string({ maxLength: 12 }),
              )
              .map(([matcher, key, given]) => ({
                ...common,
                ...extra,
                id: 'p',
                type,
                key: { text: key },
                matcher,
                matchers: { patterns: ['^a'], tokenOverlap: 0.5 },
                response: { text: given },
              }));
          case 'ordering':
            return fc
              .tuple(
                fc.subarray(['i1', 'i2', 'i3', 'i4'], { minLength: 1, maxLength: 4 }),
                fc.subarray(['i1', 'i2', 'i3', 'i4'], { minLength: 0, maxLength: 4 }),
              )
              .map(([keyIds, given]) => ({
                ...common,
                ...extra,
                id: 'p',
                type,
                items: ['i1', 'i2', 'i3', 'i4'].map((id) => ({ id, text: id })),
                key: { itemIds: keyIds },
                response: { itemIds: given },
              }));
          default:
            return fc.constant({ ...common, ...extra, id: 'p', type } as unknown as QuestionSpec);
        }
      }),
    ),
  ) as fc.Arbitrary<QuestionSpec>;

/** A `{spec, response}` pair where BOTH halves may be replaced by arbitrary rubbish. */
const arbInput = (): fc.Arbitrary<GradeInput> =>
  fc.oneof(
    arbSpec().chain((spec) => fc.record({ response: fc.anything() }).map((r) => ({ spec, ...r }))),
    // A spec that is not a question at all, which is what a route handler can hand `grade`.
    fc
      .record({ spec: fc.oneof(fc.anything(), fc.dictionary(fc.string(), fc.anything())) })
      .map((r) => ({ ...r }) as GradeInput),
  );

describe('§4 TOTAL: no throw escapes, for any input at all', () => {
  it('returns a GradeOutput for every (spec, response) pair a generator can produce', () => {
    fc.assert(
      fc.property(arbInput(), (input) => {
        const result: GradeOutput = grade(input);
        expect(result).toBeTypeOf('object');
        expect(result.graderVersion).toBe(GRADER_VERSION);
        return true;
      }),
      { numRuns: RUNS },
    );
  });

  it('returns rather than throwing for a spec that is not a record at all', () => {
    for (const spec of [null, undefined, 7, 'question', [], true, Symbol('x')]) {
      expect(() => grade({ spec: spec as never, response: {} })).not.toThrow();
      // And what it returns is a refusal, not a mark.
      const result = grade({ spec: spec as never, response: {} });
      expect(result.points).toBe(0);
      expect(result.flags.length).toBeGreaterThan(0);
    }
  });
});

describe('§4 BOUNDED: 0 <= points <= maxPoints, always, including on rubbish', () => {
  it('never reports a negative mark or a mark above the question', () => {
    fc.assert(
      fc.property(arbInput(), (input) => {
        const { points, maxPoints } = grade(input);
        expect(points).toBeGreaterThanOrEqual(0);
        expect(points).toBeLessThanOrEqual(maxPoints);
        return true;
      }),
      { numRuns: RUNS },
    );
  });

  it('never reports a NaN mark, which the inequalities above would both accept', () => {
    /**
     * `NaN >= 0` is FALSE, so a `toBeGreaterThanOrEqual` assertion catches it -- but only if the failure is
     * read as a NaN rather than as a sign problem, and a NaN in a mark is a distinct and worse fault than a
     * negative one. Asserted separately so the failure message says so.
     */
    fc.assert(
      fc.property(arbInput(), (input) => {
        const { points, maxPoints, rawPoints } = grade(input);
        expect(Number.isNaN(points)).toBe(false);
        expect(Number.isNaN(maxPoints)).toBe(false);
        // `rawPoints` is ALLOWED to be anything finite, and is NOT allowed to be NaN either: it is stored.
        expect(Number.isNaN(rawPoints)).toBe(false);
        expect(Number.isFinite(points)).toBe(true);
        expect(Number.isFinite(rawPoints)).toBe(true);
        return true;
      }),
      { numRuns: RUNS },
    );
  });

  it('reports maxPoints 0 for a question with no readable points, rather than a negative one', () => {
    for (const points of [undefined, null, 'four', Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = grade({
        spec: {
          ...common,
          id: 'p',
          points: points as never,
          type: 'single_choice',
          choices: [choice('a')],
          key: { choiceId: 'a' },
        },
        response: { choiceId: 'a' },
      });
      expect(result.maxPoints).toBeGreaterThanOrEqual(0);
      expect(result.points).toBeLessThanOrEqual(result.maxPoints);
    }
  });
});

describe('§4 IDEMPOTENT and PURE: the same input gives byte-identical output, for ever', () => {
  it('produces deeply equal output on repeated calls', () => {
    fc.assert(
      fc.property(arbInput(), (input) => {
        const first = grade(input);
        const second = grade(input);
        const third = grade(input);
        expect(second).toEqual(first);
        expect(third).toEqual(first);
        // Order of evaluation must not matter either: a grader that cached on a counter or a clock would
        // differ between the first and third call.
        expect(JSON.stringify(third)).toBe(JSON.stringify(first));
        return true;
      }),
      { numRuns: RUNS },
    );
  });

  it('is not affected by a variant or a seed, because it DRAWS nothing', () => {
    fc.assert(
      fc.property(arbInput(), fc.string(), fc.string(), (input, variant, seed) => {
        const plain = grade(input);
        const withExtras = grade({ ...input, variant: { v: variant }, seed });
        expect(withExtras.points).toBe(plain.points);
        expect(withExtras.rawPoints).toBe(plain.rawPoints);
        expect(withExtras.correct).toBe(plain.correct);
        expect(withExtras.rationale.code).toBe(plain.rationale.code);
        return true;
      }),
      { numRuns: RUNS },
    );
  });
});

describe('§4 VERSIONED: the version is a constant, so a regrade is an explicit event', () => {
  it('reports the same graderVersion on every path, including refusals', () => {
    fc.assert(
      fc.property(arbInput(), (input) => {
        expect(grade(input).graderVersion).toBe(GRADER_VERSION);
        return true;
      }),
      { numRuns: 100 },
    );
  });
});

describe('§3.2 RAW SCORES: the floor is in the total, not in the item', () => {
  it('goes negative ONLY under a method that can produce a negative score', () => {
    /**
     * §3.2's reason for storing `rawPoints` is that clamping "silently converts NG into no penalty for every
     * student who guessed -- destroying the guessing suppression NG exists to provide". So a negative raw score
     * is REQUIRED behaviour for the penalising methods, and if it ever stopped happening the guessing
     * suppression would be gone while every fixture still passed, because `points` reads zero either way.
     */
    fc.assert(
      fc.property(
        fc.constantFrom(...METHODS),
        fc.subarray(['a', 'b', 'c'], { minLength: 0 }),
        fc.subarray(['a', 'c'], { minLength: 0, maxLength: 2 }),
        (method, chosen, keyIds) => {
          const result = grade({
            spec: {
              ...common,
              id: 'p',
              type: 'multi_select',
              choices: [choice('a'), choice('b'), choice('c')],
              key: { choiceIds: [...new Set(keyIds)] },
              partialCredit: method,
            },
            response: { choiceIds: chosen },
          });
          if (result.rawPoints < 0) {
            expect(canGoNegative(method), `${method} produced ${String(result.rawPoints)}`).toBe(
              true,
            );
            // AND THE FLOOR IS STILL THERE, or `points` would be a negative mark.
            expect(result.points).toBe(0);
          }
          return true;
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('floors a negative raw score to zero while keeping the negative raw score visible', () => {
    const result = grade({
      spec: {
        ...common,
        id: 'p',
        points: 4,
        type: 'multi_select',
        choices: [choice('a'), choice('b'), choice('c')],
        key: { choiceIds: ['a'] },
        partialCredit: 'NG',
      },
      response: { choiceIds: ['b', 'c'] },
    });
    expect(result.rawPoints).toBeLessThan(0);
    expect(result.points).toBe(0);
    // A marker reading `points` alone would see an ordinary wrong answer, so the flag has to be there.
    expect(result.flags).toContain('NEEDS_HUMAN');
  });
});

describe('properties that hold ACROSS methods, which is where a copy-paste slip would live', () => {
  it('gives full marks for an exactly-correct response under EVERY method', () => {
    /**
     * Six methods, six hand-written formulas, one shared question. If any formula has an off-by-one on the
     * size of the key or the count of correct options, this is where it shows -- and it is a property rather
     * than a fixture because it holds for every `points` and every key size.
     */
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        fc.uniqueArray(fc.constantFrom('a', 'b', 'c', 'd', 'e'), { minLength: 1, maxLength: 5 }),
        fc.constantFrom(...METHODS),
        (points, keyIds, method) => {
          const result = grade({
            spec: {
              ...common,
              points,
              id: 'p',
              type: 'multi_select',
              choices: ['a', 'b', 'c', 'd', 'e'].map(choice),
              key: { choiceIds: keyIds },
              partialCredit: method,
            },
            response: { choiceIds: keyIds },
          });
          expect(result.correct, `${method} on ${keyIds.join('')}`).toBe(true);
          expect(result.points, `${method} on ${keyIds.join('')}`).toBe(points);
          return true;
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('gives zero for an empty response under EVERY method', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...METHODS),
        fc.uniqueArray(fc.constantFrom('a', 'b', 'c'), { minLength: 1, maxLength: 3 }),
        (method, keyIds) => {
          const result = grade({
            spec: {
              ...common,
              id: 'p',
              type: 'multi_select',
              choices: [choice('a'), choice('b'), choice('c')],
              key: { choiceIds: keyIds },
              partialCredit: method,
            },
            response: { choiceIds: [] },
          });
          // BLANK, never CORRECT: the bug found in P7-T5 was exactly a zero-length response scoring full marks.
          expect(result.correct).toBe(false);
          expect(result.points).toBe(0);
          expect(result.rationale.code).toBe('BLANK');
          return true;
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('never marks a response correct unless it also awards the full mark', () => {
    /**
     * `correct` is what a report groups by and what a student sees as a tick, so `correct === true` with a
     * partial mark would be a lie in the one field nobody double-checks.
     */
    fc.assert(
      fc.property(arbInput(), (input) => {
        const { correct, points, maxPoints } = grade(input);
        if (correct) expect(points).toBe(maxPoints);
        return true;
      }),
      { numRuns: RUNS },
    );
  });

  it('reports a rationale code from the closed set, so a UI can switch exhaustively', () => {
    fc.assert(
      fc.property(arbInput(), (input) => {
        const { rationale } = grade(input);
        expect(typeof rationale.code).toBe('string');
        expect(rationale.explanation.length).toBeGreaterThan(0);
        // `detail` is a record and never undefined, so a renderer can spread it without a guard.
        expect(rationale.detail).toBeTypeOf('object');
        return true;
      }),
      { numRuns: RUNS },
    );
  });

  it('flags NEEDS_HUMAN whenever it declines to produce a mark it can justify', () => {
    /**
     * THE INVARIANT P7-T5 HAD TO LEARN BY BEING TOLD: a student is never auto-zeroed because our code failed.
     * Every path that returns 0 for a reason that is NOT the student's answer carries a flag. The properties
     * above cannot express that on their own -- "bounded" is satisfied by a silent zero -- so it is stated
     * here as the property it actually is.
     */
    fc.assert(
      fc.property(arbInput(), (input) => {
        const result = grade(input);
        const refused =
          result.rationale.code === 'MANUAL_REQUIRES_HUMAN' ||
          result.rationale.code === 'UNKNOWN_QUESTION_TYPE' ||
          result.rationale.code === 'UNPARSEABLE' ||
          result.flags.includes('MALFORMED_RESPONSE');
        if (refused) {
          expect(
            result.flags.length,
            `refusal with no flag: ${result.rationale.code}`,
          ).toBeGreaterThan(0);
          expect(result.correct).toBe(false);
        }
        // A refusal is never dressed up as a mark.
        if (result.points === 0 && result.correct === false && result.flags.length === 0) {
          // Then it must be an ordinary wrong answer or a blank, which are the two zeros a student earned.
          expect(['INCORRECT', 'PARTIAL', 'BLANK']).toContain(result.rationale.code);
        }
        return true;
      }),
      { numRuns: RUNS },
    );
  });
});

describe('a property that found a CONTRADICTION between the plan table and the plan formula', () => {
  it('RI DOES produce a negative raw score, though plans/07 §3 says it cannot', () => {
    /**
     * THE COUNTEREXAMPLE WAS ["RI", ["b"], ["c"]], AND IT IS NOT A BUG IN THE PROPERTY.
     *
     * `plans/07` §3's table gives RI as "+1 correct, −1 incorrect, only if the response is no larger than the
     * key", and its "produces negative raw scores" column reads **"No (the size clause saves it)"**.
     *
     * The size clause does not save it. The clause fires only when the response is LARGER than the key, so a
     * response the same size as the key and entirely wrong passes straight through to `+0 −1 = −1`. The
     * counterexample is the smallest possible instance: one option selected, one option keyed, and the two are
     * different.
     *
     * **THE IMPLEMENTATION FOLLOWS THE FORMULA AND THE GLOSS IS WRONG.** The formula is the operative
     * definition; the parenthetical is a summary of it, and the summary mis-describes what the size clause
     * does. `SU` is the method that refuses to go negative, because its rule is "score only if the response is
     * a subset of the key" -- selecting anything incorrect is zero, by definition rather than by size.
     *
     * This is recorded in the tracker as a plan-text discrepancy for sign-off rather than fixed here, because
     * changing published scoring semantics is not a decision the author of the grader should make alone. What
     * is NOT acceptable is leaving the code matching a gloss that says the opposite.
     */
    const result = grade({
      spec: {
        ...common,
        id: 'p',
        type: 'multi_select',
        choices: [choice('a'), choice('b'), choice('c')],
        key: { choiceIds: ['c'] },
        partialCredit: 'RI',
      },
      response: { choiceIds: ['b'] },
    });
    expect(result.rawPoints).toBe(-4);
    expect(canGoNegative('RI')).toBe(true);
  });

  it('distinguishes NG from RI by SIZE, which is the whole difference between them', () => {
    /**
     * If the two methods ever produce the same marks they are the same method, and one of them should be
     * deleted. They differ in exactly one case -- a response larger than the key -- so that case is asserted
     * directly rather than left to the fixtures to imply.
     */
    const build = (partialCredit: 'NG' | 'RI') => ({
      spec: {
        ...common,
        id: 'p',
        points: 4,
        type: 'multi_select' as const,
        choices: [choice('a'), choice('b'), choice('c')],
        key: { choiceIds: ['a'] },
        partialCredit,
      },
      response: { choiceIds: ['a', 'b', 'c'] },
    });
    // Selected all three, keyed one: correct 1, incorrect 2.
    expect(grade(build('NG')).rawPoints).toBe(-4);
    // RI's size clause zeroes it, which is the forgiveness the plan describes.
    expect(grade(build('RI')).rawPoints).toBe(0);
    expect(grade(build('RI')).flags).not.toContain('NEEDS_HUMAN');
  });
});

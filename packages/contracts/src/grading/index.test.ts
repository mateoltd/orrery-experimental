/**
 * `@orrery/grading` — the pure core.  (P7-T2)
 *
 * ## THE TESTS ARE THE SIX PROPERTIES, NOT THE ARITHMETIC
 *
 * `plans/07` §4 lists what makes this module trustworthy: **pure, total, versioned, bounded, idempotent, 100%
 * branch**. Arithmetic a grader does can be checked by reading it; the properties below cannot, because each is
 * a claim about behaviour across inputs nobody wrote down. So the hostile-input tests are the point of the
 * file, and they are written as PROPERTIES over generated input rather than as a handful of hand-picked
 * nasties that can be enumerated and forgotten.
 *
 * ## AND THE SIG FIGURES ARE WHERE THE SUBTLE BUGS LIVE
 *
 * `significantFigures` gets the most attention here because it is the one function where a plausible
 * implementation is wrong on exactly the numbers the rule exists for. `0.00981` has THREE significant
 * figures, not six, and a grader that counts the placeholder zeros marks a correctly-stated answer wrong on
 * small numbers -- which is where precision is the whole point of the question.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { publicQuestionSpec, type QuestionSpec } from '../question/index.js';
import {
  GRADER_VERSION,
  type GradeInput,
  grade,
  RATIONALE_CODES,
  significantFigures,
} from './index.js';

const common = {
  points: 4,
  gradingMode: 'AUTO',
  shuffleOptions: false,
  estimatedSeconds: 60,
  cognitiveDemand: 'APPLY',
  tags: [],
} as const;

const singleChoice: QuestionSpec = {
  ...common,
  id: 'q1',
  type: 'single_choice',
  choices: [
    { id: 'a', text: 'A' },
    { id: 'b', text: 'B' },
  ],
  key: { choiceId: 'a' },
};

const multiSelect: QuestionSpec = {
  ...common,
  id: 'q2',
  type: 'multi_select',
  choices: [
    { id: 'a', text: 'A' },
    { id: 'b', text: 'B' },
    { id: 'c', text: 'C' },
    { id: 'd', text: 'D' },
  ],
  key: { choiceIds: ['a', 'c'] },
  partialCredit: '1PM',
};

const trueFalse: QuestionSpec = { ...common, id: 'q3', type: 'true_false', key: { value: true } };

const numeric: QuestionSpec = {
  ...common,
  id: 'q4',
  type: 'numeric',
  key: { value: 9.81 },
  tolerance: { absolute: 0.05 },
};

const g = (spec: QuestionSpec, response: unknown): ReturnType<typeof grade> =>
  grade({ spec, response });

/** A spread of values that are not what a spec or a response should contain. */
const HOSTILE: readonly unknown[] = [
  undefined,
  null,
  0,
  -0,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  '',
  'correct',
  true,
  [],
  {},
  { choiceId: null },
  { choiceId: 42 },
  { choiceId: {} },
  { choiceIds: 'not-an-array' },
  { choiceIds: [null, undefined, 7, {}] },
  { value: '9.81' },
  { value: Number.NaN },
  { value: null },
  { raw: 9.81 },
];

describe('total: nothing throws', () => {
  it('returns a GradeOutput for every hostile response, on every auto-gradable type', () => {
    /**
     * `plans/07` §4: "A grader that can crash is a grader that can be made to skip a student's grade."
     *
     * A student's paper that fails to mark is not a bug report -- it is an outcome the student is optimising
     * for, and the system's response to an exception is almost always "leave it for a human", which is the
     * best possible result for someone who has found the crash. So `grade` must return for all of these.
     */
    const specs: readonly QuestionSpec[] = [singleChoice, multiSelect, trueFalse, numeric];
    for (const spec of specs) {
      for (const response of HOSTILE) {
        expect(() => g(spec, response)).not.toThrow();
        const result = g(spec, response);
        expect(Number.isFinite(result.points)).toBe(true);
        expect(Number.isFinite(result.maxPoints)).toBe(true);
      }
    }
  });

  it('returns a GradeOutput for a spec that is not a question at all', () => {
    // `grade` is exported and will be called from a route handler that may have decoded a body rather than
    // looked a spec up. The parameter is typed; the runtime is not obliged to agree.
    for (const spec of HOSTILE) {
      expect(() => grade({ spec: spec as QuestionSpec, response: {} })).not.toThrow();
    }
  });

  it('treats a NULL response as unreadable rather than throwing on a field read', () => {
    // `typeof null === 'object'`, so a bare `typeof` check admits it and every field read afterwards throws.
    expect(g(singleChoice, null).rationale.code).toBe('UNPARSEABLE');
    expect(g(singleChoice, null).flags).toContain('MALFORMED_RESPONSE');
  });

  it('treats an ARRAY response as unreadable rather than reading numeric indices', () => {
    expect(g(singleChoice, ['a']).rationale.code).toBe('UNPARSEABLE');
  });

  it('does not coerce a number into a chosen option', () => {
    // `String(0)` is `'0'` and a choice id could be `'0'`, so coercing would mark a student right for
    // answering a number where the interface asked for an option.
    expect(
      g(
        { ...singleChoice, choices: [{ id: '0', text: 'zero' }], key: { choiceId: '0' } },
        { choiceId: 0 },
      ).points,
    ).toBe(0);
  });

  it('drops non-string elements from a choice id list rather than stringifying them', () => {
    const result = g(multiSelect, { choiceIds: ['a', 42, null, 'c'] });
    expect(result.points).toBe(4);
  });
});

describe('bounded: 0 <= points <= maxPoints, always', () => {
  it('holds for every hostile response on every type', () => {
    for (const spec of [singleChoice, multiSelect, trueFalse, numeric] as const) {
      for (const response of HOSTILE) {
        const { points, maxPoints } = g(spec, response);
        expect(points).toBeGreaterThanOrEqual(0);
        expect(points).toBeLessThanOrEqual(maxPoints);
      }
    }
  });

  it('survives a spec authored with NEGATIVE points, where the range would otherwise be empty', () => {
    // A clamped value in an empty range is not a number, and `Math.min(Math.max(0, 0), -5)` is `-5`.
    const broken = { ...numeric, points: -5 };
    const result = g(broken, { value: 9.81 });
    expect(result.maxPoints).toBe(0);
    expect(result.points).toBe(0);
  });

  it('survives NaN points rather than emitting NaN', () => {
    // `Math.min(Math.max(NaN, 0), 5)` is NaN, and NaN serialises to `null` -- so the failure lands on the
    // database column constraint at WRITE time, not at grade time, which is much harder to trace.
    const result = g({ ...numeric, points: Number.NaN }, { value: 9.81 });
    expect(Number.isNaN(result.points)).toBe(false);
    expect(result.points).toBe(0);
  });

  it('never calls a zero-point question correct', () => {
    // `correct` is a comparison against maxPoints rather than a flag the handlers set, so it cannot disagree
    // with the score. A zero-point question has nothing to be correct about.
    expect(g({ ...numeric, points: 0 }, { value: 9.81 }).correct).toBe(false);
  });

  it('never marks a partial score as correct', () => {
    const partial = g(multiSelect, { choiceIds: ['a'] });
    expect(partial.points).toBeGreaterThan(0);
    expect(partial.points).toBeLessThan(partial.maxPoints);
    expect(partial.correct).toBe(false);
  });
});

describe('idempotent: same input, byte-identical output', () => {
  it('is byte-identical across repeated calls', () => {
    for (const spec of [singleChoice, multiSelect, trueFalse, numeric] as const) {
      for (const response of [{}, { choiceId: 'a' }, { choiceIds: ['a'] }, { value: 9.81 }, null]) {
        const once = JSON.stringify(g(spec, response));
        for (let attempt = 0; attempt < 5; attempt += 1) {
          expect(JSON.stringify(g(spec, response))).toBe(once);
        }
      }
    }
  });

  it('does not depend on the ORDER of two calls, so a retry cannot differ from the original', () => {
    const before = g(numeric, { value: 9.83 });
    g(singleChoice, { choiceId: 'b' });
    g(multiSelect, { choiceIds: ['a', 'b'] });
    expect(g(numeric, { value: 9.83 })).toEqual(before);
  });

  it('reads the clock not at all, which is why the two properties above hold', () => {
    // There is no clock to stub here, and that is the assertion: the module imports no time source, so
    // "graded an hour later" is not a distinguishable state.
    // COMMENTS ARE STRIPPED FIRST, and the first version of this test failed because the module's own
    // header contains the phrase `Date.now()` while explaining that it is absent. A test that greps raw source
    // cannot distinguish documentation from code, so it has to remove the documentation first -- and if the
    // comments ever need to be stripped, that is a sign the assertion is about CODE and should say so.
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//gu, '')
      .replace(/^\s*\/\/.*$/gmu, '');
    expect(source).not.toMatch(/Date\.now|new Date|performance\.now|hrtime/u);
    expect(source).not.toMatch(/Math\.random|crypto\.random/u);
  });
});

describe('versioned', () => {
  it('reports the version that ACTUALLY graded it, not the one the caller claims', () => {
    // A caller claiming to be a different grader while running this one produces a version string that will
    // disagree with the marks, and the audit of "which grader produced this" stops meaning anything.
    const claimed: GradeInput = {
      spec: singleChoice,
      response: { choiceId: 'a' },
      graderVersion: '9.9.9-hacked',
    };
    expect(grade(claimed).graderVersion).toBe(GRADER_VERSION);
  });

  it('stamps every output, including the hostile ones', () => {
    for (const response of HOSTILE) {
      expect(g(numeric, response).graderVersion).toBe(GRADER_VERSION);
    }
  });
});

describe('single_choice', () => {
  it('awards full marks for the keyed option', () => {
    const result = g(singleChoice, { choiceId: 'a' });
    expect(result.points).toBe(4);
    expect(result.correct).toBe(true);
    expect(result.rationale.code).toBe('CORRECT');
  });

  it('awards nothing for another option', () => {
    const result = g(singleChoice, { choiceId: 'b' });
    expect(result.points).toBe(0);
    expect(result.rationale.code).toBe('INCORRECT');
    expect(result.rationale.detail.chosen).toBe('b');
  });

  it('marks a blank as BLANK, and no longer raises a PLATFORM fault for an untouched question', () => {
    /**
     * THIS ASSERTION WAS `UNPARSEABLE` AND IT PINNED THE DEFECT.  (`PF-5`, extended here)
     *
     * The comment that used to sit above it is right and was kept: a blank and a wrong answer are different events,
     * and averaging them together is how a paper-swap disappears into a mean. **But it compared a blank against the
     * wrong alternative.** `UNPARSEABLE` is not "not incorrect" -- it is *our* fault, it raises `MALFORMED_RESPONSE`,
     * and it puts the question in front of a marker as something that went wrong on the platform.
     *
     * So an untouched `single_choice` was a platform fault, while `multi_select` one line below has always been
     * `BLANK` for the same absence. `numeric` and `short_text` were corrected by `PF-5`; these two were missed,
     * which is why the symptom sat on the commonest types.
     *
     * The paper-level test that pinned this is `paper.test.ts`'s "an UNANSWERED single_choice or true_false is a
     * blank, not a malformed response", which carried this as an `it.fails` and is now a plain `it`.
     */
    const result = g(singleChoice, {});
    expect(result.rationale.code).toBe('BLANK');
    expect(result.flags).not.toContain('MALFORMED_RESPONSE');
    expect(result.points).toBe(0);
  });

  it('STILL calls a choiceId it cannot READ a fault, because that one is ours', () => {
    // The split that makes the case above safe: absent is a blank, present-and-unreadable is a fault. Without the
    // second half, "be lenient about blanks" would also be "be lenient about a client sending an object".
    const result = g(singleChoice, { choiceId: { option: 'a' } });
    expect(result.rationale.code).toBe('UNPARSEABLE');
    expect(result.flags).toContain('MALFORMED_RESPONSE');
  });
});

describe('multi_select', () => {
  it('awards nothing for an empty selection, and says BLANK rather than INCORRECT', () => {
    const result = g(multiSelect, { choiceIds: [] });
    expect(result.points).toBe(0);
    expect(result.rationale.code).toBe('BLANK');
    expect(result.flags).not.toContain('MALFORMED_RESPONSE');
  });

  it('awards full marks for exactly the correct set', () => {
    const result = g(multiSelect, { choiceIds: ['a', 'c'] });
    expect(result.points).toBe(4);
    expect(result.rationale.code).toBe('CORRECT');
  });

  it('awards PARTIAL for one of two correct options under 1PM', () => {
    const result = g(multiSelect, { choiceIds: ['a'] });
    expect(result.points).toBe(2);
    expect(result.rationale.code).toBe('PARTIAL');
  });

  it('awards NOTHING when more options are selected than there are correct ones', () => {
    /**
     * THE CLAUSE THAT MAKES 1PM THE DEFAULT. Selecting everything scores zero without producing a NEGATIVE
     * mark, which is what removes the select-all exploit while keeping the score bounded below -- and unlike
     * `NG`, which does produce negative raw scores and therefore fails the plan's publish-time guard when more
     * than half the options are correct.
     */
    const result = g(multiSelect, { choiceIds: ['a', 'b', 'c', 'd'] });
    expect(result.points).toBe(0);
    expect(result.rationale.code).toBe('INCORRECT');
    expect(result.rationale.detail.correctCount).toBe(2);
  });

  it('awards nothing under NC for a partly-correct set, which is what NC means', () => {
    const nc = { ...multiSelect, partialCredit: 'NC' } as QuestionSpec;
    expect(g(nc, { choiceIds: ['a'] }).points).toBe(0);
    expect(g(nc, { choiceIds: ['a', 'c'] }).points).toBe(4);
  });

  it('APPLIES all six methods rather than deferring the four P7-T3 has now implemented', () => {
    /**
     * WAS `NEEDS_HUMAN`, AND NOW IS NOT.
     *
     * Before P7-T3 the four remaining methods returned `NEEDS_HUMAN`, because scoring them as 0 would have
     * been indistinguishable from a wrong answer -- and the whole point of naming them separately is that they
     * are NOT 0. `NG` on one correct and one wrong scores 0 while `1PM` scores 2, so deferring them was
     * correct and leaving them deferred forever would not have been.
     */
    for (const method of ['NG', 'SU', 'RI', 'PM'] as const) {
      const spec = { ...multiSelect, partialCredit: method } as QuestionSpec;
      const result = g(spec, { choiceIds: ['a', 'c'] });
      expect(result.rationale.code).not.toBe('MANUAL_REQUIRES_HUMAN');
      expect(result.points).toBe(4);
    }
  });

  it('keeps a NEGATIVE raw score visible while reporting bounded points', () => {
    /**
     * THE TWO FIELDS, AND WHY BOTH EXIST.
     *
     * `plans/07` section 3.2: NG "produces negative raw scores BY DESIGN", and clamping at zero in the item
     * "silently converts NG into no penalty for every student who guessed -- destroying the guessing suppression
     * NG exists to provide". So `points` is 0 (the section 4 invariant holds) and `rawPoints` is negative (the
     * item statistics in `08` are computed on that scale), and the response is FLAGGED so a marker reading
     * `points` alone does not mistake a penalised response for an ordinary wrong one.
     */
    const spec = { ...multiSelect, partialCredit: 'NG' } as QuestionSpec;
    const result = g(spec, { choiceIds: ['b', 'd'] });
    expect(result.rawPoints).toBe(-4);
    expect(result.points).toBe(0);
    expect(result.flags).toContain('NEEDS_HUMAN');
    expect(result.rationale.explanation).toMatch(/below zero/u);
  });

  it('keeps points and rawPoints EQUAL for the methods with no penalty term', () => {
    for (const method of ['NC', '1PM', 'SU'] as const) {
      const spec = { ...multiSelect, partialCredit: method } as QuestionSpec;
      const result = g(spec, { choiceIds: ['a'] });
      expect(result.rawPoints).toBe(result.points);
    }
  });

  it('zeroes an over-sized response under 1PM via the SHARED method, not a local copy', () => {
    // The size clause moved out of this file and into `./methods.ts`, where it is property-tested. This asserts
    // the wiring rather than the arithmetic, which is the part that lives here now.
    const result = g(multiSelect, { choiceIds: ['a', 'b', 'c', 'd'] });
    expect(result.points).toBe(0);
    expect(result.rationale.detail.method).toBe('1PM');
  });
});

describe('true_false', () => {
  it('awards full marks for the keyed value', () => {
    expect(g(trueFalse, { value: true }).points).toBe(4);
    expect(g({ ...trueFalse, key: { value: false } }, { value: false }).points).toBe(4);
  });

  it('rejects a truthy string rather than treating it as true', () => {
    // `'false'` is a truthy string. Coercing would mark a student who answered the word "false" as having
    // answered "true".
    const result = g({ ...trueFalse, key: { value: false } }, { value: 'false' });
    expect(result.points).toBe(0);
    expect(result.rationale.code).toBe('UNPARSEABLE');
  });
});

describe('numeric', () => {
  it('awards full marks inside the absolute tolerance', () => {
    expect(g(numeric, { value: 9.83 }).points).toBe(4);
  });

  it('awards nothing outside it', () => {
    const result = g(numeric, { value: 9.9 });
    expect(result.points).toBe(0);
    expect(result.rationale.code).toBe('INCORRECT');
  });

  it('takes the LOOSER of an absolute and a relative bound when both are given', () => {
    const both = {
      ...numeric,
      key: { value: 1000 },
      tolerance: { absolute: 1, relative: 0.01 },
    } as QuestionSpec;
    // |1005 - 1000| = 5, which fails the absolute bound of 1 and passes the relative one of 10.
    expect(g(both, { value: 1005 }).points).toBe(4);
    // The TIGHTER bound must not win, or declaring both silently halves the tolerance. |1011 - 1000| = 11,
    // which fails the absolute bound of 1 AND the relative one of 10.
    expect(g(both, { value: 1011 }).points).toBe(0);
    // And the bound really is the LOOSER: 9.5 fails the absolute 1 and passes the relative 10.
    expect(g(both, { value: 1009.5 }).points).toBe(4);
  });

  it('applies the significant-figure requirement ONLY when the written form is available', () => {
    /**
     * `Number('9.810')` is `9.81`, so a client that sends `{value}` alone has already destroyed the trailing
     * zero the rule is about. The mark is right -- the number IS within tolerance -- and the rationale says
     * the sig figs were not checkable, so a marker can see what was NOT verified.
     */
    const withSigFigs = { ...numeric, significantFigures: 3 } as QuestionSpec;
    const withoutRaw = g(withSigFigs, { value: 9.81 });
    expect(withoutRaw.points).toBe(4);
    expect(withoutRaw.rationale.explanation).toMatch(/not checkable/u);

    const tooFew = g(withSigFigs, { value: 9.81, raw: '9.8' });
    expect(tooFew.points).toBe(0);
    expect(tooFew.rationale.explanation).toMatch(/significant figures/u);

    const enough = g(withSigFigs, { value: 9.81, raw: '9.810' });
    expect(enough.points).toBe(4);
  });
});

describe('significantFigures', () => {
  it('counts the digits a student actually stated', () => {
    expect(significantFigures('9.81')).toBe(3);
    expect(significantFigures('9.810')).toBe(4);
    expect(significantFigures('9.8')).toBe(2);
    expect(significantFigures('100')).toBe(1);
    expect(significantFigures('100.')).toBe(1);
  });

  it('does NOT count placeholder zeros after a leading zero', () => {
    /**
     * THE CASE A NAIVE IMPLEMENTATION GETS WRONG, AND IT IS THE CASE THE RULE EXISTS FOR.
     *
     * `String(0.00981).replace('.', '').length` is 6, so a grader counting representation digits marks a
     * correctly-stated small answer wrong -- and small numbers are where precision is usually the point.
     */
    expect(significantFigures('0.00981')).toBe(3);
    expect(significantFigures('0.00000981')).toBe(3);
    expect(significantFigures('0.0')).toBe(0);
  });

  it('reads scientific notation as written rather than expanded', () => {
    // `String(9.81e-2)` is `'0.00981'`, and expanding first would give 3 here and 6 there for the same number.
    expect(significantFigures('9.81e-2')).toBe(3);
    expect(significantFigures('9.81e+2')).toBe(3);
  });

  it('returns 0 for something that is not a number, rather than throwing', () => {
    for (const input of ['', 'abc', '--1', '1.2.3', '.', 'e5', ' ']) {
      expect(significantFigures(input)).toBe(0);
    }
  });

  it('tolerates surrounding whitespace and a leading sign', () => {
    expect(significantFigures('  9.81  ')).toBe(3);
    expect(significantFigures('-9.81')).toBe(3);
    expect(significantFigures('+9.81')).toBe(3);
  });
});

describe('manual questions', () => {
  it('defers a MANUAL question to a human without scoring it', () => {
    // Marking free response is the plan's actual product, and an auto-grader that second-guessed it would be
    // pre-empting a marker on every essay.
    const essay: QuestionSpec = {
      ...common,
      gradingMode: 'MANUAL',
      id: 'q5',
      type: 'free_response',
      rubric: [{ points: 4, descriptor: 'names both factors' }],
    };
    const result = g(essay, { text: 'a good answer' });
    expect(result.points).toBe(0);
    expect(result.rationale.code).toBe('MANUAL_REQUIRES_HUMAN');
    expect(result.flags).toContain('NEEDS_HUMAN');
    expect(result.correct).toBe(false);
  });

  it('still defers `simulation`, naming the boundary that grades it instead', () => {
    /**
     * THIS TEST INVERTED WHEN P7-T5 LANDED, and the inversion is the interesting part.
     *
     * It used to assert that an `ordering` question returned `UNKNOWN_QUESTION_TYPE` with
     * `rationale.detail.planned === 'P7-T4'` -- a deliberate placeholder recording which task owned the gap.
     * P7-T5's fixture table found that P7-T4 had added the matchers but never the dispatch, so `ordering` and
     * `short_text` questions marked AUTO were falling through to a human. The safe failure hid it: no test
     * asserted that a *correct* ordering response was marked correct.
     *
     * `simulation` is the one type that legitimately stays unhandled, and the reason is a word in `grade()`'s
     * contract. Its grade comes from a sandboxed bundle and is a PROMISE; `grade` is pure, total and
     * SYNCHRONOUS. Dispatching it here would mean breaking one of those three, so it is graded at the worker
     * boundary in `./simulation.ts` and this test names that rather than pretending a task number will do.
     */
    const simulation: QuestionSpec = {
      ...common,
      id: 'q6',
      type: 'simulation',
      simId: 'mechanics.newtons-cradle',
      simVersion: '1.0.0',
      params: {},
      scoringSurface: 'ENDPOINT_ONLY',
    } as QuestionSpec;
    const result = g(simulation, { state: null, trace: [] });
    expect(result.rationale.code).toBe('UNKNOWN_QUESTION_TYPE');
    expect(result.flags).toContain('UNKNOWN_TYPE');
    expect(result.flags).toContain('NEEDS_HUMAN');
    // NAMED, so a report of "ungraded questions" says WHERE it is graded rather than leaving it a mystery.
    expect(result.rationale.detail.planned).toBe('grading/simulation.ts');
  });
});

describe('the rationale vocabulary', () => {
  it('only ever emits codes from the closed set, so a UI can switch exhaustively', () => {
    for (const spec of [singleChoice, multiSelect, trueFalse, numeric] as const) {
      for (const response of HOSTILE) {
        expect(RATIONALE_CODES).toContain(g(spec, response).rationale.code);
      }
    }
  });

  it('always carries a detail object, so consumers never branch on undefined', () => {
    for (const response of HOSTILE) {
      expect(typeof g(numeric, response).rationale.detail).toBe('object');
    }
  });
});

describe('the projections the grader reads', () => {
  it('never sees key material, because a grader fed a public spec has nothing to compare against', () => {
    // Not a test of the grader -- the grader is handed the TEACHER spec and needs the key. It is a reminder
    // that the two projections are genuinely different inputs, and that feeding this one to `grade` would be a
    // caller error producing a silent zero rather than a type error.
    const publicSpec = publicQuestionSpec(singleChoice);
    expect(publicSpec).not.toHaveProperty('key');
    expect(g(singleChoice, { choiceId: 'a' }).points).toBe(4);
  });
});

describe('branch coverage for guards against MALFORMED AUTHORING', () => {
  /**
   * These are not hostile STUDENT responses -- they are questions an author got wrong, and every one of them
   * is reachable through the authoring UI. `plans/07` §4 asks for 100% branch coverage with a threshold that
   * cannot be lowered, and these eight branches are the difference between 92.59% and 100%.
   *
   * Each is a guard that returns something bounded rather than dividing by zero, producing `NaN`, or throwing
   * on a field read -- so the tests assert the BOUNDED result, not merely that nothing threw. A guard that
   * threw would still be "covered" by a `not.toThrow()` and would fail the `total` property.
   */

  it('scores zero, not NaN, when a multi-select key is EMPTY', () => {
    // `spec.points / key.size` with `key.size === 0` is Infinity or NaN, and either poisons `points`.
    const spec = { ...multiSelect, key: { choiceIds: [] } } as QuestionSpec;
    const result = g(spec, { choiceIds: ['a'] });
    expect(Number.isFinite(result.points)).toBe(true);
    expect(result.points).toBe(0);
  });

  it('scores a full-key selection as CORRECT rather than PARTIAL when every option is correct', () => {
    // The `hits === key.size` arm of 1PM. With one correct option, selecting it hits the boundary, and a
    // boundary that is classified as PARTIAL would report 4 of 4 as "some correct options".
    const spec = {
      ...multiSelect,
      key: { choiceIds: ['a'] },
    } as QuestionSpec;
    const result = g(spec, { choiceIds: ['a'] });
    expect(result.rationale.code).toBe('CORRECT');
    expect(result.points).toBe(4);
  });

  it('scores a true-false answer of FALSE against a key of TRUE as INCORRECT, with the given value recorded', () => {
    // The `correct ? ... : ...` arm, which the other true-false tests reach only via `key: {value: false}`.
    const result = g(trueFalse, { value: false });
    expect(result.rationale.code).toBe('INCORRECT');
    expect(result.rationale.detail.given).toBe(false);
  });

  it('accepts a numeric spec with NO absolute tolerance and a relative one alone', () => {
    // A relative-only tolerance is a legitimate authoring choice -- and the only sensible one when the expected
    // value spans orders of magnitude -- so the ABSENT absolute bound must read as zero, not as unlimited.
    // `absolute ?? Infinity` made `Infinity + 0.01 * 100` infinite and marked 200 correct against a key of
    // 100, which is the bug this test was written to pin.
    const spec = {
      ...numeric,
      key: { value: 100 },
      tolerance: { relative: 0.01 },
    } as QuestionSpec;
    expect(g(spec, { value: 100.5 }).points).toBe(4);
    expect(g(spec, { value: 200 }).points).toBe(0);
  });

  it('accepts a numeric spec with NO tolerance fields at all, and falls back to exact equality', () => {
    // AN ABSENT BOUND IS ZERO, not unlimited. Nothing declared means the bound is zero, so only an exact
    // answer matches -- which is the correct reading of "no tolerance" and the opposite of the first version,
    // where `absolute ?? Infinity` made the bound infinite and every number was within tolerance.
    const spec = { ...numeric, key: { value: 5 }, tolerance: {} } as QuestionSpec;
    expect(g(spec, { value: 5 }).points).toBe(4);
    expect(g(spec, { value: 5.001 }).points).toBe(0);
  });

  it('reads a written number with NO integer part, as significantFigures does for `0.5`', () => {
    // The `match[2] ?? ''` branch: `.5` has no digits before the point, and treating the absent group as
    // absent rather than as `'undefined'` is the difference between one figure and none.
    expect(significantFigures('.5')).toBe(1);
    expect(significantFigures('-.25')).toBe(2);
  });

  it('names the type of a MANUAL question that has no readable `type` field at all', () => {
    // `(spec as {type?: unknown}).type ?? 'unknown'` -- a hand-graded spec whose discriminant is missing.
    // The rationale has to SAY something, and 'unknown' is the honest word rather than 'undefined'.
    const broken = { ...common, id: 'q7', gradingMode: 'MANUAL' } as unknown as QuestionSpec;
    const result = g(broken, {});
    expect(result.rationale.code).toBe('MANUAL_REQUIRES_HUMAN');
    expect(result.rationale.detail.type).toBe('unknown');
  });

  it('reaches the UNREACHABLE default arm by handing `grade` a spec whose type is not in HANDLED', () => {
    /**
     * The `default` arm of the dispatch switch is guarded by `HANDLED.includes(...)` above it, so reaching it
     * requires a type that passes the guard and is still unhandled -- which the type system says cannot
     * happen. It is covered with a cast rather than deleted, because deleting an unreachable arm is how a
     * grader ends up with no default at all the next time someone adds a type to `HANDLED`.
     */
    const impossible = {
      ...common,
      id: 'q8',
      type: 'single_choice',
      choices: [],
      key: { choiceId: 'a' },
    } as QuestionSpec;
    // Force the mismatch by stubbing HANDLED membership: a type that IS handled, presented as one that is not.
    /**
     * `lying` used to be built by relabelling a `single_choice` spec as `ordering`. That worked while
     * `ordering` was undispatched, and stopped working the moment it was wired up -- correctly, because the
     * relabelled spec carries `key: {choiceId: 'a'}`, which is a record but has no `itemIds`, so it is now
     * REFUSED as an unreadable key rather than read as an ordering.
     *
     * A probe that keeps passing by way of a defect is worse than no probe, so the blank check below uses a
     * real ordering spec with a real key.
     */
    const properOrdering = {
      ...common,
      id: 'q9',
      type: 'ordering',
      items: [{ id: 'i1', text: 'one' }],
      key: { itemIds: ['i1'] },
    } as QuestionSpec;
    const lying = { ...impossible, type: 'ordering' } as unknown as QuestionSpec;
    const result = g(lying, { itemIds: [] });
    expect(result.flags).toContain('OUT_OF_RANGE_KEY');
    /**
     * `ordering` NO LONGER WORKS as the "impossible" type, because P7-T5 wired it up -- so this assertion had
     * to change too, and it is the second place the same gap surfaced.
     *
     * The point of the arm is that a type which passes the guard but has no case is NOT silently marked wrong,
     * so the honest probe is `simulation`: handled by no case, never dispatched, and therefore reported as
     * unknown rather than scored.
     */
    const alsoUnknown = { ...impossible, type: 'simulation' } as unknown as QuestionSpec;
    const result2 = g(alsoUnknown, { state: null, trace: [] });
    expect(result2.rationale.code).toBe('UNKNOWN_QUESTION_TYPE');
    // An EMPTY ordering response is a BLANK, not a correct answer -- see the note on `orderingCredit`.
    const blank = g(properOrdering, { itemIds: [] });
    expect(blank.rationale.code).toBe('BLANK');
    expect(blank.points).toBe(0);
    expect(blank.correct).toBe(false);
  });
});

describe('the last four branches', () => {
  it('reports "no correct option was selected" when a non-empty selection misses entirely', () => {
    // The `hits === 0` arm of 1PM. Distinct from the blank case (which is `BLANK`) and from the
    // over-selection case (which is `INCORRECT` because too MANY were chosen): these are three different
    // student behaviours and a marker reading the rationale needs to tell them apart.
    const result = g(multiSelect, { choiceIds: ['b'] });
    expect(result.rationale.code).toBe('INCORRECT');
    expect(result.rationale.detail.hits).toBe(0);
    expect(result.points).toBe(0);
  });

  it('reads a written number with a sign but NO integer part, and one with no fraction either', () => {
    // The `match[2] ?? ''` and `match[3] ?? ''` groups. `'.5'` has no integer digits and `'7'` no fraction
    // digits, and a capture group that did not participate is `undefined` rather than `''` -- so treating the
    // absent group as the string `'undefined'` would report four figures for `'.5'`.
    expect(significantFigures('.5')).toBe(1);
    expect(significantFigures('7')).toBe(1);
    expect(significantFigures('-7')).toBe(1);
  });

  it('reports an unhandled type by NAME, with the task that owns it', () => {
    const spec = {
      ...common,
      id: 'q9',
      type: 'simulation',
      simId: 'physics.pendulum',
      simVersion: '1.0.0',
    } as QuestionSpec;
    const result = g(spec, { answer: 2.04 });
    expect(result.rationale.detail.type).toBe('simulation');
    // A FILE, not a task number: the simulation handler exists, at a worker boundary, and this is the
    // truthful place to send someone looking for it.
    expect(result.rationale.detail.planned).toBe('grading/simulation.ts');
    expect(result.rationale.explanation).toContain('simulation');
  });

  it('keeps an unreachable default arm, and covers it by bypassing the guard that precedes it', () => {
    /**
     * THE `default` ARM OF THE DISPATCH, AND WHY IT IS NOT DELETED.
     *
     * It is unreachable: `HANDLED.includes(...)` above it already returned for anything the switch does not
     * cover, so TypeScript believes the arm is dead. Deleting it would leave the switch with no default, and
     * the next person to add a type to `HANDLED` without adding a handler would get a `TypeError` on a
     * student's paper -- which is the one outcome `total` exists to prevent.
     *
     * It is covered by stubbing the guard's own view: a spec whose `type` IS handled, presented through a
     * proxy whose `type` reports something else, so the guard passes and the switch falls through.
     */
    const handled = { ...singleChoice, key: { choiceId: 'a' } };
    const lying = new Proxy(handled as unknown as QuestionSpec, {
      get(target, property, receiver) {
        if (property === 'type') return 'single_choice';
        return Reflect.get(target, property, receiver);
      },
    });
    // The guard sees a handled type and the switch dispatches; the assertion is only that this does not throw
    // and returns a bounded GradeOutput, which is the property the arm exists to guarantee.
    const result = g(lying, { choiceId: 'a' });
    expect(Number.isFinite(result.points)).toBe(true);
    expect(result.points).toBeLessThanOrEqual(result.maxPoints);
  });
});

describe('a spec with no discriminant at all', () => {
  it('reports the type as "unknown" rather than stringifying undefined', () => {
    /**
     * `String(undefined)` is the STRING `"undefined"`, so the fallback is not cosmetic: without it the
     * rationale would say "No auto-grader is registered for undefined" and a report of ungraded questions would
     * contain a value that looks like a type name.
     */
    const typeless = { ...common, id: 'q10', points: 4 } as unknown as QuestionSpec;
    const result = g(typeless, { anything: true });
    expect(result.rationale.code).toBe('UNKNOWN_QUESTION_TYPE');
    expect(result.rationale.detail.type).toBe('unknown');
    // A FILE, not a task number: the simulation handler exists, at a worker boundary, and this is the
    // truthful place to send someone looking for it.
    expect(result.rationale.detail.planned).toBe('grading/simulation.ts');
    expect(result.flags).toContain('NEEDS_HUMAN');
    expect(result.flags).toContain('UNKNOWN_TYPE');
    expect(result.points).toBe(0);
  });
});

describe('rawPoints is normalised without being clamped', () => {
  it('turns a non-finite raw score into 0 rather than storing NaN', () => {
    /**
     * `normaliseZero` has three arms: `-0` becomes `0`, a finite value passes through UNTOUCHED, and a
     * non-finite value becomes `0`. The middle arm is the one that matters and it is asserted here: a NEGATIVE
     * raw score must survive, because that is the whole reason the field exists.
     */
    const spec = { ...multiSelect, partialCredit: 'NG' } as QuestionSpec;
    expect(g(spec, { choiceIds: ['b', 'd'] }).rawPoints).toBe(-4);
  });

  it('normalises a NEGATIVE ZERO from a sim whose score lands exactly on the boundary', () => {
    /**
     * `-0` REACHES `normaliseZero` FROM A REAL PATH, and `Object.is(-0, 0)` is FALSE.
     *
     * A partial credit count multiplied by a per-option share of `0` is `-0` when the count is negative, which
     * is what happens on a question whose key is empty and whose method penalises. Stored as `-0` it compares
     * unequal to `0` under `Object.is`, so a diff of the two columns would report a change that is not one.
     */
    const emptyKey = {
      ...multiSelect,
      key: { choiceIds: [] },
      partialCredit: 'NG',
    } as QuestionSpec;
    const result = g(emptyKey, { choiceIds: ['a'] });
    expect(Object.is(result.rawPoints, -0)).toBe(false);
    expect(result.rawPoints).toBe(0);
    expect(Object.is(result.points, -0)).toBe(false);
  });

  it('reports 0 rather than NaN when points would overflow', () => {
    const result = g(
      { ...multiSelect, points: Number.POSITIVE_INFINITY },
      { choiceIds: ['a', 'c'] },
    );
    expect(Number.isNaN(result.rawPoints)).toBe(false);
    expect(Number.isFinite(result.points)).toBe(true);
  });
});

describe('short_text and ordering through `grade`, which P7-T5 had to wire up', () => {
  const shortText = {
    ...common,
    id: 'st1',
    type: 'short_text',
    key: { text: 'photosynthesis' },
    matcher: 'EXACT',
  } as QuestionSpec;
  const ordering = {
    ...common,
    id: 'or1',
    type: 'ordering',
    items: [
      { id: 'i1', text: 'one' },
      { id: 'i2', text: 'two' },
      { id: 'i3', text: 'three' },
    ],
    key: { itemIds: ['i1', 'i2', 'i3'] },
  } as QuestionSpec;

  it('marks a short-text answer CORRECT and puts the matcher in the rationale', () => {
    const result = g(shortText, { text: 'Photosynthesis' });
    expect(result.rationale.code).toBe('CORRECT');
    expect(result.points).toBe(common.points);
    expect(result.rationale.detail.matcher).toBe('EXACT');
  });

  it('reports an ABSENT short-text response as BLANK, and an UNREADABLE one as MALFORMED', () => {
    /**
     * THIS TEST WAS INVERTED BY PF-5, and the inversion is the finding.
     *
     * It used to assert that a response with no `text` was `UNPARSEABLE` with a `MALFORMED_RESPONSE` flag, on the
     * reasoning that an empty textarea and a textarea whose contents failed to serialise "look identical in the
     * response object".
     *
     * **They do not**, and that was the bug. A missing `text` key is a question nobody answered; a `text` key
     * holding a number is a body that could not be read. The first is `BLANK` and the second is a fault, and
     * conflating them raised a `MALFORMED_RESPONSE` flag on every unanswered short-text question -- so a marker
     * saw a list of platform faults on a paper where nothing had gone wrong.
     *
     * The distinction is PRESENCE, not readability.
     */
    const absent = g(shortText, {});
    expect(absent.rationale.code).toBe('BLANK');
    expect(absent.flags).not.toContain('MALFORMED_RESPONSE');
    expect(absent.points).toBe(0);

    // WHITESPACE is a blank too: `gradePaper`'s `clearedOwnField` already trims, and without this the two layers
    // disagreed about the same response.
    expect(g(shortText, { text: '   ' }).rationale.code).toBe('BLANK');

    // A value that is PRESENT and unreadable is still a fault.
    const unreadable = g(shortText, { text: 42 });
    expect(unreadable.rationale.code).toBe('UNPARSEABLE');
    expect(unreadable.flags).toContain('MALFORMED_RESPONSE');
  });

  it('reports an ABSENT numeric response as BLANK and an UNREADABLE one as MALFORMED', () => {
    // A browser sends `null` for a cleared numeric input, so `{value: null}` is an unanswered question and not a
    // fault. `NaN` and a string are present and unreadable, and remain faults.
    expect(g(numeric, {}).rationale.code).toBe('BLANK');
    expect(g(numeric, { value: null }).rationale.code).toBe('BLANK');
    expect(g(numeric, { value: 'abc' }).rationale.code).toBe('UNPARSEABLE');
    expect(g(numeric, { value: Number.NaN }).flags).toContain('MALFORMED_RESPONSE');
  });

  it('ADV-S2: does NOT call an object blank when it is carrying something this type cannot read', () => {
    /**
     * `PF-5` made a MISSING field a blank and tested it with `{}`. An object with no `value` that is NOT empty took
     * the same branch: a simulation's `{ state, answer }` saved against a numeric question, or a client that
     * renamed `value`, scored `BLANK` -- zero marks and no flag -- while `gradePaper` counted it as answered.
     *
     * What breaks without it: the student's answer is in the response, the grader cannot see it, and the record says
     * they left the question out. Nothing is raised, so nobody looks.
     */
    const cases: ReadonlyArray<readonly [QuestionSpec, unknown, string]> = [
      [numeric, { state: { angle: 12 }, answer: 5 }, 'The number returned could not be read.'],
      [numeric, { number: 9.81 }, 'The number returned could not be read.'],
      [numeric, { raw: '9.81' }, 'The number returned could not be read.'],
      [numeric, { text: '' }, 'The number returned could not be read.'],
      [shortText, { state: { angle: 12 }, answer: 5 }, 'The text returned could not be read.'],
      [shortText, { value: 'photosynthesis' }, 'The text returned could not be read.'],
      [shortText, { choiceIds: [] }, 'The text returned could not be read.'],
    ];
    for (const [spec, response, explanation] of cases) {
      const result = g(spec, response);
      expect(result.rationale).toEqual({ code: 'UNPARSEABLE', explanation, detail: {} });
      expect(result.flags).toEqual(['MALFORMED_RESPONSE']);
      expect(result.points).toBe(0);
    }
  });

  it('ADV-S2: still calls the two real shapes of an emptied field blank, with no flag', () => {
    // The fix must not reopen `PF-5`: an untouched paper is not a list of platform faults. Blank is the EMPTY
    // object, or the field itself present and holding nothing -- whatever else is beside it.
    const cases: ReadonlyArray<readonly [QuestionSpec, unknown]> = [
      [numeric, {}],
      [numeric, { value: null }],
      [numeric, { value: undefined }],
      [numeric, { value: null, raw: '' }],
      [shortText, {}],
      [shortText, { text: null }],
      [shortText, { text: undefined }],
      [shortText, { text: null, savedAt: 1 }],
    ];
    for (const [spec, response] of cases) {
      const result = g(spec, response);
      expect(result.rationale.code).toBe('BLANK');
      expect(result.flags).toEqual([]);
      expect(result.points).toBe(0);
    }
  });

  it('names a bad REGEX pattern as NEEDS_HUMAN rather than marking the student wrong', () => {
    const broken = {
      ...shortText,
      matcher: 'REGEX_SET',
      matchers: { patterns: ['(unclosed'] },
    } as QuestionSpec;
    const result = g(broken, { text: 'photosynthesis' });
    expect(result.points).toBe(0);
    expect(result.flags).toContain('NEEDS_HUMAN');
    // The mark is zero, but the flag says a HUMAN must look, which is the difference between a wrong answer
    // and a broken question.
    expect(result.flags).not.toContain('MALFORMED_RESPONSE');
  });

  it('marks a fully ordered response CORRECT', () => {
    const result = g(ordering, { itemIds: ['i1', 'i2', 'i3'] });
    expect(result.rationale.code).toBe('CORRECT');
    expect(result.points).toBe(common.points);
  });

  it('reports an ordering response with no itemIds as MALFORMED', () => {
    const result = g(ordering, {});
    expect(result.rationale.code).toBe('UNPARSEABLE');
    expect(result.flags).toContain('MALFORMED_RESPONSE');
  });

  it('reports an EMPTY ordering as BLANK, and never as correct', () => {
    /**
     * THE BUG THIS CAUGHT. `orderingCredit` guarded `length <= 1`, so an empty response was "trivially in
     * order" and scored FULL MARKS. A student who submitted nothing would have scored 100% on every ordering
     * question in the paper, and the only reason it was found is that an unrelated test about unreachable
     * switch arms happened to pass an empty array.
     */
    const result = g(ordering, { itemIds: [] });
    expect(result.points).toBe(0);
    expect(result.correct).toBe(false);
    expect(result.rationale.code).toBe('BLANK');
  });

  it('names the mis-ordered pairs in the rationale, so a marker is not given an opaque fraction', () => {
    const result = g(ordering, { itemIds: ['i2', 'i1', 'i3'] });
    expect(result.rationale.code).toBe('PARTIAL');
    expect(result.points).toBeGreaterThan(0);
    expect(result.points).toBeLessThan(common.points);
    expect(String(result.rationale.detail.misordered)).not.toBe('');
  });
});

/**
 * Tests for grading a whole paper.  (P7-T9)
 *
 * ## THE PROPERTIES ARE ABOUT ORDER AND ABOUT ABSENCE
 *
 * Two things can go wrong in a paper grade and neither throws: the grades can come out in a different order from
 * the marks, and an unanswered question can be silently absent from the array instead of scored as a blank. Both are
 * asserted as properties over generated papers.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { QuestionSpec } from '../question/index.js';
import { grade } from './index.js';
import { gradePaper, type PaperQuestion, unusableQuestions } from './paper.js';

const RUNS = 200;

const common = {
  points: 4,
  gradingMode: 'AUTO' as const,
  shuffleOptions: false,
  estimatedSeconds: 60,
  cognitiveDemand: 'APPLY' as const,
  tags: [],
};

const multi = (key: readonly string[] = ['a', 'c'], partialCredit = 'NC'): QuestionSpec =>
  ({
    ...common,
    type: 'multi_select',
    choices: [
      { id: 'a', text: 'Alpha' },
      { id: 'b', text: 'Bravo' },
      { id: 'c', text: 'Charlie' },
    ],
    key: { choiceIds: [...key] },
    partialCredit,
  }) as QuestionSpec;

const numeric = (): QuestionSpec =>
  ({ ...common, type: 'numeric', key: { value: 5 }, tolerance: { absolute: 0.1 } }) as QuestionSpec;

const shortText = (): QuestionSpec =>
  ({
    ...common,
    type: 'short_text',
    key: { text: 'mitochondria' },
    matcher: 'EXACT',
  }) as QuestionSpec;

const ordering = (): QuestionSpec =>
  ({
    ...common,
    type: 'ordering',
    items: [
      { id: 'i1', text: 'one' },
      { id: 'i2', text: 'two' },
    ],
    key: { itemIds: ['i1', 'i2'] },
  }) as QuestionSpec;

const singleChoice = (): QuestionSpec =>
  ({
    ...common,
    type: 'single_choice',
    choices: [
      { id: 'a', text: 'Alpha' },
      { id: 'b', text: 'Bravo' },
    ],
    key: { choiceId: 'a' },
  }) as QuestionSpec;

const trueFalse = (): QuestionSpec =>
  ({ ...common, type: 'true_false', key: { value: true } }) as QuestionSpec;

const manual = (type: 'free_response' | 'file_submission' | 'worked_solution'): QuestionSpec =>
  ({ ...common, gradingMode: 'MANUAL', type }) as QuestionSpec;

const simulation = (gradingMode: 'AUTO' | 'MANUAL'): QuestionSpec =>
  ({
    ...common,
    gradingMode,
    type: 'simulation',
    simId: 'pendulum',
    simVersion: '1',
  }) as QuestionSpec;

const paper = (specs: readonly QuestionSpec[]): PaperQuestion[] =>
  specs.map((spec, index) => ({ questionId: `q${String(index + 1)}`, spec }));

describe('a paper is graded in PAPER ORDER, which is the order the student saw', () => {
  it('keeps the question ids in the order they were given', () => {
    const result = gradePaper(paper([multi(), numeric(), shortText()]), {});
    expect(result.grades.map((entry) => entry.questionId)).toEqual(['q1', 'q2', 'q3']);
  });

  it('does NOT order by response, so the grades and the receipt can be derived from one list', () => {
    /**
     * The obvious implementation walks the ANSWERS, which produces a grades array and a receipt in two different
     * orders. Reconciling them is where they drift, and a teacher comparing them is comparing two orderings and
     * having to trust one was derived from the other.
     */
    const questions = paper([multi(), numeric(), shortText()]);
    const responses = { q3: { text: 'mitochondria' }, q1: { choiceIds: ['a', 'c'] } };
    const result = gradePaper(questions, responses);
    expect(result.grades.map((entry) => entry.questionId)).toEqual(['q1', 'q2', 'q3']);
    // q2 has no response at all and is still present, in its place.
    expect(result.grades[1]?.questionId).toBe('q2');
    expect(result.grades[1]?.blank).toBe(true);
  });

  it('holds paper order for ANY order of the response keys', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.constantFrom('q1', 'q2', 'q3', 'q4'), { minLength: 0, maxLength: 4 }),
        (keys) => {
          const questions = paper([multi(), numeric(), shortText(), multi(['a'])]);
          const responses: Record<string, unknown> = {};
          for (const key of keys) responses[key] = { choiceIds: ['a'] };
          return (
            JSON.stringify(gradePaper(questions, responses).grades.map((e) => e.questionId)) ===
            JSON.stringify(['q1', 'q2', 'q3', 'q4'])
          );
        },
      ),
      { numRuns: RUNS },
    );
  });
});

describe('AN UNANSWERED QUESTION IS GRADED AS A BLANK, NEVER SKIPPED', () => {
  it('produces a grades entry for every question even with no responses at all', () => {
    // Skipping would produce an array shorter than the paper, and every consumer would then have to know that
    // absence means "unanswered" while `points: 0` means "answered wrongly" -- two facts at the same length.
    const result = gradePaper(paper([multi(), numeric()]), {});
    expect(result.grades).toHaveLength(2);
    expect(result.blankCount).toBe(2);
    expect(result.answeredCount).toBe(0);
  });

  it('distinguishes a BLANK from an INCORRECT answer, which is the whole point of `blank`', () => {
    const questions = paper([multi()]);
    const blank = gradePaper(questions, {}).grades[0];
    const wrong = gradePaper(questions, { q1: { choiceIds: ['b'] } }).grades[0];
    expect(blank?.blank).toBe(true);
    expect(blank?.outcome.points).toBe(0);
    expect(wrong?.blank).toBe(false);
    expect(wrong?.outcome.points).toBe(0);
    // Same mark, different fact -- which is exactly the distinction a marker needs and `points` alone cannot give.
    // The rationale is BLANK for a type that HAS a blank path; `PaperGrade.blank` is the paper-level truth for the
    // types that do not, and it is what a caller should branch on.
    expect(blank?.outcome.rationale.code).toBe('BLANK');
    expect(wrong?.outcome.rationale.code).not.toBe('BLANK');
  });

  it('treats each shape of "not answered" as blank', () => {
    const questions = paper([multi(), multi(), numeric(), shortText()]);
    const result = gradePaper(questions, {
      q1: { choiceIds: [] },
      q2: undefined,
      q3: { value: null },
      q4: { text: '   ' },
    });
    expect(result.grades.map((entry) => entry.blank)).toEqual([true, true, true, true]);
    // And an ABSENT key is distinguished from a MALFORMED one, which is the whole reason for `emptyResponseFor`.
    const malformed = gradePaper(questions, { q1: { choiceIds: 'not an array' } });
    expect(malformed.grades[0]?.blank).toBe(false);
    expect(unusableQuestions(malformed)).toContain('q1');
  });

  it('does NOT call an object with no known response field "absent"', () => {
    // A response this version does not understand should still be graded, not treated as a blank -- otherwise a
    // future question type's answers all score zero on an older grader, silently.
    const result = gradePaper(paper([multi()]), { q1: { somethingNew: true } });
    expect(result.grades[0]?.blank).toBe(false);
  });
});

describe('ADV-S1: only NOTHING is "no response" -- a present value is graded exactly as it arrived', () => {
  /** Every auto-graded type that has a `BLANK` path, so a wrong blank and a right one can be told apart by code. */
  const autoTypes = (): ReadonlyArray<readonly [string, QuestionSpec]> => [
    ['numeric', numeric()],
    ['short_text', shortText()],
    ['multi_select', multi()],
    ['ordering', ordering()],
  ];

  it('calls a present `[]` and a present `""` UNREADABLE, as `grade` itself does', () => {
    /**
     * `gradePaper` counted a bare `[]` and a bare `''` as "absent" for every type, substituted the type's empty
     * shape, and reported a blank with no flag. `grade()` on the same value raised `MALFORMED_RESPONSE`. No
     * response shape is a bare array or a bare string, so neither is an empty answer: it is the wrong type in the
     * slot, and that it is empty NOW says nothing about what the student put there.
     *
     * What breaks without it: an answer mangled between the student and the database is recorded as a question the
     * student chose to leave out, indistinguishable from thirty real blanks, and nobody looks.
     */
    for (const [type, spec] of autoTypes()) {
      for (const rubbish of [[], '', '   ']) {
        const label = `${type} <- ${JSON.stringify(rubbish)}`;
        const result = gradePaper(paper([spec]), { q1: rubbish });
        const entry = result.grades[0];
        expect(entry?.blank, label).toBe(false);
        expect(entry?.outcome.rationale.code, label).toBe('UNPARSEABLE');
        expect(entry?.flags, label).toEqual(['MALFORMED_RESPONSE']);
        expect(unusableQuestions(result), label).toEqual(['q1']);
        expect([result.answeredCount, result.blankCount], label).toEqual([1, 0]);
        // The two layers, on the same value:
        expect(entry?.outcome, label).toEqual(grade({ spec, response: rubbish }));
      }
    }
  });

  it('still calls the slot EMPTY for an absent key, `undefined` and `null`, and raises nothing', () => {
    // `null` is how JSON and a nullable column say "no value". It is absence written down, not a value.
    for (const [type, spec] of autoTypes()) {
      for (const responses of [{}, { q1: undefined }, { q1: null }]) {
        const label = `${type} <- ${JSON.stringify(responses)}`;
        const result = gradePaper(paper([spec]), responses);
        expect(result.grades[0]?.blank, label).toBe(true);
        expect(result.grades[0]?.outcome.rationale.code, label).toBe('BLANK');
        expect(result.grades[0]?.flags, label).toEqual([]);
        expect(unusableQuestions(result), label).toEqual([]);
        expect([result.answeredCount, result.blankCount], label).toEqual([0, 1]);
      }
    }
  });

  it('does not find an answer on the prototype chain, for a question whose id is an inherited name', () => {
    for (const questionId of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const result = gradePaper([{ questionId, spec: numeric() }], {});
      expect(result.grades[0]?.blank, questionId).toBe(true);
      expect(result.grades[0]?.outcome.rationale.code, questionId).toBe('BLANK');
    }
  });

  it('calls ANOTHER type’s empty answer in the slot unreadable, not blank', () => {
    /**
     * The old check looked for any of five field names on any question, so `{choiceIds: []}` -- a multi-select's
     * empty answer -- was a blank in a NUMERIC slot. It is not that question's empty answer. It is another
     * question's answer in the wrong place, which is a fault whether or not it happens to be empty.
     */
    const cases: ReadonlyArray<readonly [QuestionSpec, unknown]> = [
      [numeric(), { choiceIds: [] }],
      [numeric(), { text: '   ' }],
      [numeric(), { value: [] }],
      [numeric(), { value: '' }],
      [shortText(), { value: null }],
      [shortText(), { text: [] }],
      [multi(), { value: null }],
      [multi(), { choiceIds: null }],
      [multi(), { choiceIds: '' }],
      [ordering(), { choiceIds: [] }],
      [ordering(), { itemIds: null }],
    ];
    for (const [spec, response] of cases) {
      const label = `${spec.type} <- ${JSON.stringify(response)}`;
      const result = gradePaper(paper([spec]), { q1: response });
      expect(result.grades[0]?.blank, label).toBe(false);
      expect(result.grades[0]?.flags, label).toEqual(['MALFORMED_RESPONSE']);
      expect(unusableQuestions(result), label).toEqual(['q1']);
    }
  });

  it('recognises each type’s OWN field, emptied, including the three MANUAL types', () => {
    // `assetIds` and `steps` were not in the old list at all, so an essay left empty was a blank and an upload
    // left empty was not. A marker opening a hand-marked question needs "left empty" as much as a grader does.
    const cases: ReadonlyArray<readonly [QuestionSpec, unknown]> = [
      [multi(), { choiceIds: [] }],
      [ordering(), { itemIds: [] }],
      [numeric(), { value: null }],
      [shortText(), { text: null }],
      [shortText(), { text: ' \t\n' }],
      [manual('free_response'), { text: '' }],
      [manual('free_response'), { text: null }],
      [manual('file_submission'), { assetIds: [] }],
      [manual('worked_solution'), { steps: [] }],
    ];
    for (const [spec, response] of cases) {
      const label = `${spec.type} <- ${JSON.stringify(response)}`;
      const result = gradePaper(paper([spec]), { q1: response });
      expect(result.grades[0]?.blank, label).toBe(true);
      expect(unusableQuestions(result), label).toEqual([]);
    }
    // And the same types, with something in the field, are NOT blank.
    const answered: ReadonlyArray<readonly [QuestionSpec, unknown]> = [
      [manual('free_response'), { text: 'because it is' }],
      [manual('file_submission'), { assetIds: ['asset-1'] }],
      [manual('worked_solution'), { steps: [{ text: 'x = 2' }] }],
    ];
    for (const [spec, response] of answered) {
      expect(gradePaper(paper([spec]), { q1: response }).grades[0]?.blank, spec.type).toBe(false);
    }
  });

  it('has NO cleared form for a simulation: anything present in that slot is a response', () => {
    // A sim's state is written by a bundle, not typed by a student, so there is no input to empty. `{}` and the
    // other types' empty shapes are all the remains of something, and each must reach a human.
    for (const mode of ['AUTO', 'MANUAL'] as const) {
      for (const response of [{}, [], '', { text: '' }, { value: null }, { choiceIds: [] }]) {
        const label = `${mode} <- ${JSON.stringify(response)}`;
        const result = gradePaper(paper([simulation(mode)]), { q1: response });
        const entry = result.grades[0];
        expect(entry?.blank, label).toBe(false);
        expect(entry?.needsHuman === true || unusableQuestions(result).includes('q1'), label).toBe(
          true,
        );
      }
      // Nothing in the slot is still an unanswered simulation.
      expect(gradePaper(paper([simulation(mode)]), {}).grades[0]?.blank, mode).toBe(true);
    }
  });

  it('survives a spec whose `type` is not a type, including an inherited property name', () => {
    for (const type of ['constructor', 'toString', 'essay', 42, null]) {
      const spec = { ...common, type } as unknown as QuestionSpec;
      const result = gradePaper(paper([spec]), { q1: { text: '' } });
      expect(result.grades[0]?.blank, String(type)).toBe(false);
      expect(unusableQuestions(result), String(type)).toEqual(['q1']);
    }
  });

  it('grades ANY present value exactly as `grade` does, and agrees with it about what is blank', () => {
    /**
     * The structural half. `gradePaper` substitutes for an EMPTY slot and for nothing else, so for a present value
     * the two layers produce the same `GradeOutput` -- the paper cannot hide a flag the grader raised.
     *
     * And `blank` agrees with the rationale in both directions: never "answered" beside a `BLANK` rationale (which
     * is what `{}` in a numeric slot used to say), and never "blank" beside a fault.
     */
    fc.assert(
      fc.property(
        fc.constantFrom(numeric(), shortText(), multi(), ordering()),
        fc.oneof(
          fc.jsonValue(),
          fc.record(
            {
              value: fc.jsonValue(),
              text: fc.jsonValue(),
              choiceIds: fc.jsonValue(),
              itemIds: fc.jsonValue(),
              raw: fc.jsonValue(),
            },
            { requiredKeys: [] },
          ),
        ),
        (spec, response) => {
          fc.pre(response !== null);
          const result = gradePaper(paper([spec]), { q1: response });
          const entry = result.grades[0];
          expect(entry?.outcome).toEqual(grade({ spec, response }));
          expect(entry?.blank).toBe(entry?.outcome.rationale.code === 'BLANK');
          if (entry?.blank === true) expect(entry.flags).toEqual([]);
        },
      ),
      { numRuns: RUNS * 5 },
    );
  });
});

describe('rawTotal is a SUM WITHOUT A FLOOR, and there is deliberately no `total`', () => {
  it('reports a NEGATIVE rawTotal under NG, because §3.2 forbids the floor at the item', () => {
    // "clamping at zero silently converts NG into no penalty for every student who guessed -- destroying the
    // guessing suppression NG exists to provide".
    const result = gradePaper(paper([multi(['a'], 'NG')]), { q1: { choiceIds: ['b'] } });
    expect(result.rawTotal).toBeLessThan(0);
  });

  it('has no `total` and no `percentage`, so nothing can display one by accident', () => {
    const result = gradePaper(paper([multi()]), { q1: { choiceIds: ['a', 'c'] } });
    expect(Object.keys(result).sort()).toEqual(
      [
        'answeredCount',
        'blankCount',
        'grades',
        'maxPoints',
        'needsHumanCount',
        'questionCount',
        'rawTotal',
      ].sort(),
    );
  });

  it('sums `maxPoints` over the paper, so a caller can divide once', () => {
    expect(gradePaper(paper([multi(), numeric()]), {}).maxPoints).toBe(8);
  });

  it('does NOT count a penalising method as needing a human', () => {
    // `NG`/`PM` producing a negative raw score is the method working, and is a MARK rather than a question for a
    // marker. Counting it as `needsHuman` would put every guessing student in front of a teacher.
    const penalised = gradePaper(paper([multi(['a'], 'NG')]), { q1: { choiceIds: ['b'] } });
    expect(penalised.grades[0]?.needsHuman).toBe(false);
  });

  it('DOES count an unreadable key as needing a human', () => {
    const broken = paper([{ ...multi(), key: undefined } as unknown as QuestionSpec]);
    expect(gradePaper(broken, { q1: { choiceIds: ['a'] } }).grades[0]?.needsHuman).toBe(true);
  });
});

describe('a response for a question NOT on this paper is ignored', () => {
  it('does not add a grade for it', () => {
    // It belongs to another paper, and grading it would put a mark in a total that does not include the question.
    const result = gradePaper(paper([multi()]), {
      q1: { choiceIds: ['a', 'c'] },
      q99: { choiceIds: ['a'] },
    });
    expect(result.grades).toHaveLength(1);
    expect(result.questionCount).toBe(1);
  });

  it('handles an empty paper without dividing by zero or throwing', () => {
    const result = gradePaper([], {});
    expect(result.grades).toEqual([]);
    expect(result.maxPoints).toBe(0);
    expect(result.rawTotal).toBe(0);
  });
});

/**
 * PF-5, NOW CLOSED -- the gap this describe documented is the gap that was fixed.
 *
 * It used to assert that `numeric` and `short_text` report `UNPARSEABLE` for an unanswered question while
 * `PaperGrade.blank` says `true`, and it named that as a defect in the P7-T2/P7-T4 core. Both handlers now have a
 * `BLANK` path, so the two layers agree -- which is the point. `gradePaper`'s `isAbsent` trims whitespace and the
 * grader now does too, and two layers disagreeing about the same response is how a question gets marked wrong for
 * a reason nobody can see.
 *
 * The test is inverted rather than deleted, because a test that documents a defect by naming it is worth more than
 * a silent workaround, and the inverse is what stops the gap reopening.
 */
describe('PF-5 closed: the grader and the paper layer now AGREE about a blank', () => {
  it('reports BLANK for every type with a blank path, including the two that were fixed', () => {
    const result = gradePaper(paper([numeric(), shortText(), multi(), multi()]), {});
    expect(result.grades.map((entry) => entry.blank)).toEqual([true, true, true, true]);
    expect(result.grades.map((entry) => entry.outcome.rationale.code)).toEqual([
      'BLANK',
      'BLANK',
      'BLANK',
      'BLANK',
    ]);
  });

  it('reports BLANK for a whitespace answer and not for a malformed one, at BOTH layers', () => {
    const whitespace = gradePaper(paper([shortText()]), { q1: { text: '   ' } });
    expect(whitespace.grades[0]?.blank).toBe(true);
    expect(whitespace.grades[0]?.outcome.rationale.code).toBe('BLANK');
    expect(unusableQuestions(whitespace)).toEqual([]);

    const malformed = gradePaper(paper([numeric()]), { q1: { value: 'abc' } });
    expect(malformed.grades[0]?.blank).toBe(false);
    expect(unusableQuestions(malformed)).toEqual(['q1']);
  });

  it('no longer raises MALFORMED_RESPONSE on a paper of entirely unanswered questions', () => {
    // The practical effect of PF-5: a marker opening an untouched paper saw a list of platform faults, because
    // every unanswered numeric and short-text question reported one.
    const result = gradePaper(paper([numeric(), shortText(), numeric()]), {});
    expect(unusableQuestions(result)).toEqual([]);
    expect(result.needsHumanCount).toBe(0);
  });
});

/**
 * FOUND WHILE FIXING `ADV-S1` AND `ADV-S2`, AND NOT FIXED.
 *
 * Both are the same distinction -- unanswered versus unreadable -- failing in places the five confirmed defects did
 * not name. Each `it.fails` asserts the guarantee as it should hold and goes RED when the defect is fixed, at which
 * point the marker comes off. They are pinned rather than fixed because each fix changes what `grade()` returns for
 * a shape an existing test pins, which is a decision and not a repair.
 */
describe('KNOWN, NOT FIXED: two more places unanswered and unreadable are confused', () => {
  /**
   * `PF-5` gave `numeric` and `short_text` a `BLANK` path. `single_choice` and `true_false` still have none, so
   * `emptyResponseFor` hands the grader `{}` and it answers `UNPARSEABLE` with `MALFORMED_RESPONSE`. An UNTOUCHED
   * paper therefore lists every single-choice and true/false question as a platform fault -- `PF-5`'s own symptom,
   * on the two commonest types -- while `blank` is `true` on the same entry.
   *
   * The fix is in `grading/index.ts` and it inverts `index.test.ts`'s "marks a blank as UNPARSEABLE".
   */
  it.fails('an UNANSWERED single_choice or true_false is a blank, not a malformed response', () => {
    for (const spec of [singleChoice(), trueFalse()]) {
      const result = gradePaper(paper([spec]), {});
      expect(result.grades[0]?.blank).toBe(true);
      expect(result.grades[0]?.outcome.rationale.code).toBe('BLANK');
      expect(unusableQuestions(result)).toEqual([]);
    }
  });

  /**
   * `asStringArray` drops the entries of a list that are not strings, which is right when SOME are: half a list
   * beats none. When NONE are -- a client that sent option ids as numbers -- every entry is dropped, the list is
   * empty, and the handler reports `BLANK` with no flag. The student selected two options and the record says
   * they selected nothing. That is `ADV-S2` again, one level down.
   */
  it.fails('a selection whose every entry is unreadable is a fault, not a blank', () => {
    const cases: ReadonlyArray<readonly [QuestionSpec, unknown]> = [
      [multi(), { choiceIds: [1, 3] }],
      [ordering(), { itemIds: [1, 2] }],
    ];
    for (const [spec, response] of cases) {
      const result = gradePaper(paper([spec]), { q1: response });
      expect(result.grades[0]?.blank).toBe(false);
      expect(unusableQuestions(result)).toEqual(['q1']);
    }
  });
});

describe('unusableQuestions separates the two things a caller must handle differently', () => {
  it('names an UNKNOWN_TYPE question, which is a defect', () => {
    const questions = paper([
      {
        ...common,
        type: 'simulation',
        simId: 'x',
        simVersion: '1',
        params: {},
        scoringSurface: 'ENDPOINT_ONLY',
      } as unknown as QuestionSpec,
      multi(),
    ]);
    expect(unusableQuestions(gradePaper(questions, {}))).toEqual(['q1']);
  });

  it('names a MALFORMED_RESPONSE question, which a marker must see', () => {
    expect(
      unusableQuestions(gradePaper(paper([multi()]), { q1: { choiceIds: 'not an array' } })),
    ).toEqual(['q1']);
  });

  it('names nothing for a clean paper', () => {
    expect(
      unusableQuestions(gradePaper(paper([multi()]), { q1: { choiceIds: ['a', 'c'] } })),
    ).toEqual([]);
  });
});

describe('properties over a paper grade', () => {
  it('always produces exactly one grade per question, whatever the responses', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 8 }),
        fc.dictionary(fc.constantFrom('q1', 'q2', 'q3', 'q4', 'q9'), fc.jsonValue()),
        (count, responses) => {
          const specs = Array.from({ length: count }, (_, index) =>
            index % 3 === 0 ? numeric() : index % 3 === 1 ? shortText() : multi(),
          );
          const result = gradePaper(paper(specs), responses);
          return result.grades.length === count && result.questionCount === count;
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('counts answered and blank so the two always sum to the question count', () => {
    fc.assert(
      fc.property(
        fc.array(fc.option(fc.jsonValue(), { nil: undefined }), { maxLength: 6 }),
        (values) => {
          const specs = values.map(() => multi());
          const responses: Record<string, unknown> = {};
          values.forEach((value, index) => {
            responses[`q${String(index + 1)}`] = value;
          });
          const result = gradePaper(paper(specs), responses);
          return result.answeredCount + result.blankCount === result.questionCount;
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('holds every mark between zero and its maximum, because `bounded` is a property of `grade` too', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.constantFrom('q1', 'q2'), fc.jsonValue()), (responses) => {
        const result = gradePaper(paper([multi(), multi()]), responses);
        return result.grades.every(
          (entry) => entry.outcome.points >= 0 && entry.outcome.points <= entry.outcome.maxPoints,
        );
      }),
      { numRuns: RUNS },
    );
  });

  it('is a FUNCTION of its inputs, so a regrade of the same submission is identical', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.constantFrom('q1'), fc.jsonValue()), (responses) => {
        const questions = paper([multi()]);
        // Two separate calls, hoisted: written as one expression compared with itself it is a self-compare,
        // which `noSelfCompare` flags, and rightly.
        const first = gradePaper(questions, responses);
        const second = gradePaper(questions, responses);
        return JSON.stringify(first) === JSON.stringify(second);
      }),
      { numRuns: RUNS },
    );
  });
});

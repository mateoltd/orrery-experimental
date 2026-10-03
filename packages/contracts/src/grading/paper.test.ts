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

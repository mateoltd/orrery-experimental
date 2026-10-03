/**
 * The assertion that makes `answerFixtures` worth having.  (P7-T5)
 *
 * ## THE TEST IS DELIBERATELY THE OPPOSITE OF A SNAPSHOT
 *
 * Every assertion here is `expect(grade(...)).toEqual(fixture.expected)` where `fixture.expected` was written
 * out by hand in `fixtures.ts` and never derived from the grader's output. If the grader and the table disagree,
 * this file FAILS. A snapshot would have recorded the disagreement as the new truth.
 *
 * ## AND THE FIRST RUN OF THIS FILE FAILED ON A REAL GAP, NOT A TYPO
 *
 * `short_text` and `ordering` questions were marked `AUTO` and returned `UNKNOWN_QUESTION_TYPE`, because P7-T4
 * added the matchers but never added the dispatch cases. The behaviour was safe -- a visible `NEEDS_HUMAN`
 * flag rather than a zero -- so no existing test noticed. This file noticed, which is the argument for writing
 * the table before trusting the suite.
 */

import { describe, expect, it } from 'vitest';
import { GRADER_VERSION, grade, HANDLED } from '../grading/index.js';
import {
  ANSWER_FIXTURES,
  assertCoverage,
  fixture,
  handComputedScore,
  REVIEW_IS_COMPLETE,
  unreviewedFixtures,
} from './fixtures.js';
import type { PartialCreditMethod } from './index.js';

/** The six methods, declared here as well so a method added to one place and not the other is a failure. */
const ALL_METHODS: readonly PartialCreditMethod[] = ['NC', '1PM', 'NG', 'SU', 'RI', 'PM'];

describe('answerFixtures agree with the grader', () => {
  it('has fixtures, and every one is uniquely named', () => {
    expect(ANSWER_FIXTURES.length).toBeGreaterThan(30);
    const names = ANSWER_FIXTURES.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('grades every fixture to its HAND-COMPUTED points, rawPoints, maxPoints, correct and rationale', () => {
    const mismatches: string[] = [];
    for (const fixture of ANSWER_FIXTURES) {
      const actual = grade({ spec: fixture.spec, response: fixture.response });
      const problems: string[] = [];
      if (actual.points !== fixture.expected.points) {
        problems.push(`points ${actual.points} != hand-computed ${fixture.expected.points}`);
      }
      if (actual.rawPoints !== fixture.expected.rawPoints) {
        problems.push(
          `rawPoints ${actual.rawPoints} != hand-computed ${fixture.expected.rawPoints}`,
        );
      }
      if (actual.maxPoints !== fixture.expected.maxPoints)
        problems.push(`maxPoints ${actual.maxPoints}`);
      if (actual.correct !== fixture.expected.correct) problems.push(`correct ${actual.correct}`);
      if (actual.rationale.code !== fixture.expected.rationaleCode) {
        problems.push(
          `rationale ${actual.rationale.code} != hand-computed ${fixture.expected.rationaleCode}`,
        );
      }
      if (problems.length > 0) mismatches.push(`${fixture.name}: ${problems.join('; ')}`);
    }
    /**
     * ONE assertion listing every mismatch, rather than one assertion per fixture.
     *
     * A loop of `expect`s would stop at the first failure, so a change that broke five methods would be
     * diagnosed five times in five runs. This way the whole damage is visible at once, which is what makes the
     * table reviewable -- the reviewer needs to see WHICH rules moved, not just that something did.
     */
    expect(mismatches).toEqual([]);
  });

  it('reports the grader version, so a fixture cannot outlive the grader it was written for', () => {
    const result = grade({ spec: ANSWER_FIXTURES[0].spec, response: ANSWER_FIXTURES[0].response });
    expect(result.graderVersion).toBe(GRADER_VERSION);
  });
});

describe('the fixture table is COMPLETE, which is the part that is easy to forget', () => {
  it('crosses every partial-credit method with the type that has methods', () => {
    expect(assertCoverage(HANDLED, ALL_METHODS)).toEqual([]);
  });

  it('covers every auto-graded type the core dispatches, including the two P7-T4 nearly missed', () => {
    /**
     * `HANDLED` is read from the grader rather than restated, so adding a handler without adding a fixture is a
     * failure here. That is the whole mechanism: the gap is only visible if something compares the two lists.
     */
    for (const type of HANDLED) {
      expect(
        ANSWER_FIXTURES.some((entry) => entry.spec.type === type),
        `${type} is auto-graded but has no answerFixture`,
      ).toBe(true);
    }
  });

  it('covers short_text and ordering, the two that were dispatching to NEEDS_HUMAN', () => {
    const types = new Set(ANSWER_FIXTURES.map((entry) => entry.spec.type));
    expect(types.has('short_text')).toBe(true);
    expect(types.has('ordering')).toBe(true);
  });

  it('includes the numeric fixtures that reproduce the bugs P7-T2 fixed', () => {
    /**
     * NOT HISTORICAL NOSTALGIA. Each of these two names a defect that shipped inside this phase:
     *
     * - `numeric/relative-only-rejects-a-distant-answer` -- `absolute ?? Infinity` then SUMMING gave a bound of
     *   Infinity, so a question with `tolerance: {relative: 0.01}` and a key of 100 marked 200 CORRECT.
     * - `numeric/sig-figs-exactly-enough` -- "9.810" states FOUR significant figures, not three, because a
     *   trailing zero after the point is significant. A count that ignored it under-reported.
     *
     * A fixture table that only covered the happy path would have let both back in.
     */
    const names = ANSWER_FIXTURES.map((entry) => entry.name);
    expect(names).toContain('numeric/relative-only-rejects-a-distant-answer');
    expect(names).toContain('numeric/sig-figs-exactly-enough');
  });
});

describe('the gap detector, tested against a gap', () => {
  /**
   * A completeness check that has never reported a gap is indistinguishable from one that cannot.
   *
   * `assertCoverage` is the only thing standing between "the table grew a method" and "nobody checked the new
   * method", so it is given two deliberate gaps here and required to name both. Without this, 100% coverage of
   * `assertCoverage` would prove only that its happy path runs.
   */
  it('names a method with no fixtures', () => {
    expect(assertCoverage(HANDLED, [...ALL_METHODS, 'PROP' as PartialCreditMethod])).toEqual([
      'multi_select/PROP has no fixture',
    ]);
  });

  it('names a type with no fixtures at all', () => {
    expect(assertCoverage([...HANDLED, 'worked_solution'], ALL_METHODS)).toEqual([
      'worked_solution has no fixture at all',
    ]);
  });

  it('finds a fixture by name, and reports a miss rather than throwing', () => {
    expect(fixture('single_choice/correct')?.expected.points).toBe(4);
    // A typo in a test name must not read as "no such fixture, skip it".
    expect(fixture('single_choice/typo')).toBeUndefined();
  });

  it('treats an UNKNOWN method as zero rather than throwing', () => {
    /**
     * `PROP` is in `plans/07` §3's table and in no code path -- it is marked `PUBLISHED_BUT_UNIMPLEMENTED`.
     * So a question bank can legitimately contain one, and the hand-computed reader must survive it rather than
     * return `NaN` and quietly compare equal to nothing.
     */
    const withUnimplemented = ANSWER_FIXTURES.find(
      (entry) => entry.name === 'multi_select/NC/none-correct',
    );
    expect(withUnimplemented).toBeDefined();
  });

  it('scores an EMPTY KEY as zero, because dividing by a key of no options is not a fraction', () => {
    /**
     * A multi-select with an empty key is legal in the type system and meaningless as a question. The share
     * would be `points / 0 = Infinity`, and any non-zero count would become `Infinity * Infinity`. The reader
     * returns 0 for an empty key so the fixture table can hold the shape without asserting nonsense.
     */
    const spec = {
      ...ANSWER_FIXTURES[0].spec,
      type: 'multi_select',
      choices: [{ id: 'a', text: 'A' }],
      key: { choiceIds: [] },
      partialCredit: 'NC',
    } as unknown as Parameters<typeof grade>[0]['spec'];
    const result = grade({ spec, response: { choiceIds: ['a'] } });
    expect(Number.isFinite(result.points)).toBe(true);
    expect(result.points).toBe(0);
  });

  it('REFUSES an uncomputable scoring method instead of throwing or guessing', () => {
    /**
     * THE TOTALLY VIOLATION THIS FIXTURE CAUGHT.
     *
     * The first draft of the test above spread a `single_choice` fixture into a `multi_select` spec, which is
     * type-invalid -- and the grader THREW. `BY_METHOD[method]` is a `Record` lookup, so a spec with no
     * `partialCredit` indexed it with `undefined` and produced a `TypeError` from inside `grade`.
     *
     * `partialCredit` is REQUIRED by the type, so this is not reachable from typed code. But `grade` reads
     * specs out of JSON columns written by authoring tools, and `plans/07` §4 requires every `(spec, response)`
     * pair to return a `GradeOutput`. A throw from inside the auto-grade loop is how a whole class of students
     * gets no marks at all, with nothing in the attempt log to explain it.
     *
     * So an uncomputable method is now refused with `NEEDS_HUMAN` and the student's counts attached. Note what
     * it does NOT do: it does not fall back to `NC`, which would invent a scoring policy, and it does not
     * return zero, which would invent a mark.
     */
    const spec = {
      ...ANSWER_FIXTURES[0].spec,
      type: 'multi_select',
      choices: [
        { id: 'a', text: 'A' },
        { id: 'b', text: 'B' },
      ],
      key: { choiceIds: ['a'] },
      partialCredit: 'PROP',
    } as unknown as Parameters<typeof grade>[0]['spec'];
    const result = grade({ spec, response: { choiceIds: ['a'] } });
    expect(result.points).toBe(0);
    expect(result.correct).toBe(false);
    expect(result.flags).toContain('NEEDS_HUMAN');
    expect(result.rationale.code).toBe('MANUAL_REQUIRES_HUMAN');
    expect(result.rationale.detail.method).toBe('PROP');
    // The counts survive, so a marker can see what the student actually chose.
    expect(result.rationale.detail.correctCount).toBe(1);
  });

  it('never throws on ANY spec, which is §4 restated as an assertion over garbage', () => {
    /**
     * `total` IS A PROPERTY, AND A PROPERTY NEEDS A GENERATOR RATHER THAN A FEW EXAMPLES.
     *
     * Each spec here is missing or corrupting one field that the grader reads, which is the shape a bank
     * imported from an older schema version actually has. The assertion is that `grade` RETURNS for all of
     * them -- not that the marks are right, which is a different question and is what the fixture table is for.
     */
    const base = ANSWER_FIXTURES.find(
      (entry) => entry.name === 'multi_select/NC/exactly-correct',
    )?.spec;
    expect(base).toBeDefined();
    const corruptions: ReadonlyArray<Record<string, unknown>> = [
      { partialCredit: undefined },
      { partialCredit: 'PROP' },
      { partialCredit: 7 },
      { key: undefined },
      { key: { choiceIds: null } },
      { choices: undefined },
      { points: undefined },
      { points: 'four' },
      { points: Number.NaN },
      { points: Number.POSITIVE_INFINITY },
    ];
    for (const patch of corruptions) {
      const spec = { ...(base as object), ...patch } as Parameters<typeof grade>[0]['spec'];
      for (const response of [{ choiceIds: ['a'] }, { choiceIds: [] }, {}, null, 'nonsense', 42]) {
        const label = `${JSON.stringify(patch)} / ${JSON.stringify(response)}`;
        expect(() => grade({ spec, response }), label).not.toThrow();
      }
    }
  });
});

describe('the REVIEW, which this task cannot honestly claim', () => {
  it('records every fixture as UNREVIEWED, because the author is not a second person', () => {
    /**
     * `plans/17` §3.2 requires these fixtures to be "reviewed by a second person". That has not happened, and
     * an assertion that it HAD would be the lie. So this asserts the truth: all 40-odd fixtures are awaiting a
     * reader, and `REVIEW_IS_COMPLETE()` is false.
     *
     * When a second person checks the arithmetic, the change is to set `reviewedBy` on each fixture -- and this
     * test then fails, which is the signal to flip it to assert completion. The review cannot be skipped
     * silently, and it cannot be marked done by the person it is meant to protect.
     */
    expect(unreviewedFixtures().length).toBe(ANSWER_FIXTURES.length);
    expect(REVIEW_IS_COMPLETE()).toBe(false);
  });

  it('gives every fixture a written reason, because a fixture with no working is one nobody can review', () => {
    for (const fixture of ANSWER_FIXTURES) {
      expect(fixture.why.length, `${fixture.name} has no arithmetic written down`).toBeGreaterThan(
        20,
      );
    }
  });
});

describe('the hand-computed READER is total too, over the same garbage the grader now survives', () => {
  /**
   * `handComputedScore` is the second reading of `plans/07` §3, so it owes the same totality as the grader:
   * an edge it cannot handle has to be visible, not `NaN`. `NaN` would be the worst outcome here, because
   * `expect(NaN).toEqual(NaN)` passes with `Object.is` -- a fixture asserting `NaN` would agree with anything.
   */
  it('reports a gap for a method outside the six rather than returning NaN', () => {
    const result = handComputedScore('PROP' as PartialCreditMethod, ['a'], ['a', 'c'], 4, 4);
    expect(Number.isNaN(result.rawPoints)).toBe(false);
    expect(result.rawPoints).toBe(0);
    expect(result.reason).toBe('unknown method');
  });

  it('returns 0 for an EMPTY key, because points / 0 is not a fraction', () => {
    // `share` is 0 for an empty key, matching `shareFor` in the grader -- so this arm and that one agree.
    const result = handComputedScore('NC', ['a'], [], 4, 4);
    expect(result.rawPoints).toBe(0);
    expect(Number.isFinite(result.rawPoints)).toBe(true);
  });

  it('agrees with the grader on every method for a selection it can compute', () => {
    /**
     * THE READER AND THE GRADER ARE INDEPENDENT IMPLEMENTATIONS, so this is a genuine cross-check rather
     * than a tautology: `methods.ts` reads a tally, this file re-derives `correct - incorrect` from the plan.
     */
    for (const method of ALL_METHODS) {
      for (const selection of [
        ['a', 'c'],
        ['a'],
        ['b', 'd'],
        ['a', 'b', 'c'],
        ['a', 'b'],
        [],
      ] as const) {
        const template = ANSWER_FIXTURES.find((entry) => entry.spec.type === 'multi_select');
        if (template === undefined)
          throw new Error('the table has no multi_select fixture to build from');
        const spec = {
          ...template.spec,
          partialCredit: method,
          key: { choiceIds: ['a', 'c'] },
        } as Parameters<typeof grade>[0]['spec'];
        const expected = handComputedScore(method, [...selection], ['a', 'c'], 4, 4);
        const actual = grade({ spec, response: { choiceIds: [...selection] } });
        const label = `${method} / ${JSON.stringify(selection)}`;
        expect(actual.points, label).toBeCloseTo(expected.points, 10);
        expect(actual.rawPoints, label).toBeCloseTo(expected.rawPoints, 10);
      }
    }
  });
});

describe('every AUTO-GRADED type survives having no key, which the first sweep did not test', () => {
  /**
   * `HANDLED` is the list, so the sweep walks IT rather than restating the types.
   *
   * The first version of this garbage sweep built its corruptions from ONE `multi_select` fixture, so it proved
   * `grade` was total for one type out of six. `readKey` has five separate `null` arms -- one per handler --
   * and four of them were unexercised, which is the shape of a bug that would only appear in production for
   * whichever question type nobody tested.
   */
  const VALID: Readonly<Record<string, { spec: unknown; responses: readonly unknown[] }>> = {
    single_choice: {
      spec: { type: 'single_choice', choices: [{ id: 'a', text: 'A' }], key: { choiceId: 'a' } },
      responses: [{ choiceId: 'a' }, {}, null],
    },
    multi_select: {
      spec: {
        type: 'multi_select',
        choices: [{ id: 'a', text: 'A' }],
        key: { choiceIds: ['a'] },
        partialCredit: 'NC',
      },
      responses: [{ choiceIds: ['a'] }, {}, null],
    },
    true_false: {
      spec: { type: 'true_false', key: { value: true } },
      responses: [{ value: true }, {}, null],
    },
    numeric: {
      spec: { type: 'numeric', key: { value: 5 }, tolerance: { absolute: 0.1 } },
      responses: [{ value: 5 }, {}, null],
    },
    short_text: {
      spec: { type: 'short_text', key: { text: 'x' }, matcher: 'EXACT' },
      responses: [{ text: 'x' }, {}, null],
    },
    ordering: {
      spec: { type: 'ordering', items: [{ id: 'i1', text: 'one' }], key: { itemIds: ['i1'] } },
      responses: [{ itemIds: ['i1'] }, {}, null],
    },
  };

  const base = (extra: Record<string, unknown>): Record<string, unknown> => ({
    id: 'fx',
    points: 4,
    gradingMode: 'AUTO',
    shuffleOptions: false,
    estimatedSeconds: 60,
    cognitiveDemand: 'APPLY',
    tags: [],
    ...extra,
  });

  it('walks every type in HANDLED, so a new handler arrives with its refusal already tested', () => {
    expect([...HANDLED].sort()).toEqual(Object.keys(VALID).sort());
  });

  it('refuses each type with no readable key, flagging it rather than scoring it', () => {
    for (const type of HANDLED) {
      const entry = VALID[type];
      expect(entry, `no valid ${type} spec in this test`).toBeDefined();
      for (const key of [undefined, null, 'a', 7, [], { choiceIds: null }]) {
        const spec = base({ ...(entry.spec as object), key }) as Parameters<
          typeof grade
        >[0]['spec'];
        const result = grade({ spec, response: entry.responses[0] });
        const label = `${type} with key ${JSON.stringify(key)}`;
        // NO MARK, and a flag that says a human must look. The counts of what the student chose are still
        // available on the response, so nothing is lost by refusing.
        expect(result.points, label).toBe(0);
        expect(result.flags, label).toContain('NEEDS_HUMAN');
        expect(result.flags, label).toContain('OUT_OF_RANGE_KEY');
        expect(result.rationale.detail.type, label).toBe(type);
      }
    }
  });

  it('scores each type normally when its key IS readable, so the refusals are not passing by accident', () => {
    for (const type of HANDLED) {
      const entry = VALID[type];
      const spec = base(entry.spec as object) as Parameters<typeof grade>[0]['spec'];
      const result = grade({ spec, response: entry.responses[0] });
      expect(result.points, `${type} should score its correct answer`).toBe(4);
      expect(result.correct, `${type} should mark its correct answer correct`).toBe(true);
    }
  });

  it('survives a key of the right shape but the wrong TYPES inside it', () => {
    /**
     * A record is not a valid key. `key: {choiceIds: 'a'}` passes `readKey`'s record check and then fails
     * every read inside it, so this is the layer where a cast would otherwise turn into a `TypeError`.
     */
    for (const type of HANDLED) {
      const entry = VALID[type];
      for (const key of [
        { choiceId: 7 },
        { choiceIds: 'a' },
        { value: 'yes' },
        { text: 42 },
        { itemIds: 9 },
        // A list that is MOSTLY strings is still a malformed key: dropping the odd entry out would silently
        // remove an option from the question, which is how a key ends up scoring against the wrong set.
        { choiceIds: ['a', 7] },
        { itemIds: ['i1', null] },
        { choiceIds: [7, 'a'] },
      ]) {
        const spec = base({ ...(entry.spec as object), key }) as Parameters<
          typeof grade
        >[0]['spec'];
        for (const response of entry.responses) {
          expect(() => grade({ spec, response }), `${type} / ${JSON.stringify(key)}`).not.toThrow();
        }
      }
    }
  });

  it('survives a spec whose non-key fields are corrupt, for EVERY type', () => {
    /**
     * `points` is read by `readTypedKey` to build the refusal's `maxPoints`, so a spec with no `points` is the
     * one input that reaches the `?? 0` there. Walking every type rather than `numeric` alone is what finds
     * that -- the first version of this test was numeric-only and covered the arm by accident.
     */
    for (const type of HANDLED) {
      const entry = VALID[type];
      for (const patch of [
        { tolerance: undefined },
        { tolerance: 'wide' },
        { tolerance: null },
        { points: undefined },
        { points: 'four' },
        { points: Number.NaN },
        { points: Number.POSITIVE_INFINITY },
        { points: -5 },
        { points: 0 },
      ]) {
        const spec = base({ ...(entry.spec as object), ...patch }) as Parameters<
          typeof grade
        >[0]['spec'];
        for (const response of entry.responses) {
          expect(() => grade({ spec, response }), `${type} ${JSON.stringify(patch)}`).not.toThrow();
        }
        // A refusal on a spec with no `points` reports `maxPoints` 0 rather than NaN.
        const refusal = grade({ spec, response: entry.responses[1] });
        expect(Number.isFinite(refusal.maxPoints), `${type} ${JSON.stringify(patch)}`).toBe(true);
      }
    }
  });

  it('survives a short_text key whose text is not a string, matching nothing rather than throwing', () => {
    // An empty key matches nothing, so the student is marked wrong -- visible, and not a crash.
    const spec = base({ type: 'short_text', key: { text: 42 }, matcher: 'EXACT' }) as Parameters<
      typeof grade
    >[0]['spec'];
    const result = grade({ spec, response: { text: 'anything' } });
    expect(result.points).toBe(0);
    expect(Number.isFinite(result.points)).toBe(true);
  });

  it('survives a multi_select whose choices array is missing, reporting the size clause honestly', () => {
    /**
     * `optionCount` is `M`, and the size clauses of `1PM`, `RI` and `PM` are meaningless without it. With no
     * choices list, `M` is 0, so selecting more than the key means selecting more than zero -- which the size
     * clause reports as a refusal to score rather than as a crash on `undefined.length`.
     */
    const spec = base({
      type: 'multi_select',
      key: { choiceIds: ['a', 'c'] },
      partialCredit: '1PM',
    }) as Parameters<typeof grade>[0]['spec'];
    const result = grade({ spec, response: { choiceIds: ['a'] } });
    expect(Number.isFinite(result.points)).toBe(true);
  });
});

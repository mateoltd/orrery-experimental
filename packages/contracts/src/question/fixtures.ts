/**
 * `answerFixtures` — hand-computed expected grades.  (P7-T5)
 *
 * ## THESE ARE THE NUMBERS THAT DECIDE STUDENTS' GRADES, WHICH IS WHY THEY ARE NOT SNAPSHOTS
 *
 * `plans/17` §3.2: "hand-computed expected grades for every question type × every partial-credit method,
 * **reviewed by a second person**. These are the numbers that decide students' grades."
 *
 * A snapshot records whatever the implementation did. That is the opposite of checking it, and this phase has
 * already produced the evidence: P7-T2's numeric tolerance accepted EVERY answer while every test passed,
 * P7-T3's sig-fig rule reported 3 for `9.810`, and four of my own P7-T3 fixtures were wrong while the code
 * was right. A snapshot of any of those would have been green, stable and wrong for ever.
 *
 * So `expected` here is written out longhand, with the arithmetic in the `why`, and the tests assert the
 * grader agrees. When they disagree the FIXTURE is usually the thing that is wrong -- which is uncomfortable
 * and is the reason the plan asks for a second reader.
 *
 * ## AND THE REVIEW IS A DEPENDENCY, NOT A SIGN-OFF BOX
 *
 * `reviewedBy` is recorded per fixture because "reviewed" and "not reviewed" must not look the same in a diff.
 * Every fixture below is marked UNREVIEWED, and `assertReviewed` fails -- which is the honest state: this task's
 * defining requirement cannot be satisfied by the author. `P7-T5` is DONE in the sense that the table exists,
 * is complete, and REFUSES to claim a review that has not happened.
 */

import type { PartialCreditMethod, QuestionSpec, QuestionType } from '../question/index.js';

/** Who checked the arithmetic, or `null` for nobody. A fixture with no reviewer must be visible as such. */
export interface ReviewRecord {
  readonly reviewedBy: string | null;
  readonly reviewedAt: string | null;
}

/** UNREVIEWED. Named rather than absent so a diff shows the state changing rather than a field appearing. */
export const NOT_REVIEWED: ReviewRecord = { reviewedBy: null, reviewedAt: null };

export interface AnswerFixture {
  /** A stable identifier, because a fixture referenced by nothing is a fixture nobody reads. */
  readonly name: string;
  readonly spec: QuestionSpec;
  /** What the student sent. `unknown`, because a response is whatever a browser produced. */
  readonly response: unknown;
  /** THE HAND-COMPUTED MARK, before anyone ran the grader. */
  readonly expected: {
    readonly points: number;
    /** The untransformed score, where it differs. Negative for NG, PM and RI. */
    readonly rawPoints: number;
    readonly maxPoints: number;
    readonly correct: boolean;
    readonly rationaleCode: string;
  };
  /** THE ARITHMETIC, WRITTEN OUT. This is the part a second reader checks. */
  readonly why: string;
  readonly review: ReviewRecord;
}

const common = {
  points: 4,
  /**
   * `AUTO` on every fixture, because `grade()` refuses to auto-grade anything else -- which is correct, and it
   * means the fixtures cannot silently pass by never reaching a grader at all.
   */
  gradingMode: 'AUTO',
  shuffleOptions: false,
  estimatedSeconds: 60,
  cognitiveDemand: 'APPLY',
  tags: [],
} as const;

const choice = (id: string, text: string): { id: string; text: string } => ({ id, text });

/** Four options, two correct — the shape every partial-credit fixture uses, because it is where the methods differ. */
const FOUR_CHOICES = [
  choice('a', 'Alpha'),
  choice('b', 'Bravo'),
  choice('c', 'Charlie'),
  choice('d', 'Delta'),
];

/** The six methods, crossed with a handful of selections chosen to separate them from one another. */
const SELECTIONS: ReadonlyArray<{ readonly label: string; readonly ids: readonly string[] }> = [
  { label: 'exactly correct', ids: ['a', 'c'] },
  { label: 'one correct only', ids: ['a'] },
  { label: 'none correct', ids: ['b', 'd'] },
  { label: 'all correct plus a distractor', ids: ['a', 'b', 'c'] },
  { label: 'one correct one wrong, at key size', ids: ['a', 'b'] },
  { label: 'nothing selected', ids: [] },
];

const METHODS: readonly PartialCreditMethod[] = ['NC', '1PM', 'NG', 'SU', 'RI', 'PM'];

/**
 * THE ARITHMETIC, DERIVED FROM THE DEFINITIONS RATHER THAN PASTED IN.
 *
 * ## WHY THIS IS A FUNCTION AND NOT A TABLE OF NUMBERS
 *
 * The first draft wrote twenty-eight literal expected values, which is a table of numbers that agrees with the
 * grader only for as long as both are edited together. Deriving them from the same published rules the grader
 * implements means a rule change shows up as a DIFF in the expectations, which is the review signal `P7-T5` is
 * actually asking for.
 *
 * The rules are stated here independently of `methods.ts` -- `correct - incorrect`, and so on -- so that this
 * file is a second reading of `plans/07` section 3 rather than a restatement of the code. If the two disagree,
 * one of them has misunderstood the plan and a human needs to decide which.
 *
 * ## AND IT IS EXPORTED, BECAUSE A TABLE NOBODY CAN ASK QUESTIONS OF IS NOT A SECOND READING
 *
 * `handComputedScore` is exported so its own edges are testable: the `default` arm, which exists because a
 * fixture reader that meets an unrecognised method must report a gap rather than return `NaN`, and the
 * empty-key arm, where `points / 0` would otherwise be `Infinity`. Both were unreachable while this was a
 * private helper, which is the usual way a defensive branch becomes dead code with a reassuring name.
 */
export const handComputedScore = (
  method: PartialCreditMethod,
  selected: readonly string[],
  key: readonly string[],
  optionCount: number,
  maxPoints: number,
): { points: number; rawPoints: number; correct: boolean; reason: string } => {
  const keySet = new Set(key);
  const correct = selected.filter((id) => keySet.has(id)).length;
  const incorrect = selected.length - correct;
  const share = key.length === 0 ? 0 : maxPoints / key.length;
  const full = correct === key.length && incorrect === 0;
  const over = selected.length > key.length;

  // The per-method rule, in the plan's own words.
  let count: number;
  let reason: string;
  switch (method) {
    case 'NC':
      count = full ? key.length : 0;
      reason = 'all correct -> full, otherwise 0';
      break;
    case '1PM':
      count = over ? 0 : correct;
      reason = 'one per correct option, 0 overall if more options selected than correct ones';
      break;
    case 'NG':
      count = correct - incorrect;
      reason = 'correct minus incorrect, no size clause';
      break;
    case 'SU':
      count = incorrect === 0 ? correct : 0;
      reason = 'score only if the response is a subset of the key, then proportional';
      break;
    case 'RI':
      count = over ? 0 : correct - incorrect;
      reason = 'correct minus incorrect, but 0 if the response is larger than the key';
      break;
    case 'PM':
      count = correct - incorrect;
      reason = 'correct minus incorrect, regardless of set size';
      break;
    default:
      count = 0;
      reason = 'unknown method';
  }
  const rawPoints = count * share;
  const points = Math.min(Math.max(rawPoints, 0), maxPoints);
  void optionCount;
  return { points, rawPoints, correct: maxPoints > 0 && points >= maxPoints && full, reason };
};

// ───────────────────────────────────────────────────────────── the table

export const ANSWER_FIXTURES: readonly AnswerFixture[] = [
  // ── single_choice, one fixture per outcome a student can produce.
  {
    name: 'single_choice/correct',
    spec: {
      ...common,
      id: 'fx-sc-correct',
      type: 'single_choice',
      choices: [choice('a', 'Alpha'), choice('b', 'Bravo')],
      key: { choiceId: 'a' },
    },
    response: { choiceId: 'a' },
    expected: { points: 4, rawPoints: 4, maxPoints: 4, correct: true, rationaleCode: 'CORRECT' },
    why: 'The keyed option was chosen, so 4 of 4.',
    review: NOT_REVIEWED,
  },
  {
    name: 'single_choice/wrong',
    spec: {
      ...common,
      id: 'fx-sc-wrong',
      type: 'single_choice',
      choices: [choice('a', 'Alpha'), choice('b', 'Bravo')],
      key: { choiceId: 'a' },
    },
    response: { choiceId: 'b' },
    expected: { points: 0, rawPoints: 0, maxPoints: 4, correct: false, rationaleCode: 'INCORRECT' },
    why: 'A different option was chosen, so 0 of 4. There is no partial credit on a single choice.',
    review: NOT_REVIEWED,
  },
  {
    name: 'single_choice/blank',
    spec: {
      ...common,
      id: 'fx-sc-blank',
      type: 'single_choice',
      choices: [choice('a', 'Alpha'), choice('b', 'Bravo')],
      key: { choiceId: 'a' },
    },
    response: {},
    expected: {
      points: 0,
      rawPoints: 0,
      maxPoints: 4,
      correct: false,
      // BLANK, AND IT WAS `UNPARSEABLE` IN THIS FIXTURE TOO.
      rationaleCode: 'BLANK',
    },
    /**
     * The reasoning that made this fixture `UNPARSEABLE` was half right, and the half that was wrong is the half that
     * reached a teacher.
     *
     * "A blank and a wrong answer are different events" is exactly `plans/07`'s position, and it is preserved: this is
     * not `INCORRECT`, and `INCORRECT` would have been the real error. But **`UNPARSEABLE` is not merely
     * "not INCORRECT"** -- it is *our* fault. It raises `MALFORMED_RESPONSE`, so an untouched paper listed every
     * single-choice and true/false question to a marker as something that had gone wrong on the platform, with a
     * message that read `'No option was chosen.'` and so blamed the student for choosing nothing.
     *
     * `PF-5` established that a missing or `null` field is a `BLANK` and only a PRESENT-AND-UNREADABLE one is a fault.
     * It fixed `numeric` and `short_text`; these two types were missed, and `multi_select` one fixture along already
     * said `BLANK` for the identical absence. So the fixture table recorded both answers to one question, and
     * `fixtures.test.ts` caught the disagreement the moment the graders were made consistent -- which is the argument
     * for hand-computed fixtures over snapshots: it says `UNPARSEABLE` and disagrees in a sentence a human reads.
     */
    why: 'No option was chosen. Reported BLANK rather than INCORRECT, because a blank and a wrong answer are different events -- and rather than UNPARSEABLE, because UNPARSEABLE is a PLATFORM fault and would put an untouched question in front of a marker as our error.',
    review: NOT_REVIEWED,
  },

  // ── true_false
  {
    name: 'true_false/correct',
    spec: { ...common, id: 'fx-tf-true', type: 'true_false', key: { value: true } },
    response: { value: true },
    expected: { points: 4, rawPoints: 4, maxPoints: 4, correct: true, rationaleCode: 'CORRECT' },
    why: 'The keyed value was returned, so 4 of 4.',
    review: NOT_REVIEWED,
  },
  {
    name: 'true_false/wrong',
    spec: { ...common, id: 'fx-tf-false', type: 'true_false', key: { value: true } },
    response: { value: false },
    expected: { points: 0, rawPoints: 0, maxPoints: 4, correct: false, rationaleCode: 'INCORRECT' },
    why: 'The opposite value was returned, so 0 of 4.',
    review: NOT_REVIEWED,
  },

  // ── numeric, including the significant-figure rule that P7-T2 got wrong.
  {
    name: 'numeric/within-absolute-tolerance',
    spec: {
      ...common,
      id: 'fx-num-abs',
      type: 'numeric',
      key: { value: 9.81 },
      tolerance: { absolute: 0.05 },
    },
    response: { value: 9.83 },
    expected: { points: 4, rawPoints: 4, maxPoints: 4, correct: true, rationaleCode: 'CORRECT' },
    why: '|9.83 - 9.81| = 0.02, which is within the absolute bound of 0.05, so 4 of 4.',
    review: NOT_REVIEWED,
  },
  {
    name: 'numeric/outside-absolute-tolerance',
    spec: {
      ...common,
      id: 'fx-num-out',
      type: 'numeric',
      key: { value: 9.81 },
      tolerance: { absolute: 0.05 },
    },
    response: { value: 9.9 },
    expected: { points: 0, rawPoints: 0, maxPoints: 4, correct: false, rationaleCode: 'INCORRECT' },
    why: '|9.9 - 9.81| = 0.09, which is greater than 0.05, so 0 of 4.',
    review: NOT_REVIEWED,
  },
  {
    name: 'numeric/relative-only-tolerance',
    spec: {
      ...common,
      id: 'fx-num-rel',
      type: 'numeric',
      key: { value: 100 },
      tolerance: { relative: 0.01 },
    },
    response: { value: 100.5 },
    expected: { points: 4, rawPoints: 4, maxPoints: 4, correct: true, rationaleCode: 'CORRECT' },
    why: 'Relative bound = 0.01 * 100 = 1, and |100.5 - 100| = 0.5 is within it, so 4 of 4. The ABSENT absolute bound is 0, not unlimited.',
    review: NOT_REVIEWED,
  },
  {
    name: 'numeric/relative-only-rejects-a-distant-answer',
    spec: {
      ...common,
      id: 'fx-num-rel-out',
      type: 'numeric',
      key: { value: 100 },
      tolerance: { relative: 0.01 },
    },
    response: { value: 200 },
    expected: { points: 0, rawPoints: 0, maxPoints: 4, correct: false, rationaleCode: 'INCORRECT' },
    why: '|200 - 100| = 100, which is far outside the relative bound of 1, so 0 of 4. This is the fixture that would have caught the Infinity bound.',
    review: NOT_REVIEWED,
  },
  {
    name: 'numeric/sig-figs-exactly-enough',
    spec: {
      ...common,
      id: 'fx-num-sf-ok',
      type: 'numeric',
      key: { value: 9.81 },
      tolerance: { absolute: 0.05 },
      significantFigures: 3,
    },
    response: { value: 9.81, raw: '9.810' },
    expected: { points: 4, rawPoints: 4, maxPoints: 4, correct: true, rationaleCode: 'CORRECT' },
    why: 'Within tolerance, and "9.810" states FOUR significant figures (trailing zeros after the point are significant), which is at least the three required. 4 of 4.',
    review: NOT_REVIEWED,
  },
  {
    name: 'numeric/sig-figs-too-few',
    spec: {
      ...common,
      id: 'fx-num-sf-few',
      type: 'numeric',
      key: { value: 9.81 },
      tolerance: { absolute: 0.05 },
      significantFigures: 3,
    },
    response: { value: 9.81, raw: '9.8' },
    expected: { points: 0, rawPoints: 0, maxPoints: 4, correct: false, rationaleCode: 'INCORRECT' },
    why: '9.8 is within tolerance but states only TWO significant figures, so 0 of 4. Correct within tolerance is not sufficient.',
    review: NOT_REVIEWED,
  },
  {
    name: 'numeric/small-number-sig-figs',
    spec: {
      ...common,
      id: 'fx-num-sf-small',
      type: 'numeric',
      key: { value: 0.00981 },
      tolerance: { absolute: 0.00001 },
      significantFigures: 3,
    },
    response: { value: 0.00981, raw: '0.00981' },
    expected: { points: 4, rawPoints: 4, maxPoints: 4, correct: true, rationaleCode: 'CORRECT' },
    why: '"0.00981" states THREE significant figures, not six: the leading zeros and the zeros before the first non-zero digit are placeholders. 4 of 4.',
    review: NOT_REVIEWED,
  },

  // ── short_text, one per matcher.
  {
    name: 'short_text/exact-different-case',
    spec: {
      ...common,
      id: 'fx-st-exact',
      type: 'short_text',
      key: { text: 'photosynthesis' },
      matcher: 'EXACT',
    },
    response: { text: '  Photosynthesis ' },
    expected: { points: 4, rawPoints: 4, maxPoints: 4, correct: true, rationaleCode: 'CORRECT' },
    why: 'EXACT trims and lowercases by default, so surrounding whitespace and case do not matter. 4 of 4.',
    review: NOT_REVIEWED,
  },
  {
    name: 'short_text/fuzzy-inflection',
    spec: {
      ...common,
      id: 'fx-st-fuzzy',
      type: 'short_text',
      key: { text: 'mitochondria powerhouse' },
      matcher: 'FUZZY',
      matchers: { tokenOverlap: 0.6 },
    },
    response: { text: 'the mitochondria are the powerhouse of cells' },
    expected: { points: 4, rawPoints: 4, maxPoints: 4, correct: true, rationaleCode: 'CORRECT' },
    why: 'After stopwords and stemming: key is {mitochondria, powerhouse}, response contains both. Overlap 2/2 = 1, which is at or above 0.6. 4 of 4.',
    review: NOT_REVIEWED,
  },
  {
    name: 'short_text/fuzzy-below-threshold',
    spec: {
      ...common,
      id: 'fx-st-fuzzy-low',
      type: 'short_text',
      key: { text: 'mitochondria powerhouse' },
      matcher: 'FUZZY',
      matchers: { tokenOverlap: 0.6 },
    },
    response: { text: 'mitochondria is interesting' },
    expected: { points: 0, rawPoints: 0, maxPoints: 4, correct: false, rationaleCode: 'INCORRECT' },
    why: 'Only 1 of the 2 key tokens is present, so overlap is 1/2 = 0.5, which is below 0.6. 0 of 4.',
    review: NOT_REVIEWED,
  },
  {
    name: 'short_text/regex-invalid-pattern-matches-nothing',
    spec: {
      ...common,
      id: 'fx-st-regex-bad',
      type: 'short_text',
      key: { text: 'anything' },
      matcher: 'REGEX_SET',
      matchers: { patterns: ['(unclosed'] },
    },
    response: { text: 'anything at all' },
    expected: { points: 0, rawPoints: 0, maxPoints: 4, correct: false, rationaleCode: 'INCORRECT' },
    why: "The pattern does not compile, so it matches nothing rather than throwing. 0 of 4. A throw here would fail a student who triggered someone else's bad pattern.",
    review: NOT_REVIEWED,
  },

  // ── ordering, the adjacent-pair rule.
  {
    name: 'ordering/perfect',
    spec: {
      ...common,
      id: 'fx-or-perfect',
      type: 'ordering',
      items: [choice('a', 'first'), choice('b', 'second'), choice('c', 'third')],
      key: { itemIds: ['a', 'b', 'c'] },
    },
    response: { itemIds: ['a', 'b', 'c'] },
    expected: { points: 4, rawPoints: 4, maxPoints: 4, correct: true, rationaleCode: 'CORRECT' },
    why: 'Both adjacent pairs (a,b) and (b,c) are in order, so 2 of 2 correct = full credit. 4 of 4.',
    review: NOT_REVIEWED,
  },
  {
    name: 'ordering/one-transition-wrong-earns-most',
    spec: {
      ...common,
      id: 'fx-or-most',
      type: 'ordering',
      items: [
        choice('a', 'first'),
        choice('b', 'second'),
        choice('c', 'third'),
        choice('d', 'fourth'),
      ],
      key: { itemIds: ['a', 'b', 'c', 'd'] },
    },
    response: { itemIds: ['a', 'b', 'd', 'c'] },
    /**
     * `(4 * 2) / 3` IS WRITTEN AS THE ARITHMETIC RATHER THAN TYPED AS A NUMBER, and the first draft of this
     * fixture typed `3`. The `why` string in that draft already said 2.67 -- the working was right and the
     * number was a rounder guess at the same quantity, which is exactly the failure mode a hand-computed table
     * is supposed to catch and exactly the one a snapshot cannot.
     *
     * So the two thirds is not rounded to a half mark anywhere. `points/4` is the fraction the marker sees, and
     * rounding it here would mean the stored mark disagreed with the stated rule by up to a quarter of a mark.
     */
    expected: {
      points: (4 * 2) / 3,
      rawPoints: (4 * 2) / 3,
      maxPoints: 4,
      correct: false,
      rationaleCode: 'PARTIAL',
    },
    why: 'Three adjacent pairs, of which (a,b) and (b,d) are correct and (d,c) is not, so 2 of 3, and 4 * 2/3 = 2.666... which is NOT 3. The unrounded fraction is stored, because rounding here would make the mark disagree with the stated rule.',
    review: NOT_REVIEWED,
  },

  // ── the METHOD-CROSSED table: every method against every selection.
  ...METHODS.flatMap((method) =>
    SELECTIONS.map((selection): AnswerFixture => {
      const key = ['a', 'c'];
      const spec: QuestionSpec = {
        ...common,
        id: `fx-ms-${method}-${selection.label.replace(/\s+/gu, '-')}`,
        type: 'multi_select',
        choices: FOUR_CHOICES,
        key: { choiceIds: key },
        partialCredit: method,
      };
      const expected = handComputedScore(
        method,
        selection.ids,
        key,
        FOUR_CHOICES.length,
        common.points,
      );
      const code =
        expected.correct === true
          ? 'CORRECT'
          : expected.points > 0
            ? 'PARTIAL'
            : selection.ids.length === 0
              ? 'BLANK'
              : 'INCORRECT';
      return {
        name: `multi_select/${method}/${selection.label.replace(/\s+/gu, '-')}`,
        spec,
        response: { choiceIds: [...selection.ids] },
        expected: {
          points: expected.points,
          rawPoints: expected.rawPoints,
          maxPoints: common.points,
          correct: expected.correct,
          rationaleCode: code,
        },
        // THE ARITHMETIC IS RESTATED PER FIXTURE rather than held in one place, because this string is what a
        // second person reads. A reviewer who cannot see the working cannot check the number.
        why: `Method ${method} (${expected.reason}); selected {${selection.ids.join(', ')}} against key {${key.join(', ')}}. Per-option share is 4/2 = 2.`,
        review: NOT_REVIEWED,
      };
    }),
  ),
];

/** The fixture a name refers to, or `undefined`. A miss is a typo in a test, not a silent skip. */
export const fixture = (name: string): AnswerFixture | undefined =>
  ANSWER_FIXTURES.find((entry) => entry.name === name);

/** Every (type, method) pair the table covers, so a gap is a failure rather than an omission nobody notices. */
export const coveredCombinations = (): ReadonlySet<string> =>
  new Set(
    ANSWER_FIXTURES.filter((entry) => entry.spec.type === 'multi_select').map((entry) => {
      const method = (entry.spec as { partialCredit: PartialCreditMethod }).partialCredit;
      return `${entry.spec.type}/${method}`;
    }),
  );

/**
 * EVERY AUTO-GRADABLE TYPE HAS AT LEAST ONE FIXTURE, AND EVERY METHOD IS CROSSED WITH THE SELECTIONS.
 *
 * `plans/17` says "every question type x every partial-credit method". Read literally that is a cross product
 * of ten types and six methods, which is meaningless for nine of them -- `true_false` has no partial credit --
 * so the requirement is read as: every method crossed with the type that HAS methods, and every other
 * auto-gradable type covered at least once.
 */
export const assertCoverage = (
  autoTypes: readonly QuestionType[],
  methods: readonly string[],
): string[] => {
  const gaps: string[] = [];
  const covered = coveredCombinations();
  for (const method of methods) {
    if (!covered.has(`multi_select/${method}`)) gaps.push(`multi_select/${method} has no fixture`);
  }
  for (const type of autoTypes) {
    const anyOfType = ANSWER_FIXTURES.some((entry) => entry.spec.type === type);
    if (!anyOfType) gaps.push(`${type} has no fixture at all`);
  }
  return gaps;
};

/**
 * THE REVIEW GATE, WHICH THIS TASK CANNOT SATISFY BY ITSELF.
 *
 * `P7-T5` requires the fixtures to be "reviewed by a second person", and the author is not a second person.
 * Rather than tick a box, `reviewedBy` stays `null` and this returns the list of fixtures still awaiting a
 * reader. When someone else has checked the arithmetic, setting their name is the whole change.
 */
export const unreviewedFixtures = (): readonly string[] =>
  ANSWER_FIXTURES.filter((entry) => entry.review.reviewedBy === null).map((entry) => entry.name);

export const REVIEW_IS_COMPLETE = (): boolean => unreviewedFixtures().length === 0;

/**
 * Grading a whole paper: the auto-grade half of submit.  (P7-T9)
 *
 * ## WHY THE PAPER GRADES IN QUESTION ORDER, NOT RESPONSE ORDER
 *
 * The obvious implementation walks the answers. That produces two things that must then be reconciled -- a grade
 * list and a receipt -- and reconciling them is where they drift. `plans/01` §9.4 folds the receipt "in QUESTION
 * ORDER", so if the grades come out in a different order from the marks, a teacher comparing them is comparing
 * two orderings and has to trust that one was derived from the other.
 *
 * So there is ONE order here, it is the paper's order, and both the grades and the receipt are derived from it. The
 * paper's order is also the order the student saw, which makes "question 7 was wrong" mean something.
 *
 * ## AND A QUESTION WITH NO RESPONSE IS GRADED AS A BLANK RATHER THAN SKIPPED
 *
 * Skipping it would produce a grades array shorter than the paper, and every consumer would then have to know that
 * absence means "unanswered" while `points: 0` means "answered wrongly" -- two different facts with the same
 * length. `grade()` already reports an absent response as `BLANK` with `points: 0`, which is the correct answer, so
 * this function simply does not skip.
 *
 * ## AND IT DOES NOT SUM, BECAUSE `plans/07` §3.2 SAYS THE FLOOR BELONGS IN THE ATTEMPT TOTAL
 *
 * There is deliberately no `total` and no `percentage` here. `NG` and `PM` produce negative `rawPoints` per
 * question, and §3.2's reason for storing them unclamped is that clamping at the item "silently converts NG into no
 * penalty for every student who guessed". A `total` computed here would have to either clamp -- destroying exactly
 * that -- or be negative, and a negative total is `INV-RELEASE-2`'s forbidden shape if it ever reached a student
 * surface. So the caller receives per-question grades and does the arithmetic, once, in one place.
 */

import type { QuestionSpec } from '../question/index.js';
import type { GradeFlag, GradeOutput } from './index.js';
import { grade } from './index.js';

/** One question as the paper presents it: an id and the spec to grade against. */
export interface PaperQuestion {
  readonly questionId: string;
  readonly spec: QuestionSpec;
}

export interface PaperGrade {
  readonly questionId: string;
  readonly outcome: GradeOutput;
  /** True when the response was absent or empty, as opposed to present and wrong. */
  readonly blank: boolean;
  /** True when the grader could not produce a mark it can justify. A blank is NOT one of these. */
  readonly needsHuman: boolean;
  readonly flags: readonly GradeFlag[];
}

export interface PaperResult {
  /** IN PAPER ORDER, and never reordered by any consumer. */
  readonly grades: readonly PaperGrade[];
  readonly questionCount: number;
  readonly answeredCount: number;
  readonly blankCount: number;
  /** Questions the grader declined to score. A submission can contain these and still be valid. */
  readonly needsHumanCount: number;
  /**
   * `rawPoints` summed WITHOUT a floor, so a guessing penalty is visible to the caller that must apply one.
   *
   * Named `rawTotal` because `plans/01` §10.1 calls it that, and because a field called `total` would invite a
   * caller to display it -- and a negative total displayed before release is the failure `INV-RELEASE-2` exists to
   * prevent.
   */
  readonly rawTotal: number;
  readonly maxPoints: number;
}

/**
 * THE EMPTY RESPONSE FOR A TYPE, so an UNANSWERED question reaches the grader as a BLANK.
 *
 * ## THE GAP THIS CLOSES
 *
 * `grade()` receives one response and cannot tell "the student did not answer" from "the response could not be
 * read": both arrive as an object with no `choiceIds`, and it reports `UNPARSEABLE` for both. That is CORRECT for a
 * single response arriving at a route -- an unreadable body is a fault and must not look like a blank.
 *
 * But `gradePaper` DOES know the difference, because its responses are keyed by question id. An ABSENT KEY is a
 * question nobody answered; a PRESENT key holding rubbish is a malformed response. Passing `undefined` for the
 * first case threw that knowledge away and reported every unanswered question as `UNPARSEABLE`.
 *
 * So an absent key is translated into the type's own empty shape, and the grader's `BLANK` path -- which already
 * exists for the types that have one -- does the rest.
 */
const emptyResponseFor = (spec: QuestionSpec): unknown => {
  switch (spec.type) {
    case 'multi_select':
      return { choiceIds: [] };
    case 'ordering':
      return { itemIds: [] };
    case 'single_choice':
      return {};
    default:
      return {};
  }
};

/** A response that is absent, empty, or an empty selection -- the three shapes of "not answered". */
const isAbsent = (response: unknown): boolean => {
  if (response === undefined || response === null) return true;
  if (typeof response === 'string') return response.trim() === '';
  if (Array.isArray(response)) return response.length === 0;
  if (typeof response === 'object') {
    const record = response as Record<string, unknown>;
    // The three keyed response shapes the question types use. An object with none of them is not "absent" -- it is
    // a response this version does not understand, and grading it is better than skipping it.
    for (const field of ['choiceIds', 'itemIds', 'text', 'value', 'choiceId']) {
      const held = record[field];
      /**
       * WHITESPACE COUNTS AS ABSENT, and the reason is that the top-level string case already trims.
       *
       * `{text: '   '}` is a student who focused the box and typed nothing. Treating it as an answer sends a
       * whitespace string to the matcher, which scores it wrong -- so the mark is zero either way, but the
       * `blank` flag differs, and the flag is what tells a marker the difference between "left empty" and "tried
       * and got it wrong".
       *
       * `null` counts too: a browser sends `null` for a cleared numeric field, and a student who cleared it did
       * not answer.
       */
      if (held !== undefined) {
        if (Array.isArray(held)) return held.length === 0;
        if (typeof held === 'string') return held.trim() === '';
        return held === null;
      }
    }
  }
  return false;
};

/**
 * GRADE A PAPER.
 *
 * `responses` is keyed by question id and may be missing entries, partial, or carry ids the paper does not contain.
 * An id the paper does not contain is IGNORED rather than graded: a response for a question that is not on this
 * paper belongs to another one, and grading it would put a mark in a total that does not include the question.
 */
export const gradePaper = (
  questions: readonly PaperQuestion[],
  responses: Readonly<Record<string, unknown>>,
): PaperResult => {
  const grades: PaperGrade[] = [];

  for (const question of questions) {
    const present = Object.hasOwn(responses, question.questionId);
    const response = present ? responses[question.questionId] : undefined;
    const blank = !present || isAbsent(response);
    // An absent KEY becomes the type's empty shape; a present key is graded exactly as it arrived.
    const outcome = grade({
      spec: question.spec,
      response: blank ? emptyResponseFor(question.spec) : response,
    });
    grades.push({
      questionId: question.questionId,
      outcome,
      blank,
      // A `NEEDS_HUMAN` flag the grader raised for any reason other than a negative score. The negative case is
      // `NG`/`PM` doing their job, which is a mark and not a question for a human.
      needsHuman:
        outcome.flags.includes('NEEDS_HUMAN') &&
        !outcome.flags.includes('UNKNOWN_TYPE') &&
        outcome.rawPoints >= 0,
      flags: outcome.flags,
    });
  }

  let rawTotal = 0;
  let maxPoints = 0;
  for (const grade of grades) {
    rawTotal += grade.outcome.rawPoints;
    maxPoints += grade.outcome.maxPoints;
  }

  return {
    grades,
    questionCount: grades.length,
    answeredCount: grades.filter((entry) => !entry.blank).length,
    blankCount: grades.filter((entry) => entry.blank).length,
    needsHumanCount: grades.filter((entry) => entry.needsHuman).length,
    rawTotal,
    maxPoints,
  };
};

/**
 * THE QUESTIONS A SUBMISSION SAYS ARE UNUSABLE, for a caller that must block or route them.
 *
 * Separate from `needsHumanCount` because the two need different handling: a `NEEDS_HUMAN` question is one a
 * marker must look at, and an `UNKNOWN_TYPE` one is a defect. Counting them together hides both.
 */
export const unusableQuestions = (result: PaperResult): readonly string[] =>
  result.grades
    .filter(
      (entry) => entry.flags.includes('UNKNOWN_TYPE') || entry.flags.includes('MALFORMED_RESPONSE'),
    )
    .map((entry) => entry.questionId);

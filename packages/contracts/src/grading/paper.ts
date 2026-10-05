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
 * ## AND "NO RESPONSE" MEANS NOTHING IN THE SLOT -- NOT "SOMETHING EMPTY-LOOKING IN THE SLOT"
 *
 * An unanswered question and an unreadable one both score zero, and the consequence is opposite: a blank stands,
 * and a fault goes to a human. So which values count as "no response" is the decision that settles whether a
 * student is recorded as having left a question out when the platform in fact lost their answer. It is stated
 * once, on `readSlot`, and it is deliberately narrow.
 *
 * ## AND IT DOES NOT SUM, BECAUSE `plans/07` §3.2 SAYS THE FLOOR BELONGS IN THE ATTEMPT TOTAL
 *
 * There is deliberately no `total` and no `percentage` here. `NG` and `PM` produce negative `rawPoints` per
 * question, and §3.2's reason for storing them unclamped is that clamping at the item "silently converts NG into no
 * penalty for every student who guessed". A `total` computed here would have to either clamp -- destroying exactly
 * that -- or be negative, and a negative total is `INV-RELEASE-2`'s forbidden shape if it ever reached a student
 * surface. So the caller receives per-question grades and does the arithmetic, once, in one place.
 */

import type { QuestionSpec, QuestionType } from '../question/index.js';
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
  /**
   * True when the question was NOT ANSWERED: nothing in the slot, or this type's own answer shape with nothing in
   * it. Never true for a value that is merely empty-looking and the wrong shape -- that is a fault, and it is in
   * `flags`. See `readSlot`.
   */
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
 * So a slot with NOTHING in it is translated into the type's own empty shape, and the grader's `BLANK` path -- which
 * already exists for the types that have one -- does the rest. This is the only substitution `gradePaper` makes.
 */
/**
 * THE EMPTY SHAPE FOR A TYPE, **DERIVED FROM `ANSWER_FIELD`** RATHER THAN HAND-WRITTEN.
 *
 * It was a switch listing `multi_select`, `ordering` and `single_choice`, and it was wrong in a way only a test could
 * have found. `ANSWER_FIELD` -- thirty lines below -- already says `single_choice`'s field is **`choiceId`**, singular,
 * and `true_false`'s is **`value`**; the switch answered `{ choiceIds: [] }` for both, which is not either type's shape.
 *
 * So an untouched `single_choice` was substituted with an object whose only key was one that grader does not read,
 * `readTypedKey` found nothing, and `isTheAnswerUnreadable` (the `ADV-S2` fix) correctly concluded *"there is an
 * answer here and I cannot see it"* -- `UNPARSEABLE`, `MALFORMED_RESPONSE`. **Every untouched paper would have put
 * half its questions in front of a teacher as platform faults**, on the two commonest types, and `blank` was `true` on
 * the very same entry.
 *
 * ## WHY NOBODY WROTE THE CASE: THE QUESTION ASKS WHAT A WRONG ANSWER LOOKS LIKE
 *
 * `PF-5` gave `numeric` and `short_text` a `BLANK` path and these two were missed. Every existing fixture supplies a
 * WRONG answer -- a wrong option id, a wrong number -- because that is what a grader test is for. "Single choice,
 * untouched" is not a grading question, it is a fixture question, and it was never written.
 *
 * ## AND A SECOND COPY OF A TABLE IS A SECOND THING TO FORGET
 *
 * This is the same defect as the `HANDLED.includes(...)` guard in `index.ts` that this file already documents: a guard
 * that duplicates what it guards is a second thing to forget, and this was the copy that would have been missed,
 * because the table it duplicated is thirty lines below in the same file. Deriving it means **a type added to
 * `ANSWER_FIELD` gets the right empty shape for free**, and a type with no field (`simulation`) still gets `{}`,
 * which is correct -- there is nothing a student empties.
 *
 * `SCALAR` becomes `null` because `PF-5` established a missing **or null** field as a `BLANK`, and `LIST` becomes `[]`
 * because an empty list is an answer that is empty rather than an answer nobody can see. Those are different facts
 * and `emptied` is exactly the record of which is which.
 */
const emptyResponseFor = (spec: QuestionSpec): unknown => {
  const declared = ANSWER_FIELD[spec.type];
  if (declared === null) return {};
  const { field, emptied } = declared;
  return emptied === 'LIST' ? { [field]: [] } : { [field]: null };
};

/**
 * THE ONE FIELD EACH TYPE'S ANSWER LIVES IN, and what an EMPTIED one looks like -- or `null` where there is no
 * such thing. From `plans/07` section 2's table.
 *
 * Keyed by `QuestionType` so that adding a type is a compile error here rather than a type whose cleared answers
 * are quietly never recognised: the list this replaces named five fields for ten types, and `assetIds` and `steps`
 * were not among them.
 *
 * `simulation` is `null` ON PURPOSE. Its response is `{ simState, answer }`, written by a third-party bundle and
 * round-tripped through `postMessage`, an outbox and a `jsonb` column. There is no input a student empties, so
 * nothing found in that slot is "cleared" -- it is either a state or the remains of one.
 */
type Emptied = 'LIST' | 'TEXT' | 'SCALAR';
const ANSWER_FIELD: {
  readonly [T in QuestionType]: { readonly field: string; readonly emptied: Emptied } | null;
} = {
  single_choice: { field: 'choiceId', emptied: 'SCALAR' },
  multi_select: { field: 'choiceIds', emptied: 'LIST' },
  true_false: { field: 'value', emptied: 'SCALAR' },
  numeric: { field: 'value', emptied: 'SCALAR' },
  short_text: { field: 'text', emptied: 'TEXT' },
  ordering: { field: 'itemIds', emptied: 'LIST' },
  free_response: { field: 'text', emptied: 'TEXT' },
  file_submission: { field: 'assetIds', emptied: 'LIST' },
  worked_solution: { field: 'steps', emptied: 'LIST' },
  simulation: null,
};

/**
 * DID THE STUDENT CLEAR THIS TYPE'S OWN ANSWER FIELD?
 *
 * True only for the question's OWN field, held as an own key, holding what THAT KIND of input produces when it is
 * emptied: `[]` for a list, `null` or whitespace for text, `null` for a number, an option or a boolean.
 *
 * ## WHITESPACE COUNTS, AND `null` COUNTS
 *
 * `{text: '   '}` is a student who focused the box and typed nothing. Treating it as an answer sends a whitespace
 * string to the matcher, which scores it wrong -- so the mark is zero either way, but the `blank` flag differs, and
 * the flag is what tells a marker the difference between "left empty" and "tried and got it wrong". A browser sends
 * `null` for a cleared numeric field, and a student who cleared it did not answer.
 *
 * ## ANOTHER TYPE'S FIELD DOES NOT COUNT, NOR ANOTHER KIND OF EMPTY, AND BOTH USED TO
 *
 * The first version looked for ANY of five field names on ANY question and accepted ANY of the three empties in
 * each, so `{choiceIds: []}` in a numeric slot was a blank, and so was `{value: []}`. Neither is the numeric
 * question's empty answer. One is a multi-select's answer in the wrong slot and the other is a list where a number
 * goes; `grade()` calls both unreadable, and a paper that calls them blank is hiding what the grader flagged.
 */
const clearedOwnField = (spec: QuestionSpec, response: unknown): boolean => {
  if (typeof response !== 'object' || response === null || Array.isArray(response)) return false;
  // `Object.hasOwn` on the table as well as on the response: a spec read out of a JSON column can name a type
  // this build has never heard of, or `constructor`.
  const own = Object.hasOwn(ANSWER_FIELD, spec.type) ? ANSWER_FIELD[spec.type] : null;
  if (own === null || !Object.hasOwn(response, own.field)) return false;
  const held = (response as Record<string, unknown>)[own.field];
  switch (own.emptied) {
    case 'LIST':
      return Array.isArray(held) && held.length === 0;
    case 'TEXT':
      return held === null || (typeof held === 'string' && held.trim() === '');
    case 'SCALAR':
      return held === null;
  }
};

/**
 * WHAT IS IN A QUESTION'S SLOT: nothing, or something.
 *
 * ## THE RULE, AND IT IS THE STRICT ONE
 *
 * **A slot is EMPTY only when there is no value in it: the key is absent, or it holds `undefined` or `null`.**
 * `null` is how JSON and a nullable column say "no value", so it is absence written down. Everything else is
 * PRESENT, and a present value is graded EXACTLY AS IT ARRIVED -- nothing is substituted for it, so the paper
 * cannot hide a response that `grade()` would have flagged.
 *
 * ## `[]` AND `''` ARE PRESENT, AND THIS FUNCTION USED TO SAY OTHERWISE  (`ADV-S1`)
 *
 * It was called `isAbsent`, it described itself as "absent, empty, or an empty selection", and it counted a bare
 * `[]` and a bare `''` as absent for every question type. The line that called it then claimed "a present key is
 * graded exactly as it arrived". Both could not be true, and the code followed the first: a present `[]` was
 * replaced by the type's empty shape and reported as a blank with no flag, while `grade()` called directly on the
 * same value raised `MALFORMED_RESPONSE`. Two layers disagreed about one value, and the layer a submission goes
 * through was the one that hid it.
 *
 * No response shape in the contract is a bare array or a bare string -- `plans/07` section 2: every one is an
 * object, and an empty selection is `{choiceIds: []}`. So a bare `[]` is not an empty answer. It is the wrong type,
 * which means something between the student and this function wrote the slot wrongly, and its being empty NOW says
 * nothing about what the student put there. That is a fault, and a fault is not a blank.
 */
type Slot = { readonly kind: 'EMPTY' } | { readonly kind: 'PRESENT'; readonly response: unknown };

const readSlot = (responses: Readonly<Record<string, unknown>>, questionId: string): Slot => {
  // `Object.hasOwn`, so a question called `constructor` does not find `Object` waiting for it as an answer.
  const held = Object.hasOwn(responses, questionId) ? responses[questionId] : undefined;
  return held === undefined || held === null
    ? { kind: 'EMPTY' }
    : { kind: 'PRESENT', response: held };
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
    const slot = readSlot(responses, question.questionId);
    // An EMPTY slot becomes the type's empty shape; a present value is graded exactly as it arrived.
    const outcome = grade({
      spec: question.spec,
      response: slot.kind === 'EMPTY' ? emptyResponseFor(question.spec) : slot.response,
    });
    /**
     * UNANSWERED IS THREE THINGS, AND NONE OF THEM CHANGES WHAT WAS GRADED.
     *
     * Nothing in the slot; the type's own field, cleared; or the grader's own verdict of `BLANK`. The third is
     * here so the two layers cannot disagree: `{}` in a numeric slot was counted as ANSWERED by the paper while
     * the grader's rationale said `BLANK`, and a marker reading both was told two things about one response.
     */
    const blank =
      slot.kind === 'EMPTY' ||
      clearedOwnField(question.spec, slot.response) ||
      outcome.rationale.code === 'BLANK';
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

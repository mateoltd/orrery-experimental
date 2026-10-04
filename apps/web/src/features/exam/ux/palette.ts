'use client';

/**
 * The question palette: what every question in the paper looks like from the outside, and where the student may
 * go.  (P8-T13)
 *
 * ## A PALETTE IS A NAVIGATOR, NOT A SCOREBOARD
 *
 * Everything here is derived from `AttemptState` and nothing is fetched. That is not a performance decision, it is
 * the only way the palette can be honest: a palette that showed correctness would be a sealed grade leaking onto a
 * screen mid-exam (`INV-RELEASE-2`), and the temptation is exactly there, because a green tick per question is the
 * obvious design. So the vocabulary of this file is `ANSWERED`/`UNANSWERED` and there is no third state that
 * means "right".
 *
 * ## AND `UNANSWERED` IS NOT A BLANK
 *
 * `answerStore.ts` records that answering with `undefined` DELETES the key, so "the student cleared every option"
 * and "the student never touched this question" are the same stored fact. The palette therefore reports
 * `UNANSWERED` for both, and must not invent a distinction the store cannot represent. It is still the right word:
 * `plans/07` treats an absent response key as unanswered and grades it as a blank, so the palette and the grader
 * agree.
 *
 * ## THE THREE DECISIONS THIS FILE MAKES, AND WHY
 *
 * 1. **THE STUDENT MAY JUMP ANYWHERE.** `ONE_AT_A_TIME` means one question is *presented* at a time -- no scrolling
 *    a whole paper -- not that the paper is a corridor they may only walk one way. If it meant the latter, a
 *    student who mis-clicks question 4 could never reach question 1 again without replaying 2 and 3, and under
 *    `perQuestionTimeLimitSec` that is punitive. The policy already has the mechanism for "you may not return":
 *    `lockQuestionAfterAnswer`. Navigation that blocked return would make that flag redundant.
 * 2. **A CLOSED QUESTION IS `aria-disabled`, NOT `disabled`.** A `disabled` button is not focusable, so a student
 *    using a screen reader cannot discover that the question exists or why it is closed. `aria-disabled` keeps it
 *    discoverable and announces the refusal, and `paletteTarget` refuses the move with a reason -- because a
 *    control that silently does nothing is the dead end `plans/09` §6.2 exists to prevent, here in a quieter form.
 * 3. **`showQuestionNumbers: false` HIDES THE AUTHORED NUMBER, NOT THE POSITION.** The two are different facts:
 *    the authored number is what a teacher's paper says, and it can differ from the order this student drew. The
 *    position within the paper is unavoidable for navigation and is visible anyway by counting, so the palette
 *    falls back to position and says so.
 */

import type { AttemptState } from '../answerStore';
import { canAnswer } from '../answerStore';

/** What the palette knows about one question. Deliberately carries no correctness of any kind. */
export type PaletteStatus =
  /** Answered, and `lockQuestionAfterAnswer` means it can no longer be reopened. */
  | 'LOCKED'
  /** Answered, and reopenable. */
  | 'ANSWERED'
  /** No answer stored. */
  | 'UNANSWERED'
  /**
   * Its own per-question window has closed -- `questionDeadlineAt + grace`, which is `answerStore.canAnswer`'s
   * boundary and not this file's.
   */
  | 'WINDOW_CLOSED';

export interface PaletteEntry {
  readonly index: number;
  readonly questionId: string;
  readonly status: PaletteStatus;
  /** The student's own bookmark. Orthogonal to `status`: a flagged question may be answered or not. */
  readonly flagged: boolean;
  /** Where the student is. */
  readonly current: boolean;
  /** `null` when the move is permitted, otherwise why it is not -- never a bare `false`. */
  readonly blockedBecause: 'LOCKED' | 'QUESTION_DEADLINE_PASSED' | 'ATTEMPT_OVER' | null;
  /**
   * The accessible name. Computed HERE rather than assembled in the component, because a name built in JSX is a
   * name a refactor can drop, and `plans/15` 2.5.8 wants these finger-sized and `2.4.6` wants them described.
   */
  readonly label: string;
}

export interface Palette {
  readonly entries: readonly PaletteEntry[];
  readonly total: number;
  readonly answered: number;
  readonly unanswered: number;
  readonly flagged: number;
  /** Answered-and-reopenable plus unanswered: what the student could still change if they wanted to. */
  readonly open: number;
  readonly summary: string;
}

const plural = (n: number, one: string, many: string): string =>
  `${String(n)} ${n === 1 ? one : many}`;

/**
 * The label for one entry.
 *
 * `questionNumber` is the POSITION in the paper the student was served. When `showQuestionNumbers` is false the
 * label says "Question" rather than "Question 7" for the authored number, but the position is still announced in
 * the summary a screen reader reads out, because a palette of forty unlabelled buttons is not navigable.
 */
const labelFor = (
  position: number,
  total: number,
  status: PaletteStatus,
  flagged: boolean,
  showQuestionNumbers: boolean,
): string => {
  const name = showQuestionNumbers ? `Question ${String(position)}` : 'Question';
  const of = `of ${String(total)}`;
  const state =
    status === 'LOCKED'
      ? 'answered, locked'
      : status === 'ANSWERED'
        ? 'answered'
        : status === 'WINDOW_CLOSED'
          ? 'window closed'
          : 'not answered';
  const bookmark = flagged ? ', flagged for review' : '';
  return `${name} ${of}, ${state}${bookmark}`;
};

/**
 * THE PALETTE, DERIVED.
 *
 * `now` is the SERVER-corrected instant, not the client's. A palette that closes a question's window because the
 * student's own clock is slow takes away a question the server would still accept, and `answerStore.canAnswer`
 * already draws that line correctly -- so this file ASKS it rather than re-deriving a second boundary. Two answers
 * to "may this student still write to this question?" in two files is the defect class this repo keeps finding.
 */
export const palette = (state: AttemptState, now: number): Palette => {
  const total = state.slots.length;
  const entries = state.slots.map((slot, index) => {
    const answered = Object.hasOwn(state.answers, slot.questionId);
    const permission = canAnswer(state, slot.questionId, now);

    let status: PaletteStatus;
    if (!permission.allowed && permission.why === 'QUESTION_DEADLINE_PASSED')
      status = 'WINDOW_CLOSED';
    else if (answered && state.policy.lockQuestionAfterAnswer) status = 'LOCKED';
    else if (answered) status = 'ANSWERED';
    else status = 'UNANSWERED';

    return {
      index,
      questionId: slot.questionId,
      status,
      flagged: state.flagged.has(slot.questionId),
      current: index === state.cursor,
      /**
       * THE REFUSAL IS ABOUT THE MOVE, NOT THE ANSWER.
       *
       * A `LOCKED` entry is not blocked as a *destination* under `lockQuestionAfterAnswer` -- the student must be
       * able to go back and READ what they wrote. `answerStore.canAnswer` refuses the WRITE, which is the correct
       * and separate question, so its `LOCKED` reason is deliberately not propagated into `blockedBecause`.
       * Copying it here would make a locked question unreachable for review, which is the opposite of what the
       * policy asks for.
       */
      blockedBecause:
        status === 'WINDOW_CLOSED'
          ? 'QUESTION_DEADLINE_PASSED'
          : permission.allowed || permission.why === 'LOCKED'
            ? null
            : 'ATTEMPT_OVER',
      label: labelFor(
        index + 1,
        total,
        status,
        state.flagged.has(slot.questionId),
        state.policy.showQuestionNumbers,
      ),
    } satisfies PaletteEntry;
  });

  /**
   * `LOCKED` COUNTS AS ANSWERED, and a test caught it not doing so.
   *
   * The two are not peers -- `LOCKED` is `ANSWERED` plus "and you may not change it" -- and treating them as peers
   * made the summary fail to ACCOUNT for the paper: a two-question paper with one answered and then locked reported
   * "0 questions answered, 1 question not answered". A student reading that has been told one of their two questions
   * does not exist.
   *
   * `open` excludes it deliberately, and that is the distinction the two fields draw: `answered` is what is on the
   * paper, `open` is what a student could still act on.
   */
  const answered = entries.filter(
    (entry) => entry.status === 'ANSWERED' || entry.status === 'LOCKED',
  ).length;
  const unanswered = entries.filter((entry) => entry.status === 'UNANSWERED').length;
  const flagged = entries.filter((entry) => entry.flagged).length;

  return {
    entries,
    total,
    answered,
    unanswered,
    flagged,
    open: entries.filter((entry) => entry.status === 'ANSWERED' || entry.status === 'UNANSWERED')
      .length,
    summary:
      total === 0
        ? 'This paper has no questions.'
        : `${plural(answered, 'question answered', 'questions answered')}, ${plural(unanswered, 'question not answered', 'questions not answered')}`,
  };
};

/**
 * MAY THE STUDENT GO THERE?
 *
 * A separate function rather than a `canNavigate` on the entry, because the answer depends on the DESTINATION's
 * state and a student may click the question they are already on -- which is always permitted, since refusing it
 * would make the palette's own current item a dead control.
 */
export const paletteTarget = (
  state: AttemptState,
  now: number,
  index: number,
): { readonly permitted: boolean; readonly why?: string } => {
  const slot = state.slots[index];
  if (slot === undefined)
    return { permitted: false, why: 'There is no question at that position.' };
  if (index === state.cursor) return { permitted: true };

  const entry = palette(state, now).entries[index];
  if (entry === undefined)
    return { permitted: false, why: 'There is no question at that position.' };
  if (entry.blockedBecause === 'QUESTION_DEADLINE_PASSED')
    return { permitted: false, why: "That question's time is up, so it can no longer be opened." };
  if (entry.blockedBecause === 'ATTEMPT_OVER')
    return { permitted: false, why: 'This attempt is closed.' };
  return { permitted: true };
};

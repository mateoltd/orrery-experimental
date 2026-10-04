'use client';

/**
 * The submit confirmation: what a student is told before a paper becomes final.  (P8-T13)
 *
 * ## NOTHING HERE MAY DEPEND ON WHETHER AN ANSWER IS CORRECT
 *
 * `INV-RELEASE-2` does not say "no score field". It says no score may be *inferable*, and it enumerates a count of
 * correct answers among the ways that happens. A submit dialog is a natural home for a leak, because "you got 4 of 5
 * right, submit anyway?" is an obvious and completely forbidden design: it is the single most useful signal in an
 * auto-graded paper, and a student who learns it mid-exam can revise precisely the questions it names.
 *
 * `AttemptState` has no answer key in it, so this function cannot grade. The stronger claim is asserted as a property
 * in the tests -- two states whose answers are correct and wrong respectively produce byte-identical output -- because
 * "there is no field for it" is a weaker thing to promise than "nothing it renders changes when correctness changes".
 *
 * ## IT IS NEVER A DEAD END
 *
 * The property, not a promise: for every combination of unanswered questions, time state and attempt status, at least
 * one action is available. An integrity modal with one disabled button BLOCKS the exam (`plans/09` §6.2), and the same
 * is true of a submit dialog -- with the difference that this one appears at the moment a student is most likely to
 * be ready to leave.
 *
 * So where submitting is impossible, the dialog does not offer a button that will fail. It says the paper has already
 * closed, which is a different sentence from "you have unanswered questions", and it offers no submit action at all.
 */
import type { AttemptState } from '../answerStore';
import { canAnswer, unanswered } from '../answerStore';
import { correctedNow } from '../serverClock';

export interface SubmitConfirmAction {
  readonly kind: 'SUBMIT' | 'CANCEL' | 'NONE';
  readonly label: string;
  /** Whether this is the action a keyboard user's focus should land on. Never more than one. */
  readonly primary: boolean;
}

export interface SubmitConfirm {
  readonly heading: string;
  readonly detail: readonly string[];
  readonly actions: readonly SubmitConfirmAction[];
  /**
   * Whether the student must acknowledge before the submit proceeds. `false` for a clean paper -- interrupting a
   * student who has answered everything, to ask them to confirm they have answered everything, is the modal that
   * trains people to click through dialogs without reading them.
   */
  readonly blocking: boolean;
  /** True when the paper can no longer be submitted by the student at all. */
  readonly closed: boolean;
}

const plural = (n: number, one: string, many: string): string =>
  `${String(n)} ${n === 1 ? one : many}`;

/**
 * WHAT THE STUDENT IS TOLD, GIVEN EVERYTHING KNOWN ABOUT THEIR PAPER.
 *
 * `now` is the SERVER-corrected instant for the same reason the countdown's is: a client whose clock is slow believes
 * it has more time, and this dialog is where that belief turns into an irreversible action.
 *
 * ORDER IS BY HOW MUCH A STUDENT WOULD BE MISLED BY GETTING IT WRONG, which is the same ordering rule `resumePrompt`
 * uses and for the same reason -- two dialogs in one flow that order their clauses differently will disagree in a
 * reviewer's head about what the flow considers important:
 *
 * 1. **CLOSED** -- the paper is over. Nothing else matters, and "you have 4 unanswered questions" to a student whose
 *    paper closed four minutes ago is technically true and actively harmful.
 * 2. **UNSAVED** -- writes the server has not acknowledged. This is the one that is both blocking and irreversible
 *    once they proceed, because an unsubmitted answer is not on the server.
 * 3. **UNANSWERED** -- a count, and the questions by position. No judgement about them.
 * 4. **OK** -- nothing to say, and no dialog.
 */
export const submitConfirm = (
  state: AttemptState,
  now: { readonly clientNow: number; readonly offset: number },
): SubmitConfirm | null => {
  const serverNow = correctedNow(now.clientNow, now.offset);
  const graceMs = state.policy.gracePeriodSec * 1000;
  const pastDeadline = state.deadlineAt !== null && serverNow > state.deadlineAt + graceMs;
  const submitted = state.status === 'SUBMITTED';

  /**
   * CLOSED IS CHECKED FIRST, AND IT SUPPRESSES THE DIALOG'S ONLY IRREVERSIBLE ACTION.
   *
   * The tempting shape is to keep the submit button and let the server refuse. A button that fails is worse than no
   * button: the student presses it, waits, and learns the outcome from an error rather than from a sentence written
   * before they committed.
   */
  if (submitted || pastDeadline) {
    return {
      heading: submitted ? 'This attempt has been submitted' : 'Your time is up',
      detail: [
        submitted
          ? 'Your answers have been sent to your teacher. Nothing here can be changed now.'
          : 'This attempt closed while you were working. Answers that reached the server have been kept.',
        'Answers not saved before the deadline may not have been recorded.',
      ],
      actions: [{ kind: 'NONE', label: 'Close', primary: true }],
      blocking: false,
      closed: true,
    };
  }

  const missing = unanswered(state);
  const unsaved = state.queued.length;
  const detail: string[] = [];

  if (unsaved > 0) {
    detail.push(
      `${plural(unsaved, 'answer has', 'answers have')} not yet reached the server. Submitting now sends only what has arrived.`,
    );
  }

  if (missing.length > 0) {
    detail.push(
      `${plural(missing.length, 'question has', 'questions have')} no answer. An unanswered question is not a wrong answer -- it is scored as a blank.`,
    );
    /**
     * THE POSITIONS ARE LISTED, AND NEVER THE ANSWERS.
     *
     * A student using this list to go back and guess at the named questions is behaving reasonably; a student shown
     * which of them they got RIGHT is being handed the answer key. Positions are what a navigation aid needs.
     */
    detail.push(
      `Still to answer: ${missing.map((id) => `#${String(state.slots.findIndex((slot) => slot.questionId === id) + 1)}`).join(', ')}.`,
    );
  }

  if (missing.length === 0 && unsaved === 0) {
    return null;
  }

  return {
    heading: 'Submit this attempt?',
    detail,
    actions: [
      { kind: 'SUBMIT', label: 'Submit', primary: true },
      // `CANCEL` IS NEVER THE PRIMARY ACTION ON A DIALOG WHOSE WORST CASE IS A LOST SITTING. The keyboard's default
      // belongs to the reversible choice, so a student who presses Enter in a hurry keeps their paper.
      { kind: 'CANCEL', label: 'Keep working', primary: false },
    ],
    // Blocking only where proceeding loses something irreversible: queued writes are gone the moment the attempt is
    // submitted, and a student who does not know that will not go back and flush them.
    blocking: unsaved > 0,
    /**
     * `closed: false`, WHICH WAS MISSING AND SHOULD NOT HAVE BEEN.
     *
     * The field is declared `boolean` on the interface, so omitting it here is a compile error -- `vitest` does not
     * typecheck, so a test run could not see it, and a reader of the JSON would see a dialog with no `closed` at all.
     * A UI that reads `dialog.closed` gets `undefined`, which is falsy, so the *behaviour* happened to be right and the
     * type was quietly wrong. `pnpm typecheck` is what catches this class, and the reason it is in the loop.
     */
    closed: false,
  };
};

/**
 * MAY THIS STUDENT STILL OPEN A QUESTION THEY HAVE NOT ANSWERED? The one question the confirm dialog's advice implies.
 *
 * Exported because a caller that renders "still to answer: #4" must be able to check that #4 is somewhere they can
 * actually go, and `canAnswer` is the answer -- the same one `reduceAttempt` and the server's `decideWrite` use.
 */
export const canStillAnswer = (state: AttemptState, questionId: string, now: number): boolean =>
  canAnswer(state, questionId, now).allowed;

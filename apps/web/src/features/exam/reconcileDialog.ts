'use client';

/**
 * The 409 choice: "keep mine / keep theirs".  (P7-T11)
 *
 * ## WHY THE STUDENT IS THE ONE WHO DECIDES
 *
 * `plans/01` §9.3: "a stale revision is a `409` that surfaces 'keep mine / keep theirs' -- which is also how a
 * second device is detected."
 *
 * Neither copy can be preferred automatically. Taking the server's silently loses work the student believes they
 * saved; taking the client's silently resurrects an answer the server has already superseded. And the two are not
 * symmetric in blame: sometimes the other device is right, sometimes this one is, and the only party who knows which
 * is the student.
 *
 * ## AND THE DIALOG MUST SHOW BOTH ANSWERS, NOT JUST THE QUESTION
 *
 * The obvious presentation is "this changed elsewhere, keep yours?" -- which asks the student to decide without
 * showing them what they are deciding between. That is a coin flip with extra steps, and the student cannot tell a
 * later edit from an earlier one by question number.
 *
 * So both values are rendered, each labelled with WHICH revision it is and WHICH revision supersedes it. The
 * numbers matter as much as the text: the common case is a student who edited the same question on two devices, and
 * "revision 3 (this device) / revision 2 (another device)" is the whole explanation.
 *
 * ## AND A MISSING ANSWER IS SHOWN AS MISSING, NOT AS EMPTY
 *
 * `undefined` in `mine` or `theirs` means UNANSWERED, which is a different fact from answered-with-nothing: the
 * grader reports one as `BLANK` and the other is not a response at all. Rendering both as an empty box would make
 * "I cleared it" and "they never answered" indistinguishable, and the student would pick wrongly on a question
 * where the difference is the whole mark.
 */

import type { ReconcileRequired } from './answerStore';

/** One side of the choice, with enough provenance for the student to reason about it. */
export interface AnswerChoice {
  /** Which side this is. Named so a caller cannot swap them silently. */
  readonly side: 'MINE' | 'THEIRS';
  readonly label: string;
  readonly revision: number;
  /** The answer, RENDERED. Never the raw value: it may be a file, a sim state, or a paragraph. */
  readonly display: string;
  /** True when this side has no answer at all -- which is not the same as an empty one. */
  readonly unanswered: boolean;
  readonly buttonLabel: string;
  /** What choosing this does, in one line. A student choosing between irreversible options deserves to know. */
  readonly consequence: string;
}

/**
 * RENDER AN ANSWER FOR A STUDENT TO COMPARE.
 *
 * `string`, `number` and `boolean` are shown as themselves. An OBJECT is summarised by its keys, because a
 * `multi_select` answer is `{choiceIds: [...]}` and showing raw JSON to a student is not an answer. `undefined` is
 * the distinct "no answer" case.
 */
export const displayAnswer = (answer: unknown): string => {
  if (answer === undefined) return 'No answer';
  if (answer === null) return 'Empty';
  if (typeof answer === 'string') return answer.trim() === '' ? 'Empty' : answer;
  if (typeof answer === 'number' || typeof answer === 'boolean') return String(answer);
  if (Array.isArray(answer))
    return answer.length === 0 ? 'Empty' : `${String(answer.length)} selected`;
  if (typeof answer === 'object') {
    const entries = Object.entries(answer as Record<string, unknown>);
    if (entries.length === 0) return 'Empty';
    /**
     * THE VALUES ARE RENDERED, NOT JUST THE KEYS, and a test found why.
     *
     * Summarising by keys alone rendered `{choiceIds: ['a']}` and `{choiceIds: ['a', 'c']}` as the SAME string --
     * "choiceIds". So for a `multi_select` conflict, which is the most common conflict there is, both sides of the
     * dialog were identical and the student was asked to choose between two identical-looking answers. The whole
     * reason this dialog shows both values is defeated by abbreviating them to the same word.
     *
     * It also produced an EMPTY string for an object whose only key is `""`, which reads as a rendering fault.
     */
    return entries.map(([key, value]) => `${key}: ${displayAnswer(value)}`).join(', ');
  }
  return 'Empty';
};

/** The dialog's contents, or `null` when there is nothing to reconcile. */
export interface ReconcileDialog {
  readonly questionId: string;
  /** The question's own text is NOT here: it is not in `ReconcileRequired`, and a dialog that cannot show the question is a dialog about an abstract id. */
  readonly heading: string;
  readonly explanation: string;
  readonly mine: AnswerChoice;
  readonly theirs: AnswerChoice;
  /** True when both sides are the SAME answer, so the choice is cosmetic and should not be presented as a conflict. */
  readonly identical: boolean;
}

export const reconcileDialog = (reconcile: ReconcileRequired | null): ReconcileDialog | null => {
  if (reconcile === null) return null;

  const identical = displayAnswer(reconcile.mine) === displayAnswer(reconcile.theirs);

  return {
    questionId: reconcile.questionId,
    heading: 'This answer was changed somewhere else',
    /**
     * `plans/01` §9.3 says a 409 "is also how a second device is detected", so the dialog says so rather than
     * leaving the student to guess. Naming the cause is what makes the choice informed rather than arbitrary.
     */
    explanation:
      'You have this paper open in more than one place, and each has a different version of this answer. Keeping one discards the other, so it cannot be undone.',
    mine: {
      side: 'MINE',
      label: 'This device',
      revision: reconcile.myRevision,
      display: displayAnswer(reconcile.mine),
      unanswered: reconcile.mine === undefined,
      buttonLabel: 'Keep this one',
      consequence: 'Discards the other device’s answer for this question.',
    },
    theirs: {
      side: 'THEIRS',
      label: 'Another device',
      revision: reconcile.theirRevision,
      display: displayAnswer(reconcile.theirs),
      unanswered: reconcile.theirs === undefined,
      buttonLabel: 'Keep that one',
      consequence: 'Discards this device’s answer for this question.',
    },
    identical,
  };
};

/**
 * WHETHER THE CHOICE STILL NEEDS TO BE ASKED.
 *
 * When both sides hold the SAME answer the conflict is invisible to the student and the dialog is theatre -- so a
 * caller may dismiss it without calling either `KEEP_MINE` or `KEEP_THEIRS`, which would otherwise re-queue a write
 * that says nothing.
 */
export const needsAChoice = (dialog: ReconcileDialog | null): boolean =>
  dialog !== null && !dialog.identical;

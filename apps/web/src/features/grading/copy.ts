/**
 * Every sentence the grading workspace says, in one place.  (P9-T2, P9-T3)
 *
 * ## WHY THE WORDS ARE CONSTANTS AND NOT JSX
 *
 * `integrity/timeline.ts` exports its banner and help text as required constants so that the wording is reviewable in
 * one file and a test can hold it to a standard. The same is true here, and the standard is the same one: the screen
 * DESCRIBES what is stored and what happened; it never CHARACTERISES the student, and it never states a conclusion
 * the machine did not reach.
 *
 * Three rules, each held by `copy.test.ts` over every string in this file:
 *
 *  1. **Nothing here is about the person.** The marking is of a piece of work. "The answer names one force" is a
 *     statement a teacher can check against the page; "the student is confused" is not, and it is the sentence a
 *     prefilled comment most easily turns into. `D13`: this product improves instruments and never sorts children.
 *  2. **A response nobody has marked is never described with a number or as wrong.** See `markingState.ts`.
 *  3. **"Saved" means the server acknowledged a mark.** A draft on this device is "kept on this device". The two
 *     states never share the word.
 *
 * ## AND PREFILLED FEEDBACK IS LABELLED AS THE TEACHER'S
 *
 * A comment that appears by itself in a box next to a student's work reads as the platform's opinion of that work.
 * It is not one: a teacher wrote it for the band and a teacher sends it. `PREFILL_HINT` says so next to the field,
 * every time a prefill is standing.
 */

import type { AwaitingReason, MarkingCounts, MarkingState } from './markingState';

/** `3 response(s)`: the repo's stand-in for a plural until the ICU catalogue exists (`plans/15` §5.2). */
const count = (n: number, noun: string): string => `${String(n)} ${noun}(s)`;

export const AWAITING_REASON: Readonly<Record<AwaitingReason, string>> = {
  MARKED_BY_HAND: 'This question is marked by a person, and no mark has been given yet.',
  SIMULATION_FAULT:
    'The simulation’s grader did not produce a mark. That is a fault in the platform or the simulation, not in ' +
    'the work. No mark has been given.',
  PENALISED_BELOW_ZERO:
    'The scoring method on this question deducts for incorrect selections, and this response scored below zero on ' +
    'the raw scale. The raw score is kept as it is: the zero floor is applied to the attempt total, not to this ' +
    'question. It was sent to a person so that it is seen before it stands.',
  KEY_UNREADABLE:
    'This question’s answer key could not be read, so no response to it was marked. That is a fault in the ' +
    'question, not in the work.',
  NO_GRADER: 'No automatic marker exists for this question as it is set up, so it was not marked.',
  ANSWER_UNREADABLE:
    'The stored answer could not be read as an answer to this question. That is a fault in the platform, not in ' +
    'the work.',
  NOT_YET_GRADED: 'This response has not been marked yet.',
  REFERRED: 'This response was sent to a person to mark. No reason was recorded.',
};

/**
 * THE STATE LINE. For `AWAITING_MARK` it states what the question is WORTH and nothing about what was earned,
 * because nothing has been decided -- and `MarkingState` gives it no number to print.
 */
export const stateLine = (state: MarkingState): string => {
  switch (state.kind) {
    case 'AWAITING_MARK':
      return `Awaiting a mark. Worth ${String(state.maxPoints)}.`;
    case 'MARKED':
      return `Marked by a teacher: ${String(state.points)} of ${String(state.maxPoints)}.`;
    case 'MARKED_AUTOMATICALLY':
      return `Marked automatically: ${String(state.points)} of ${String(state.maxPoints)}.`;
    case 'EXCUSED':
      return 'Excused. Not counted in the marks earned or in the marks available.';
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
};

/** The short form, for the position line and the announcement on moving between responses. */
export const stateWord = (state: MarkingState): string => {
  switch (state.kind) {
    case 'AWAITING_MARK':
      return 'awaiting a mark';
    case 'MARKED':
      return 'marked by a teacher';
    case 'MARKED_AUTOMATICALLY':
      return 'marked automatically';
    case 'EXCUSED':
      return 'excused';
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
};

export const countsLine = (counts: MarkingCounts): string =>
  `${count(counts.total, 'response')}: ${String(counts.awaiting)} awaiting a mark, ${String(counts.marked)} marked ` +
  `by a teacher, ${String(counts.markedAutomatically)} marked automatically, ${String(counts.excused)} excused.`;

export const positionLine = (position: number, total: number): string =>
  `Response ${String(position)} of ${String(total)}`;

export const SEALED_NOTE =
  'This mark is sealed and cannot be changed here. If the key looks wrong, flag the response: a flag is reviewed ' +
  'and, if it is upheld, every attempt that had this question is regraded together.';

export const RAW_SCORE_NOTE = (raw: number): string =>
  `Raw score ${String(raw)}. The zero floor is applied to the attempt total, not to this question.`;

export const RELEASED_NOTE =
  'These results have been released. A change now is a regrade, which is recorded and tells the student; it is not ' +
  'made on this screen.';

export const ACCEPT_AUTO_LABEL = 'Accept the automatic mark as it stands';
export const ACCEPT_AUTO_NOTE =
  'Accepting keeps the raw score, including the deduction. A mark entered by hand cannot be below 0, so entering ' +
  '0 here would remove the deduction for this response alone.';

export const EXCUSE_LABEL = 'Excuse this response';
export const EXCUSE_REASON_LABEL = 'Reason for excusing';
export const EXCUSE_NOTE =
  'An excused question is removed from the marks earned and from the marks available. The mark above is not used ' +
  'while this is ticked.';
export const EXCUSE_REASON_REQUIRED = 'Give the reason for excusing this response before saving.';

export const FLAG_LABEL = 'Flag this response for follow-up';

export const SCORE_LABEL = (maxPoints: number): string => `Mark, out of ${String(maxPoints)}`;
export const BAND_LEGEND = 'Rubric band';
export const FEEDBACK_LABEL = 'Feedback to the student';
export const SAVE_LABEL = 'Save mark and go to the next response';
export const NEXT_LABEL = 'Next response';
export const PREVIOUS_LABEL = 'Previous response';
export const SHORTCUTS_LABEL = 'Keyboard shortcuts';

export const FEEDBACK_HINT =
  'Sent to the student when results are released. Write about the answer: what it shows and what it leaves out.';

/** Shown while a band’s comment is standing in the field untouched. */
export const PREFILL_HINT =
  'Prefilled from the rubric band. It is sent as your comment, not the platform’s: edit it to fit this answer.';

export const OFFER_INTRO =
  'Your comment was kept. The band’s comment was not inserted, because it would have replaced what you wrote:';
export const OFFER_APPEND = 'Add it below my comment';
export const OFFER_REPLACE = 'Replace my comment with it';
export const OFFER_DISMISS = 'Leave my comment as it is';
export const DISPLACED_INTRO = 'Your earlier comment was replaced by the band’s comment.';
export const DISPLACED_RESTORE = 'Put my comment back';

export const QUICK_SCORED_NOTE =
  'Entered with a single key. This is recorded as quick-scored, and quick-scored marks are sampled for moderation.';

/* ──────────────────────────────────────────────────────────── the draft ── */

export const DRAFT_NONE = 'No draft on this device.';
export const draftKept = (time: string): string =>
  `Draft kept on this device at ${time}. It is not a saved mark yet.`;
export const DRAFT_NOT_KEPT =
  'This browser refused to store the draft. It exists only in this tab: closing or reloading the tab will lose ' +
  'it. Save the mark before leaving.';
export const draftRestored = (time: string, stale: boolean): string =>
  `A draft kept on this device was restored, last changed ${time}. It is not a saved mark.` +
  (stale
    ? ' The response or its mark has changed since this draft was written, so check it against what is shown now.'
    : '');
export const DRAFT_UNREADABLE =
  'Something is stored on this device for this response and it could not be read as a draft. Nothing was restored. ' +
  'It will be replaced if you start a draft here.';
export const DRAFT_DISCARD = 'Discard this draft';
export const DRAFT_DISCARDED =
  'Draft discarded. The fields show the saved mark, or nothing if there is none.';
export const MARK_SAVING = 'Saving the mark…';
export const markSaved = (time: string): string => `Mark saved at ${time}.`;
export const markNotSaved = (reason: string, kept: boolean): string =>
  `The mark was not saved: ${reason}. ` +
  (kept ? 'Your draft is still kept on this device.' : 'The draft exists only in this tab.');
export const REQUEST_DID_NOT_COMPLETE = 'the request did not complete';
export const CHANGED_WHILE_SAVING =
  'Mark saved. You changed the draft while it was saving, and those changes are not saved yet.';

/* ───────────────────────────────────────────────────────── announcements ── */

export const announcePosition = (position: number, total: number, state: MarkingState): string =>
  `${positionLine(position, total)}, ${stateWord(state)}.`;
export const AT_FIRST = 'This is the first response.';
export const AT_LAST = 'This is the last response.';
export const NOTHING_ELSE_AWAITING = 'No other response in this attempt is awaiting a mark.';
export const NOTHING_TO_SAVE = 'Nothing to save on this response.';
export const SEALED_NO_MARK =
  'This response was marked automatically and is sealed. No mark was entered.';
export const noSuchBand = (digit: number): string =>
  `There is no band ${String(digit)} on this question.`;
export const bandApplied = (
  position: number,
  points: number,
  maxPoints: number,
  comment: 'PREFILLED' | 'OFFERED' | 'NONE' | 'UNCHANGED',
): string => {
  const base = `Band ${String(position)} applied: ${String(points)} of ${String(maxPoints)}.`;
  switch (comment) {
    case 'PREFILLED':
      return `${base} Feedback prefilled from the band.`;
    case 'OFFERED':
      return `${base} Your comment was kept; the band’s comment was not inserted.`;
    case 'NONE':
      return `${base} This band has no comment to prefill.`;
    case 'UNCHANGED':
      return base;
    default: {
      const exhaustive: never = comment;
      return exhaustive;
    }
  }
};
export const quickScoredLine = (points: number, maxPoints: number): string =>
  `${String(points)} of ${String(maxPoints)} entered.`;
export const EXCUSED_ON = 'Excused. Give a reason before saving.';
export const EXCUSED_OFF = 'No longer excused.';
export const FLAG_ON = 'Flagged for follow-up.';
export const FLAG_OFF = 'Flag removed.';

/* ──────────────────────────────────────────────────────────── the answer ── */

export const ANSWER_NOT_REACHED =
  'Not reached. Time ran out before this question was opened, so nothing was written.';
export const ANSWER_OMITTED = 'Left unanswered.';
export const ANSWER_BLANK = 'No answer was submitted.';
export const ANSWER_UNREADABLE =
  'Something is stored for this response and it could not be read as an answer to this question. That is a fault ' +
  'in the platform, not in the work. It is shown below exactly as stored.';
export const CHOICE_SELECTED = 'selected';
export const CHOICE_KEYED = 'keyed answer';
export const unknownChoice = (id: string): string =>
  `An option that is not in this question was selected: ${id}`;
export const FILES_NOTE = 'Files are listed by identifier. This screen does not preview them.';
export const STEP_EMPTY = 'Nothing written for this step.';
export const CONCEPT_HINTS_NOTE =
  'Concept hints are suggestions for the marker. They do not decide the mark.';

/* ────────────────────────────────────────────────────────── the replay ── */

export const SIM_NO_OUTCOME = 'No grader outcome is stored for this simulation answer.';
export const simFaultLine = (reason: string, detail: string): string =>
  `The simulation’s grader did not produce a mark (${reason}: ${detail}). That is a fault in the platform or the ` +
  'simulation, not in the work.';
export const simGradedLine = (points: number, maxPoints: number, code: string): string =>
  `The simulation’s grader returned ${String(points)} of ${String(maxPoints)} (${code}).`;
export const SIM_TRACE_EMPTY = 'No interaction trace is stored.';
export const SIM_REPLAY_NOTE =
  'This shows what is stored. It does not re-run the grader, and it does not change the mark.';

/* ───────────────────────────────────────────────────────── the screen ── */

export const workspaceTitle = (candidateLabel: string): string => `Marking: ${candidateLabel}`;
export const NO_RESPONSES = 'This attempt has no responses to mark.';
export const RESPONSES_NAV_LABEL = 'Responses in this attempt';
export const questionHeading = (position: number): string => `Question ${String(position)}`;
export const ANSWER_HEADING = 'Student\u2019s answer';
export const REPLAY_HEADING = 'Simulation replay';
export const MARK_HEADING = 'Mark';
export const GUIDANCE_HEADING = 'Marking guidance';
export const worth = (points: number): string => `Worth ${String(points)}.`;
export const MODEL_ANSWER_LABEL = 'Model answer';
export const CONCEPT_HINTS_LABEL = 'Concept hints';
export const TRACE_HEADING = 'Interaction trace';
export const automaticReport = (explanation: string): string =>
  `The automatic marker reported: ${explanation}`;
/**
 * A band in the list. "Worth N", NOT "N of M": that phrasing is reserved for a mark that has been GIVEN, and a
 * zero-mark band listed beside an unmarked essay would otherwise put "0 of 5" on a screen whose whole job is not to
 * say that.
 */
export const bandOption = (position: number, points: number, descriptor: string): string =>
  `${String(position)}. Worth ${String(points)}: ${descriptor}`;
export const MARK_SAVED_SHORT = 'Mark saved.';
export const DRAFT_RESTORED_SHORT = 'A draft kept on this device was restored.';

export const SHORTCUTS_CAPTION = 'What each key does on this screen';
export const SHORTCUTS_NOTE =
  'Every shortcut has a control on this screen that does the same thing. A key that is not listed here is left ' +
  'to the field it is typed in, or to the browser.';
export const SHORTCUT_COLUMNS = ['Key', 'What it does', 'Where it works'] as const;
export const SHORTCUT_SCOPE = {
  ANYWHERE: 'Anywhere, including inside a field',
  OUTSIDE_TEXT_ENTRY: 'When not typing in a field',
  OUTSIDE_CONTROLS: 'When focus is not on a field, a button or a checkbox',
} as const;

/* ─────────────────────────────────────────────────────────── the layout ── */

export const STACKED_NOTE =
  'This window is too narrow to show the question and the answer side by side. They are stacked in this order: ' +
  'question, answer, simulation replay, mark.';

/* ──────────────────────────────────────────────────────── the rubric editor ── */

export const RUBRIC_EDIT_SUMMARY = 'Edit the rubric for this question';
export const rubricBound = (maxPoints: number): string =>
  `A band is worth between 0 and ${String(maxPoints)}. A band cannot take marks away.`;
export const RUBRIC_DOES_NOT_REGRADE =
  'Changing a band does not change marks already saved with it. Those keep the value they were saved with; ' +
  'changing them is a regrade.';
export const BAND_POINTS_LABEL = 'Marks';
export const BAND_DESCRIPTOR_LABEL = 'What earns this band';
export const BAND_COMMENT_LABEL = 'Comment prefilled when this band is applied';
export const BAND_COMMENT_HINT =
  'Optional. Write about the answer: what it shows and what it leaves out. It becomes the teacher’s comment when ' +
  'the band is applied, and can be edited each time.';
export const RUBRIC_ADD = 'Add a band';
export const RUBRIC_SAVE = 'Save rubric';
export const RUBRIC_SAVED = 'Rubric saved.';
export const RUBRIC_UNSAVED = 'The rubric has changes that are not saved.';
export const RUBRIC_BLOCKED = 'The rubric was not saved. Correct the bands marked below first.';
export const rubricNotSaved = (reason: string): string => `The rubric was not saved: ${reason}.`;
export const RUBRIC_EMPTY =
  'This question has no rubric bands. Marks are typed into the mark field.';
export const bandMoved = (from: number, to: number): string =>
  `Band ${String(from)} is now band ${String(to)}.`;
export const bandCannotMove = (position: number, direction: 'UP' | 'DOWN'): string =>
  `Band ${String(position)} is already ${direction === 'UP' ? 'first' : 'last'}.`;
export const bandRemoved = (position: number): string => `Band ${String(position)} removed.`;
export const bandAdded = (position: number): string => `Band ${String(position)} added.`;

/**
 * EVERY SENTENCE IN THIS FILE, with the formatters called on representative values.
 *
 * For the copy test, so the language rules are checked against everything the screen can say rather than against the
 * strings a test author remembered to list. A string CONSTANT added above and left out of this list fails the test
 * that compares the list with the module's exports. A new FORMATTER does not -- nothing can call a function it has
 * never seen -- and has to be added here by hand.
 */
export const allCopy = (): readonly string[] => {
  const awaiting: MarkingState = { kind: 'AWAITING_MARK', why: 'MARKED_BY_HAND', maxPoints: 5 };
  const states: readonly MarkingState[] = [
    awaiting,
    { kind: 'MARKED', points: 3, maxPoints: 5 },
    { kind: 'MARKED_AUTOMATICALLY', points: 0, maxPoints: 5 },
    { kind: 'EXCUSED' },
  ];
  return [
    ...Object.values(AWAITING_REASON),
    ...states.flatMap((state) => [
      stateLine(state),
      stateWord(state),
      announcePosition(2, 7, state),
    ]),
    countsLine({ total: 7, awaiting: 2, marked: 1, markedAutomatically: 3, excused: 1 }),
    positionLine(2, 7),
    SEALED_NOTE,
    RAW_SCORE_NOTE(-2),
    RELEASED_NOTE,
    ACCEPT_AUTO_LABEL,
    ACCEPT_AUTO_NOTE,
    EXCUSE_LABEL,
    EXCUSE_REASON_LABEL,
    EXCUSE_NOTE,
    EXCUSE_REASON_REQUIRED,
    FLAG_LABEL,
    SCORE_LABEL(5),
    BAND_LEGEND,
    FEEDBACK_LABEL,
    SAVE_LABEL,
    NEXT_LABEL,
    PREVIOUS_LABEL,
    SHORTCUTS_LABEL,
    FEEDBACK_HINT,
    PREFILL_HINT,
    OFFER_INTRO,
    OFFER_APPEND,
    OFFER_REPLACE,
    OFFER_DISMISS,
    DISPLACED_INTRO,
    DISPLACED_RESTORE,
    QUICK_SCORED_NOTE,
    DRAFT_NONE,
    draftKept('14:32'),
    DRAFT_NOT_KEPT,
    draftRestored('14:32', false),
    draftRestored('14:32', true),
    DRAFT_UNREADABLE,
    DRAFT_DISCARD,
    DRAFT_DISCARDED,
    MARK_SAVING,
    markSaved('14:32'),
    markNotSaved(REQUEST_DID_NOT_COMPLETE, true),
    markNotSaved(REQUEST_DID_NOT_COMPLETE, false),
    REQUEST_DID_NOT_COMPLETE,
    CHANGED_WHILE_SAVING,
    AT_FIRST,
    AT_LAST,
    NOTHING_ELSE_AWAITING,
    NOTHING_TO_SAVE,
    SEALED_NO_MARK,
    noSuchBand(7),
    bandApplied(2, 2, 5, 'PREFILLED'),
    bandApplied(2, 2, 5, 'OFFERED'),
    bandApplied(2, 2, 5, 'NONE'),
    bandApplied(2, 2, 5, 'UNCHANGED'),
    quickScoredLine(3, 5),
    EXCUSED_ON,
    EXCUSED_OFF,
    FLAG_ON,
    FLAG_OFF,
    ANSWER_NOT_REACHED,
    ANSWER_OMITTED,
    ANSWER_BLANK,
    ANSWER_UNREADABLE,
    CHOICE_SELECTED,
    CHOICE_KEYED,
    unknownChoice('z'),
    FILES_NOTE,
    STEP_EMPTY,
    CONCEPT_HINTS_NOTE,
    SIM_NO_OUTCOME,
    simFaultLine('GRADER_THREW', 'TypeError'),
    simGradedLine(2, 3, 'PARTIAL'),
    SIM_TRACE_EMPTY,
    SIM_REPLAY_NOTE,
    workspaceTitle('Candidate 14'),
    NO_RESPONSES,
    RESPONSES_NAV_LABEL,
    questionHeading(3),
    ANSWER_HEADING,
    REPLAY_HEADING,
    MARK_HEADING,
    GUIDANCE_HEADING,
    worth(5),
    MODEL_ANSWER_LABEL,
    CONCEPT_HINTS_LABEL,
    TRACE_HEADING,
    automaticReport('A different option was chosen.'),
    bandOption(2, 2, 'names one force'),
    MARK_SAVED_SHORT,
    DRAFT_RESTORED_SHORT,
    SHORTCUTS_CAPTION,
    SHORTCUTS_NOTE,
    ...SHORTCUT_COLUMNS,
    ...Object.values(SHORTCUT_SCOPE),
    STACKED_NOTE,
    RUBRIC_EDIT_SUMMARY,
    rubricBound(5),
    RUBRIC_DOES_NOT_REGRADE,
    BAND_POINTS_LABEL,
    BAND_DESCRIPTOR_LABEL,
    BAND_COMMENT_LABEL,
    BAND_COMMENT_HINT,
    RUBRIC_ADD,
    RUBRIC_SAVE,
    RUBRIC_SAVED,
    RUBRIC_UNSAVED,
    RUBRIC_BLOCKED,
    rubricNotSaved(REQUEST_DID_NOT_COMPLETE),
    RUBRIC_EMPTY,
    bandMoved(2, 1),
    bandCannotMove(1, 'UP'),
    bandCannotMove(3, 'DOWN'),
    bandRemoved(2),
    bandAdded(4),
  ];
};

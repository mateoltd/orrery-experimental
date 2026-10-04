'use client';

/**
 * Leave-and-return: what happens when a student goes away mid-exam.  (P8-T13)
 *
 * ## LEAVING DOES NOT PAUSE THE CLOCK, AND THE PRODUCT MUST NOT PRETEND OTHERWISE
 *
 * `plans/09` §12: "Tab closed mid-exam → Attempt stays `IN_PROGRESS`; resume allowed; elapsed time preserved; closing
 * is logged." Every product in this space that pauses is lying to the student, because the timer on the server did not
 * pause, and a student who learns that on return has been taught that the clock is not to be believed -- which is
 * worse for the next exam than the original lie.
 *
 * ## THE BROWSER WILL NOT LET US SAY ANYTHING, AND THAT IS NOT AN OBSTACLE
 *
 * `beforeunload` can set `returnValue` and can suppress its own dialog, but a modern browser shows **its own** string.
 * There is no API for a custom message. So `leaveDecision` returns a boolean and NO COPY, and a caller that tries to
 * attach a sentence has to go somewhere else and invent it.
 *
 * This is the same honesty constraint as `Escape` in `plans/09` §6.1, which the repo has already written down once:
 * `Escape` releases pointer lock, browsers deliberately prevent interception, and any product claiming otherwise is
 * lying. The rule generalises -- **never ship a claim about a browser behaviour you cannot implement.**
 *
 * ## AND THE STUDENT MAY ALWAYS LEAVE
 *
 * No refusal, ever. `plans/09` §12 requires resume to be permitted, and a dialog that blocks leaving contradicts it
 * directly; more practically, a student whose laptop is about to sleep or whose battery is dying cannot be held here,
 * and the attempt survives regardless because the server owns the clock. What this module decides is only whether to
 * *ask first*, and `warn` is `false` when there is nothing at stake.
 */

import type { AttemptState } from '../answerStore';

/** What kind of departure this is, because the two need different handling and neither needs a message. */
export type Departure = 'UNLOAD' | 'IN_APP_NAVIGATION';

export interface LeaveDecision {
  /**
   * Whether to ask the student first. `true` means "set `event.returnValue`" on `beforeunload`, or render the in-app
   * prompt. It NEVER means the departure is prevented -- see the note above.
   */
  readonly warn: boolean;
  /**
   * What the student is told, in OUR words, for an in-app navigation. `null` for `UNLOAD`, because we have no way to
   * show it: the browser's string is the only string there is.
   *
   * Typed `null` rather than omitted for the same reason `Evidence['detail']` was widened to admit it in P8-T5: both
   * alternatives assert something nobody knows. An absent field reads as "nothing to say"; `false` reads as "we said
   * no".
   */
  readonly message: string | null;
  /** Whether the elapsed time continues. Always `true`, and a field so a caller cannot quietly assume otherwise. */
  readonly clockContinues: boolean;
  /**
   * Whether the student may come back to this attempt. Always `true` while the attempt is open, and exported as a
   * constant because a caller that caches it will eventually cache it at the wrong moment.
   */
  readonly resumable: boolean;
}

/** The one sentence the platform can say about a departure. Deliberately says nothing about the clock being fair. */
export const LEAVE_MESSAGE =
  'Your answers stay saved on this device and your time keeps running. You can come back to this attempt.';

/**
 * SHOULD WE ASK?
 *
 * `UNLOAD` gets the browser's own dialog, which most students have learned to dismiss without reading -- so the bar for
 * asking is low and asking every time is pure noise. `IN_APP_NAVIGATION` is a link this application controls, so it can
 * carry a real sentence and a real choice.
 *
 * **THE THREE THINGS THAT MAKE LEAVING WORTH ASKING ABOUT**, and none of them is "the attempt is in progress":
 *
 * - **queued writes.** Closing with writes in the queue is how an answer is lost. This is the strongest of the three
 *   and it is the one `answerStore`'s `ABANDONED` state exists for.
 * - **anything answered at all.** An untouched paper is empty; leaving it costs nothing.
 * - **open windows.** A per-question timer that expires while the student is away is a surprise, and `plans/09` §12's
 *   "elapsed time preserved" is the honest description of what happened.
 *
 * Deliberately NOT one of them: elapsed time, or how much is unanswered. Neither is lost by leaving.
 */
export const leaveDecision = (
  state: Pick<AttemptState, 'answers' | 'queued' | 'slots' | 'status'>,
  departure: Departure,
): LeaveDecision => {
  const answered = Object.keys(state.answers).length > 0;
  const queued = state.queued.length > 0;
  const openWindow = state.slots.some((slot) => slot.questionDeadlineAt !== null);

  const warn = queued || answered || openWindow;

  if (departure === 'UNLOAD') {
    // `message: null`, and it is `null` rather than omitted. See the interface's note.
    return { warn, message: null, clockContinues: true, resumable: true };
  }

  return {
    warn,
    message: warn ? LEAVE_MESSAGE : null,
    clockContinues: true,
    resumable: true,
  };
};

/*
 * I WROTE AN `armUnloadWarning` HELPER HERE AND DELETED IT, and the reason is worth recording.
 *
 * The temptation is to wrap the two DOM lines -- `event.preventDefault()` and `event.returnValue = ''` -- because
 * getting them subtly wrong is easy and no test at the call site would notice. Only current browsers consult the
 * `returnValue` assignment; `preventDefault()` alone shows nothing.
 *
 * The helper I wrote took the window, the event AND the decision, and then called
 * `addEventListener('beforeunload', ...)` from inside its own body -- so every firing of the event registered
 * another copy of itself. That is not a subtle bug in a helper, it is a helper that cannot exist, and it passed my
 * reading because the signature looked reasonable.
 *
 * So the note stays and the function does not: `leaveDecision(...).warn` is the whole contract, and the two lines are
 * the caller's. A wrapper would also have had to invent an event type and a target it does not own, which is how a
 * three-line browser call becomes a module with a surface.
 */

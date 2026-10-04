'use client';

/**
 * The recovery overlay's decision logic.  (P8-T4)
 *
 * ## "NEVER A DEAD END" IS THE WHOLE REQUIREMENT, AND IT IS EASIER TO GET WRONG THAN IT LOOKS
 *
 * An integrity overlay is a modal with a message and a button. The failure mode is the version where the button says
 * "Return to fullscreen" and is disabled while the browser refuses, which leaves a student staring at a modal they
 * cannot leave -- on a locked-down school device, in an iframe, or after a policy denies fullscreen. That is worse than
 * not showing the overlay at all: it converts a recoverable situation into a dead end and, because it is modal, it
 * blocks the exam.
 *
 * So the rule this module enforces is structural rather than editorial: **there is always at least one action, and it
 * always leads somewhere.** A dismissal is one of those actions, and it is always present.
 *
 * ## AND IT NEVER ACCUSES
 *
 * The copy does not say the student did something. It states what the exam noticed and what it will do about it. A
 * student who alt-tabbed to check a definition and is told they have been flagged for cheating have been told
 * something false, and the escalation ladder will act on the false report.
 */

import type { EvidenceKind } from './watchdog';

/** Why the overlay is up. */
export type OverlayReason =
  | 'FULLSCREEN_LOST'
  | 'FULLSCREEN_DENIED'
  | 'POINTER_LOCK_LOST'
  | 'WINDOW_BLURRED'
  | 'TAB_HIDDEN'
  | 'MULTI_TAB'
  | 'NETWORK_LOST';

/** What the student can do from the overlay. `CONTINUE_UNLOCKED` is the one that must always exist. */
export type OverlayAction =
  | 'REQUEST_FULLSCREEN'
  | 'REQUEST_POINTER_LOCK'
  | 'CONTINUE_UNLOCKED'
  | 'SAVE_AND_CONTINUE'
  | 'END_AND_SUBMIT';

export interface OverlayState {
  readonly reason: OverlayReason;
  /** True when the browser REFUSED fullscreen rather than the student leaving it. Changes the copy entirely. */
  readonly isDenial: boolean;
  /** How many times this has happened in this attempt, including this one. */
  readonly count: number;
  /** Whether the attempt's deadline has already passed. A dead end is least bad when time is up. */
  readonly isOutOfTime: boolean;
  /** Whether a request is in flight, so the primary action can say "waiting" instead of pretending to work. */
  readonly isRequestPending: boolean;
  /** Whether answers can still be saved from where the student is. False means the overlay must offer submission. */
  readonly canSave: boolean;
}

export interface OverlayCopy {
  readonly title: string;
  readonly body: string;
  readonly primary: { readonly action: OverlayAction; readonly label: string };
  /** Every action offered, in order. Never empty. */
  readonly actions: readonly { readonly action: OverlayAction; readonly label: string }[];
  /** True when at least one offered action is not "try again". Drives the accessibility live-region announcement. */
  readonly hasWayForward: boolean;
}

const REASON_TO_EVIDENCE: Readonly<Record<OverlayReason, EvidenceKind>> = Object.freeze({
  FULLSCREEN_LOST: 'FULLSCREEN_EXITED',
  FULLSCREEN_DENIED: 'FULLSCREEN_DENIED',
  POINTER_LOCK_LOST: 'POINTERLOCK_LOST',
  WINDOW_BLURRED: 'WINDOW_BLURRED',
  TAB_HIDDEN: 'TAB_HIDDEN',
  MULTI_TAB: 'MULTI_TAB_DETECTED',
  NETWORK_LOST: 'NETWORK_LOST',
});

/** The evidence kind this overlay state reports when it opens, so the timeline records the same reason the student saw. */
export const evidenceFor = (reason: OverlayReason): EvidenceKind => REASON_TO_EVIDENCE[reason];

/**
 * BUILD THE OVERLAY'S COPY AND ACTIONS.
 *
 * Pure, so the rule that matters -- there is always a way forward -- is a property that can be tested over every
 * combination rather than read.
 */
export const overlayCopy = (state: OverlayState): OverlayCopy => {
  const asksForFullscreen =
    state.reason === 'FULLSCREEN_LOST' || state.reason === 'FULLSCREEN_DENIED';

  /**
   * A REQUEST IN FLIGHT, OR A REFUSAL, SUPPRESSES THE "TRY AGAIN" BUTTON.
   *
   * A disabled primary button labelled "Return to fullscreen" is the dead end. On a refusal there is nothing to return
   * to, so the button would be permanently disabled; and while a request is pending, offering it again invites a
   * second request the browser will also refuse. Both cases fall through to the dismiss action instead.
   */
  const retryIsUseful = asksForFullscreen && !state.isDenial && !state.isRequestPending;

  const title = ((): string => {
    if (state.isOutOfTime) return 'Time is up';
    if (state.reason === 'FULLSCREEN_DENIED') return 'Fullscreen is not available here';
    switch (state.reason) {
      case 'FULLSCREEN_LOST':
        return 'You left fullscreen';
      case 'POINTER_LOCK_LOST':
        return 'The pointer was released';
      case 'MULTI_TAB':
        return 'This exam is open in another tab';
      case 'NETWORK_LOST':
        return 'The connection dropped';
      default:
        return 'The exam lost focus';
    }
  })();

  /**
   * THE BODY STATES WHAT NOTICED AND WHAT HAPPENS NEXT. IT NEVER SAYS THE STUDENT MISBEHAVED.
   *
   * This is a sentence about the exam's own behaviour. It differs between the first occurrence and a later one ONLY in
   * saying the event is recorded -- the escalation ladder is what acts on a pattern, and the overlay is not that.
   *
   * An earlier version of this comment claimed the sentence was identical at every count, which the code did not do and
   * should not: "this has happened again, and it is recorded" is true and useful, while being told you have been
   * "flagged" on your first alt-tab is neither. Neither variant accuses, and that is the invariant worth pinning.
   */
  const body = ((): string => {
    if (state.isOutOfTime) {
      return 'The time for this exam has passed. Your last saved answers are kept, and you can submit them now.';
    }
    if (state.reason === 'FULLSCREEN_DENIED') {
      // The most important sentence in this module: the browser refused, so the student is not at fault and must not
      // be told to do something they cannot do.
      return 'This browser will not allow fullscreen here. You can carry on without it — nothing is withheld for that.';
    }
    if (state.count > 1) {
      return 'This has happened again. It is recorded, and a teacher can see it when the exam is reviewed.';
    }
    if (state.reason === 'MULTI_TAB') {
      return 'Only one copy of this exam can be open at a time. Close the other tab to carry on.';
    }
    if (state.reason === 'NETWORK_LOST') {
      return 'Answers are kept on this device and sent when the connection returns.';
    }
    return 'The exam noticed the window changed. Your saved answers are unaffected.';
  })();

  const actions: { action: OverlayAction; label: string }[] = [];

  if (retryIsUseful) {
    actions.push({
      action:
        asksForFullscreen && state.reason === 'FULLSCREEN_LOST'
          ? 'REQUEST_FULLSCREEN'
          : 'REQUEST_FULLSCREEN',
      label: 'Return to fullscreen',
    });
  }
  if (state.reason === 'POINTER_LOCK_LOST') {
    actions.push({ action: 'REQUEST_POINTER_LOCK', label: 'Click to resume' });
  }

  /**
   * THE DISMISS IS ALWAYS OFFERED, AND IT IS WHAT MAKES THIS NOT A DEAD END.
   *
   * On a refusal there is nothing to return to; on a policy that forbids fullscreen there never was. Without this the
   * student has a modal, an explanation, and no way out.
   */
  if (state.canSave) {
    actions.push({ action: 'CONTINUE_UNLOCKED', label: 'Carry on without it' });
  } else {
    // Cannot save from here, so continuing is not an option and submission is the only honest action left.
    actions.push({ action: 'SAVE_AND_CONTINUE', label: 'Save and carry on' });
  }
  if (state.isOutOfTime) {
    actions.push({ action: 'END_AND_SUBMIT', label: 'Submit now' });
  }

  const primary = actions[0] ?? { action: 'CONTINUE_UNLOCKED' as const, label: 'Carry on' };

  return {
    title,
    body,
    primary,
    actions,
    hasWayForward: actions.some((entry) => entry.action !== 'REQUEST_FULLSCREEN'),
  };
};

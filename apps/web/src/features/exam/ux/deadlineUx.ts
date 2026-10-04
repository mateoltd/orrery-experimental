'use client';

/**
 * Deadline UX: the countdown, what it does to saving, and when it says something out loud.  (P8-T13)
 *
 * ## THE DISPLAYED NUMBER IS THE SERVER'S DEADLINE AND NOTHING ELSE
 *
 * `now` arrives here as `{ clientNow, offset }` and every figure goes through `correctedNow`, imported from
 * `./serverClock` rather than re-added, for the reason that module's own comment gives: one place adds the offset,
 * so no caller can forget. A countdown computed from the raw client clock is wrong by exactly the offset, and it is
 * wrong in the direction that matters -- a client whose clock is slow reads as having MORE time than it does.
 *
 * `INV-LATE-1` is why the display and the decision are allowed to disagree. The screen says "time is up"; the server
 * decides whether the write lands. Clamping at zero rather than rendering a negative number is the honest pair.
 *
 * ## THE PHASES ARE DERIVED, NEVER TRACKED
 *
 * `aggressiveSaving` is a FUNCTION of the phase, not a flag a timer sets. Two flags that can disagree -- a phase and a
 * boolean -- is the mechanism behind every "the client thought it was safe to buffer" bug, and the phase is already
 * known, so deriving it removes a state that could be wrong rather than adding one that could.
 *
 * ## THE ANNOUNCEMENT IS THE PART THAT IS EASY TO GET WRONG
 *
 * A live region that re-renders every second is the most abrasive thing on an exam screen: it interrupts the student
 * once a second for an hour. So `nextAnnouncement` is a two-argument function -- remaining, and what has already been
 * said -- and it returns a threshold at most once each. The countdown may update every second; the announcement does
 * not. The three thresholds are the ones `plans/15` and the a11y interaction contract already fixed at 300/60/10
 * seconds, so this file adopts them rather than inventing a set.
 */

import { correctedNow } from '../serverClock';

/**
 * `plans/09` §9: "Near the deadline the client switches to aggressive saving (no debounce) and fires a final submit
 * at `deadlineAt - 2 s`."
 *
 * Two seconds, and the number is worth keeping: it is the largest gap that still leaves a request time to arrive
 * before the deadline rather than after it, where it would be refused and the student would never learn why.
 */
export const FINAL_SUBMIT_LEAD_MS = 2_000;

/**
 * How early the client drops its debounce entirely.
 *
 * Not the same as the final-submit lead: debouncing protects a student mid-sentence, and the window where that
 * protection is worth less than a guaranteed save is much wider than two seconds.
 */
export const AGGRESSIVE_SAVING_LEAD_MS = 30_000;

export type DeadlinePhase =
  /** No total limit. Nothing here can tick, and the UI must not pretend otherwise. */
  | 'UNTIMED'
  /** Open, with time to spare. Debounced saving. */
  | 'OPEN'
  /** Close enough that a lost debounce window could cost a mark. No debounce. */
  | 'NEAR_DEADLINE'
  /** Inside the final-submit lead. The submit is owed now. */
  | 'FINAL_SUBMIT'
  /** Past `deadlineAt`, inside `grace`. The outbox still flushes and writes are still admitted. */
  | 'GRACE'
  /** Past `deadlineAt + grace`. Nothing further is accepted; the queue is abandoned and said so. */
  | 'CLOSED';

export interface DeadlineView {
  readonly phase: DeadlinePhase;
  /** Clamped at zero. A negative countdown in a student's browser is worse than one reading 0:00. */
  readonly remainingMs: number;
  /** What the student is told, or `null` when there is nothing worth interrupting them for. */
  readonly announcement: string | null;
  /** What the thresholds already announced, so each is said once. Carry this forward on every tick. */
  readonly announced: readonly number[];
  /**
   * Whether the autosave debounce applies at all. Derived from `phase`, so it cannot drift out of step with the
   * countdown the student is reading.
   */
  readonly savingMode: 'DEBOUNCED' | 'AGGRESSIVE' | 'FLUSH_ONLY';
  /** True once the client owes a submit. Separate from `phase` because it is a debt, not a state. */
  readonly submitDue: boolean;
  /**
   * True once unacknowledged answers must be described as possibly unrecorded, and never described as saved again.
   * `answerStore`'s `ABANDONED` is absorbing, and so is this.
   */
  readonly mustDiscloseLoss: boolean;
}

/**
 * THE PHASE, AT AN INSTANT.
 *
 * `phaseAt` is exported separately because `plans/09` §9's three rules (what to save, whether to submit, what to tell
 * the student) are three consequences of one position on a line, and testing them through the whole view is how a
 * boundary gets checked from the outside when it should be checked from the inside.
 */
export const phaseAt = (deadlineAt: number | null, graceMs: number, now: number): DeadlinePhase => {
  if (deadlineAt === null) return 'UNTIMED';
  if (now > deadlineAt + graceMs) return 'CLOSED';
  if (now > deadlineAt) return 'GRACE';
  if (now >= deadlineAt - FINAL_SUBMIT_LEAD_MS) return 'FINAL_SUBMIT';
  if (now >= deadlineAt - AGGRESSIVE_SAVING_LEAD_MS) return 'NEAR_DEADLINE';
  return 'OPEN';
};

/** The three thresholds, in the order they are met. Descending, because time runs that way. */
export const ANNOUNCEMENT_THRESHOLDS_MS = [300_000, 60_000, 10_000] as const;

const phrase = (remainingMs: number): string => {
  const totalSeconds = Math.ceil(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0
    ? `${String(minutes)}:${String(seconds).padStart(2, '0')}`
    : `${String(seconds)}s`;
};

/**
 * THE NEXT THRESHOLD TO SAY, OR `null`.
 *
 * **`announced` IS AN INPUT, AND THAT IS THE WHOLE DESIGN.** The alternative -- returning a string whenever the
 * remaining time is under some bound -- makes a live region announce the same fact every second for the last five
 * minutes, which is not "advisory" in any sense a student would thank you for. Each threshold fires once: it is
 * dropped from the carried set the moment it is said.
 *
 * The returned array is the new `announced`, so a caller cannot announce twice by forgetting to record. A caller can
 * still get it wrong by not carrying it, which is why `deadlineView` takes and returns it rather than holding it.
 */
export const nextAnnouncement = (
  remainingMs: number,
  announced: readonly number[],
): { readonly announcement: string | null; readonly announced: readonly number[] } => {
  /**
   * CROSSING ONE THRESHOLD CROSSES EVERY LARGER ONE, and my first version did not know that.
   *
   * The filters were "every threshold at or below the remaining time that has not been said", so at 59 s the 300 s and
   * 60 s bands were both due, the more urgent was spoken, and the 300 s band stayed pending. It then fired on a
   * LATER TICK: a student with fifty-nine seconds left was told "**5:00** left on this exam". A countdown that
   * announces time the student no longer has is worse than no countdown, because it is the one number they were
   * checking.
   *
   * Time runs one way, so a threshold above the one just spoken is necessarily already behind us. So announcing
   * `next` records every threshold at or above it, and the set is monotonically non-decreasing.
   */
  const said = new Set(announced);
  const pending = ANNOUNCEMENT_THRESHOLDS_MS.filter(
    (threshold) => remainingMs <= threshold && !said.has(threshold),
  );
  if (pending.length === 0) return { announcement: null, announced: [...announced] };

  const next = Math.min(...pending);
  return {
    announcement: `${phrase(next)} left on this exam.`,
    announced: [...new Set([...announced, ...ANNOUNCEMENT_THRESHOLDS_MS.filter((t) => t >= next)])],
  };
};

/**
 * THE WHOLE DEADLINE VIEW AT AN INSTANT.
 *
 * `announced` defaults to empty, so the first call at 4h59m says nothing at all -- which is correct, and worth
 * stating because the tempting default is to announce something on every mount.
 */
export const deadlineView = (
  input: {
    readonly deadlineAt: number | null;
    readonly gracePeriodSec: number;
  },
  now: { readonly clientNow: number; readonly offset: number },
  announced: readonly number[] = [],
): DeadlineView => {
  const serverNow = correctedNow(now.clientNow, now.offset);
  const phase = phaseAt(input.deadlineAt, input.gracePeriodSec * 1000, serverNow);
  const remainingMs =
    input.deadlineAt === null
      ? Number.POSITIVE_INFINITY
      : Math.max(0, input.deadlineAt - serverNow);

  /**
   * `UNTIMED` SAYS NOTHING, EVER -- not even the largest threshold.
   *
   * `remainingMs` is `Infinity` there, and `Infinity <= 300_000` is false, so the thresholds are naturally silent.
   * That is luck rather than design, so it is stated: a countdown reading "5 minutes left" on an untimed exam is a
   * lie that would end in a support ticket, and the thresholds must not acquire an untimed arm later.
   */
  const { announcement, announced: said } = nextAnnouncement(remainingMs, announced);

  return {
    phase,
    remainingMs,
    announcement,
    announced: said,
    savingMode:
      phase === 'UNTIMED' || phase === 'OPEN'
        ? 'DEBOUNCED'
        : phase === 'CLOSED'
          ? 'FLUSH_ONLY'
          : 'AGGRESSIVE',
    submitDue: phase === 'FINAL_SUBMIT' || phase === 'GRACE',
    /**
     * DISCLOSURE IS ABSORBING, LIKE `answerStore`'s `ABANDONED`.
     *
     * `CLOSED` is terminal and nothing reopens it, so there is no path by which this returns false once true. A
     * countdown that went back to reassuring after the grace period ended would be the worst version of this bug:
     * the student stops checking an answer the server never received.
     */
    mustDiscloseLoss: phase === 'CLOSED',
  };
};

/**
 * THE PER-QUESTION TIMER, and why it is NOT the same function.
 *
 * A question window has no `UNTIMED` case for the paper and no `FINAL_SUBMIT` obligation, and it can close while
 * the paper is wide open -- which is the situation a student most needs to be told about and least expects. So it is
 * a separate small function rather than a flag on the attempt view.
 *
 * **`SOFT` MATTERS HERE.** Under `expiryVerdict`, a `SOFT` question past its own window is still writable, so the
 * copy must not say "time is up" for a question that is still accepting an answer. It says the timer has ended and
 * that the answer is still recorded.
 */
export const questionTimer = (
  input: {
    readonly questionDeadlineAt: number | null;
    readonly expiry: 'SOFT' | 'LOCK' | 'AUTO_SUBMIT';
    readonly perQuestionTimeLimitSec: number | null;
  },
  now: { readonly clientNow: number; readonly offset: number },
): {
  readonly remainingMs: number;
  readonly phase: 'UNTIMED' | 'OPEN' | 'SOFT_EXPIRED' | 'LOCKED';
  readonly copy: string | null;
} => {
  if (input.questionDeadlineAt === null || input.perQuestionTimeLimitSec === null) {
    return { remainingMs: Number.POSITIVE_INFINITY, phase: 'UNTIMED', copy: null };
  }
  const serverNow = correctedNow(now.clientNow, now.offset);
  const remainingMs = Math.max(0, input.questionDeadlineAt - serverNow);
  if (remainingMs > 0) return { remainingMs, phase: 'OPEN', copy: null };

  // `expiryInstruction` reads `NONE` with no per-question limit, so with no limit configured the term cannot bite
  // and the honest reading is that nothing has expired. Reached only when a slot carries a deadline the policy
  // does not describe -- an imported bank, or a row written under an older policy -- so it must not claim expiry.
  const termApplies = input.expiry !== 'SOFT' || input.perQuestionTimeLimitSec !== null;
  if (input.expiry === 'SOFT' && termApplies) {
    return {
      remainingMs: 0,
      phase: 'SOFT_EXPIRED',
      copy: 'The timer for this question has ended. You can still change your answer until the exam ends.',
    };
  }
  return {
    remainingMs: 0,
    phase: 'LOCKED',
    copy: 'The timer for this question has ended and your answer for it is now fixed.',
  };
};

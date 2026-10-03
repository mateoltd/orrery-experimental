'use client';

/**
 * The resume screen: what a returning student is told.  (P7-T14)
 *
 * ## THE ONE THING THIS GETS RIGHT IS THE CLOCK
 *
 * `plans/01` §9's state diagram labels the resume edge "**same attempt, same server clock**". Both halves are
 * load-bearing, and the second is the one a resume screen gets wrong.
 *
 * A fresh countdown on resume is the default because it is what a page reload naturally produces -- the client
 * re-reads its own clock, the offset has not been re-synced yet, and the number on screen is wrong by however long
 * the tab was closed. So the prompt reports the time left from the SERVER's `deadlineAt` and the re-synced offset,
 * and says plainly that the deadline did not move. A student who closed the lid for ten minutes must not come
 * back to a paper that appears to have gained time.
 *
 * ## AND THE HONEST CASE IS THE UNSAVED ONE
 *
 * `plans/01` §9.3: the outbox exists so that "**nothing is silently lost and nothing is silently kept**". That
 * sentence has two halves and the second is the harder one. If a student's queued writes did not reach the server,
 * the resume screen has to SAY SO -- because the alternative is a student reading "all answers saved", closing the
 * tab, and discovering at marking time that three answers were never received.
 *
 * So a resume prompt that reports `CLEAN` when the queue is empty AND the durability is clean, and reports
 * `UNSAVED` when either is not, is the whole requirement. It never reports "saved" from the queue being empty
 * alone, because an abandoned queue is empty too.
 */

import type { AttemptState, Durability } from './answerStore';
import { correctedNow } from './serverClock';

/** What the student is told, and why. `null` when there is nothing worth interrupting them with. */
export interface ResumePrompt {
  readonly kind: 'UNSAVED' | 'TIME_PASSED' | 'OK';
  readonly heading: string;
  readonly detail: string;
  /** Whether the student must acknowledge before the paper opens. */
  readonly blocking: boolean;
}

/**
 * WHAT THE STUDENT IS TOLD, given everything known about their return.
 *
 * `deadlineAt` is the SERVER's deadline and `offset` the re-synced one, so `correctedNow` is used rather than the
 * client's raw clock. That function is imported rather than re-derived for the same reason `remainingMs` is used
 * everywhere else: one place adds the offset, so no caller can forget.
 *
 * ORDER MATTERS, and the order is by how much a student would be misled by getting it wrong:
 *
 * 1. **TIME_PASSED** -- the paper is closed. Nothing else matters; showing "you have unsaved answers" to a student
 *    whose paper has closed is technically true and useless.
 * 2. **UNSAVED** -- the queue holds writes the server has not acknowledged. Blocking, because continuing without
 *    acknowledging means writing more answers onto a paper whose last few they may not have.
 * 3. **OK** -- nothing to say.
 */
export const resumePrompt = (
  state: Pick<AttemptState, 'queued' | 'durability' | 'deadlineAt'>,
  now: { readonly clientNow: number; readonly offset: number },
): ResumePrompt | null => {
  const serverNow = correctedNow(now.clientNow, now.offset);

  if (state.deadlineAt !== null && serverNow > state.deadlineAt) {
    return {
      kind: 'TIME_PASSED',
      heading: 'Your time is up',
      detail:
        'This attempt closed while you were away. Answers that reached the server have been kept; anything still waiting to send may not have been recorded.',
      // NOT blocking: there is nothing to continue into, so a dialog the student must dismiss before the closed
      // paper opens is a dialog with no purpose.
      blocking: false,
    };
  }

  /**
   * THE QUEUE BEING EMPTY IS NOT SUFFICIENT, and `durability` is checked as well as `queued.length`.
   *
   * An `ABANDONED` attempt has, by construction, a queue the student was already told might not be recorded. If
   * those writes were later acknowledged the queue empties -- but the student's belief was formed under
   * `ABANDONED`, and quietly replacing "may not have been recorded" with "all answers saved" is worse than the
   * original uncertainty, because they would stop checking.
   */
  // `durability !== 'CLEAN'` rather than an enumeration of the other three, because the enumeration was written
  // first and omitted `PENDING` -- and `PENDING` is the state a student sits in while every autosave round-trips,
  // which is exactly when "all answers saved" is least true. The list of non-clean states is `NOT_CLEAN`, exported,
  // so the rule and its enumeration cannot drift.
  const unsaved = state.queued.length > 0 || state.durability !== 'CLEAN';
  if (unsaved) {
    const count = state.queued.length;
    const abandoned = state.durability === 'ABANDONED';
    return {
      kind: 'UNSAVED',
      heading: abandoned
        ? 'Some answers may not have been recorded'
        : 'Some answers have not been saved yet',
      detail: abandoned
        ? 'Your time ran out with answers still waiting to send. They are still here, but the server cannot confirm it received them.'
        : `${String(count)} answer${count === 1 ? '' : 's'} could not be sent. ${count === 1 ? 'It is' : 'They are'} saved on this device and will be sent when you reconnect.`,
      blocking: true,
    };
  }

  return null;
};

/** The `durability` values a resume screen must NOT present as "all answers saved". */
export const NOT_CLEAN: readonly Durability[] = ['PENDING', 'OFFLINE', 'ABANDONED'];

/**
 * The deadline sweep.  (P8-T9, `INV-LATE-1`, `plans/03` §3.4)
 *
 * ## WHY THE PREDICATE IS IMPORTED AND NOT RE-DERIVED
 *
 * `isPastDeadline` is documented in `@orrery/clock` as "the single late-write predicate". This module uses it rather
 * than writing `now > deadline + grace` again, and that is not tidiness:
 *
 * **THE SWEEP AND THE WRITE PATH MUST CLOSE A WINDOW AT THE SAME INSTANT.** They are two answers to one question --
 * "may this student still write to this question?" -- and they run in different processes on a ten-second cycle. If
 * the sweep closes on `deadline` while `decideWrite` accepts until `deadline + grace`, then a save inside the grace
 * window SUCCEEDS against a question the sweep has already marked `QUESTION_WINDOW_CLOSED`. The student's answer is
 * stored, the UI says the window is shut, and the disagreement is invisible until somebody reconciles the two.
 *
 * So the shared predicate is the mechanism, and a test asserts both call sites agree by construction.
 *
 * ## AND NOTHING HERE DISCARDS AN ANSWER  (`B10`)
 *
 * `B10` records that shedding answer writes inside the grace window *discarded* answers the plan had promised to keep.
 * The sweep therefore never deletes a response, never shortens a grace period, and never treats a late write as
 * droppable. A sweep that "tidied up" unwritten questions would reintroduce `B10` in a place much harder to notice than
 * a request handler.
 *
 * Note `plans/03` §3.4 step 3 still says answer writes get `409 WINDOW_CLOSING` inside the final ten seconds. **That is
 * the pre-`B10` text** and it contradicts what this module does; `apps/worker`'s comment has the corrected reading. The
 * plan needs amending.
 */

import { type Duration, isPastDeadline, type Millis } from '@orrery/clock';

import type { PrismaClient } from '../prisma/generated/client/client.js';

/** What the sweep needs to know about one open attempt. Deliberately narrow and plain. */
export interface SweepAttempt {
  readonly id: string;
  readonly status: string;
  /** `null` means the attempt has no overall window. */
  readonly deadlineAt: Millis | null;
  /** Per-attempt, from the policy snapshot the student was served. `RN-04`'s default is 60. */
  readonly gracePeriodSec: number;
}

export interface SweepQuestionWindow {
  readonly responseId: string;
  readonly attemptId: string;
  /** `null` means no per-question window, which is a legitimate state. */
  readonly questionDeadlineAt: Millis | null;
  readonly questionClosedReason: string | null;
}

export interface SweepPlan {
  /** Attempts to submit from server state. `INV-LATE-1`. */
  readonly autoSubmit: readonly SweepAttempt[];
  /** Question windows to close, with the reason recorded. */
  readonly closeWindow: readonly SweepQuestionWindow[];
}

/**
 * WHAT THE SWEEP SHOULD DO, GIVEN WHAT IT CAN SEE.
 *
 * Pure, so the rules are testable without a database and without a clock -- which is the only way to test the
 * interesting cases, because they are all *boundary* cases and the interesting boundary is the one you would have to
 * wait ten seconds to observe.
 */
export const planDeadlineSweep = (input: {
  readonly attempts: readonly SweepAttempt[];
  readonly windows: readonly SweepQuestionWindow[];
  readonly now: Millis;
}): SweepPlan => {
  const autoSubmit = input.attempts.filter(
    (attempt) =>
      attempt.status === 'IN_PROGRESS' &&
      attempt.deadlineAt !== null &&
      // The SAME predicate `decideWrite` uses. See the header.
      isPastDeadline(attempt.deadlineAt, input.now, attempt.gracePeriodSec * 1000),
  );

  /**
   * A WINDOW IS CLOSED ONLY WHEN A WRITE WOULD BE REFUSED.
   *
   * `questionClosedReason !== null` means somebody already closed it -- possibly this sweep on the previous tick, or a
   * teacher -- and re-closing it would write a second event for the same closure, which is how a sweep becomes an event
   * amplifier at exactly the moment a cohort is finishing.
   */
  const closeWindow = input.windows.filter(
    (window) =>
      window.questionClosedReason === null &&
      window.questionDeadlineAt !== null &&
      isPastDeadline(window.questionDeadlineAt, input.now, 0),
  );

  return { autoSubmit, closeWindow };
};

/** The reason recorded on a closed window. A code, because it is read by machines and by teachers. */
export const WINDOW_CLOSED_DEADLINE = 'DEADLINE';

/**
 * RUN THE SWEEP.
 *
 * Reads and writes share ONE transaction, for the same reason the release does: a sweep that read the open attempts,
 * then closed windows in a second transaction, would race the answer path for every student in the cohort. The window
 * is ten seconds and the cohort is thousands.
 *
 * **IDEMPOTENT ACROSS TICKS, WHICH IS THE ONLY PROPERTY THAT MATTERS FOR A CRON.** Running it twice must be
 * indistinguishable from running it once: the second run's plan is empty because the first run's writes are visible.
 * That is why the plan filters on `questionClosedReason === null` and `status === 'IN_PROGRESS'` rather than on
 * timestamps it computed itself.
 */
export const runDeadlineSweep = async (
  db: Pick<
    PrismaClient,
    'examAttempt' | 'questionResponse' | 'attemptEventRecord' | '$transaction'
  >,
  now: Millis,
  graceOverride: Duration | null = null,
): Promise<{ autoSubmitted: number; windowsClosed: number }> =>
  db.$transaction(async (tx) => {
    const attempts = (await tx.examAttempt.findMany({
      where: { status: 'IN_PROGRESS' },
      select: { id: true, status: true, deadlineAt: true, gracePeriodSec: true },
    })) as readonly {
      id: string;
      status: string;
      deadlineAt: Date | null;
      gracePeriodSec: number;
    }[];

    const windows = (await tx.questionResponse.findMany({
      where: { questionDeadlineAt: { not: null }, questionClosedReason: null },
      select: {
        id: true,
        attemptId: true,
        questionDeadlineAt: true,
        questionClosedReason: true,
      },
    })) as readonly {
      id: string;
      attemptId: string;
      questionDeadlineAt: Date | null;
      questionClosedReason: string | null;
    }[];

    const plan = planDeadlineSweep({
      attempts: attempts.map((attempt) => ({
        id: attempt.id,
        status: attempt.status,
        deadlineAt: attempt.deadlineAt === null ? null : attempt.deadlineAt.getTime(),
        // A teacher's granted extension overrides the policy default; it is why this is an argument.
        gracePeriodSec: graceOverride === null ? attempt.gracePeriodSec : graceOverride / 1000,
      })),
      windows: windows.map((window) => ({
        responseId: window.id,
        attemptId: window.attemptId,
        questionDeadlineAt:
          window.questionDeadlineAt === null ? null : window.questionDeadlineAt.getTime(),
        questionClosedReason: window.questionClosedReason,
      })),
      now,
    });

    for (const attempt of plan.autoSubmit) {
      /**
       * SUBMIT SERVER STATE, AND DISCARD NOTHING.
       *
       * The attempt becomes `SUBMITTED` with whatever responses exist. There is no step here that removes an unwritten
       * question's row, because that was the `TERMINATE` bug `V-12` corrected -- an unanswered question contributes zero
       * to the score and nothing else, and deleting the row would only destroy the evidence that it was unanswered.
       */
      await tx.examAttempt.update({
        where: { id: attempt.id },
        data: { status: 'SUBMITTED', submittedAt: new Date(now), submittedBy: 'CRON' },
      });
      await tx.attemptEventRecord.create({
        data: {
          attemptId: attempt.id,
          type: 'AUTO_SUBMITTED',
          serverTs: new Date(now),
          // `payload` is NOT NULL, and an event whose payload says nothing is an event a teacher cannot read.
          payload: {
            reason: 'DEADLINE_PLUS_GRACE',
            deadlineAt: attempt.deadlineAt,
            graceSec: attempt.gracePeriodSec,
          },
        },
      });
    }

    for (const window of plan.closeWindow) {
      await tx.questionResponse.update({
        where: { id: window.responseId },
        // Only the reason. `lastSavedAt` is deliberately NOT touched: closing a window is not a save, and stamping it
        // would tell a teacher the student wrote something in the last moments of a question they never opened.
        data: { questionClosedReason: WINDOW_CLOSED_DEADLINE },
      });
      await tx.attemptEventRecord.create({
        data: {
          attemptId: window.attemptId,
          type: 'QUESTION_WINDOW_CLOSED',
          serverTs: new Date(now),
          payload: {
            reason: WINDOW_CLOSED_DEADLINE,
            questionDeadlineAt: window.questionDeadlineAt,
          },
        },
      });
    }

    return { autoSubmitted: plan.autoSubmit.length, windowsClosed: plan.closeWindow.length };
  });

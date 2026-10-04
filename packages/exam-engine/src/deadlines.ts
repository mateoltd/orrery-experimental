/**
 * `@orrery/exam-engine` -- deadline evaluation for a running attempt.  (P8-T2)
 *
 * ## WHAT IS NEW HERE GIVEN `contracts/src/policy/deadline.ts` ALREADY EXISTS
 *
 * That module computes deadlines and evaluates a single write against them. What it cannot do is evaluate a whole
 * attempt at a point in time -- which is what a countdown, a recovery overlay, and a teacher's timeline all need, and
 * all three need it identically.
 *
 * `evaluateAttempt` is that: the policy snapshot plus the attempt's own facts plus an instant produces the state of
 * every question at once, with the instruction the policy implies. It is the thing three callers would otherwise each
 * write slightly differently.
 *
 * ## IT READS A FROZEN SNAPSHOT, NEVER A LIVE POLICY
 *
 * INV-POLICY-1: the snapshot never changes once the attempt exists. The type here takes `ExamPolicy`, which
 * `freezePolicy` has already frozen, and nothing in this module writes to it. Extensions arrive as additive rows and
 * are passed in as `extraMs` rather than being folded into a deadline here, because a deadline that absorbs an extension
 * in place is the C14 bug.
 */

import type { Duration, Millis } from '@orrery/clock';
import type { ExamPolicy } from '@orrery/contracts/policy';
import { expiryVerdict } from '@orrery/contracts/policy/deadline';

/** What a question is doing right now. */
export type QuestionState =
  /** Open and answerable. */
  | 'OPEN'
  /** Its window closed under `SOFT`: still editable, but the late flag will be set on the next write. */
  | 'SOFT_EXPIRED'
  /** Its window closed under `LOCK`: frozen, and the last accepted answer stands. */
  | 'LOCKED'
  /** Its window closed under `AUTO_SUBMIT`: frozen and the attempt is finished. */
  | 'AUTO_SUBMITTED'
  /** The whole attempt is over, whatever this question's own window says. */
  | 'ATTEMPT_CLOSED';

export interface QuestionFacts {
  readonly questionId: string;
  /** When this question's own window closes, or `null` for none. */
  readonly deadlineAt: Millis | null;
  /** The client's recorded answer, for the overlay's "you answered this" state. `undefined` means never touched. */
  readonly answeredAt?: Millis;
  readonly isExcused?: boolean;
}

export interface AttemptFacts {
  readonly attemptId: string;
  readonly status: string;
  /** The whole attempt's deadline, extensions already applied by the caller. `null` for untimed. */
  readonly deadlineAt: Millis | null;
  readonly questions: readonly QuestionFacts[];
}

export interface QuestionVerdict {
  readonly questionId: string;
  readonly state: QuestionState;
  /** `null` when the question is untimed or already closed. Never negative: a countdown shows 0:00, not -0:01. */
  readonly remainingMs: Duration;
  /** True when a write now would be recorded late. Distinct from "closed": `SOFT_EXPIRED` is still writable. */
  readonly isLate: boolean;
  /**
   * MAY A WRITE TO THIS QUESTION LAND RIGHT NOW? The same question `packages/db`'s `decideWrite` and `apps/web`'s
   * `canAnswer` ask, answered here by `expiryVerdict` so the three cannot drift.
   *
   * It exists as a field because deriving it from `state` is what hid the original defect: `SOFT_EXPIRED` reads as
   * expired, so nobody checked that the write path disagreed with it.
   */
  readonly writable: boolean;
  readonly isAnswered: boolean;
  readonly isExcused: boolean;
}

export interface AttemptVerdict {
  readonly attemptId: string;
  readonly isOpen: boolean;
  /** True once no further write can be accepted, whatever the reason. */
  readonly isClosed: boolean;
  /** Millis until the attempt closes, `0` once it has, `null` when untimed. */
  readonly remainingMs: Duration | null;
  /** Per-question states, in the order given. */
  readonly questions: readonly QuestionVerdict[];
  /** The first question the student should be shown, or `null` when there is nothing left to do. */
  readonly nextQuestionId: string | null;
}

/**
 * THE POLICY'S EXPIRY TERM BECOMES A STATE, AND THEY ARE NOT THE SAME WORDS ON PURPOSE.
 *
 * `ExamPolicy.perQuestionExpiry` is `SOFT | LOCK | AUTO_SUBMIT` -- those are the three things a TEACHER configures.
 * `QuestionState` is `OPEN | SOFT_EXPIRED | LOCKED | AUTO_SUBMITTED | ATTEMPT_CLOSED` -- those are the five things a
 * CLIENT has to do about. `SOFT_EXPIRED` rather than `SOFT` because the distinction the client cares about is not which
 * term was configured but whether a write is still accepted, and only one of the three names says that.
 *
 * So the mapping is explicit. Assigning the policy value straight through -- which is what the first version did -- puts
 * a configuration term in a field typed as a behaviour, and the two vocabularies then have to be kept in step forever.
 */
const expiredState = (expiry: 'SOFT' | 'LOCK' | 'AUTO_SUBMIT'): QuestionState => {
  if (expiry === 'SOFT') return 'SOFT_EXPIRED';
  if (expiry === 'LOCK') return 'LOCKED';
  return 'AUTO_SUBMITTED';
};

/** Remaining time, clamped at zero. A countdown that renders a negative number is worse than one that reads 0:00. */
const remaining = (deadlineAt: Millis | null, now: Millis): Duration =>
  deadlineAt === null ? 0 : Math.max(0, deadlineAt - now);

/**
 * EVALUATE AN ATTEMPT AT AN INSTANT.
 *
 * `now` is passed in rather than read, so the whole thing is pure and a countdown can be evaluated against a
 * projected instant without pretending the clock moved (INV-TIME-1 would catch a read here anyway).
 */
export function evaluateAttempt(
  policy: ExamPolicy,
  attempt: AttemptFacts,
  now: Millis,
  graceMs: Duration = 0,
): AttemptVerdict {
  const attemptClosed = attempt.status !== 'IN_PROGRESS';
  const attemptPastDeadline = attempt.deadlineAt !== null && now > attempt.deadlineAt + graceMs;

  const questions: QuestionVerdict[] = attempt.questions.map((question) => {
    const isExcused = question.isExcused ?? false;
    const isAnswered = question.answeredAt !== undefined;
    const left = remaining(question.deadlineAt, now);
    const questionPastDeadline =
      question.deadlineAt !== null && now > question.deadlineAt + graceMs;

    /**
     * THE ORDER OF THESE CHECKS IS THE SPECIFICATION.
     *
     * Attempt closure is checked before the question's own window, because a submitted attempt reporting "time is up
     * for question 4" is both wrong and alarming -- the real reason is that the exam is finished.
     *
     * An EXCUSED question is closed regardless. It is not on the paper to be answered, and leaving it `OPEN` would
     * put it in `nextQuestionId` and send the student to a question that cannot be submitted.
     */
    let state: QuestionState;
    if (attemptClosed) {
      state = 'ATTEMPT_CLOSED';
    } else if (isExcused) {
      state = 'LOCKED';
    } else if (attemptPastDeadline) {
      state = 'ATTEMPT_CLOSED';
    } else if (!questionPastDeadline) {
      state = 'OPEN';
    } else {
      state = expiredState(policy.perQuestionExpiry);
    }

    /**
     * WRITABILITY AND `isLate` COME FROM `expiryVerdict`, NOT FROM A THIRD LOCAL RULE.
     *
     * They used to be derived here from `expiredState(...)` and an inline comparison, which made this module the
     * one implementation that honoured `SOFT` while `packages/db`'s `decideWrite` and `apps/web`'s `canAnswer`
     * refused it -- so the engine reported a question as `SOFT_EXPIRED` and writable while the write path rejected
     * every save to it. The three now ask one function.
     *
     * `expiredState` is still what maps the policy's term to this module's richer vocabulary, and the verdict is
     * what decides whether a write can land: the two answers are different questions, and the engine needs both.
     * `attemptPastDeadline` is excluded from the verdict's inputs because `attemptClosed`/`attemptPastDeadline` have
     * already produced `ATTEMPT_CLOSED` above and folding it in again would report the same fact twice.
     */
    const verdict = expiryVerdict(policy, {
      questionDeadlineAt: question.deadlineAt,
      deadlineAt: attemptPastDeadline ? null : attempt.deadlineAt,
      now,
      graceMs,
    });
    const isLate = state === 'SOFT_EXPIRED' ? true : verdict.isLate;

    return {
      questionId: question.questionId,
      state,
      /**
       * EXPLICIT, so agreement with the write path is ASSERTABLE rather than inferred from the state name.
       *
       * A consumer asking "may I save to this?" previously had to reconstruct it from `state`, which is how the
       * disagreement stayed invisible: `SOFT_EXPIRED` reads as expired, so nobody checked whether it was still
       * writable. It is the field the cross-module matrix test walks.
       */
      writable: verdict.writable && !attemptClosed && !isExcused,
      remainingMs: state === 'OPEN' ? left : 0,
      isLate,
      isAnswered,
      isExcused,
    };
  });

  const autoSubmitted = questions.some((question) => question.state === 'AUTO_SUBMITTED');

  /**
   * AND IT IS APPLIED BACK TO THE OTHER QUESTIONS, in a SECOND PASS.
   *
   * The first pass cannot know this: it decides each question from that question's own window and the attempt's, and
   * the attempt's is still open while the map runs. So a question comfortably inside its own window stays `OPEN`, which
   * would tell the student it is answerable on an exam that has already been submitted. The attempt-level fact has to
   * be written back down after it is known.
   */
  const settled: QuestionVerdict[] = autoSubmitted
    ? questions.map((question) =>
        question.state === 'AUTO_SUBMITTED' || question.isExcused
          ? question
          : { ...question, state: 'ATTEMPT_CLOSED' as const, remainingMs: 0 },
      )
    : questions;

  /**
   * `nextQuestionId` IS THE FIRST UNANSWERED, OPEN, UNEXCUSED QUESTION.
   *
   * Answered questions are skipped rather than revisited, because `ONE_AT_A_TIME` navigation advances on submission and
   * a student returning to the exam should land where they left off, not at question 1. When everything still open has
   * been answered the first open question is offered instead, so a student can review.
   *
   * Computed from `settled`, not from `questions`: after an `AUTO_SUBMIT` every question is closed, and a `next` read
   * from the pre-submission states would point the student straight into a question on a submitted exam.
   */
  const next =
    settled.find(
      (question) => question.state === 'OPEN' && !question.isAnswered && !question.isExcused,
    ) ??
    settled.find((question) => question.state === 'OPEN' && !question.isExcused) ??
    null;

  return {
    attemptId: attempt.attemptId,
    isOpen: !attemptClosed && !attemptPastDeadline && !autoSubmitted,
    isClosed: attemptClosed || attemptPastDeadline || autoSubmitted,
    remainingMs: attempt.deadlineAt === null ? null : remaining(attempt.deadlineAt, now),
    questions: settled,
    nextQuestionId: next?.questionId ?? null,
  };
}

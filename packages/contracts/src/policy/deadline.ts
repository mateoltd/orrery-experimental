/**
 * The deadline arithmetic and the write-acceptance predicate.  (P7-T8)
 *
 * ## EVERY FUNCTION HERE TAKES `now` AS AN ARGUMENT AND CALLS NO CLOCK
 *
 * `plans/07` forbids `Date.now()` outside `@orrery/clock`, and this is the module where that rule earns its keep:
 * a deadline test that read the wall clock would be a test that passes in February and fails in August. Every
 * function is pure in `now`, which is also what makes the property tests in P7-T13 possible at all.
 *
 * ## AND THE CENTRAL RULE IS THAT A LATE ANSWER IS **REJECTED**, NOT ZEROED
 *
 * `INV-LATE-1`: "Answers written after their window are **rejected and the last accepted value retained** — they
 * are not silently accepted and not silently zeroed."
 *
 * Both alternatives are worse than rejection and the reasons are worth stating, because rejection looks harsh:
 *
 * - Accepting it means a student whose device clock drifted can submit after their paper closed and be believed.
 * - Zeroing it means a network retry that lands a second late destroys an answer the student gave on time. The
 *   first accepted value is the student's work; a later write is a duplicate, not a revision.
 *
 * So acceptance is decided on `expectedRevision` and `idempotencyKey` as well as on time, and a rejection says
 * which of the three conditions failed rather than only that it did.
 */

import type { ExamPolicy } from './index.js';

/** An ISO-8601 instant. */
export type Instant = string;

/** Milliseconds, from a caller-supplied `now`. */
export type Millis = number;

/** `attempt.startedAt` is the FIRST ACCEPTED START, not the moment the page loaded. */
export const attemptDeadlineAt = (
  policy: Pick<ExamPolicy, 'totalTimeLimitSec' | 'gracePeriodSec'>,
  startedAt: Millis,
): Millis | null =>
  policy.totalTimeLimitSec === null ? null : startedAt + policy.totalTimeLimitSec * 1000;

/**
 * THE DEADLINE A STUDENT'S ANSWER IS JUDGED AGAINST, WHICH INCLUDES THE GRACE.
 *
 * Kept separate from `attemptDeadlineAt` because the two answer different questions and conflating them is how a
 * countdown ends 60 seconds before the paper does. The stored `deadlineAt` is what the UI counts down to; the
 * write is accepted until `deadlineAt + grace`.
 */
export const writeDeadlineAt = (
  policy: Pick<ExamPolicy, 'totalTimeLimitSec' | 'gracePeriodSec'>,
  startedAt: Millis,
): Millis | null => {
  const deadline = attemptDeadlineAt(policy, startedAt);
  return deadline === null ? null : deadline + policy.gracePeriodSec * 1000;
};

/**
 * THE PER-QUESTION CLOCK STARTS ON THE FIRST ACCEPTED INTERACTION, NOT ON FIRST VIEW.
 *
 * `plans/01` §9.1: "per question, on the first ACCEPTED interaction: `questionOpenedAt = serverNow` (immutable
 * once set)". Two consequences, both deliberate:
 *
 * A question the student scrolled past and came back to does not restart its clock, because the opening is
 * immutable once set — otherwise a student could refresh until the timer reset.
 *
 * And a question never interacted with has NO deadline at all, so an unsubmitted question cannot expire. That is
 * why `questionDeadlineAt` is derived from an optional `openedAt` rather than from the attempt start.
 */
export const questionDeadlineAt = (
  policy: Pick<ExamPolicy, 'perQuestionTimeLimitSec'>,
  openedAt: Millis | null,
): Millis | null =>
  policy.perQuestionTimeLimitSec === null || openedAt === null
    ? null
    : openedAt + policy.perQuestionTimeLimitSec * 1000;

/** Whether an attempt may be STARTED at all: the admission window, which is separate from every deadline. */
export const mayStart = (
  policy: Pick<ExamPolicy, 'availabilityWindow'>,
  now: Millis,
): { allowed: boolean; reason?: 'BEFORE_WINDOW' | 'AFTER_WINDOW' } => {
  const window = policy.availabilityWindow;
  if (window === null) return { allowed: true };
  if (window.from !== null && now < Date.parse(window.from))
    return { allowed: false, reason: 'BEFORE_WINDOW' };
  if (window.until !== null && now > Date.parse(window.until))
    return { allowed: false, reason: 'AFTER_WINDOW' };
  return { allowed: true };
};

/** Why a write was refused. Three causes, and the caller needs to know which. */
export type RefusalReason =
  | 'ATTEMPT_NOT_IN_PROGRESS'
  | 'QUESTION_DEADLINE_PASSED'
  | 'ATTEMPT_DEADLINE_PASSED'
  | 'REVISION_MISMATCH'
  | 'DUPLICATE_IDEMPOTENCY_KEY';

/**
 * WHAT A WRITE REQUEST CARRIES, AS THE SERVER HAS IT.
 *
 * `expectedRevision` is the revision the CLIENT believes it is editing. `idempotencyKey` is the client's uuid for
 * this write. Both are needed and neither substitutes for the other: a retry carries the same key with a stale
 * revision, and a second tab carries a different key with a stale revision, and the two must resolve differently.
 */
export interface WriteRequest {
  readonly attemptStatus: 'NOT_STARTED' | 'IN_PROGRESS' | 'SUBMITTED' | 'GRADED' | 'EXPIRED';
  /** The attempt's hard deadline, or `null` when untimed. */
  readonly deadlineAt: Millis | null;
  /** This question's deadline, or `null` when untimed or never opened. */
  readonly questionDeadlineAt: Millis | null;
  /** The revision the client says it is editing. */
  readonly expectedRevision: number;
  /** The revision the server currently holds. */
  readonly serverRevision: number;
  /** Whether this `idempotencyKey` has already been accepted. */
  readonly idempotencyKeySeen: boolean;
}

export type WriteDecision =
  | { readonly accept: true; readonly idempotent: boolean }
  | { readonly accept: false; readonly reason: RefusalReason };

/**
 * ACCEPTANCE, EVALUATED ENTIRELY SERVER-SIDE.  (`plans/01` §9.1, verbatim structure)
 *
 * ```
 * accept iff  attempt.status == IN_PROGRESS
 *        and  (questionDeadlineAt == null or now <= questionDeadlineAt + grace)
 *        and  (deadlineAt        == null or now <= deadlineAt        + grace)
 *        and  response.revision == expectedRevision      (else 409 with the server copy)
 *        and  idempotencyKey is new                      (else idempotent success)
 * ```
 *
 * ## THE ORDER MATTERS AND IT IS NOT THE ORDER OF THE CONJUNCTION
 *
 * `idempotencyKeySeen` is checked FIRST, before the attempt status and before either deadline. A retry of a write
 * that was already accepted must succeed whatever has happened to the attempt since — including the attempt
 * having been submitted, which is the normal case, because a client that submits and then retries the last save
 * would otherwise get a refusal for work the server already has.
 *
 * Then the revision, and then the deadlines -- attempt before question, because the attempt deadline is the
 * one that ends the paper. Revision before time because a stale revision's answer is wrong regardless of when
 * it arrives, and telling a student their paper is closed when the real problem is that another tab holds the
 * question is the more misleading of the two messages.
 *
 * ## AND `<=`, NOT `<`
 *
 * The deadline is inclusive to the millisecond. An exclusive comparison makes the last millisecond of every
 * attempt a refusal, which is a bug that only appears under load and only for the students who submit latest.
 */
export const evaluateWrite = (
  policy: Pick<ExamPolicy, 'gracePeriodSec'>,
  request: WriteRequest,
  now: Millis,
): WriteDecision => {
  const graceMs = policy.gracePeriodSec * 1000;

  // A duplicate key is an idempotent SUCCESS, not a refusal, and it is checked before everything else.
  if (request.idempotencyKeySeen) return { accept: true, idempotent: true };

  if (request.attemptStatus !== 'IN_PROGRESS')
    return { accept: false, reason: 'ATTEMPT_NOT_IN_PROGRESS' };

  if (request.expectedRevision !== request.serverRevision) {
    return { accept: false, reason: 'REVISION_MISMATCH' };
  }

  /**
   * THE ATTEMPT DEADLINE IS CHECKED FIRST, and the order is the message.
   *
   * When both have passed, the attempt deadline is the one that ended the paper. Reporting
   * `QUESTION_DEADLINE_PASSED` would send a student to fix one question when their whole attempt is closed --
   * and the fix they would attempt, re-answering a question, cannot work.
   */
  if (request.deadlineAt !== null && now > request.deadlineAt + graceMs) {
    return { accept: false, reason: 'ATTEMPT_DEADLINE_PASSED' };
  }

  if (request.questionDeadlineAt !== null && now > request.questionDeadlineAt + graceMs) {
    return { accept: false, reason: 'QUESTION_DEADLINE_PASSED' };
  }

  return { accept: true, idempotent: false };
};

/**
 * WHAT HAPPENS TO AN ANSWER AT ITS QUESTION DEADLINE.  (`plans/01` §9.4)
 *
 * `SOFT` logs and leaves it editable until the OVERALL deadline. `LOCK` freezes it. `AUTO_SUBMIT` freezes it and
 * marks the question final.
 *
 * ## THE CITATION WAS §9.1 AND THAT IS PART OF THE DEFECT
 *
 * These three terms are defined in `plans/01` **§9.4**. §9.1 is the write-acceptance formula, and it reads
 * ```
 * accept iff ... and (questionDeadlineAt == null or now <= questionDeadlineAt + grace)
 * ```
 * with no mention of `perQuestionExpiry` whatsoever. **The plan contradicts itself in two adjacent sections**, and
 * the code implemented §9.1 -- twice, on the server and on the client -- while `expiryInstruction` implemented §9.4
 * and had no callers. So the disagreement was not only between modules; §9.1 is the sentence a reader would quote
 * to justify the current code, which is exactly why it is recorded here rather than quietly fixed.
 *
 * §9.4 is the one this module follows, for a reason that is not only precedence: under §9.1's literal reading,
 * `SOFT` and `LOCK` are the *same* configuration differing by a log line, and a policy with two names for one
 * behaviour is a policy whose terms have stopped carrying information.
 *
 * The three differ only in what a student may do next, so this returns the instruction rather than performing it:
 * freezing an answer is a write to the response row, and doing that from a pure function would make the policy
 * module responsible for persistence.
 */
export const expiryInstruction = (
  policy: Pick<ExamPolicy, 'perQuestionExpiry' | 'perQuestionTimeLimitSec'>,
): ExpiryInstruction => {
  if (policy.perQuestionTimeLimitSec === null) return 'NONE';
  switch (policy.perQuestionExpiry) {
    case 'SOFT':
      return 'LOG_ONLY';
    case 'LOCK':
      return 'FREEZE';
    case 'AUTO_SUBMIT':
      return 'FREEZE_AND_FINALISE';
    default:
      return 'NONE';
  }
};

/** The four things a teacher can configure a question's expiry to DO. See `expiryInstruction`. */
export type ExpiryInstruction = 'NONE' | 'LOG_ONLY' | 'FREEZE' | 'FREEZE_AND_FINALISE';

/** The result of asking the one question three modules were each answering separately. */
export interface ExpiryVerdict {
  /** May a write to this question land at this instant? */
  readonly writable: boolean;
  /** The write lands, but outside the question's own window. Recorded on the response; it is not a refusal. */
  readonly isLate: boolean;
  /** Why not, when it is not. `null` when the write is admissible. */
  readonly refusedBecause: 'QUESTION_LOCKED' | 'ATTEMPT_DEADLINE_PASSED' | null;
}

/**
 * THE SINGLE ANSWER TO "MAY THIS STUDENT STILL WRITE TO THIS QUESTION?", AND WHY IT HAD TO BECOME ONE.
 *
 * ## THE DEFECT THIS EXISTS TO CLOSE
 *
 * `expiryInstruction` above is `plans/01` §9.4's own vocabulary -- `SOFT` "logs and leaves it editable until the
 * OVERALL deadline", `LOCK` freezes, `AUTO_SUBMIT` freezes and finalises -- and until this commit **nothing outside
 * this module's own tests ever called it**. So the term a teacher picks had no effect on the write path at all,
 * and three separate implementations answered the question:
 *
 * | Where | What it did with a passed question window |
 * |---|---|
 * | `packages/db` `decideWrite` | refused, for every term including `SOFT` |
 * | `apps/web` `canAnswer` | refused, for every term including `SOFT` |
 * | `@orrery/exam-engine` `evaluateAttempt` | `SOFT_EXPIRED` and **writable**, flagged late |
 *
 * Two of the three therefore disagreed with the third, and the pair that agreed with each other were both wrong
 * against the plan: a teacher who chose `SOFT` got `LOCK` behaviour, and `SOFT` and `LOCK` became the same
 * configuration differing only by a log line -- which is the surest sign a policy term has stopped meaning anything.
 *
 * **THE STUDENT-VISIBLE CONSEQUENCE IS SILENCE, WHICH IS THE PART THAT MATTERS.** `canAnswer` refusing means the
 * reducer's `ANSWER` case returns the state unchanged: no queued write, no revision bump, no error, nothing on
 * screen. A student typing into a `SOFT`-expiry question past its window watched their keystrokes go nowhere and had
 * no way to learn that. `canAnswer`'s own comment claims the opposite requirement -- "the client must not be
 * stricter than the server, or a student loses an answer the server would have taken" -- and the code did exactly
 * that, while looking like it was honouring it.
 *
 * ## WHY IT LIVES HERE AND NOT IN `@orrery/clock`
 *
 * Because the answer needs `perQuestionExpiry`, which is policy, not time. `isPastDeadline` is the one predicate
 * for "past a deadline plus grace" and both windows are asked through it, so the boundary cannot drift; what to do
 * once a boundary has been crossed is a policy question and belongs beside the other policy decisions.
 *
 * ## `SOFT` IS ADMITTED **UP TO THE ATTEMPT WINDOW, NOT UNBOUNDEDLY**
 *
 * "Editable until the overall deadline" is not "editable after it". `INV-LATE-1` still governs the attempt
 * deadline, so a `SOFT` answer written inside the attempt's grace window is accepted-and-flagged rather than
 * refused. Widening a per-question relaxation until it swallowed `INV-LATE-1` would fix one defect by creating a
 * worse one.
 */
export const expiryVerdict = (
  policy: Pick<ExamPolicy, 'perQuestionExpiry' | 'perQuestionTimeLimitSec'>,
  windows: {
    /** `null` means this question has no window of its own. */
    readonly questionDeadlineAt: Millis | null;
    /** `null` means the paper is untimed. */
    readonly deadlineAt: Millis | null;
    readonly now: Millis;
    readonly graceMs: number;
  },
): ExpiryVerdict => {
  const { questionDeadlineAt, deadlineAt, now, graceMs } = windows;
  const past = (deadline: Millis): boolean => now > deadline + graceMs;
  /**
   * "PAST THE BARE DEADLINE" IS A DIFFERENT QUESTION FROM "PAST THE DEADLINE PLUS GRACE", and conflating them loses
   * the `isLate` flag.
   *
   * A write 40 seconds past a deadline with 60 seconds of grace is ACCEPTED and LATE, and both facts matter: the
   * answer stands, and the lateness is recorded for the receipt and the late-save audit. Asking only the
   * grace-inclusive question would report such a write as perfectly on time, which is the one thing the flag
   * exists to prevent.
   */
  const pastBare = (deadline: Millis): boolean => now > deadline;
  const pastItsOwnWindow = questionDeadlineAt !== null && past(questionDeadlineAt);
  const pastThePaper = deadlineAt !== null && past(deadlineAt);
  const late =
    (questionDeadlineAt !== null && pastBare(questionDeadlineAt)) ||
    (deadlineAt !== null && pastBare(deadlineAt));

  /**
   * THE PAPER IS CHECKED FIRST, and the reason is the message rather than the arithmetic.
   *
   * When both have passed, `ATTEMPT_DEADLINE_PASSED` is the fact the student can act on; "your question's time is
   * up" sends them to a question that cannot be saved anywhere, which is a worse answer than a truer one. This is
   * the same ordering `decideWrite` already documented for its own clause pair, kept deliberately identical so the
   * two cannot be read as two rules.
   */
  if (pastThePaper) {
    return { writable: false, isLate: false, refusedBecause: 'ATTEMPT_DEADLINE_PASSED' };
  }

  if (!pastItsOwnWindow) {
    return { writable: true, isLate: late, refusedBecause: null };
  }

  // Past the question's own window: only `LOG_ONLY` -- that is, `SOFT` -- still admits a write.
  if (expiryInstruction(policy) === 'LOG_ONLY') {
    return { writable: true, isLate: true, refusedBecause: null };
  }

  return { writable: false, isLate: false, refusedBecause: 'QUESTION_LOCKED' };
};

/**
 * THE COUNTDOWN A CLIENT SHOULD DISPLAY, AND WHY IT IS NOT `deadlineAt`.
 *
 * `plans/01` §9.2: the client receives `serverNow` and computes an offset from the RTT midpoint. This function
 * takes that already-corrected `now` and returns the number of milliseconds left, floored at zero.
 *
 * A negative number is clamped rather than returned, because the alternative is a countdown reading `-0.4s` in a
 * student's browser, and a clamped zero plus the server's own acceptance decision is the honest pair: the display
 * says "time is up" and the server decides whether the write lands.
 */
export const remainingMs = (deadlineAt: Millis | null, now: Millis): number =>
  deadlineAt === null ? Number.POSITIVE_INFINITY : Math.max(0, deadlineAt - now);

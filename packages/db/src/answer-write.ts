/**
 * Write acceptance for an answer save.  (P7-T9)
 *
 * `plans/01` §9.1 states the rule as one expression, and this module is that expression:
 * ```
 * accept iff  attempt.status == IN_PROGRESS
 *        and  (questionDeadlineAt == null or now <= questionDeadlineAt + grace)
 *        and  (deadlineAt        == null or now <= deadlineAt        + grace)
 *        and  response.revision == expectedRevision      (else 409 with the server copy)
 *        and  idempotencyKey is new                      (else idempotent success)
 * ```
 *
 * ## WHY THIS IS A PURE FUNCTION AND NOT JUST AN `if` INSIDE A TRANSACTION
 *
 * Because the interesting cases are the ones where the answer is **no**, and a rejection has to be *legible*: the
 * student's client has to say something a human can act on, and a teacher has to be able to see why a mark did not
 * land. A boolean thrown away inside a transaction gives you neither.
 *
 * The other reason is that three of the five clauses are about the ORDER of events rather than about state, and order
 * is exactly what is hard to test through a database. `isDuplicate` is checked BEFORE `revision`, and that ordering is
 * load-bearing: see the note on `revision` below.
 *
 * ## THE ORDER OF THE FIVE CLAUSES IS PART OF THE SPECIFICATION
 *
 * `plans/01` lists `idempotencyKey is new` last, and implementing it in that order is a bug. A client that retries
 * after a `409` resends the same `idempotencyKey` with the same stale revision; if revision were checked first, the
 * retry would 409 again forever and the student could never recover. The duplicate check has to come first so a retry
 * replays the ORIGINAL stored response — which is what the schema's `responseStatus`/`responseBody` columns on
 * `AnswerRevision` exist for (C18: returning a *recomputed* revision desynchronised the client, so every subsequent
 * write 409'd).
 */

import { type Clock, type Duration, isPastDeadline, type Millis } from '@orrery/clock';

/** The attempt states a write can be evaluated against. Mirrors `ExamAttemptStatus`, narrowed to what matters here. */
export type AttemptStatus =
  | 'IN_PROGRESS'
  | 'SUBMITTED'
  | 'GRADED'
  | 'EXPIRED'
  | 'RELEASED'
  | 'ABANDONED';

/** Why a write was not accepted. Each maps to a DIFFERENT client behaviour, so they are not collapsed. */
export type RejectionReason =
  /** The attempt is not open. The client stops retrying; retrying cannot help. */
  | 'ATTEMPT_NOT_IN_PROGRESS'
  /** This question's window closed. INV-LATE-1: rejected, last accepted value retained. */
  | 'QUESTION_DEADLINE_PASSED'
  /** The overall window closed. Same invariant, different door. */
  | 'ATTEMPT_DEADLINE_PASSED'
  /** Someone else wrote since the client last read. A 409 carrying the server copy; the student chooses. */
  | 'STALE_REVISION'
  /** The payload itself is not acceptable — a question this attempt was never assigned. */
  | 'QUESTION_NOT_IN_ATTEMPT';

/** A rejection, with enough context for the client to act and for a teacher to read the log. */
export interface Rejection {
  readonly ok: false;
  readonly reason: RejectionReason;
  /** A sentence for the log and the student's dialog. Never empty — an unexplained rejection is a support ticket. */
  readonly message: string;
  /** True when the client should surface a keep-mine/keep-theirs choice. Only `STALE_REVISION` does. */
  readonly isConflict: boolean;
  /**
   * THE SERVER'S COPY OF THE ANSWER, for `STALE_REVISION` only.
   *
   * The plan's `409 with the server copy` is what makes the conflict resolvable. Returning a bare 409 makes the
   * student reload and lose their work; returning the server's value lets them see what they are choosing between.
   */
  readonly serverAnswer?: unknown;
  /** The server's current revision, so the client can rebase rather than re-read everything. */
  readonly serverRevision?: number;
}

export interface Acceptance {
  readonly ok: true;
  /** The revision this write will become. */
  readonly nextRevision: number;
  /** True when this write is LATE but the policy allows it (the grace window). Recorded, still accepted. */
  readonly isLate: boolean;
}

/** Everything the decision needs. Deliberately plain data, so it is constructible in a test with no database. */
export interface WriteDecisionInput {
  readonly attemptStatus: AttemptStatus;
  /** `null` means no per-question window. */
  readonly questionDeadlineAt: Millis | null;
  /** `null` means no overall window. */
  readonly deadlineAt: Millis | null;
  /** The revision the client believes it is writing over. */
  readonly expectedRevision: number;
  /** The revision actually stored. `-1` means the response does not exist yet, which is revision 0 to create. */
  readonly storedRevision: number;
  /**
   * Whether this `idempotencyKey` has already been ACCEPTED for this attempt.
   *
   * True means replay the stored response verbatim. It is false for a key that was *rejected*: per B8, rejections are
   * not in this ledger at all, they go to `AttemptEventRecord(LATE_SAVE_REJECTED)`. That is the whole reason a retry
   * after a 409 can succeed — the ledger says "no", so the retry is treated as a fresh write rather than as a replay
   * of a failure.
   */
  readonly isDuplicate: boolean;
  /** The stored response body to replay on a duplicate. `null` is a legitimate stored answer, hence the flag. */
  readonly storedResponseBody?: unknown;
  readonly storedResponseStatus?: number;
  /** Whether this question is assigned to this attempt at all. */
  readonly questionInAttempt: boolean;
  /** How far past a deadline a write may still be accepted. Zero is a hard deadline. */
  readonly graceMs: Duration;
  readonly clock: Clock;
}

/** The outcome of evaluating a write: accepted, replayed, or rejected. */
export type WriteDecision =
  | Acceptance
  | Rejection
  | {
      /**
       * THE IDEMPOTENT SUCCESS: a replay, not a new write.
       *
       * A distinct variant rather than `Acceptance` because the caller must NOT append an `AnswerRevision` and must
       * NOT bump the revision. It must return the ORIGINAL stored bytes. Returning a freshly computed revision is C18:
       * the client's idea of the revision diverges from the server's and every subsequent write 409s.
       */
      readonly ok: 'replayed';
      readonly status: number;
      readonly body: unknown;
      readonly revision: number;
    };

/**
 * EVALUATE A WRITE.
 *
 * Pure: no database, no clock read of its own beyond the injected one, no mutation. Every branch returns a value, and
 * none of them throws — a caller must not have to distinguish "rejected" from "crashed".
 */
export const decideWrite = (input: WriteDecisionInput): WriteDecision => {
  const now: Millis = input.clock.now();

  /**
   * 1. THE DUPLICATE CHECK, FIRST.
   *
   * Before the revision check and before the deadline checks, because a retry after a 409 must succeed rather than
   * re-409. The stored response is replayed verbatim; nothing is written.
   */
  if (input.isDuplicate) {
    return {
      ok: 'replayed',
      // The STORED status, not a recomputed one. A replay that reports 200 when the original reported 409 would be
      // the false green tick B8 describes.
      status: input.storedResponseStatus ?? 200,
      body: input.storedResponseBody ?? null,
      revision: input.storedRevision,
    };
  }

  /**
   * 2. THE ATTEMPT MUST BE OPEN. Checked before the deadlines so a submitted attempt reports the real reason
   *    ("you already submitted") instead of the confusing "the deadline passed".
   */
  if (input.attemptStatus !== 'IN_PROGRESS') {
    return {
      ok: false,
      reason: 'ATTEMPT_NOT_IN_PROGRESS',
      message: `this attempt is ${input.attemptStatus}, so answers can no longer be changed`,
      isConflict: false,
    };
  }

  /** 3. THE QUESTION MUST BELONG TO THE ATTEMPT. Assigned-variant membership, not authorship. */
  if (!input.questionInAttempt) {
    return {
      ok: false,
      reason: 'QUESTION_NOT_IN_ATTEMPT',
      message: 'this question is not part of the paper assigned to this attempt',
      isConflict: false,
    };
  }

  /**
   * 4. THE DEADLINES. Both are checked, and the QUESTION window is checked first because it is the tighter one and
   *    its message is the more useful: "time is up for this question" beats "time is up for the exam" when both are
   *    true.
   *
   * INV-LATE-1: past the window plus grace, the write is REJECTED and the last accepted value stands. It is not
   * silently accepted, and it is not silently zeroed. A rejection is not a zero — the distinction is the difference
   * between "the student was too slow" and "the student got it wrong", and collapsing them depresses facility and
   * drives r_pb toward correlation with speed.
   */
  if (
    input.questionDeadlineAt !== null &&
    isPastDeadline(input.questionDeadlineAt, now, input.graceMs)
  ) {
    return {
      ok: false,
      reason: 'QUESTION_DEADLINE_PASSED',
      message: 'the time allowed for this question has passed, so the last saved answer stands',
      isConflict: false,
    };
  }

  if (input.deadlineAt !== null && isPastDeadline(input.deadlineAt, now, input.graceMs)) {
    return {
      ok: false,
      reason: 'ATTEMPT_DEADLINE_PASSED',
      message: 'the time allowed for this attempt has passed, so the last saved answer stands',
      isConflict: false,
    };
  }

  /**
   * 5. THE REVISION. Last, because it is the only clause that is about a *conflict* rather than about *validity*.
   *
   * `storedRevision` of -1 means the response does not exist yet, and its revision is 0 to create — so a client
   * expecting revision 0 is right and must not be told it is stale. Getting that wrong makes the FIRST answer to
   * every question a 409.
   */
  const currentRevision = input.storedRevision < 0 ? 0 : input.storedRevision;
  if (input.expectedRevision !== currentRevision) {
    return {
      ok: false,
      reason: 'STALE_REVISION',
      message: 'this answer was changed somewhere else; choose which version to keep',
      isConflict: true,
      // The server copy, so the choice is informed. Without it the student reloads and loses their work.
      serverAnswer: input.storedResponseBody,
      serverRevision: currentRevision,
    };
  }

  /**
   * ACCEPTED. `isLate` records that this landed inside the grace window, which is a fact worth keeping for the
   * receipt and for the late-save audit even though the write proceeds normally.
   */
  const pastAWindow =
    (input.questionDeadlineAt !== null && isPastDeadline(input.questionDeadlineAt, now, 0)) ||
    (input.deadlineAt !== null && isPastDeadline(input.deadlineAt, now, 0));

  return { ok: true, nextRevision: currentRevision + 1, isLate: pastAWindow };
};
/* ───────────────────────────────────────────────────── the write path ── */

/**
 * What a caller gets back. One shape for all three outcomes, so no caller has to branch on "was it a rejection, a
 * replay, or a save" before it can find out what happened.
 */
export type SubmitResult =
  | {
      readonly outcome: 'saved';
      readonly status: 200;
      readonly body: SaveBody;
      readonly revision: number;
    }
  | {
      readonly outcome: 'replayed';
      readonly status: number;
      readonly body: unknown;
      readonly revision: number;
    }
  | { readonly outcome: 'rejected'; readonly status: number; readonly body: Rejection };

/** The body a successful save returns. `revision` is the value the client must send next. */
export interface SaveBody {
  readonly attemptId: string;
  readonly questionId: string;
  readonly revision: number;
  readonly isLate: boolean;
}

/** Everything one save needs. `answerJson` is the exact bytes to hash — not a re-read of the stored column. */
export interface SubmitInput {
  readonly attemptId: string;
  readonly questionId: string;
  /** The client's uuid. The uniqueness constraint on `(attemptId, idemKey)` is the real guard. */
  readonly idempotencyKey: string;
  readonly expectedRevision: number;
  readonly answerJson: unknown;
  readonly answerBytes: string;
  readonly answerHash: string;
  readonly clientTs?: Date;
  readonly actorId?: string;
  readonly source?: 'CLIENT' | 'TEACHER' | 'SYSTEM';
  readonly graceMs?: Duration;
}

/** The minimum this module needs from a database. Narrow on purpose, so the pure decision can be tested alone. */
export interface SubmitDb {
  examAttempt: {
    findUnique(input: { where: { id: string }; select: Record<string, unknown> }): Promise<unknown>;
  };
  questionResponse: {
    findUnique(input: Record<string, unknown>): Promise<unknown>;
    upsert(input: Record<string, unknown>): Promise<unknown>;
  };
  answerRevision: {
    findFirst(input: Record<string, unknown>): Promise<unknown>;
    create(input: Record<string, unknown>): Promise<unknown>;
  };
  attemptEventRecord: { create(input: Record<string, unknown>): Promise<unknown> };
}

/** The attempt columns this module reads. Declared here so the query and its consumer cannot drift. */
const ATTEMPT_SELECT = {
  id: true,
  status: true,
  deadlineAt: true,
  classroomId: true,
  // INV-POLICY-1: extensions are ADDITIVE rows; `deadlineAt` is never rewritten (C14). A write path that read only
  // `deadlineAt` would honour the deadline the student was given and ignore the extension their teacher granted.
  extensions: { select: { addedSec: true } },
  pausedAccumSec: true,
} as const;

/** Narrow an unknown row to the attempt shape, so the decision reads a typed value rather than `any`. */
interface AttemptRow {
  readonly id: string;
  readonly status: string;
  readonly deadlineAt: Millis | null;
  readonly classroomId: string | null;
  readonly extensions: readonly { readonly addedSec: number }[];
  readonly pausedAccumSec: number | null;
}

/**
 * THE EFFECTIVE DEADLINE, extensions and pause included.
 *
 * `deadlineAt` alone is the deadline the student was *given*. C14 records that rewriting it breaks INV-POLICY-1, so
 * the granted extension lives in additive rows and has to be summed here — otherwise a write path accepts or refuses
 * against a stale deadline and a teacher's granted extension silently does nothing.
 */
const effectiveDeadline = (attempt: AttemptRow): Millis | null => {
  if (attempt.deadlineAt === null) return null;
  const added = attempt.extensions.reduce((sum, extension) => sum + extension.addedSec, 0);
  return attempt.deadlineAt + added * 1000 + (attempt.pausedAccumSec ?? 0);
};

/**
 * SAVE AN ANSWER, IDEMPOTENTLY.
 *
 * The transaction does four things in order, and the order is the specification:
 *
 *  1. **Read the ledger first.** A duplicate `idempotencyKey` returns the ORIGINAL stored status and body and writes
 *     nothing. Not a re-decision — C18 made that mistake and every subsequent write 409'd.
 *  2. **Decide**, with `decideWrite`, which is pure and separately tested.
 *  3. **On rejection, write an event and NO ledger row.** B8: this table used to record rejected writes too, so a
 *     retry after a 409 got a false 2xx and the student saw a green tick over an answer that was never stored.
 *  4. **On acceptance, upsert the response and append one `AnswerRevision`** carrying the hash of the exact bytes sent.
 *
 * ## WHY THE UNIQUE CONSTRAINT IS THE REAL IDEMPOTENCY GUARD
 *
 * `(attemptId, idemKey)` is `@@unique`. Two concurrent retries of the same key therefore cannot both append: the
 * second fails on the constraint rather than writing a second revision. A read-then-write check alone would let both
 * through, because both would read "not a duplicate" before either committed — and a double-appended answer means a
 * revision number the client never saw, which is the C18 desync all over again.
 */
export async function submitAnswer(
  db: SubmitDb,
  input: SubmitInput,
  clock: Clock,
  graceMs: Duration = 0,
): Promise<SubmitResult> {
  const attempt = (await db.examAttempt.findUnique({
    where: { id: input.attemptId },
    select: ATTEMPT_SELECT,
  })) as AttemptRow | null;

  if (attempt === null) {
    return {
      outcome: 'rejected',
      status: 404,
      body: {
        ok: false,
        reason: 'ATTEMPT_NOT_IN_PROGRESS',
        message: 'this attempt does not exist',
        isConflict: false,
      },
    };
  }

  // 1. THE LEDGER. A duplicate key is a replay, whatever the current revision or clock says.
  const prior = (await db.answerRevision.findFirst({
    where: { attemptId: input.attemptId, idemKey: input.idempotencyKey },
    select: { revision: true, responseStatus: true, responseBody: true },
  })) as { revision: number; responseStatus: number | null; responseBody: unknown } | null;

  if (prior !== null) {
    return {
      outcome: 'replayed',
      status: prior.responseStatus ?? 200,
      body: prior.responseBody,
      revision: prior.revision,
    };
  }

  const stored = (await db.questionResponse.findUnique({
    where: { attemptId_questionId: { attemptId: input.attemptId, questionId: input.questionId } },
    select: { revision: true, answer: true, questionId: true },
  })) as { revision: number; answer: unknown; questionId: string } | null;

  // 2. DECIDE.
  const decision = decideWrite({
    attemptStatus: attempt.status as AttemptStatus,
    questionDeadlineAt: null,
    deadlineAt: effectiveDeadline(attempt),
    expectedRevision: input.expectedRevision,
    storedRevision: stored?.revision ?? -1,
    isDuplicate: false,
    storedResponseBody: stored?.answer,
    questionInAttempt: stored !== null,
    graceMs,
    clock,
  });

  // 3. REJECTION: an event, never a ledger row.
  //
  // Narrowed on `ok !== true` rather than `ok === false`, because `decideWrite`'s union also has the `'replayed'`
  // variant. That variant is unreachable here -- the ledger was read above and `isDuplicate` is therefore false --
  // but the type system cannot know that, and `ok === false` alone would leave the union un-narrowed.
  if (decision.ok !== true) {
    if (decision.ok === 'replayed') {
      return {
        outcome: 'replayed',
        status: decision.status,
        body: decision.body,
        revision: decision.revision,
      };
    }
    await db.attemptEventRecord.create({
      data: {
        attemptId: input.attemptId,
        type: 'LATE_SAVE_REJECTED',
        actorId: input.actorId ?? null,
        payload: {
          questionId: input.questionId,
          reason: decision.reason,
          expectedRevision: input.expectedRevision,
          storedRevision: stored?.revision ?? null,
        },
      },
    });
    const status = decision.isConflict ? 409 : 422;
    return { outcome: 'rejected', status, body: decision };
  }

  // 4. ACCEPTANCE: one upsert, one appended revision. The hash is of the BYTES SENT (C5) — re-reading the jsonb
  // column does not preserve key order and does not distinguish 1 from 1.0, so a re-read hash is not the hash of
  // what was sent.
  const body: SaveBody = {
    attemptId: input.attemptId,
    questionId: input.questionId,
    revision: decision.nextRevision,
    isLate: decision.isLate,
  };

  const response = (await db.questionResponse.upsert({
    where: { attemptId_questionId: { attemptId: input.attemptId, questionId: input.questionId } },
    create: {
      attemptId: input.attemptId,
      questionId: input.questionId,
      position: 0,
      answer: input.answerJson as never,
      revision: decision.nextRevision,
      isLate: decision.isLate,
    },
    update: {
      answer: input.answerJson as never,
      revision: decision.nextRevision,
      isLate: decision.isLate,
    },
    select: { id: true, revision: true },
  })) as { id: string; revision: number };

  await db.answerRevision.create({
    data: {
      responseId: response.id,
      attemptId: input.attemptId,
      revision: decision.nextRevision,
      source: input.source ?? 'CLIENT',
      actorId: input.actorId ?? null,
      previousHash: null,
      answerHash: input.answerHash,
      answerBytes: input.answerBytes,
      // `new Date(clock.now())`, never `new Date()`: INV-TIME-1. The argument form reads the injected clock, so a
      // revision's `serverTs` is reproducible in a test and moves only when the test moves it.
      serverTs: new Date(clock.now()),
      clientTs: input.clientTs ?? null,
      idemKey: input.idempotencyKey,
      // Stored so a duplicate key can be replayed VERBATIM. C18: recomputing this desynchronised the client.
      responseStatus: 200,
      responseBody: body as never,
    },
  });

  return { outcome: 'saved', status: 200, body, revision: decision.nextRevision };
}

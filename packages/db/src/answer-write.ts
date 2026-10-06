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

import type { Clock, Duration, Millis } from '@orrery/clock';
import { expiryVerdict } from '@orrery/contracts/policy/deadline';

import type { PrismaClient } from '../prisma/generated/client/client.js';

/** The attempt states a write can be evaluated against. Mirrors `ExamAttemptStatus`, narrowed to what matters here. */
export type AttemptStatus =
  | 'IN_PROGRESS'
  | 'SUBMITTED'
  | 'GRADED'
  | 'EXPIRED'
  | 'RELEASED'
  | 'ABANDONED';

/** Why a write was not accepted. Each maps to a DIFFERENT client behaviour, so they are not collapsed. */
/**
 * B15: 64 KiB per answer, enforced where the write is decided -- not at the route, which a direct
 * caller bypasses, and not in the database, where it arrives as a failed upsert with no reason.
 * Sim states ride inside the answer JSON (`{ simState, answer }`, per `paper.ts:141-146`), so the
 * cap covers them too; oversize states refuse rather than overflow to S3, because there is no S3
 * (D-36), and a refusal states its limit where an overflow would silently depend on infrastructure
 * nobody has.
 */
export const MAX_ANSWER_BYTES = 65536;

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
  | 'QUESTION_NOT_IN_ATTEMPT'
  /** The answer exceeds `MAX_ANSWER_BYTES`. Retrying the same bytes cannot help; send less. */
  | 'ANSWER_TOO_LARGE'
  /** A sim-shaped answer whose `simState` is not an object. Stored answers must match what
   * `grading-replay` reads, and a non-object simState is silent corruption of the replay input. */
  | 'MALFORMED_SIM_STATE';

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
  /** `null` means no overall window. MILLIS, because `decideWrite` is pure and knows nothing of Prisma. */
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
  /**
   * THE PER-QUESTION EXPIRY TERM, FROM THE ATTEMPT'S FROZEN SNAPSHOT.
   *
   * INV-POLICY-1 makes `policySnapshot` the authority for everything about how this attempt is run, so the term is
   * read there and not from the resource's current policy -- a teacher editing the paper mid-exam must not change
   * what is admissible on an attempt already in progress.
   *
   * `SOFT` is not a synonym for `LOCK`, and treating it as one is the defect this input exists to close: see the
   * note at the deadline clause and at `expiryVerdict`.
   */
  readonly perQuestionExpiry: 'SOFT' | 'LOCK' | 'AUTO_SUBMIT';
  /** `null` means the paper sets no per-question limit, and `expiryInstruction` then reads `NONE`. */
  readonly perQuestionTimeLimitSec: number | null;
  /** How far past a deadline a write may still be accepted. Zero is a hard deadline. */
  readonly graceMs: Duration;
  readonly clock: Clock;
  /** Byte length of the serialized answer. Checked against `MAX_ANSWER_BYTES` before anything else. */
  readonly answerBytes: number;
  /** The answer itself, for sim-shape validation. Unread otherwise: this function grades nothing. */
  readonly answerJson: unknown;
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
 * Whether an answer claims to be sim-shaped: an object carrying `simState`. Anything else -- strings,
 * arrays, plain scalars -- passes through untouched, because choice and text answers must never be
 * inspected for sim-ness.
 */
function isSimShaped(answer: unknown): boolean {
  return (
    typeof answer === 'object' && answer !== null && !Array.isArray(answer) && 'simState' in answer
  );
}

function isSimStateObject(answer: unknown): boolean {
  if (!isSimShaped(answer)) return true;
  const state = (answer as Record<string, unknown>).simState;
  return typeof state === 'object' && state !== null && !Array.isArray(state);
}

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
  if (input.answerBytes > MAX_ANSWER_BYTES) {
    return {
      ok: false,
      reason: 'ANSWER_TOO_LARGE',
      message: `this answer is ${String(input.answerBytes)} bytes and the limit is ${String(MAX_ANSWER_BYTES)}; send less state`,
      isConflict: false,
    };
  }

  if (isSimShaped(input.answerJson) && !isSimStateObject(input.answerJson)) {
    return {
      ok: false,
      reason: 'MALFORMED_SIM_STATE',
      message: 'a sim-shaped answer must carry simState as an object',
      isConflict: false,
    };
  }

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
   * 4. THE DEADLINES. One verdict, from the policy module, rather than two comparisons written out here.
   *
   * INV-LATE-1: past the window plus grace, the write is REJECTED and the last accepted value stands. It is not
   * silently accepted, and it is not silently zeroed. A rejection is not a zero — the distinction is the difference
   * between "the student was too slow" and "the student got it wrong", and collapsing them depresses facility and
   * drives r_pb toward correlation with speed.
   *
   * **THE PER-QUESTION TERM IS CONSULTED HERE NOW, AND IT WAS NOT.** This used to refuse any write past
   * `questionDeadlineAt + graceMs` unconditionally, which is `plans/01` §9.1's formula, and §9.1 is the section
   * that omits `perQuestionExpiry` -- while §9.4, three paragraphs later, defines `SOFT` as "log only, editable
   * until the overall deadline". So a teacher who selected `SOFT` got `LOCK`: the answer froze `grace` seconds
   * after the question's own timer ended, silently, and `expiryInstruction` -- the function that carries §9.4's
   * vocabulary -- had no production caller in the repository. It is `expiryVerdict` now, and `apps/web`'s
   * `canAnswer` and `@orrery/exam-engine`'s `evaluateAttempt` ask the same one, because three copies of this
   * predicate is how it came to disagree with itself.
   *
   * The paper is still checked first, and the reason is the message: when both have passed, "time is up for this
   * attempt" is the fact the student can act on, and "time is up for this question" sends them to a question that
   * cannot be saved anywhere.
   */
  const expiry = expiryVerdict(
    {
      perQuestionExpiry: input.perQuestionExpiry,
      perQuestionTimeLimitSec: input.perQuestionTimeLimitSec,
    },
    {
      questionDeadlineAt: input.questionDeadlineAt,
      deadlineAt: input.deadlineAt,
      now,
      graceMs: input.graceMs,
    },
  );

  if (!expiry.writable) {
    return {
      ok: false,
      reason:
        expiry.refusedBecause === 'ATTEMPT_DEADLINE_PASSED'
          ? 'ATTEMPT_DEADLINE_PASSED'
          : 'QUESTION_DEADLINE_PASSED',
      message:
        expiry.refusedBecause === 'ATTEMPT_DEADLINE_PASSED'
          ? 'the time allowed for this attempt has passed, so the last saved answer stands'
          : 'the time allowed for this question has passed, so the last saved answer stands',
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
   * ACCEPTED. `isLate` is the verdict's own, not a re-derivation: recomputing "did this land outside a window"
   * here is the fourth copy of that predicate, and it is the copy that already disagreed with the other three.
   * A `SOFT`-expiry answer written inside the attempt's grace window arrives here with `isLate: true` and is
   * STORED, which is what §9.4 means by "log only".
   */
  return { ok: true, nextRevision: currentRevision + 1, isLate: expiry.isLate };
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
/**
 * THE DATABASE THIS MODULE NEEDS, AND IT IS NOW THE REAL ONE.
 *
 * This used to be a hand-written interface whose methods took `Record<string, unknown>`. **A real `PrismaClient` is
 * not assignable to it** -- Prisma's methods are generic over their argument types, and the compiler rejected the index
 * signature outright. That is a good outcome, not an inconvenience: the structural version was asserting that *any*
 * object with those method names would do, which is exactly the assumption that hid `minHoldUntil`, the `Decimal`
 * arithmetic, and the `status` column in `release.ts`.
 *
 * So the capability is now `Pick<PrismaClient, ...>`, which is both narrower than the client and true about it.
 *
 * **THE PURE HALF IS STILL TESTABLE WITHOUT A DATABASE**, which is what the split was for: `decideWrite` takes a
 * `WriteDecisionInput` of plain values and has no database in its signature at all, so its 21 unit tests run with no
 * connection. What is NOT true any more is that `submitAnswer` can be driven by a hand-rolled mock -- and given what
 * the mock-based version concealed, that is an improvement.
 */
/**
 * `$transaction` AND `$queryRawUnsafe` ARE HERE BECAUSE CONCURRENT WRITERS WERE NOT SERIALISED (ADV-DB2).
 *
 * The capability was five delegates, and the function made four independent round trips with no transaction. Two
 * students — or one student on two devices, which is the ordinary case — could both read "no stored revision", both
 * decide `accept`, both upsert and both append an `AnswerRevision`. The observed failure was worse than a lost update:
 * **one of the two callers received an unhandled Prisma exception** rather than a decision, because the loser's
 * `upsert` collided while the winner's `create` had already committed. From the student's side that is
 * indistinguishable from the network dropping, and the answer they were told was saved is the one that lost.
 *
 * The unique constraint on `(attemptId, idemKey)` does **not** save this: two devices hold two different keys, which is
 * the entire point of a second device.
 *
 * So the function now takes a transaction and pins the attempt row with `FOR UPDATE` at the top. That serialises
 * writers per attempt — which is correct anyway, since every write to one attempt must serialise — and lets the second
 * writer re-read the revision the first one just wrote, so `decideWrite` returns `STALE_REVISION` and the caller gets
 * a 409 with the server's copy. **That is the same lesson as the `runExclusive` advisory-lock leak in `c0b28b5`**,
 * which was two pooled round trips where one session was required: a multi-statement invariant needs one transaction,
 * and a unique constraint only covers the case where two writers agree on a key.
 */
export type SubmitDb = Pick<
  PrismaClient,
  | 'assessmentSlot'
  | 'examAttempt'
  | 'questionResponse'
  | 'answerRevision'
  | 'attemptEventRecord'
  | '$transaction'
  | '$queryRawUnsafe'
>;

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
  // P8-T11 integration: the ASSIGNED PAPER, which is the only thing that can answer "is this question in this
  // attempt". `variantMap` is written once at attempt start and is authoritative; the fallback below covers an attempt
  // whose paper was never resolved.
  variantMap: true,
  assignment: { select: { resourceVersionId: true } },
  /**
   * INV-POLICY-1: the frozen snapshot is where `perQuestionExpiry` comes from, and it was NOT being read here.
   *
   * That omission is why the term had no effect on writes at all -- not because anyone decided `SOFT` should behave
   * like `LOCK`, but because the column holding the decision was never in the SELECT. The same shape as P8-T10's
   * `submissionReceipt` and P8-T9's hardcoded `questionDeadlineAt: null`: a field that exists, is populated, and
   * has no reader.
   */
  policySnapshot: true,
} as const;

/** Narrow an unknown row to the attempt shape, so the decision reads a typed value rather than `any`. */
interface AttemptRow {
  readonly id: string;
  readonly status: string;
  readonly classroomId: string | null;
  /** `Record<slotId, readonly questionId[]>`. `null` when the paper was never resolved. */
  readonly variantMap: Record<string, readonly string[]> | null;
  /**
   * A `Date`, BECAUSE THAT IS WHAT PRISMA RETURNS FOR A `DateTime`.
   *
   * **I PUT THIS COMMENT ON THE WRONG FIELD FIRST.** `WriteDecisionInput.deadlineAt` also reads
   * `readonly deadlineAt: Millis | null`, my search replaced the first occurrence, and the compiler caught the
   * mismatch immediately -- which is the only reason it was caught at all. Worth recording: the trap is not "a cast
   * hides a wrong type", it is that **two fields in one file legitimately have different types**, and a find-and-replace
   * picks one of them. `decideWrite` is pure and works in millis; `AttemptRow` is a database row and works in `Date`.
   *
   * The original defect: this said `Millis | null` while the column is `@db.Timestamptz(3)`, and nothing noticed
   * because the row is produced by `as AttemptRow | null`. **A cast is not a translation** -- it silences the one check
   * that would have found it. The file already says that sentence about `release.ts`'s leaked `finalScore`, and here it
   * was the mechanism.
   */
  readonly deadlineAt: Date | null;
  readonly assignment: { readonly resourceVersionId: string } | null;
  /** `null` for an attempt that has not started. See the read note at `ATTEMPT_SELECT`. */
  readonly policySnapshot: unknown;
  readonly extensions: readonly { readonly addedSec: number }[];
  readonly pausedAccumSec: number | null;
}

/**
 * THE EXPIRY TERM, READ DEFENSIVELY OUT OF A JSON COLUMN.
 *
 * `policySnapshot` is `Json?`, so it arrives as `unknown` and three things can be true of it: absent (an attempt
 * that has not started, or a row written before the column existed), an object, or an object from a *different*
 * policy version. Any of those must yield a safe value rather than a throw -- an answer write is the one request
 * that must never 500 because of a policy read.
 *
 * **AND THE FALLBACK IS `LOCK`, NOT `SOFT`, because it is the refusal that keeps `INV-LATE-1` true.** Choosing
 * `SOFT` here would mean that any row whose snapshot cannot be read becomes writable past its question window --
 * the exact widening the whole change exists to bound, arrived at through an error path nobody would look for.
 * `EXAM_PROFILE_DEFAULTS.perQuestionExpiry` is `'SOFT'`, and using it would be defensible too; what is not defensible
 * is a fallback whose direction nobody chose deliberately.
 */
const readExpiry = (
  snapshot: unknown,
): {
  perQuestionExpiry: 'SOFT' | 'LOCK' | 'AUTO_SUBMIT';
  perQuestionTimeLimitSec: number | null;
} => {
  const from = (source: unknown): Record<string, unknown> | null =>
    typeof source === 'object' && source !== null && !Array.isArray(source)
      ? (source as Record<string, unknown>)
      : null;

  // The snapshot is the frozen POLICY OBJECT. Tolerating a `{ policy: {...} }` wrapper costs three lines and covers
  // the two shapes a hand-written fixture in this repository's own tests has used.
  const raw = from(snapshot);
  const policy = from(raw?.policy) ?? raw;

  const term = policy?.perQuestionExpiry;
  const limit = policy?.perQuestionTimeLimitSec;

  return {
    perQuestionExpiry: term === 'SOFT' || term === 'LOCK' || term === 'AUTO_SUBMIT' ? term : 'LOCK',
    perQuestionTimeLimitSec: typeof limit === 'number' && Number.isFinite(limit) ? limit : null,
  };
};

/**
 * THE EFFECTIVE DEADLINE, extensions and pause included.
 *
 * `deadlineAt` alone is the deadline the student was *given*. C14 records that rewriting it breaks INV-POLICY-1, so
 * the granted extension lives in additive rows and has to be summed here — otherwise a write path accepts or refuses
 * against a stale deadline and a teacher's granted extension silently does nothing.
 */
/**
 * ⚠️ **THIS FUNCTION WAS SILENTLY DISABLED, AND IT IS THE DEADLINE `INV-LATE-1` IS ENFORCED WITH.**
 *
 * ```ts
 * return attempt.deadlineAt + added * 1000 + (attempt.pausedAccumSec ?? 0);
 * ```
 *
 * `deadlineAt` is a `@db.Timestamptz(3)` column, so Prisma hands back a **`Date`**. `Date + number` is **string
 * concatenation** -- `new Date(...) + 0` is `"Sun Mar 01 2026 ... GMT+01000"`, a string -- and the declared return type
 * `Millis | null` is a lie the `as AttemptRow` cast made true to the compiler.
 *
 * So `effectiveDeadline` returned a STRING, `expiryVerdict` compared `now > deadline + graceMs`, and `number > string`
 * is `NaN > NaN`, which is **false for every input**. The consequence is not a rounding error:
 *
 * **THE ATTEMPT DEADLINE WAS NEVER ENFORCED.** Not loosened -- never evaluated. A write an hour after the paper closed
 * was accepted, stored, and reported `isLate: false`. `INV-LATE-1` was satisfied only for the *per-question* window,
 * whose value came from `QuestionResponse.questionDeadlineAt` and happened to be converted with `.getTime()` already.
 *
 * **AND IT COMPOUNDED WITH THE `runExclusive` LEAK FIXED IN `c0b28b5`.** That leak meant the deadline sweep stopped
 * running, so attempts stayed `IN_PROGRESS` past their deadline instead of being auto-submitted by cron -- and
 * `ATTEMPT_NOT_IN_PROGRESS` is the clause that would otherwise have closed the hole. Two defects, each survivable,
 * and together they meant **a closed exam accepted writes indefinitely**. That is the strongest argument in this
 * repository's history for testing a boundary at the point it is produced rather than trusting the type of the thing
 * that carries it: `isPastDeadline` was correct, `expiryVerdict` was correct, `decideWrite` was correct, and the value
 * arriving at all three was a string.
 *
 * **THE UNIT ERROR BESIDE IT WAS MASKED BY THIS ONE, and it is a real second bug.** `pausedAccumSec` is seconds, by
 * the column's name and by `C15`'s intent -- a student granted a ten-minute break is owed ten minutes. It was added as
 * milliseconds, so a break of 600 s contributed 600 ms. The first version of the fix corrected only the type and the
 * unit error was still there, which is why it is called out separately rather than buried: a cast can hide a unit as
 * easily as a type, and reading for one does not find the other.
 */
const effectiveDeadline = (attempt: AttemptRow): Millis | null => {
  if (attempt.deadlineAt === null) return null;
  const addedSec = attempt.extensions.reduce((sum, extension) => sum + extension.addedSec, 0);
  // `C14`: extensions are ADDITIVE rows and `deadlineAt` is never rewritten, so the granted extra time and the time
  // spent paused have to be added here or a write path honours the deadline the student was given and ignores both.
  //
  // BOTH TERMS ARE SECONDS AND BOTH ARE CONVERTED. The millisecond conversion is not a detail: `addedSec` was already
  // multiplied and `pausedAccumSec` was not, so the one term nobody writes a test for -- accumulated pause -- was the
  // one that was wrong by a factor of a thousand, and it was wrong in the direction that costs a student time they
  // were owed.
  return attempt.deadlineAt.getTime() + (addedSec + (attempt.pausedAccumSec ?? 0)) * 1000;
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
/**
 * THE ATTEMPT'S ASSIGNED PAPER, as a set of question ids.
 *
 * `variantMap` first, because `plans/05`/`P5-T9` is explicit that "every subsequent read of 'what did this student
 * get' comes from `variantMap`, never from re-running the draw" -- re-resolving here could produce a different paper
 * than the one the student was actually served, which would reject correct answers and accept wrong ones.
 */
/**
 * ONLY `assessmentSlot`, declared as its own capability rather than as `SubmitDb`.
 *
 * `SubmitDb` now includes `$transaction` and `$queryRawUnsafe`, and the handle Prisma hands a transaction callback is
 * `Omit<PrismaClient, '$transaction' | ...>` -- so a `tx` is deliberately NOT a `SubmitDb`. That asymmetry is correct
 * and this type is where it is honoured: a helper that only reads slots cannot be handed the transaction methods, and
 * cannot grow the power to open one.
 */
type PaperDb = Pick<PrismaClient, 'assessmentSlot'>;

const assignedPaper = async (db: PaperDb, attempt: AttemptRow): Promise<ReadonlySet<string>> => {
  if (attempt.variantMap !== null && attempt.variantMap !== undefined) {
    return new Set(Object.values(attempt.variantMap).flat());
  }

  const resourceVersionId = attempt.assignment?.resourceVersionId;
  if (resourceVersionId === null || resourceVersionId === undefined) return new Set();

  const slots = (await db.assessmentSlot.findMany({
    where: { resourceVersionId },
    select: { kind: true, questionId: true },
  })) as readonly { kind: string; questionId: string | null }[];

  const ids = new Set<string>();
  for (const slot of slots) {
    // A POOLED slot names a pool, not a question; its resolved ids live in the `variantMap` this fallback exists
    // because there isn't one. Counting the pool's `questionId` here would be a null, never a membership.
    if (slot.kind === 'FIXED' && slot.questionId !== null) ids.add(slot.questionId);
  }
  return ids;
};

export async function submitAnswer(
  db: SubmitDb,
  input: SubmitInput,
  clock: Clock,
  graceMs: Duration = 0,
): Promise<SubmitResult> {
  /**
   * ⚠️ ONE TRANSACTION, AND A ROW LOCK AT THE TOP OF IT (ADV-DB2).
   *
   * This used to be four independent round trips with no transaction, which let two concurrent writers both decide
   * `accept` on the same question and then collide on the way in -- one of them receiving an unhandled exception rather
   * than a decision. See the note on `SubmitDb` for the full account and for why the `(attemptId, idemKey)` unique
   * constraint does not cover it.
   *
   * **`SELECT ... FOR UPDATE` ON THE ATTEMPT ROW, FIRST, BEFORE ANY READ THAT DECIDES.** The lock has to be taken
   * before the revision is read, or the two writers serialise *after* they have both already decided and the loser
   * still has to fail. Taking it first means the second writer waits, re-reads the revision the winner just wrote, and
   * `decideWrite` returns `STALE_REVISION` -- a 409 carrying the server's copy, which is the outcome the 409 UX in
   * `reconcileDialog.ts` already knows how to present.
   *
   * ON THE ATTEMPT AND NOT THE RESPONSE: the response row **does not exist yet** on a first write, and there is no row
   * to lock. Locking the attempt is also the coarser and more correct choice, since two students cannot write the same
   * attempt but two devices of one student can.
   *
   * `attemptId` goes in as a bind value. `runExclusive` uses `pg_advisory_lock(hashtext($1))`, so this key is a
   * **hash** rather than the two-int form -- one 32-bit key space, which is acceptable here because the lock's scope is
   * a single row's lifetime rather than a named subsystem.
   */
  return db.$transaction(async (tx) => {
    await tx.$queryRawUnsafe(
      'SELECT 1 FROM "ExamAttempt" WHERE id = $1 FOR UPDATE',
      input.attemptId,
    );

    const attempt = (await tx.examAttempt.findUnique({
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
    const prior = (await tx.answerRevision.findFirst({
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

    const stored = (await tx.questionResponse.findUnique({
      where: { attemptId_questionId: { attemptId: input.attemptId, questionId: input.questionId } },
      select: {
        revision: true,
        answer: true,
        questionId: true,
        questionDeadlineAt: true,
        questionClosedReason: true,
      },
    })) as {
      revision: number;
      answer: unknown;
      questionId: string;
      /** `null` means no per-question window, and that is a legitimate state rather than an error. */
      questionDeadlineAt: Date | null;
      questionClosedReason: string | null;
    } | null;

    // 2. IS THIS QUESTION IN THE ATTEMPT'S PAPER?  (P8-T11 integration)
    //
    // **IT WAS `stored !== null`, WHICH MEANT NO FIRST ANSWER COULD EVER BE ACCEPTED.**
    //
    // A response row exists only after a successful write, so on a first write `stored` is null, membership came out
    // false, and every student saving their first answer was rejected with `QUESTION_NOT_IN_ATTEMPT` -- a rejection
    // whose message talks about the paper while the actual fault is that membership was inferred from the very table
    // the write was supposed to create. The unit tests could not see it: they call `decideWrite` directly and pass
    // `questionInAttempt: true`.
    //
    // Membership is assigned-variant membership, as the field's own doc says, so it comes from the attempt's resolved
    // `variantMap` -- written once at attempt start and authoritative thereafter. Falling back to the resource version's
    // FIXED slots covers an attempt whose paper was never resolved, rather than refusing every write on it.
    const assignedQuestionIds = await assignedPaper(tx, attempt);
    const questionInAttempt = assignedQuestionIds.has(input.questionId);

    const expiryPolicy = readExpiry(attempt.policySnapshot);

    // 3. DECIDE.
    const decision = decideWrite({
      // Byte length of what was SENT (C5's bytes), not of a re-serialization: re-reading the jsonb
      // column does not preserve key order, so its length is a different number than the client's.
      answerBytes: Buffer.byteLength(input.answerBytes, 'utf8'),
      answerJson: input.answerJson,
      attemptStatus: attempt.status as AttemptStatus,
      // P8-T11 integration: the PER-QUESTION window, read from the response row.
      //
      // **IT WAS A HARDCODED `null`, SO `INV-LATE-1` WAS NOT ENFORCED PER QUESTION AT ALL** -- every question inherited
      // only the attempt-wide deadline. `ExamAttempt` carries `pausedAccumSec` and `QuestionResponse` carries
      // `questionDeadlineAt`/`questionClosedReason` precisely because `plans/09` gives each question its own window, and
      // a hardcoded null silently disabled the stricter of the two deadlines.
      questionDeadlineAt: stored?.questionDeadlineAt?.getTime() ?? null,
      deadlineAt: effectiveDeadline(attempt),
      expectedRevision: input.expectedRevision,
      storedRevision: stored?.revision ?? -1,
      isDuplicate: false,
      storedResponseBody: stored?.answer,
      questionInAttempt,
      perQuestionExpiry: expiryPolicy.perQuestionExpiry,
      perQuestionTimeLimitSec: expiryPolicy.perQuestionTimeLimitSec,
      graceMs,
      clock,
    });

    // 4. REJECTION: an event, never a ledger row.
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
      await tx.attemptEventRecord.create({
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

    const response = (await tx.questionResponse.upsert({
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

    await tx.answerRevision.create({
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
  });
}

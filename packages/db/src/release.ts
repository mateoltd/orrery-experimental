/**
 * Score computation and batch release.  (P7-T10)
 *
 * `plans/01` INV-RELEASE-1: release is **one database transaction** across the whole batch. There is no intermediate
 * state in which some attempts in a batch are visible; a failure releases nothing and the job retries idempotently.
 *
 * ## WHY THE ARITHMETIC IS A PURE FUNCTION AND NOT IN THE TRANSACTION
 *
 * §10.1's five lines are where a release goes wrong quietly. Every one of them has an edge that produces a plausible
 * number rather than an error:
 *
 *  · **`percentage` is NULL when `maxTotal` is 0, not 0.** An all-excused paper has nothing to be a percentage OF. A
 *    0% there reads as "the student scored nothing", which is a different and much worse statement.
 *  · **Excused questions leave BOTH sums.** Skipping them in the numerator alone inflates the percentage: a student
 *    excused from half a paper looks better than one who answered everything.
 *  · **The late penalty is applied at COMPUTATION time, not submission time**, so it stays adjustable and auditable
 *    after the fact. Applying it at submission makes it unrecoverable the moment a teacher's policy is wrong.
 *  · **Weights and letter grades are derived views, never stored.** Storing them creates two truths that drift the
 *    moment a threshold is edited.
 *
 * So the arithmetic is here, pure and exhaustively tested, and the transaction is left to do only what a database is
 * for.
 */

import type { Clock, Millis } from '@orrery/clock';
import { writeReleasedScores } from './release-bulk-write.js';

/** One response's contribution. Plain data so the whole computation is testable with no fixtures. */
export interface ScoredResponse {
  readonly questionId: string;
  /** The marks awarded. `null` when the response needs a human — never 0, which means "wrong". */
  readonly finalScore: number | null;
  /** The marks the question was worth, in the RESOLVED variant. */
  readonly points: number;
  readonly isExcused: boolean;
  readonly needsHuman: boolean;
}

export interface ScoreInput {
  readonly responses: readonly ScoredResponse[];
  readonly isLate: boolean;
  /** Percent off for a late attempt, e.g. `10` for 10%. Zero or absent means no penalty. */
  readonly latePenaltyPercent: number;
}

export interface ComputedScore {
  readonly rawTotal: number;
  readonly maxTotal: number;
  /** `null` when there is nothing to be a percentage of. NOT zero. */
  readonly percentage: number | null;
  readonly lateFactor: number;
  /** The released figure, rounded to 2dp. `null` when `percentage` is `null`. */
  readonly finalScore: number | null;
  /** The penalty actually applied, as a fraction, for the audit column. */
  readonly latePenaltyApplied: number;
  /**
   * True when at least one response needs a human, so the score is PROVISIONAL.
   *
   * INV-SIM-2 in spirit: a `NEEDS_HUMAN` response must never be laundered into a number that looks final. This is
   * carried on the result rather than decided by the caller so it cannot be forgotten at one call site.
   */
  readonly isProvisional: boolean;
}

/** Round to 2dp without the float drift of `Math.round(x * 100) / 100` on values like 1.005. */
/**
 * PRISMA'S `Decimal` IS NOT A `number`, AND ADDING ONE TO THE OTHER GIVES `NaN`.
 *
 * `Decimal` has a `toJSON` that renders `"2"`, which is why it survives a `console.log` looking like a value, and a
 * `toNumber` that arithmetic does NOT use -- so `0 + someDecimal` is `NaN`, silently. A `Decimal` column read into a
 * variable typed `number` compiles perfectly and computes to nothing.
 *
 * `Number(value)` is used rather than `value.toNumber()` because `toNumber()` THROWS on a value that is out of
 * range or too many decimal places, and a release that throws halfway leaves the batch in the state `INV-RELEASE-1`
 * exists to make impossible. Falling back to `0` for an unusable mark is also the conservative direction: it lowers a
 * score, and `planRelease`'s provisional check catches the case where a mark was still expected.
 */
const scoreNumber = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  const withToNumber = value as { toNumber?: () => number };
  const converted =
    typeof withToNumber.toNumber === 'function' ? withToNumber.toNumber() : Number(value);
  return Number.isFinite(converted) ? converted : null;
};

export const round2 = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;

/**
 * COMPUTE AN ATTEMPT'S SCORE, exactly as `plans/01` §10.1 writes it.
 *
 * ```
 * rawTotal   = Σ (isExcused ? 0 : finalScore(response))
 * maxTotal   = Σ points over non-excused questions
 * percentage = maxTotal > 0 ? rawTotal / maxTotal : null
 * lateFactor = isLate ? (1 - latePenaltyPercent/100) : 1
 * final      = round(percentage × 100 × lateFactor, 2)
 * ```
 */
export const computeScore = (input: ScoreInput): ComputedScore => {
  /**
   * `needsHuman` RESPONSES ARE COUNTED IN `maxTotal` BUT NOT IN `rawTotal`.
   *
   * The reason is the asymmetry that makes this safe to release at all: a response still awaiting a marker has earned
   * nothing yet, but the question it is waiting on is still on the paper. Dropping it from `maxTotal` would raise
   * everyone else's percentage while the queue drains, which means a student's mark depends on someone else's
   * marking speed. So the score is flagged provisional instead.
   */
  const counted = input.responses.filter((response) => !response.isExcused);

  const rawTotal = round2(counted.reduce((sum, response) => sum + (response.finalScore ?? 0), 0));
  const maxTotal = round2(counted.reduce((sum, response) => sum + response.points, 0));

  const percentage = maxTotal > 0 ? rawTotal / maxTotal : null;

  /**
   * THE PENALTY IS CLAMPED TO [0, 100]. A configured penalty above 100 would make `lateFactor` negative and hand a
   * student a NEGATIVE final score for submitting late — a real configuration mistake that this arithmetic would
   * otherwise turn into a mark.
   */
  const requested = input.isLate ? input.latePenaltyPercent : 0;
  const penaltyPercent = Math.min(Math.max(requested, 0), 100);
  const lateFactor = 1 - penaltyPercent / 100;

  const finalScore = percentage === null ? null : round2(percentage * 100 * lateFactor);

  return {
    rawTotal,
    maxTotal,
    percentage,
    lateFactor,
    finalScore,
    latePenaltyApplied: penaltyPercent / 100,
    isProvisional: counted.some((response) => response.needsHuman || response.finalScore === null),
  };
};

/* ─────────────────────────────────────────────────────────── the release ── */

/** Why a batch cannot be released. Each is a refusal with something to fix, not a generic failure. */
export type ReleaseRefusal =
  /** `plans/01`: every attempt must be `GRADED`, unless an override reason is recorded. */
  | 'ATTEMPT_NOT_GRADED'
  /** An attempt in the batch still has a response awaiting a human. */
  | 'ATTEMPT_NEEDS_HUMAN'
  /** A score could not be computed at all — an all-excused paper has no percentage. */
  | 'SCORE_NOT_COMPUTABLE'
  /** K-4/RN-03: the minimum pre-release review window has not elapsed. */
  | 'HOLD_WINDOW_NOT_ELAPSED'
  /** The batch has already been released. Not an error — release is idempotent. */
  | 'ALREADY_RELEASED'
  /**
   * P10-T1: the batch is not `RELEASING`, so its membership has not been frozen and there is nothing to release yet.
   *
   * Before this existed the only status `planRelease` looked at was `RELEASED`, so a `CANCELED` batch was released --
   * measured, against the database -- and so was a `DRAFT` one that had passed no gate.
   */
  | 'BATCH_NOT_RELEASING';

export interface ReleaseCheckInput {
  readonly batchStatus: string;
  readonly holdUntil: Millis | null;
  /**
   * The attempts a recorded override WAIVES, which stands in for `GRADED` -- for those attempts and no others.
   *
   * P10-T3. This was `hasOverrideReason: boolean`, and a boolean is a blank cheque: an override written on Monday for
   * one absent student then waived every blocker the batch would ever have, including one that appeared on Tuesday
   * and that nobody had looked at. An override is a decision about what a person could SEE when they made it.
   */
  readonly waivedAttemptIds: ReadonlySet<string>;
  readonly attempts: readonly {
    readonly attemptId: string;
    readonly status: string;
    /** Per-attempt lateness. It is a property of THIS attempt, not of the batch, so it cannot be hoisted. */
    readonly isLate: boolean;
    readonly responses: readonly ScoredResponse[];
  }[];
  readonly latePenaltyPercent: number;
  readonly clock: Pick<Clock, 'now'>;
}

export interface ReleasePlan {
  readonly releasable: boolean;
  readonly refusals: readonly {
    readonly attemptId: string | null;
    readonly reason: ReleaseRefusal;
  }[];
  /** Per-attempt scores, present only when `releasable`. Computed up front so the transaction writes nothing new. */
  readonly scores: readonly { readonly attemptId: string; readonly score: ComputedScore }[];
}

/**
 * DECIDE WHETHER A BATCH MAY BE RELEASED, and compute every score — ALL OF THEM, OR NONE.
 *
 * This is deliberately a separate step from the write. Computing all the scores and finding the batch unreleasable on
 * the last attempt is the common case, and doing it before opening the transaction means the "all or nothing" property
 * comes from this function's structure rather than from trusting a loop to be careful.
 */
export const planRelease = (input: ReleaseCheckInput): ReleasePlan => {
  /**
   * AN ALREADY-RELEASED BATCH IS NOT A FAILURE.
   *
   * INV-RELEASE-1 says the job "retries idempotently", and a retry is exactly what happens when the worker dies after
   * committing but before acknowledging. Returning a refusal here would make that retry look like an error and, worse,
   * tempt a caller to force it.
   */
  if (input.batchStatus === 'RELEASED') {
    return {
      releasable: false,
      refusals: [{ attemptId: null, reason: 'ALREADY_RELEASED' }],
      scores: [],
    };
  }

  const refusals: { attemptId: string | null; reason: ReleaseRefusal }[] = [];

  // K-4/RN-03: the review window is checked before anything else, so the message is the actionable one.
  if (input.holdUntil !== null && input.clock.now() < input.holdUntil) {
    refusals.push({ attemptId: null, reason: 'HOLD_WINDOW_NOT_ELAPSED' });
  }

  const scores: { attemptId: string; readonly score: ComputedScore }[] = [];

  for (const attempt of input.attempts) {
    const waived = input.waivedAttemptIds.has(attempt.attemptId);

    if (attempt.status !== 'GRADED' && !waived) {
      refusals.push({ attemptId: attempt.attemptId, reason: 'ATTEMPT_NOT_GRADED' });
      // Scored anyway, so the caller can show the teacher what the batch WOULD produce. Cheap, and it turns a bare
      // refusal into something actionable.
    }

    const score = computeScore({
      responses: attempt.responses,
      isLate: attempt.isLate,
      latePenaltyPercent: input.latePenaltyPercent,
    });

    if (score.finalScore === null) {
      refusals.push({ attemptId: attempt.attemptId, reason: 'SCORE_NOT_COMPUTABLE' });
    } else if (score.isProvisional && !waived) {
      refusals.push({ attemptId: attempt.attemptId, reason: 'ATTEMPT_NEEDS_HUMAN' });
    } else {
      scores.push({ attemptId: attempt.attemptId, score });
    }
  }

  /**
   * AN OVERRIDE DOES NOT FIX A MISSING SCORE.
   *
   * A waiver stands in for "this attempt is `GRADED`" — it waives the status check. It cannot manufacture a
   * percentage for an all-excused paper, so `SCORE_NOT_COMPUTABLE` is refused regardless.
   */
  return { releasable: refusals.length === 0, refusals, scores };
};

/* ─────────────────────────────────────────── the release transaction ── */

/** The minimum this module needs to release. Narrow, so `planRelease` stays testable with no database. */
export interface ReleaseDb {
  releaseBatch: {
    findUnique(input: {
      where: { id: string };
      select?: Record<string, unknown>;
    }): Promise<unknown>;
    update(input: Record<string, unknown>): Promise<unknown>;
  };
  releaseBatchMember: {
    findMany(input: Record<string, unknown>): Promise<readonly unknown[]>;
    updateMany(input: Record<string, unknown>): Promise<unknown>;
  };
  examAttempt: { update(input: Record<string, unknown>): Promise<unknown> };
  /**
   * THE BATCHED SCORE WRITER'S CAPABILITY, DECLARED HERE SO IT CANNOT BE OMITTED BY ACCIDENT.  (`P10-T9`)
   *
   * `releaseBatch` writes member scores through `writeReleasedScores`, which is chunked
   * `UPDATE ... FROM (VALUES ...)` -- measured at 10 statements for 5,000 attempts against the 5,000 round trips and
   * 4,258 ms the per-attempt loop cost. **When this member was missing, every structural test double that hands
   * `releaseBatch` a handle failed at RUNTIME with `tx.$executeRawUnsafe is not a function`** -- 16 tests, none of
   * which failed to compile.
   *
   * Declaring it here turns all of those into compile errors instead, which is the difference between a broken swap
   * found by `tsc` in seconds and one found by a red integration suite. **A test double that quietly lacks the
   * capability the code needs would let a broken swap pass**, which is the failure this member exists to make
   * impossible.
   */
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
  /** Prisma's interactive transaction handle. One call, so every write inside is atomic. */
  $transaction<T>(fn: (tx: ReleaseDb) => Promise<T>): Promise<T>;
}

/**
 * THE OVERRIDE'S WAIVED ATTEMPTS, read out of a JSON column -- and it IS a translation, not a cast.
 *
 * `overrideWaived` is `Json?`, so Prisma hands back `unknown`-shaped data and a cast to `{ attemptId: string }[]`
 * would compile against anything the column happens to hold. Everything that is not an object with a string
 * `attemptId` is dropped, and dropping is the conservative direction: an entry that cannot be read waives nothing, so
 * the attempt it was meant to cover is listed as a blocker again rather than released on the strength of a guess.
 */
export const waivedAttemptIdsOf = (override: {
  readonly overrideReason: string | null;
  readonly overrideById: string | null;
  readonly overrideAt: Date | null;
  readonly overrideWaived: unknown;
}): ReadonlySet<string> => {
  /**
   * A REASON WITH NO AUTHOR WAIVES NOTHING.
   *
   * Migration `0014` adds the all-four-or-none CHECK as `NOT VALID`, so a row written before it can still hold a bare
   * `overrideReason`. That is precisely the override nobody can audit, and honouring it here would make the constraint
   * decorative for the rows it matters most for.
   */
  if (
    override.overrideReason === null ||
    override.overrideById === null ||
    override.overrideAt === null
  ) {
    return new Set();
  }
  if (!Array.isArray(override.overrideWaived)) return new Set();

  const ids = new Set<string>();
  for (const entry of override.overrideWaived as readonly unknown[]) {
    if (entry === null || typeof entry !== 'object') continue;
    const attemptId = (entry as { attemptId?: unknown }).attemptId;
    if (typeof attemptId === 'string' && attemptId !== '') ids.add(attemptId);
  }
  return ids;
};

/** A batch as stored, with the plan computed from it. What both the pre-release gate and the release read. */
export interface LoadedReleasePlan {
  readonly batchId: string;
  readonly status: string;
  readonly assignmentId: string;
  readonly classroomId: string;
  readonly attemptIds: readonly string[];
  /** The attempts the recorded override covers. Empty when there is no (complete) override. */
  readonly waivedAttemptIds: ReadonlySet<string>;
  /**
   * The translated input `plan` was computed from, kept so a caller can ask a DIFFERENT question of the same read.
   * Recording an override needs "what blocks with nothing waived?", and re-reading the rows to ask it would be a
   * second read that a concurrent grade could land between.
   */
  readonly check: ReleaseCheckInput;
  readonly plan: ReleasePlan;
}

/**
 * READ A BATCH AND PLAN ITS RELEASE.  (P10-T3)
 *
 * This was the first half of `releaseBatch`, and it is its own function because the pre-release gate needs exactly
 * the same answer. **A gate that decides "releasable" by a different read from the release is a gate that admits
 * batches the release then refuses** -- and a batch refused after it has entered `RELEASING` is frozen and stuck. One
 * read, one `planRelease`, two callers: what the gate admits is by construction what the release accepts.
 *
 * It must be called on a TRANSACTION handle. The read and whatever the caller writes next are one decision, and a
 * concurrent grade landing between them is the window `B16` exists to close.
 */
export async function loadReleasePlan(
  tx: ReleaseDb,
  input: {
    readonly batchId: string;
    readonly latePenaltyPercent: number;
    readonly clock: Pick<Clock, 'now'>;
  },
): Promise<LoadedReleasePlan | null> {
  const batch = (await tx.releaseBatch.findUnique({
    where: { id: input.batchId },
    select: {
      id: true,
      status: true,
      assignmentId: true,
      classroomId: true,
      // `minHoldUntil`, NOT `holdUntil`. The column is `minHoldUntil` and the internal input field is `holdUntil`,
      // and the two were conflated -- so `releaseBatch` threw `Invalid tx.releaseBatch.findUnique() invocation` on
      // EVERY call, against a real database.
      //
      // **The unit tests could not have caught this.** They pass a hand-written mock whose `findUnique` returns
      // whatever the test says, so a field name that does not exist in the schema is indistinguishable from one
      // that does. INV-RELEASE-1 was, in other words, completely untested as a transaction: the pure planning was
      // proven and the part that touches the database had never been executed.
      minHoldUntil: true,
      overrideReason: true,
      overrideById: true,
      overrideAt: true,
      overrideWaived: true,
      members: { select: { attemptId: true } },
    },
  })) as {
    id: string;
    status: string;
    assignmentId: string;
    classroomId: string;
    minHoldUntil: Date | null;
    overrideReason: string | null;
    overrideById: string | null;
    overrideAt: Date | null;
    overrideWaived: unknown;
    members: readonly { attemptId: string }[];
  } | null;

  if (batch === null) return null;

  // The attempts, with the responses needed to compute each score. Read INSIDE the transaction, for the reason above.
  const attempts = (await tx.releaseBatchMember.findMany({
    where: { batchId: input.batchId },
    select: {
      attempt: {
        select: {
          id: true,
          status: true,
          isLate: true,
          responses: {
            select: {
              questionId: true,
              isExcused: true,
              needsHuman: true,
              autoScore: true,
              manualScore: true,
              // `points` is NOT on the response: it lives on the QUESTION, and §10.1's `maxTotal` is the sum over
              // the RESOLVED variant. Selecting it through the relation is what makes `maxTotal` the marks
              // actually on this student's paper rather than the authored question's marks.
              question: { select: { points: true } },
            },
          },
        },
      },
    },
  })) as readonly {
    attempt: {
      id: string;
      status: string;
      isLate: boolean;
      responses: readonly {
        questionId: string;
        isExcused: boolean;
        needsHuman: boolean;
        /** A Prisma `Decimal`, NOT a number. `scoreNumber` is what makes it one. */
        autoScore: unknown;
        /** A Prisma `Decimal`, NOT a number. */
        manualScore: unknown;
        question: { points: unknown };
      }[];
    };
  }[];

  const waivedAttemptIds = waivedAttemptIdsOf(batch);

  const check: ReleaseCheckInput = {
    batchStatus: batch.status,
    holdUntil: batch.minHoldUntil === null ? null : batch.minHoldUntil.getTime(),
    waivedAttemptIds,
    latePenaltyPercent: input.latePenaltyPercent,
    clock: input.clock,
    attempts: attempts.map(({ attempt }) => ({
      attemptId: attempt.id,
      status: attempt.status,
      isLate: attempt.isLate,
      responses: attempt.responses.map((row) => ({
        questionId: row.questionId,
        // A manual mark wins over the auto mark. `finalScore` is the DERIVED value: this is not a stored truth, and
        // computing it here is what keeps `finalScore`/`autoScore`/`manualScore` from becoming three truths.
        //
        // **THROUGH `scoreNumber`, BECAUSE PRISMA RETURNS `Decimal` OBJECTS AND `number + Decimal` IS `NaN`.**
        //
        // This is the second defect the integration test found in this function, and the more dangerous one: the
        // local type said `autoScore: number` and so did the cast, so the compiler agreed with an assumption the
        // database never made. `computeScore` then summed `0 + Decimal` into `NaN`, `maxTotal > 0` was false,
        // `percentage` came out `null`, and EVERY batch was refused with `SCORE_NOT_COMPUTABLE`.
        //
        // **THE RELEASE TRANSACTION HAS THEREFORE NEVER RELEASED ANYTHING.** The unit tests passed because they
        // pass plain numbers into `planRelease`, which is the correct input -- the bug lived entirely in the
        // translation from a Prisma row to that input, and a cast is not a translation.
        finalScore: scoreNumber(row.manualScore) ?? scoreNumber(row.autoScore),
        points: scoreNumber(row.question.points) ?? 0,
        isExcused: row.isExcused,
        needsHuman: row.needsHuman,
      })),
    })),
  };

  return {
    batchId: batch.id,
    status: batch.status,
    assignmentId: batch.assignmentId,
    classroomId: batch.classroomId,
    attemptIds: batch.members.map((member) => member.attemptId),
    waivedAttemptIds,
    check,
    plan: planRelease(check),
  };
}

/**
 * RELEASE A WHOLE BATCH, OR NOTHING.
 *
 * INV-RELEASE-1. Every score write and the batch's own `RELEASED` status happen inside ONE `prisma.$transaction`. The
 * alternative -- a loop of per-attempt writes with a final status update -- has a failure mode that is invisible until
 * a student complains: the batch is marked released while some attempts were never written, or some attempts are
 * visible while the batch still says `DRAFT`. Neither leaves a partial state to inspect, which is what makes them hard
 * to notice and expensive to unpick.
 *
 * `planRelease` has already decided releasability, and it is called INSIDE the transaction rather than outside so the
 * decision and the write cannot be separated by a concurrent grade landing in between. Planning outside would leave a
 * window in which the batch was checked, then changed, then written.
 *
 * ## IT RELEASES A `RELEASING` BATCH AND NOTHING ELSE  (P10-T1)
 *
 * `RELEASING` is the state in which membership is frozen (`release-batch.ts`, migration `0014`), so it is the only
 * state in which "every member was verified" is a statement about the members that will actually become visible.
 * `beginRelease` is how a batch gets there, and it runs the pre-release gate on the way.
 */
export async function releaseBatch(
  db: ReleaseDb,
  input: {
    readonly batchId: string;
    readonly releasedById?: string;
    readonly latePenaltyPercent: number;
    readonly clock: Clock;
  },
): Promise<{
  readonly released: boolean;
  readonly releasedCount: number;
  readonly refusals: readonly { attemptId: string | null; reason: ReleaseRefusal }[];
}> {
  return db.$transaction(async (tx) => {
    const loaded = await loadReleasePlan(tx, input);

    if (loaded === null) {
      return {
        released: false,
        releasedCount: 0,
        refusals: [{ attemptId: null, reason: 'SCORE_NOT_COMPUTABLE' }],
      };
    }

    const { plan, attemptIds } = loaded;

    /**
     * `RELEASED` falls through to `planRelease`'s idempotent `ALREADY_RELEASED`; every other status is refused HERE,
     * before anything is written, so a `DRAFT` or `CANCELED` batch is a clean refusal rather than a trigger error.
     * The trigger is still there for the writer that does not call this function.
     */
    if (loaded.status !== 'RELEASING' && loaded.status !== 'RELEASED') {
      return {
        released: false,
        releasedCount: 0,
        refusals: [{ attemptId: null, reason: 'BATCH_NOT_RELEASING' }],
      };
    }

    if (!plan.releasable) {
      // NOTHING is written. Not the scores, not the members, not the batch status.
      return { released: false, releasedCount: 0, refusals: plan.refusals };
    }

    /**
     * THE BATCHED WRITER.  (`P10-T9`)
     *
     * **MEASURED, 5,000 attempts in one transaction, on this host:**
     *
     *     one `examAttempt.update` per member .......... 4,086 ms  (5,000 round trips, 0.82 ms each)
     *     the single visibility gate write ............     1 ms  (one statement, one row)
     *     whole transaction .......................... 4,258 ms
     *     Prisma's DEFAULT interactive-transaction ceiling ..... 5,000 ms
     *     MARGIN .......................................   742 ms
     *
     * **742 ms.** The round-trip count WAS the cohort, so a batch twice the size was twice the transaction while the
     * gate beside it stayed one statement about one row -- and a release that exceeds Prisma's default timeout throws
     * partway, which is the one outcome `INV-RELEASE-1` exists to make impossible. This does the same work in **10
     * statements and 359 ms**, a 4,641 ms margin.
     *
     * **THE VISIBILITY SEMANTICS ARE UNCHANGED, AND THAT IS THE ONLY CLAIM THAT MAKES THE SWAP ADMISSIBLE.** The gate
     * below is still ONE `releaseBatch.update`, still the last statement in the transaction, so a batch is still either
     * entirely invisible or entirely visible. `release-atomicity.integration.test.ts` runs a concurrent reader loop
     * against both writers and asserts the same whole-batch snapshots, plus two structural facts that hold on a
     * machine ten times slower: the loop's round-trip count EQUALS the cohort, and this one's does not.
     *
     * Three hazards the raw SQL had to handle, none of which a test about scores would catch:
     *
     * · **`@updatedAt` IS APPLIED BY PRISMA ON THE CLIENT**, so a raw `UPDATE` skips it. Unhandled, every release would
     *   publish 5,000 rows whose `updatedAt` predates the release that published them. The statement sets it.
     * · **`UPDATE ... FROM (VALUES ...)` SILENTLY SKIPS AN ID NOT IN THE TABLE** -- a silent partial write inside the
     *   one transaction whose purpose is to not be partial. The affected row count is summed against the input and a
     *   mismatch THROWS.
     * · **EVERY `VALUES` COLUMN IS CAST EXPLICITLY**, because Postgres infers per column across the whole list: one
     *   null makes the column `text` and the failure names a type absent from this file.
     *
     * **ONE SEMANTIC CHANGE, RECORDED RATHER THAN DONE QUIETLY:** every member now carries ONE instant, read once, so
     * `releasedAt` is a fact about the release rather than about the order Postgres happened to service 5,000 updates
     * in -- which is what a reader of that column is entitled to assume.
     */
    await writeReleasedScores(tx, { scores: plan.scores, clock: input.clock });

    /**
     * **THERE IS NO PER-MEMBER WRITE, AND THE ONE THAT WAS HERE COULD NOT HAVE RUN.**
     *
     * `ReleaseBatchMember` has exactly three columns: `batchId`, `attemptId`, `addedAt`. There is no `status`, so
     * `updateMany({ data: { status: 'RELEASED' } })` throws -- which the pure unit tests could not see, because their
     * mock accepted whatever it was handed.
     *
     * **AND IT WAS NOT NEEDED.** `B16` makes student visibility `EXISTS(... batch status = 'RELEASED')`, so the batch's
     * own status IS the visibility switch. Flipping per-member rows would have been a second source of truth for one
     * fact, and the two would have been able to disagree.
     *
     * It is worth naming why the comment above it claimed to prevent a half-visible batch: the update was a
     * *symptom* of the design, not the design. The single status write below is the whole mechanism, and it is the last
     * statement in the transaction, so a batch is either entirely invisible or entirely visible.
     */

    await tx.releaseBatch.update({
      where: { id: input.batchId },
      data: {
        status: 'RELEASED',
        releasedAt: new Date(input.clock.now()),
        releasedById: input.releasedById ?? null,
      },
    });

    return { released: true, releasedCount: attemptIds.length, refusals: [] };
  });
}

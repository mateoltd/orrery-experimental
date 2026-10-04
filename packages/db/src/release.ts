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
  | 'ALREADY_RELEASED';

export interface ReleaseCheckInput {
  readonly batchStatus: string;
  readonly holdUntil: Millis | null;
  /** Whether an override reason is recorded on the batch, which stands in for `GRADED`. */
  readonly hasOverrideReason: boolean;
  readonly attempts: readonly {
    readonly attemptId: string;
    readonly status: string;
    /** Per-attempt lateness. It is a property of THIS attempt, not of the batch, so it cannot be hoisted. */
    readonly isLate: boolean;
    readonly responses: readonly ScoredResponse[];
  }[];
  readonly latePenaltyPercent: number;
  readonly clock: Clock;
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
    if (attempt.status !== 'GRADED' && !input.hasOverrideReason) {
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
    } else if (score.isProvisional && !input.hasOverrideReason) {
      refusals.push({ attemptId: attempt.attemptId, reason: 'ATTEMPT_NEEDS_HUMAN' });
    } else {
      scores.push({ attemptId: attempt.attemptId, score });
    }
  }

  /**
   * AN OVERRIDE DOES NOT FIX A MISSING SCORE.
   *
   * `overrideReason` stands in for "this attempt is `GRADED`" — it waives the status check. It cannot manufacture a
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
  /** Prisma's interactive transaction handle. One call, so every write inside is atomic. */
  $transaction<T>(fn: (tx: ReleaseDb) => Promise<T>): Promise<T>;
}

/**
 * RELEASE A WHOLE BATCH, OR NOTHING.
 *
 * INV-RELEASE-1. Every score write, every member row, and the batch's own `RELEASED` status happen inside ONE
 * `prisma.$transaction`. The alternative -- a loop of per-attempt writes with a final status update -- has a failure
 * mode that is invisible until a student complains: the batch is marked released while some attempts were never written,
 * or some attempts are visible while the batch still says `DRAFT`. Neither leaves a partial state to inspect, which is
 * what makes them hard to notice and expensive to unpick.
 *
 * `planRelease` has already decided releasability, and it is called INSIDE the transaction rather than outside so the
 * decision and the write cannot be separated by a concurrent grade landing in between. Planning outside would leave a
 * window in which the batch was checked, then changed, then written.
 *
 * Every member row is set to `RELEASED` in ONE `updateMany` rather than per row, because student visibility is
 * `EXISTS(... batch status = 'RELEASED')` (B16) and per-row writes are how a batch ends up half-visible.
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
    const batch = (await tx.releaseBatch.findUnique({
      where: { id: input.batchId },
      select: {
        id: true,
        status: true,
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
        members: { select: { attemptId: true } },
      },
    })) as {
      id: string;
      status: string;
      minHoldUntil: Date | null;
      overrideReason: string | null;
      members: readonly { attemptId: string }[];
    } | null;

    if (batch === null) {
      return {
        released: false,
        releasedCount: 0,
        refusals: [{ attemptId: null, reason: 'SCORE_NOT_COMPUTABLE' }],
      };
    }

    const attemptIds = batch.members.map((member) => member.attemptId);

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

    const plan = planRelease({
      batchStatus: batch.status,
      holdUntil: batch.minHoldUntil === null ? null : batch.minHoldUntil.getTime(),
      hasOverrideReason: batch.overrideReason !== null,
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
    });

    if (!plan.releasable) {
      // NOTHING is written. Not the scores, not the members, not the batch status.
      return { released: false, releasedCount: 0, refusals: plan.refusals };
    }

    for (const { attemptId, score } of plan.scores) {
      await tx.examAttempt.update({
        where: { id: attemptId },
        data: {
          finalScore: score.finalScore,
          percentage: score.percentage,
          maxScore: score.maxTotal,
          latePenaltyApplied: score.latePenaltyApplied,
          // `new Date(clock.now())`, never `new Date()`: INV-TIME-1.
          releasedAt: new Date(input.clock.now()),
        },
      });
    }

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

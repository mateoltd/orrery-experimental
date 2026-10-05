/**
 * A CANDIDATE for the per-attempt score loop in `releaseBatch`.  (P10-T9)
 *
 * ## WHY THIS FILE EXISTS, AND WHY `releaseBatch` IS NOT CALLING IT
 *
 * `releaseBatch` (`release.ts`) writes one `examAttempt.update` per member inside one transaction, so a 5,000-attempt
 * release is 5,000 sequential round trips with the transaction open. `plans/07` §6.1's table claims release is
 * "O(1) in batch size" and "instant", and **that claim is true of the visibility GATE and false of the transaction**:
 * the gate is one statement about one row, and the per-attempt score writes are what scale with the batch. The measured
 * numbers are in `release-scale.integration.test.ts`, which prints them on every run.
 *
 * **This module is NOT WIRED IN, and that is a decision for the owner of `release.ts` rather than for this task.**
 * `release.ts` is committed and protected, so the swap is left as a measured candidate with a one-call change surface:
 * replace the `for (const { attemptId, score } of plan.scores)` loop with `writeReleasedScores(tx, ...)`. Nothing else
 * moves -- in particular the single `releaseBatch.update` that flips the batch to `RELEASED` stays one statement, which
 * is the whole of `B16`'s visibility rule.
 *
 * ## WHY THE BATCH GATE IS NOT IN SCOPE FOR THIS OPTIMISATION
 *
 * `B16` makes student visibility `EXISTS(... ReleaseBatch.status = 'RELEASED')`. The per-attempt score writes are NOT a
 * visibility decision -- they are the arithmetic's output, already computed by `planRelease` before the transaction
 * opened (`plans/07` §6.2). So batching them changes **when the numbers land**, not **who may read them**, and the
 * concurrent-reader proof in `release-atomicity.integration.test.ts` is what says so rather than this comment.
 *
 * ## WHAT THIS FILE DELIBERATELY REFUSES, AND WHY EACH ONE IS A FAILURE MODE AND NOT A TYPE
 *
 * - **A NULL SCORE.** `plan.scores` carries only attempts with a computable `finalScore`, and `percentage` is non-null
 *   whenever `finalScore` is (`computeScore` derives both from the same `maxTotal > 0` test). This writer REFUSES a
 *   null, because a `VALUES` row holding one makes Postgres infer the whole column as `text` and the failure arrives as
 *   a cast error naming a type that is not in this file.
 * - **AN ID IT DID NOT UPDATE.** `UPDATE ... FROM (VALUES ...)` matches on `a.id = v.id`, so an id that is not in the
 *   table is silently not updated. At 5,000 attempts that is a silent partial write inside the one transaction whose
 *   whole purpose is that it is not partial -- so the affected row count is summed and compared against the input, and
 *   a mismatch throws rather than committing.
 * - **SILENTLY LOSING `@updatedAt`.** `updatedAt` is Prisma's `@updatedAt`, applied by the CLIENT, so a raw `UPDATE`
 *   skips it and every batch would leave 5,000 rows with an `updatedAt` older than the release that just published
 *   them. The statement sets it explicitly. This is the difference every raw-SQL optimisation has, and it is the one no
 *   test about scores would catch.
 *
 * ## AND ONE SEMANTIC DIFFERENCE THAT IS AN IMPROVEMENT, SO IT IS RECORDED RATHER THAN IMPLEMENTED QUIETLY
 *
 * The loop stamps each attempt with `clock.now()` at the moment that attempt's statement is issued, so on a real clock
 * a release that took four seconds stamps its first member four seconds before its last. This stamps every member with
 * ONE instant, read once. `releaseAt` is then a fact about the release rather than about the order Postgres happened to
 * service 5,000 updates in, which is what a reader of that column is entitled to assume.
 */

import type { Clock } from '@orrery/clock';

/**
 * One member's score. Structural rather than `ComputedScore`, so this module does not import `release.ts` -- a
 * one-directional dependency keeps a future swap from becoming an import cycle.
 */
export interface ReleasedScoreRow {
  readonly finalScore: number | null;
  readonly percentage: number | null;
  readonly maxTotal: number;
  readonly latePenaltyApplied: number;
}

export interface ReleasedScoreInput {
  readonly attemptId: string;
  readonly score: ReleasedScoreRow;
}

/**
 * The minimum this needs. `$executeRawUnsafe` takes bind values positionally after the query, exactly as
 * `runExclusive`'s `$queryRawUnsafe` call does (`run-exclusive.ts`), so the narrow `Pick` and the explicit cast at the
 * call site are the house pattern rather than an invention here.
 */
export type BulkScoreWriter = {
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
};

/**
 * **500 ROWS PER STATEMENT**, which is 3,000 bind parameters -- a twentieth of Postgres's 65,535-parameter wire limit,
 * so the limit is not the reason for this number and the comment says so.
 *
 * The chunk count IS the round-trip count, so the chunk is chosen for latency rather than for safety: 500 rows is small
 * enough that the statement stays trivial to plan and large enough that 5,000 attempts are ten round trips rather than
 * five thousand. It is exported because a benchmark that cannot change the constant it is measuring is a benchmark
 * that reports one number forever.
 */
export const BULK_SCORE_CHUNK = 500;

export interface BulkWriteResult {
  /** Rows the database reported as updated, summed across chunks. */
  readonly rows: number;
  readonly chunks: number;
  readonly statements: number;
}

/** Postgres' wire-protocol ceiling on bind parameters in one statement. */
const PARAMETER_CEILING = 65_535;

/**
 * WRITE EVERY MEMBER'S RELEASED SCORE IN CHUNKED `UPDATE ... FROM (VALUES ...)` STATEMENTS.
 *
 * Every column is cast inside the `VALUES` list rather than left to inference, because inference is per column across
 * the WHOLE list: one row binding a JS number and another binding a string would leave the column `text`, and the
 * error names a type that is not in this file.
 */
export async function writeReleasedScores(
  tx: BulkScoreWriter,
  input: {
    readonly scores: readonly ReleasedScoreInput[];
    readonly clock: Pick<Clock, 'now'>;
    readonly chunkSize?: number;
  },
): Promise<BulkWriteResult> {
  const { scores, clock } = input;
  if (scores.length === 0) return { rows: 0, chunks: 0, statements: 0 };

  const chunkSize = chunkSizeOf(input.chunkSize);
  // INV-TIME-1: read once, from the injected clock, never `new Date()`.
  const releasedAt = new Date(clock.now());

  let rows = 0;
  let statements = 0;
  let pending: string[] = [];
  let values: unknown[] = [];

  for (const { attemptId, score } of scores) {
    if (score.finalScore === null || score.percentage === null) {
      throw new Error(
        `BULK_SCORE_WITHOUT_A_SCORE: ${attemptId} has no finalScore or no percentage. A null in a VALUES list makes ` +
          'Postgres infer the column as text and the cast fails naming a type nobody asked about, so this is refused ' +
          'by name instead.',
      );
    }
    const base = values.length;
    values.push(
      attemptId,
      String(score.finalScore),
      String(score.percentage),
      String(score.maxTotal),
      String(score.latePenaltyApplied),
      releasedAt,
    );
    pending.push(
      `($${String(base + 1)}::text, $${String(base + 2)}::numeric(9,2), $${String(base + 3)}::numeric(6,3), ` +
        `$${String(base + 4)}::numeric(9,2), $${String(base + 5)}::numeric(5,2), $${String(base + 6)}::timestamptz)`,
    );
    if (pending.length === chunkSize) {
      rows += await execute(tx, pending, values);
      statements += 1;
      pending = [];
      values = [];
    }
  }
  if (pending.length > 0) {
    rows += await execute(tx, pending, values);
    statements += 1;
  }

  /**
   * A SILENT PARTIAL WRITE IS THE ONE FAILURE A TRANSACTION EXISTS TO PREVENT, so it is checked rather than assumed.
   *
   * `UPDATE ... FROM` reports the rows it matched and updated, so this comparison is not a formality: an attempt id
   * that was deleted between `loadReleasePlan` and this statement -- or an id that was never an attempt -- shows up
   * here as a shortfall, and the batch's members and its scores would otherwise disagree with each other in a
   * transaction whose entire claim is that they cannot.
   */
  if (rows !== scores.length) {
    throw new Error(
      `BULK_SCORE_PARTIAL_WRITE: the batch has ${String(scores.length)} members but the statement updated ` +
        `${String(rows)}. Inside one transaction a partial write is the failure ` +
        'INV-RELEASE-1 exists to make impossible, so this refuses to commit rather than reporting a release.',
    );
  }

  return { rows, chunks: Math.ceil(scores.length / chunkSize), statements };
}

/**
 * THE CHUNK SIZE IS REFUSED IF IT WOULD BREACH THE WIRE LIMIT, rather than clamped.
 *
 * A clamp would answer a different question from the one the caller asked, and `P11-T2` records the same reasoning for
 * a different ceiling: a number that silently becomes a different number is a number nobody is measuring.
 */
const chunkSizeOf = (requested: number | undefined): number => {
  const size = requested ?? BULK_SCORE_CHUNK;
  if (!Number.isInteger(size) || size < 1) {
    throw new Error(
      `BULK_SCORE_CHUNK_INVALID: ${String(size)} is not a positive whole number of rows.`,
    );
  }
  if (size * 6 > PARAMETER_CEILING) {
    throw new Error(
      `BULK_SCORE_CHUNK_TOO_LARGE: ${String(size)} rows is ${String(size * 6)} bind parameters and Postgres accepts ` +
        `at most ${String(PARAMETER_CEILING)} in one statement. Lower the chunk rather than having the server refuse ` +
        'a statement whose failure would name a limit instead of the caller.',
    );
  }
  return size;
};

/**
 * ONE `UPDATE ... FROM (VALUES ...)` FOR ONE CHUNK.
 *
 * **`id` IS CAST `text`, NOT `uuid`.** `ExamAttempt.id` is `@default(uuid(7))` with no `@db.Uuid`, so the column is
 * `text` -- as `ReleaseBatchMember.attemptId` and every other identifier in this schema is. The first version of this
 * statement cast it `::uuid`, which is what a Prisma `String @id` looks like to somebody who has not read the DDL, and
 * the first run failed with `operator does not exist: text = uuid` at 5,000 rows. A schema fact that is not in the
 * schema file is a schema fact that gets guessed.
 *
 * `updatedAt` IS SET HERE EXPLICITLY, and it is the only column this statement writes that `releaseBatch`'s loop does
 * not name, for the reason in the header: Prisma's `@updatedAt` runs in the client.
 */
const execute = async (
  tx: BulkScoreWriter,
  tuples: readonly string[],
  values: readonly unknown[],
): Promise<number> =>
  tx.$executeRawUnsafe(
    `UPDATE "ExamAttempt" AS a
       SET "finalScore" = v.final_score,
           "percentage" = v.percentage,
           "maxScore" = v.max_score,
           "latePenaltyApplied" = v.late_penalty,
           "releasedAt" = v.released_at,
           "updatedAt" = now()
       FROM (VALUES ${tuples.join(', ')})
         AS v(id, final_score, percentage, max_score, late_penalty, released_at)
      WHERE a.id = v.id`,
    ...values,
  );

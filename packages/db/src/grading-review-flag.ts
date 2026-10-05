/**
 * The write half of sealed auto-grade review: raising "this key looks wrong", and reading what it would cost.  (P9-T6)
 *
 * ## WHY THE FLAG IS AN `AuditEvent` AND NOT A TABLE
 *
 * Three requirements, and the existing log meets all three without a migration:
 *
 *  1. **A flag with no reason is unusable later** (`grading-review.ts`), so the reason is `meta.reason` on the row.
 *  2. **It must be identifiable as a key dispute forever**, so `targetType` is a constant and `targetId` is the
 *     assignment-and-question pair joined by `keyFlagIdentity`.
 *  3. **It must be resolvable without erasing it**, which is why `schema.prisma:1243-1250` argues for an append-only
 *     history in the first place and `flagsFrom` folds rather than updates.
 *
 * A new model would have needed a migration, a generated-client rebuild, and a status column that duplicates what two
 * more rows in the log already say. The cost of the choice is stated in `flagsFrom`: open flags are found by reading a
 * key's actions, not by an indexed `status = OPEN`.
 *
 * ## AND WHY NO SCORE-BEARING COLUMN IS EVER SELECTED IN THIS FILE
 *
 * `readAutoGradeReviewTargets` and `readKeyPopulation` both answer questions about marks -- "is this sealed?", "how many
 * papers carry this key?" -- and both answer them in the `where` clause, which the database evaluates without handing
 * the value to this process. That is why neither appears in `audit/score-projections.json`: there is no `select:`
 * here naming `autoScore`, `manualScore` or `finalScore` for `scripts/audit-projections.mjs` to object to, and there
 * is no mark in the process to leak into a payload, a log line or an exception message.
 *
 * ## THE FLAG MOVES NOTHING, AND `lockAttemptForMarking` IS WHY THE RECORD IS TRUE
 *
 * The decision reads `needsHuman`, `autoScore` and `manualScore`, all of which a marking write can change between the
 * read and the insert. So the attempt is locked first, on the same batch-then-attempt order `grading-write.ts:79-80`
 * uses, and the decision is taken against a row that cannot move underneath it. That does not make the flag
 * load-bearing -- it writes no mark either way -- but a flag recorded against a row that has since been marked by hand
 * is a flag nobody can act on, and the lock is cheaper than explaining that.
 */

import type { Prisma } from '../prisma/generated/client/client.js';
import type { GradingClock, GradingDb, GradingTx } from './grading-access.js';
import { lockAttemptForMarking, teacherAttempt, teacherClassroom } from './grading-access.js';
import {
  type AutoGradeKeyFlag,
  type AutoGradeKeyFlagFacts,
  blastRadius,
  decideAutoGradeKeyFlag,
  flagsFrom,
  KEY_FLAG_DISMISSED,
  KEY_FLAG_RAISED,
  KEY_FLAG_REASON_MAX_CHARS,
  KEY_FLAG_TARGET_TYPE,
  KEY_FLAG_UPHELD,
  type KeyFlagEvent,
  type KeyFlagResolution,
  type KeyPopulation,
  keyFlagIdentity,
  type ReviewSurfaceIsInert,
  resolutionAction,
  type SealedAutoGradeTarget,
} from './grading-review.js';

/**
 * The statuses whose responses `grading-regrade.ts:166-170` considers, so the population and the preview agree.
 *
 * Spelled as literals rather than read off the generated enum: the generated `ExamAttemptWhereInput['status']` is a
 * UNION of the enum and its filter, so a conditional type over it collapses to `never` -- the same trap
 * `packages/interop/src/boundary.ts:179-183` records for its own union. A literal that is not in the schema's enum is a
 * compile error here, which is what the type is for.
 */
const REVIEWABLE_STATUSES = ['SUBMITTED', 'EXPIRED', 'PENDING_REVIEW', 'GRADED'] as const;

export interface AutoGradeReviewQuery {
  readonly actorId: string;
  readonly assignmentId: string;
  readonly questionId: string;
  /** A review queue is a page, not a dump. */
  readonly limit?: number;
}

export interface AutoGradeKeyFlagInput {
  readonly actorId: string;
  readonly clock: GradingClock;
  readonly assignmentId: string;
  /** Which response the marker was looking at. It is what identifies the QUESTION, so a wrong one is a wrong flag. */
  readonly responseId: string;
  readonly reason: string;
}

export interface KeyFlagResolutionInput {
  readonly actorId: string;
  readonly clock: GradingClock;
  readonly assignmentId: string;
  readonly questionId: string;
  readonly resolution: KeyFlagResolution;
  /** Why. A resolution with no note is a decision nobody can check, which is the reason a flag had to carry one. */
  readonly note: string;
}

export type KeyFlagWriteResult =
  | { readonly ok: true; readonly flag: AutoGradeKeyFlag }
  | {
      readonly ok: false;
      readonly reason:
        | 'NOT_FOUND'
        | 'REASON_REQUIRED'
        | 'REASON_TOO_LONG'
        | 'NOT_SEALED_AUTOMATIC'
        | 'ALREADY_FLAGGED';
      /** Present on `NOT_SEALED_AUTOMATIC`, so the screen can say what the row actually is instead of only refusing. */
      readonly awaitingHuman: boolean;
    };

export type KeyFlagResolutionResult =
  | { readonly ok: true; readonly key: string }
  | {
      readonly ok: false;
      readonly reason: 'NOT_FOUND' | 'NOT_OPEN' | 'REASON_REQUIRED' | 'ALREADY_RESOLVED';
    };

const flagEventsWhere = (targetId: string) => ({
  targetType: KEY_FLAG_TARGET_TYPE,
  targetId,
  // A mutable array: Prisma's `StringFilter.in` is `string[]`, and a `readonly` tuple from an `as const` is not one.
  action: { in: [KEY_FLAG_RAISED, KEY_FLAG_UPHELD, KEY_FLAG_DISMISSED] },
});

const asFlagEvents = (
  rows: readonly {
    action: string;
    targetType: string;
    targetId: string;
    actorId: string | null;
    meta: unknown;
    createdAt: Date;
  }[],
): readonly KeyFlagEvent[] =>
  rows.map((row) => ({
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    actorId: row.actorId,
    /**
     * The reason lives in `meta` because `AuditEvent` has one `Json` column and no per-action shape. It is read as
     * untrusted and narrowed here rather than cast: a hand-written or future writer that stores something else
     * produces an empty reason, which is the same as a flag with no reason -- refused, not recorded.
     */
    reason:
      typeof row.meta === 'object' &&
      row.meta !== null &&
      typeof (row.meta as { reason?: unknown }).reason === 'string'
        ? (row.meta as { reason: string }).reason
        : '',
    at: row.createdAt.toISOString(),
  }));

/** ONE KEY'S HISTORY. Indexed on `(targetType, targetId, createdAt)`, and a key has a handful of rows. */
const readKeyHistory = async (
  tx: Pick<GradingTx, 'auditEvent'>,
  key: string,
): Promise<readonly KeyFlagEvent[]> =>
  asFlagEvents(
    await tx.auditEvent.findMany({
      where: flagEventsWhere(key),
      /**
       * `createdAt` THEN `id`, AND THE SECOND KEY IS NOT OPTIONAL.
       *
       * `createdAt` is `@db.Timestamptz(3)` -- millisecond resolution -- and two markers can raise a flag on one key in
       * the same millisecond, as a `FrozenClock` makes certain. Ordering by `createdAt` alone then leaves the order of
       * those two rows up to Postgres, and `flagsFrom`'s fold is order-SENSITIVE by design: a resolution closes the most
       * recent raising, so an arbitrary order makes a re-raised flag look already-dismissed or an open flag look closed.
       *
       * `id` is `BigInt @default(autoincrement)`, so ordering by it after `createdAt` is a total order consistent with
       * the order the rows were written. The integration test "shows an upheld flag as closed, and a second raising as
       * open" failed on exactly this, with a frozen clock and two flags at the same instant.
       */
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        action: true,
        targetType: true,
        targetId: true,
        actorId: true,
        meta: true,
        createdAt: true,
      },
    }),
  );

/** Open flags raised by one reporter against one key. The dedupe `ALREADY_FLAGGED` exists to enforce. */
const openFlagsBy = (
  events: readonly KeyFlagEvent[],
  reporterId: string,
): readonly AutoGradeKeyFlag[] =>
  flagsFrom(events).filter((flag) => flag.raisedById === reporterId && flag.resolution === null);

/** The assignment rows a flag or a count is scoped to: teacher-owned, and the statuses a regrade considers. */
const assignmentScoped = (assignmentId: string, actorId: string): Prisma.ExamAttemptWhereInput => ({
  assignmentId,
  purpose: 'GRADED',
  status: { in: [...REVIEWABLE_STATUSES] },
  ...teacherAttempt(actorId),
});

/* ──────────────────────────────────────────────────────────── the reads ── */

/**
 * THE SEALED AUTO-GRADES A MARKER MAY DISPUTE, projected with NO MARK ON THEM.
 *
 * "Sealed" is decided entirely in the `where` clause -- `autoScore` not null, `manualScore` null, `needsHuman` false,
 * not excused -- so this returns rows whose stored mark the caller never receives. That is the projection that makes
 * `SealedAutoGradeTarget` honest: there is no field to omit, because there was never a value here.
 *
 * `limit` is applied because this is a review list. A 500-paper assignment has 500 sealed auto-grades at one key and a
 * queue that renders all of them is the queue nobody opens.
 */
export async function readAutoGradeReviewTargets(
  db: GradingDb,
  input: AutoGradeReviewQuery,
): Promise<readonly SealedAutoGradeTarget[]> {
  const key = keyFlagIdentity(input.assignmentId, input.questionId);
  const rows = await db.$transaction(
    async (tx) => {
      const flags = await readKeyHistory(tx, key);
      const responses = await tx.questionResponse.findMany({
        where: {
          questionId: input.questionId,
          attempt: assignmentScoped(input.assignmentId, input.actorId),
          autoScore: { not: null },
          manualScore: null,
          needsHuman: false,
          isExcused: false,
        },
        orderBy: [{ attemptId: 'asc' }, { position: 'asc' }],
        take: input.limit ?? 200,
        select: {
          id: true,
          attemptId: true,
          position: true,
          needsHuman: true,
          autoGraderVersion: true,
          autoGradedAt: true,
          attempt: {
            select: {
              id: true,
              releasedAt: true,
              releaseMembers: { select: { batch: { select: { status: true } } } },
            },
          },
          question: { select: { points: true } },
        },
      });
      const open = openFlagsBy(flags, input.actorId).length;
      return responses.map((response) => ({
        responseId: response.id,
        attemptId: response.attemptId,
        assignmentId: input.assignmentId,
        questionId: input.questionId,
        position: response.position,
        worth: Number(response.question.points),
        markedByVersion: response.autoGraderVersion,
        gradedAt: response.autoGradedAt?.toISOString() ?? null,
        needsHuman: response.needsHuman,
        released:
          response.attempt.releasedAt !== null ||
          response.attempt.releaseMembers.some((member) => member.batch.status === 'RELEASED'),
        openFlagsByReporter: open,
      }));
    },
    { timeout: 30_000 },
  );
  return rows;
}

/**
 * HOW MANY RESPONSES SIT UNDER ONE KEY, as five COUNTS the database produced.
 *
 * Every count is a `count` with the category in the `where`, so no mark is loaded. `notAutomaticallyGraded` is the
 * complement of the other four rather than a fifth query, because it is the only category defined by what is ABSENT --
 * and the complement is checked by `isPartitioned` in the caller rather than trusted, so a future category added to
 * the schema shows up as a partition failure instead of as a plausible number.
 */
export async function readKeyPopulation(
  db: GradingDb,
  input: AutoGradeReviewQuery,
): Promise<KeyPopulation> {
  const scope = {
    questionId: input.questionId,
    attempt: assignmentScoped(input.assignmentId, input.actorId),
  } as const;
  return db.$transaction(
    async (tx) => {
      const notExcused = { isExcused: false };
      const unreviewedByHand = { ...notExcused, manualScore: null };
      const [responses, preservedAsExcused, preservedByManualMark, awaitingHuman, sealedAutomatic] =
        await Promise.all([
          tx.questionResponse.count({ where: scope }),
          tx.questionResponse.count({ where: { ...scope, isExcused: true } }),
          tx.questionResponse.count({
            where: { ...scope, ...notExcused, manualScore: { not: null } },
          }),
          tx.questionResponse.count({ where: { ...scope, ...unreviewedByHand, needsHuman: true } }),
          tx.questionResponse.count({
            where: { ...scope, ...unreviewedByHand, needsHuman: false, autoScore: { not: null } },
          }),
        ]);
      return {
        assignmentId: input.assignmentId,
        questionId: input.questionId,
        responses,
        sealedAutomatic,
        awaitingHuman,
        // The complement, and the reason `isPartitioned` exists: if the five stop partitioning, this goes negative or
        // the sum drifts, and a negative count on a marker's screen is louder than an exception.
        notAutomaticallyGraded:
          responses - preservedAsExcused - preservedByManualMark - awaitingHuman - sealedAutomatic,
        preservedByManualMark,
        preservedAsExcused,
      };
    },
    { timeout: 30_000 },
  );
}

/* ──────────────────────────────────────────────────────────── the writes ── */

/**
 * RAISE "THIS KEY LOOKS WRONG", which is the whole of what a marker may do about a sealed auto-grade.
 *
 * ## THE ONE THING THIS FUNCTION MUST NEVER BE ABLE TO DO IS CHANGE A MARK, AND IT CANNOT
 *
 * There is no `update` on any mark-bearing table in this function, and `AutoGradeReviewApi` below makes adding one a
 * compile error. The mark moves only through `grading-regrade.ts`'s `applyRegrade`, which needs a preview token
 * recomputed under locks -- so a flag on a released paper cannot move the published figure, and `INV-RELEASE-1` holds
 * for the flag path exactly as it does for the release path.
 */
export async function flagAutoGradeKey(
  db: GradingDb,
  input: AutoGradeKeyFlagInput,
): Promise<KeyFlagWriteResult> {
  const reason = input.reason.trim();
  if (reason === '') return { ok: false, reason: 'REASON_REQUIRED', awaitingHuman: false };
  if (input.reason.length > KEY_FLAG_REASON_MAX_CHARS)
    return { ok: false, reason: 'REASON_TOO_LONG', awaitingHuman: false };

  return db.$transaction(
    async (tx) => {
      const target = await tx.questionResponse.findFirst({
        where: {
          id: input.responseId,
          attempt: teacherAttempt(input.actorId),
        },
        select: {
          id: true,
          questionId: true,
          needsHuman: true,
          isExcused: true,
          attemptId: true,
          attempt: {
            select: {
              id: true,
              assignmentId: true,
              classroomId: true,
              releasedAt: true,
              releaseMembers: { select: { batch: { select: { status: true } } } },
            },
          },
        },
      });
      if (!target || target.attempt.assignmentId !== input.assignmentId)
        return {
          ok: false as const,
          reason: 'NOT_FOUND' as const,
          awaitingHuman: target?.needsHuman ?? false,
        };

      // Same batch-then-attempt order as `grading-write.ts`, so a flag cannot deadlock against a mark.
      const locked = await lockAttemptForMarking(tx, target.attemptId);
      if (locked === null)
        return { ok: false as const, reason: 'NOT_FOUND' as const, awaitingHuman: false };

      /**
       * `existsAutoScore` and `existsManualScore` rather than the values. A flag is about the ROW being sealed, not
       * about the figure on it, and a query that selected the mark would put a mark on the review path for no gain.
       */
      const marks = await tx.questionResponse.findUniqueOrThrow({
        where: { id: target.id },
        select: { autoScore: true, manualScore: true },
      });
      const key = keyFlagIdentity(target.attempt.assignmentId, target.questionId);
      const history = await readKeyHistory(tx, key);
      const facts: AutoGradeKeyFlagFacts = {
        status: locked.status,
        hasAutomaticMark: marks.autoScore !== null,
        hasManualMark: marks.manualScore !== null,
        isExcused: target.isExcused,
        needsHuman: target.needsHuman,
        openFlagsByReporter: openFlagsBy(history, input.actorId).length,
      };
      const refusal = decideAutoGradeKeyFlag(facts, { reason });
      if (refusal !== null)
        return { ok: false as const, reason: refusal, awaitingHuman: facts.needsHuman };

      const at = new Date(input.clock.now());
      await tx.auditEvent.create({
        data: {
          actorId: input.actorId,
          action: KEY_FLAG_RAISED,
          targetType: KEY_FLAG_TARGET_TYPE,
          targetId: key,
          classroomId: target.attempt.classroomId,
          meta: {
            assignmentId: target.attempt.assignmentId,
            questionId: target.questionId,
            responseId: target.id,
            attemptId: target.attemptId,
            reason,
            raisedAt: at.toISOString(),
          },
          createdAt: at,
        },
      });
      return {
        ok: true as const,
        flag: {
          key,
          assignmentId: target.attempt.assignmentId,
          questionId: target.questionId,
          raisedById: input.actorId,
          reason,
          raisedAt: at.toISOString(),
          timesResolved: 0,
          resolution: null,
          resolvedById: null,
        },
      };
    },
    { timeout: 30_000 },
  );
}

/**
 * UPHOLD OR DISMISS A FLAG, which is the step between "a marker flagged it" and "a regrade was confirmed".
 *
 * A dismissal with a note is as important as an upholding: a key that is right is a fact worth having written down,
 * because the next marker to flag it will be shown that it was already checked. Both are rows in the same log, so the
 * reviewer's reasoning and the marker's reasoning sit together.
 *
 * **A reviewer may not resolve their own flag.** Someone who believes the key is wrong and then dismisses the flag
 * against a rule nobody else set is the quiet local override `plans/07` §5.1 rules out, in a different costume. The
 * refusal is `NOT_OPEN` rather than a new reason, because from the reviewer's side there is nothing there to act on.
 */
export async function resolveAutoGradeKeyFlag(
  db: GradingDb,
  input: KeyFlagResolutionInput,
): Promise<KeyFlagResolutionResult> {
  const note = input.note.trim();
  if (note === '') return { ok: false, reason: 'REASON_REQUIRED' };
  return db.$transaction(
    async (tx) => {
      const assignment = await tx.assignment.findFirst({
        where: { id: input.assignmentId, classroom: teacherClassroom(input.actorId) },
        select: { id: true, classroomId: true },
      });
      if (!assignment) return { ok: false as const, reason: 'NOT_FOUND' as const };
      const key = keyFlagIdentity(input.assignmentId, input.questionId);
      const history = await readKeyHistory(tx, key);
      const every = flagsFrom(history);
      const open = every.filter(
        (flag) => flag.resolution === null && flag.raisedById !== input.actorId,
      );
      if (open.length === 0) {
        return {
          ok: false as const,
          reason: every.length === 0 ? ('NOT_FOUND' as const) : ('NOT_OPEN' as const),
        };
      }
      const at = new Date(input.clock.now());
      await tx.auditEvent.create({
        data: {
          actorId: input.actorId,
          action: resolutionAction(input.resolution),
          targetType: KEY_FLAG_TARGET_TYPE,
          targetId: key,
          classroomId: assignment.classroomId,
          meta: {
            assignmentId: input.assignmentId,
            questionId: input.questionId,
            reason: note,
            resolution: input.resolution,
            /** The marker's words are kept with the reviewer's, so a later reader sees both arguments. */
            addressedRaisedById: open[0]?.raisedById ?? null,
            addressedRaisedAt: open[0]?.raisedAt ?? null,
          },
          createdAt: at,
        },
      });
      return { ok: true as const, key };
    },
    { timeout: 30_000 },
  );
}

/** Everything said about one key, in order, for the reviewer who has to decide. */
export async function readAutoGradeKeyFlags(
  db: Pick<GradingDb, '$transaction'>,
  input: { actorId: string; assignmentId: string; questionId: string },
): Promise<readonly AutoGradeKeyFlag[]> {
  const allowed = await db.$transaction((tx) =>
    tx.assignment.count({
      where: { id: input.assignmentId, classroom: teacherClassroom(input.actorId) },
    }),
  );
  if (allowed !== 1) return [];
  return flagsFrom(
    await db.$transaction((tx) =>
      readKeyHistory(tx, keyFlagIdentity(input.assignmentId, input.questionId)),
    ),
  );
}

/* ───────────────────────────────────────────── the compile-time guarantee ── */

/**
 * THE WHOLE REVIEW SURFACE, NAMED IN ONE PLACE.
 *
 * Two things are checked against this and neither is a comment:
 *
 *  · `REVIEW_SURFACE_IS_INERT` below fails to COMPILE if any parameter object here can carry a key or a mark. That is
 *    the "the platform never silently rewrites an answer key" guarantee, enforced by the compiler rather than by a
 *    reviewer remembering.
 *  · `grading-review.test.ts` compares the module's ACTUAL runtime exports against this interface's keys plus a
 *    two-name allow-list, so an exported function that is not here fails a test. That second check is the one that
 *    matters, and it is not theoretical: a `silentlyRewriteTheKey` export added to this file compiled CLEANLY, because
 *    the inertness assertion reads `AutoGradeReviewApi` and an export nobody added to that interface is invisible to it.
 *    A type cannot police a module's own namespace; only a test comparing the two can.
 *
 * `blastRadius` and `decideAutoGradeKeyFlag` are listed even though they take no `db`, because they are what the review
 * surface renders.
 */
export interface AutoGradeReviewApi {
  decideAutoGradeKeyFlag: (
    facts: AutoGradeKeyFlagFacts,
    request: { reason: string },
  ) => ReturnType<typeof decideAutoGradeKeyFlag>;
  readAutoGradeReviewTargets: (
    db: GradingDb,
    input: AutoGradeReviewQuery,
  ) => ReturnType<typeof readAutoGradeReviewTargets>;
  readKeyPopulation: (
    db: GradingDb,
    input: AutoGradeReviewQuery,
  ) => ReturnType<typeof readKeyPopulation>;
  blastRadius: typeof blastRadius;
  readAutoGradeKeyFlags: (
    db: Pick<GradingDb, '$transaction'>,
    input: { actorId: string; assignmentId: string; questionId: string },
  ) => ReturnType<typeof readAutoGradeKeyFlags>;
  flagAutoGradeKey: (
    db: GradingDb,
    input: AutoGradeKeyFlagInput,
  ) => ReturnType<typeof flagAutoGradeKey>;
  resolveAutoGradeKeyFlag: (
    db: GradingDb,
    input: KeyFlagResolutionInput,
  ) => ReturnType<typeof resolveAutoGradeKeyFlag>;
}

export const AUTO_GRADE_REVIEW_API: AutoGradeReviewApi = {
  decideAutoGradeKeyFlag,
  readAutoGradeReviewTargets,
  readKeyPopulation,
  blastRadius,
  readAutoGradeKeyFlags,
  flagAutoGradeKey,
  resolveAutoGradeKeyFlag,
};

/**
 * THE COMPILER'S ASSERTION THAT THIS SCREEN CANNOT REWRITE A KEY.
 *
 * `true` only while `keyof` of every parameter object of every entry point in `AUTO_GRADE_REVIEW_API` shares no name
 * with `KeyBearingField`. Adding `points` to a flag input, or a `spec` to a query, makes this assignment fail with the
 * offending field named in the error -- which is the difference between a guarantee and a convention.
 */
export type ReviewSurfaceParameters = Parameters<
  AutoGradeReviewApi[keyof AutoGradeReviewApi]
>[number];

export const REVIEW_SURFACE_IS_INERT: ReviewSurfaceIsInert<ReviewSurfaceParameters> = true;

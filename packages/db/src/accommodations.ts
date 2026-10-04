/**
 * Granting and revoking an accommodation, including MID-EXAM.  (P8-T12, `INV-ACC-1`, `C14`)
 *
 * ## WHY "MID-EXAM" IS THE WHOLE PROBLEM
 *
 * An accommodation granted before an attempt starts is easy: nobody is waiting. Granted twenty minutes into a live
 * attempt it is not, and three things have to be true that are not true at attempt start:
 *
 *   1. **The relaxation has to reach a RUNNING CLIENT.** The server can stop counting strikes immediately; the browser
 *      guard cannot stop nagging until it hears about it. So the grant is written where the client will pick it up on its
 *      next sync, and the client's own read of "which relaxations apply" is what silences the guard.
 *   2. **Extra time must NOT rewrite `deadlineAt`.** `INV-POLICY-1`/`C14`: `deadlineAt` is never rewritten, extensions
 *      are ADDITIVE rows. Assigning a recomputed deadline would discard every extension already granted, because the new
 *      value is computed from the base rather than from what is in force.
 *   3. **A student mid-exam must be able to SEE it.** A grant that silently extends a student's time leaves them with a
 *      countdown they do not know about, which is indistinguishable from the clock being wrong -- and the correct
 *      response to a clock that looks wrong is to panic.
 *
 * ## AND THE CLIENT'S REQUEST IS NOT THE AUTHORITY
 *
 * `INV-TELEMETRY-1`: client events are evidence, never truth. A client that asks "what am I exempt from?" is asking, not
 * deciding -- the answer comes from the `Accommodation` row. A client that asserts "I am exempt" is refused, which is
 * why `activeRelaxationsFor` takes an attempt id and reads the database rather than accepting a list.
 */

import { extraTimeSeconds, type GrantedRelaxation } from '@orrery/exam-engine/accommodations';

import type { PrismaClient } from '../prisma/generated/client/client.js';

export type AccommodationDb = Pick<
  PrismaClient,
  | 'accommodation'
  | 'examAttempt'
  | 'attemptDeadlineExtension'
  | 'attemptEventRecord'
  | '$transaction'
>;

export interface GrantInput {
  readonly studentId: string;
  readonly classroomId: string;
  /** `null` for a standing accommodation; otherwise it applies to one assignment. */
  readonly assignmentId?: string | null;
  readonly relaxations: readonly GrantedRelaxation[];
  /** A share of the paper's total. Ignored unless `EXTRA_TIME_PERCENT` is among the relaxations. */
  readonly extraTimePercent?: number | null;
  /** Required, and never optional: an accommodation with no stated reason cannot be challenged by the student. */
  readonly reason: string;
  readonly grantedById: string;
  /** `INV-TIME-1`: injected. */
  readonly nowMs: number;
}

export type GrantRefusal =
  | 'NO_REASON'
  | 'NO_RELAXATIONS'
  | 'STUDENT_NOT_IN_CLASSROOM'
  | 'ATTEMPT_NOT_IN_PROGRESS';

export type GrantResult =
  | {
      readonly ok: true;
      readonly accommodationId: string;
      /** Seconds added to a live attempt, as an ADDITIVE extension row. `0` when nothing live was extended. */
      readonly addedSec: number;
      /** The attempt the extension landed on, or `null` when the student has none running. */
      readonly extendedAttemptId: string | null;
    }
  | { readonly ok: false; readonly reason: GrantRefusal; readonly message: string };

const MIN_REASON = 10;

/**
 * GRANT AN ACCOMMODATION, and extend a live attempt's time if there is one.
 *
 * The accommodation row and the deadline extension are written in ONE transaction: a relaxation the client can see but
 * a clock that did not move is a student who was told nothing and given nothing, and there is no reconciliation for that
 * after the fact.
 */
export const grantAccommodation = async (
  db: AccommodationDb,
  input: GrantInput,
): Promise<GrantResult> => {
  if (input.relaxations.length === 0) {
    return {
      ok: false,
      reason: 'NO_RELAXATIONS',
      message:
        'an accommodation with no relaxations grants nothing, and would look like a record of one',
    };
  }
  // A relaxation a student cannot challenge is indistinguishable from one they were never told about. `INV-ACC-1` makes
  // a zero-violation guarantee, so the reason is the only thing standing between the student and an unexplained gap in
  // their own record.
  if (input.reason.trim().length < MIN_REASON) {
    return {
      ok: false,
      reason: 'NO_REASON',
      message: `an accommodation needs a reason of at least ${String(MIN_REASON)} characters, so the student can challenge it`,
    };
  }

  return db.$transaction(async (tx) => {
    const accommodation = await tx.accommodation.create({
      data: {
        classroomId: input.classroomId,
        studentId: input.studentId,
        assignmentId: input.assignmentId ?? null,
        relaxations: [...input.relaxations],
        extraTimePercent: input.extraTimePercent ?? null,
        reason: input.reason.trim(),
        grantedById: input.grantedById,
        grantedAt: new Date(input.nowMs),
        status: 'ACTIVE',
      },
      select: { id: true },
    });

    /**
     * THE LIVE ATTEMPT. At most one: "single active attempt" is a database invariant (`B12`), so a count of 1 is the
     * expected shape and more than one would mean the invariant is broken rather than that this needs handling.
     */
    const live = await tx.examAttempt.findFirst({
      where: {
        studentId: input.studentId,
        classroomId: input.classroomId,
        status: 'IN_PROGRESS',
        ...(input.assignmentId ? { assignmentId: input.assignmentId } : {}),
      },
      select: { id: true, policySnapshot: true },
      orderBy: { startedAt: 'desc' },
    });

    let addedSec = 0;
    if (live !== null && input.relaxations.includes('EXTRA_TIME_PERCENT')) {
      const snapshot = live.policySnapshot as { totalTimeLimitSec?: number | null } | null;
      const totalSec = snapshot?.totalTimeLimitSec ?? null;

      if (totalSec !== null && totalSec !== undefined) {
        /**
         * A DELTA, WRITTEN AS A ROW. See the header: `deadlineAt` is never rewritten, and this is the only shape in
         * which granting twice means adding twice.
         */
        addedSec = extraTimeSeconds(totalSec, input.extraTimePercent ?? 0);
        if (addedSec > 0) {
          await tx.attemptDeadlineExtension.create({
            data: {
              attemptId: live.id,
              addedSec,
              reason: input.reason.trim(),
              // The extension row's author column is `actorId`, not `grantedById` -- same author, different name.
              actorId: input.grantedById,
            },
          });
          await tx.attemptEventRecord.create({
            data: {
              attemptId: live.id,
              type: 'DEADLINE_EXTENDED',
              serverTs: new Date(input.nowMs),
              // The payload names the accommodation, so a later question "why does this attempt have extra time" has an
              // answer that points at the grant rather than at an unexplained number of seconds.
              payload: { addedSec, accommodationId: accommodation.id, reason: input.reason.trim() },
            },
          });
        }
      }
    }

    return {
      ok: true as const,
      accommodationId: accommodation.id,
      addedSec,
      extendedAttemptId: addedSec > 0 ? (live?.id ?? null) : null,
    };
  });
};

/**
 * REVOKE AN ACCOMMODATION.
 *
 * ## AND IT DOES NOT TAKE THE TIME BACK
 *
 * A student who has already spent the extra time cannot un-spend it, and shortening `deadlineAt` mid-exam is exactly
 * the class of bug `V-12` corrected: an automatic, irreversible change to a live attempt made by the platform rather than
 * a person. So revocation stops FUTURE relaxations from applying -- the row's status, which the client reads on its next
 * sync -- and leaves the granted extension in place.
 *
 * A teacher who genuinely needs to remove time has `AttemptDeadlineExtension` to delete by hand, with the audit trail
 * that implies.
 */
export const revokeAccommodation = async (
  db: Pick<
    AccommodationDb,
    'accommodation' | 'examAttempt' | 'attemptEventRecord' | '$transaction'
  >,
  input: { readonly accommodationId: string; readonly revokedById: string; readonly nowMs: number },
): Promise<
  { ok: true } | { ok: false; reason: 'NOT_FOUND' | 'ALREADY_REVOKED'; message: string }
> => {
  const existing = await db.accommodation.findUnique({
    where: { id: input.accommodationId },
    select: { id: true, status: true, studentId: true, classroomId: true },
  });

  if (existing === null)
    return { ok: false, reason: 'NOT_FOUND', message: 'this accommodation does not exist' };
  if (existing.status !== 'ACTIVE') {
    return {
      ok: false,
      reason: 'ALREADY_REVOKED',
      message: 'this accommodation is already revoked',
    };
  }

  /**
   * THE EVENT GOES ON A LIVE ATTEMPT, IF THERE IS ONE.
   *
   * **The first version wrote `attemptId: existing.studentId`, which is simply wrong** -- it put a user id in a column
   * that references `ExamAttempt`, so the insert failed on the foreign key for every student with a running attempt.
   * An integration test caught it in one run, which is the entire argument for having them.
   *
   * And the underlying question is real: a revocation is a fact about an ACCOMMODATION, which outlives any attempt, so
   * there is not always an attempt to hang it on. `Accommodation.revokedAt` is the durable record and always carries it.
   * The attempt event is the *additional* evidence that the relaxation changed while a student was sitting an exam, and
   * where there is no live attempt there is nothing to contradict.
   */
  const live = await db.examAttempt.findFirst({
    where: {
      studentId: existing.studentId,
      classroomId: existing.classroomId,
      status: 'IN_PROGRESS',
    },
    select: { id: true },
  });

  await db.$transaction(async (tx) => {
    await tx.accommodation.update({
      where: { id: input.accommodationId },
      data: { status: 'REVOKED', revokedAt: new Date(input.nowMs) },
    });

    if (live !== null) {
      await tx.attemptEventRecord.create({
        data: {
          attemptId: live.id,
          type: 'ACCOMMODATION_APPLIED',
          serverTs: new Date(input.nowMs),
          // `ACCOMMODATION_APPLIED` with `revoked: true`, because the enum has no revoke member and adding one would
          // split the audit vocabulary across two spellings of the same fact.
          payload: {
            accommodationId: input.accommodationId,
            revoked: true,
            revokedById: input.revokedById,
          },
        },
      });
    }
  });

  return { ok: true };
};

/**
 * THE RELAXATIONS IN FORCE FOR AN ATTEMPT RIGHT NOW -- what the client silences its guards by.
 *
 * ## WHY THIS READS THE DATABASE AND NOT THE REQUEST
 *
 * Because a client that could assert its own exemptions would be an integrity system defeated by a single line of
 * JavaScript. This is the read side of `INV-TELEMETRY-1` applied to accommodations: the client asks, the server answers,
 * and the answer comes from a row a teacher wrote.
 *
 * `expiresAt` is honoured here rather than by a sweeper, because an accommodation that lapses at 09:00 and keeps
 * applying until somebody notices is worse than one that needs a job to expire it.
 */
export const activeRelaxationsFor = async (
  db: Pick<PrismaClient, 'accommodation'>,
  input: {
    readonly studentId: string;
    readonly classroomId: string;
    readonly assignmentId?: string | null;
    readonly nowMs: number;
  },
): Promise<readonly GrantedRelaxation[]> => {
  const rows = await db.accommodation.findMany({
    where: {
      studentId: input.studentId,
      classroomId: input.classroomId,
      status: 'ACTIVE',
      // Either a standing accommodation (no assignment) or one aimed at this assignment.
      OR: [
        { assignmentId: null },
        ...(input.assignmentId ? [{ assignmentId: input.assignmentId }] : []),
      ],
    },
    select: { relaxations: true, expiresAt: true },
  });

  const active = new Set<GrantedRelaxation>();
  for (const row of rows) {
    if (row.expiresAt !== null && row.expiresAt.getTime() <= input.nowMs) continue;
    for (const relaxation of row.relaxations) active.add(relaxation as GrantedRelaxation);
  }
  return [...active];
};

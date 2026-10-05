import { can } from '@orrery/auth/can';
import type { Action, Actor } from '@orrery/auth/types';
import type { Clock } from '@orrery/clock';
import { effectiveDeadline } from './assignment-overrides.js';
import { classroomCanInput } from './classrooms.js';
import type { PrismaClient, TxClient } from './index.js';

export type AttemptException =
  | { kind: 'EXCUSE' }
  | { kind: 'MARK_MISSING' }
  | { kind: 'MARK_LATE'; isLate: boolean }
  | { kind: 'EXTEND_DEADLINE'; addedSec: number };
export type ExceptionRefusal =
  | 'NO_REASON'
  | 'FORBIDDEN'
  | 'ATTEMPT_NOT_FOUND'
  | 'INVALID_STATE'
  | 'WINDOW_OPEN'
  | 'INVALID_EXTENSION'
  | 'NO_DEADLINE'
  | 'RELEASE_STARTED';
export type ExceptionDecision =
  | {
      ok: true;
      event: 'EXCUSED' | 'MISSING' | 'LATE_MARKED' | 'DEADLINE_EXTENDED';
      status?: 'EXCUSED' | 'MISSING';
    }
  | { ok: false; reason: ExceptionRefusal };
export type ExceptionResult =
  | (Extract<ExceptionDecision, { ok: true }> & {
      /** Only for `EXTEND_DEADLINE`: the instant to TELL the student, base plus every grant and pause. */
      effectiveDeadlineAt?: Date;
    })
  | Extract<ExceptionDecision, { ok: false }>;

/**
 * Each fact asks the kernel its OWN verb. Folding all four into `update` would be the wrong door:
 * `excuse` is a separate verb in `@orrery/auth` precisely so its rule can differ from editing.
 */
export const EXCEPTION_VERB = {
  EXCUSE: 'excuse',
  MARK_MISSING: 'excuse',
  MARK_LATE: 'grade',
  EXTEND_DEADLINE: 'update',
} as const satisfies Record<AttemptException['kind'], Action>;

export function decideAttemptException(input: {
  status: string;
  reason: string;
  windowClosesAt: number | null;
  deadlineAt: number | null;
  releaseStarted: boolean;
  now: number;
  action: AttemptException;
}): ExceptionDecision {
  if (input.reason.trim().length < 10) return { ok: false, reason: 'NO_REASON' };
  if (input.releaseStarted) return { ok: false, reason: 'RELEASE_STARTED' };
  switch (input.action.kind) {
    case 'EXCUSE':
      return input.status === 'NOT_STARTED'
        ? { ok: true, event: 'EXCUSED', status: 'EXCUSED' }
        : { ok: false, reason: 'INVALID_STATE' };
    case 'MARK_MISSING':
      if (input.status !== 'NOT_STARTED') return { ok: false, reason: 'INVALID_STATE' };
      if (input.windowClosesAt === null || input.now <= input.windowClosesAt)
        return { ok: false, reason: 'WINDOW_OPEN' };
      return { ok: true, event: 'MISSING', status: 'MISSING' };
    case 'MARK_LATE':
      return ['SUBMITTED', 'EXPIRED', 'PENDING_REVIEW', 'GRADED'].includes(input.status)
        ? { ok: true, event: 'LATE_MARKED' }
        : { ok: false, reason: 'INVALID_STATE' };
    case 'EXTEND_DEADLINE':
      if (input.status !== 'IN_PROGRESS') return { ok: false, reason: 'INVALID_STATE' };
      if (input.deadlineAt === null) return { ok: false, reason: 'NO_DEADLINE' };
      if (
        !Number.isSafeInteger(input.action.addedSec) ||
        input.action.addedSec <= 0 ||
        input.action.addedSec > 2_147_483_647
      )
        return { ok: false, reason: 'INVALID_EXTENSION' };
      return { ok: true, event: 'DEADLINE_EXTENDED' };
  }
}

/**
 * `plans/07` §8: excused leaves BOTH sums always; missing leaves the denominator only where the
 * assignment says so. Not yet called by the gradebook -- `Assignment.missingExcludedFromGradebook`
 * is inert until `report-gradebook.ts` reads it through this.
 */
export function gradebookIncluded(status: string, missingExcludedFromGradebook: boolean): boolean {
  if (status === 'EXCUSED' || status === 'VOIDED') return false;
  return status !== 'MISSING' || !missingExcludedFromGradebook;
}

/**
 * Ask `can()` about the REAL subject type inside the classroom scope `classroomCanInput` loads.
 *
 * `permit` would ask the `Classroom` rules, where `update` is owner-only and a co-teacher could
 * not extend a deadline. `ownerId` stays the CLASSROOM owner: the kernel's attempt rules grant
 * `owner`, and handing them the student there would let a student extend their own deadline.
 */
async function allowed(
  tx: TxClient,
  input: {
    actor: Actor;
    action: Action;
    classroomId: string;
    subject: { type: 'ExamAttempt' | 'Assignment'; id: string };
  },
): Promise<boolean> {
  const built = await classroomCanInput(tx, {
    action: input.action,
    classroomId: input.classroomId,
    actor: input.actor,
  });
  if (!built.ok) return false;
  return can({
    ...built.canInput,
    subject: { ...built.canInput.subject, type: input.subject.type, id: input.subject.id },
  }).allowed;
}

export async function applyAttemptException(
  db: PrismaClient,
  input: {
    attemptId: string;
    actor: Actor;
    reason: string;
    action: AttemptException;
    clock: Clock;
  },
): Promise<ExceptionResult> {
  return db.$transaction(async (tx) => {
    // The decision and the write are one fact: an unlocked read lets a submit land between them
    // and leaves an extension row against an attempt that has no deadline left to extend.
    await tx.$queryRaw`SELECT id FROM "ExamAttempt" WHERE id = ${input.attemptId} FOR UPDATE`;
    const attempt = await tx.examAttempt.findUnique({
      where: { id: input.attemptId },
      select: {
        status: true,
        classroomId: true,
        studentId: true,
        deadlineAt: true,
        pausedAccumSec: true,
        extensions: { select: { addedSec: true }, orderBy: { id: 'asc' } },
        assignment: { select: { availableUntil: true } },
        releaseMembers: {
          where: { batch: { status: { in: ['RELEASING', 'RELEASED'] } } },
          select: { batchId: true },
        },
        // Student-specific window overrides must be honoured when deciding `MISSING`.
        assignmentId: true,
      },
    });
    if (attempt === null) return { ok: false, reason: 'ATTEMPT_NOT_FOUND' };
    if (
      !(await allowed(tx, {
        actor: input.actor,
        action: EXCEPTION_VERB[input.action.kind],
        classroomId: attempt.classroomId,
        subject: { type: 'ExamAttempt', id: input.attemptId },
      }))
    )
      return { ok: false, reason: 'FORBIDDEN' };
    const override = await tx.assignmentStudentOverride.findUnique({
      where: {
        assignmentId_studentId: {
          assignmentId: attempt.assignmentId,
          studentId: attempt.studentId,
        },
      },
      select: { availableUntil: true },
    });
    const decision = decideAttemptException({
      status: attempt.status,
      reason: input.reason,
      deadlineAt: attempt.deadlineAt?.getTime() ?? null,
      windowClosesAt:
        (override?.availableUntil ?? attempt.assignment.availableUntil)?.getTime() ?? null,
      releaseStarted: attempt.releaseMembers.length > 0,
      now: input.clock.now(),
      action: input.action,
    });
    if (!decision.ok) return decision;
    const at = new Date(input.clock.now());
    const reason = input.reason.trim();
    let effectiveDeadlineAt: Date | undefined;
    if (input.action.kind === 'EXTEND_DEADLINE') {
      // `C14`: never rewrite the frozen base deadline; repeated grants add repeated deltas.
      await tx.attemptDeadlineExtension.create({
        data: {
          attemptId: input.attemptId,
          addedSec: input.action.addedSec,
          actorId: input.actor.id,
          reason,
          triggerEventTypes: [],
          at,
        },
      });
      // The SAME arithmetic the rest of the package displays, so the audit row and the teacher's
      // confirmation cannot name two different instants.
      effectiveDeadlineAt =
        effectiveDeadline({
          deadlineAt: attempt.deadlineAt,
          addedSec: [...attempt.extensions.map((e) => e.addedSec), input.action.addedSec],
          pausedAccumSec: attempt.pausedAccumSec,
          gracePeriodSec: 0,
        }) ?? undefined;
    } else {
      await tx.examAttempt.update({
        where: { id: input.attemptId },
        data:
          input.action.kind === 'MARK_LATE'
            ? { isLate: input.action.isLate }
            : { status: decision.status },
      });
    }
    const payload = {
      reason,
      action: input.action,
      ...(effectiveDeadlineAt === undefined
        ? {}
        : { effectiveDeadlineAt: effectiveDeadlineAt.toISOString() }),
    };
    await tx.attemptEventRecord.create({
      data: {
        attemptId: input.attemptId,
        type: decision.event,
        actorId: input.actor.id,
        serverTs: at,
        payload,
      },
    });
    await tx.auditEvent.create({
      data: {
        action: `ExamAttempt.${decision.event}`,
        targetType: 'ExamAttempt',
        targetId: input.attemptId,
        classroomId: attempt.classroomId,
        actorId: input.actor.id,
        createdAt: at,
        meta: payload,
      },
    });
    return effectiveDeadlineAt === undefined ? decision : { ...decision, effectiveDeadlineAt };
  });
}

/** Penalty changes after release belong to the regrade lane; never leave visible totals stale. */
export async function setAssignmentLatePenalty(
  db: PrismaClient,
  input: { assignmentId: string; actor: Actor; percent: number; reason: string; clock: Clock },
) {
  if (input.reason.trim().length < 10) return { ok: false as const, reason: 'NO_REASON' };
  // `computeScore` clamps too, but a stored 150 is a configuration nobody can explain later.
  if (!Number.isFinite(input.percent) || input.percent < 0 || input.percent > 100)
    return { ok: false as const, reason: 'INVALID_PENALTY' };
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Assignment" WHERE id = ${input.assignmentId} FOR UPDATE`;
    const assignment = await tx.assignment.findUnique({
      where: { id: input.assignmentId },
      select: {
        classroomId: true,
        latePenaltyPercent: true,
        releaseBatches: {
          where: { status: { in: ['RELEASING', 'RELEASED'] } },
          select: { id: true },
        },
      },
    });
    if (
      assignment === null ||
      !(await allowed(tx, {
        actor: input.actor,
        action: 'update',
        classroomId: assignment.classroomId,
        subject: { type: 'Assignment', id: input.assignmentId },
      }))
    )
      return { ok: false as const, reason: 'FORBIDDEN' };
    if (assignment.releaseBatches.length > 0)
      return { ok: false as const, reason: 'REQUIRES_REGRADE' };
    await tx.assignment.update({
      where: { id: input.assignmentId },
      data: { latePenaltyPercent: input.percent },
    });
    await tx.auditEvent.create({
      data: {
        action: 'Assignment.latePenaltyChanged',
        targetType: 'Assignment',
        targetId: input.assignmentId,
        actorId: input.actor.id,
        classroomId: assignment.classroomId,
        createdAt: new Date(input.clock.now()),
        meta: {
          before: Number(assignment.latePenaltyPercent),
          after: input.percent,
          reason: input.reason.trim(),
        },
      },
    });
    return { ok: true as const };
  });
}

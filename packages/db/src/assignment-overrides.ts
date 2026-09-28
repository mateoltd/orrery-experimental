/**
 * Per-student overrides, and the mid-exam deadline extensions that must not rewrite anything.  (P5-T2)
 *
 * ## WHAT THIS FILE IS FOR
 *
 * `plans/01` §6: "`AssignmentStudentOverride` carries per-student exceptions: a different window,
 * extra attempts, a longer time limit, an accommodation reference. This is the escape hatch that
 * stops a teacher from choosing between 'rigid policy' and 'my student has a rough home internet
 * connection'."
 *
 * The schema row existed from P0 with nothing reading or writing it. What is here is the service
 * that grants one, the fold that applies it (`resolveForStudent` in `assignments.ts`, and the
 * arithmetic in `@orrery/contracts/policy`), and the one thing that must never happen to a
 * running attempt.
 *
 * ## C14: A MID-EXAM GRANT IS AN ADDITIVE ROW, NEVER A REWRITE
 *
 * The original design gave a student extra time by REWRITING `ExamAttempt.deadlineAt`. That broke
 * `INV-POLICY-1` in a way that is worth spelling out, because the symptom was in a different
 * system than the cause: `verify-receipt` began reporting DIVERGENCE on a legitimate action, and
 * a teacher receiving that message has no way to guess that a fair accommodation caused it.
 *
 * So `deadlineAt` is written once, at first start, and never again:
 *
 * ```
 * effectiveDeadlineAt = deadlineAt + Σ addedSec + pausedAccumSec
 * ```
 *
 * The function that computes it is exported and takes the extension rows as an argument, so
 * every caller — the sweep, the exam header, the receipt verifier — reads the same arithmetic
 * rather than each having its own idea. `deadlineAt` being a column nobody updates is the
 * property that makes the whole thing checkable, and the test asserts it by reading the column.
 */

import type { Actor } from '@orrery/auth/types';
import { type Clock, systemClock } from '@orrery/clock';
import { permit } from './classrooms.js';
import type { PrismaClient, TxClient } from './index.js';

type Db = PrismaClient | TxClient;

export type OverrideRefusal = {
  readonly ok: false;
  readonly httpStatus: 403 | 404 | 409;
  readonly reason: string;
};

export interface GrantOverrideInput {
  readonly classroomId: string;
  readonly assignmentId: string;
  readonly studentId: string;
  readonly actor: Actor;
  /** REQUIRED. An override with no reason is an unexplained advantage, and unexplainable is the
   *  same as unfair. The column is NOT NULL for that reason. */
  readonly reason: string;
  readonly availableFrom?: Date | null;
  readonly availableUntil?: Date | null;
  readonly maxAttempts?: number | null;
  readonly extraTimePercent?: number | null;
  readonly policyOverride?: unknown;
}

const REASON_MIN = 10;

/**
 * Grant, replace, or revoke an override for one student on one assignment.
 *
 * Idempotent per `(assignmentId, studentId)` — the schema has a `@@unique` on that pair, so
 * granting twice is an UPSERT rather than an error. That matters because a teacher fixing a typo
 * in an accommodation should not have to work out whether one already exists.
 */
export async function grantStudentOverride(
  db: Db,
  input: GrantOverrideInput,
  clock: Clock = systemClock,
): Promise<{ ok: true; overrideId: string } | OverrideRefusal> {
  const decision = await permit(db, {
    action: 'changeRole',
    classroomId: input.classroomId,
    actor: input.actor,
  });
  if (!decision.ok) return { ok: false, httpStatus: decision.httpStatus, reason: decision.reason };

  // A reason is enforced here as well as by the column, because a 5-character reason is a reason
  // nobody can use in a conversation with a parent six months later.
  if (input.reason.trim().length < REASON_MIN) {
    return {
      ok: false,
      httpStatus: 409,
      reason: `an override needs a reason of at least ${REASON_MIN} characters, because this row is what explains the advantage later`,
    };
  }

  const assignment = await db.assignment.findUnique({
    where: { id: input.assignmentId },
    select: { id: true, classroomId: true, maxAttempts: true, status: true },
  });
  if (assignment === null) return { ok: false, httpStatus: 404, reason: 'no such assignment' };
  if (assignment.classroomId !== input.classroomId) {
    return { ok: false, httpStatus: 403, reason: 'wrongClassroom' };
  }

  // An override can only ever ADD attempts, never take them away. A teacher who has granted a
  // second attempt and then edits the row to `maxAttempts: 0` has retroactively invalidated work
  // a student may already have handed in, and a lower number than the class default is exactly
  // that shape.
  if (input.maxAttempts !== undefined && input.maxAttempts !== null) {
    if (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 1) {
      return {
        ok: false,
        httpStatus: 409,
        reason: 'attempts must be a whole number of at least 1',
      };
    }
  }

  const now = new Date(clock.now());
  const row = await db.assignmentStudentOverride.upsert({
    where: {
      assignmentId_studentId: { assignmentId: input.assignmentId, studentId: input.studentId },
    },
    create: {
      assignmentId: input.assignmentId,
      studentId: input.studentId,
      availableFrom: input.availableFrom ?? null,
      availableUntil: input.availableUntil ?? null,
      maxAttempts: input.maxAttempts ?? null,
      extraTimePercent: input.extraTimePercent ?? null,
      policyOverride: (input.policyOverride ?? undefined) as never,
      reason: input.reason,
      grantedById: input.actor.id,
      createdAt: now,
    },
    update: {
      availableFrom: input.availableFrom ?? null,
      availableUntil: input.availableUntil ?? null,
      maxAttempts: input.maxAttempts ?? null,
      extraTimePercent: input.extraTimePercent ?? null,
      policyOverride: (input.policyOverride ?? undefined) as never,
      reason: input.reason,
      grantedById: input.actor.id,
    },
    select: { id: true },
  });
  return { ok: true, overrideId: row.id };
}

/** Revoke. The row is deleted rather than flagged: an override is not a record, it is a setting. */
export async function revokeStudentOverride(
  db: Db,
  input: { classroomId: string; assignmentId: string; studentId: string; actor: Actor },
): Promise<{ ok: true } | OverrideRefusal> {
  const decision = await permit(db, {
    action: 'changeRole',
    classroomId: input.classroomId,
    actor: input.actor,
  });
  if (!decision.ok) return { ok: false, httpStatus: decision.httpStatus, reason: decision.reason };

  const assignment = await db.assignment.findUnique({
    where: { id: input.assignmentId },
    select: { id: true, classroomId: true },
  });
  if (assignment === null) return { ok: false, httpStatus: 404, reason: 'no such assignment' };
  if (assignment.classroomId !== input.classroomId) {
    return { ok: false, httpStatus: 403, reason: 'wrongClassroom' };
  }
  await db.assignmentStudentOverride.deleteMany({
    where: { assignmentId: input.assignmentId, studentId: input.studentId },
  });
  return { ok: true };
}

export interface DeadlineInputs {
  /** The column. Written once, at first start, and never updated. */
  readonly deadlineAt: Date | null;
  /** The additive extension rows. */
  readonly addedSec: readonly number[];
  /** Paused time, from `ExamAttempt.pausedAccumSec` (C15). */
  readonly pausedAccumSec: number;
  /** The grace period from the frozen policy (RN-04: Moodle's 60 s default). */
  readonly gracePeriodSec: number;
}

/**
 * `effectiveDeadlineAt = deadlineAt + Σ addedSec + pausedAccumSec`, and the grace period is a
 * SEPARATE caller decision.
 *
 * The grace period is excluded on purpose. It is a tolerance the SWEEP applies when deciding to
 * auto-submit, not part of when the student may work: a student told "you have until 11:00"
 * should be able to submit at 11:00:59, and baking the grace into the displayed deadline would
 * hand them 60 seconds the exam never agreed to give. `plans/09` is explicit that the sweep runs
 * at `deadlineAt + grace + 30s`.
 */
export function effectiveDeadline(inputs: DeadlineInputs): Date | null {
  if (inputs.deadlineAt === null) return null;
  const extra = inputs.addedSec.reduce((a, b) => a + b, 0);
  const total = inputs.deadlineAt.getTime() + (extra + inputs.pausedAccumSec) * 1000;
  return new Date(total);
}

/** The instant the sweep acts on: the effective deadline plus the grace plus a safety margin. */
export function autoSubmitAt(inputs: DeadlineInputs, cronMarginSec = 30): Date | null {
  const effective = effectiveDeadline(inputs);
  if (effective === null) return null;
  return new Date(effective.getTime() + (inputs.gracePeriodSec + cronMarginSec) * 1000);
}

export interface ExtensionOutcome {
  readonly ok: boolean;
  readonly reason?: string;
  /** The new effective deadline, so a caller can TELL the student rather than just storing it. */
  readonly effectiveDeadlineAt: Date | null;
}

/**
 * Add time to a RUNNING attempt, additively.
 *
 * ## The three things this refuses, and why each one is a real incident
 *
 *  1. **An attempt that is not running.** A submitted or graded attempt has no deadline to
 *     extend, and a row against one makes the arithmetic above describe a past instant.
 *  2. **A negative or zero grant.** Zero is a no-op that still writes a row, and a row is an
 *     audit claim that something happened.
 *  3. **A reason that cannot be used later.** Same rule as the override, and for the same reason.
 *
 * ## It does NOT update `deadlineAt`, and that is the point of the whole file
 *
 * C14. A rewrite breaks `INV-POLICY-1` and makes `verify-receipt` report divergence on a
 * legitimate action, and a teacher receiving that message has no way to guess that a fair
 * accommodation caused it.
 */
export async function extendAttemptDeadline(
  db: Db,
  input: {
    classroomId: string;
    attemptId: string;
    actor: Actor;
    addedSec: number;
    reason: string;
    /** T-6: an evidence-triggered BULK extension names the event types that caused it. */
    triggerEventTypes?: readonly string[];
  },
  clock: Clock = systemClock,
): Promise<ExtensionOutcome> {
  const decision = await permit(db, {
    action: 'update',
    classroomId: input.classroomId,
    actor: input.actor,
  });
  if (!decision.ok) {
    return { ok: false, reason: decision.reason, effectiveDeadlineAt: null };
  }

  if (!Number.isInteger(input.addedSec) || input.addedSec <= 0) {
    return {
      ok: false,
      reason: 'an extension adds time; zero and negative values are not extensions',
      effectiveDeadlineAt: null,
    };
  }
  if (input.reason.trim().length < REASON_MIN) {
    return {
      ok: false,
      reason: `an extension needs a reason of at least ${REASON_MIN} characters, because this row is what explains it later`,
      effectiveDeadlineAt: null,
    };
  }

  const attempt = await db.examAttempt.findUnique({
    where: { id: input.attemptId },
    select: {
      id: true,
      classroomId: true,
      status: true,
      deadlineAt: true,
      pausedAccumSec: true,
      extensions: { select: { addedSec: true }, orderBy: { id: 'asc' } },
    },
  });
  if (attempt === null) return { ok: false, reason: 'no such attempt', effectiveDeadlineAt: null };
  if (attempt.classroomId !== input.classroomId) {
    return { ok: false, reason: 'wrongClassroom', effectiveDeadlineAt: null };
  }
  if (attempt.status !== 'IN_PROGRESS') {
    return {
      ok: false,
      reason: `an attempt that is ${attempt.status} has no deadline to extend`,
      effectiveDeadlineAt: null,
    };
  }

  const now = new Date(clock.now());
  const added = [...attempt.extensions.map((e) => e.addedSec), input.addedSec];
  const effectiveDeadlineAt = effectiveDeadline({
    deadlineAt: attempt.deadlineAt,
    addedSec: added,
    pausedAccumSec: attempt.pausedAccumSec,
    gracePeriodSec: 0,
  });

  // ONE write: the extension row. `deadlineAt` is not in the data, and its absence from this
  // statement is the C14 fix expressed as code.
  await db.attemptDeadlineExtension.create({
    data: {
      attemptId: attempt.id,
      addedSec: input.addedSec,
      reason: input.reason,
      actorId: input.actor.id,
      triggerEventTypes: [...(input.triggerEventTypes ?? [])],
      at: now,
    },
  });

  return { ok: true, effectiveDeadlineAt };
}

/** Read the overrides for one assignment, for the authoring surface. */
export async function listStudentOverrides(
  db: Db,
  input: { classroomId: string; assignmentId: string; actor: Actor },
): Promise<
  readonly {
    id: string;
    studentId: string;
    reason: string;
    extraTimePercent: string | null;
    maxAttempts: number | null;
    availableFrom: Date | null;
    availableUntil: Date | null;
  }[]
> {
  const decision = await permit(db, {
    action: 'read',
    classroomId: input.classroomId,
    actor: input.actor,
  });
  if (!decision.ok) return [];

  const rows = await db.assignmentStudentOverride.findMany({
    where: { assignment: { classroomId: input.classroomId, id: input.assignmentId } },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      studentId: true,
      reason: true,
      extraTimePercent: true,
      maxAttempts: true,
      availableFrom: true,
      availableUntil: true,
    },
  });
  // `Decimal` is mapped to a STRING here, explicitly, because the alternative is worse in a way
  // that is not obvious: Prisma's Decimal serialises through `toJSON` as a string, so a caller
  // typing it as `number` gets `undefined` at runtime and `NaN` in an arithmetic expression, with
  // no type error to explain either. A string that says "25.0" is a value a UI can format.
  return rows.map((r) => ({ ...r, extraTimePercent: r.extraTimePercent?.toString() ?? null }));
}

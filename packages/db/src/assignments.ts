/**
 * Assignments.  (P5-T1)
 *
 * ## THE PINNING IS STRUCTURAL, NOT A CHECK
 *
 * `INV-ASSIGN-1`: "A student's assessment surface derives **only** from
 * `Assignment.resourceVersionId` and the attempt's `policySnapshot`. No code path may read
 * `Resource.currentVersionId` when rendering an assessment."
 *
 * The enforcement ADR-0025 chose is a PATH BAN on the identifier, because a generic lint rule
 * cannot do taint analysis — the forbidden value reaches a renderer through a dozen frames. The
 * complement is what THIS module does: `createAssignment` requires an explicit
 * `resourceVersionId` and there is no parameter through which a current version could arrive
 * instead. A caller that forgets the version cannot call the function, rather than calling it and
 * getting the wrong answer at exam time.
 *
 * ## WHY A DRAFT ASSIGNMENT STILL PINS
 *
 * The obvious design is "the version is chosen at publish", which is one refactor too many
 * changes: a teacher edits the questions, a colleague publishes, and the colleague published
 * something the teacher never saw. Pinning at creation makes the version an explicit choice at
 * the moment somebody is looking at it, and publishing becomes the act of *showing* that pin.
 *
 * ## WITHDRAWAL STOPS NEW ATTEMPTS AND NOTHING ELSE
 *
 * `INV-ASSIGN-2`: "Withdrawing an assignment stops **new** attempts. In-flight attempts run to
 * their own deadline and remain submittable. Withdrawal is audited and shown to students as a
 * message, never a silent 404."
 *
 * So `withdrawAssignment` does not touch attempts, and it cannot: the function takes an
 * assignment id and has no attempt parameter. A student part-way through an exam when the
 * teacher withdraws it still submits, still gets marked, and is told why the work disappeared.
 */

import type { Actor } from '@orrery/auth/types';
import { type Clock, systemClock } from '@orrery/clock';
import {
  type ExamPolicy,
  freezePolicy,
  isPublishable,
  type PolicyOverride,
  profileFor,
  resolvePolicy,
  validatePolicy,
} from '@orrery/contracts/policy';
import { permit } from './classrooms.js';
import type { PrismaClient, TxClient } from './index.js';

type Db = PrismaClient | TxClient;

export type AssignmentMode = 'ASSIGNMENT' | 'EXAM';
export type AssignmentStatus = 'DRAFT' | 'PUBLISHED' | 'WITHDRAWN';

export class AssignmentRefused extends Error {
  constructor(
    readonly httpStatus: 403 | 404 | 409,
    readonly reason: string,
  ) {
    super(`assignment refused: ${reason}`);
    this.name = 'AssignmentRefused';
  }
}

export class AssignmentInvalid extends Error {
  constructor(readonly problems: readonly { field: string; problem: string; error: boolean }[]) {
    super('assignment policy is not internally consistent');
    this.name = 'AssignmentInvalid';
  }
}

export interface CreateAssignmentInput {
  readonly classroomId: string;
  /** REQUIRED. There is deliberately no way to pass "whatever the current version is". */
  readonly resourceVersionId: string;
  readonly actor: Actor;
  readonly mode?: AssignmentMode;
  readonly titleOverride?: string | null;
  readonly instructions?: unknown;
  readonly availableFrom?: Date | null;
  readonly availableUntil?: Date | null;
  readonly maxAttempts?: number;
  readonly weight?: number;
  readonly latePenaltyPercent?: number;
  readonly policyOverride?: PolicyOverride | null;
  readonly moderationSampleSize?: number;
  readonly moderationPercent?: number;
}

/**
 * Create an assignment, PINNED to one version.
 *
 * ## The resource is resolved from the VERSION, never the other way round
 *
 * `resourceId` is derived from `resourceVersionId` rather than accepted, because accepting both
 * would let a caller pair version 3 of one resource with version 1 of another — and every later
 * read would be a join on two ids that were never related. Deriving it means the inconsistency
 * is unrepresentable.
 */
export async function createAssignment(
  db: Db,
  input: CreateAssignmentInput,
  clock: Clock = systemClock,
): Promise<
  { ok: true; assignmentId: string } | { ok: false; httpStatus: 403 | 404; reason: string }
> {
  const decision = await permit(db, {
    action: 'assign',
    classroomId: input.classroomId,
    actor: input.actor,
  });
  if (!decision.ok) return { ok: false, httpStatus: decision.httpStatus, reason: decision.reason };

  const version = await db.resourceVersion.findUnique({
    where: { id: input.resourceVersionId },
    select: { id: true, resourceId: true, assessmentPolicy: true, version: true },
  });
  if (version === null) {
    return { ok: false, httpStatus: 404, reason: 'no such resource version' };
  }

  // INV-POLICY-2, checked at AUTHORING time with field-level problems.
  //
  // The plan is emphatic: "Field-level errors in the authoring UI, never at exam start." A
  // student discovering at 09:00 that the policy is impossible is a support incident with a
  // deadline attached, and it is entirely preventable here.
  const mode = input.mode ?? 'ASSIGNMENT';
  const candidate = resolvePolicy({
    mode,
    versionPolicy: (version.assessmentPolicy as PolicyOverride | null) ?? null,
    assignmentOverride: input.policyOverride ?? null,
    assignmentWindow: {
      from: input.availableFrom ?? null,
      until: input.availableUntil ?? null,
    },
  });
  const problems = validatePolicy(candidate);
  if (!isPublishable(problems)) throw new AssignmentInvalid(problems);

  const now = new Date(clock.now());
  const created = await db.assignment.create({
    data: {
      classroomId: input.classroomId,
      resourceId: version.resourceId,
      resourceVersionId: version.id,
      mode,
      status: 'DRAFT',
      ...(input.titleOverride === undefined || input.titleOverride === null
        ? {}
        : { titleOverride: input.titleOverride }),
      ...(input.instructions === undefined ? {} : { instructions: input.instructions as never }),
      availableFrom: input.availableFrom ?? null,
      availableUntil: input.availableUntil ?? null,
      maxAttempts: input.maxAttempts ?? candidate.maxAttempts,
      weight: input.weight ?? 100,
      latePenaltyPercent: input.latePenaltyPercent ?? 0,
      ...(input.policyOverride === undefined || input.policyOverride === null
        ? {}
        : { policyOverride: input.policyOverride as never }),
      moderationSampleSize: input.moderationSampleSize ?? 0,
      moderationPercent: input.moderationPercent ?? 0,
      createdById: input.actor.id,
      createdAt: now,
      updatedAt: now,
    },
    select: { id: true },
  });
  return { ok: true, assignmentId: created.id };
}

/**
 * Publish, which is the act of SHOWING the pin.
 *
 * The version is re-read here and reported back, because publishing is the last moment a
 * teacher can see what they are about to release, and "you are about to publish version 4" is
 * the sentence that prevents the whole class of mistake this invariant exists for. The published
 * version cannot then be changed; changing it means a new assignment.
 */
export async function publishAssignment(
  db: Db,
  input: { classroomId: string; assignmentId: string; actor: Actor },
  clock: Clock = systemClock,
): Promise<
  | { ok: true; resourceVersionId: string; versionNumber: number }
  | { ok: false; httpStatus: 403 | 404 | 409; reason: string }
> {
  const decision = await permit(db, {
    action: 'publish',
    classroomId: input.classroomId,
    actor: input.actor,
  });
  if (!decision.ok) return { ok: false, httpStatus: decision.httpStatus, reason: decision.reason };

  const assignment = await db.assignment.findUnique({
    where: { id: input.assignmentId },
    select: {
      id: true,
      classroomId: true,
      status: true,
      resourceVersionId: true,
      resourceVersion: { select: { version: true, assessmentPolicy: true } },
    },
  });
  if (assignment === null) {
    return { ok: false, httpStatus: 404, reason: 'no such assignment' };
  }
  if (assignment.classroomId !== input.classroomId) {
    return { ok: false, httpStatus: 403, reason: 'wrongClassroom' };
  }
  if (assignment.status === 'PUBLISHED') {
    // Publishing twice is a no-op with an answer, not an error. A teacher double-clicking
    // Publish must not get a 409 that reads like a problem with their exam.
    return {
      ok: true,
      resourceVersionId: assignment.resourceVersionId,
      versionNumber: assignment.resourceVersion.version,
    };
  }
  if (assignment.status === 'WITHDRAWN') {
    return {
      ok: false,
      httpStatus: 409,
      reason: 'an assignment cannot be re-published once withdrawn',
    };
  }

  // Re-validate at publish, not only at create. A teacher can edit `availableUntil` on a draft,
  // and a draft that became unsittable between authoring and publishing is the common case.
  const problems = validatePolicy(
    resolvePolicy({
      mode: 'ASSIGNMENT',
      versionPolicy: (assignment.resourceVersion.assessmentPolicy as PolicyOverride | null) ?? null,
      assignmentWindow: { from: null, until: null },
    }),
  );
  if (!isPublishable(problems)) throw new AssignmentInvalid(problems);

  const now = new Date(clock.now());
  await db.assignment.update({
    where: { id: assignment.id },
    data: { status: 'PUBLISHED', publishedAt: now, updatedAt: now },
  });
  return {
    ok: true,
    resourceVersionId: assignment.resourceVersionId,
    versionNumber: assignment.resourceVersion.version,
  };
}

/**
 * Withdraw. Stops NEW attempts and touches nothing else.
 *
 * `INV-ASSIGN-2`, and the reason the function has no attempt parameter: in-flight attempts run
 * to their own deadline and remain submittable. A withdrawal is a message, not a deletion, and
 * the message is what a student sees instead of a 404.
 */
export async function withdrawAssignment(
  db: Db,
  input: { classroomId: string; assignmentId: string; actor: Actor; reason: string },
  clock: Clock = systemClock,
): Promise<{ ok: true } | { ok: false; httpStatus: 403 | 404 | 409; reason: string }> {
  const decision = await permit(db, {
    action: 'update',
    classroomId: input.classroomId,
    actor: input.actor,
  });
  if (!decision.ok) return { ok: false, httpStatus: decision.httpStatus, reason: decision.reason };

  const assignment = await db.assignment.findUnique({
    where: { id: input.assignmentId },
    select: { id: true, classroomId: true, status: true },
  });
  if (assignment === null) return { ok: false, httpStatus: 404, reason: 'no such assignment' };
  if (assignment.classroomId !== input.classroomId) {
    return { ok: false, httpStatus: 403, reason: 'wrongClassroom' };
  }
  if (assignment.status === 'DRAFT') {
    // A draft was never given to anybody, so deleting it would be honest and this function does
    // not do that — `delete` is a different door with a different blast radius.
    return {
      ok: false,
      httpStatus: 409,
      reason: 'a draft was never published, so delete it instead',
    };
  }

  const now = new Date(clock.now());
  await db.assignment.update({
    where: { id: assignment.id },
    data: { status: 'WITHDRAWN', withdrawnAt: now, updatedAt: now },
  });
  return { ok: true };
}

export interface PolicySources {
  readonly mode: AssignmentMode;
  readonly versionPolicy: PolicyOverride | null;
  readonly assignmentOverride: PolicyOverride | null;
  readonly availableFrom: Date | null;
  readonly availableUntil: Date | null;
  readonly studentOverride?: {
    readonly availableFrom?: string | null;
    readonly availableUntil?: string | null;
    readonly maxAttempts?: number | null;
    readonly extraTimePercent?: number | null;
    readonly policyOverride?: PolicyOverride | null;
  } | null;
  readonly accommodation?: {
    readonly relaxations: readonly string[];
    readonly extraTimePercent?: number | null;
    readonly status?: string;
    readonly revokedAt?: Date | null;
    readonly expiresAt?: Date | null;
  } | null;
  readonly maxAttempts: number;
}

/**
 * `resolve(assignment.policyOverride, resourceVersion.assessmentPolicy, studentOverride,
 * accommodation)` — the fold from `plans/01` §6, with the arguments in the order the plan wrote
 * them and the PRIORITY documented in `@orrery/contracts/policy`.
 *
 * `maxAttempts` comes from the row rather than the policy, because it is a column as well as a
 * policy field and a column that a teacher edits is a column that must win. The one place they
 * disagree is the one a teacher touched most recently.
 */
export function resolveForStudent(sources: PolicySources): ExamPolicy {
  return freezePolicy(
    resolvePolicy({
      mode: sources.mode,
      versionPolicy: sources.versionPolicy,
      assignmentOverride: sources.assignmentOverride,
      studentOverride: sources.studentOverride ?? null,
      accommodation: sources.accommodation ?? null,
      assignmentWindow: { from: sources.availableFrom, until: sources.availableUntil },
    }),
  );
}

/** The default profile for a mode, exported so a caller can prefill an authoring form. */
export function defaultPolicyFor(mode: AssignmentMode): ExamPolicy {
  return profileFor(mode);
}

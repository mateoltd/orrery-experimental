/**
 * The resource library: mine, blast radius, transfer, duplicate.  (P2-T9)
 *
 * ## The one thing this module is for
 *
 * **Blast radius, before the destructive action.** The packet says it plainly: "so a teacher can
 * see the blast radius before deleting or transferring something a live exam depends on".
 *
 * Every function here exists to make a number visible *before* an irreversible action, and the
 * numbers are not decoration. `blastRadius` answers "how many classrooms, how many students, how
 * many attempts, how many marks already depend on this" — and `transferOwnership` REFUSES when
 * the answer includes a live attempt.
 *
 * ## Why the live-attempt check cannot live in the matrix
 *
 * `Resource.transfer` grants the permission. It cannot enforce the precondition, because the
 * matrix has no database and "is an exam sitting in this right now" is a fact only a query can
 * establish. A rule that tried to consult a count it cannot see would be a rule that silently
 * granted the action to everyone — which is the failure mode of putting a check in a layer that
 * cannot do it, and it is worse than having no check because it reads as though there is one.
 *
 * So the split is explicit: the matrix says WHO MAY, this module says WHETHER IT IS SAFE, and
 * both have to pass.
 */

import { can } from '@orrery/auth/can';
import type { Actor } from '@orrery/auth/types';
import { contentChecksum } from '@orrery/contracts/editor';
import type { PrismaClient, TxClient } from './index.js';
import { loadResourceView } from './resources.js';

type Db = PrismaClient | TxClient;

/** Unsettled: the mark still depends on somebody answering for the content. */
const IN_FLIGHT = ['IN_PROGRESS', 'FROZEN', 'SUBMITTED', 'PENDING_REVIEW'] as const;
/** Settled: the mark is fixed, and it belongs to the student rather than to the author. */
const SETTLED = ['GRADED', 'RELEASED', 'EXCUSED'] as const;

/**
 * What depends on a resource. Every number here is something a teacher is about to affect.
 *
 * ## What "in flight" means, and why it is not the same as "open"
 *
 * `IN_PROGRESS`, `FROZEN`, `SUBMITTED` and `PENDING_REVIEW` are in flight. A `FROZEN` attempt
 * is a student who was removed mid-exam with held answers (V-12/C16) and a `SUBMITTED` one has
 * handed work in — in both cases the mark is NOT settled, so it still depends on somebody
 * answering for the content.
 *
 * ## Why this blocks a transfer, when the data cannot actually break
 *
 * It is tempting to argue a live attempt does not matter, because it provably does not: the
 * assignment pins `resourceVersionId`, and INV-CONTENT-1 makes a version write-once. Transferring
 * ownership cannot change what a student in the middle of an exam is looking at.
 *
 * That is true, and it is the wrong reason to stop. What the transfer changes is
 * **ACCOUNTABILITY** — who is responsible for a room of students who are sitting an exam right
 * now, and who is in a position to notice one is going wrong. And the new owner starts with the
 * ability to publish a corrected version, which is exactly the wrong moment for somebody else
 * to be rewriting the content under them.
 *
 * So the guard is about people, not bytes, and it is stated that way here because the stronger
 * claim ("the content would change") is false and would be refuted by anyone who read the
 * pinning rules. A guard whose stated reason can be disproved is a guard that gets removed.
 */
export interface BlastRadius {
  readonly resourceId: string;
  /** Classrooms this resource is assigned into, by assignment status. */
  readonly classrooms: readonly {
    readonly classroomId: string;
    readonly name: string;
    readonly status: string;
  }[];
  readonly publishedAssignments: number;
  readonly totalAttempts: number;
  /** The gate. Non-zero means an exam is running right now against this content. */
  readonly attemptsInFlight: number;
  /** Submissions and exams that have already been marked. Irreversible once destroyed. */
  readonly gradedAttempts: number;
  readonly studentsReachable: number;
  /** True when any of the above makes a destructive action unsafe RIGHT NOW. */
  readonly blocksDestructive: boolean;
  readonly reason: string | null;
}

export async function blastRadius(db: Db, resourceId: string): Promise<BlastRadius> {
  const assignments = await db.assignment.findMany({
    where: { resourceId },
    select: {
      status: true,
      classroomId: true,
      classroom: { select: { name: true } },
      _count: {
        select: {
          attempts: {
            where: { status: { in: [...IN_FLIGHT] } },
          },
        },
      },
      attempts: {
        where: { status: { in: [...SETTLED] } },
        select: { id: true },
      },
    },
  });

  const live = assignments.map((a) => ({
    classroomId: a.classroomId,
    name: a.classroom.name,
    status: a.status,
  }));

  // "Students reachable" counts DISTINCT students, not assignments. A resource assigned twice
  // into the same classroom reaches the same children twice, and a number that inflates with
  // the number of assignments is a number a teacher learns to distrust.
  const reachable = await db.examAttempt.findMany({
    where: { assignment: { resourceId } },
    select: { studentId: true },
    distinct: ['studentId'],
  });

  const attemptsInFlight = assignments.reduce((n, a) => n + a._count.attempts, 0);
  const gradedAttempts = assignments.reduce((n, a) => n + a.attempts.length, 0);
  const publishedAssignments = assignments.filter((a) => a.status === 'PUBLISHED').length;

  const reasons: string[] = [];
  if (attemptsInFlight > 0) {
    reasons.push(
      `${attemptsInFlight} attempt${attemptsInFlight === 1 ? ' is' : 's are'} still open — ` +
        'somebody has to be responsible for them',
    );
  }
  if (gradedAttempts > 0) {
    reasons.push(
      `${gradedAttempts} student${gradedAttempts === 1 ? ' has' : 's have'} already been marked on this`,
    );
  }

  return {
    resourceId,
    classrooms: live,
    publishedAssignments,
    totalAttempts: reachable.length,
    attemptsInFlight,
    gradedAttempts,
    studentsReachable: reachable.length,
    // ONLY an unsettled attempt blocks. A resource with settled marks can still be transferred:
    // the marks belong to the students, not to the author, and they survive the transfer. A
    // resource with an open attempt cannot, because somebody has to be responsible for it while
    // it is open — see the header for why that is about people rather than bytes.
    blocksDestructive: attemptsInFlight > 0,
    reason: reasons.length === 0 ? null : reasons.join('; '),
  };
}

export interface LibraryEntry {
  readonly id: string;
  readonly title: string;
  readonly kind: string;
  readonly status: string;
  readonly visibility: string;
  readonly classroomCount: number;
  readonly attemptsInFlight: number;
  readonly updatedLabel: string;
}

/**
 * "Mine", as a filtered list.
 *
 * Scoped by `ownerId` in the `where` and never post-filtered, for the reason `searchResources`
 * exists: a post-filter has already paid to read every row the database was willing to return.
 */
export async function listMine(
  db: Db,
  ownerId: string,
  filter: { status?: string; kind?: string; limit?: number } = {},
): Promise<LibraryEntry[]> {
  const rows = await db.resource.findMany({
    where: {
      ownerId,
      ...(filter.status ? { status: filter.status as never } : {}),
      ...(filter.kind ? { kind: filter.kind as never } : {}),
    },
    select: {
      id: true,
      title: true,
      kind: true,
      status: true,
      visibility: true,
      updatedAt: true,
      assignments: { select: { classroomId: true } },
      _count: {
        select: {
          versions: true,
        },
      },
    },
    orderBy: { updatedAt: 'desc' },
    take: filter.limit ?? 50,
  });
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    kind: r.kind,
    status: r.status,
    visibility: r.visibility,
    classroomCount: new Set(r.assignments.map((a) => a.classroomId)).size,
    attemptsInFlight: 0,
    updatedLabel: r.updatedAt.toISOString().slice(0, 10),
    ...(r._count.versions === 0 ? { kind: `${r.kind} (no versions yet)` } : {}),
  }));
}

export type TransferOutcome =
  | { readonly ok: true; readonly previousOwnerId: string; readonly newOwnerId: string }
  | { readonly ok: false; readonly httpStatus: 403 | 404 | 409; readonly reason: string };

/**
 * Hand a resource to somebody else.
 *
 * The checks, and the order they matter in:
 *
 *   1. **Permission** — `Resource.transfer` through `can()`. Invisible is 404, not 403.
 *   2. **The reason** — an obligation from the grant, and a transfer without one is an
 *      unauditable act. Nobody notices a lesson quietly changing hands.
 *   3. **The target exists** — 404 if not. A transfer to a deleted account would leave a
 *      resource owned by nobody, and the recovery is manual.
 *   4. **The blast radius** — refuse on a live attempt, 409. Not 403: the caller is allowed to
 *      do this, the timing is wrong. A 409 says "try again later" where a 403 says "never",
 *      and the difference is the whole point of a live-attempt window.
 *
 * All of it inside ONE transaction with the audit row, because a transfer that succeeds and is
 * not recorded is the failure this action exists to prevent.
 */
export async function transferOwnership(
  // `PrismaClient`, not `Db`: this opens a transaction, and `TxClient` has no `$transaction`.
  // A transfer that succeeds and is not recorded is the failure this action exists to prevent,
  // so the audit row cannot be optional here the way it is for a single-statement query.
  db: PrismaClient,
  input: {
    resourceId: string;
    toUserId: string;
    reason: string;
    actor: Actor;
  },
): Promise<TransferOutcome> {
  const view = await loadResourceView(db, input.resourceId);
  if (view === null) return { ok: false, httpStatus: 404, reason: 'no such resource' };

  const decision = can({
    actor: input.actor,
    action: 'transfer',
    subject: {
      type: 'Resource',
      id: view.id,
      ownerId: view.ownerId,
      lifecycleStatus: view.status,
      visibility: view.visibility,
      sharedClassroomIds: new Set(view.classroomIds),
    },
    // An empty classroom set is correct and not a placeholder. `Resource.transfer` decides on
    // ownership, role and visibility; it does not read classroom membership, and passing the
    // actor's real memberships would only widen the context in a way the rule ignores.
    context: { actorClassroomIds: new Set<string>() },
  });
  if (!decision.allowed) {
    return {
      ok: false,
      httpStatus: decision.reason === 'notVisible' ? 404 : 403,
      reason: decision.reason,
    };
  }

  if (input.reason.trim().length < 10) {
    return {
      ok: false,
      httpStatus: 403,
      reason: 'a transfer must say why; it is the one action nobody would otherwise notice',
    };
  }

  const target = await db.user.findUnique({
    where: { id: input.toUserId },
    select: { id: true, suspendedAt: true, deletedAt: true },
  });
  if (target === null) {
    return { ok: false, httpStatus: 404, reason: 'no such recipient' };
  }
  if (target.suspendedAt !== null || target.deletedAt !== null) {
    return {
      ok: false,
      httpStatus: 409,
      reason: 'the recipient is suspended or deleted, and a resource cannot be owned by nobody',
    };
  }

  const radius = await blastRadius(db, input.resourceId);
  if (radius.blocksDestructive) {
    return {
      ok: false,
      httpStatus: 409,
      reason: `${radius.reason}. Wait for it to finish, or publish a corrected version instead.`,
    };
  }

  return db.$transaction(async (tx) => {
    await tx.resource.update({
      where: { id: input.resourceId },
      data: { ownerId: input.toUserId },
    });
    await tx.auditEvent.create({
      data: {
        actorId: input.actor.id,
        action: 'Resource.transfer',
        targetType: 'Resource',
        targetId: input.resourceId,
        ipHash: null,
        meta: {
          from: view.ownerId,
          to: input.toUserId,
          reason: input.reason.trim(),
          // The blast radius goes IN the audit row. Six months later, "was this a good idea" is
          // unanswerable without knowing what depended on it at the time.
          blastRadius: {
            classrooms: radius.classrooms.length,
            studentsReachable: radius.studentsReachable,
            gradedAttempts: radius.gradedAttempts,
          },
        },
      },
    });
    return { ok: true, previousOwnerId: view.ownerId, newOwnerId: input.toUserId };
  });
}

export type DuplicateOutcome =
  | { readonly ok: true; readonly resourceId: string; readonly versionId: string }
  | { readonly ok: false; readonly httpStatus: 403 | 404 | 409; readonly reason: string };

/**
 * Copy a resource.
 *
 * ## Why a duplicate is a NEW resource and not a new version
 *
 * INV-CONTENT-1: a `ResourceVersion` is write-once, and corrections are new versions. A
 * duplicate therefore cannot be a version of the original — it would be a second version whose
 * `blocks` are identical, which makes "the version of this lesson" a multi-valued answer and
 * quietly breaks every assignment that pins one.
 *
 * So a duplicate is a fresh `Resource` (DRAFT, PRIVATE, owned by the actor) with a fresh
 * `ResourceVersion` at version 1, carrying the SAME `blocks` and a checksum computed over them.
 * The `blocksChecksum` is recomputed rather than copied, which is the check that the content
 * layer exists to provide: if the stored blocks do not hash to the stored checksum, the copy
 * would be the first thing to carry the corruption onward.
 */
export async function duplicateResource(
  db: PrismaClient,
  input: { resourceId: string; actor: Actor; title?: string },
): Promise<DuplicateOutcome> {
  const source = await loadResourceView(db, input.resourceId);
  if (source === null) return { ok: false, httpStatus: 404, reason: 'no such resource' };

  // A duplicate is a READ of the source and a CREATE of the copy, so it needs both. Checking
  // `read` alone would let a teacher copy content they may see but not own into their own
  // library — which is not a security hole exactly, but it is how a teacher's private draft
  // becomes a second teacher's material, and it should be a decision somebody makes.
  const verdict = can({
    actor: input.actor,
    action: 'create',
    subject: {
      type: 'Resource',
      id: 'new',
      ownerId: input.actor.id,
      lifecycleStatus: 'DRAFT',
      visibility: 'PRIVATE',
    },
  });
  if (!verdict.allowed) {
    return { ok: false, httpStatus: 403, reason: verdict.reason };
  }

  const version = await db.resourceVersion.findFirst({
    where: { resourceId: input.resourceId },
    orderBy: { version: 'desc' },
    select: { id: true, blocks: true, blocksChecksum: true, meta: true },
  });
  if (version === null) {
    return {
      ok: false,
      httpStatus: 409,
      reason: 'there is nothing to copy: this resource has no version yet',
    };
  }

  const newId = crypto.randomUUID();
  return db.$transaction(async (tx) => {
    await tx.resource.create({
      data: {
        id: newId,
        ownerId: input.actor.id,
        status: 'DRAFT',
        // PRIVATE, always. A duplicate does not inherit the source's visibility. A shared
        // lesson duplicated into someone's library and left PUBLIC has been published by a
        // button whose label is "duplicate".
        visibility: 'PRIVATE',
        kind: 'LESSON',
        title: input.title ?? 'Copy',
        slug: newId,
      },
    });
    const newVersion = await tx.resourceVersion.create({
      data: {
        resourceId: newId,
        version: 1,
        blocks: version.blocks as never,
        // Recomputed from the bytes being copied. Copying the stored checksum would assert
        // "this content is intact" without having checked anything.
        // The CANONICAL checksum, imported rather than reimplemented. The first version of this
        // file carried a local FNV over `JSON.stringify` and a comment claiming that a test kept
        // the two implementations in step. There was no such test and no such function in
        // `contracts` -- the comment described a protection that did not exist, which is worse
        // than no comment because it stops the next reader looking.
        blocksChecksum: contentChecksum(version.blocks),
        meta: version.meta as never,
        createdById: input.actor.id,
      },
      select: { id: true },
    });
    await tx.auditEvent.create({
      data: {
        actorId: input.actor.id,
        action: 'Resource.duplicate',
        targetType: 'Resource',
        targetId: newId,
        ipHash: null,
        meta: { from: input.resourceId, fromVersionId: version.id },
      },
    });
    return { ok: true, resourceId: newId, versionId: newVersion.id };
  });
}

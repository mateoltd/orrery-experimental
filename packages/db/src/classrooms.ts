/**
 * Classrooms, membership, and the database bridge to the `can()` kernel.  (P4-T1, P4-T2)
 *
 * ## What this module is for
 *
 * Three things, and the third is the one that matters downstream:
 *
 *   1. **Lifecycle** — create, rename, archive, ownership transfer.
 *   2. **Membership** — join, role change, removal, leaving, and the append-only history.
 *   3. **The bridge.** Every call into `can()` needs a `RuleInput` whose `actorClassroomIds` is
 *      the set of classrooms the actor is *currently* an active member of. Getting that wrong is
 *      how "a teacher from classroom A grades in classroom B" happens, so it is built once here
 *      and every caller uses it.
 *
 * ## Classroom scoping is applied IN THE QUERY, and there is a test that says so
 *
 * `plans/12` §4: "A teacher sees only their own classrooms. Classroom scoping is applied *in the
 * query*, not filtered afterwards, and a test asserts the generated SQL contains the scope."
 *
 * The post-filter version is the one people write, because it is easier to write and it is the
 * same mistake `searchResources` and `PUBLIC_LISTING` both carry a comment about: a post-filter
 * has already read every row the database was willing to return, so the other classroom's rows
 * were in application memory, in the query log, and in the slow-query sample before anybody
 * filtered them. `listClassroomsFor` puts the scope in the `where`, and
 * `classrooms.integration.test.ts` captures the emitted SQL and asserts the classroom id is in
 * it.
 *
 * ## INV-CLASSROOM-1: the effective role is the MAXIMUM over ACTIVE enrollments
 *
 * `effectiveRoles` in `@orrery/auth` is the pure implementation, and it already existed from
 * P1. This module is the bridge: `resolveActorForRequest` reads the enrollments and returns an
 * `Actor` whose `roles` are DERIVED, never the roles the session claimed.
 *
 * That is the whole invariant. A session may claim `teacher` after a teacher enrollment was
 * removed, and a kernel that honours the claim has a teacher who cannot be stopped. The
 * consequence worth stating because it surprises people: **removing a user's STUDENT enrollment
 * does not reduce their teacher access.** They are a teacher in another classroom, the maximum
 * is teacher, and that is not a bug in the removal.
 *
 * ## INV-CLASSROOM-2: departure revokes access, and the student's records are not the classroom's
 *
 * Departure sets `Enrollment.status` to `LEFT` or `REMOVED` and writes a `MembershipEvent`. It
 * does not touch attempts, responses or grades, and this module has no code path that could. The
 * `removeMember` signature has no `cascade` flag, deliberately: a destructive option on a
 * function whose whole purpose is to be reversible is an option somebody will use.
 */

import { can, isSameActor } from '@orrery/auth/can';
import { type EnrollmentRow, effectiveRoles } from '@orrery/auth/roles';
import type { Actor, Role } from '@orrery/auth/types';
import { type Clock, systemClock } from '@orrery/clock';
import { toSlug } from '@orrery/contracts/taxonomy';
import type { PrismaClient, TxClient } from './index.js';

type Db = PrismaClient | TxClient;

export type ClassroomRole = 'OWNER' | 'TEACHER' | 'REVIEWER' | 'STUDENT';
export type EnrollmentStatus = 'ACTIVE' | 'REMOVED' | 'LEFT';

/**
 * `ClassroomRole` (the DATABASE vocabulary) to `Role` (the KERNEL vocabulary).
 *
 * ## Two vocabularies, and the seam is real
 *
 * The column stores `TEACHER`. `effectiveRoles` wants `teacher`. They are not the same type and
 * `Role` is not assignable to it, so something has to translate — and the translation is a
 * FUNCTION rather than a cast, because a cast would typecheck `OWNER as Role` and produce
 * `'OWNER'`, which is not in `ROLE_ORDER`, which `maxRole` then ranks as `undefined`.
 *
 * `OWNER` maps to `teacher` and not to something stronger, because the kernel has no `owner`
 * role. Ownership is a RELATIONSHIP (a column on the classroom) that the matrix reads as
 * `isOwner`; a user who owns a classroom is a teacher for every other purpose, and inventing an
 * `owner` role here would create a fifth role that no rule knows about.
 */
const ROLE_TO_KERNEL: Readonly<Record<ClassroomRole, Role>> = {
  OWNER: 'teacher',
  TEACHER: 'teacher',
  REVIEWER: 'reviewer',
  STUDENT: 'student',
};

/* ------------------------------------------------------------------ *
 * The bridge: enrollments in, an Actor out
 * ------------------------------------------------------------------ */

export interface ResolvedActor extends Actor {
  /** Every classroom the actor is ACTIVE in, for `actorClassroomIds`. */
  readonly classroomIds: readonly string[];
  /** The role in each of those, for display and for the role matrix's `member` check. */
  readonly classroomRoles: Readonly<Record<string, ClassroomRole>>;
}

/**
 * Build an `Actor` whose roles are DERIVED from active enrollments.  (INV-CLASSROOM-1)
 *
 * There is no `claimed` parameter, and its absence is the point. A session may claim a role it
 * no longer holds — the teacher was demoted, the enrollment ended — and a kernel that honours
 * the claim has a teacher who cannot be stopped. The claim is what the client says; the
 * enrollment is what the database says, and only the second one reaches this function.
 *
 * The account status is a PARAMETER rather than a lookup, so this stays a pure-ish function of
 * its arguments and a test can drive every branch without a suspended account lying around.
 */
export function resolveActor(input: {
  readonly userId: string;
  readonly enrollments: readonly {
    readonly classroomId: string;
    readonly role: ClassroomRole;
    readonly endedAt: number | null;
  }[];
  readonly accountStatus: 'ACTIVE' | 'SUSPENDED' | 'DELETING' | 'DELETED';
  readonly now: number;
}): {
  roles: readonly Role[];
  classroomIds: readonly string[];
  classroomRoles: Record<string, ClassroomRole>;
} {
  // `EnrollmentRow` is the KERNEL's shape: `{role, endsAt, withdrawnAt}`, and deliberately
  // without a `classroomId` — the pure function was written for callers that already knew which
  // classroom they were asking about. So the rows are MAPPED here rather than passed through,
  // and `endedAt` becomes `endsAt`: the database column is `endedAt` and the kernel's spelling
  // is `endsAt`, which is the kind of near-miss that surfaces as a missing property rather than
  // as a wrong one, and which would have had `endedAt: undefined` quietly read as "no end date"
  // — i.e. as an ACTIVE enrollment for everybody, forever.
  const kernelRows: EnrollmentRow[] = input.enrollments.map((e) => ({
    role: ROLE_TO_KERNEL[e.role],
    endsAt: e.endedAt,
  }));
  const roles = effectiveRoles({
    enrollments: kernelRows,
    now: input.now,
    accountStatus: input.accountStatus,
  });
  const active = input.enrollments.filter((e) => e.endedAt === null || e.endedAt > input.now);
  return {
    roles,
    classroomIds: [...new Set(active.map((e) => e.classroomId))],
    classroomRoles: Object.fromEntries(active.map((e) => [e.classroomId, e.role])),
  };
}

/** Read a user's enrollments and resolve their effective roles. The one way to build an Actor. */
export async function resolveActorForRequest(
  db: Db,
  userId: string,
  clock: Clock = systemClock,
): Promise<ResolvedActor | null> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      status: true,
      suspendedAt: true,
      deletedAt: true,
      deletingAt: true,
      enrollments: {
        where: { status: 'ACTIVE' },
        select: { classroomId: true, role: true, endedAt: true },
      },
    },
  });
  if (user === null) return null;

  // `UserStatus` is the enum; `suspendedAt`/`deletingAt` are the date columns. Reading the
  // status from the DATES rather than the enum means a row that says `SUSPENDED` without a
  // `suspendedAt` — which a hand edit or a partial import can produce — still reads as
  // suspended. The enum is the claim and the dates are the evidence, and the evidence is what
  // this function is for.
  const accountStatus: 'ACTIVE' | 'SUSPENDED' | 'DELETING' | 'DELETED' =
    user.status === 'DELETED' || user.deletedAt !== null
      ? 'DELETED'
      : user.status === 'DELETING' || user.deletingAt !== null
        ? 'DELETING'
        : user.status === 'SUSPENDED' || user.suspendedAt !== null
          ? 'SUSPENDED'
          : 'ACTIVE';

  const resolved = resolveActor({
    userId,
    enrollments: user.enrollments.map((e) => ({
      classroomId: e.classroomId,
      role: e.role,
      endedAt: e.endedAt === null ? null : e.endedAt.getTime(),
    })),
    accountStatus,
    now: clock.now(),
  });

  return {
    id: user.id,
    roles: resolved.roles,
    mfaVerified: false,
    suspended: accountStatus === 'SUSPENDED',
    classroomIds: resolved.classroomIds,
    classroomRoles: resolved.classroomRoles,
  };
}

/* ------------------------------------------------------------------ *
 * The one place that calls `can()` for a classroom
 * ------------------------------------------------------------------ */

export interface ClassroomCanInput {
  readonly action: Parameters<typeof can>[0]['action'];
  readonly classroomId: string;
  readonly actor: Actor;
}

type CanInput = Parameters<typeof can>[0];

/**
 * Build a COMPLETE `CanInput` for an action on a classroom.
 *
 * ## Why this is one function and not a pattern
 *
 * Because `sameClassroom` is unsatisfiable unless the caller says which classroom the action is
 * scoped to, and forgetting produces a `wrongClassroom` deny that reads like a permissions
 * problem rather than like a missing argument. Every classroom rule in the matrix grants
 * `sameClassroom` — that is the point of it — so EVERY call needs this.
 *
 * The first version of this module called `can()` inline at each site with an empty
 * `context`, and every single one of them returned `wrongClassroom`: the tests said "a student
 * cannot create a classroom" and passed, for the wrong reason, while the owner could not rename
 * their own room. A test that passes for the wrong reason is worse than one that fails, and the
 * fix is structural rather than a matter of remembering.
 *
 * `actorClassroomIds` is read fresh from the database on every call. That is INV-CLASSROOM-2's
 * "within one request" made mechanical: a teacher removed from a classroom loses access on the
 * next call, with no cache to invalidate and no session to kill.
 */
export async function classroomCanInput(
  db: Db,
  input: ClassroomCanInput,
): Promise<
  | { ok: true; canInput: CanInput; ownerId: string; archived: boolean }
  | { ok: false; httpStatus: 403 | 404; reason: string }
> {
  const classroom = await db.classroom.findUnique({
    where: { id: input.classroomId },
    select: { id: true, ownerId: true, archivedAt: true },
  });
  if (classroom === null) return { ok: false, httpStatus: 404, reason: 'no such classroom' };

  const memberships = await db.enrollment.findMany({
    where: { userId: input.actor.id, status: 'ACTIVE' },
    select: { classroomId: true },
  });
  const actorClassroomIds = new Set(memberships.map((m) => m.classroomId));

  return {
    ok: true,
    ownerId: classroom.ownerId,
    archived: classroom.archivedAt !== null,
    canInput: {
      actor: input.actor,
      action: input.action,
      subject: {
        type: 'Classroom',
        id: classroom.id,
        ownerId: classroom.ownerId,
        // A classroom's OWNING CLASSROOM IS ITSELF, and `sameClassroom` compares this against
        // `context.scopeClassroomId`. Leaving it undefined makes the obligation deny with
        // `wrongClassroom` — a second unsatisfiable-obligation bug of the same family as
        // `Classroom.create` claiming `sameClassroom` for a room that does not exist yet. The
        // owner of a room could not rename their own room, and the failure read as a permissions
        // problem rather than as a missing field.
        owningClassroomId: classroom.id,
        sharedClassroomIds: actorClassroomIds,
        // An archived classroom is read-only, and the matrix reads that from the lifecycle
        // status. `undefined` is NOT "ARCHIVED" — the matrix denies on anything it does not
        // RECOGNISE, so an unrecognised value denies, and an archived room must not read as
        // unrecognised.
        ...(classroom.archivedAt === null ? {} : { lifecycleStatus: 'ARCHIVED' as const }),
      },
      context: { actorClassroomIds, scopeClassroomId: classroom.id },
    },
  };
}

/**
 * Authorise, and return the gate's own findings on success.
 *
 * `ownerId` and `archived` come back on the happy path because the caller needs them anyway,
 * and reading them here means one query rather than the two this function would otherwise
 * trigger. A permission check that costs an extra round trip per call is a permission check
 * somebody will eventually inline instead of calling.
 */
export async function permit(
  db: Db,
  input: ClassroomCanInput,
): Promise<
  | { ok: true; ownerId: string; archived: boolean }
  | { ok: false; httpStatus: 403 | 404; reason: string }
> {
  const built = await classroomCanInput(db, input);
  if (!built.ok) return built;
  const decision = can(built.canInput);
  if (!decision.allowed) {
    // `notVisible` is a 404 and `wrongClassroom` is a 403 — the distinction the deny code exists
    // for. A 403 on a classroom the actor has no relationship with tells an attacker the id is
    // real, and a directory of guessed ids is a directory of the system.
    return {
      ok: false,
      httpStatus: decision.reason === 'notVisible' ? 404 : 403,
      reason: decision.reason,
    };
  }
  return { ok: true, ownerId: built.ownerId, archived: built.archived };
}

/* ------------------------------------------------------------------ *
 * P4-T1. Classroom lifecycle
 * ------------------------------------------------------------------ */

/**
 * A slug that is unique per owner.
 *
 * `@@unique([ownerId, slug])` means the database enforces it, and this makes the COMMON case
 * readable: two teachers can each have a "Year 9", and the second one gets "year-9-2" rather
 * than an error. The loop is bounded and then gives up deliberately — a caller that hits the
 * bound gets an error it can report, not a hang.
 */
export async function uniqueClassroomSlug(db: Db, ownerId: string, name: string): Promise<string> {
  const base = toSlug(name);
  // A name with nothing a URL can carry is a USER problem, not something to paper over with a
  // generated slug. The plan says names are free text and the slug is DERIVED, and a classroom
  // called "🎓" has no address to be found at.
  if (!base.ok) throw new Error(`classroom name: ${base.reason}`);
  for (let n = 1; n <= 50; n += 1) {
    const candidate = n === 1 ? base.slug : `${base.slug}-${n}`;
    const taken = await db.classroom.findFirst({
      where: { ownerId, slug: candidate },
      select: { id: true },
    });
    if (taken === null) return candidate;
  }
  throw new Error(`could not derive a free slug for classroom "${name}" after 50 attempts`);
}

export type CreateOutcome =
  | { readonly ok: true; readonly id: string; readonly slug: string }
  | { readonly ok: false; readonly httpStatus: 403; readonly reason: string };

export async function createClassroom(
  db: PrismaClient,
  input: { name: string; description?: string | null; actor: Actor },
): Promise<CreateOutcome> {
  // `create` is checked WITHOUT a classroom scope, because the classroom does not exist yet.
  // `classroomCanInput` is for actions ON a classroom; creation is the one action that
  // establishes one.
  const verdict = can({
    actor: input.actor,
    action: 'create',
    subject: { type: 'Classroom', id: 'new', ownerId: input.actor.id },
  });
  if (!verdict.allowed) return { ok: false, httpStatus: 403, reason: verdict.reason };

  return db.$transaction(async (tx) => {
    const slug = await uniqueClassroomSlug(tx as never, input.actor.id, input.name);
    const row = await tx.classroom.create({
      data: {
        ownerId: input.actor.id,
        name: input.name,
        slug,
        description: input.description ?? null,
      },
      select: { id: true, slug: true },
    });
    // The owner is an ENROLLMENT, not a special case in the owner column alone.
    //
    // The `ownerId` column answers "who is responsible for this space" and is what the matrix's
    // `owner` check reads. An enrollment answers "who is in here" and is what the roster and
    // `actorClassroomIds` read. Writing only the column would make a teacher who owns a
    // classroom invisible in their own roster and unable to be removed from it.
    await tx.enrollment.create({
      data: { classroomId: row.id, userId: input.actor.id, role: 'OWNER' },
    });
    await tx.membershipEvent.create({
      data: {
        classroomId: row.id,
        userId: input.actor.id,
        actorId: input.actor.id,
        kind: 'JOINED',
        toRole: 'OWNER',
      },
    });
    await tx.auditEvent.create({
      data: {
        actorId: input.actor.id,
        action: 'Classroom.create',
        targetType: 'Classroom',
        targetId: row.id,
        classroomId: row.id,
        ipHash: null,
        meta: { name: input.name, slug },
      },
    });
    return { ok: true, id: row.id, slug: row.slug };
  });
}

/**
 * Archive, softly. Read-only afterwards: no new assignments, no new attempts.
 *
 * Soft because B5 — deleting a classroom CASCADED every grade, attempt and receipt, which
 * contradicted INV-CLASSROOM-2. This sets `archivedAt` and nothing else, and the matrix's
 * lifecycle check is what refuses new work.
 */
export async function archiveClassroom(
  db: PrismaClient,
  input: { classroomId: string; actor: Actor },
  clock: Clock = systemClock,
): Promise<{ ok: boolean; httpStatus?: number; reason?: string }> {
  const gate = await permit(db, {
    action: 'update',
    classroomId: input.classroomId,
    actor: input.actor,
  });
  if (!gate.ok) return gate;

  const classroom = await db.classroom.findUnique({
    where: { id: input.classroomId },
    select: { id: true, ownerId: true, archivedAt: true },
  });
  if (classroom === null) return { ok: false, httpStatus: 404, reason: 'no such classroom' };
  if (classroom.archivedAt !== null) {
    // Idempotent, not an error. A double-clicked archive button should not report a failure.
    return { ok: true };
  }

  await db.$transaction(async (tx) => {
    await tx.classroom.update({
      where: { id: classroom.id },
      data: { archivedAt: new Date(clock.now()) },
    });
    await tx.membershipEvent.create({
      data: {
        classroomId: classroom.id,
        userId: input.actor.id,
        actorId: input.actor.id,
        kind: 'CLASSROOM_ARCHIVED',
      },
    });
    await tx.auditEvent.create({
      data: {
        actorId: input.actor.id,
        action: 'Classroom.archive',
        targetType: 'Classroom',
        targetId: classroom.id,
        classroomId: classroom.id,
        ipHash: null,
        meta: {},
      },
    });
  });
  return { ok: true };
}

export type TransferOutcome =
  | { readonly ok: true; readonly previousOwnerId: string; readonly newOwnerId: string }
  | { readonly ok: false; readonly httpStatus: 403 | 404 | 409; readonly reason: string };

/**
 * Hand a classroom to somebody else.  (`plans/12` §1)
 *
 * **Refused unless the target is already a TEACHER in that classroom**, and the reasoning is
 * worth keeping in the code: ownership here is the ability to manage a roster, publish work and
 * release results for a room full of children. Handing it to a student who has never been a
 * teacher is not a promotion, it is an accidental privilege escalation, and the only thing
 * standing between a mis-click and a student owning their classmates' grades is this check.
 *
 * The previous owner is demoted to `TEACHER`, not removed. They keep the ability to grade and
 * publish in a room they ran, and the room does not lose a teacher the moment it changes hands —
 * which is the behaviour people expect and the one a bare transfer gets wrong.
 */
export async function transferClassroomOwnership(
  db: PrismaClient,
  input: { classroomId: string; toUserId: string; reason: string; actor: Actor },
  clock: Clock = systemClock,
): Promise<TransferOutcome> {
  if (input.reason.trim().length < 10) {
    return {
      ok: false,
      httpStatus: 403,
      reason: 'a transfer must say why; it is the one change nobody would otherwise notice',
    };
  }

  const gate = await permit(db, {
    action: 'update',
    classroomId: input.classroomId,
    actor: input.actor,
  });
  if (!gate.ok) return gate;

  const classroom = await db.classroom.findUnique({
    where: { id: input.classroomId },
    select: { id: true, ownerId: true, archivedAt: true },
  });
  if (classroom === null) return { ok: false, httpStatus: 404, reason: 'no such classroom' };
  if (classroom.archivedAt !== null) {
    return { ok: false, httpStatus: 409, reason: 'an archived classroom cannot change hands' };
  }
  // `isSameActor` rather than `classroom.ownerId === input.toUserId`. All three of these are the
  // same question — "is the person being targeted the owner of this room?" — and the
  // authz-ownership gate is right that it should be asked one way. A service that also answers it
  // inline is a service that will eventually answer it wrong, or inconsistently, in one of the
  // three places.
  if (isSameActor(classroom.ownerId, input.toUserId)) {
    return { ok: true, previousOwnerId: classroom.ownerId, newOwnerId: input.toUserId };
  }

  const target = await db.enrollment.findFirst({
    where: { classroomId: classroom.id, userId: input.toUserId, status: 'ACTIVE' },
    select: { id: true, role: true },
  });
  if (target === null) {
    return {
      ok: false,
      httpStatus: 409,
      reason:
        'they are not in this classroom. Ownership is the ability to manage a roster and release ' +
        'grades for a room full of children, so it transfers to a teacher in the room, not to ' +
        'anybody with the id.',
    };
  }
  if (target.role !== 'TEACHER') {
    return {
      ok: false,
      httpStatus: 409,
      reason: `they are enrolled as ${target.role}. Ownership transfers to a TEACHER, not a ${target.role}.`,
    };
  }

  const now = clock.now();
  return db.$transaction(async (tx) => {
    await tx.classroom.update({ where: { id: classroom.id }, data: { ownerId: input.toUserId } });
    await tx.enrollment.update({ where: { id: target.id }, data: { role: 'OWNER' } });
    // The previous owner is DEMOTED, not removed — see the header.
    await tx.enrollment.updateMany({
      where: { classroomId: classroom.id, userId: classroom.ownerId, role: 'OWNER' },
      data: { role: 'TEACHER' },
    });
    for (const [userId, from, to] of [
      [input.toUserId, 'TEACHER', 'OWNER'],
      [classroom.ownerId, 'OWNER', 'TEACHER'],
    ] as const) {
      await tx.membershipEvent.create({
        data: {
          classroomId: classroom.id,
          userId,
          actorId: input.actor.id,
          kind: 'ROLE_CHANGED',
          fromRole: from,
          toRole: to,
        },
      });
    }
    await tx.auditEvent.create({
      data: {
        actorId: input.actor.id,
        action: 'Classroom.transfer',
        targetType: 'Classroom',
        targetId: classroom.id,
        classroomId: classroom.id,
        ipHash: null,
        // The reason goes in the audit row. Six months later "was this a good idea" is
        // unanswerable without knowing why the room changed hands.
        meta: {
          from: classroom.ownerId,
          to: input.toUserId,
          reason: input.reason.trim(),
          at: new Date(now),
        },
      },
    });
    return { ok: true, previousOwnerId: classroom.ownerId, newOwnerId: input.toUserId };
  });
}

/* ------------------------------------------------------------------ *
 * P4-T2. Membership
 * ------------------------------------------------------------------ */

export type MembershipOutcome =
  | { readonly ok: true; readonly alreadyMember: boolean }
  | { readonly ok: false; readonly httpStatus: 403 | 404 | 409; readonly reason: string };

/**
 * Add somebody to a classroom, idempotently.
 *
 * Re-adding a REMOVED or LEFT person REACTIVATES the row rather than inserting a second one,
 * because `@@unique([classroomId, userId])` makes a second insert impossible anyway and the
 * honest repair is to reopen the membership — which also preserves `joinedAt`, so "when did this
 * student join" stays the first day rather than becoming the day they were let back.
 */
export async function addMember(
  db: PrismaClient,
  input: {
    classroomId: string;
    userId: string;
    role: ClassroomRole;
    actor: Actor;
    note?: string | null;
  },
  clock: Clock = systemClock,
): Promise<MembershipOutcome> {
  if (input.role === 'OWNER') {
    return {
      ok: false,
      httpStatus: 403,
      reason:
        'OWNER is not granted by invitation; it comes from creating the room or transferring it',
    };
  }

  const gate = await permit(db, {
    action: 'invite',
    classroomId: input.classroomId,
    actor: input.actor,
  });
  if (!gate.ok) return gate;
  if (gate.archived) {
    return { ok: false, httpStatus: 409, reason: 'an archived classroom is read-only' };
  }
  const classroom = await db.classroom.findUnique({
    where: { id: input.classroomId },
    select: { id: true },
  });
  if (classroom === null) return { ok: false, httpStatus: 404, reason: 'no such classroom' };

  const existing = await db.enrollment.findUnique({
    where: { classroomId_userId: { classroomId: classroom.id, userId: input.userId } },
    select: { id: true, status: true, role: true },
  });
  if (existing !== null && existing.status === 'ACTIVE') {
    return { ok: true, alreadyMember: true };
  }

  const now = new Date(clock.now());
  return db.$transaction(async (tx) => {
    if (existing === null) {
      await tx.enrollment.create({
        data: { classroomId: classroom.id, userId: input.userId, role: input.role },
      });
    } else {
      await tx.enrollment.update({
        where: { id: existing.id },
        data: { status: 'ACTIVE', role: input.role, endedAt: null },
      });
    }
    await tx.membershipEvent.create({
      data: {
        classroomId: classroom.id,
        userId: input.userId,
        actorId: input.actor.id,
        kind: 'JOINED',
        toRole: input.role,
        ...(input.note ? { note: input.note } : {}),
      },
    });
    await tx.auditEvent.create({
      data: {
        actorId: input.actor.id,
        action: 'Enrollment.add',
        targetType: 'Enrollment',
        targetId: input.userId,
        classroomId: classroom.id,
        ipHash: null,
        meta: { role: input.role, reactivated: existing !== null, at: now },
      },
    });
    return { ok: true, alreadyMember: false };
  });
}

/**
 * Change somebody's role.
 *
 * Refuses a change to OWNER, because ownership is not a role you assign — it is what creating
 * the room or transferring it does. A roster screen that can set anybody to OWNER is a screen
 * that can accidentally make a student responsible for everyone, and the transfer path has the
 * TEACHER check that this one would bypass.
 */
export async function changeMemberRole(
  db: PrismaClient,
  input: { classroomId: string; userId: string; role: ClassroomRole; actor: Actor },
): Promise<MembershipOutcome> {
  if (input.role === 'OWNER') {
    return {
      ok: false,
      httpStatus: 403,
      reason: 'use transferClassroomOwnership: OWNER is not assigned through a roster',
    };
  }

  const classroom = await db.classroom.findUnique({
    where: { id: input.classroomId },
    select: { id: true, ownerId: true },
  });
  if (classroom === null) return { ok: false, httpStatus: 404, reason: 'no such classroom' };
  if (isSameActor(classroom.ownerId, input.userId)) {
    return { ok: false, httpStatus: 409, reason: "the owner's role is not a roster setting" };
  }

  // `permit`, not an inline `can()`. This function kept a hand-rolled `can()` with no
  // `context` after every sibling was refactored onto the shared builder, and it failed
  // `sameClassroom` with `wrongClassroom` — a deny that reads like a permissions problem and
  // had nothing to do with permissions. It is the third time in this file that an inline call
  // site was the bug, which is the reason `permit` exists and the reason the file now has
  // exactly ONE inline `can()`: the `create` call, where there is no classroom to scope to.
  const gate = await permit(db, {
    action: 'changeRole',
    classroomId: input.classroomId,
    actor: input.actor,
  });
  if (!gate.ok) return gate;

  const existing = await db.enrollment.findUnique({
    where: { classroomId_userId: { classroomId: classroom.id, userId: input.userId } },
    select: { id: true, role: true, status: true },
  });
  if (existing === null)
    return { ok: false, httpStatus: 404, reason: 'they are not in this classroom' };
  if (existing.role === input.role) return { ok: true, alreadyMember: true };

  return db.$transaction(async (tx) => {
    await tx.enrollment.update({ where: { id: existing.id }, data: { role: input.role } });
    await tx.membershipEvent.create({
      data: {
        classroomId: classroom.id,
        userId: input.userId,
        actorId: input.actor.id,
        kind: 'ROLE_CHANGED',
        fromRole: existing.role,
        toRole: input.role,
      },
    });
    await tx.auditEvent.create({
      data: {
        actorId: input.actor.id,
        action: 'Enrollment.changeRole',
        targetType: 'Enrollment',
        targetId: input.userId,
        classroomId: classroom.id,
        ipHash: null,
        meta: { from: existing.role, to: input.role },
      },
    });
    return { ok: true, alreadyMember: false };
  });
}

/**
 * Remove somebody, or let them leave.  (INV-CLASSROOM-2)
 *
 * `byThemselves` distinguishes a student leaving from a teacher removing them, and the difference
 * is recorded in the history because "left" and "was removed" are different facts that a school
 * needs to be able to tell apart.
 *
 * ## What this does NOT do, and there is no flag to make it do it
 *
 * It does not touch attempts, responses, grades or the student's own release history. INV-
 * CLASSROOM-2 says departure preserves the student's access to their own records, and the way to
 * guarantee that is for this function to have no parameter capable of expressing the opposite.
 * A `cascade` flag here would be a `false` that reads as a decision and a `true` that nobody
 * would think twice about.
 *
 * The access revocation is not in this function either — it is in `resolveActorForRequest`, which
 * derives roles from ACTIVE enrollments, so it applies on the very next request with no cache to
 * invalidate and no session to kill.
 */
export async function endMembership(
  db: PrismaClient,
  input: {
    classroomId: string;
    userId: string;
    byThemselves?: boolean;
    actor: Actor;
    reason?: string | null;
  },
  clock: Clock = systemClock,
): Promise<MembershipOutcome> {
  const byThemselves = input.byThemselves === true;
  // A SELF-LEAVE IS NOT A REMOVAL, and it must not be gated as one.
  //
  // The first version gated `removeMember` before checking `byThemselves`, so a student could
  // not leave a classroom — they would need the power to remove themselves, which is precisely
  // the power INV-CLASSROOM-2 assumes they lack. The feature was impossible for its primary
  // user, and the failure was a `403` that reads like a permissions problem.
  if (!byThemselves) {
    const gate = await permit(db, {
      action: 'removeMember',
      classroomId: input.classroomId,
      actor: input.actor,
    });
    if (!gate.ok) return gate;
  }
  const classroom = await db.classroom.findUnique({
    where: { id: input.classroomId },
    select: { id: true, ownerId: true },
  });
  if (classroom === null) return { ok: false, httpStatus: 404, reason: 'no such classroom' };
  if (isSameActor(classroom.ownerId, input.userId)) {
    return {
      ok: false,
      httpStatus: 409,
      reason: 'the owner cannot leave. Transfer the classroom or archive it.',
    };
  }

  const existing = await db.enrollment.findUnique({
    where: { classroomId_userId: { classroomId: classroom.id, userId: input.userId } },
    select: { id: true, status: true, role: true },
  });
  if (existing === null)
    return { ok: false, httpStatus: 404, reason: 'they are not in this classroom' };
  if (existing.status !== 'ACTIVE') return { ok: true, alreadyMember: false };

  const now = new Date(clock.now());
  return db.$transaction(async (tx) => {
    await tx.enrollment.update({
      where: { id: existing.id },
      data: { status: byThemselves ? 'LEFT' : 'REMOVED', endedAt: now },
    });
    await tx.membershipEvent.create({
      data: {
        classroomId: classroom.id,
        userId: input.userId,
        // A self-leave has no actor, and that is the interesting case: the common one for
        // INV-CLASSROOM-2 is a student deciding to leave, and the history should not imply a
        // teacher pushed them out.
        actorId: byThemselves ? null : input.actor.id,
        kind: byThemselves ? 'LEFT' : 'REMOVED',
        fromRole: existing.role,
        ...(input.reason ? { note: input.reason } : {}),
      },
    });
    await tx.auditEvent.create({
      data: {
        actorId: input.actor.id,
        action: byThemselves ? 'Enrollment.leave' : 'Enrollment.remove',
        targetType: 'Enrollment',
        targetId: input.userId,
        classroomId: classroom.id,
        ipHash: null,
        // INV-CLASSROOM-2, stated in the record itself: the student's own records are NOT
        // touched by departure, and a reader of this row six months later should not have to
        // take that on trust.
        meta: { role: existing.role, recordsPreserved: true },
      },
    });
    return { ok: true, alreadyMember: false };
  });
}

/* ------------------------------------------------------------------ *
 * The query that carries the scope
 * ------------------------------------------------------------------ */

export interface ClassroomSummary {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly ownerId: string;
  readonly archived: boolean;
  /** The actor's role in THIS classroom, which is not the same as their maximum role. */
  readonly myRole: ClassroomRole | null;
  readonly memberCount: number;
}

/**
 * The classrooms an actor may see, scoped IN THE QUERY.
 *
 * The `where` carries both relationships the matrix knows about — owned, and actively enrolled —
 * and the `select` resolves `myRole` from the same row rather than by a second lookup per
 * classroom, which is the N+1 this shape avoids.
 *
 * `actorClassroomIds` is NOT used to filter here. It is the set of classrooms the actor is in,
 * and using it would mean reading the other classrooms first.
 */
export async function listClassroomsFor(
  db: Db,
  actor: Actor & { readonly classroomIds?: readonly string[] },
): Promise<readonly ClassroomSummary[]> {
  const rows = await db.classroom.findMany({
    where: {
      // Platform admins see everything; everybody else sees owned-or-enrolled. One predicate,
      // and the alternative — every classroom then a filter — is the post-filter mistake.
      ...(actor.roles.includes('platformAdmin')
        ? {}
        : {
            OR: [
              { ownerId: actor.id },
              { enrollments: { some: { userId: actor.id, status: 'ACTIVE' } } },
            ],
          }),
    },
    orderBy: [{ archivedAt: 'asc' }, { name: 'asc' }],
    select: {
      id: true,
      name: true,
      slug: true,
      ownerId: true,
      archivedAt: true,
      _count: { select: { enrollments: { where: { status: 'ACTIVE' } } } },
      enrollments: {
        where: { userId: actor.id },
        select: { role: true, status: true },
        take: 1,
      },
    },
  });
  return rows.map((r) => {
    const mine = r.enrollments.find((e) => e.status === 'ACTIVE');
    return {
      id: r.id,
      name: r.name,
      slug: r.slug,
      ownerId: r.ownerId,
      archived: r.archivedAt !== null,
      // `isSameActor`, for the same reason the authz-ownership gate insists: "is this mine?" is
      // an identity question and belongs in one place. A row can be owned by somebody who is no
      // longer enrolled — a transfer demotes rather than removes, but a direct owner-column edit
      // would do it — and the enrollment is the better answer when there is one.
      myRole: mine?.role ?? (isSameActor(r.ownerId, actor.id) ? 'OWNER' : null),
      memberCount: r._count.enrollments,
    };
  });
}

/**
 * Authorise an action on a classroom, loading the scope the matrix needs.
 *
 * Every call into `can()` for a classroom goes through here, so there is exactly one place that
 * knows how to turn a `(classroomId, actor)` pair into the `actorClassroomIds` the rules read.
 * A caller that assembles that set by hand is the bug this function exists to prevent.
 */
export async function canOnClassroom(
  db: Db,
  input: ClassroomCanInput,
): Promise<{ allowed: true } | { allowed: false; reason: string }> {
  const built = await classroomCanInput(db, input);
  if (!built.ok)
    return { allowed: false, reason: built.httpStatus === 404 ? 'notFound' : built.reason };
  const decision = can(built.canInput);
  return decision.allowed ? { allowed: true } : { allowed: false, reason: decision.reason };
}

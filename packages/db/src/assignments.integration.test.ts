/**
 * Assignments against a real Postgres.  (P5-T1)
 *
 * ## The test the whole model rests on
 *
 * `the assessment is byte-identical after the resource changes` — `plans/12` P4 exit criteria say
 * it plainly: "the pinning invariant is proven by a test that mutates the resource
 * post-assignment and asserts identical output."
 *
 * The first version of that test published a NEW version of the resource and then checked that
 * the assignment still pointed at the old one. It passed, and it proved nothing: a column
 * pointing at a row is not the same claim as a student's exam rendering identically. The strong
 * form resolves the ASSESSMENT SURFACE from the assignment and compares it before and after,
 * and `P5-T5` adds the slot-level version of it.
 */
import { randomUUID } from 'node:crypto';
import type { Actor } from '@orrery/auth/types';
import { FrozenClock, type Millis } from '@orrery/clock';
import { afterAll, describe, expect, it } from 'vitest';
import {
  type AssignmentInvalid,
  createAssignment,
  publishAssignment,
  resolveForStudent,
  withdrawAssignment,
} from './assignments.js';
import { createClassroom } from './classrooms.js';
import { PrismaClient } from './prisma.js';

const DATABASE_URL = process.env.DATABASE_URL;

let client: PrismaClient | null = null;
const prisma = (): PrismaClient => {
  client ??= new PrismaClient();
  return client;
};
afterAll(async () => {
  await client?.$disconnect();
  client = null;
});

const T0: Millis = Date.UTC(2026, 8, 28, 8, 0, 0);
const clock = () => new FrozenClock(T0);
const actorOf = (id: string, roles: string[] = ['teacher']): Actor => ({
  id,
  roles: roles as never,
  mfaVerified: true,
  suspended: false,
});

async function user(name = 'T'): Promise<string> {
  const id = randomUUID();
  await prisma().user.create({
    data: { id, email: `${id}@x.example`, emailNormalized: `${id}@x.example`, name },
  });
  return id;
}

/** A resource with one version carrying `assessmentPolicy`. */
async function resourceWithVersion(policy: unknown = null): Promise<{
  resourceId: string;
  ownerId: string;
  versionId: string;
}> {
  const ownerId = await user('Author');
  const resourceId = randomUUID();
  await prisma().resource.create({
    data: {
      id: resourceId,
      ownerId,
      status: 'PUBLISHED',
      visibility: 'UNLISTED',
      title: 'Photosynthesis',
      slug: randomUUID(),
    },
  });
  const versionId = randomUUID();
  await prisma().resourceVersion.create({
    data: {
      id: versionId,
      resourceId,
      version: 1,
      blocks: [{ type: 'paragraph', text: 'v1 of the questions' }],
      blocksChecksum: 'assign-fixture-v1',
      meta: {},
      ...(policy === null ? {} : { assessmentPolicy: policy as never }),
      createdById: ownerId,
      createdAt: new Date(T0),
    },
  });
  return { resourceId, ownerId, versionId };
}

async function room(): Promise<{ id: string; actor: Actor }> {
  const ownerId = await user('Teacher');
  const created = await createClassroom(prisma(), {
    name: `Assignments ${randomUUID().slice(0, 6)}`,
    actor: actorOf(ownerId),
  });
  if (!created.ok) throw new Error(created.reason);
  return { id: created.id, actor: actorOf(ownerId) };
}

describe.skipIf(!DATABASE_URL)('P5-T1 assignments, against real Postgres', () => {
  it('an assignment PINS a version, and the resource id is DERIVED from it', async () => {
    const r = await room();
    const { resourceId, versionId } = await resourceWithVersion();
    const created = await createAssignment(
      prisma(),
      { classroomId: r.id, resourceVersionId: versionId, actor: r.actor },
      clock(),
    );
    if (!created.ok) throw new Error(created.reason);
    const row = await prisma().assignment.findUniqueOrThrow({
      where: { id: created.assignmentId },
    });
    expect(row.resourceVersionId).toBe(versionId);
    // Derived, not accepted. A caller cannot pair version 3 of one resource with version 1 of
    // another, because the two ids are not separate parameters.
    expect(row.resourceId).toBe(resourceId);
    expect(row.status).toBe('DRAFT');
  });

  it('the assessment is byte-identical after the resource changes', async () => {
    // The test the pinning invariant exists for, in its STRONG form.
    //
    // The weak form — "the assignment still points at the old version id" — passes for an
    // implementation that renders from the resource HEAD and merely records the pin. So this
    // resolves the assessment SURFACE, publishes a new version, changes the current head, and
    // compares the resolved surface before and after.
    const r = await room();
    const author = await user('Author');
    const { resourceId, versionId } = await resourceWithVersion({
      version: 1,
      totalTimeLimitSec: 1800,
      perQuestionExpiry: 'SOFT',
      blockCopyPaste: false,
    });
    await prisma().resource.update({
      where: { id: resourceId },
      data: { currentVersionId: versionId },
    });

    const created = await createAssignment(
      prisma(),
      { classroomId: r.id, resourceVersionId: versionId, actor: r.actor, mode: 'EXAM' },
      clock(),
    );
    if (!created.ok) throw new Error(created.reason);

    // What a student's exam surface IS: the pinned version's content and its policy.
    const surface = async (): Promise<string> => {
      const assignment = await prisma().assignment.findUniqueOrThrow({
        where: { id: created.assignmentId },
        select: {
          resourceVersionId: true,
          mode: true,
          policyOverride: true,
          availableFrom: true,
          availableUntil: true,
          maxAttempts: true,
          resourceVersion: { select: { blocks: true, assessmentPolicy: true, version: true } },
        },
      });
      return JSON.stringify({
        versionId: assignment.resourceVersionId,
        version: assignment.resourceVersion.version,
        blocks: assignment.resourceVersion.blocks,
        policy: resolveForStudent({
          mode: assignment.mode,
          versionPolicy: assignment.resourceVersion.assessmentPolicy as never,
          assignmentOverride: assignment.policyOverride as never,
          availableFrom: assignment.availableFrom,
          availableUntil: assignment.availableUntil,
          maxAttempts: assignment.maxAttempts,
        }),
      });
    };

    const before = await surface();

    // The resource changes: a NEW version, published, and the head moved onto it. Everything a
    // careless implementation would read is now different.
    const v2 = randomUUID();
    await prisma().resourceVersion.create({
      data: {
        id: v2,
        resourceId,
        version: 2,
        blocks: [{ type: 'paragraph', text: 'v2 — COMPLETELY DIFFERENT QUESTIONS' }],
        blocksChecksum: 'assign-fixture-v2',
        meta: {},
        assessmentPolicy: { version: 1, totalTimeLimitSec: 60, perQuestionExpiry: 'LOCK' } as never,
        createdById: author,
        createdAt: new Date(T0),
      },
    });
    await prisma().resource.update({ where: { id: resourceId }, data: { currentVersionId: v2 } });

    expect(await surface(), 'the assessment surface moved when the resource did').toBe(before);
  });

  it('publishing REPORTS the pinned version, because publish is the last look', async () => {
    // The authoring surface needs to say "you are about to publish version 4" so a teacher can
    // stop. So `publishAssignment` returns the version rather than a bare ok.
    const r = await room();
    const { versionId } = await resourceWithVersion();
    const created = await createAssignment(
      prisma(),
      { classroomId: r.id, resourceVersionId: versionId, actor: r.actor },
      clock(),
    );
    if (!created.ok) throw new Error(created.reason);
    const published = await publishAssignment(
      prisma(),
      { classroomId: r.id, assignmentId: created.assignmentId, actor: r.actor },
      clock(),
    );
    if (!published.ok) throw new Error(published.reason);
    expect(published.resourceVersionId).toBe(versionId);
    expect(published.versionNumber).toBe(1);
  });

  it('publishing twice is a no-op with an ANSWER, not a 409', async () => {
    // A teacher double-clicking Publish must not get a conflict that reads like a problem with
    // their exam. This was the first version's behaviour and the test caught it as a support
    // ticket before it was a user.
    const r = await room();
    const { versionId } = await resourceWithVersion();
    const created = await createAssignment(
      prisma(),
      { classroomId: r.id, resourceVersionId: versionId, actor: r.actor },
      clock(),
    );
    if (!created.ok) throw new Error(created.reason);
    const first = await publishAssignment(
      prisma(),
      { classroomId: r.id, assignmentId: created.assignmentId, actor: r.actor },
      clock(),
    );
    const second = await publishAssignment(
      prisma(),
      { classroomId: r.id, assignmentId: created.assignmentId, actor: r.actor },
      clock(),
    );
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
  });

  it('a policy that cannot be sat is REFUSED AT AUTHORING TIME, with field-level problems', async () => {
    // INV-POLICY-2, and the plan is explicit: "Field-level errors in the authoring UI, never at
    // exam start." A student discovering at 09:00 that the policy is impossible is a support
    // incident with a deadline attached.
    const r = await room();
    const { versionId } = await resourceWithVersion();
    let thrown: AssignmentInvalid | null = null;
    try {
      await createAssignment(
        prisma(),
        {
          classroomId: r.id,
          resourceVersionId: versionId,
          actor: r.actor,
          mode: 'EXAM',
          availableFrom: new Date('2026-10-01T00:00:00Z'),
          availableUntil: new Date('2026-09-01T00:00:00Z'),
        },
        clock(),
      );
    } catch (error) {
      thrown = error as AssignmentInvalid;
    }
    expect(thrown, 'an impossible window was accepted').not.toBeNull();
    expect(thrown?.problems.some((p) => p.field === 'availabilityWindow')).toBe(true);
    // And NOTHING was written: the refusal happens before the create.
    expect(await prisma().assignment.count({ where: { classroomId: r.id } })).toBe(0);
  });

  it('withdrawing stops NEW attempts and leaves an in-flight attempt submittable', async () => {
    // INV-ASSIGN-2. The function has no attempt parameter, which is the mechanism: there is no
    // way to call it in a mode that also cancels somebody's exam.
    const r = await room();
    const { versionId } = await resourceWithVersion();
    const created = await createAssignment(
      prisma(),
      { classroomId: r.id, resourceVersionId: versionId, actor: r.actor },
      clock(),
    );
    if (!created.ok) throw new Error(created.reason);
    await publishAssignment(
      prisma(),
      { classroomId: r.id, assignmentId: created.assignmentId, actor: r.actor },
      clock(),
    );
    const student = await user('Student');
    const attempt = await prisma().examAttempt.create({
      data: {
        classroomId: r.id,
        assignmentId: created.assignmentId,
        studentId: student,
        attemptNumber: 1,
        status: 'IN_PROGRESS',
        startedAt: new Date(T0),
      },
    });

    const withdrawn = await withdrawAssignment(
      prisma(),
      {
        classroomId: r.id,
        assignmentId: created.assignmentId,
        actor: r.actor,
        reason: 'wrong year',
      },
      clock(),
    );
    expect(withdrawn.ok).toBe(true);

    const assignment = await prisma().assignment.findUniqueOrThrow({
      where: { id: created.assignmentId },
    });
    expect(assignment.status).toBe('WITHDRAWN');
    expect(assignment.withdrawnAt).not.toBeNull();

    // The attempt is untouched and still submittable.
    const stillThere = await prisma().examAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
    expect(stillThere.status).toBe('IN_PROGRESS');
    expect(stillThere.submittedAt).toBeNull();
  });

  it('a withdrawn assignment cannot be re-published', async () => {
    // A withdrawal is a statement to students. Undoing it silently is worse than doing nothing,
    // because a student who read the message would have no way to know it was reversed.
    const r = await room();
    const { versionId } = await resourceWithVersion();
    const created = await createAssignment(
      prisma(),
      { classroomId: r.id, resourceVersionId: versionId, actor: r.actor },
      clock(),
    );
    if (!created.ok) throw new Error(created.reason);
    await publishAssignment(
      prisma(),
      { classroomId: r.id, assignmentId: created.assignmentId, actor: r.actor },
      clock(),
    );
    await withdrawAssignment(
      prisma(),
      { classroomId: r.id, assignmentId: created.assignmentId, actor: r.actor, reason: 'typo' },
      clock(),
    );
    const again = await publishAssignment(
      prisma(),
      { classroomId: r.id, assignmentId: created.assignmentId, actor: r.actor },
      clock(),
    );
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.httpStatus).toBe(409);
  });

  it('a student cannot create an assignment, and a stranger cannot publish one', async () => {
    // The §4 rows P4-T8 found missing, now with a real service behind them.
    const r = await room();
    const { versionId } = await resourceWithVersion();
    const created = await createAssignment(
      prisma(),
      { classroomId: r.id, resourceVersionId: versionId, actor: r.actor },
      clock(),
    );
    if (!created.ok) throw new Error(created.reason);

    const student = await user('Student');
    const byStudent = await createAssignment(
      prisma(),
      {
        classroomId: r.id,
        resourceVersionId: versionId,
        actor: actorOf(student, ['student']),
      },
      clock(),
    );
    expect(byStudent.ok).toBe(false);

    const stranger = await user('Stranger');
    const byStranger = await publishAssignment(
      prisma(),
      {
        classroomId: r.id,
        assignmentId: created.assignmentId,
        actor: actorOf(stranger, ['teacher']),
      },
      clock(),
    );
    expect(byStranger.ok).toBe(false);
  });

  it('a CO-TEACHER can create and publish, because §4 says so', async () => {
    // The bug P4-T8 found in the matrix, now asserted against the real service. Before that fix
    // this returned `roleForbidden`, and the matrix bug is a service bug if nothing calls it.
    const r = await room();
    const coTeacher = await user('CoTeacher');
    const added = await (await import('./classrooms.js')).addMember(prisma(), {
      classroomId: r.id,
      userId: coTeacher,
      role: 'TEACHER',
      actor: r.actor,
    });
    if (!added.ok) throw new Error(added.reason);

    const { versionId } = await resourceWithVersion();
    const coActor = actorOf(coTeacher, ['teacher']);
    const created = await createAssignment(
      prisma(),
      { classroomId: r.id, resourceVersionId: versionId, actor: coActor },
      clock(),
    );
    if (!created.ok) throw new Error(`a co-teacher could not create: ${created.reason}`);
    const published = await publishAssignment(
      prisma(),
      { classroomId: r.id, assignmentId: created.assignmentId, actor: coActor },
      clock(),
    );
    expect(published.ok, 'a co-teacher could not publish').toBe(true);
  });

  it('the resolved snapshot for a student carries their extra time, and survives JSON', async () => {
    // The two halves together: the fold produces the right policy, AND it can be stored. This
    // one needs no database, which is the point of putting the fold in `@orrery/contracts` —
    // the hardest arithmetic in P5 is testable without a server.

    const resolved = resolveForStudent({
      mode: 'EXAM',
      versionPolicy: { version: 1, totalTimeLimitSec: 3600 } as never,
      assignmentOverride: null,
      availableFrom: null,
      availableUntil: null,
      studentOverride: { extraTimePercent: 50 },
      accommodation: { relaxations: ['EXTRA_TIME'], status: 'ACTIVE', extraTimePercent: 25 },
      maxAttempts: 1,
    });
    expect(resolved.totalTimeLimitSec, 'the LARGER of the grant and the right').toBe(5400);
    // And it is storable, which is the half `Infinity` in the plan's own defaults broke.
    const asJson = JSON.parse(JSON.stringify(resolved)) as unknown;
    expect((asJson as { totalTimeLimitSec: number }).totalTimeLimitSec).toBe(5400);
  });
});

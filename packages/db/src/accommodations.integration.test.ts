/**
 * Accommodations, against real Postgres.  (P8-T12)
 *
 * The mid-exam case is the whole task, and it is the one no pure test can reach: the claim being made is about what a
 * RUNNING attempt looks like afterwards -- a clock that moved, an extension row, a relaxation the client can read -- and
 * every part of that is a statement about the database.
 */

import { randomUUID } from 'node:crypto';

import { producesViolation } from '@orrery/exam-engine/accommodations';
import { afterAll, describe, expect, it } from 'vitest';

import { activeRelaxationsFor, grantAccommodation, revokeAccommodation } from './accommodations.js';
import { PrismaClient } from './prisma.js';

let client: PrismaClient | null = null;
const prisma = (): PrismaClient => {
  client ??= new PrismaClient();
  return client;
};

afterAll(async () => {
  await client?.$disconnect();
  client = null;
});

const T0 = 1_800_000_000_000;
const REASON = 'screen-reader user, fullscreen is unusable with the magnifier';

interface Fixture {
  studentId: string;
  teacherId: string;
  classroomId: string;
  assignmentId: string;
  attemptId: string;
}

const fixture = async (over: {
  totalTimeLimitSec: number | null;
  status?: string;
}): Promise<Fixture> => {
  const db = prisma();
  const teacherId = randomUUID();
  const studentId = randomUUID();

  await db.user.create({
    data: {
      id: teacherId,
      email: `${teacherId}@s.example`,
      emailNormalized: `${teacherId}@s.example`,
      name: 'T',
    },
  });
  await db.user.create({
    data: {
      id: studentId,
      email: `${studentId}@s.example`,
      emailNormalized: `${studentId}@s.example`,
      name: 'S',
    },
  });

  const resource = await db.resource.create({
    data: {
      id: randomUUID(),
      ownerId: teacherId,
      status: 'PUBLISHED',
      visibility: 'UNLISTED',
      title: 'Accommodations',
      slug: randomUUID(),
    },
  });
  const version = await db.resourceVersion.create({
    data: {
      id: randomUUID(),
      resourceId: resource.id,
      version: 1,
      blocks: [],
      blocksChecksum: 'acc',
      meta: {},
      createdById: teacherId,
    },
  });
  const classroom = await db.classroom.create({
    data: { id: randomUUID(), ownerId: teacherId, name: 'Acc', slug: randomUUID() },
  });
  const assignment = await db.assignment.create({
    data: {
      id: randomUUID(),
      classroomId: classroom.id,
      resourceId: resource.id,
      resourceVersionId: version.id,
      status: 'PUBLISHED',
      createdById: teacherId,
    },
  });
  const attempt = await db.examAttempt.create({
    data: {
      id: randomUUID(),
      assignmentId: assignment.id,
      classroomId: classroom.id,
      studentId,
      attemptNumber: 1,
      status: (over.status ?? 'IN_PROGRESS') as never,
      ...(over.totalTimeLimitSec === null
        ? {}
        : { deadlineAt: new Date(T0 + over.totalTimeLimitSec * 1000) }),
      policySnapshot: { version: 1, totalTimeLimitSec: over.totalTimeLimitSec, gracePeriodSec: 60 },
    },
  });

  return {
    studentId,
    teacherId,
    classroomId: classroom.id,
    assignmentId: assignment.id,
    attemptId: attempt.id,
  };
};

describe.skipIf(!process.env.DATABASE_URL)('granting an accommodation MID-EXAM', () => {
  it('extends the clock with an ADDITIVE ROW and leaves `deadlineAt` alone', async () => {
    /**
     * `INV-POLICY-1`/`C14`: `deadlineAt` is never rewritten. Rewriting it would discard every extension already
     * granted, because the recomputed value comes from the base rather than from what is in force -- and the assertion is
     * on the stored deadline because that is the only place the distinction is visible.
     */
    const f = await fixture({ totalTimeLimitSec: 3 * 3600 });

    const result = await grantAccommodation(prisma(), {
      studentId: f.studentId,
      classroomId: f.classroomId,
      assignmentId: f.assignmentId,
      relaxations: ['EXTRA_TIME_PERCENT'],
      extraTimePercent: 25,
      reason: REASON,
      grantedById: f.teacherId,
      nowMs: T0,
    });

    expect(result.ok, result.ok ? '' : result.reason).toBe(true);
    if (!result.ok) return;
    expect(result.addedSec).toBe(45 * 60);
    expect(result.extendedAttemptId).toBe(f.attemptId);

    const attempt = await prisma().examAttempt.findUniqueOrThrow({ where: { id: f.attemptId } });
    // The base deadline is untouched. Every extension is a row, so "grant twice" means "add twice".
    expect(attempt.deadlineAt?.getTime()).toBe(T0 + 3 * 3600 * 1000);

    const extensions = await prisma().attemptDeadlineExtension.findMany({
      where: { attemptId: f.attemptId },
    });
    expect(extensions).toHaveLength(1);
    expect(extensions[0]?.addedSec).toBe(45 * 60);
  });

  it('ADDS rather than REPLACES when granted twice', async () => {
    const f = await fixture({ totalTimeLimitSec: 3600 });
    const grant = () =>
      grantAccommodation(prisma(), {
        studentId: f.studentId,
        classroomId: f.classroomId,
        assignmentId: f.assignmentId,
        relaxations: ['EXTRA_TIME_PERCENT'],
        extraTimePercent: 25,
        reason: REASON,
        grantedById: f.teacherId,
        nowMs: T0,
      });

    expect((await grant()).ok).toBe(true);
    expect((await grant()).ok).toBe(true);

    const extensions = await prisma().attemptDeadlineExtension.findMany({
      where: { attemptId: f.attemptId },
    });
    expect(extensions.map((row) => row.addedSec)).toEqual([15 * 60, 15 * 60]);
    expect(extensions.reduce((sum, row) => sum + row.addedSec, 0)).toBe(30 * 60);
  });

  it('makes the relaxation VISIBLE TO THE CLIENT, and the client is what silences the guard', async () => {
    /**
     * The server can stop counting strikes the moment the row exists; the browser guard cannot stop nagging until it
     * hears about it. So the read side is the half that actually silences anything, and it reads the DATABASE rather
     * than accepting a list -- a client that could assert its own exemptions would be defeated by one line of
     * JavaScript.
     */
    const f = await fixture({ totalTimeLimitSec: 3600 });
    await grantAccommodation(prisma(), {
      studentId: f.studentId,
      classroomId: f.classroomId,
      relaxations: ['DISABLE_FULLSCREEN'],
      reason: REASON,
      grantedById: f.teacherId,
      nowMs: T0,
    });

    const relaxations = await activeRelaxationsFor(prisma(), {
      studentId: f.studentId,
      classroomId: f.classroomId,
      assignmentId: f.assignmentId,
      nowMs: T0,
    });

    expect(relaxations).toContain('DISABLE_FULLSCREEN');
    // And the effect on an integrity decision, end to end: `INV-ACC-1`.
    expect(producesViolation('FULLSCREEN', relaxations)).toBe(false);
    expect(producesViolation('COPY', relaxations)).toBe(true);
  });

  it('HONOURS `expiresAt` on the read, because a job that might not run is not an expiry', async () => {
    const f = await fixture({ totalTimeLimitSec: 3600 });
    const accommodation = await prisma().accommodation.create({
      data: {
        classroomId: f.classroomId,
        studentId: f.studentId,
        relaxations: ['DISABLE_FULLSCREEN'],
        reason: REASON,
        grantedById: f.teacherId,
        grantedAt: new Date(T0),
        expiresAt: new Date(T0 + 1000),
        status: 'ACTIVE',
      },
      select: { id: true },
    });

    const before = await activeRelaxationsFor(prisma(), {
      studentId: f.studentId,
      classroomId: f.classroomId,
      nowMs: T0,
    });
    const after = await activeRelaxationsFor(prisma(), {
      studentId: f.studentId,
      classroomId: f.classroomId,
      nowMs: T0 + 2000,
    });

    expect(before).toContain('DISABLE_FULLSCREEN');
    expect(after).not.toContain('DISABLE_FULLSCREEN');
    void accommodation;
  });

  it('REFUSES WITHOUT A REASON, because an unexplained gap in a record cannot be challenged', async () => {
    const f = await fixture({ totalTimeLimitSec: 3600 });
    const result = await grantAccommodation(prisma(), {
      studentId: f.studentId,
      classroomId: f.classroomId,
      relaxations: ['DISABLE_FULLSCREEN'],
      reason: 'because',
      grantedById: f.teacherId,
      nowMs: T0,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('NO_REASON');
  });

  it('REFUSES AN EMPTY RELAXATION LIST rather than recording an accommodation that grants nothing', async () => {
    const f = await fixture({ totalTimeLimitSec: 3600 });
    const result = await grantAccommodation(prisma(), {
      studentId: f.studentId,
      classroomId: f.classroomId,
      relaxations: [],
      reason: REASON,
      grantedById: f.teacherId,
      nowMs: T0,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('NO_RELAXATIONS');
  });

  it('ADDS NO TIME to a paper with no time limit, rather than dividing by nothing', async () => {
    const f = await fixture({ totalTimeLimitSec: null });
    const result = await grantAccommodation(prisma(), {
      studentId: f.studentId,
      classroomId: f.classroomId,
      relaxations: ['EXTRA_TIME_PERCENT'],
      extraTimePercent: 50,
      reason: REASON,
      grantedById: f.teacherId,
      nowMs: T0,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.addedSec).toBe(0);
  });

  it('REVOKES WITHOUT TAKING THE TIME BACK', async () => {
    /**
     * A student who has already spent the extra time cannot un-spend it, and shortening `deadlineAt` mid-exam is the
     * class of bug `V-12` corrected: an irreversible change to a live attempt made by the platform rather than a person.
     */
    const f = await fixture({ totalTimeLimitSec: 3600 });
    const granted = await grantAccommodation(prisma(), {
      studentId: f.studentId,
      classroomId: f.classroomId,
      relaxations: ['DISABLE_FULLSCREEN', 'EXTRA_TIME_PERCENT'],
      extraTimePercent: 25,
      reason: REASON,
      grantedById: f.teacherId,
      nowMs: T0,
    });
    expect(granted.ok).toBe(true);
    if (!granted.ok) return;

    const revoked = await revokeAccommodation(prisma(), {
      accommodationId: granted.accommodationId,
      revokedById: f.teacherId,
      nowMs: T0 + 60_000,
    });
    expect(revoked.ok).toBe(true);

    // The relaxation stops applying.
    expect(
      await activeRelaxationsFor(prisma(), {
        studentId: f.studentId,
        classroomId: f.classroomId,
        nowMs: T0 + 120_000,
      }),
    ).not.toContain('DISABLE_FULLSCREEN');

    // The extension stands.
    const extensions = await prisma().attemptDeadlineExtension.findMany({
      where: { attemptId: f.attemptId },
    });
    expect(extensions).toHaveLength(1);
    const attempt = await prisma().examAttempt.findUniqueOrThrow({ where: { id: f.attemptId } });
    expect(attempt.deadlineAt?.getTime()).toBe(T0 + 3600 * 1000);
  });

  it('does NOT extend a FROZEN attempt, because a freeze is a teacher decision mid-flight', async () => {
    // The grant is still recorded -- the student's accommodations do not evaporate -- but extending the clock of an
    // attempt a teacher is actively reviewing would be the platform deciding the outcome.
    const f = await fixture({ totalTimeLimitSec: 3600, status: 'FROZEN' });
    const result = await grantAccommodation(prisma(), {
      studentId: f.studentId,
      classroomId: f.classroomId,
      relaxations: ['EXTRA_TIME_PERCENT'],
      extraTimePercent: 25,
      reason: REASON,
      grantedById: f.teacherId,
      nowMs: T0,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.addedSec).toBe(0);
    expect(
      await prisma().attemptDeadlineExtension.count({ where: { attemptId: f.attemptId } }),
    ).toBe(0);
  });
});

/**
 * Per-student overrides and mid-exam extensions against a real Postgres.  (P5-T2)
 *
 * ## The test that matters most
 *
 * `a mid-exam extension ADDS time and never rewrites deadlineAt` — C14. The symptom of the
 * original rewrite was not in the exam system at all: `verify-receipt` reported DIVERGENCE on a
 * legitimate action, in a different system, and a teacher receiving that message has no way to
 * guess a fair accommodation caused it. So the assertion is on the COLUMN, not on the arithmetic.
 */
import { randomUUID } from 'node:crypto';
import type { Actor } from '@orrery/auth/types';
import { FrozenClock, type Millis } from '@orrery/clock';
import { afterAll, describe, expect, it } from 'vitest';
import {
  autoSubmitAt,
  effectiveDeadline,
  extendAttemptDeadline,
  grantStudentOverride,
  listStudentOverrides,
  revokeStudentOverride,
} from './assignment-overrides.js';
import { createAssignment, publishAssignment, resolveForStudent } from './assignments.js';
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

async function user(name = 'P'): Promise<string> {
  const id = randomUUID();
  await prisma().user.create({
    data: { id, email: `${id}@x.example`, emailNormalized: `${id}@x.example`, name },
  });
  return id;
}

async function fixture(): Promise<{
  classroomId: string;
  actor: Actor;
  studentId: string;
  assignmentId: string;
}> {
  const ownerId = await user('Teacher');
  const created = await createClassroom(prisma(), {
    name: `Overrides ${randomUUID().slice(0, 6)}`,
    actor: actorOf(ownerId),
  });
  if (!created.ok) throw new Error(created.reason);

  const resourceId = randomUUID();
  await prisma().resource.create({
    data: {
      id: resourceId,
      ownerId,
      status: 'PUBLISHED',
      visibility: 'UNLISTED',
      title: 'Work',
      slug: randomUUID(),
    },
  });
  const versionId = randomUUID();
  await prisma().resourceVersion.create({
    data: {
      id: versionId,
      resourceId,
      version: 1,
      blocks: [],
      blocksChecksum: 'override-fixture',
      meta: {},
      createdById: ownerId,
    },
  });
  const assignment = await createAssignment(
    prisma(),
    {
      classroomId: created.id,
      resourceVersionId: versionId,
      actor: actorOf(ownerId),
      mode: 'EXAM',
    },
    clock(),
  );
  if (!assignment.ok) throw new Error(assignment.reason);
  await publishAssignment(
    prisma(),
    { classroomId: created.id, assignmentId: assignment.assignmentId, actor: actorOf(ownerId) },
    clock(),
  );
  return {
    classroomId: created.id,
    actor: actorOf(ownerId),
    studentId: await user('Student'),
    assignmentId: assignment.assignmentId,
  };
}

describe.skipIf(!DATABASE_URL)('P5-T2 student overrides, against real Postgres', () => {
  it('an override needs a REASON, because this row is what explains the advantage later', async () => {
    const f = await fixture();
    const short = await grantStudentOverride(
      prisma(),
      {
        classroomId: f.classroomId,
        assignmentId: f.assignmentId,
        studentId: f.studentId,
        actor: f.actor,
        reason: 'fair',
        extraTimePercent: 50,
      },
      clock(),
    );
    expect(short.ok).toBe(false);
    // And nothing was written: a refusal that leaves a row behind is worse than no refusal,
    // because the row looks like the grant somebody asked for.
    expect(
      await prisma().assignmentStudentOverride.count({ where: { studentId: f.studentId } }),
    ).toBe(0);

    const granted = await grantStudentOverride(
      prisma(),
      {
        classroomId: f.classroomId,
        assignmentId: f.assignmentId,
        studentId: f.studentId,
        actor: f.actor,
        reason: 'access plan: 25% additional time',
        extraTimePercent: 25,
      },
      clock(),
    );
    expect(granted.ok).toBe(true);
  });

  it('granting twice REPLACES rather than duplicating, because the pair is unique', async () => {
    const f = await fixture();
    const first = await grantStudentOverride(
      prisma(),
      {
        classroomId: f.classroomId,
        assignmentId: f.assignmentId,
        studentId: f.studentId,
        actor: f.actor,
        reason: 'first attempt at this',
        maxAttempts: 2,
      },
      clock(),
    );
    const second = await grantStudentOverride(
      prisma(),
      {
        classroomId: f.classroomId,
        assignmentId: f.assignmentId,
        studentId: f.studentId,
        actor: f.actor,
        reason: 'corrected to three attempts',
        maxAttempts: 3,
      },
      clock(),
    );
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    const rows = await listStudentOverrides(prisma(), {
      classroomId: f.classroomId,
      assignmentId: f.assignmentId,
      actor: f.actor,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.maxAttempts).toBe(3);
  });

  it('a Decimal comes back as a STRING, because a Decimal typed as a number is NaN at runtime', async () => {
    // Prisma's Decimal serialises through `toJSON` as a string. A caller typing this field as
    // `number` gets no type error, `undefined` at the boundary and `NaN` in the first arithmetic
    // expression. A string the UI can format is the honest answer.
    const f = await fixture();
    await grantStudentOverride(
      prisma(),
      {
        classroomId: f.classroomId,
        assignmentId: f.assignmentId,
        studentId: f.studentId,
        actor: f.actor,
        reason: 'access plan: 25% additional time',
        extraTimePercent: 25,
      },
      clock(),
    );
    const rows = await listStudentOverrides(prisma(), {
      classroomId: f.classroomId,
      assignmentId: f.assignmentId,
      actor: f.actor,
    });
    expect(typeof rows[0]?.extraTimePercent).toBe('string');
    expect(rows[0]?.extraTimePercent).toBe('25');
  });

  it('an override is a SETTING, so revoking deletes it rather than flagging it', async () => {
    const f = await fixture();
    await grantStudentOverride(
      prisma(),
      {
        classroomId: f.classroomId,
        assignmentId: f.assignmentId,
        studentId: f.studentId,
        actor: f.actor,
        reason: 'temporary, this term only',
        maxAttempts: 2,
      },
      clock(),
    );
    const revoked = await revokeStudentOverride(prisma(), {
      classroomId: f.classroomId,
      assignmentId: f.assignmentId,
      studentId: f.studentId,
      actor: f.actor,
    });
    expect(revoked.ok).toBe(true);
    expect(
      await prisma().assignmentStudentOverride.count({ where: { studentId: f.studentId } }),
    ).toBe(0);
  });

  it('the fold gives ONE student their extra time and leaves the rest of the class alone', async () => {
    // The override is per student, and a test that only checks the student misses the more
    // likely bug: the merge leaking into the class policy.
    const f = await fixture();
    await grantStudentOverride(
      prisma(),
      {
        classroomId: f.classroomId,
        assignmentId: f.assignmentId,
        studentId: f.studentId,
        actor: f.actor,
        reason: 'access plan: 50% additional time',
        extraTimePercent: 50,
      },
      clock(),
    );
    const row = await prisma().assignment.findUniqueOrThrow({ where: { id: f.assignmentId } });
    const common = {
      mode: 'EXAM' as const,
      versionPolicy: { version: 1 as const, totalTimeLimitSec: 3600 } as never,
      assignmentOverride: row.policyOverride as never,
      availableFrom: row.availableFrom,
      availableUntil: row.availableUntil,
      maxAttempts: row.maxAttempts,
    };
    const theirs = resolveForStudent({
      ...common,
      studentOverride: await readOverride(f.assignmentId, f.studentId),
    });
    const somebodiesElse = resolveForStudent({ ...common, studentOverride: null });
    expect(theirs.totalTimeLimitSec).toBe(5400);
    expect(somebodiesElse.totalTimeLimitSec, 'the override leaked into the class policy').toBe(
      3600,
    );
  });

  it('a mid-exam extension ADDS time and NEVER rewrites deadlineAt', async () => {
    // C14. The assertion is on the COLUMN.
    const f = await fixture();
    const attempt = await runningAttempt(f, new Date('2026-09-28T10:00:00Z'));

    const result = await extendAttemptDeadline(
      prisma(),
      {
        classroomId: f.classroomId,
        attemptId: attempt.id,
        actor: f.actor,
        addedSec: 900,
        reason: 'school power cut, 15 minutes',
      },
      clock(),
    );
    expect(result.ok).toBe(true);
    // The caller is TOLD, so the student can be told too.
    expect(result.effectiveDeadlineAt?.toISOString()).toBe('2026-09-28T10:15:00.000Z');

    // THE C14 ASSERTION. The column is byte-identical to what it was before the extension.
    const after = await prisma().examAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
    expect(after.deadlineAt?.toISOString()).toBe('2026-09-28T10:00:00.000Z');
    expect(attempt.deadlineAt?.toISOString()).toBe('2026-09-28T10:00:00.000Z');
    // And the extension is a ROW, which is also the audit record.
    expect(
      await prisma().attemptDeadlineExtension.count({ where: { attemptId: attempt.id } }),
    ).toBe(1);
  });

  it('two extensions STACK, because a second accommodation does not replace the first', async () => {
    const f = await fixture();
    const attempt = await runningAttempt(f, new Date('2026-09-28T10:00:00Z'));
    await extendAttemptDeadline(
      prisma(),
      {
        classroomId: f.classroomId,
        attemptId: attempt.id,
        actor: f.actor,
        addedSec: 600,
        reason: 'access plan granted mid-exam',
      },
      clock(),
    );
    const result = await extendAttemptDeadline(
      prisma(),
      {
        classroomId: f.classroomId,
        attemptId: attempt.id,
        actor: f.actor,
        addedSec: 300,
        reason: 'connectivity collapse, 5 further minutes',
      },
      clock(),
    );
    expect(result.effectiveDeadlineAt?.toISOString()).toBe('2026-09-28T10:15:00.000Z');
  });

  it('an extension to a FINISHED attempt is refused, because there is no deadline to extend', async () => {
    const f = await fixture();
    const attempt = await prisma().examAttempt.create({
      data: {
        classroomId: f.classroomId,
        assignmentId: f.assignmentId,
        studentId: f.studentId,
        attemptNumber: 1,
        status: 'SUBMITTED',
        startedAt: new Date(T0),
        submittedAt: new Date(T0),
      },
    });
    const result = await extendAttemptDeadline(
      prisma(),
      {
        classroomId: f.classroomId,
        attemptId: attempt.id,
        actor: f.actor,
        addedSec: 600,
        reason: 'too late to matter now',
      },
      clock(),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/SUBMITTED/);
    expect(
      await prisma().attemptDeadlineExtension.count({ where: { attemptId: attempt.id } }),
    ).toBe(0);
  });

  it('a zero or negative extension is refused, because a row claims something happened', async () => {
    const f = await fixture();
    const attempt = await runningAttempt(f, new Date('2026-09-28T10:00:00Z'));
    for (const addedSec of [0, -60]) {
      const result = await extendAttemptDeadline(
        prisma(),
        {
          classroomId: f.classroomId,
          attemptId: attempt.id,
          actor: f.actor,
          addedSec,
          reason: 'a grant of nothing at all',
        },
        clock(),
      );
      expect(result.ok, `${addedSec} was accepted as an extension`).toBe(false);
    }
    expect(
      await prisma().attemptDeadlineExtension.count({ where: { attemptId: attempt.id } }),
    ).toBe(0);
  });

  it('an extension without a usable reason is refused', async () => {
    const f = await fixture();
    const attempt = await runningAttempt(f, new Date('2026-09-28T10:00:00Z'));
    const result = await extendAttemptDeadline(
      prisma(),
      {
        classroomId: f.classroomId,
        attemptId: attempt.id,
        actor: f.actor,
        addedSec: 600,
        reason: 'nice',
      },
      clock(),
    );
    expect(result.ok).toBe(false);
  });

  it('a student cannot extend their own deadline, and a stranger cannot either', async () => {
    const f = await fixture();
    const attempt = await runningAttempt(f, new Date('2026-09-28T10:00:00Z'));
    const byStudent = await extendAttemptDeadline(
      prisma(),
      {
        classroomId: f.classroomId,
        attemptId: attempt.id,
        actor: actorOf(f.studentId, ['student']),
        addedSec: 86_400,
        reason: 'I would like more time please',
      },
      clock(),
    );
    expect(byStudent.ok).toBe(false);

    const stranger = await user('Stranger');
    const byStranger = await extendAttemptDeadline(
      prisma(),
      {
        classroomId: f.classroomId,
        attemptId: attempt.id,
        actor: actorOf(stranger, ['teacher']),
        addedSec: 86_400,
        reason: 'not even in this classroom',
      },
      clock(),
    );
    expect(byStranger.ok).toBe(false);
  });
});

describe('the deadline arithmetic, which every caller shares', () => {
  const base = new Date('2026-09-28T10:00:00Z');

  it('effectiveDeadlineAt = deadlineAt + Σ addedSec + pausedAccumSec', () => {
    expect(
      effectiveDeadline({
        deadlineAt: base,
        addedSec: [600, 300],
        pausedAccumSec: 120,
        gracePeriodSec: 60,
      })?.toISOString(),
    ).toBe('2026-09-28T10:17:00.000Z');
  });

  it('an UNTIMED attempt has no effective deadline, however much time is added', () => {
    // `null` is not zero. An untimed exam with an extension is still untimed, and a function
    // that did `null + 600` would produce an instant in 1970.
    expect(
      effectiveDeadline({
        deadlineAt: null,
        addedSec: [600],
        pausedAccumSec: 0,
        gracePeriodSec: 60,
      }),
    ).toBeNull();
  });

  it('the GRACE PERIOD is a sweep decision, not part of the deadline a student is told', () => {
    // plans/09: the sweep runs at `deadlineAt + grace + 30s`. A student told "you have until
    // 11:00" should be able to submit at 11:00:59, and baking the grace into the displayed
    // deadline would hand them 60 seconds the exam never agreed to give.
    const inputs = { deadlineAt: base, addedSec: [], pausedAccumSec: 0, gracePeriodSec: 60 };
    expect(effectiveDeadline(inputs)?.toISOString()).toBe('2026-09-28T10:00:00.000Z');
    expect(autoSubmitAt(inputs)?.toISOString()).toBe('2026-09-28T10:01:30.000Z');
    expect(autoSubmitAt(inputs, 0)?.toISOString()).toBe('2026-09-28T10:01:00.000Z');
  });
});

async function runningAttempt(
  f: { classroomId: string; assignmentId: string; studentId: string },
  deadlineAt: Date,
): Promise<{ id: string; deadlineAt: Date | null }> {
  const row = await prisma().examAttempt.create({
    data: {
      classroomId: f.classroomId,
      assignmentId: f.assignmentId,
      studentId: f.studentId,
      attemptNumber: 1,
      status: 'IN_PROGRESS',
      startedAt: new Date(deadlineAt.getTime() - 3_600_000),
      deadlineAt,
    },
    select: { id: true, deadlineAt: true },
  });
  return row;
}

async function readOverride(assignmentId: string, studentId: string) {
  return prisma().assignmentStudentOverride.findUniqueOrThrow({
    where: { assignmentId_studentId: { assignmentId, studentId } },
    select: {
      availableFrom: true,
      availableUntil: true,
      maxAttempts: true,
      extraTimePercent: true,
      policyOverride: true,
    },
  });
}

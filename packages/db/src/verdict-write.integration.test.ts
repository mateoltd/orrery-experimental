/**
 * THE VERDICT WRITER AGAINST REAL POSTGRES.  (P11-T8)
 *
 * `verdict-decision.test.ts` covers the rules. This covers the three things only a database can prove: that the writer
 * actually writes, that **authorisation runs before the rules**, and that a caller cannot supply `frozen: true`.
 */

import { randomUUID } from 'node:crypto';
import type { Actor } from '@orrery/auth/types';
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from './prisma.js';
import { writeIntegrityVerdict } from './verdict-write.js';

/**
 * THE LAZY SINGLETON, BECAUSE `beforeAll` IS NOT HOW THIS PACKAGE GETS A CLIENT.
 *
 * The first version of this file built the client in `beforeAll` and every test then failed with `Cannot read properties
 * of undefined (reading 'createMany')` — because this package's integration files use a lazily-created module-level
 * client (`accommodations.integration.test.ts:17-20`), and a `beforeAll` that has not run is not a client.
 *
 * The lazily-created singleton is also the RIGHT shape rather than merely the house one: `writeIntegrityVerdict` takes
 * the client as its first argument, so a test may hand it anything, and the tests that matter here are about the
 * arguments rather than the connection.
 */
let client: PrismaClient | null = null;
const prisma = (): PrismaClient => {
  client ??= new PrismaClient();
  return client;
};

const db = (): PrismaClient => prisma();

afterAll(async () => {
  await client?.$disconnect();
  client = null;
});

const REASON = 'two answers match a pattern worth a second look';

/** A teacher in the classroom, an outsider, and the student — the three identities the rules must separate. */
const teacher: Actor = { id: '', roles: ['TEACHER'] };
const outsider: Actor = { id: '', roles: ['TEACHER'] };
const student: Actor = { id: '', roles: ['STUDENT'] };

/**
 * THE FIXTURE IS THE RESOURCE GRAPH, AND THAT IS NOT OBVIOUS.
 *
 * An `Assignment` needs a real `Resource` and a real `ResourceVersion` (`resourceId` and `resourceVersionId` are both
 * `Restrict` foreign keys), and this file's first version invented `title` and a random UUID for the version -- so it
 * failed on `Argument 'classroom' is missing`, which names the wrong thing entirely. **The shape below is copied from
 * `accommodations.integration.test.ts`, which needed the same graph.**
 *
 * It is recorded here because the cost is real: four required columns were wrong in three successive attempts
 * (`ownerId`, `emailNormalized`, `name`, and the whole assignment graph), and every one of them failed with a message
 * pointing somewhere other than the cause.
 */
const room = async (options: { frozen?: boolean } = {}) => {
  const teacherId = randomUUID();
  const studentId = randomUUID();
  const outsiderId = randomUUID();
  const classroomId = randomUUID();
  const assignmentId = randomUUID();
  const attemptId = randomUUID();

  // Users BEFORE the classroom: `ownerId` is a real foreign key, so this order is the schema's order.
  await db().user.createMany({
    data: [
      // `email` is `Citext` and `emailNormalized` is a second unique column -- two columns for one fact is the schema's
      // design, so a fixture supplies both.
      {
        id: teacherId,
        email: `${teacherId}@t.example`,
        emailNormalized: `${teacherId}@t.example`,
        name: 'T',
      },
      {
        id: studentId,
        email: `${studentId}@t.example`,
        emailNormalized: `${studentId}@t.example`,
        name: 'S',
      },
      {
        id: outsiderId,
        email: `${outsiderId}@t.example`,
        emailNormalized: `${outsiderId}@t.example`,
        name: 'O',
      },
    ],
  });
  await db().classroom.create({
    data: {
      id: classroomId,
      ownerId: teacherId,
      name: 'verdict room',
      slug: `v-${classroomId.slice(0, 8)}`,
    },
  });
  await db().enrollment.createMany({
    data: [
      { classroomId, userId: teacherId, role: 'TEACHER', status: 'ACTIVE' },
      { classroomId, userId: studentId, role: 'STUDENT', status: 'ACTIVE' },
      // THE OUTSIDER IS DELIBERATELY NOT ENROLLED. That is what makes the refusal an authorisation refusal rather than a
      // membership-miss refusal, and it is the case worth testing.
    ],
  });
  const resource = await db().resource.create({
    data: { id: randomUUID(), ownerId: teacherId, title: 'Verdict paper', slug: randomUUID() },
  });
  const version = await db().resourceVersion.create({
    data: {
      id: randomUUID(),
      resourceId: resource.id,
      version: 1,
      blocks: [],
      blocksChecksum: 'verdict',
      meta: {},
      createdById: teacherId,
    },
  });
  await db().assignment.create({
    data: {
      id: assignmentId,
      classroomId,
      resourceId: resource.id,
      resourceVersionId: version.id,
      status: 'PUBLISHED',
      createdById: teacherId,
    },
  });
  await db().examAttempt.create({
    data: {
      id: attemptId,
      classroomId,
      assignmentId,
      studentId,
      purpose: 'GRADED',
      status: 'GRADED',
      attemptNumber: 1,
      ...(options.frozen === true ? { frozenAt: new Date(0), frozenReason: 'held' } : {}),
    },
  });

  const ids = { classroomId, assignmentId, attemptId, teacherId, studentId, outsiderId };
  return {
    ids,
    asTeacher: { ...teacher, id: teacherId } as Actor,
    asOutsider: { ...outsider, id: outsiderId } as Actor,
    asStudent: { ...student, id: studentId } as Actor,
  };
};

const base = (attemptId: string) => ({
  attemptId,
  outcome: 'REVIEW' as const,
  reason: REASON,
  consideredAccessibilityContext: true,
  /** A CALLER CLAIMING THE ATTEMPT IS FROZEN. Every test below passes this, and it must never matter. */
  frozen: true,
  existingVerdict: false,
});

describe('writing a verdict', () => {
  it('records the outcome, the reason, the author and the accessibility consideration', async () => {
    const r = await room({ frozen: true });
    const result = await writeIntegrityVerdict(db(), r.asTeacher, base(r.ids.attemptId));
    expect(result.ok).toBe(true);
    const row = await db().integrityVerdict.findUniqueOrThrow({
      where: { attemptId: r.ids.attemptId },
      include: { decidedBy: { select: { id: true } } },
    });
    expect(row.outcome).toBe('REVIEW');
    expect(row.reason).toBe(REASON);
    expect(row.decidedBy.id).toBe(r.ids.teacherId);
    expect(row.consideredAccessibilityContext).toBe(true);
    expect(row.decidedAt).toBeInstanceOf(Date);
  });

  it('A CALLER-SUPPLIED `frozen: true` DOES NOT VOID AN UNFROZEN PAPER', async () => {
    /**
     * **The single most important line in `verdict-write.ts`.** `base()` passes `frozen: true` on every test, and this one
     * does too — so if the writer trusted the input rather than the column, this test would pass a void it should refuse,
     * and the freeze-before-a-void rule would be theatre.
     */
    const r = await room();
    const result = await writeIntegrityVerdict(db(), r.asTeacher, {
      ...base(r.ids.attemptId),
      outcome: 'VOIDED',
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.refusal).toBe('VOID_REQUIRES_FREEZE');
    expect(await db().integrityVerdict.count({ where: { attemptId: r.ids.attemptId } })).toBe(0);
  });

  it('a CALLER-SUPPLIED `existingVerdict: false` CANNOT OVERWRITE A REAL VERDICT', async () => {
    /** The same trap in the other direction: the input claims there is no verdict, and the column says otherwise. */
    const r = await room({ frozen: true });
    expect((await writeIntegrityVerdict(db(), r.asTeacher, base(r.ids.attemptId))).ok).toBe(true);
    const second = await writeIntegrityVerdict(db(), r.asTeacher, {
      ...base(r.ids.attemptId),
      outcome: 'NO_CONCERN',
    });
    expect(second.ok).toBe(false);
    expect(second.ok === false && second.refusal).toBe('ALREADY_DECIDED');
    // And the FIRST conclusion survives intact, which is the point of refusing rather than overwriting.
    const row = await db().integrityVerdict.findUniqueOrThrow({
      where: { attemptId: r.ids.attemptId },
    });
    expect(row.outcome).toBe('REVIEW');
  });
});

describe('authorisation, and it runs BEFORE the rules', () => {
  it('refuses a teacher from another classroom', async () => {
    const r = await room();
    const result = await writeIntegrityVerdict(db(), r.asOutsider, base(r.ids.attemptId));
    expect(result.ok === false && result.refusal).toBe('NOT_PERMITTED');
  });

  it('refuses the STUDENT, on their own paper', async () => {
    /** The rule this row exists for: a verdict is a conclusion about a student, and the student may not make it. */
    const r = await room();
    const result = await writeIntegrityVerdict(db(), r.asStudent, base(r.ids.attemptId));
    expect(result.ok === false && result.refusal).toBe('NOT_PERMITTED');
  });

  it('GIVES THE SAME ANSWER for a missing attempt and a forbidden one', async () => {
    /**
     * **A different message would be an existence oracle.** The difference between "no such attempt" and "not your
     * classroom" is the whole payload an attacker wants, and the reason is the same as `refuseCaller()`'s.
     */
    const r = await room();
    const missing = await writeIntegrityVerdict(db(), r.asTeacher, base(randomUUID()));
    const forbidden = await writeIntegrityVerdict(db(), r.asOutsider, base(r.ids.attemptId));
    expect(missing.ok).toBe(false);
    expect(forbidden.ok).toBe(false);
    expect(missing.ok === false && missing.message).toBe(
      forbidden.ok === false ? forbidden.message : '',
    );
  });

  it('does NOT run the rules for an unauthorised caller, so a bad reason leaks nothing', async () => {
    /**
     * Ordering is observable: an unauthorised caller is told "no such attempt" even with a reason too short, so they
     * cannot use the refusal to learn where the reason floor is.
     */
    const r = await room();
    const result = await writeIntegrityVerdict(db(), r.asOutsider, {
      ...base(r.ids.attemptId),
      reason: 'no',
    });
    expect(result.ok === false && result.refusal).toBe('NOT_PERMITTED');
  });
});

describe('the rules still apply to an authorised caller', () => {
  it('refuses a reason-less verdict before touching the database', async () => {
    const r = await room({ frozen: true });
    const result = await writeIntegrityVerdict(db(), r.asTeacher, {
      ...base(r.ids.attemptId),
      reason: '  ',
    });
    expect(result.ok === false && result.refusal).toBe('REASON_REQUIRED');
    expect(await db().integrityVerdict.count({ where: { attemptId: r.ids.attemptId } })).toBe(0);
  });

  it('refuses a NON-GRADED attempt, because a practice sitting has no verdict to conclude', async () => {
    const r = await room({ frozen: true });
    await db().examAttempt.update({
      where: { id: r.ids.attemptId },
      data: { purpose: 'PRACTICE' },
    });
    const result = await writeIntegrityVerdict(db(), r.asTeacher, base(r.ids.attemptId));
    expect(result.ok === false && result.refusal).toBe('ATTEMPT_NOT_FOUND');
  });
});

describe('the verdict is findable afterwards, which is what makes it a record', () => {
  it('reads back with the frozen paper byte-identical in every other column', async () => {
    const r = await room({ frozen: true });
    const before = await db().examAttempt.findUniqueOrThrow({ where: { id: r.ids.attemptId } });
    await writeIntegrityVerdict(db(), r.asTeacher, base(r.ids.attemptId));
    const after = await db().examAttempt.findUniqueOrThrow({ where: { id: r.ids.attemptId } });
    expect(after.frozenAt).toEqual(before.frozenAt);
    expect(after.finalScore).toEqual(before.finalScore);
    expect(after.status).toEqual(before.status);
  });
});

import { randomUUID } from 'node:crypto';
import type { Actor } from '@orrery/auth/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from './prisma.js';
import { readIntegrityReportFacts } from './report-integrity.js';
import { readItemAnalysis } from './report-item-analysis.js';
import { readGradebook, readSubmissions } from './report-queries.js';

const db = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
const ids = {
  classroom: randomUUID(),
  teacher: randomUUID(),
  outsider: randomUUID(),
  resource: randomUUID(),
  version: randomUUID(),
  bank: randomUUID(),
  a4: randomUUID(),
  a5: randomUUID(),
  qA: randomUUID(),
  qB: randomUUID(),
  students: Array.from({ length: 6 }, () => randomUUID()),
};
const now = Date.parse('2026-10-05T20:00:00Z');
const teacher: Actor = { id: ids.teacher, roles: ['teacher'], mfaVerified: true, suspended: false };
const sql: { query: string; params: string }[] = [];
db.$on('query', (event) => sql.push(event));
const attempts: string[] = [];
const a5Attempts: string[] = [];

async function all<T>(source: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const row of source) result.push(row);
  return result;
}

async function release(assignmentId: string, members: readonly string[]) {
  const batch = await db.releaseBatch.create({
    data: {
      classroomId: ids.classroom,
      assignmentId,
      status: 'DRAFT',
      members: { create: members.map((attemptId) => ({ attemptId })) },
    },
  });
  for (const status of ['READY', 'RELEASING', 'RELEASED'] as const)
    await db.releaseBatch.update({
      where: { id: batch.id },
      data: { status, ...(status === 'RELEASED' ? { releasedAt: new Date(now) } : {}) },
    });
}

describe.skipIf(!process.env.DATABASE_URL)('P11 report boundaries against Postgres', () => {
  beforeAll(async () => {
    for (const id of [ids.teacher, ids.outsider, ...ids.students])
      await db.user.create({
        data: {
          id,
          name: '=HYPERLINK("evil")',
          email: `${id}@report.example`,
          emailNormalized: `${id}@report.example`,
        },
      });
    await db.classroom.create({
      data: { id: ids.classroom, ownerId: ids.teacher, name: 'Reports', slug: randomUUID() },
    });
    await db.enrollment.create({
      data: { classroomId: ids.classroom, userId: ids.teacher, role: 'OWNER' },
    });
    for (const userId of ids.students)
      await db.enrollment.create({ data: { classroomId: ids.classroom, userId, role: 'STUDENT' } });
    await db.resource.create({
      data: {
        id: ids.resource,
        ownerId: ids.teacher,
        title: 'Report assignment',
        slug: randomUUID(),
        status: 'PUBLISHED',
        visibility: 'UNLISTED',
      },
    });
    await db.resourceVersion.create({
      data: {
        id: ids.version,
        resourceId: ids.resource,
        version: 1,
        blocks: [],
        blocksChecksum: 'report-fixture',
        meta: {},
        createdById: ids.teacher,
      },
    });
    await db.questionBank.create({
      data: { id: ids.bank, ownerId: ids.teacher, name: 'Report bank' },
    });
    for (const id of [ids.qA, ids.qB])
      await db.question.create({
        data: {
          id,
          bankId: ids.bank,
          resourceVersionId: ids.version,
          isSnapshot: true,
          type: 'singleChoice',
          points: 4,
          spec: {},
        },
      });
    for (const id of [ids.a4, ids.a5])
      await db.assignment.create({
        data: {
          id,
          classroomId: ids.classroom,
          resourceId: ids.resource,
          resourceVersionId: ids.version,
          createdById: ids.teacher,
          status: 'PUBLISHED',
          availableUntil: new Date(now - 1000),
        },
      });
    for (const [index, studentId] of ids.students.slice(0, 5).entries()) {
      for (const assignmentId of [ids.a4, ids.a5]) {
        const attemptId = randomUUID();
        (assignmentId === ids.a4 ? attempts : a5Attempts).push(attemptId);
        await db.examAttempt.create({
          data: {
            id: attemptId,
            assignmentId,
            classroomId: ids.classroom,
            studentId,
            attemptNumber: 1,
            status: 'GRADED',
            submittedAt: new Date(now - 2000),
            variantMap: { '0': [ids.qB] },
            preflight: { fullscreen: 'denied', nested: { supported: false } },
            responses: {
              create: {
                questionId: ids.qB,
                position: 0,
                answer: '=WEBSERVICE("evil")',
                autoScore: index === 0 ? 4 : 2,
                autoRawScore: index === 0 ? 4 : 2,
                manualScore: index === 0 ? 3 : null,
              },
            },
          },
        });
      }
    }
    await release(ids.a4, attempts.slice(0, 4));
    await db.releaseBatch.create({
      data: {
        classroomId: ids.classroom,
        assignmentId: ids.a4,
        status: 'DRAFT',
        members: { create: { attemptId: attempts[4] as string } },
      },
    });
    await release(ids.a5, a5Attempts);
    // Practice consumes neither a grade nor an analytics observation, even with a larger number.
    await db.examAttempt.create({
      data: {
        assignmentId: ids.a4,
        classroomId: ids.classroom,
        studentId: ids.students[0] as string,
        purpose: 'PRACTICE',
        attemptNumber: 9,
        variantMap: { '0': [ids.qA] },
      },
    });
  });

  afterAll(async () => {
    // Attempts first allow membership cascades without weakening the release-state triggers.
    await db.examAttempt.deleteMany({ where: { classroomId: ids.classroom } });
    await db.releaseBatch.deleteMany({ where: { classroomId: ids.classroom } });
    await db.assignment.deleteMany({ where: { id: { in: [ids.a4, ids.a5] } } });
    await db.questionBank.deleteMany({ where: { id: ids.bank } });
    await db.resourceVersion.deleteMany({ where: { id: ids.version } });
    await db.resource.deleteMany({ where: { id: ids.resource } });
    await db.classroom.deleteMany({ where: { id: ids.classroom } });
    await db.user.deleteMany({
      where: { id: { in: [ids.teacher, ids.outsider, ...ids.students] } },
    });
    await db.$disconnect();
  });

  it('a released sibling batch never releases the other attempt into the ledger or submissions', async () => {
    sql.length = 0;
    const rows = await all(
      readGradebook(
        db,
        teacher,
        { classroomId: ids.classroom, assignmentId: ids.a4 },
        { now: () => now, monotonic: () => 0 },
      ),
    );
    const released = rows.find((r) => r.cells[0]?.attemptId === attempts[0]);
    const sealed = rows.find((r) => r.cells[0]?.attemptId === attempts[4]);
    expect(released?.cells[0]?.score?.finalScore).toBe(75); // manual 3 / possible 4
    expect(released?.cells[0]?.variant.questionIds).toEqual([ids.qB]);
    expect(sealed?.cells[0]).toMatchObject({ state: 'SEALED', score: null });
    expect(sealed?.total.percentage).toBeNull();
    expect(rows.filter((r) => r.cells[0]?.flag === 'missing')).toHaveLength(1);
    const submissions = await all(
      readSubmissions(db, teacher, { classroomId: ids.classroom, assignmentId: ids.a4 }),
    );
    expect(submissions).toHaveLength(4);
    expect(submissions.map((r) => r.attemptId)).not.toContain(attempts[4]);
    expect(submissions.every((r) => r.questionId === ids.qB)).toBe(true);
    // Prisma loads responses separately, using only the membership-gated attempt IDs.
    expect(
      sql.some((s) => s.query.includes('ReleaseBatchMember') && s.params.includes('RELEASED')),
    ).toBe(true);
    const scoreReads = sql.filter(
      (s) => s.query.startsWith('SELECT') && s.query.includes('"autoScore"'),
    );
    expect(scoreReads.length).toBeGreaterThan(0);
    expect(scoreReads.every((s) => !s.params.includes(attempts[4] as string))).toBe(true);
  });
  it('refuses students, including a global teacher enrolled as a student, and unrelated teachers', async () => {
    for (const id of [ids.students[0] as string, ids.outsider]) {
      const actor: Actor = { ...teacher, id };
      await expect(
        readGradebook(
          db,
          actor,
          { classroomId: ids.classroom },
          { now: () => now, monotonic: () => 0 },
        ).next(),
      ).rejects.toThrow('access refused');
      await expect(
        readSubmissions(db, actor, { classroomId: ids.classroom }).next(),
      ).rejects.toThrow('access refused');
      await expect(
        readIntegrityReportFacts(
          db,
          actor,
          { classroomId: ids.classroom, attemptId: attempts[0] as string },
          { now: () => now, monotonic: () => 0 },
        ),
      ).rejects.toThrow('access refused');
    }
  });
  it('suppresses N=4 in SQL and shows hand-computed N=5 facility while retaining undrawn items', async () => {
    const small = await all(
      readItemAnalysis(
        db,
        teacher,
        { classroomId: ids.classroom, assignmentId: ids.a4 },
        { now: () => now, monotonic: () => 0 },
      ),
    );
    expect(small).toHaveLength(2);
    expect(small.find((r) => r.questionId === ids.qB)).toMatchObject({
      n: 4,
      pFull: null,
      pCredit: null,
    });
    expect(small.find((r) => r.questionId === ids.qA)).toMatchObject({
      n: 0,
      pFull: null,
      pCredit: null,
    });
    const usable = await all(
      readItemAnalysis(
        db,
        teacher,
        { classroomId: ids.classroom, assignmentId: ids.a5 },
        { now: () => now, monotonic: () => 0 },
      ),
    );
    // 3/4, 2/4, 2/4, 2/4, 2/4 => mean 11/20; none full-credit after manual override.
    expect(usable.find((r) => r.questionId === ids.qB)).toMatchObject({
      n: 5,
      pFull: 0,
      pCredit: 0.55,
      computedAt: now,
    });
  });
  it('a newer sealed attempt prevents a released older result being presented as the current grade', async () => {
    const studentId = ids.students[0] as string;
    const id = randomUUID();
    await db.examAttempt.create({
      data: {
        id,
        assignmentId: ids.a4,
        classroomId: ids.classroom,
        studentId,
        attemptNumber: 2,
        status: 'SUBMITTED',
        submittedAt: new Date(now),
        variantMap: { '0': [ids.qA] },
      },
    });
    try {
      const rows = await all(
        readGradebook(
          db,
          teacher,
          { classroomId: ids.classroom, assignmentId: ids.a4, studentId },
          { now: () => now, monotonic: () => 0 },
        ),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.cells[0]).toMatchObject({
        attemptId: id,
        state: 'SEALED',
        score: null,
        variant: { questionIds: [ids.qA] },
      });
      expect(rows[0]?.total.percentage).toBeNull();
    } finally {
      await db.examAttempt.delete({ where: { id } });
    }
  });
  it('an assignment filter changes displayed cells, never the weighted course denominator', async () => {
    const attemptId = a5Attempts[0] as string;
    await db.questionResponse.update({
      where: { attemptId_questionId: { attemptId, questionId: ids.qB } },
      data: { manualScore: 1 },
    });
    try {
      const rows = await all(
        readGradebook(
          db,
          teacher,
          {
            classroomId: ids.classroom,
            assignmentId: ids.a4,
            studentId: ids.students[0] as string,
          },
          { now: () => now, monotonic: () => 0 },
        ),
      );
      expect(rows[0]?.cells).toHaveLength(1);
      expect(rows[0]?.cells[0]?.score?.finalScore).toBe(75);
      // A4: 3/4 = 75%; A5: 1/4 = 25%; equal weights => 50%, even in the A4 view.
      expect(rows[0]?.total.percentage).toBe(50);
      expect(rows[0]?.total.includedWeight).toBe(200);
    } finally {
      await db.questionResponse.update({
        where: { attemptId_questionId: { attemptId, questionId: ids.qB } },
        data: { manualScore: 3 },
      });
    }
  });
  it('a personal availability override prevents a premature missing flag', async () => {
    const studentId = ids.students[5] as string;
    const override = await db.assignmentStudentOverride.create({
      data: {
        assignmentId: ids.a4,
        studentId,
        availableUntil: new Date(now + 1000),
        grantedById: ids.teacher,
        reason: 'Personal availability window',
      },
    });
    try {
      const rows = await all(
        readGradebook(
          db,
          teacher,
          { classroomId: ids.classroom, assignmentId: ids.a4, studentId },
          { now: () => now, monotonic: () => 0 },
        ),
      );
      expect(rows[0]?.cells[0]?.flag).toBe('pending');
    } finally {
      await db.assignmentStudentOverride.delete({ where: { id: override.id } });
    }
  });
  it('a resolved question with no response still counts in the released paper maximum', async () => {
    const assignmentId = randomUUID();
    await db.assignment.create({
      data: {
        id: assignmentId,
        classroomId: ids.classroom,
        resourceId: ids.resource,
        resourceVersionId: ids.version,
        createdById: ids.teacher,
        status: 'PUBLISHED',
      },
    });
    try {
      const attemptId = randomUUID();
      await db.examAttempt.create({
        data: {
          id: attemptId,
          classroomId: ids.classroom,
          assignmentId,
          studentId: ids.students[0] as string,
          attemptNumber: 1,
          status: 'GRADED',
          submittedAt: new Date(now),
          variantMap: { '0': [ids.qA, ids.qB] },
          responses: {
            create: {
              questionId: ids.qB,
              position: 1,
              answer: 'Written answer',
              autoScore: 4,
              manualScore: 3,
            },
          },
        },
      });
      await release(assignmentId, [attemptId]);
      const rows = await all(
        readGradebook(
          db,
          teacher,
          { classroomId: ids.classroom, assignmentId, studentId: ids.students[0] as string },
          { now: () => now, monotonic: () => 0 },
        ),
      );
      // Q-A: unanswered, 0/4; Q-B: manual 3/4 => 3/8 = 37.5%, never 3/4 = 75%.
      expect(rows[0]?.cells[0]?.score).toMatchObject({
        rawTotal: 3,
        maxTotal: 8,
        finalScore: 37.5,
      });
      expect(rows[0]?.cells[0]?.variant.questionIds).toEqual([ids.qA, ids.qB]);
      expect(rows[0]?.total.percentage).toBe(62.5); // equal weights: (75 + 75 + 37.5) / 3
    } finally {
      await db.examAttempt.deleteMany({ where: { assignmentId } });
      await db.releaseBatch.deleteMany({ where: { assignmentId } });
      await db.assignment.delete({ where: { id: assignmentId } });
    }
  });
  it('reads existing preflight, final-flush evidence and the stored teacher verdict without payload intent text', async () => {
    const attemptId = attempts[0] as string;
    await db.integrityEvent.create({
      data: {
        attemptId,
        type: 'NETWORK_LOST',
        severity: 'WARN',
        serverTs: new Date(now - 500),
        payload: { phase: 'final_flush', reason: 'tried to cheat' },
      },
    });
    await db.integrityVerdict.create({
      data: {
        attemptId,
        outcome: 'REVIEW',
        reason: 'Review the saved work with accessibility context.',
        decidedById: ids.teacher,
        decidedAt: new Date(now),
        consideredAccessibilityContext: true,
      },
    });
    const report = await readIntegrityReportFacts(
      db,
      teacher,
      { classroomId: ids.classroom, attemptId },
      { now: () => now, monotonic: () => 0 },
    );
    expect(report.facts.entries[0]?.phrase).toBe('network lost');
    expect(JSON.stringify(report)).not.toContain('tried to cheat');
    expect(report.facts.forceExits).toHaveLength(1);
    expect(report.facts.preflight).toMatchObject({ fullscreen: 'denied' });
    expect(report.verdict).toMatchObject({
      conclusion: 'REVIEW',
      authorId: ids.teacher,
      consideredAccessibilityContext: true,
    });
    expect(report.similarityAvailable).toBe(false);
  });
});

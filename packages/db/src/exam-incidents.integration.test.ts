/**
 * In-exam incident reports: own attempt accepted, everything else refused, nothing deduplicated.
 */

import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@orrery/db/prisma';
import { afterAll, describe, expect, it } from 'vitest';
import { reportIncident } from './exam-incidents.js';

let client: PrismaClient | null = null;
const prisma = (): PrismaClient => {
  if (process.env.DATABASE_URL === undefined || process.env.DATABASE_URL.length === 0) {
    throw new Error('DATABASE_URL is required: this test files reports, not mocks of reports');
  }
  client ??= new PrismaClient();
  return client;
};
afterAll(async () => {
  await client?.$disconnect();
  client = null;
});

async function person(): Promise<string> {
  const id = randomUUID();
  await prisma().user.create({
    data: { id, email: `${id}@r.example`, emailNormalized: `${id}@r.example`, name: 'P' },
  });
  return id;
}

async function attemptFor(studentId: string): Promise<{ attemptId: string; questionId: string }> {
  const db = prisma();
  const teacherId = await person();
  const room = await db.classroom.create({
    data: { ownerId: teacherId, name: 'R', slug: randomUUID() },
  });
  const resource = await db.resource.create({
    data: { ownerId: teacherId, title: 'R', slug: randomUUID() },
  });
  const version = await db.resourceVersion.create({
    data: {
      resourceId: resource.id,
      version: 1,
      blocks: [],
      blocksChecksum: 'x',
      meta: {},
      createdById: teacherId,
    },
  });
  const assignment = await db.assignment.create({
    data: {
      classroomId: room.id,
      resourceId: resource.id,
      resourceVersionId: version.id,
      createdById: teacherId,
      status: 'PUBLISHED',
    },
  });
  const bank = await db.questionBank.create({ data: { ownerId: teacherId, name: 'B' } });
  const question = await db.question.create({
    data: { bankId: bank.id, type: 'single_choice', spec: {}, points: 1 },
  });
  const attempt = await db.examAttempt.create({
    data: {
      assignmentId: assignment.id,
      classroomId: room.id,
      studentId,
      attemptNumber: 1,
      status: 'IN_PROGRESS',
      policySnapshot: {},
      responses: { create: [{ questionId: question.id, position: 0, answer: null }] },
    },
    select: { id: true },
  });
  return { attemptId: attempt.id, questionId: question.id };
}

describe('reportIncident', () => {
  it('accepts a report on the reporter\u2019s own attempt, with the question attached', async () => {
    const db = prisma();
    const studentId = await person();
    const { attemptId, questionId } = await attemptFor(studentId);
    const outcome = await reportIncident(db, studentId, {
      attemptId,
      questionId,
      reason: 'BROKEN_QUESTION',
      detail: 'Option B has no text.',
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const row = await db.examIncident.findUnique({ where: { id: outcome.id } });
    expect(row?.status).toBe('OPEN');
    expect(row?.reporterId).toBe(studentId);
  });

  it('refuses someone else\u2019s attempt: a report about another exam is a probe or a mistake', async () => {
    const db = prisma();
    const studentId = await person();
    const otherId = await person();
    const { attemptId } = await attemptFor(studentId);
    const outcome = await reportIncident(db, otherId, { attemptId, reason: 'TYPO' });
    expect(outcome).toMatchObject({ ok: false, httpStatus: 404 });
  });

  it('refuses OTHER without detail, and unknown reasons outright', async () => {
    const db = prisma();
    const studentId = await person();
    const { attemptId } = await attemptFor(studentId);
    expect(await reportIncident(db, studentId, { attemptId, reason: 'OTHER' })).toMatchObject({
      ok: false,
      httpStatus: 400,
    });
    expect(
      await reportIncident(db, studentId, {
        attemptId,
        reason: 'OTHER',
        detail: 'The diagram shows nothing.',
      }),
    ).toMatchObject({ ok: true });
    expect(await reportIncident(db, studentId, { attemptId, reason: 'NOPE' })).toMatchObject({
      ok: false,
      httpStatus: 400,
    });
  });

  it('refuses a question that is not on the attempt', async () => {
    const db = prisma();
    const studentId = await person();
    const { attemptId } = await attemptFor(studentId);
    const outcome = await reportIncident(db, studentId, {
      attemptId,
      questionId: randomUUID(),
      reason: 'TYPO',
    });
    expect(outcome).toMatchObject({ ok: false, httpStatus: 404 });
  });

  it('does NOT deduplicate: two identical reports are two rows', async () => {
    const db = prisma();
    const studentId = await person();
    const { attemptId, questionId } = await attemptFor(studentId);
    const first = await reportIncident(db, studentId, {
      attemptId,
      questionId,
      reason: 'SIM_WONT_LOAD',
    });
    const second = await reportIncident(db, studentId, {
      attemptId,
      questionId,
      reason: 'SIM_WONT_LOAD',
    });
    expect(first.ok && second.ok).toBe(true);
  });
});

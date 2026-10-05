/**
 * `P10-T10`'s boundary against a REAL unreleased attempt with a REAL score in the database.  (P10-T10)
 *
 * ## WHY THIS IS A SEPARATE FILE AND NOT MORE CASES IN `packages/interop`
 *
 * The negative case that matters is "an unreleased attempt that HAS a mark". `packages/interop` has no dependencies --
 * not even Prisma -- so it cannot hold a real one, and a fixture with `rawTotal: 18` written by hand is a fixture whose
 * score somebody chose. **The hazard is specifically that the database HAS the mark and the payload must not**, so the
 * mark here is read out of `ExamAttempt` and `QuestionResponse` and is the number the release would publish.
 *
 * ## AND THE DECISION IS THE DATABASE'S, NOT A CALLER'S BOOLEAN
 *
 * The tempting shape is a handler that reads `attempt.releasedAt !== null` and passes `released: false` to the
 * chokepoint. **That is the same class of mistake as the roster-page leak** (`audit/score-projections.json`,
 * `$why_it_exists`): a boolean derived somewhere other than the one visibility rule, which a second writer can make
 * disagree with the database. So this file drives the chokepoint from `attemptReleaseState` -- `B16`'s predicate, read
 * from the `ReleaseBatchMember`/`ReleaseBatch` join -- and then asserts that the chokepoint's decision CHANGED when the
 * database changed and NOT ONE LINE ELSE DID.
 *
 * ## A NOTE ON THE PROJECTION AUDIT
 *
 * This file selects `finalScore` and reads `autoScore`. `scripts/audit-projections.mjs` skips test files by design --
 * "a test is not reachable by a browser, so a score it selects cannot leak to a student, and the production function it
 * exercises IS scanned, which is where the claim belongs" -- so no entry in `audit/score-projections.json` is filed for
 * it, and none should be: an entry for a test would put a test author in the position of making a release-gating
 * decision about production code.
 */

import { randomUUID } from 'node:crypto';

import { FrozenClock } from '@orrery/clock';
import { buildStudentGrade, type Grade } from '@orrery/interop';
import {
  findInteropScoreBearingKeys,
  type OutboundStandard,
  prepareOutbound,
} from '@orrery/interop/outbound';
import { afterAll, describe, expect, it } from 'vitest';

import { PrismaClient } from './prisma.js';
import {
  attemptReleaseState,
  beginRelease,
  createReleaseBatch,
  markBatchReady,
} from './release-batch.js';

const T0 = 1_800_000_000_000;
const clock = new FrozenClock(T0);

/** What the release will publish: 7 of 10 marks, so `rawTotal: 7`, `maxTotal: 10`, `percentage: 70`. */
const TRUE_TOTAL = 7;
const TRUE_MAX = 10;

let client: PrismaClient | null = null;
const prisma = (): PrismaClient => {
  client ??= new PrismaClient();
  return client;
};

const mine = {
  users: [] as string[],
  resources: [] as string[],
  versions: [] as string[],
  classrooms: [] as string[],
  assignments: [] as string[],
  banks: [] as string[],
  questions: [] as string[],
  attempts: [] as string[],
  batches: [] as string[],
};

afterAll(async () => {
  if (client === null) return;
  const db = client;
  await db.auditEvent.deleteMany({
    where: { targetType: 'ReleaseBatch', targetId: { in: mine.batches } },
  });
  await db.questionResponse.deleteMany({ where: { attemptId: { in: mine.attempts } } });
  await db.examAttempt.deleteMany({ where: { id: { in: mine.attempts } } });
  await db.releaseBatch.deleteMany({ where: { id: { in: mine.batches } } });
  await db.assignment.deleteMany({ where: { id: { in: mine.assignments } } });
  await db.question.deleteMany({ where: { id: { in: mine.questions } } });
  await db.questionBank.deleteMany({ where: { id: { in: mine.banks } } });
  await db.classroom.deleteMany({ where: { id: { in: mine.classrooms } } });
  await db.resourceVersion.deleteMany({ where: { id: { in: mine.versions } } });
  await db.resource.deleteMany({ where: { id: { in: mine.resources } } });
  await db.user.deleteMany({ where: { id: { in: mine.users } } });
  await db.$disconnect();
  client = null;
});

const user = async (): Promise<string> => {
  const id = randomUUID();
  await prisma().user.create({
    data: {
      id,
      email: `${id}@p10t10.example`,
      emailNormalized: `${id}@p10t10.example`,
      name: 'P10T10',
    },
  });
  mine.users.push(id);
  return id;
};

interface Room {
  readonly teacherId: string;
  readonly studentId: string;
  readonly classroomId: string;
  readonly assignmentId: string;
  readonly attemptId: string;
  readonly questionId: string;
}

/**
 * A GRADED attempt with a REAL mark sitting in the database, and no batch holding it.
 *
 * **`finalScore: 7` IS WRITTEN DIRECTLY** rather than computed by a release, because the hazard does not depend on how
 * the number got there: it is that a number exists on the row while the batch says the student may not see it. A
 * half-graded paper with a provisional total on it is the ordinary state of a class between marking and release.
 */
const gradedAttemptWithAScore = async (): Promise<Room> => {
  const db = prisma();
  const teacherId = await user();
  const studentId = await user();
  const resource = await db.resource.create({
    data: {
      id: randomUUID(),
      ownerId: teacherId,
      status: 'PUBLISHED',
      visibility: 'UNLISTED',
      title: 'P10-T10 boundary',
      slug: randomUUID(),
    },
  });
  mine.resources.push(resource.id);
  const version = await db.resourceVersion.create({
    data: {
      id: randomUUID(),
      resourceId: resource.id,
      version: 1,
      blocks: [],
      blocksChecksum: 'p10t10',
      meta: {},
      createdById: teacherId,
    },
  });
  mine.versions.push(version.id);
  const classroom = await db.classroom.create({
    data: { id: randomUUID(), ownerId: teacherId, name: 'P10T10', slug: randomUUID() },
  });
  mine.classrooms.push(classroom.id);
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
  mine.assignments.push(assignment.id);
  const bank = await db.questionBank.create({
    data: { id: randomUUID(), ownerId: teacherId, name: 'P10T10' },
  });
  mine.banks.push(bank.id);
  const question = await db.question.create({
    data: { id: randomUUID(), bankId: bank.id, type: 'shortText', spec: {}, points: TRUE_MAX },
  });
  mine.questions.push(question.id);

  const attemptId = randomUUID();
  mine.attempts.push(attemptId);
  await db.examAttempt.create({
    data: {
      id: attemptId,
      assignmentId: assignment.id,
      classroomId: classroom.id,
      studentId,
      attemptNumber: 1,
      status: 'GRADED',
      purpose: 'GRADED',
      submittedAt: new Date(T0 - 60_000),
      finalScore: TRUE_TOTAL,
      maxScore: TRUE_MAX,
      percentage: 70,
    },
  });
  await db.questionResponse.create({
    data: {
      id: randomUUID(),
      attemptId,
      questionId: question.id,
      position: 1,
      answer: { text: 'seven of them, in a paragraph, in my own words' },
      autoScore: TRUE_TOTAL,
      needsHuman: false,
      isExcused: false,
    },
  });

  return {
    teacherId,
    studentId,
    classroomId: classroom.id,
    assignmentId: assignment.id,
    attemptId,
    questionId: question.id,
  };
};

/**
 * BUILD THE BOUNDARY GRADE FROM THE DATABASE, with the release decision taken from `B16`'s predicate.
 *
 * **THE SCORE IS IN HAND WHENEVER THE ATTEMPT IS GRADED, AND THAT IS THE WHOLE POINT**: `released: false` below does not
 * stop the score being read, loaded and passed to `buildStudentGrade`. It is right there in the object. The chokepoint
 * has to drop it, and the assertions are on the bytes.
 */
const gradeFromDatabase = async (room: Room): Promise<Grade> => {
  const db = prisma();
  const row = await db.examAttempt.findUniqueOrThrow({
    where: { id: room.attemptId },
    select: {
      id: true,
      status: true,
      submittedAt: true,
      responses: {
        orderBy: { position: 'asc' },
        select: {
          questionId: true,
          answer: true,
          autoScore: true,
          manualScore: true,
          isExcused: true,
        },
      },
    },
  });
  const state = await attemptReleaseState(db, room.attemptId);
  const total = await db.questionResponse.aggregate({
    where: { attemptId: room.attemptId, isExcused: false },
    _sum: { autoScore: true },
  });

  return buildStudentGrade({
    released: state.state === 'RELEASED',
    attemptId: row.id,
    assignmentId: room.assignmentId,
    submittedAt: (row.submittedAt ?? new Date(T0)).toISOString(),
    answers: row.responses.map((response) => ({
      questionId: response.questionId,
      answer: response.answer,
      submittedAt: (row.submittedAt ?? new Date(T0)).toISOString(),
    })),
    // **THE REAL NUMBERS, AND THE ROWS THAT CARRY THEM ARE STILL THERE.** Nothing here is a fixture number.
    score:
      state.state === 'RELEASED'
        ? {
            rawTotal: Number(total._sum.autoScore ?? 0),
            maxTotal: TRUE_MAX,
            percentage: (Number(total._sum.autoScore ?? 0) / TRUE_MAX) * 100,
            perQuestion: row.responses.map((response) => ({
              questionId: response.questionId,
              score: Number(response.manualScore ?? response.autoScore ?? 0),
              max: TRUE_MAX,
              outcome: 'PARTIAL' as const,
              feedback: null,
              correctAnswer: null,
            })),
          }
        : null,
    releasedAt: state.state === 'RELEASED' ? (state.releasedAt ?? null) : null,
    regradeNotice: null,
  });
};

const send = (
  room: Room,
  grade: Grade,
  standard: OutboundStandard,
  envelope?: Record<string, unknown>,
) =>
  prepareOutbound({
    target: {
      standard,
      bindingId: 'binding-1',
      externalId: 'platform-1',
      attemptId: room.attemptId,
      assignmentId: room.assignmentId,
    },
    grade,
    envelope,
  });

/**
 * EVERY NUMBER ANYWHERE IN A PARSED DOCUMENT.
 *
 * `expect(body.body).not.toContain('7')` was the first version of the assertion below and it is worthless: the document
 * is full of UUIDs and a hexadecimal receipt hash, so any single digit appears in it by chance. **A substring test on a
 * serialised payload cannot distinguish a mark from a coincidence**, which is the whole reason the check has to walk
 * the value. This walks it, and asserts the sealed document contains NO NUMBER AT ALL -- which is stronger than
 * "not the mark" and is the shape the invariant actually has.
 */
const numbersIn = (value: unknown): number[] => {
  if (typeof value === 'number') return [value];
  if (Array.isArray(value)) return value.flatMap(numbersIn);
  if (value !== null && typeof value === 'object')
    return Object.values(value as Record<string, unknown>).flatMap(numbersIn);
  return [];
};

describe.skipIf(!process.env.DATABASE_URL)(
  'P10-T10: nothing score-bearing crosses for an unreleased attempt that has a score',
  () => {
    it('sees the mark in the database and sends nothing, on both standards', async () => {
      const room = await gradedAttemptWithAScore();

      // PRECONDITION, STATED AS AN ASSERTION RATHER THAN A COMMENT: the score really is on the row.
      const stored = await prisma().examAttempt.findUniqueOrThrow({
        where: { id: room.attemptId },
        select: { finalScore: true, maxScore: true },
      });
      expect(Number(stored.finalScore)).toBe(TRUE_TOTAL);
      expect(Number(stored.maxScore)).toBe(TRUE_MAX);
      expect((await attemptReleaseState(prisma(), room.attemptId)).state).toBe('SEALED');

      const grade = await gradeFromDatabase(room);
      expect(grade.state).toBe('SEALED');

      for (const standard of ['LTI_AGS', 'XAPI'] as const) {
        const body = send(room, grade, standard);
        expect(body.state).toBe('SEALED');
        const document = JSON.parse(body.body) as Record<string, unknown>;

        // NO SCORE FIELD, ON THE OBJECT OR IN THE BYTES. Not null, not zero, not a placeholder: absent.
        expect(Object.keys(document)).not.toContain('score');
        expect(body.body).not.toContain('scoreGiven');
        expect(body.body).not.toContain('scoreMaximum');
        // AND NO NUMBER ANYWHERE IN THE DOCUMENT, which is what "no mark" means when the mark is `7` and the payload is
        // full of digits that are not it.
        expect(numbersIn(document), 'a sealed outbound document carrying a number').toEqual([]);
        expect(findInteropScoreBearingKeys(document)).toEqual([]);

        // AND NO ANSWER CONTENT, which no key-based guard could ever have caught.
        expect(body.body).not.toContain('seven of them');
        expect(body.body).not.toContain('answers');
      }
    });

    it('refuses a smuggled copy of the REAL mark read straight out of the row', async () => {
      /**
       * THE NEGATIVE CASE WITH A REAL NUMBER IN IT, rather than a literal somebody typed.
       *
       * The envelope is built from the row, so this is the exact shape a hurried integration would produce: a codec that
       * was handed the attempt and spread what it had into an xAPI extension. Every value in it is true, which is what
       * makes it dangerous -- nothing about this payload is wrong, it is just early.
       */
      const room = await gradedAttemptWithAScore();
      const row = await prisma().examAttempt.findUniqueOrThrow({
        where: { id: room.attemptId },
        select: { finalScore: true, maxScore: true, percentage: true },
      });
      const grade = await gradeFromDatabase(room);

      const smuggled = {
        'https://w3id.org/xapi/extensions/orrery': {
          grade: {
            scoreGiven: Number(row.finalScore),
            scoreMaximum: Number(row.maxScore),
            percentage: Number(row.percentage),
          },
        },
      };
      expect(() => send(room, grade, 'XAPI', smuggled)).toThrow(/INTEROP_SCORE_LEAK/);
      expect(() => send(room, grade, 'LTI_AGS', smuggled)).toThrow(/INTEROP_SCORE_LEAK/);

      // And the exact AGS shape `plans/16` §4.1 describes, with this attempt's real mark in it.
      expect(() =>
        send(room, grade, 'LTI_AGS', {
          lineItem: {
            scoreGiven: Number(row.finalScore),
            scoreMaximum: Number(row.maxScore),
            activityProgress: 'Completed',
          },
        }),
      ).toThrow(/scoreGiven/);
    });

    it('changes its decision when the DATABASE changes, with no other input changing', async () => {
      /**
       * THE CHOKEPOINT IS DRIVEN BY `B16`'s PREDICATE, AND THIS IS THE PROOF.
       *
       * Same room, same student, same `gradeFromDatabase` call, same target -- one thing differs, and it is the database:
       * the attempt joins a batch and the batch is released. If this passed while `released` were still a caller-supplied
       * boolean, the boundary would be a convention. Here the ONLY input that changed is a row.
       */
      const room = await gradedAttemptWithAScore();
      const before = await gradeFromDatabase(room);
      expect(before.state).toBe('SEALED');
      expect(send(room, before, 'LTI_AGS').state).toBe('SEALED');

      const created = await createReleaseBatch(prisma(), {
        assignmentId: room.assignmentId,
        classroomId: room.classroomId,
        attemptIds: [room.attemptId],
        actorId: room.teacherId,
        clock,
      });
      if (!created.ok) throw new Error(`fixture: ${JSON.stringify(created)}`);
      mine.batches.push(created.batchId);
      const ready = await markBatchReady(prisma(), {
        batchId: created.batchId,
        actorId: room.teacherId,
        clock,
      });
      if (!ready.ok) throw new Error(`fixture: ${JSON.stringify(ready)}`);
      const begun = await beginRelease(prisma(), {
        batchId: created.batchId,
        actorId: room.teacherId,
        clock,
      });
      if (!begun.ok) throw new Error(`fixture: ${JSON.stringify(begun)}`);

      // STILL SEALED, because `RELEASING` is not `RELEASED`. This is the intermediate state the gate exists to hide.
      const midway = await gradeFromDatabase(room);
      expect(midway.state).toBe('SEALED');
      expect(send(room, midway, 'LTI_AGS').state).toBe('SEALED');

      await prisma().releaseBatch.update({
        where: { id: created.batchId },
        data: { status: 'RELEASED', releasedAt: new Date(T0), releasedById: room.teacherId },
      });

      const after = await gradeFromDatabase(room);
      expect(after.state).toBe('RELEASED');
      const ags = send(room, after, 'LTI_AGS');
      expect(ags.state).toBe('RELEASED');
      expect(ags.state === 'RELEASED' ? ags.score : null).toMatchObject({
        scoreGiven: TRUE_TOTAL,
        scoreMaximum: TRUE_MAX,
        activityProgress: 'Completed',
      });
      // ...and the mark in the payload is the mark in the row, which is the only definition of correct that matters.
      const xapi = send(room, after, 'XAPI');
      expect(xapi.state === 'RELEASED' ? xapi.score : null).toMatchObject({
        raw: TRUE_TOTAL,
        max: TRUE_MAX,
      });
    });
  },
);

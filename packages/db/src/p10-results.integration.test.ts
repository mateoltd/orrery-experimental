import { randomUUID } from 'node:crypto';
import type { Actor } from '@orrery/auth/types';
import { FrozenClock } from '@orrery/clock';
import { assertNoScoreLeak } from '@orrery/interop';
import { afterAll, describe, expect, it } from 'vitest';
import { applyAttemptException, setAssignmentLatePenalty } from './attempt-exceptions.js';
import type { TxClient } from './index.js';
import { PrismaClient } from './prisma.js';
import { queueReleaseNotifications } from './release-delivery.js';
import { finishRelease, runReleaseTick } from './release-worker.js';
import { loadStudentDigest, queueStudentDigest, runStudentDigestTick } from './student-digest.js';
import {
  ACCOMMODATION_MARKER,
  loadStudentResults,
  setResultsAccommodationVisibility,
  VOIDED_RESULTS_NOTICE,
} from './student-results.js';

const db = new PrismaClient();
const clock = new FrozenClock(1_800_000_000_000);
const users: string[] = [],
  attempts: string[] = [],
  batches: string[] = [],
  assignments: string[] = [],
  resources: string[] = [],
  versions: string[] = [],
  rooms: string[] = [],
  banks: string[] = [],
  questions: string[] = [];
afterAll(async () => {
  await db.emailOutbox.deleteMany({ where: { userId: { in: users } } });
  await db.notificationPreference.deleteMany({ where: { userId: { in: users } } });
  await db.auditEvent.deleteMany({
    where: {
      OR: [
        { targetId: { in: [...batches, ...attempts, ...assignments] } },
        { actorId: { in: users } },
      ],
    },
  });
  await db.examAttempt.deleteMany({ where: { id: { in: attempts } } });
  await db.releaseBatch.deleteMany({ where: { id: { in: batches } } });
  await db.assignment.deleteMany({ where: { id: { in: assignments } } });
  await db.question.deleteMany({ where: { id: { in: questions } } });
  await db.questionBank.deleteMany({ where: { id: { in: banks } } });
  await db.classroom.deleteMany({ where: { id: { in: rooms } } });
  await db.resourceVersion.deleteMany({ where: { id: { in: versions } } });
  await db.resource.deleteMany({ where: { id: { in: resources } } });
  await db.user.deleteMany({ where: { id: { in: users } } });
  await db.$disconnect();
});
async function person() {
  const id = randomUUID();
  users.push(id);
  await db.user.create({
    data: {
      id,
      email: `${id}@p10-impl.example`,
      emailNormalized: `${id}@p10-impl.example`,
      name: 'P10 fixture',
    },
  });
  return id;
}
async function fixture() {
  const teacherId = await person(),
    studentId = await person();
  const resource = await db.resource.create({
    data: { ownerId: teacherId, title: 'Mechanics', slug: randomUUID() },
  });
  resources.push(resource.id);
  const version = await db.resourceVersion.create({
    data: {
      resourceId: resource.id,
      version: 1,
      blocks: [],
      blocksChecksum: 'p10',
      meta: {},
      createdById: teacherId,
    },
  });
  versions.push(version.id);
  const room = await db.classroom.create({
    data: { ownerId: teacherId, name: 'P10 impl', slug: randomUUID() },
  });
  rooms.push(room.id);
  // The kernel's `sameClassroom` obligation reads ENROLMENT, not `ownerId`, as `createClassroom` writes it.
  await db.enrollment.create({
    data: { classroomId: room.id, userId: teacherId, role: 'OWNER', status: 'ACTIVE' },
  });
  const assignment = await db.assignment.create({
    data: {
      classroomId: room.id,
      resourceId: resource.id,
      resourceVersionId: version.id,
      createdById: teacherId,
      status: 'PUBLISHED',
      availableUntil: new Date(clock.now() - 1000),
      latePenaltyPercent: 10,
    },
  });
  assignments.push(assignment.id);
  const bank = await db.questionBank.create({ data: { ownerId: teacherId, name: 'P10 impl' } });
  banks.push(bank.id);
  const question = await db.question.create({
    data: {
      bankId: bank.id,
      type: 'single_choice',
      spec: { key: { choiceId: 'a' } },
      points: 2,
      modelAnswer: 'Author model answer',
    },
  });
  questions.push(question.id);
  return {
    teacherId,
    studentId,
    classroomId: room.id,
    assignmentId: assignment.id,
    questionId: question.id,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const staff = (id: string, roles: Actor['roles'] = ['teacher']): Actor => ({
  id,
  roles,
  mfaVerified: false,
  suspended: false,
});
async function attempt(
  f: Fixture,
  status: 'GRADED' | 'IN_PROGRESS' | 'NOT_STARTED' | 'FROZEN' = 'GRADED',
  studentId = f.studentId,
) {
  const row = await db.examAttempt.create({
    data: {
      assignmentId: f.assignmentId,
      classroomId: f.classroomId,
      studentId,
      attemptNumber: attempts.length + 1,
      status,
      policySnapshot: { showCorrectAnswersAfterRelease: false },
      deadlineAt: new Date(clock.now() + 60000),
      submittedAt: status === 'GRADED' ? new Date(clock.now() - 10000) : null,
      submissionReceipt: 'real-stored-receipt',
      relaxationsApplied: ['DISABLE_FULLSCREEN'],
      responses: {
        create: {
          questionId: f.questionId,
          position: 0,
          answer: { choiceId: 'a' },
          autoScore: 2,
          manualFeedback: 'Response feedback',
        },
      },
    },
  });
  attempts.push(row.id);
  return row.id;
}
async function batch(
  f: Fixture,
  members: string[],
  status: 'DRAFT' | 'READY' | 'RELEASING' = 'RELEASING',
) {
  const row = await db.releaseBatch.create({
    data: {
      assignmentId: f.assignmentId,
      classroomId: f.classroomId,
      members: { create: members.map((attemptId) => ({ attemptId })) },
    },
  });
  batches.push(row.id);
  if (status !== 'DRAFT')
    await db.releaseBatch.update({ where: { id: row.id }, data: { status: 'READY' } });
  if (status === 'RELEASING')
    await db.releaseBatch.update({ where: { id: row.id }, data: { status } });
  return row.id;
}
function transactionProxy(transform: (tx: TxClient) => TxClient): PrismaClient {
  return new Proxy(db, {
    get(target, property) {
      if (property === '$transaction')
        return (fn: (tx: TxClient) => Promise<unknown>, options?: object) =>
          target.$transaction((tx) => fn(transform(tx)), options);
      return Reflect.get(target, property);
    },
  });
}
function scopedScan(ids: string[]): PrismaClient {
  return new Proxy(db, {
    get(target, property) {
      if (property === 'releaseBatch')
        return new Proxy(target.releaseBatch, {
          get(model, method) {
            if (method === 'findMany')
              return (args: Record<string, unknown>) =>
                model.findMany({
                  ...args,
                  where: { AND: [args.where, { id: { in: ids } }] },
                } as never);
            return Reflect.get(model, method);
          },
        });
      return Reflect.get(target, property);
    },
  });
}

const reason = 'Teacher recorded a specific exception';
describe('atomic release and worker recovery', () => {
  it('failure after the first score write rolls back every score, visibility and audit; the next tick finishes', async () => {
    const f = await fixture(),
      a = await attempt(f),
      b = await attempt(f, 'GRADED', await person());
    const id = await batch(f, [a, b]);
    let writes = 0;
    const failing = transactionProxy(
      (tx) =>
        new Proxy(tx, {
          get(target, property) {
            if (property === 'examAttempt')
              return new Proxy(target.examAttempt, {
                get(model, method) {
                  if (method === 'update')
                    return (args: Parameters<typeof model.update>[0]) => {
                      if (++writes === 2) throw new Error('injected worker crash');
                      return model.update(args);
                    };
                  return Reflect.get(model, method);
                },
              });
            return Reflect.get(target, property);
          },
        }),
    );
    await expect(finishRelease(failing, id, clock)).rejects.toThrow('injected worker crash');
    expect(writes).toBe(2);
    const rows = await db.examAttempt.findMany({
      where: { id: { in: [a, b] } },
      select: { finalScore: true, releasedAt: true },
    });
    expect(rows.every((r) => r.finalScore === null && r.releasedAt === null)).toBe(true);
    expect((await db.releaseBatch.findUniqueOrThrow({ where: { id } })).status).toBe('RELEASING');
    expect(
      await db.attemptEventRecord.count({ where: { attemptId: { in: [a, b] }, type: 'RELEASED' } }),
    ).toBe(0);
    const next = await runReleaseTick(scopedScan([id]), clock, 'https://orrery.example');
    expect(next).toEqual([{ batchId: id, released: true, notified: 2 }]);
    const result = await loadStudentResults(db, f.studentId, a);
    expect(result?.state).toBe('RELEASED');
    expect(
      (await db.examAttempt.findUniqueOrThrow({ where: { id: b } })).finalScore?.toNumber(),
    ).toBe(100);
  });
  it('verifies all before writing: one ungraded member leaves the whole batch sealed', async () => {
    const f = await fixture(),
      a = await attempt(f),
      b = await attempt(f, 'IN_PROGRESS', await person());
    const id = await batch(f, [a, b]);
    expect((await finishRelease(db, id, clock)).released).toBe(false);
    expect((await db.examAttempt.findUniqueOrThrow({ where: { id: a } })).finalScore).toBeNull();
    expect((await loadStudentResults(db, f.studentId, a))?.state).toBe('SEALED');
  });
  it('a RELEASING batch that verification refuses is reported every tick, releases nobody, and finishes once fixed', async () => {
    const f = await fixture(),
      a = await attempt(f),
      b = await attempt(f, 'IN_PROGRESS', await person());
    const id = await batch(f, [a, b]);
    const stuck = [
      {
        batchId: id,
        released: false,
        notified: 0,
        refusals: [{ attemptId: b, reason: 'ATTEMPT_NOT_GRADED' }],
      },
    ];
    // Twice: a refusal must not consume the batch or quietly drop it from discovery.
    expect(await runReleaseTick(scopedScan([id]), clock, 'https://orrery.example')).toEqual(stuck);
    expect(await runReleaseTick(scopedScan([id]), clock, 'https://orrery.example')).toEqual(stuck);
    expect((await loadStudentResults(db, f.studentId, a))?.state).toBe('SEALED');
    expect(await db.notification.count({ where: { userId: f.studentId } })).toBe(0);
    await db.examAttempt.update({ where: { id: b }, data: { status: 'GRADED' } });
    expect(await runReleaseTick(scopedScan([id]), clock, 'https://orrery.example')).toEqual([
      { batchId: id, released: true, notified: 2 },
    ]);
  });
  it('READY is left alone and a RELEASING batch is rediscovered on a later tick', async () => {
    const f = await fixture(),
      a = await attempt(f),
      id = await batch(f, [a], 'READY');
    expect(await runReleaseTick(scopedScan([id]), clock, 'https://orrery.example')).toEqual([]);
    await db.releaseBatch.update({ where: { id }, data: { status: 'RELEASING' } });
    expect(
      (await runReleaseTick(scopedScan([id]), clock, 'https://orrery.example'))[0]?.released,
    ).toBe(true);
  });
  it('retry after commit is a no-op and concurrent workers write one release event', async () => {
    const f = await fixture(),
      a = await attempt(f),
      id = await batch(f, [a]);
    const results = await Promise.all([finishRelease(db, id, clock), finishRelease(db, id, clock)]);
    expect(results.filter((r) => r.released)).toHaveLength(1);
    const before = await db.examAttempt.findUniqueOrThrow({ where: { id: a } });
    expect(
      (await finishRelease(db, id, new FrozenClock(clock.now() + 5000))).refusals[0]?.reason,
    ).toBe('ALREADY_RELEASED');
    const after = await db.examAttempt.findUniqueOrThrow({ where: { id: a } });
    expect(after.releasedAt).toEqual(before.releasedAt);
    expect(await db.attemptEventRecord.count({ where: { attemptId: a, type: 'RELEASED' } })).toBe(
      1,
    );
  });
  it('an in-flight grade is WAITED for: the release blocks on its row lock and then verifies the committed mark', async () => {
    const f = await fixture(),
      a = await attempt(f),
      id = await batch(f, [a]);
    let markReady!: () => void, commitGrade!: () => void;
    const ready = new Promise<void>((r) => {
        markReady = r;
      }),
      hold = new Promise<void>((r) => {
        commitGrade = r;
      });
    const grading = db.$transaction(
      async (tx) => {
        await tx.questionResponse.update({
          where: { attemptId_questionId: { attemptId: a, questionId: f.questionId } },
          data: { manualScore: 1 },
        });
        markReady();
        await hold;
      },
      { timeout: 20000 },
    );
    await ready;
    let settled = false;
    const release = finishRelease(db, id, clock).finally(() => {
      settled = true;
    });
    try {
      // Without `FOR UPDATE OF r` the release reads the OLD committed mark and finishes here, at
      // 100, and the grade then lands on an already-released attempt (`B16`'s window).
      await new Promise((r) => setTimeout(r, 500));
      expect(settled).toBe(false);
    } finally {
      commitGrade();
    }
    await grading;
    expect((await release).released).toBe(true);
    expect(
      (await db.examAttempt.findUniqueOrThrow({ where: { id: a } })).finalScore?.toNumber(),
    ).toBe(50);
  });
  it('a cancel in flight wins cleanly: the release waits on the batch row and then refuses, writing nothing', async () => {
    const f = await fixture(),
      a = await attempt(f),
      id = await batch(f, [a]);
    let markReady!: () => void, commitCancel!: () => void;
    const ready = new Promise<void>((r) => {
        markReady = r;
      }),
      hold = new Promise<void>((r) => {
        commitCancel = r;
      });
    const canceling = db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "ReleaseBatch" WHERE id = ${id} FOR UPDATE`;
        await tx.releaseBatch.update({ where: { id }, data: { status: 'CANCELED' } });
        markReady();
        await hold;
      },
      { timeout: 20000 },
    );
    await ready;
    const release = finishRelease(db, id, clock);
    await new Promise((r) => setTimeout(r, 300));
    commitCancel();
    await canceling;
    // A refusal, not a thrown trigger error: taking the batch lock FIRST is what lets the release
    // see `CANCELED` before it has verified or written anything.
    expect(await release).toEqual({
      released: false,
      releasedCount: 0,
      refusals: [{ attemptId: null, reason: 'BATCH_NOT_RELEASING' }],
    });
    const row = await db.examAttempt.findUniqueOrThrow({ where: { id: a } });
    expect([row.finalScore, row.releasedAt]).toEqual([null, null]);
  });
  it('reads the configured penalty and clamps legacy values over 100', async () => {
    const f = await fixture(),
      a = await attempt(f);
    await db.examAttempt.update({ where: { id: a }, data: { isLate: true } });
    await db.assignment.update({
      where: { id: f.assignmentId },
      data: { latePenaltyPercent: 150 },
    });
    const id = await batch(f, [a]);
    expect((await finishRelease(db, id, clock)).released).toBe(true);
    const row = await db.examAttempt.findUniqueOrThrow({ where: { id: a } });
    expect(row.finalScore?.toNumber()).toBe(0);
    expect(row.latePenaltyApplied?.toNumber()).toBe(1);
  });
});

describe('owned results and score inference', () => {
  it('a released sibling batch on the same assignment never exposes sealed marks; grade changes leave bytes identical', async () => {
    const f = await fixture(),
      a = await attempt(f),
      sibling = await attempt(f, 'GRADED', await person());
    const releasedBatch = await batch(f, [sibling]);
    await batch(f, [a], 'DRAFT');
    await finishRelease(db, releasedBatch, clock);
    const first = await loadStudentResults(db, f.studentId, a);
    expect(first?.state).toBe('SEALED');
    expect(() => assertNoScoreLeak(first)).not.toThrow();
    await db.examAttempt.update({
      where: { id: a },
      data: { finalScore: 0, percentage: 0, status: 'PENDING_REVIEW' },
    });
    await db.questionResponse.update({
      where: { attemptId_questionId: { attemptId: a, questionId: f.questionId } },
      data: { manualScore: 0, needsHuman: true, manualFeedback: 'Hidden changed feedback' },
    });
    const second = await loadStudentResults(db, f.studentId, a);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(() =>
      assertNoScoreLeak({ ...second, questions: [{ correctAnswer: 'injected key' }] }),
    ).toThrow('$.questions[0].correctAnswer');
  });
  it('voiding after release takes the marks back down and says so, rather than "still being reviewed"', async () => {
    const f = await fixture(),
      a = await attempt(f),
      id = await batch(f, [a]);
    await finishRelease(db, id, clock);
    expect((await loadStudentResults(db, f.studentId, a))?.state).toBe('RELEASED');
    await db.examAttempt.update({ where: { id: a }, data: { status: 'VOIDED' } });
    const voided = await loadStudentResults(db, f.studentId, a);
    expect(voided).toMatchObject({ state: 'SEALED', notice: VOIDED_RESULTS_NOTICE });
    expect(() => assertNoScoreLeak(voided)).not.toThrow();
  });
  it('other-owner and nonexistent attempts return the same null', async () => {
    const f = await fixture(),
      a = await attempt(f),
      id = await batch(f, [a]);
    await finishRelease(db, id, clock);
    expect(await loadStudentResults(db, await person(), a)).toBeNull();
    expect(await loadStudentResults(db, f.studentId, randomUUID())).toBeNull();
  });
  it('outcomes, visible feedback, breakdown, stored receipt and opt-in rights marker are projected after release', async () => {
    const f = await fixture(),
      a = await attempt(f);
    await db.feedback.createMany({
      data: [
        {
          attemptId: a,
          authorId: f.teacherId,
          body: 'Visible feedback',
          visibility: 'STUDENT_AFTER_RELEASE',
        },
        {
          attemptId: a,
          authorId: f.teacherId,
          body: 'Private feedback',
          visibility: 'TEACHER_ONLY',
        },
        { attemptId: a, authorId: f.teacherId, body: 'Draft feedback', isDraft: true },
      ],
    });
    await db.examAttempt.update({ where: { id: a }, data: { isLate: true } });
    const id = await batch(f, [a]);
    await finishRelease(db, id, clock);
    let result = await loadStudentResults(db, f.studentId, a);
    if (result?.state !== 'RELEASED') throw new Error('expected release');
    expect(result.questions[0]?.outcome).toBe('CORRECT');
    expect(result.questions[0]?.correctAnswer).toBeNull();
    expect(result.questions[0]?.feedback).toEqual(['Response feedback']);
    expect(result.feedback).toEqual(['Visible feedback']);
    expect(result.breakdown).toEqual({
      rawTotal: 2,
      maxTotal: 2,
      percentage: 1,
      finalScore: 90,
      latePenaltyApplied: 0.1,
      provisional: false,
    });
    expect(result.receipt.receiptHash).toBe('real-stored-receipt');
    expect(result.accommodationMarker).toBeNull();
    await setResultsAccommodationVisibility(db, await person(), a, true);
    expect(
      (await db.examAttempt.findUniqueOrThrow({ where: { id: a } })).showAccommodationOnResults,
    ).toBe(false);
    await setResultsAccommodationVisibility(db, f.studentId, a, true);
    await db.examAttempt.update({
      where: { id: a },
      data: {
        policySnapshot: { showCorrectAnswersAfterRelease: true },
        regradeNoticePendingAt: new Date(clock.now()),
      },
    });
    result = await loadStudentResults(db, f.studentId, a);
    if (result?.state !== 'RELEASED') throw new Error('expected release');
    expect(result.questions[0]?.correctAnswer).toBe('Author model answer');
    expect(result.accommodationMarker).toBe(ACCOMMODATION_MARKER);
    expect(result.accommodationMarker).not.toMatch(/penalty|score|mark affected/);
    expect(result.regradeNotice).toContain('updated');
    expect(JSON.stringify(result)).not.toMatch(/Private feedback|Draft feedback/);
  });
});

describe('late, absent and extended are independent facts', () => {
  it('two live deadline extensions append twice and leave the base deadline unchanged; every grant is audited', async () => {
    const f = await fixture(),
      a = await attempt(f, 'IN_PROGRESS');
    const before = await db.examAttempt.findUniqueOrThrow({ where: { id: a } });
    const base = before.deadlineAt?.getTime() ?? 0;
    // A co-teacher, not the owner: `Classroom.update` is owner-only, so this is the case that
    // breaks if the question is asked of the classroom rather than of the attempt.
    const coTeacher = await person();
    await db.enrollment.create({
      data: { classroomId: f.classroomId, userId: coTeacher, role: 'TEACHER', status: 'ACTIVE' },
    });
    const told: (number | undefined)[] = [];
    for (const actor of [staff(f.teacherId), staff(coTeacher)]) {
      const result = await applyAttemptException(db, {
        attemptId: a,
        actor,
        reason,
        action: { kind: 'EXTEND_DEADLINE', addedSec: 60 },
        clock,
      });
      if (!result.ok) throw new Error(`extension refused: ${result.reason}`);
      told.push(result.effectiveDeadlineAt?.getTime());
    }
    // Grant twice means ADD twice: the second confirmation is 120 s past base, not 60.
    expect(told).toEqual([base + 60_000, base + 120_000]);
    expect((await db.examAttempt.findUniqueOrThrow({ where: { id: a } })).deadlineAt).toEqual(
      before.deadlineAt,
    );
    const extensions = await db.attemptDeadlineExtension.findMany({
      where: { attemptId: a },
      orderBy: { id: 'asc' },
    });
    expect(extensions.map((e) => e.addedSec)).toEqual([60, 60]);
    expect(extensions.map((e) => e.actorId)).toEqual([f.teacherId, coTeacher]);
    expect(extensions.every((e) => e.reason === reason)).toBe(true);
    expect(
      await db.attemptEventRecord.count({ where: { attemptId: a, type: 'DEADLINE_EXTENDED' } }),
    ).toBe(2);
    const audits = await db.auditEvent.findMany({
      where: { targetId: a, action: 'ExamAttempt.DEADLINE_EXTENDED' },
      select: { actorId: true, meta: true },
    });
    expect(audits).toHaveLength(2);
    expect(audits.every((e) => (e.meta as { reason?: string }).reason === reason)).toBe(true);
  });
  it('a student cannot extend their own deadline, and a submitted attempt has none to extend', async () => {
    const f = await fixture(),
      a = await attempt(f, 'IN_PROGRESS');
    await db.enrollment.create({
      data: { classroomId: f.classroomId, userId: f.studentId, role: 'STUDENT', status: 'ACTIVE' },
    });
    const extend = (actor: Actor) =>
      applyAttemptException(db, {
        attemptId: a,
        actor,
        reason,
        action: { kind: 'EXTEND_DEADLINE', addedSec: 600 },
        clock,
      });
    // Even holding the global teacher role: authority is the role IN THIS classroom.
    expect(await extend(staff(f.studentId, ['student', 'teacher']))).toEqual({
      ok: false,
      reason: 'FORBIDDEN',
    });
    await db.examAttempt.update({ where: { id: a }, data: { status: 'SUBMITTED' } });
    expect(await extend(staff(f.teacherId))).toEqual({ ok: false, reason: 'INVALID_STATE' });
    expect(await db.attemptDeadlineExtension.count({ where: { attemptId: a } })).toBe(0);
  });
  it('excused and missing are separate states; student override keeps a missing window open', async () => {
    const f = await fixture(),
      excused = await attempt(f, 'NOT_STARTED'),
      missing = await attempt(f, 'NOT_STARTED');
    /**
     * THE KERNEL REFUSES A TEACHER HERE, AND THIS ASSERTS WHAT IS TRUE RATHER THAN WHAT IS WANTED.
     *
     * `plans/07` §8 says excused is "teacher-marked"; `examAttemptRules.excuse` in `@orrery/auth`
     * grants `platformAdmin` only. This module asks the kernel and does not route around it, so a
     * teacher is `FORBIDDEN` until that one rule changes -- at which point THIS expectation fails
     * and should be flipped, with no change to `attempt-exceptions.ts`.
     */
    expect(
      await applyAttemptException(db, {
        attemptId: excused,
        actor: staff(f.teacherId),
        reason,
        action: { kind: 'EXCUSE' },
        clock,
      }),
    ).toEqual({ ok: false, reason: 'FORBIDDEN' });
    expect((await db.examAttempt.findUniqueOrThrow({ where: { id: excused } })).status).toBe(
      'NOT_STARTED',
    );
    const adminId = await person();
    await db.enrollment.create({
      data: { classroomId: f.classroomId, userId: adminId, role: 'TEACHER', status: 'ACTIVE' },
    });
    const admin = staff(adminId, ['platformAdmin']);
    expect(
      (
        await applyAttemptException(db, {
          attemptId: excused,
          actor: admin,
          reason,
          action: { kind: 'EXCUSE' },
          clock,
        })
      ).ok,
    ).toBe(true);
    await db.assignmentStudentOverride.create({
      data: {
        assignmentId: f.assignmentId,
        studentId: f.studentId,
        grantedById: f.teacherId,
        reason,
        availableUntil: new Date(clock.now() + 1000),
      },
    });
    expect(
      await applyAttemptException(db, {
        attemptId: missing,
        actor: admin,
        reason,
        action: { kind: 'MARK_MISSING' },
        clock,
      }),
    ).toEqual({ ok: false, reason: 'WINDOW_OPEN' });
    await db.assignmentStudentOverride.deleteMany({
      where: { assignmentId: f.assignmentId, studentId: f.studentId },
    });
    expect(
      (
        await applyAttemptException(db, {
          attemptId: missing,
          actor: admin,
          reason,
          action: { kind: 'MARK_MISSING' },
          clock,
        })
      ).ok,
    ).toBe(true);
    expect((await db.examAttempt.findUniqueOrThrow({ where: { id: excused } })).status).toBe(
      'EXCUSED',
    );
    expect((await db.examAttempt.findUniqueOrThrow({ where: { id: missing } })).status).toBe(
      'MISSING',
    );
    // Two facts, two events: neither transition is recorded as the other.
    expect(
      await db.attemptEventRecord.findMany({
        where: { attemptId: { in: [excused, missing] } },
        select: { attemptId: true, type: true },
        orderBy: { serverTs: 'asc' },
      }),
    ).toEqual(
      expect.arrayContaining([
        { attemptId: excused, type: 'EXCUSED' },
        { attemptId: missing, type: 'MISSING' },
      ]),
    );
  });
  it('unauthorised and reasonless exceptions write nothing', async () => {
    const f = await fixture(),
      a = await attempt(f, 'IN_PROGRESS');
    expect(
      await applyAttemptException(db, {
        attemptId: a,
        actor: staff(await person()),
        reason,
        action: { kind: 'EXTEND_DEADLINE', addedSec: 30 },
        clock,
      }),
    ).toEqual({ ok: false, reason: 'FORBIDDEN' });
    expect(
      await applyAttemptException(db, {
        attemptId: a,
        actor: staff(f.teacherId),
        reason: ' ',
        action: { kind: 'EXTEND_DEADLINE', addedSec: 30 },
        clock,
      }),
    ).toEqual({ ok: false, reason: 'NO_REASON' });
    expect(await db.attemptDeadlineExtension.count({ where: { attemptId: a } })).toBe(0);
    expect(await db.attemptEventRecord.count({ where: { attemptId: a } })).toBe(0);
  });
  it('late flag and penalty are auditable, and penalty edits after release require regrade', async () => {
    const f = await fixture(),
      a = await attempt(f);
    expect(
      (
        await applyAttemptException(db, {
          attemptId: a,
          actor: staff(f.teacherId),
          reason,
          action: { kind: 'MARK_LATE', isLate: true },
          clock,
        })
      ).ok,
    ).toBe(true);
    expect(
      await setAssignmentLatePenalty(db, {
        assignmentId: f.assignmentId,
        actor: staff(f.teacherId),
        percent: 25,
        reason,
        clock,
      }),
    ).toEqual({ ok: true });
    const id = await batch(f, [a]);
    await finishRelease(db, id, clock);
    expect(
      (await db.examAttempt.findUniqueOrThrow({ where: { id: a } })).finalScore?.toNumber(),
    ).toBe(75);
    expect(
      await setAssignmentLatePenalty(db, {
        assignmentId: f.assignmentId,
        actor: staff(f.teacherId),
        percent: 20,
        reason,
        clock,
      }),
    ).toEqual({ ok: false, reason: 'REQUIRES_REGRADE' });
  });
});

describe('release delivery and student digest', () => {
  it('no notification before release; committed release is picked up for notification on the next tick', async () => {
    const f = await fixture(),
      a = await attempt(f),
      id = await batch(f, [a]);
    expect(await queueReleaseNotifications(db, id, clock, 'https://orrery.example')).toBe(0);
    await finishRelease(db, id, clock);
    const result = await runReleaseTick(scopedScan([id]), clock, 'https://orrery.example');
    expect(result).toEqual([{ batchId: id, released: false, notified: 1 }]);
    expect(await runReleaseTick(scopedScan([id]), clock, 'https://orrery.example')).toEqual([]);
    const notices = await db.notification.findMany({
      where: { userId: f.studentId, kind: 'RESULTS_RELEASED', refId: a },
    });
    expect(notices).toHaveLength(1);
    expect(notices[0]?.body).not.toMatch(/score|rank|classmate|changed/);
    expect(
      await db.emailOutbox.count({ where: { userId: f.studentId, template: 'RESULTS_RELEASED' } }),
    ).toBe(1);
  });
  it('an outbox write failure also rolls back the inbox row, and retry queues both halves', async () => {
    const f = await fixture(),
      a = await attempt(f),
      id = await batch(f, [a]);
    await finishRelease(db, id, clock);
    const failing = transactionProxy(
      (tx) =>
        new Proxy(tx, {
          get(target, property) {
            if (property === '$queryRaw')
              return (strings: TemplateStringsArray, ...values: unknown[]) => {
                if (strings.join('').includes('INSERT INTO "EmailOutbox"'))
                  throw new Error('outbox unavailable');
                return target.$queryRaw(strings, ...values);
              };
            return Reflect.get(target, property);
          },
        }),
    );
    await expect(
      queueReleaseNotifications(failing, id, clock, 'https://orrery.example'),
    ).rejects.toThrow('outbox unavailable');
    expect(await db.notification.count({ where: { userId: f.studentId } })).toBe(0);
    expect(await db.emailOutbox.count({ where: { userId: f.studentId } })).toBe(0);
    expect(await queueReleaseNotifications(db, id, clock, 'https://orrery.example')).toBe(1);
  });
  it('concurrent notification delivery queues one inbox and one email per recipient', async () => {
    const f = await fixture(),
      a = await attempt(f),
      id = await batch(f, [a]);
    await finishRelease(db, id, clock);
    const delivered = await Promise.all([
      queueReleaseNotifications(db, id, clock, 'https://orrery.example'),
      queueReleaseNotifications(db, id, clock, 'https://orrery.example'),
    ]);
    expect(delivered.reduce((sum, n) => sum + n, 0)).toBe(1);
    expect(
      await db.notification.count({ where: { userId: f.studentId, kind: 'RESULTS_RELEASED' } }),
    ).toBe(1);
    expect(
      await db.emailOutbox.count({ where: { userId: f.studentId, template: 'RESULTS_RELEASED' } }),
    ).toBe(1);
  });
  it('crash on second recipient commits first delivery; retry fills the gap without duplicates', async () => {
    const f = await fixture(),
      other = await person(),
      a = await attempt(f),
      b = await attempt(f, 'GRADED', other),
      id = await batch(f, [a, b]);
    await finishRelease(db, id, clock);
    let transactions = 0;
    const failing = new Proxy(db, {
      get(target, property) {
        if (property === '$transaction')
          return (fn: (tx: TxClient) => Promise<unknown>) => {
            if (++transactions === 2) throw new Error('delivery crash');
            return target.$transaction(fn);
          };
        return Reflect.get(target, property);
      },
    });
    await expect(
      queueReleaseNotifications(failing, id, clock, 'https://orrery.example'),
    ).rejects.toThrow('delivery crash');
    expect(
      await db.notification.count({
        where: { userId: { in: [f.studentId, other] }, kind: 'RESULTS_RELEASED' },
      }),
    ).toBe(1);
    expect(
      (await db.releaseBatch.findUniqueOrThrow({ where: { id } })).notificationsCompletedAt,
    ).toBeNull();
    expect(await queueReleaseNotifications(db, id, clock, 'https://orrery.example')).toBe(1);
    expect(
      await db.notification.count({
        where: { userId: { in: [f.studentId, other] }, kind: 'RESULTS_RELEASED' },
      }),
    ).toBe(2);
    expect(
      await db.emailOutbox.count({
        where: { userId: { in: [f.studentId, other] }, template: 'RESULTS_RELEASED' },
      }),
    ).toBe(2);
  });
  it('hidden grade updates cannot reorder the score-free student digest', async () => {
    const f = await fixture(),
      otherAssignment = await fixture();
    const a = await attempt(f),
      b = await attempt(otherAssignment, 'GRADED', f.studentId);
    await db.examAttempt.update({
      where: { id: a },
      data: { updatedAt: new Date(clock.now() - 10000) },
    });
    await db.examAttempt.update({
      where: { id: b },
      data: { updatedAt: new Date(clock.now() - 5000) },
    });
    const before = await loadStudentDigest(db, f.studentId);
    await db.examAttempt.update({
      where: { id: a },
      data: { finalScore: 13, updatedAt: new Date(clock.now()) },
    });
    expect(JSON.stringify(await loadStudentDigest(db, f.studentId))).toBe(JSON.stringify(before));
  });
  it('digest tick dedupes within an interval, stays silent while nothing readable changed, and speaks when it does', async () => {
    const f = await fixture(),
      a = await attempt(f);
    await db.enrollment.create({
      data: { classroomId: f.classroomId, userId: f.studentId, role: 'STUDENT', status: 'ACTIVE' },
    });
    // Constrain the discovery READ; no production test-only scope parameter is needed.
    const scoped = new Proxy(db, {
      get(target, property) {
        if (property === 'user')
          return new Proxy(target.user, {
            get(model, method) {
              if (method === 'findMany')
                return (args: Record<string, unknown>) =>
                  model.findMany({
                    ...args,
                    where: { AND: [args.where, { id: f.studentId }] },
                  } as never);
              return Reflect.get(model, method);
            },
          });
        return Reflect.get(target, property);
      },
    });
    const tick = (hours: number) =>
      runStudentDigestTick(
        scoped,
        new FrozenClock(clock.now() + hours * 3_600_000),
        'https://orrery.example',
      );
    expect(await tick(0)).toEqual({ queued: 1, failed: 0 });
    // Same interval, e.g. a restarted worker: the persisted period dedupes.
    expect(await tick(0)).toEqual({ queued: 0, failed: 0 });
    // HIDDEN marking moved, across a new interval. A digest here would be a signal that it had.
    await db.examAttempt.update({
      where: { id: a },
      data: { status: 'PENDING_REVIEW', finalScore: 13 },
    });
    expect(await tick(1)).toEqual({ queued: 0, failed: 0 });
    const id = await batch(f, [a]);
    // Frozen for release but refused (the member is not `GRADED`): still nothing the student may read.
    expect((await finishRelease(db, id, clock)).released).toBe(false);
    expect(await tick(2)).toEqual({ queued: 0, failed: 0 });
    await db.examAttempt.update({ where: { id: a }, data: { status: 'GRADED' } });
    expect((await finishRelease(db, id, clock)).released).toBe(true);
    // Release IS something the student may read, so now there is news -- once.
    expect(await tick(3)).toEqual({ queued: 1, failed: 0 });
    expect(await tick(4)).toEqual({ queued: 0, failed: 0 });
    expect(
      await db.emailOutbox.count({ where: { userId: f.studentId, template: 'STUDENT_DIGEST' } }),
    ).toBe(2);
  });
  it('digest is owned, sealed-grade-free, reversible for frozen attempts, deduped and respects opt-out', async () => {
    const f = await fixture(),
      a = await attempt(f, 'FROZEN');
    await attempt(f, 'GRADED', await person());
    const digest = await loadStudentDigest(db, f.studentId);
    expect(digest.items).toHaveLength(1);
    expect(digest.items[0]?.href).toContain(a);
    expect(digest.items[0]?.notice).toContain('can reinstate');
    expect(() => assertNoScoreLeak(digest)).not.toThrow();
    await db.notificationPreference.create({
      data: { userId: f.studentId, unsubscribeToken: randomUUID(), emailOptOut: true },
    });
    const input = {
      studentId: f.studentId,
      period: '2026-10-05',
      origin: 'https://orrery.example',
      clock,
    };
    expect(await queueStudentDigest(db, input)).toEqual({ created: true });
    expect(await queueStudentDigest(db, input)).toEqual({ created: false });
    expect(
      await db.notification.count({ where: { userId: f.studentId, kind: 'STUDENT_DIGEST' } }),
    ).toBe(1);
    const mail = await db.emailOutbox.findMany({
      where: { userId: f.studentId, template: 'STUDENT_DIGEST' },
    });
    expect(mail).toHaveLength(1);
    expect(mail[0]?.status).toBe('SUPPRESSED');
    expect(JSON.stringify(mail[0]?.payload)).toContain('/notifications/unsubscribe?token=');
  });
});

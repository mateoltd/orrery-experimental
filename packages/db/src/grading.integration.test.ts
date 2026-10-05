import { randomUUID } from 'node:crypto';
import { FrozenClock } from '@orrery/clock';
import { afterAll, describe, expect, it } from 'vitest';
import type { GradingDb, GradingTx } from './grading-access.js';
import { bulkRelease } from './grading-bulk-release.js';
import { saveFeedback, studentFeedback, teacherFeedback } from './grading-feedback.js';
import { notifyGradingNeeded } from './grading-notifications.js';
import type { GradingAction } from './grading-policy.js';
import { applyRegrade, previewRegrade, type RegradeCalculator } from './grading-regrade.js';
import { bulkGrade } from './grading-write.js';
import { PrismaClient } from './prisma.js';
import { beginRelease, type ReleaseBatchDb } from './release-batch.js';

const db = new PrismaClient();
const clock = new FrozenClock(1_800_000_000_000);
const mine = {
  users: [] as string[],
  rooms: [] as string[],
  resources: [] as string[],
  versions: [] as string[],
  assignments: [] as string[],
  banks: [] as string[],
  questions: [] as string[],
  attempts: [] as string[],
  batches: [] as string[],
  feedback: [] as string[],
};
afterAll(async () => {
  await db.auditEvent.deleteMany({
    where: {
      OR: [
        { targetType: 'Feedback', targetId: { in: mine.feedback } },
        { targetType: 'ReleaseBatch', targetId: { in: mine.batches } },
      ],
    },
  });
  await db.examAttempt.deleteMany({ where: { id: { in: mine.attempts } } });
  await db.releaseBatch.deleteMany({ where: { id: { in: mine.batches } } });
  await db.assignment.deleteMany({ where: { id: { in: mine.assignments } } });
  await db.question.deleteMany({ where: { id: { in: mine.questions } } });
  await db.questionBank.deleteMany({ where: { id: { in: mine.banks } } });
  await db.classroom.deleteMany({ where: { id: { in: mine.rooms } } });
  await db.resourceVersion.deleteMany({ where: { id: { in: mine.versions } } });
  await db.resource.deleteMany({ where: { id: { in: mine.resources } } });
  await db.user.deleteMany({ where: { id: { in: mine.users } } });
  await db.$disconnect();
});
const user = async () => {
  const id = randomUUID();
  await db.user.create({
    data: { id, email: `${id}@p9.example`, emailNormalized: `${id}@p9.example`, name: 'P9' },
  });
  mine.users.push(id);
  return id;
};
async function room() {
  const teacher = await user(),
    second = await user(),
    student = await user();
  const resource = await db.resource.create({
    data: {
      ownerId: teacher,
      title: 'P9',
      slug: randomUUID(),
      status: 'PUBLISHED',
      visibility: 'UNLISTED',
    },
  });
  mine.resources.push(resource.id);
  const version = await db.resourceVersion.create({
    data: {
      resourceId: resource.id,
      version: 1,
      blocks: [],
      blocksChecksum: 'p9',
      meta: {},
      createdById: teacher,
    },
  });
  mine.versions.push(version.id);
  const classroom = await db.classroom.create({
    data: { ownerId: teacher, name: 'P9', slug: randomUUID() },
  });
  mine.rooms.push(classroom.id);
  await db.enrollment.create({
    data: { classroomId: classroom.id, userId: second, role: 'TEACHER', status: 'ACTIVE' },
  });
  const assignment = await db.assignment.create({
    data: {
      classroomId: classroom.id,
      resourceId: resource.id,
      resourceVersionId: version.id,
      createdById: teacher,
      status: 'PUBLISHED',
    },
  });
  mine.assignments.push(assignment.id);
  const bank = await db.questionBank.create({ data: { ownerId: teacher, name: 'P9' } });
  mine.banks.push(bank.id);
  const question = await db.question.create({
    data: { bankId: bank.id, type: 'freeResponse', spec: {}, points: 5 },
  });
  mine.questions.push(question.id);
  return {
    teacher,
    second,
    student,
    classroomId: classroom.id,
    assignmentId: assignment.id,
    questionId: question.id,
  };
}
type Room = Awaited<ReturnType<typeof room>>;
async function paper(r: Room, n = 1, automatic = false) {
  const attempt = await db.examAttempt.create({
    data: {
      assignmentId: r.assignmentId,
      classroomId: r.classroomId,
      studentId: r.student,
      attemptNumber: n,
      status: automatic ? 'GRADED' : 'PENDING_REVIEW',
      ...(automatic ? { finalScore: 20, percentage: 0.2, maxScore: 5 } : {}),
    },
  });
  mine.attempts.push(attempt.id);
  const response = await db.questionResponse.create({
    data: {
      attemptId: attempt.id,
      questionId: r.questionId,
      position: 0,
      answer: { text: 'answer' },
      needsHuman: !automatic,
      ...(automatic
        ? {
            autoScore: 1,
            autoRawScore: 1,
            autoRationale: {},
            autoCorrect: false,
            autoGraderVersion: 'old',
          }
        : {}),
    },
  });
  return { attemptId: attempt.id, responseId: response.id, basedOn: '0' };
}
async function batch(r: Room, ids: string[], released = false) {
  const row = await db.releaseBatch.create({
    data: {
      assignmentId: r.assignmentId,
      classroomId: r.classroomId,
      status: 'DRAFT',
      members: { create: ids.map((attemptId) => ({ attemptId })) },
    },
  });
  mine.batches.push(row.id);
  if (released) {
    await db.releaseBatch.update({ where: { id: row.id }, data: { status: 'READY' } });
    await db.releaseBatch.update({ where: { id: row.id }, data: { status: 'RELEASING' } });
    const result = await bulkRelease(db, {
      batchId: row.id,
      attemptIds: ids,
      actorId: r.teacher,
      reason: 'Review complete',
      clock,
    });
    expect(result.ok).toBe(true);
  }
  return row.id;
}
const calculator: RegradeCalculator = async () => ({
  points: 3,
  rawPoints: 3,
  correct: false,
  needsHuman: false,
  rationale: { corrected: true },
  graderVersion: 'corrected',
});

describe('teacher grading against Postgres', () => {
  it('two teachers saving the same version yield one acknowledgement and one comparison, with the winning value intact', async () => {
    const r = await room(),
      target = await paper(r);
    const results = await Promise.all(
      [2, 4].map((points, i) =>
        bulkGrade(db, {
          actorId: i === 0 ? r.teacher : r.second,
          clock,
          targets: [target],
          action: { kind: 'SCORE', points, feedback: `mark ${points}` },
        }),
      ),
    );
    expect(results.filter((x) => x.ok)).toHaveLength(1);
    const conflict = results.find((x) => !x.ok);
    expect(conflict).toMatchObject({ ok: false, reason: 'CONFLICT', current: { version: '1' } });
    const row = await db.questionResponse.findUniqueOrThrow({ where: { id: target.responseId } });
    expect(String(row.manualScore)).toBe(String(results[0]?.ok ? 2 : 4));
    expect(row.revision).toBe(1);
    expect(
      await db.attemptEventRecord.count({
        where: { attemptId: target.attemptId, type: 'MANUAL_GRADED' },
      }),
    ).toBe(1);
  });
  it.each([
    { kind: 'SCORE', points: 2, feedback: '' },
    {
      kind: 'FEEDBACK',
      body: 'Bulk feedback',
      visibility: 'STUDENT_AFTER_RELEASE',
      isDraft: false,
    },
    { kind: 'EXCUSE', reason: 'Reviewed absence' },
    {
      kind: 'VOID',
      reason: 'Human-reviewed evidence',
      humanConfirmed: true,
      consideredAccessibilityContext: true,
    },
  ] satisfies GradingAction[])(
    'a stale last row rolls back all 204 prior $kind writes in a 205-paper bulk action',
    async (action) => {
      const r = await room();
      const targets = [];
      for (let n = 1; n <= 205; n++) targets.push(await paper(r, n));
      const last = targets[204];
      if (!last) throw new Error('fixture');
      await db.questionResponse.update({ where: { id: last.responseId }, data: { revision: 1 } });
      expect(await bulkGrade(db, { actorId: r.teacher, clock, targets, action })).toMatchObject({
        ok: false,
        reason: 'CONFLICT',
      });
      expect(
        await db.questionResponse.count({
          where: { attemptId: { in: targets.map((t) => t.attemptId) }, manualScore: { not: null } },
        }),
      ).toBe(0);
      expect(
        await db.attemptEventRecord.count({
          where: { attemptId: { in: targets.map((t) => t.attemptId) } },
        }),
      ).toBe(0);
      const ids = targets.map((t) => t.attemptId);
      expect(await db.feedback.count({ where: { attemptId: { in: ids } } })).toBe(0);
      expect(await db.integrityVerdict.count({ where: { attemptId: { in: ids } } })).toBe(0);
      expect(await db.gradeChange.count({ where: { attemptId: { in: ids } } })).toBe(0);
      expect(await db.examAttempt.count({ where: { id: { in: ids }, status: 'VOIDED' } })).toBe(0);
      expect(
        await db.questionResponse.count({ where: { attemptId: { in: ids }, isExcused: true } }),
      ).toBe(0);
    },
  );
  it('two teachers marking different questions on one paper keep both marks and their histories', async () => {
    const r = await room(),
      one = await paper(r);
    const question = await db.question.create({
      data: {
        bankId: mine.banks[mine.banks.length - 1] as string,
        type: 'freeResponse',
        spec: {},
        points: 5,
      },
    });
    mine.questions.push(question.id);
    const response = await db.questionResponse.create({
      data: {
        attemptId: one.attemptId,
        questionId: question.id,
        position: 1,
        answer: {},
        needsHuman: true,
      },
    });
    const results = await Promise.all(
      [one, { ...one, responseId: response.id }].map((target, i) =>
        bulkGrade(db, {
          targets: [target],
          actorId: i === 0 ? r.teacher : r.second,
          clock,
          action: { kind: 'SCORE', points: i + 2, feedback: `Teacher ${i}` },
        }),
      ),
    );
    expect(results.every((result) => result.ok)).toBe(true);
    const marks = await db.questionResponse.findMany({
      where: { attemptId: one.attemptId },
      orderBy: { position: 'asc' },
    });
    expect(marks.map((mark) => Number(mark.manualScore))).toEqual([2, 3]);
    expect(await db.gradeChange.count({ where: { attemptId: one.attemptId } })).toBe(2);
    expect(await db.examAttempt.findUnique({ where: { id: one.attemptId } })).toMatchObject({
      status: 'GRADED',
    });
  });
  it('release waits for an in-flight mark, then computes the acknowledged value', async () => {
    const r = await room(),
      target = await paper(r);
    await bulkGrade(db, {
      actorId: r.teacher,
      clock,
      targets: [target],
      action: { kind: 'SCORE', points: 1, feedback: 'Initial' },
    });
    const batchId = await batch(r, [target.attemptId]);
    await db.releaseBatch.update({ where: { id: batchId }, data: { status: 'READY' } });
    let allowMark: () => void = () => {
      throw new Error('Mark barrier not initialized');
    };
    let markReached: () => void = () => {
      throw new Error('Mark barrier not initialized');
    };
    const wait = new Promise<void>((resolve) => {
      allowMark = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      markReached = resolve;
    });
    const paused = new Proxy(db, {
      get(client, key) {
        if (key !== '$transaction') return Reflect.get(client, key);
        return (fn: (tx: GradingTx) => Promise<unknown>) =>
          client.$transaction(
            (tx) =>
              fn(
                new Proxy(tx, {
                  get(handle, delegate) {
                    if (delegate !== 'questionResponse') return Reflect.get(handle, delegate);
                    return new Proxy(handle.questionResponse, {
                      get(responses, method) {
                        if (method !== 'updateMany') return Reflect.get(responses, method);
                        return async (...args: Parameters<typeof responses.updateMany>) => {
                          const result = await responses.updateMany(...args);
                          markReached();
                          await wait;
                          return result;
                        };
                      },
                    });
                  },
                }),
              ),
            { timeout: 10_000 },
          );
      },
    }) as GradingDb;
    const marking = bulkGrade(paused, {
      actorId: r.second,
      clock,
      targets: [{ ...target, basedOn: '1' }],
      action: { kind: 'SCORE', points: 4, feedback: 'Acknowledged' },
    });
    await reached;
    let releasePid = 0;
    let pidReached: () => void = () => {
      throw new Error('PID barrier not initialized');
    };
    const pidReady = new Promise<void>((resolve) => {
      pidReached = resolve;
    });
    const releaseDb = new Proxy(db, {
      get(client, key) {
        if (key !== '$transaction') return Reflect.get(client, key);
        return (fn: (tx: GradingTx) => Promise<unknown>) =>
          client.$transaction(
            async (tx) => {
              const pid = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
              releasePid = pid[0]?.pid ?? 0;
              pidReached();
              return fn(tx);
            },
            { timeout: 10_000 },
          );
      },
    }) as ReleaseBatchDb;
    let settled = false,
      blocked = false;
    const releasing = beginRelease(releaseDb, { batchId, actorId: r.teacher, clock });
    void releasing.then(() => {
      settled = true;
    });
    await pidReady;
    try {
      // Inspect only this transaction's PID, so another suite's lock cannot make the assertion pass.
      for (let n = 0; n < 100 && !settled; n++) {
        const activity = await db.$queryRaw<
          { waiting: string | null }[]
        >`SELECT wait_event_type AS waiting FROM pg_stat_activity WHERE pid = ${releasePid}`;
        if (activity[0]?.waiting === 'Lock') {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    } finally {
      allowMark();
    }
    const [markResult, releaseResult] = await Promise.all([marking, releasing]);
    expect(blocked).toBe(true);
    expect(markResult.ok).toBe(true);
    expect(releaseResult.ok).toBe(true);
    expect(
      await bulkRelease(db, {
        batchId,
        attemptIds: [target.attemptId],
        actorId: r.teacher,
        reason: 'Reviewed',
        clock,
      }),
    ).toMatchObject({ ok: true });
    expect(
      String(
        (await db.examAttempt.findUniqueOrThrow({ where: { id: target.attemptId } })).finalScore,
      ),
    ).toBe('80');
  });
  it('a bulk comment is not a marking decision: the paper stays in the state the pipeline left it', async () => {
    const r = await room(),
      target = await paper(r);
    // Submitted, and `grade.auto` has not reached it yet.
    await db.examAttempt.update({ where: { id: target.attemptId }, data: { status: 'SUBMITTED' } });
    expect(
      await bulkGrade(db, {
        actorId: r.teacher,
        clock,
        targets: [target],
        action: {
          kind: 'FEEDBACK',
          body: 'See me about question 2',
          visibility: 'TEACHER_ONLY',
          isDraft: false,
        },
      }),
    ).toMatchObject({ ok: true });
    expect(await db.examAttempt.findUnique({ where: { id: target.attemptId } })).toMatchObject({
      status: 'SUBMITTED',
    });
  });
  it('a selected response from another classroom refuses the entire bulk write', async () => {
    const r = await room(),
      other = await room();
    const one = await paper(r),
      two = await paper(other);
    expect(
      await bulkGrade(db, {
        actorId: r.teacher,
        clock,
        targets: [one, two],
        action: { kind: 'EXCUSE', reason: 'Absent' },
      }),
    ).toMatchObject({ ok: false, reason: 'NOT_FOUND' });
    expect(
      await db.questionResponse.count({
        where: { id: { in: [one.responseId, two.responseId] }, isExcused: true },
      }),
    ).toBe(0);
  });
  it('void requires a human reason, discards attempt totals and retains the response and verdict', async () => {
    const r = await room(),
      target = await paper(r, 1, true);
    expect(
      await bulkGrade(db, {
        actorId: r.teacher,
        clock,
        targets: [target],
        action: {
          kind: 'VOID',
          reason: 'Reviewed evidence',
          humanConfirmed: false,
          consideredAccessibilityContext: true,
        },
      }),
    ).toMatchObject({ ok: false, reason: 'HUMAN_VERDICT_REQUIRED' });
    expect(
      await bulkGrade(db, {
        actorId: r.teacher,
        clock,
        targets: [target],
        action: {
          kind: 'VOID',
          reason: 'Reviewed evidence',
          humanConfirmed: true,
          consideredAccessibilityContext: true,
        },
      }),
    ).toMatchObject({ ok: true });
    expect(await db.examAttempt.findUnique({ where: { id: target.attemptId } })).toMatchObject({
      status: 'VOIDED',
      finalScore: null,
      percentage: null,
      maxScore: null,
    });
    expect(
      await db.integrityVerdict.findUnique({ where: { attemptId: target.attemptId } }),
    ).toMatchObject({
      outcome: 'VOIDED',
      decidedById: r.teacher,
      reason: 'Reviewed evidence',
      consideredAccessibilityContext: true,
    });
    expect(await db.questionResponse.count({ where: { id: target.responseId } })).toBe(1);
  });
  it('feedback stays sealed for a DRAFT sibling, hides teacher notes and drafts after release, and belongs to the student', async () => {
    const r = await room(),
      one = await paper(r, 1, true),
      two = await paper(r, 2, true);
    for (const target of [one, two])
      for (const [visibility, isDraft] of [
        ['STUDENT_AFTER_RELEASE', false],
        ['TEACHER_ONLY', false],
        ['STUDENT_AFTER_RELEASE', true],
      ] as const) {
        const result = await saveFeedback(db, {
          attemptId: target.attemptId,
          responseId: null,
          authorId: r.teacher,
          body: 'Feedback',
          visibility,
          isDraft,
          clock,
        });
        if (!result.ok) throw new Error(result.reason);
        mine.feedback.push(result.id);
      }
    // Nothing is released yet: the student reads nothing, on either paper.
    expect(await studentFeedback(db, { attemptId: one.attemptId, studentId: r.student })).toEqual(
      [],
    );
    await batch(r, [one.attemptId], true);
    await batch(r, [two.attemptId]);
    const visible = await studentFeedback(db, { attemptId: one.attemptId, studentId: r.student });
    expect(visible).toHaveLength(1);
    // A comment and where it hangs. A key added here is a key on a student's screen.
    expect(Object.keys(visible[0] ?? {}).sort()).toEqual([
      'body',
      'createdAt',
      'id',
      'responseId',
      'updatedAt',
    ]);
    expect(
      await teacherFeedback(db, { attemptId: one.attemptId, actorId: r.teacher }),
    ).toHaveLength(3);
    expect(await teacherFeedback(db, { attemptId: one.attemptId, actorId: r.second })).toHaveLength(
      2,
    );
    expect(await studentFeedback(db, { attemptId: two.attemptId, studentId: r.student })).toEqual(
      [],
    );
    expect(await studentFeedback(db, { attemptId: one.attemptId, studentId: r.second })).toEqual(
      [],
    );
  });
  it('after release nothing a student can read is added, edited or withdrawn; teacher notes and drafts still save', async () => {
    const r = await room(),
      one = await paper(r, 1, true);
    const input = {
      attemptId: one.attemptId,
      responseId: null,
      authorId: r.teacher,
      body: 'Read this before the resit',
      visibility: 'STUDENT_AFTER_RELEASE' as const,
      isDraft: false,
      clock,
    };
    const shown = await saveFeedback(db, input);
    if (!shown.ok) throw new Error(shown.reason);
    mine.feedback.push(shown.id);
    const batchId = await batch(r, [one.attemptId]);
    await db.releaseBatch.update({ where: { id: batchId }, data: { status: 'READY' } });
    await db.releaseBatch.update({ where: { id: batchId }, data: { status: 'RELEASING' } });
    // Frozen for release: what was reviewed is what is released.
    expect(await saveFeedback(db, { ...input, body: 'Unreviewed' })).toMatchObject({
      ok: false,
      reason: 'RELEASE_IN_PROGRESS',
    });
    expect(
      await bulkRelease(db, {
        batchId,
        attemptIds: [one.attemptId],
        actorId: r.teacher,
        reason: 'Reviewed',
        clock,
      }),
    ).toMatchObject({ ok: true });
    const existing = { id: shown.id, basedOn: shown.version };
    for (const change of [
      { body: 'A new comment' },
      { body: 'Rewritten', existing },
      { isDraft: true, existing },
      { visibility: 'TEACHER_ONLY' as const, existing },
    ])
      expect(await saveFeedback(db, { ...input, ...change })).toMatchObject({
        ok: false,
        reason: 'STUDENT_FEEDBACK_AFTER_RELEASE',
      });
    expect(await studentFeedback(db, { attemptId: one.attemptId, studentId: r.student })).toEqual([
      expect.objectContaining({ id: shown.id, body: 'Read this before the resit' }),
    ]);
    for (const change of [{ visibility: 'TEACHER_ONLY' as const }, { isDraft: true }]) {
      const note = await saveFeedback(db, { ...input, ...change, body: 'Note for the dispute' });
      if (!note.ok) throw new Error(note.reason);
      mine.feedback.push(note.id);
    }
    expect(
      await studentFeedback(db, { attemptId: one.attemptId, studentId: r.student }),
    ).toHaveLength(1);
  });
  it('same-clock feedback edits change the token and refuse stale replacement; a mismatched response cannot be attached', async () => {
    const r = await room(),
      one = await paper(r),
      two = await paper(r, 2);
    const input = {
      attemptId: one.attemptId,
      responseId: one.responseId,
      authorId: r.teacher,
      body: 'First',
      visibility: 'TEACHER_ONLY' as const,
      isDraft: true,
      clock,
    };
    const created = await saveFeedback(db, input);
    if (!created.ok) throw new Error(created.reason);
    mine.feedback.push(created.id);
    const existing = { id: created.id, basedOn: created.version };
    const changed = await saveFeedback(db, { ...input, body: 'Second', existing });
    expect(changed).toMatchObject({ ok: true });
    if (!changed.ok) throw new Error(changed.reason);
    expect(changed.version).not.toBe(created.version);
    expect(await saveFeedback(db, { ...input, body: 'Lost update', existing })).toMatchObject({
      ok: false,
      reason: 'CONFLICT',
      current: { body: 'Second' },
    });
    expect(await saveFeedback(db, { ...input, responseId: two.responseId })).toMatchObject({
      ok: false,
      reason: 'NOT_FOUND',
    });
  });
  it('bulk release refuses a partial selection and a bad member without changing any batch mark', async () => {
    const r = await room(),
      one = await paper(r, 1, true),
      two = await paper(r, 2, true);
    const batchId = await batch(r, [one.attemptId, two.attemptId]);
    await db.releaseBatch.update({ where: { id: batchId }, data: { status: 'READY' } });
    await db.releaseBatch.update({ where: { id: batchId }, data: { status: 'RELEASING' } });
    expect(
      await bulkRelease(db, {
        batchId,
        attemptIds: [one.attemptId],
        actorId: r.teacher,
        reason: 'Reviewed',
        clock,
      }),
    ).toMatchObject({ ok: false, reason: 'SELECTION_DIFFERS_FROM_BATCH' });
    await db.questionResponse.update({ where: { id: two.responseId }, data: { needsHuman: true } });
    expect(
      await bulkRelease(db, {
        batchId,
        attemptIds: [one.attemptId, two.attemptId],
        actorId: r.teacher,
        reason: 'Reviewed',
        clock,
      }),
    ).toMatchObject({ ok: false, reason: 'RELEASE_REFUSED' });
    expect(
      await db.examAttempt.count({
        where: { id: { in: [one.attemptId, two.attemptId] }, releasedAt: { not: null } },
      }),
    ).toBe(0);
    expect(await db.releaseBatch.findUnique({ where: { id: batchId } })).toMatchObject({
      status: 'RELEASING',
    });
  });
  it('dry run writes nothing, previews released deltas; apply audits old/new/who/why/when and notifies every changed student', async () => {
    const r = await room(),
      one = await paper(r, 1, true),
      two = await paper(r, 2, true);
    await batch(r, [one.attemptId, two.attemptId], true);
    const request = {
      assignmentId: r.assignmentId,
      actorId: r.teacher,
      reason: 'Corrected key',
      questionIds: [r.questionId],
    };
    const dry = await previewRegrade(db, request, calculator);
    if (!dry.ok) throw new Error(dry.reason);
    expect(dry.preview).toMatchObject({ affectedCount: 2, alreadyReleasedCount: 2 });
    expect(dry.preview.attempts.map((a) => a.delta)).toEqual([40, 40]);
    expect(
      await db.gradeChange.count({ where: { attemptId: { in: [one.attemptId, two.attemptId] } } }),
    ).toBe(0);
    expect(
      String(
        (await db.questionResponse.findUniqueOrThrow({ where: { id: one.responseId } })).autoScore,
      ),
    ).toBe('1');
    expect(
      await applyRegrade(db, { request, previewToken: dry.preview.token, clock }, calculator),
    ).toMatchObject({ ok: true, appliedCount: 2 });
    const history = await db.gradeChange.findMany({
      where: { attemptId: one.attemptId },
      orderBy: { createdAt: 'asc' },
    });
    expect(history).toHaveLength(2);
    expect(history.find((c) => c.responseId === one.responseId)).toMatchObject({
      actorId: r.teacher,
      reason: 'Corrected key',
      createdAt: new Date(clock.now()),
      before: { points: 1 },
      after: { points: 3 },
    });
    expect(
      await db.notification.count({
        where: {
          userId: r.student,
          kind: 'REGRADE_NOTICE',
          refId: { in: [one, two].map((t) => `${t.attemptId}:${dry.preview.token}`) },
        },
      }),
    ).toBe(2);
    expect(
      await db.examAttempt.count({
        where: {
          id: { in: [one.attemptId, two.attemptId] },
          finalScore: 60,
          regradeNoticePendingAt: new Date(clock.now()),
        },
      }),
    ).toBe(2);
    expect(
      await applyRegrade(db, { request, previewToken: dry.preview.token, clock }, calculator),
    ).toMatchObject({ ok: true, alreadyApplied: true, appliedCount: 2 });
    expect(
      await db.gradeChange.count({ where: { attemptId: { in: [one.attemptId, two.attemptId] } } }),
    ).toBe(4);
    expect(
      await db.notification.count({ where: { userId: r.student, kind: 'REGRADE_NOTICE' } }),
    ).toBe(2);
    expect(
      await applyRegrade(
        db,
        {
          request: { ...request, reason: 'Different reason' },
          previewToken: dry.preview.token,
          clock,
        },
        calculator,
      ),
    ).toMatchObject({ ok: false, reason: 'PREVIEW_STALE' });
  });
  it('a failed notice insert rolls back both released members, their GradeChanges and events', async () => {
    const r = await room(),
      one = await paper(r, 1, true),
      two = await paper(r, 2, true);
    await batch(r, [one.attemptId, two.attemptId], true);
    const request = { assignmentId: r.assignmentId, actorId: r.teacher, reason: 'Corrected key' };
    const dry = await previewRegrade(db, request, calculator);
    if (!dry.ok) throw new Error(dry.reason);
    let notices = 0;
    const failing = {
      $transaction: (fn: (tx: GradingTx) => Promise<unknown>) =>
        db.$transaction((tx) =>
          fn(
            new Proxy(tx, {
              get(target, key) {
                if (key !== 'notification') return Reflect.get(target, key);
                return new Proxy(target.notification, {
                  get(delegate, method) {
                    if (method !== 'create') return Reflect.get(delegate, method);
                    return async (...args: Parameters<typeof delegate.create>) => {
                      if (++notices === 2) throw new Error('Notice insert failed');
                      return delegate.create(...args);
                    };
                  },
                });
              },
            }),
          ),
        ),
    } as GradingDb;
    await expect(
      applyRegrade(failing, { request, previewToken: dry.preview.token, clock }, calculator),
    ).rejects.toThrow('Notice insert failed');
    const ids = [one.attemptId, two.attemptId];
    expect(
      await db.examAttempt.count({
        where: { id: { in: ids }, finalScore: 20, regradeNoticePendingAt: null },
      }),
    ).toBe(2);
    expect(
      await db.questionResponse.count({
        where: { attemptId: { in: ids }, autoScore: 1, revision: 0 },
      }),
    ).toBe(2);
    expect(await db.gradeChange.count({ where: { attemptId: { in: ids } } })).toBe(0);
    expect(
      await db.attemptEventRecord.count({ where: { attemptId: { in: ids }, type: 'REGRADED' } }),
    ).toBe(0);
    expect(
      await db.notification.count({ where: { userId: r.student, kind: 'REGRADE_NOTICE' } }),
    ).toBe(0);
  });
  it('the worker entry point applies a confirmed 500-attempt batch with complete per-attempt history', async () => {
    const r = await room(),
      targets = [];
    for (let n = 1; n <= 500; n++) targets.push(await paper(r, n, true));
    await batch(
      r,
      targets.map((t) => t.attemptId),
      true,
    );
    const request = {
      assignmentId: r.assignmentId,
      actorId: r.teacher,
      reason: 'Reviewed 500-paper correction',
    };
    const dry = await previewRegrade(db, request, calculator);
    if (!dry.ok) throw new Error(dry.reason);
    expect(dry.preview.affectedCount).toBe(500);
    expect(
      await applyRegrade(db, { request, previewToken: dry.preview.token, clock }, calculator),
    ).toMatchObject({ ok: true, appliedCount: 500 });
    const ids = targets.map((t) => t.attemptId);
    expect(await db.gradeChange.count({ where: { attemptId: { in: ids } } })).toBe(1000);
    expect(
      await db.examAttempt.count({
        where: { id: { in: ids }, finalScore: 60, regradeNoticePendingAt: { not: null } },
      }),
    ).toBe(500);
    expect(
      await db.notification.count({ where: { userId: r.student, kind: 'REGRADE_NOTICE' } }),
    ).toBe(500);
  });
  it('a saved mark or different grader output after preview refuses the entire regrade', async () => {
    const r = await room(),
      one = await paper(r, 1, true),
      two = await paper(r, 2, true);
    const request = { assignmentId: r.assignmentId, actorId: r.teacher, reason: 'Corrected key' };
    const dry = await previewRegrade(db, request, calculator);
    if (!dry.ok) throw new Error(dry.reason);
    expect(
      await applyRegrade(db, { request, previewToken: dry.preview.token, clock }, async () => ({
        points: 4,
        rawPoints: 4,
        correct: false,
        needsHuman: false,
        rationale: {},
        graderVersion: 'different',
      })),
    ).toMatchObject({ ok: false, reason: 'PREVIEW_STALE' });
    await db.questionResponse.update({
      where: { id: two.responseId },
      data: { revision: { increment: 1 } },
    });
    expect(
      await applyRegrade(db, { request, previewToken: dry.preview.token, clock }, calculator),
    ).toMatchObject({ ok: false, reason: 'PREVIEW_STALE' });
    expect(
      await db.gradeChange.count({ where: { attemptId: { in: [one.attemptId, two.attemptId] } } }),
    ).toBe(0);
    expect(
      String(
        (await db.questionResponse.findUniqueOrThrow({ where: { id: one.responseId } })).autoScore,
      ),
    ).toBe('1');
  });
  it('invalid grader result or a human referral cannot mutate a released mark', async () => {
    const r = await room(),
      one = await paper(r, 1, true);
    await batch(r, [one.attemptId], true);
    const request = { assignmentId: r.assignmentId, actorId: r.teacher, reason: 'Corrected key' };
    expect(
      await previewRegrade(db, request, async () => ({
        points: NaN,
        rawPoints: 0,
        correct: false,
        needsHuman: false,
        rationale: {},
        graderVersion: 'new',
      })),
    ).toMatchObject({ ok: false, reason: 'INVALID_GRADER_RESULT' });
    expect(
      await previewRegrade(db, request, async () => ({
        points: 0,
        rawPoints: 0,
        correct: false,
        needsHuman: true,
        rationale: {},
        graderVersion: 'new',
      })),
    ).toMatchObject({ ok: false, reason: 'RELEASED_WOULD_BE_PROVISIONAL' });
    expect(
      String((await db.examAttempt.findUniqueOrThrow({ where: { id: one.attemptId } })).finalScore),
    ).toBe('20');
  });
  it('a released total that no longer matches its marks is shown in the dry run, as a two-decimal delta', async () => {
    const r = await room(),
      target = await paper(r, 1, true);
    await db.questionResponse.update({
      where: { id: target.responseId },
      data: { autoScore: 1.01, autoRawScore: 1.01 },
    });
    await batch(r, [target.attemptId], true);
    // What the student was shown, under a late penalty the assignment no longer carries.
    await db.examAttempt.update({
      where: { id: target.attemptId },
      data: { isLate: true, finalScore: 20.1, percentage: 0.202, latePenaltyApplied: 0.005 },
    });
    const request = {
      assignmentId: r.assignmentId,
      actorId: r.teacher,
      reason: 'Removed late penalty',
    };
    const dry = await previewRegrade(db, request, async () => ({
      points: 1.01,
      rawPoints: 1.01,
      correct: false,
      needsHuman: false,
      rationale: {},
      graderVersion: 'old',
    }));
    if (!dry.ok) throw new Error(dry.reason);
    // 20.2 - 20.1 is 0.09999999999999787 in a double. A teacher confirming a regrade reads this number.
    expect(dry.preview.attempts[0]).toMatchObject({ released: true, changes: [], delta: 0.1 });
    expect(dry.preview).toMatchObject({ affectedCount: 1, alreadyReleasedCount: 1 });
  });
  it('an unchanged fractional released result is a no-op rather than another student notice', async () => {
    const r = await room(),
      target = await paper(r, 1, true);
    await db.question.update({ where: { id: r.questionId }, data: { points: 3 } });
    await batch(r, [target.attemptId], true);
    const request = { assignmentId: r.assignmentId, actorId: r.teacher, reason: 'Checked key' };
    const sameCalculator: RegradeCalculator = async () => ({
      points: 1,
      rawPoints: 1,
      correct: false,
      needsHuman: false,
      rationale: {},
      graderVersion: 'old',
    });
    const dry = await previewRegrade(db, request, sameCalculator);
    if (!dry.ok) throw new Error(dry.reason);
    expect(dry.preview.affectedCount).toBe(0);
    expect(dry.preview.alreadyReleasedCount).toBe(0);
  });
  it('a negative raw score is stored as the grader returned it, and the bounded mark is what is totalled', async () => {
    const r = await room(),
      target = await paper(r, 1, true);
    await batch(r, [target.attemptId], true);
    const request = {
      assignmentId: r.assignmentId,
      actorId: r.teacher,
      reason: 'Penalty key corrected',
    };
    const negative: RegradeCalculator = async () => ({
      points: 0,
      rawPoints: -1,
      correct: false,
      needsHuman: false,
      rationale: {},
      graderVersion: 'negative',
    });
    const dry = await previewRegrade(db, request, negative);
    if (!dry.ok) throw new Error(dry.reason);
    expect(dry.preview.attempts[0]?.after.finalScore).toBe(0);
    expect(
      await applyRegrade(db, { request, previewToken: dry.preview.token, clock }, negative),
    ).toMatchObject({ ok: true });
    expect(
      String(
        (await db.questionResponse.findUniqueOrThrow({ where: { id: target.responseId } }))
          .autoRawScore,
      ),
    ).toBe('-1');
    expect(
      String(
        (await db.examAttempt.findUniqueOrThrow({ where: { id: target.attemptId } })).finalScore,
      ),
    ).toBe('0');
  });
  it('a regrade that changes no grader output does not move a released mark on a paper with a negative raw score', async () => {
    const r = await room(),
      target = await paper(r, 1, true);
    const second = await db.question.create({
      data: {
        bankId: mine.banks[mine.banks.length - 1] as string,
        type: 'freeResponse',
        spec: {},
        points: 5,
      },
    });
    mine.questions.push(second.id);
    await db.questionResponse.update({
      where: { id: target.responseId },
      data: { autoScore: 0, autoRawScore: -1 },
    });
    await db.questionResponse.create({
      data: {
        attemptId: target.attemptId,
        questionId: second.id,
        position: 1,
        answer: {},
        autoScore: 5,
        autoRawScore: 5,
        autoRationale: {},
        autoCorrect: true,
        autoGraderVersion: 'old',
      },
    });
    await batch(r, [target.attemptId], true);
    // What the student was shown is `releaseBatch`'s figure. The regrade must start from the same arithmetic.
    expect(
      String(
        (await db.examAttempt.findUniqueOrThrow({ where: { id: target.attemptId } })).finalScore,
      ),
    ).toBe('50');
    const echo: RegradeCalculator = async ({ questionId }) => ({
      points: questionId === second.id ? 5 : 0,
      rawPoints: questionId === second.id ? 5 : -1,
      correct: questionId === second.id,
      needsHuman: false,
      rationale: {},
      graderVersion: 'old',
    });
    const dry = await previewRegrade(
      db,
      { assignmentId: r.assignmentId, actorId: r.teacher, reason: 'Checked key' },
      echo,
    );
    if (!dry.ok) throw new Error(dry.reason);
    expect(dry.preview.attempts[0]?.after.finalScore).toBe(50);
    expect(dry.preview).toMatchObject({ affectedCount: 0, alreadyReleasedCount: 0 });
  });
  it('an unreleased paper with no stored total is affected only when a mark changes, and its delta is computed', async () => {
    const r = await room(),
      target = await paper(r, 1, true);
    // `releaseBatch` is the only writer of attempt totals, so an unreleased paper has none.
    await db.examAttempt.update({
      where: { id: target.attemptId },
      data: { finalScore: null, percentage: null, maxScore: null },
    });
    const request = { assignmentId: r.assignmentId, actorId: r.teacher, reason: 'Checked key' };
    const unchanged = await previewRegrade(db, request, async () => ({
      points: 1,
      rawPoints: 1,
      correct: false,
      needsHuman: false,
      rationale: {},
      graderVersion: 'old',
    }));
    if (!unchanged.ok) throw new Error(unchanged.reason);
    expect(unchanged.preview.affectedCount).toBe(0);
    const changed = await previewRegrade(db, request, calculator);
    if (!changed.ok) throw new Error(changed.reason);
    expect(changed.preview).toMatchObject({ affectedCount: 1, alreadyReleasedCount: 0 });
    expect(changed.preview.attempts[0]).toMatchObject({
      released: false,
      before: { finalScore: 20 },
      delta: 40,
    });
    expect(
      await applyRegrade(db, { request, previewToken: changed.preview.token, clock }, calculator),
    ).toMatchObject({ ok: true, appliedCount: 1 });
    // Nothing was released, so nobody is told and no notice is left pending.
    expect(
      await db.notification.count({ where: { userId: r.student, kind: 'REGRADE_NOTICE' } }),
    ).toBe(0);
    expect(
      (await db.examAttempt.findUniqueOrThrow({ where: { id: target.attemptId } }))
        .regradeNoticePendingAt,
    ).toBeNull();
  });
  it("a notifier between reading a teacher's standing notice and writing one holds out a second, so a later paper is not a second notice", async () => {
    const r = await room(),
      first = await paper(r),
      second = await paper(r, 2);
    await db.reviewTask.create({
      data: { attemptId: first.attemptId, createdAt: new Date(clock.now()) },
    });
    let release: () => void = () => {
      throw new Error('Barrier not initialized');
    };
    let reached: () => void = () => {
      throw new Error('Barrier not initialized');
    };
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queueRead = new Promise<void>((resolve) => {
      reached = resolve;
    });
    // Pause the first notifier AFTER it has read "no standing notice", with its own notice still unwritten.
    const paused = {
      $transaction: (fn: (tx: GradingTx) => Promise<unknown>) =>
        db.$transaction(
          (tx) =>
            fn(
              new Proxy(tx, {
                get(handle, key) {
                  if (key !== 'notification') return Reflect.get(handle, key);
                  return new Proxy(handle.notification, {
                    get(notices, method) {
                      if (method !== 'findFirst') return Reflect.get(notices, method);
                      return async (...args: Parameters<typeof notices.findFirst>) => {
                        const row = await notices.findFirst(...args);
                        reached();
                        await held;
                        return row;
                      };
                    },
                  });
                },
              }),
            ),
          { timeout: 20_000 },
        ),
    } as GradingDb;
    const input = { assignmentId: r.assignmentId, clock, origin: 'https://orrery.example' };
    const slow = notifyGradingNeeded(paused, input);
    await queueRead;
    await db.reviewTask.create({
      data: { attemptId: second.attemptId, createdAt: new Date(clock.now() + 1_000) },
    });
    const fast = notifyGradingNeeded(db, input);
    // Long enough for an unserialised second notifier to commit a notice for the later paper.
    await Promise.race([fast, new Promise((resolve) => setTimeout(resolve, 400))]);
    release();
    await Promise.all([slow, fast]);
    expect(
      await db.notification.count({
        where: { kind: 'GRADING_NEEDED', userId: { in: [r.teacher, r.second] } },
      }),
    ).toBe(2);
  });
  it('grading-needed reaches every active teacher once per wave, needs no teacher to trigger it, and queues no email', async () => {
    const r = await room(),
      first = await paper(r),
      late = await paper(r, 2);
    const input = { assignmentId: r.assignmentId, clock, origin: 'https://orrery.example' };
    const mineOnly = {
      kind: 'GRADING_NEEDED',
      refId: { startsWith: `${r.assignmentId}:` },
      userId: { in: [r.teacher, r.second, r.student] },
    };
    // Nothing is waiting yet, so nothing is said.
    expect(await notifyGradingNeeded(db, input)).toEqual({ ok: true, created: 0 });
    await db.reviewTask.create({
      data: { attemptId: first.attemptId, createdAt: new Date(clock.now()) },
    });
    const both = await Promise.all([
      notifyGradingNeeded(db, input),
      notifyGradingNeeded(db, input),
    ]);
    // Two submissions landing together are one notice each, not two.
    expect(both.map((x) => (x.ok ? x.created : -1)).sort()).toEqual([0, 2]);
    expect(await db.notification.count({ where: mineOnly })).toBe(2);
    expect(await db.notification.count({ where: { ...mineOnly, userId: r.student } })).toBe(0);
    // The owner reads theirs. The co-teacher does not.
    await db.notification.updateMany({
      where: { ...mineOnly, userId: r.teacher },
      data: { readAt: new Date(clock.now()) },
    });
    // Read, and nothing new: silence.
    expect(await notifyGradingNeeded(db, input)).toEqual({ ok: true, created: 0 });
    // A late paper arrives after the notice was read.
    await db.reviewTask.create({
      data: { attemptId: late.attemptId, createdAt: new Date(clock.now() + 60_000) },
    });
    expect(await notifyGradingNeeded(db, input)).toEqual({ ok: true, created: 1 });
    expect(await db.notification.count({ where: { ...mineOnly, userId: r.teacher } })).toBe(2);
    expect(await db.notification.count({ where: { ...mineOnly, userId: r.second } })).toBe(1);
    expect(
      await db.emailOutbox.count({
        where: { toEmail: { in: [`${r.teacher}@p9.example`, `${r.second}@p9.example`] } },
      }),
    ).toBe(0);
  });
});

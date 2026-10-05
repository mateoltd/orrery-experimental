/**
 * "This key looks wrong" against Postgres: the flag moves nothing, and the flag is on record.  (P9-T6)
 *
 * ## WHY MOST OF THIS FILE IS "DIFF EVERYTHING BEFORE AND AFTER"
 *
 * `plans/07` §7 and `INV-RELEASE-1` between them say a published figure never moves without a regrade, a reason and a
 * notice. A unit test can only assert that `flagAutoGradeKey` returns something; it cannot assert that the flag did not
 * touch a mark. So the central test here snapshots every response, every attempt and every release batch, raises a
 * flag, and compares the snapshots field by field -- including the ones a careless implementation would move.
 */

import { randomUUID } from 'node:crypto';
import { FrozenClock } from '@orrery/clock';
import { afterAll, describe, expect, it } from 'vitest';
import { bulkRelease } from './grading-bulk-release.js';
import { previewRegrade, type RegradeCalculator } from './grading-regrade.js';
import { blastRadius, keyFlagIdentity } from './grading-review.js';
import {
  flagAutoGradeKey,
  readAutoGradeKeyFlags,
  readAutoGradeReviewTargets,
  readKeyPopulation,
  resolveAutoGradeKeyFlag,
} from './grading-review-flag.js';
import { bulkGrade } from './grading-write.js';
import { PrismaClient } from './prisma.js';

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
  audits: [] as string[],
};
afterAll(async () => {
  // The audit rows first: they carry no foreign key, but deleting a classroom cascades attempts and their events, and
  // a leftover row pointing at a deleted actor would fail the NEXT suite's unique constraints rather than this one's.
  // `targetType` alone, scoped by action: the flag rows have no foreign key to cascade, and a `targetId` predicate
  // here has to guess a separator -- which is the same guess that produced the NUL bug.
  await db.auditEvent.deleteMany({
    where: {
      targetType: 'AssignmentQuestionKey',
      action: {
        in: ['AUTO_GRADE_KEY_FLAGGED', 'AUTO_GRADE_KEY_UPHELD', 'AUTO_GRADE_KEY_DISMISSED'],
      },
    },
  });
  await db.auditEvent.deleteMany({
    where: { action: 'SIM_REPLAY_OVERRIDE', targetType: 'QuestionResponse' },
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

const user = async (role: 'TEACHER' | 'STUDENT' | 'OUTSIDER') => {
  const id = randomUUID();
  await db.user.create({
    data: { id, email: `${id}@p9.example`, emailNormalized: `${id}@p9.example`, name: role },
  });
  mine.users.push(id);
  return id;
};

async function room() {
  const teacher = await user('TEACHER');
  const second = await user('TEACHER');
  const student = await user('STUDENT');
  const outsider = await user('OUTSIDER');
  const resource = await db.resource.create({
    data: {
      ownerId: teacher,
      title: 'P9-T6',
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
      blocksChecksum: 'p9-t6',
      meta: {},
      createdById: teacher,
    },
  });
  mine.versions.push(version.id);
  const classroom = await db.classroom.create({
    data: { ownerId: teacher, name: 'P9-T6', slug: randomUUID() },
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
  const bank = await db.questionBank.create({ data: { ownerId: teacher, name: 'P9-T6' } });
  mine.banks.push(bank.id);
  const question = await db.question.create({
    data: { bankId: bank.id, type: 'singleChoice', spec: { key: { choiceId: 'b' } }, points: 5 },
  });
  mine.questions.push(question.id);
  return {
    teacher,
    second,
    student,
    outsider,
    classroomId: classroom.id,
    assignmentId: assignment.id,
    questionId: question.id,
  };
}
type Room = Awaited<ReturnType<typeof room>>;

type ResponseShape = 'SEALED' | 'AWAITING_HUMAN' | 'MANUAL' | 'EXCUSED' | 'UNGRADED';

async function response(r: Room, shape: ResponseShape, attemptNumber = 1, studentId = r.student) {
  const attempt = await db.examAttempt.create({
    data: {
      assignmentId: r.assignmentId,
      classroomId: r.classroomId,
      studentId,
      attemptNumber,
      status: 'GRADED',
      finalScore: 1,
      percentage: 0.2,
      maxScore: 5,
    },
  });
  mine.attempts.push(attempt.id);
  const row = await db.questionResponse.create({
    data: {
      attemptId: attempt.id,
      questionId: r.questionId,
      position: 0,
      answer: { choiceId: 'a' },
      ...(shape === 'SEALED'
        ? {
            autoScore: 1,
            autoRawScore: 1,
            autoRationale: { why: 'option a is not the key' },
            autoCorrect: false,
            autoGraderVersion: 'auto-1',
            needsHuman: false,
          }
        : {}),
      ...(shape === 'AWAITING_HUMAN' ? { needsHuman: true, autoGraderVersion: 'auto-1' } : {}),
      ...(shape === 'MANUAL'
        ? { autoScore: 0, manualScore: 2, graderId: r.teacher, needsHuman: false }
        : {}),
      ...(shape === 'EXCUSED' ? { autoScore: 1, isExcused: true, needsHuman: false } : {}),
    },
  });
  return { attemptId: attempt.id, responseId: row.id, revision: row.revision };
}

/**
 * RELEASE THROUGH `bulkRelease`, NOT BY UPDATING THE ROW.
 *
 * The first version set `status = 'RELEASED'` directly and Postgres refused it:
 * `23514: RELEASE_BATCH_ILLEGAL_TRANSITION: READY -> RELEASED is not a transition`. The state machine is TRIGGERS
 * (`migrations/20261004000000_0014_release_batch_state_machine`), so the only way to release a paper is through the
 * committed transaction -- which is the right thing for a test about release safety to be doing anyway, since a fixture
 * that released by hand would be releasing through a path that does not exist in production.
 */
async function release(r: Room, attemptIds: readonly string[]) {
  const row = await db.releaseBatch.create({
    data: {
      assignmentId: r.assignmentId,
      classroomId: r.classroomId,
      status: 'DRAFT',
      members: { create: attemptIds.map((attemptId) => ({ attemptId })) },
    },
  });
  mine.batches.push(row.id);
  await db.releaseBatch.update({ where: { id: row.id }, data: { status: 'READY' } });
  await db.releaseBatch.update({ where: { id: row.id }, data: { status: 'RELEASING' } });
  const result = await bulkRelease(db, {
    batchId: row.id,
    attemptIds,
    actorId: r.teacher,
    reason: 'Review complete',
    clock,
  });
  if (!result.ok) throw new Error(`release refused: ${result.reason}`);
  return row.id;
}

/** EVERYTHING A MARK LIVES ON, in one comparable shape. A field missing here is a field a flag could move unobserved. */
const marksSnapshot = async (r: Room) => ({
  responses: await db.questionResponse.findMany({
    where: { attempt: { assignmentId: r.assignmentId } },
    orderBy: { id: 'asc' },
    select: {
      id: true,
      revision: true,
      autoScore: true,
      autoRawScore: true,
      autoCorrect: true,
      autoGraderVersion: true,
      autoGradedAt: true,
      manualScore: true,
      manualFeedback: true,
      needsHuman: true,
      isExcused: true,
      graderId: true,
      gradedAt: true,
      updatedAt: true,
    },
  }),
  attempts: await db.examAttempt.findMany({
    where: { assignmentId: r.assignmentId },
    orderBy: { id: 'asc' },
    select: {
      id: true,
      status: true,
      finalScore: true,
      percentage: true,
      maxScore: true,
      autoScore: true,
      manualScore: true,
      regradeNoticePendingAt: true,
      updatedAt: true,
    },
  }),
  batches: await db.releaseBatch.findMany({
    where: { assignmentId: r.assignmentId },
    orderBy: { id: 'asc' },
    select: { id: true, status: true, releasedAt: true, updatedAt: true },
  }),
  gradeChanges: await db.gradeChange.count({
    where: { attempt: { assignmentId: r.assignmentId } },
  }),
  events: await db.attemptEventRecord.count({
    where: { attempt: { assignmentId: r.assignmentId } },
  }),
  notifications: await db.notification.count({
    where: { userId: r.student, kind: 'REGRADE_NOTICE' },
  }),
  reviewTasks: await db.reviewTask.findMany({
    where: { attempt: { assignmentId: r.assignmentId } },
    orderBy: { attemptId: 'asc' },
    select: { attemptId: true, status: true },
  }),
});

/** Flags raised against THIS room's key. Scoped, because the audit log is shared across every feature. */
const raisedFor = (r: Room) =>
  db.auditEvent.count({
    where: {
      action: 'AUTO_GRADE_KEY_FLAGGED',
      targetId: keyFlagIdentity(r.assignmentId, r.questionId),
    },
  });

const calculator =
  (points: number, version: string): RegradeCalculator =>
  async () => ({
    points,
    rawPoints: points,
    correct: false,
    needsHuman: false,
    rationale: { recomputed: version },
    graderVersion: version,
  });

describe('raising "this key looks wrong" changes no mark, which is INV-RELEASE-1 on this path', () => {
  /**
   * THE TEST THE WHOLE FEATURE EXISTS FOR.
   *
   * A flag that moved a mark would still pass every other test here: it returns a record, it is on file, and it appears
   * in the review queue. So this diffs EVERY table a mark lives in -- response marks and revisions, attempt totals and
   * status, release batch state, `GradeChange` rows, attempt events, review tasks, and student notices -- before and after
   * the flag. On a RELEASED paper, because that is the case where a moved mark is unrecoverable.
   */
  it('leaves a released paper byte-identical, and records the flag with its reason and its question', async () => {
    const r = await room();
    const sealed = await response(r, 'SEALED');
    await release(r, [sealed.attemptId]);

    const before = await marksSnapshot(r);
    const raised = await flagAutoGradeKey(db, {
      actorId: r.teacher,
      clock,
      assignmentId: r.assignmentId,
      responseId: sealed.responseId,
      reason: 'The key names an option that is not in this question.',
    });
    expect(raised.ok).toBe(true);
    const after = await marksSnapshot(r);
    expect(after).toEqual(before);

    // The record names the QUESTION and the MARKER and carries the reason verbatim, which is the three things a reviewer
    // needs and the two things `copy.ts`'s FLAG_LABEL alone would not give them.
    const row = await db.auditEvent.findFirstOrThrow({
      where: { action: 'AUTO_GRADE_KEY_FLAGGED' },
      orderBy: { id: 'desc' },
    });
    expect(row.actorId).toBe(r.teacher);
    expect(row.targetType).toBe('AssignmentQuestionKey');
    expect(row.targetId).toBe(keyFlagIdentity(r.assignmentId, r.questionId));
    expect(row.meta).toMatchObject({
      assignmentId: r.assignmentId,
      questionId: r.questionId,
      responseId: sealed.responseId,
      reason: 'The key names an option that is not in this question.',
    });
  });

  it('moves nothing on an UNRELEASED paper either, which is the case a careless writer would treat differently', async () => {
    // The claim "a released result is protected, an unreleased one is the marker\'s business" is how a sealed auto-grade
    // ends up editable by accident: the check is written for the released case because that is the case that was
    // reported.
    const r = await room();
    const sealed = await response(r, 'SEALED');
    const before = await marksSnapshot(r);
    await flagAutoGradeKey(db, {
      actorId: r.teacher,
      clock,
      assignmentId: r.assignmentId,
      responseId: sealed.responseId,
      reason: 'The keyed option was removed from this question in revision 4.',
    });
    expect(await marksSnapshot(r)).toEqual(before);
  });

  it('refuses a second open flag from the same reporter, and permits a SECOND marker to raise one', async () => {
    // Two markers independently believing the same thing is evidence, not duplication: the dedupe is per reporter so the
    // queue does not fill with one person's opinion and so a reviewer's response to it is answerable.
    const r = await room();
    const sealed = await response(r, 'SEALED');
    const reason = 'The keyed option is not offered to students.';
    expect(
      (
        await flagAutoGradeKey(db, {
          actorId: r.teacher,
          clock,
          assignmentId: r.assignmentId,
          responseId: sealed.responseId,
          reason,
        })
      ).ok,
    ).toBe(true);
    expect(
      await flagAutoGradeKey(db, {
        actorId: r.teacher,
        clock,
        assignmentId: r.assignmentId,
        responseId: sealed.responseId,
        reason,
      }),
    ).toMatchObject({ ok: false, reason: 'ALREADY_FLAGGED' });
    expect(
      (
        await flagAutoGradeKey(db, {
          actorId: r.second,
          clock,
          assignmentId: r.assignmentId,
          responseId: sealed.responseId,
          reason,
        })
      ).ok,
    ).toBe(true);
    const flags = await readAutoGradeKeyFlags(db, {
      actorId: r.teacher,
      assignmentId: r.assignmentId,
      questionId: r.questionId,
    });
    expect(flags).toHaveLength(2);
    expect(flags.every((flag) => flag.resolution === null)).toBe(true);
  });

  it('refuses an empty reason BEFORE touching the log, so a reason-less flag cannot exist', async () => {
    const r = await room();
    const sealed = await response(r, 'SEALED');
    expect(
      await flagAutoGradeKey(db, {
        actorId: r.teacher,
        clock,
        assignmentId: r.assignmentId,
        responseId: sealed.responseId,
        reason: '   ',
      }),
    ).toMatchObject({ ok: false, reason: 'REASON_REQUIRED' });
    // Scoped to THIS key, not counted globally: the log is shared, and a global count would make this test depend on
    // which other tests ran first -- which is how a test suite starts failing only in CI.
    expect(await raisedFor(r)).toBe(0);
  });

  it('refuses a row that is not a sealed auto-grade, and says which case it is', async () => {
    const r = await room();
    const awaiting = await response(r, 'AWAITING_HUMAN', 1);
    const manual = await response(r, 'MANUAL', 2);
    const excused = await response(r, 'EXCUSED', 3);
    for (const target of [awaiting, manual, excused]) {
      const result = await flagAutoGradeKey(db, {
        actorId: r.teacher,
        clock,
        assignmentId: r.assignmentId,
        responseId: target.responseId,
        reason: 'This key looks wrong.',
      });
      expect(result.ok).toBe(false);
    }
    // And the `awaitingHuman` flag is on the refusal, so the screen can route the row to a marker rather than to a regrade.
    const onAwaiting = await flagAutoGradeKey(db, {
      actorId: r.teacher,
      clock,
      assignmentId: r.assignmentId,
      responseId: awaiting.responseId,
      reason: 'This key looks wrong.',
    });
    expect(onAwaiting).toMatchObject({ ok: false, awaitingHuman: true });
  });

  /**
   * THE CONFORMANCE THAT CANNOT BE DONE IN A UNIT TEST.
   *
   * `isSealedAutomatic` is re-derived in `grading-review.ts` because `grading-policy.ts` is committed. The agreement is
   * proved HERE, against the real `bulkGrade`: one call raises the flag and the other tries a hand mark on the SAME row,
   * and one is accepted while the other is refused. `grading-review.test.ts` explains why the unit suite cannot do this.
   */
  it('raises a flag on exactly the rows `bulkGrade` refuses to hand-mark as SEALED_AUTOMATIC', async () => {
    const r = await room();
    const sealed = await response(r, 'SEALED');
    const flagged = await flagAutoGradeKey(db, {
      actorId: r.teacher,
      clock,
      assignmentId: r.assignmentId,
      responseId: sealed.responseId,
      reason: 'The keyed option is not offered to students.',
    });
    expect(flagged.ok).toBe(true);
    const marked = await bulkGrade(db, {
      actorId: r.teacher,
      clock,
      targets: [{ attemptId: sealed.attemptId, responseId: sealed.responseId, basedOn: '0' }],
      action: { kind: 'SCORE', points: 4, feedback: 'by hand' },
    });
    expect(marked).toMatchObject({ ok: false, reason: 'SEALED_AUTOMATIC' });
  });

  it('refuses a teacher from another classroom, and records nothing', async () => {
    const r = await room();
    const sealed = await response(r, 'SEALED');
    expect(
      await flagAutoGradeKey(db, {
        actorId: r.outsider,
        clock,
        assignmentId: r.assignmentId,
        responseId: sealed.responseId,
        reason: 'This key looks wrong.',
      }),
    ).toMatchObject({ ok: false, reason: 'NOT_FOUND' });
    expect(await raisedFor(r)).toBe(0);
  });

  it('refuses a response belonging to a DIFFERENT assignment, under the right teacher', async () => {
    // `responseId` is what identifies the question, so a mismatched pair is the shape of a client bug that would file a
    // flag about one key on the record of another assignment.
    const r = await room();
    const other = await room();
    const sealed = await response(r, 'SEALED');
    expect(
      await flagAutoGradeKey(db, {
        actorId: other.teacher,
        clock,
        assignmentId: other.assignmentId,
        responseId: sealed.responseId,
        reason: 'This key looks wrong.',
      }),
    ).toMatchObject({ ok: false, reason: 'NOT_FOUND' });
  });
});

describe('a reviewer upholds or dismisses a flag, and neither erases it', () => {
  it('records the note, keeps both reasons together, and closes only the raising', async () => {
    const r = await room();
    const sealed = await response(r, 'SEALED');
    await flagAutoGradeKey(db, {
      actorId: r.teacher,
      clock,
      assignmentId: r.assignmentId,
      responseId: sealed.responseId,
      reason: 'The keyed option is not offered to students.',
    });
    const resolved = await resolveAutoGradeKeyFlag(db, {
      actorId: r.second,
      clock,
      assignmentId: r.assignmentId,
      questionId: r.questionId,
      resolution: 'UPHELD',
      note: 'Confirmed against revision 4 of the resource. Fixing the key and regrading.',
    });
    expect(resolved.ok).toBe(true);
    const flags = await readAutoGradeKeyFlags(db, {
      actorId: r.second,
      assignmentId: r.assignmentId,
      questionId: r.questionId,
    });
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({
      resolution: 'UPHELD',
      resolvedById: r.second,
      reason: 'The keyed option is not offered to students.',
    });
    // The reviewer's reasoning is on the same key, addressable, because the next marker to flag it will be shown that it
    // was already checked.
    const rows = await db.auditEvent.findMany({
      where: {
        targetType: 'AssignmentQuestionKey',
        targetId: keyFlagIdentity(r.assignmentId, r.questionId),
      },
      orderBy: { id: 'asc' },
    });
    expect(rows.map((row) => row.action)).toEqual([
      'AUTO_GRADE_KEY_FLAGGED',
      'AUTO_GRADE_KEY_UPHELD',
    ]);
    expect(rows[1]?.meta).toMatchObject({ addressedRaisedById: r.teacher, resolution: 'UPHELD' });
  });

  it('refuses a marker resolving their OWN flag, which is the quiet override in another costume', async () => {
    const r = await room();
    const sealed = await response(r, 'SEALED');
    await flagAutoGradeKey(db, {
      actorId: r.teacher,
      clock,
      assignmentId: r.assignmentId,
      responseId: sealed.responseId,
      reason: 'The keyed option is not offered to students.',
    });
    expect(
      await resolveAutoGradeKeyFlag(db, {
        actorId: r.teacher,
        clock,
        assignmentId: r.assignmentId,
        questionId: r.questionId,
        resolution: 'DISMISSED',
        note: 'On reflection the key is fine.',
      }),
    ).toMatchObject({ ok: false, reason: 'NOT_OPEN' });
  });

  it('refuses a resolution with no note, because a resolution with no reasoning is a shrug', async () => {
    const r = await room();
    const sealed = await response(r, 'SEALED');
    await flagAutoGradeKey(db, {
      actorId: r.teacher,
      clock,
      assignmentId: r.assignmentId,
      responseId: sealed.responseId,
      reason: 'The keyed option is not offered to students.',
    });
    expect(
      await resolveAutoGradeKeyFlag(db, {
        actorId: r.second,
        clock,
        assignmentId: r.assignmentId,
        questionId: r.questionId,
        resolution: 'UPHELD',
        note: '  ',
      }),
    ).toMatchObject({ ok: false, reason: 'REASON_REQUIRED' });
    expect(
      await db.auditEvent.count({
        where: {
          action: 'AUTO_GRADE_KEY_UPHELD',
          targetId: keyFlagIdentity(r.assignmentId, r.questionId),
        },
      }),
    ).toBe(0);
  });

  it('shows an upheld flag as closed, and a second raising as open', async () => {
    // The history a reviewer reads months later: "dismissed, raised again, upheld" is two raisings and one of them
    // still waiting, and a `status` column on a flag row could not express it.
    const r = await room();
    const sealed = await response(r, 'SEALED');
    const flag = () =>
      flagAutoGradeKey(db, {
        actorId: r.teacher,
        clock,
        assignmentId: r.assignmentId,
        responseId: sealed.responseId,
        reason: 'The keyed option is not offered to students.',
      });
    await flag();
    await resolveAutoGradeKeyFlag(db, {
      actorId: r.second,
      clock,
      assignmentId: r.assignmentId,
      questionId: r.questionId,
      resolution: 'DISMISSED',
      note: 'Checked against the resource: the option is offered.',
    });
    // The same reporter may raise again once the previous one is closed.
    expect((await flag()).ok).toBe(true);
    await resolveAutoGradeKeyFlag(db, {
      actorId: r.second,
      clock,
      assignmentId: r.assignmentId,
      questionId: r.questionId,
      resolution: 'UPHELD',
      note: 'Checked again after revision 5: it is gone.',
    });
    const flags = await readAutoGradeKeyFlags(db, {
      actorId: r.second,
      assignmentId: r.assignmentId,
      questionId: r.questionId,
    });
    expect(flags.map((f) => f.resolution)).toEqual(['DISMISSED', 'UPHELD']);
    expect(flags.filter((f) => f.resolution === null)).toHaveLength(0);
  });
});

describe('the review list and the population count what is actually under the key', () => {
  it('lists only sealed rows, and carries no mark on the list', async () => {
    const r = await room();
    const sealed = await response(r, 'SEALED');
    await response(r, 'SEALED', 2);
    await response(r, 'AWAITING_HUMAN', 3);
    await response(r, 'MANUAL', 4);
    await response(r, 'EXCUSED', 5);
    const targets = await readAutoGradeReviewTargets(db, {
      actorId: r.teacher,
      assignmentId: r.assignmentId,
      questionId: r.questionId,
    });
    // Two sealed rows and nothing else: the awaiting-human row, the hand-marked one, the excused one and the
    // never-graded one are all excluded, and `sealed` is one of the two that are included.
    expect(targets).toHaveLength(2);
    expect(targets.map((t) => t.responseId)).toContain(sealed.responseId);
    for (const target of targets) expect(target).not.toHaveProperty('points');
    expect(targets[0]?.worth).toBe(5);
  });

  it('marks a released row as released on the target, so the screen can say what is already public', async () => {
    const r = await room();
    const held = await response(r, 'SEALED');
    const out = await response(r, 'SEALED', 2);
    await release(r, [out.attemptId]);
    const targets = await readAutoGradeReviewTargets(db, {
      actorId: r.teacher,
      assignmentId: r.assignmentId,
      questionId: r.questionId,
    });
    const byId = new Map(targets.map((target) => [target.responseId, target]));
    expect(byId.get(held.responseId)?.released).toBe(false);
    expect(byId.get(out.responseId)?.released).toBe(true);
  });

  it('partitions the population into the five categories a regrade treats differently', async () => {
    const r = await room();
    await response(r, 'SEALED');
    await response(r, 'SEALED', 2);
    await response(r, 'AWAITING_HUMAN', 3);
    await response(r, 'MANUAL', 4);
    await response(r, 'EXCUSED', 5);
    await response(r, 'UNGRADED', 6);
    const population = await readKeyPopulation(db, {
      actorId: r.teacher,
      assignmentId: r.assignmentId,
      questionId: r.questionId,
    });
    expect(population).toMatchObject({
      responses: 6,
      sealedAutomatic: 2,
      awaitingHuman: 1,
      notAutomaticallyGraded: 1,
      preservedByManualMark: 1,
      preservedAsExcused: 1,
    });
    expect(
      population.sealedAutomatic +
        population.awaitingHuman +
        population.notAutomaticallyGraded +
        population.preservedByManualMark +
        population.preservedAsExcused,
    ).toBe(population.responses);
  });

  it("gives another classroom an empty population rather than another classroom's count", async () => {
    const r = await room();
    const other = await room();
    await response(r, 'SEALED');
    expect(
      await readKeyPopulation(db, {
        actorId: other.teacher,
        assignmentId: r.assignmentId,
        questionId: r.questionId,
      }),
    ).toMatchObject({ responses: 0 });
    expect(
      await readAutoGradeReviewTargets(db, {
        actorId: other.teacher,
        assignmentId: r.assignmentId,
        questionId: r.questionId,
      }),
    ).toEqual([]);
  });
});

describe("the blast radius is the regrade preview's own arithmetic, and it says what a key change would move", () => {
  /**
   * THE END-TO-END ARGUMENT, AND THE ONLY PLACE THE TWO HALVES MEET.
   *
   * The unit tests cover `blastRadius` over a fixture preview. This covers the real thing: the numbers on the review
   * screen and the numbers the confirmed regrade applies are produced by the SAME `previewRegrade` call, so they cannot
   * disagree. A review surface that computed its own estimate and then handed a token for somebody else's arithmetic
   * would be a review surface that lies with a count in it.
   */
  it('counts every paper under the key, splits released from withheld, and keeps the preserved ones out of it', async () => {
    const r = await room();
    await response(r, 'SEALED');
    await response(r, 'SEALED', 2);
    const out = await response(r, 'SEALED', 3);
    await release(r, [out.attemptId]);
    const manual = await response(r, 'MANUAL', 4);

    const request = {
      assignmentId: r.assignmentId,
      actorId: r.teacher,
      reason: 'The keyed option is not offered to students.',
      questionIds: [r.questionId],
    };
    const dryRun = await previewRegrade(db, request, calculator(4, 'fixed'));
    expect(dryRun.ok).toBe(true);
    if (!dryRun.ok) return;
    const population = await readKeyPopulation(db, {
      actorId: r.teacher,
      assignmentId: r.assignmentId,
      questionId: r.questionId,
    });
    const radius = blastRadius(dryRun.preview, population);
    expect(radius).not.toBeNull();
    expect(radius).toMatchObject({
      responses: 4,
      sealedAutomatic: 3,
      preservedByManualMark: 1,
      // THREE, and the fourth paper is not in either count.
      attemptsRewriting: 3,
      affectedAttempts: 3,
      rewrittenButUnchanged: 0,
      alreadyReleased: 1,
      gained: 3,
      lost: 0,
    });
    // A HAND-MARKED PAPER IS NOT RECOMPUTED AT ALL, which is a stronger statement than "its total survives".
    // `grading-regrade.ts:237-241` gates the calculator on `manualScore === null && !isExcused`, so the hand-marked
    // response is never handed to the grader and its stored automatic figure is left exactly as it was. It appears in
    // `responses` (it is under this key) and in `preservedByManualMark` (a regrade will not touch it) and in NEITHER
    // mover count -- and that is the number a marker needs, because a paper whose automatic figure still reads the OLD
    // key's output is not a paper whose mark is wrong.
    const preserved = dryRun.preview.attempts.find(
      (attempt) => attempt.attemptId === manual.attemptId,
    );
    expect(preserved?.changes).toEqual([]);
    expect(preserved?.delta).toBe(0);
    expect(
      dryRun.preview.attempts.some(
        (attempt) => attempt.attemptId === manual.attemptId && attempt.changes.length > 0,
      ),
    ).toBe(false);
    // The three sealed papers are in BOTH counts, so the two agree here -- and the unit suite pins the case where they
    // do not, which is a regrade that rewrites a figure and lands on the same number.
    expect(radius?.affectedAttempts).toBeLessThanOrEqual(radius?.sealedAutomatic ?? 0);
    expect(radius?.attemptsRewriting).toBe(radius?.affectedAttempts);
    expect(radius?.alreadyReleased).toBe(1);
    expect(radius?.preservedByManualMark).toBe(1);
    // And the preview's own count agrees with the radius's, because they are the same function's output.
    expect(radius?.attemptsRewriting).toBe(
      dryRun.preview.attempts.filter((attempt) => attempt.changes.length > 0).length,
    );
  });

  it('reports zero affected when a changed key produces the same marks, and does not call that a change', async () => {
    // The hard-won invariant in `grading-regrade.ts:266-270`, seen from the review side: a key change that changes
    // nothing must read as a no-op, or every regrade confirmation says "N papers affected" for a regrade that moves none.
    //
    // THE CALCULATOR MUST REPRODUCE THE STORED ROW EXACTLY, and that is a finding rather than a detail of the fixture.
    // `grading-regrade.ts:255` compares the WHOLE stored figure -- points, raw points, correct, needsHuman, the RATIONALE
    // and the grader version -- so a calculator returning the same number with a different rationale reports a change,
    // and a screen counting it says the student's mark moved when their mark did not. `attemptsRewriting` is the honest
    // name for that case and `affectedAttempts` is the number a marker acts on.
    const r = await room();
    const untouched: RegradeCalculator = async () => ({
      points: 1,
      rawPoints: 1,
      correct: false,
      needsHuman: false,
      rationale: { why: 'option a is not the key' },
      graderVersion: 'auto-1',
    });
    await response(r, 'SEALED');
    const dryRun = await previewRegrade(
      db,
      {
        assignmentId: r.assignmentId,
        actorId: r.teacher,
        reason: 'Re-checking the key.',
        questionIds: [r.questionId],
      },
      untouched,
    );
    expect(dryRun.ok).toBe(true);
    if (!dryRun.ok) return;
    expect(dryRun.preview.affectedCount).toBe(0);
    const population = await readKeyPopulation(db, {
      actorId: r.teacher,
      assignmentId: r.assignmentId,
      questionId: r.questionId,
    });
    const radius = blastRadius(dryRun.preview, population);
    // `attemptsRewriting` may be non-zero: the stored figure was recomputed and came out the same. `affectedAttempts`
    // is the number the marker acts on, and it is zero.
    expect(radius?.affectedAttempts).toBe(0);
    expect(radius?.gained).toBe(0);
    expect(radius?.lost).toBe(0);
    expect(radius?.alreadyReleased).toBe(0);
  });

  it('refuses a population for a question the preview was not scoped to', async () => {
    const r = await room();
    await response(r, 'SEALED');
    const unscoped = await previewRegrade(
      db,
      { assignmentId: r.assignmentId, actorId: r.teacher, reason: 'Everything on the paper.' },
      calculator(4, 'fixed'),
    );
    expect(unscoped.ok).toBe(true);
    if (!unscoped.ok) return;
    const population = await readKeyPopulation(db, {
      actorId: r.teacher,
      assignmentId: r.assignmentId,
      questionId: r.questionId,
    });
    expect(blastRadius(unscoped.preview, population)).toBeNull();
  });

  it('counts a paper the regrade would leave PROVISIONAL, rather than calling it unchanged', async () => {
    // A regrade that resolves a `needsHuman` row can make a paper provisional. Counting that as "unchanged" would tell
    // a marker nothing will happen on a paper whose stored result just became unusable.
    const r = await room();
    await response(r, 'AWAITING_HUMAN');
    const needsHuman: RegradeCalculator = async () => ({
      points: 0,
      rawPoints: 0,
      correct: false,
      needsHuman: true,
      rationale: { why: 'the grader could not read the state' },
      graderVersion: 'same',
    });
    const dryRun = await previewRegrade(
      db,
      {
        assignmentId: r.assignmentId,
        actorId: r.teacher,
        reason: 'Re-checking the key.',
        questionIds: [r.questionId],
      },
      needsHuman,
    );
    expect(dryRun.ok).toBe(true);
    if (!dryRun.ok) return;
    const population = await readKeyPopulation(db, {
      actorId: r.teacher,
      assignmentId: r.assignmentId,
      questionId: r.questionId,
    });
    const radius = blastRadius(dryRun.preview, population);
    expect(radius?.wouldBecomeProvisional).toBe(1);
  });
});

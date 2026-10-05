import { assertNoScoreLeak } from '@orrery/interop';
import {
  type GradingClock,
  type GradingDb,
  lockAttemptForMarking,
  teacherAttempt,
} from './grading-access.js';
import { decideFeedbackWrite } from './grading-policy.js';

export interface FeedbackInput {
  attemptId: string;
  responseId: string | null;
  authorId: string;
  body: string;
  visibility: 'TEACHER_ONLY' | 'STUDENT_AFTER_RELEASE';
  isDraft: boolean;
  clock: GradingClock;
  existing?: { id: string; basedOn: string };
}

/** Authors edit only their own comment. Other teachers can append without replacing it. */
export async function saveFeedback(db: GradingDb, input: FeedbackInput) {
  return db.$transaction(async (tx) => {
    const attempt = await tx.examAttempt.findFirst({
      where: { id: input.attemptId, ...teacherAttempt(input.authorId) },
      select: { id: true },
    });
    if (!attempt) return { ok: false as const, reason: 'NOT_FOUND' as const };
    // The batch lock is what makes "not released" still true at commit: `beginRelease` waits behind it.
    const standing = await lockAttemptForMarking(tx, input.attemptId);
    if (standing === null)
      return { ok: false as const, reason: 'RELEASE_MEMBERSHIP_CHANGED' as const };
    if (
      input.responseId !== null &&
      (await tx.questionResponse.count({
        where: { id: input.responseId, attemptId: input.attemptId },
      })) !== 1
    ) {
      return { ok: false as const, reason: 'NOT_FOUND' as const };
    }
    const previous = input.existing
      ? await tx.feedback.findFirst({
          where: {
            id: input.existing.id,
            authorId: input.authorId,
            attemptId: input.attemptId,
            responseId: input.responseId,
          },
          select: { id: true, updatedAt: true, body: true, visibility: true, isDraft: true },
        })
      : null;
    if (input.existing && !previous) return { ok: false as const, reason: 'NOT_FOUND' as const };
    const refusal = decideFeedbackWrite({ ...standing, previous }, input);
    if (refusal) return { ok: false as const, reason: refusal };
    if (previous && previous.updatedAt.toISOString() !== input.existing?.basedOn) {
      return { ok: false as const, reason: 'CONFLICT' as const, current: previous };
    }
    // Same-millisecond saves must still invalidate the previous token.
    const at = new Date(Math.max(input.clock.now(), (previous?.updatedAt.getTime() ?? -1) + 1));
    const data = {
      body: input.body,
      visibility: input.visibility,
      isDraft: input.isDraft,
      updatedAt: at,
    };
    const row = previous
      ? await tx.feedback.update({
          where: { id: previous.id },
          data,
          select: { id: true, updatedAt: true },
        })
      : await tx.feedback.create({
          data: {
            ...data,
            attemptId: input.attemptId,
            responseId: input.responseId,
            authorId: input.authorId,
            createdAt: at,
          },
          select: { id: true, updatedAt: true },
        });
    await tx.auditEvent.create({
      data: {
        actorId: input.authorId,
        action: 'FEEDBACK_SAVED',
        targetType: 'Feedback',
        targetId: row.id,
        createdAt: at,
        meta: {
          attemptId: input.attemptId,
          responseId: input.responseId,
          visibility: input.visibility,
          isDraft: input.isDraft,
        },
      },
    });
    return { ok: true as const, id: row.id, version: row.updatedAt.toISOString() };
  });
}

/**
 * Release belongs to this attempt's membership, never to a sibling batch on its assignment.
 *
 * The rows are a comment and where it hangs, and nothing else. `assertNoScoreLeak` is here for the day somebody adds
 * `response: { select: { manualScore } }` to save the results page a query.
 */
export async function studentFeedback(
  db: GradingDb,
  input: { attemptId: string; studentId: string },
) {
  const rows = await db.$transaction((tx) =>
    tx.feedback.findMany({
      where: {
        attemptId: input.attemptId,
        visibility: 'STUDENT_AFTER_RELEASE',
        isDraft: false,
        attempt: {
          studentId: input.studentId,
          status: { not: 'VOIDED' },
          releaseMembers: { some: { batch: { status: 'RELEASED' } } },
        },
      },
      select: { id: true, responseId: true, body: true, createdAt: true, updatedAt: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    }),
  );
  assertNoScoreLeak(rows);
  return rows;
}

export async function teacherFeedback(
  db: GradingDb,
  input: { attemptId: string; actorId: string },
) {
  return db.$transaction((tx) =>
    tx.feedback.findMany({
      where: {
        attemptId: input.attemptId,
        attempt: teacherAttempt(input.actorId),
        OR: [{ isDraft: false }, { authorId: input.actorId }],
      },
      select: {
        id: true,
        responseId: true,
        authorId: true,
        body: true,
        visibility: true,
        isDraft: true,
        updatedAt: true,
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    }),
  );
}

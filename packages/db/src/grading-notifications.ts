import type { Clock } from '@orrery/clock';
import type { GradingDb } from './grading-access.js';
import { notify } from './notifications.js';

/** The newest open review task on the assignment, by the clock that wrote `ReviewTask.createdAt`. */
export interface OpenQueue {
  readonly newestTaskId: string;
  readonly newestTaskAt: number;
}

/** The last notice this teacher was sent for the assignment. `watermark` is the `newestTaskAt` it was sent for. */
export interface StandingNotice {
  readonly read: boolean;
  readonly watermark: number | null;
}

/**
 * The `refId` of the notice to send, or `null`.
 *
 * At most one unread notice per teacher per assignment, and a new one only once the last was read AND work arrived
 * after it. Keying on the assignment alone told a teacher once, ever: the late paper a week on hit the dedupe index.
 * Keying on the response is the per-response noise `plans/12` §7 rules out.
 */
export const decideGradingNotice = (
  assignmentId: string,
  queue: OpenQueue | null,
  latest: StandingNotice | null,
): string | null => {
  if (queue === null) return null;
  if (latest !== null && !latest.read) return null;
  // Both sides are `ReviewTask.createdAt`, so the comparison never crosses the app clock and the database clock.
  if (latest !== null && latest.watermark !== null && queue.newestTaskAt <= latest.watermark)
    return null;
  return `${assignmentId}:${queue.newestTaskId}`;
};

const watermarkOf = (data: unknown): number | null => {
  if (data === null || typeof data !== 'object') return null;
  const value = (data as Record<string, unknown>).newestTaskAt;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
};

/**
 * Tell an assignment's teachers that work is waiting. In-app only: delivery is `notify`, and `GRADING_NEEDED` has no
 * email channel in the policy `notify` reads.
 *
 * There is no teacher actor. The caller is the submit pipeline or a worker, after a `ReviewTask` is committed; a
 * notice only a teacher could trigger tells them what they already know. It reads the queue rather than taking an
 * event, so a lost call is repaired by the next one and a repeated call sends nothing.
 */
export async function notifyGradingNeeded(
  db: GradingDb,
  input: { assignmentId: string; clock: Clock; origin: string },
) {
  return db.$transaction(async (tx) => {
    // Two submissions landing together would each see "no standing notice" and send one each. Serialised on a key
    // of its own, never on the `Assignment` row every submit touches.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`grading-needed:${input.assignmentId}`}))`;
    const assignment = await tx.assignment.findUnique({
      where: { id: input.assignmentId },
      select: {
        id: true,
        classroomId: true,
        classroom: {
          select: {
            ownerId: true,
            enrollments: {
              where: { status: 'ACTIVE', role: { in: ['OWNER', 'TEACHER'] } },
              select: { userId: true },
            },
          },
        },
      },
    });
    if (!assignment) return { ok: false as const, reason: 'NOT_FOUND' as const };
    const newest = await tx.reviewTask.findFirst({
      where: {
        status: { in: ['PENDING', 'CLAIMED'] },
        attempt: { assignmentId: assignment.id, status: 'PENDING_REVIEW', purpose: 'GRADED' },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, createdAt: true },
    });
    const queue = newest
      ? { newestTaskId: newest.id, newestTaskAt: newest.createdAt.getTime() }
      : null;
    const recipients = [
      ...new Set([
        assignment.classroom.ownerId,
        ...assignment.classroom.enrollments.map((e) => e.userId),
      ]),
    ];
    let created = 0;
    for (const userId of recipients) {
      const latest = await tx.notification.findFirst({
        where: { userId, kind: 'GRADING_NEEDED', refId: { startsWith: `${assignment.id}:` } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { readAt: true, data: true },
      });
      const refId = decideGradingNotice(
        assignment.id,
        queue,
        latest ? { read: latest.readAt !== null, watermark: watermarkOf(latest.data) } : null,
      );
      if (refId === null || queue === null) continue;
      const result = await notify(
        tx,
        {
          userId,
          kind: 'GRADING_NEEDED',
          refId,
          title: 'Grading needed',
          body: 'Submitted work is waiting for a teacher to review.',
          data: {
            assignmentId: assignment.id,
            classroomId: assignment.classroomId,
            newestTaskAt: queue.newestTaskAt,
          },
          origin: input.origin,
        },
        input.clock,
      );
      if (result.created) created += 1;
    }
    return { ok: true as const, created };
  });
}

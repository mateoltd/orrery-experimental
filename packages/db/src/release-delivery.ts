import type { Clock } from '@orrery/clock';
import { assertNoScoreLeak } from '@orrery/interop';
import type { PrismaClient } from './index.js';
import { notify } from './notifications.js';

export function releaseNotice(attemptId: string) {
  const notice = {
    title: 'Your results are available',
    body: 'Your teacher has released your results. Open your results to read feedback and your submission receipt.',
    href: `/attempts/${encodeURIComponent(attemptId)}/results`,
  };
  assertNoScoreLeak(notice);
  return notice;
}

/** Each recipient commits both inbox and email outbox; a later tick repairs interrupted delivery. */
export async function queueReleaseNotifications(
  db: PrismaClient,
  batchId: string,
  clock: Clock,
  origin: string,
): Promise<number> {
  const batch = await db.releaseBatch.findUnique({
    where: { id: batchId },
    select: {
      status: true,
      notificationsCompletedAt: true,
      members: {
        select: { attemptId: true, attempt: { select: { studentId: true, purpose: true } } },
      },
    },
  });
  if (batch?.status !== 'RELEASED' || batch.notificationsCompletedAt !== null) return 0;
  let created = 0;
  for (const member of batch.members) {
    if (member.attempt.purpose !== 'GRADED') continue;
    // `notify` is multi-statement: inbox row and outbox row commit together or not at all, so a
    // retry never finds a student told in-app with no email queued (or the reverse).
    const result = await db.$transaction(async (tx) => {
      return notify(
        tx,
        {
          userId: member.attempt.studentId,
          kind: 'RESULTS_RELEASED',
          // Per-attempt dedupe also covers an attempt belonging to two released batches.
          refId: member.attemptId,
          origin,
          ...releaseNotice(member.attemptId),
        },
        clock,
      );
    });
    if (result.created) created += 1;
  }
  await db.releaseBatch.updateMany({
    where: { id: batchId, status: 'RELEASED', notificationsCompletedAt: null },
    data: { notificationsCompletedAt: new Date(clock.now()) },
  });
  return created;
}

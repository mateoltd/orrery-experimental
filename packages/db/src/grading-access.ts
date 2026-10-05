import type { Clock } from '@orrery/clock';
import type { Prisma, PrismaClient } from '../prisma/generated/client/client.js';

export type GradingDb = Pick<PrismaClient, '$transaction'>;
export type GradingTx = Prisma.TransactionClient;
export type GradingClock = Pick<Clock, 'now'>;

/** Permission is part of the read predicate, so another classroom's marks never enter memory. */
export const teacherClassroom = (actorId: string) => ({
  OR: [
    { ownerId: actorId },
    {
      enrollments: {
        some: {
          userId: actorId,
          status: 'ACTIVE' as const,
          role: { in: ['OWNER' as const, 'TEACHER' as const] },
        },
      },
    },
  ],
});

export const teacherAttempt = (actorId: string) => ({ classroom: teacherClassroom(actorId) });

/** Stable ordering prevents opposite bulk selections from deadlocking each other. */
export async function lockGradingAttempts(tx: GradingTx, ids: readonly string[]): Promise<void> {
  for (const id of [...new Set(ids)].sort()) {
    await tx.$queryRaw`SELECT "id" FROM "ExamAttempt" WHERE "id" = ${id} FOR UPDATE`;
  }
}

/** The release transition takes the batch lock first; marking must take it in the same order. */
export async function lockGradingBatches(
  tx: GradingTx,
  attemptIds: readonly string[],
): Promise<ReadonlySet<string>> {
  const members = await tx.releaseBatchMember.findMany({
    where: { attemptId: { in: [...attemptIds] } },
    select: { batchId: true },
  });
  const ids = [...new Set(members.map((member) => member.batchId))].sort();
  for (const id of ids)
    await tx.$queryRaw`SELECT "id" FROM "ReleaseBatch" WHERE "id" = ${id} FOR UPDATE`;
  return new Set(ids);
}

/**
 * Lock one attempt for a marking write, batch first, and say where it stands with release.
 *
 * `null` means a membership appeared between the two locks: the caller refuses rather than write under a batch lock
 * it does not hold.
 */
export async function lockAttemptForMarking(
  tx: GradingTx,
  attemptId: string,
): Promise<{ status: string; released: boolean; releasing: boolean } | null> {
  const locked = await lockGradingBatches(tx, [attemptId]);
  await lockGradingAttempts(tx, [attemptId]);
  const attempt = await tx.examAttempt.findUniqueOrThrow({
    where: { id: attemptId },
    select: {
      status: true,
      releasedAt: true,
      releaseMembers: { select: { batchId: true, batch: { select: { status: true } } } },
    },
  });
  if (attempt.releaseMembers.some((member) => !locked.has(member.batchId))) return null;
  return {
    status: attempt.status,
    released:
      attempt.releasedAt !== null ||
      attempt.releaseMembers.some((member) => member.batch.status === 'RELEASED'),
    releasing: attempt.releaseMembers.some((member) => member.batch.status === 'RELEASING'),
  };
}

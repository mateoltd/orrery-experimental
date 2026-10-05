import type { Clock } from '@orrery/clock';
import { type GradingDb, lockGradingAttempts, teacherClassroom } from './grading-access.js';
import { type ReleaseDb, releaseBatch } from './release.js';

/** The selection must be the frozen batch, so a UI filter cannot quietly release extra papers. */
export async function bulkRelease(
  db: GradingDb,
  input: {
    batchId: string;
    attemptIds: readonly string[];
    actorId: string;
    reason: string;
    clock: Clock;
  },
) {
  if (input.reason.trim() === '') return { ok: false as const, reason: 'REASON_REQUIRED' as const };
  if (input.attemptIds.length === 0 || new Set(input.attemptIds).size !== input.attemptIds.length) {
    return { ok: false as const, reason: 'INVALID_SELECTION' as const };
  }
  return db.$transaction(
    async (tx) => {
      const allowed = await tx.releaseBatch.count({
        where: { id: input.batchId, classroom: teacherClassroom(input.actorId) },
      });
      if (allowed !== 1) return { ok: false as const, reason: 'NOT_FOUND' as const };
      await tx.$queryRaw`SELECT "id" FROM "ReleaseBatch" WHERE "id" = ${input.batchId} FOR UPDATE`;
      const batch = await tx.releaseBatch.findUniqueOrThrow({
        where: { id: input.batchId },
        select: {
          status: true,
          classroomId: true,
          assignment: { select: { latePenaltyPercent: true } },
          members: { select: { attemptId: true } },
        },
      });
      const ids = new Set(input.attemptIds);
      if (batch.members.length !== ids.size || batch.members.some((m) => !ids.has(m.attemptId))) {
        return { ok: false as const, reason: 'SELECTION_DIFFERS_FROM_BATCH' as const };
      }
      if (batch.status === 'RELEASED') return { ok: true as const, releasedCount: 0 };
      if (batch.status !== 'RELEASING')
        return { ok: false as const, reason: 'BATCH_NOT_RELEASING' as const };
      await lockGradingAttempts(tx, input.attemptIds);
      // Reuse the release writer on this transaction handle; opening a second transaction would break atomicity.
      const adapter: ReleaseDb = {
        releaseBatch: tx.releaseBatch as unknown as ReleaseDb['releaseBatch'],
        releaseBatchMember: tx.releaseBatchMember as unknown as ReleaseDb['releaseBatchMember'],
        examAttempt: tx.examAttempt as unknown as ReleaseDb['examAttempt'],
        $transaction: (fn) => fn(adapter),
      };
      const result = await releaseBatch(adapter, {
        batchId: input.batchId,
        releasedById: input.actorId,
        latePenaltyPercent: Number(batch.assignment.latePenaltyPercent),
        clock: input.clock,
      });
      if (!result.released)
        return {
          ok: false as const,
          reason: 'RELEASE_REFUSED' as const,
          refusals: result.refusals,
        };
      const at = new Date(input.clock.now());
      await tx.attemptEventRecord.createMany({
        data: input.attemptIds.map((attemptId) => ({
          attemptId,
          actorId: input.actorId,
          type: 'RELEASED' as const,
          serverTs: at,
          payload: { batchId: input.batchId, reason: input.reason.trim() },
        })),
      });
      await tx.auditEvent.create({
        data: {
          actorId: input.actorId,
          action: 'BULK_RELEASE',
          targetType: 'ReleaseBatch',
          targetId: input.batchId,
          classroomId: batch.classroomId,
          createdAt: at,
          meta: { reason: input.reason.trim(), attemptIds: [...input.attemptIds] },
        },
      });
      return { ok: true as const, releasedCount: result.releasedCount };
    },
    { timeout: 60_000 },
  );
}

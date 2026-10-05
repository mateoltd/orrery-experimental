import type { Clock } from '@orrery/clock';
import type { PrismaClient, TxClient } from './index.js';
import { type ReleaseDb, type ReleaseRefusal, releaseBatch } from './release.js';
import { queueReleaseNotifications } from './release-delivery.js';

export const RELEASE_TICK_LIMIT = 20;

/** Only `beginRelease` starts work. A later tick automatically resumes `RELEASING`. */
export function releaseWork(
  status: string,
  notificationsCompleted: boolean,
): 'RELEASE' | 'NOTIFY' | 'NONE' {
  if (status === 'RELEASING') return 'RELEASE';
  if (status === 'RELEASED' && !notificationsCompleted) return 'NOTIFY';
  return 'NONE';
}

/** Adapt the existing release function to the already pinned transaction. */
function releaseTx(tx: TxClient): ReleaseDb {
  return {
    releaseBatch: tx.releaseBatch,
    releaseBatchMember: tx.releaseBatchMember,
    examAttempt: tx.examAttempt,
    $transaction: async <T>(fn: (tx: ReleaseDb) => Promise<T>) => fn(tx as unknown as ReleaseDb),
  } as unknown as ReleaseDb;
}

/** `EMPTY_BATCH` is the gate's own word for it; `releaseBatch` would mark an empty batch released. */
export type FinishRefusal = ReleaseRefusal | 'EMPTY_BATCH';
export interface FinishResult {
  readonly released: boolean;
  readonly releasedCount: number;
  readonly refusals: readonly { attemptId: string | null; reason: FinishRefusal }[];
}

/**
 * Verify every member and release, or write nothing -- inside ONE transaction on ONE session.
 *
 * The row locks are what "verify-all, then write" means under concurrency: a grade either commits
 * before the `FOR UPDATE` and is the mark that is verified, or waits until the release commits.
 * Nothing here is session-scoped, so a worker killed mid-release leaves no lock and no partial
 * write: the batch is simply still `RELEASING` for the next tick.
 */
export async function finishRelease(
  db: PrismaClient,
  batchId: string,
  clock: Clock,
): Promise<FinishResult> {
  return db.$transaction<FinishResult>(
    async (tx) => {
      // Row locks use this transaction's session; pool-level lock/unlock would leak locks.
      await tx.$queryRaw`SELECT id FROM "ReleaseBatch" WHERE id = ${batchId} FOR UPDATE`;
      await tx.$queryRaw`SELECT a.id FROM "Assignment" a JOIN "ReleaseBatch" b ON b."assignmentId" = a.id
      WHERE b.id = ${batchId} FOR SHARE OF a`;
      const batch = await tx.releaseBatch.findUnique({
        where: { id: batchId },
        select: {
          status: true,
          classroomId: true,
          assignment: { select: { latePenaltyPercent: true } },
        },
      });
      if (batch === null) return { released: false, releasedCount: 0, refusals: [] };
      if (batch.status === 'RELEASING') {
        // A grade writer must finish before verification, or wait until release commits.
        await tx.$queryRaw`SELECT a.id FROM "ExamAttempt" a JOIN "ReleaseBatchMember" m ON m."attemptId" = a.id
        WHERE m."batchId" = ${batchId} ORDER BY a.id FOR UPDATE OF a`;
        await tx.$queryRaw`SELECT r.id FROM "QuestionResponse" r JOIN "ReleaseBatchMember" m ON m."attemptId" = r."attemptId"
        WHERE m."batchId" = ${batchId} ORDER BY r.id FOR UPDATE OF r`;
        const count = await tx.releaseBatchMember.count({ where: { batchId } });
        if (count === 0)
          return {
            released: false,
            releasedCount: 0,
            refusals: [{ attemptId: null, reason: 'EMPTY_BATCH' }],
          };
      }
      const result = await releaseBatch(releaseTx(tx), {
        batchId,
        latePenaltyPercent: Number(batch.assignment.latePenaltyPercent),
        clock,
      });
      if (result.released) {
        const at = new Date(clock.now());
        const members = await tx.releaseBatchMember.findMany({
          where: { batchId },
          select: { attemptId: true },
        });
        await tx.attemptEventRecord.createMany({
          data: members.map(({ attemptId }) => ({
            attemptId,
            type: 'RELEASED',
            actorId: null,
            serverTs: at,
            payload: { batchId },
          })),
        });
        await tx.auditEvent.create({
          data: {
            action: 'ReleaseBatch.released',
            targetType: 'ReleaseBatch',
            targetId: batchId,
            classroomId: batch.classroomId,
            createdAt: at,
            meta: { releasedCount: result.releasedCount },
          },
        });
      }
      return result;
    },
    { timeout: 60_000 },
  );
}

export interface ReleaseTickResult {
  readonly batchId: string;
  readonly released: boolean;
  readonly notified: number;
  /** Present only when a `RELEASING` batch was verified and NOT released. Internal: carries attempt ids. */
  readonly refusals?: FinishResult['refusals'];
  readonly error?: string;
}

export async function runReleaseTick(
  db: PrismaClient,
  clock: Clock,
  origin: string,
): Promise<ReleaseTickResult[]> {
  const candidates = await db.releaseBatch.findMany({
    where: {
      OR: [
        { status: 'RELEASING' },
        { status: 'RELEASED', releasedAt: { not: null }, notificationsCompletedAt: null },
      ],
    },
    orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
    take: RELEASE_TICK_LIMIT,
    select: { id: true, status: true, notificationsCompletedAt: true },
  });
  const results: ReleaseTickResult[] = [];
  for (const batch of candidates) {
    let committed = false;
    try {
      // Rotate even failed delivery so twenty bad recipients cannot starve every later batch.
      await db.releaseBatch.updateMany({
        where: { id: batch.id, status: { in: ['RELEASING', 'RELEASED'] } },
        data: { updatedAt: new Date(clock.now()) },
      });
      const result =
        releaseWork(batch.status, batch.notificationsCompletedAt !== null) === 'RELEASE'
          ? await finishRelease(db, batch.id, clock)
          : null;
      committed = result?.released ?? false;
      // A lost race with another worker is success, not a stuck batch.
      const refusals = (result?.refusals ?? []).filter((r) => r.reason !== 'ALREADY_RELEASED');
      const notified =
        result !== null && !result.released && refusals.length > 0
          ? 0
          : await queueReleaseNotifications(db, batch.id, clock, origin);
      results.push({
        batchId: batch.id,
        released: committed,
        notified,
        // A frozen batch that verification refuses is retried every tick and releases nobody.
        // Reporting it is the only way anyone learns: nothing throws and nothing is written.
        ...(refusals.length > 0 ? { refusals } : {}),
      });
    } catch (error) {
      results.push({
        batchId: batch.id,
        released: committed,
        notified: 0,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

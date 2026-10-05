import { createHash } from 'node:crypto';
import { assertNoScoreLeak } from '@orrery/interop';
import type { Prisma } from '../prisma/generated/client/client.js';
import {
  type GradingClock,
  type GradingDb,
  type GradingTx,
  lockGradingAttempts,
  teacherClassroom,
} from './grading-access.js';
import { type ComputedScore, computeScore, round2, type ScoredResponse } from './release.js';

export interface AutomaticRegrade {
  points: number;
  rawPoints: number;
  correct: boolean;
  needsHuman: boolean;
  rationale: Prisma.InputJsonValue;
  graderVersion: string;
}

/** Server-owned calculator, shared by preview and the worker. It must use the pinned snapshot, not a live key. */
export type RegradeCalculator = (input: {
  questionId: string;
  answer: Prisma.JsonValue;
  simState: Prisma.JsonValue | null;
  simStateRef: string | null;
  snapshot: { resourceVersionId: string; blocks: Prisma.JsonValue; meta: Prisma.JsonValue };
}) => Promise<AutomaticRegrade>;

export interface RegradeRequest {
  assignmentId: string;
  actorId: string;
  reason: string;
  questionIds?: readonly string[];
}

interface ResponseChange {
  responseId: string;
  revision: number;
  before: {
    points: number | null;
    rawPoints: number | null;
    correct: boolean | null;
    needsHuman: boolean;
    rationale: Prisma.JsonValue | null;
    graderVersion: string | null;
  };
  after: AutomaticRegrade;
}
export interface RegradeAttemptPreview {
  attemptId: string;
  studentId: string;
  released: boolean;
  changes: readonly ResponseChange[];
  before: { finalScore: number | null; percentage: number | null; maxScore: number | null };
  after: ComputedScore;
  delta: number | null;
}
export interface RegradePreview {
  token: string;
  request: RegradeRequest;
  attempts: readonly RegradeAttemptPreview[];
  affectedCount: number;
  alreadyReleasedCount: number;
  batches: readonly { id: string; status: string; members: readonly string[] }[];
}

export type RegradeRefusal =
  | 'NOT_FOUND'
  | 'REASON_REQUIRED'
  | 'INVALID_QUESTION_SELECTION'
  | 'RELEASE_IN_PROGRESS'
  | 'INCOMPLETE_RELEASED_BATCH'
  | 'INVALID_GRADER_RESULT'
  | 'RELEASED_WOULD_BE_PROVISIONAL'
  | 'PREVIEW_STALE';
class RegradeRefused extends Error {
  constructor(readonly reason: RegradeRefusal) {
    super(reason);
  }
}

const nullableNumber = (value: unknown): number | null => (value === null ? null : Number(value));
const same = (left: unknown, right: unknown): boolean => canonical(left) === canonical(right);

/** JSON object order must not turn an unchanged preview into a spurious conflict. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

export const validAutomaticRegrade = (value: AutomaticRegrade, maxPoints: number): boolean =>
  [value.points, value.rawPoints].every(
    (n) => Number.isFinite(n) && Math.abs(n * 100 - Math.round(n * 100)) < 1e-7,
  ) &&
  value.points >= 0 &&
  value.points <= maxPoints &&
  value.rawPoints <= maxPoints &&
  typeof value.correct === 'boolean' &&
  typeof value.needsHuman === 'boolean' &&
  value.graderVersion.trim() !== '';

/**
 * `percentage` is stored as `Decimal(6,3)`, so an unrounded 1/3 would differ from the released 0.333 on every dry run.
 * Nothing else is adjusted: a released figure came out of `computeScore`, and a second arithmetic here would move it.
 */
export function atStoragePrecision(score: ComputedScore): ComputedScore {
  return {
    ...score,
    percentage: score.percentage === null ? null : Math.round(score.percentage * 1000) / 1000,
  };
}

/**
 * What a student is told when a released result moves: that it moved, and why. The new figure is on the results
 * page, behind the release gate; a notification is read on a lock screen and is not.
 */
export function regradeNotice(attemptId: string, reason: string) {
  const notice = {
    title: 'Your result was regraded',
    body: reason.trim(),
    href: `/attempts/${encodeURIComponent(attemptId)}/results`,
  };
  assertNoScoreLeak(notice);
  return notice;
}

const isChanged = (attempt: RegradeAttemptPreview): boolean =>
  attempt.changes.length > 0 ||
  attempt.before.finalScore !== attempt.after.finalScore ||
  attempt.before.percentage !== attempt.after.percentage ||
  attempt.before.maxScore !== attempt.after.maxTotal;

async function prepare(
  tx: GradingTx,
  request: RegradeRequest,
  calculate: RegradeCalculator,
): Promise<RegradePreview> {
  if (!request.reason.trim()) throw new RegradeRefused('REASON_REQUIRED');
  if (
    request.questionIds &&
    (request.questionIds.length === 0 ||
      new Set(request.questionIds).size !== request.questionIds.length)
  ) {
    throw new RegradeRefused('INVALID_QUESTION_SELECTION');
  }
  const assignment = await tx.assignment.findFirst({
    where: { id: request.assignmentId, classroom: teacherClassroom(request.actorId) },
    select: {
      id: true,
      updatedAt: true,
      latePenaltyPercent: true,
      resourceVersionId: true,
      resourceVersion: { select: { blocks: true, meta: true } },
    },
  });
  if (!assignment) throw new RegradeRefused('NOT_FOUND');
  const rows = await tx.examAttempt.findMany({
    where: {
      assignmentId: assignment.id,
      purpose: 'GRADED',
      status: { in: ['SUBMITTED', 'EXPIRED', 'PENDING_REVIEW', 'GRADED'] },
    },
    orderBy: { id: 'asc' },
    select: {
      id: true,
      studentId: true,
      status: true,
      releasedAt: true,
      updatedAt: true,
      isLate: true,
      finalScore: true,
      percentage: true,
      maxScore: true,
      responses: {
        orderBy: { id: 'asc' },
        select: {
          id: true,
          questionId: true,
          revision: true,
          answer: true,
          simState: true,
          simStateRef: true,
          autoScore: true,
          autoRawScore: true,
          autoCorrect: true,
          autoRationale: true,
          autoGraderVersion: true,
          manualScore: true,
          isExcused: true,
          needsHuman: true,
          question: { select: { points: true } },
        },
      },
    },
  });
  const batchRows = await tx.releaseBatch.findMany({
    where: { assignmentId: assignment.id, status: { in: ['RELEASED', 'RELEASING'] } },
    orderBy: { id: 'asc' },
    select: {
      id: true,
      status: true,
      members: { orderBy: { attemptId: 'asc' }, select: { attemptId: true } },
    },
  });
  if (batchRows.some((b) => b.status === 'RELEASING'))
    throw new RegradeRefused('RELEASE_IN_PROGRESS');
  const allIds = new Set(rows.map((r) => r.id));
  if (batchRows.some((b) => b.members.some((m) => !allIds.has(m.attemptId))))
    throw new RegradeRefused('INCOMPLETE_RELEASED_BATCH');
  const questionIds = new Set(rows.flatMap((r) => r.responses.map((q) => q.questionId)));
  if (request.questionIds?.some((id) => !questionIds.has(id)))
    throw new RegradeRefused('INVALID_QUESTION_SELECTION');
  const selected = request.questionIds ? new Set(request.questionIds) : questionIds;
  const attempts: RegradeAttemptPreview[] = [];
  for (const row of rows) {
    const changes: ResponseChange[] = [];
    const stored: ScoredResponse[] = [];
    const regraded: ScoredResponse[] = [];
    for (const response of row.responses) {
      const before = {
        points: nullableNumber(response.autoScore),
        rawPoints: nullableNumber(response.autoRawScore),
        correct: response.autoCorrect,
        needsHuman: response.needsHuman,
        rationale: response.autoRationale,
        graderVersion: response.autoGraderVersion,
      };
      let after: AutomaticRegrade | null = null;
      // Manual decisions and excuses survive a changed automatic key.
      if (
        selected.has(response.questionId) &&
        response.manualScore === null &&
        !response.isExcused
      ) {
        after = await calculate({
          questionId: response.questionId,
          answer: response.answer,
          simState: response.simState,
          simStateRef: response.simStateRef,
          snapshot: {
            resourceVersionId: assignment.resourceVersionId,
            blocks: assignment.resourceVersion.blocks,
            meta: assignment.resourceVersion.meta,
          },
        });
        if (!validAutomaticRegrade(after, Number(response.question.points)))
          throw new RegradeRefused('INVALID_GRADER_RESULT');
        if (!same(before, after))
          changes.push({ responseId: response.id, revision: response.revision, before, after });
      }
      const manual = nullableNumber(response.manualScore);
      const common = {
        questionId: response.questionId,
        points: Number(response.question.points),
        isExcused: response.isExcused,
      };
      // `manualScore ?? autoScore`, the bounded mark, exactly as `loadReleasePlan` reads it. Totalling `rawPoints`
      // here moved a released 50 to 40 on a paper nobody had regraded: two arithmetics for one figure.
      stored.push({
        ...common,
        needsHuman: response.needsHuman,
        finalScore: manual ?? before.points,
      });
      regraded.push({
        ...common,
        needsHuman: after?.needsHuman ?? response.needsHuman,
        finalScore: manual ?? (after ? after.points : before.points),
      });
    }
    const released =
      row.releasedAt !== null ||
      batchRows.some((b) => b.members.some((m) => m.attemptId === row.id));
    const total = (responses: readonly ScoredResponse[]) =>
      atStoragePrecision(
        computeScore({
          responses,
          isLate: row.isLate,
          latePenaltyPercent: Number(assignment.latePenaltyPercent),
        }),
      );
    const after = total(regraded);
    if (released && after.isProvisional) throw new RegradeRefused('RELEASED_WOULD_BE_PROVISIONAL');
    const held = total(stored);
    // A released paper starts from what the student was SHOWN. An unreleased one has no stored total yet
    // (`releaseBatch` writes it), and comparing against that null reported every unreleased paper as affected.
    const before = released
      ? {
          finalScore: nullableNumber(row.finalScore),
          percentage: nullableNumber(row.percentage),
          maxScore: nullableNumber(row.maxScore),
        }
      : { finalScore: held.finalScore, percentage: held.percentage, maxScore: held.maxTotal };
    attempts.push({
      attemptId: row.id,
      studentId: row.studentId,
      released,
      changes,
      before,
      after,
      delta:
        before.finalScore === null || after.finalScore === null
          ? null
          : round2(after.finalScore - before.finalScore),
    });
  }
  const batches = batchRows.map((b) => ({
    id: b.id,
    status: b.status,
    members: b.members.map((m) => m.attemptId),
  }));
  // Include unchanged revisions too: a newly saved manual mark invalidates the confirmed preview.
  const token = createHash('sha256')
    .update(
      canonical({
        request,
        attempts,
        batches,
        version: assignment.resourceVersionId,
        policyAt: assignment.updatedAt.toISOString(),
        rows: rows.map((r) => ({
          id: r.id,
          status: r.status,
          updatedAt: r.updatedAt.toISOString(),
          responses: r.responses.map((q) => ({ id: q.id, revision: q.revision })),
        })),
      }),
    )
    .digest('hex');
  const affected = attempts.filter(isChanged);
  return {
    token,
    request,
    attempts,
    batches,
    affectedCount: affected.length,
    alreadyReleasedCount: affected.filter((a) => a.released).length,
  };
}

/** No writes. Repeatable-read keeps batch membership and the marks in one preview snapshot. */
export async function previewRegrade(
  db: GradingDb,
  request: RegradeRequest,
  calculate: RegradeCalculator,
) {
  try {
    const preview = await db.$transaction((tx) => prepare(tx, request, calculate), {
      isolationLevel: 'RepeatableRead',
      timeout: 60_000,
    });
    return { ok: true as const, preview };
  } catch (error) {
    if (error instanceof RegradeRefused) return { ok: false as const, reason: error.reason };
    throw error;
  }
}

/** Worker entry point. Queue persistence belongs to the host; this applies one confirmed job atomically. */
export async function applyRegrade(
  db: GradingDb,
  input: { request: RegradeRequest; previewToken: string; clock: GradingClock },
  calculate: RegradeCalculator,
) {
  try {
    return await db.$transaction(
      async (tx) => {
        const allowed = await tx.assignment.count({
          where: {
            id: input.request.assignmentId,
            classroom: teacherClassroom(input.request.actorId),
          },
        });
        if (allowed !== 1) throw new RegradeRefused('NOT_FOUND');
        // Block new batch/attempt foreign keys and policy edits while the confirmed assignment is applied.
        await tx.$queryRaw`SELECT "id" FROM "Assignment" WHERE "id" = ${input.request.assignmentId} FOR UPDATE`;
        // A worker can lose its acknowledgement after commit. The event token makes that retry a receipt, not another regrade.
        const requestDigest = createHash('sha256').update(canonical(input.request)).digest('hex');
        const applied = await tx.attemptEventRecord.count({
          where: {
            type: 'REGRADED',
            actorId: input.request.actorId,
            attempt: { assignmentId: input.request.assignmentId },
            AND: [
              { payload: { path: ['previewToken'], equals: input.previewToken } },
              { payload: { path: ['requestDigest'], equals: requestDigest } },
            ],
          },
        });
        if (applied > 0)
          return {
            ok: true as const,
            appliedCount: applied,
            token: input.previewToken,
            alreadyApplied: true,
          };
        // Lock batches before attempts, matching the release wrapper's ordering.
        await tx.$queryRaw`SELECT "id" FROM "ReleaseBatch" WHERE "assignmentId" = ${input.request.assignmentId} ORDER BY "id" FOR UPDATE`;
        const ids = await tx.examAttempt.findMany({
          where: { assignmentId: input.request.assignmentId },
          select: { id: true },
        });
        await lockGradingAttempts(
          tx,
          ids.map((r) => r.id),
        );
        const preview = await prepare(tx, input.request, calculate);
        if (preview.token !== input.previewToken) throw new RegradeRefused('PREVIEW_STALE');
        const at = new Date(input.clock.now());
        const changed = preview.attempts.filter(isChanged);
        const batchMembers = new Set(
          preview.batches
            .filter((b) => b.members.some((id) => changed.some((a) => a.attemptId === id)))
            .flatMap((b) => b.members),
        );
        for (const attempt of preview.attempts) {
          if (!isChanged(attempt) && !batchMembers.has(attempt.attemptId)) continue;
          for (const change of attempt.changes) {
            const written = await tx.questionResponse.updateMany({
              where: { id: change.responseId, revision: change.revision },
              data: {
                autoScore: change.after.points,
                autoRawScore: change.after.rawPoints,
                autoRationale: change.after.rationale,
                autoGraderVersion: change.after.graderVersion,
                autoGradedAt: at,
                autoCorrect: change.after.correct,
                needsHuman: change.after.needsHuman,
                revision: { increment: 1 },
                updatedAt: at,
              },
            });
            if (written.count !== 1) throw new RegradeRefused('PREVIEW_STALE');
            await tx.gradeChange.create({
              data: {
                attemptId: attempt.attemptId,
                responseId: change.responseId,
                actorId: input.request.actorId,
                reason: input.request.reason.trim(),
                createdAt: at,
                before: change.before as Prisma.InputJsonValue,
                after: change.after as unknown as Prisma.InputJsonValue,
              },
            });
          }
          await tx.examAttempt.update({
            where: { id: attempt.attemptId },
            data: {
              finalScore: attempt.after.finalScore,
              percentage: attempt.after.percentage,
              maxScore: attempt.after.maxTotal,
              latePenaltyApplied: attempt.after.latePenaltyApplied,
              status: attempt.after.isProvisional ? 'PENDING_REVIEW' : 'GRADED',
              ...(attempt.released && isChanged(attempt) ? { regradeNoticePendingAt: at } : {}),
              updatedAt: at,
            },
          });
          if (attempt.after.isProvisional)
            await tx.reviewTask.upsert({
              where: { attemptId: attempt.attemptId },
              create: {
                attemptId: attempt.attemptId,
                status: 'PENDING',
                createdAt: at,
                updatedAt: at,
              },
              update: { status: 'PENDING', graderId: null, claimedAt: null, updatedAt: at },
            });
          else
            await tx.reviewTask.updateMany({
              where: { attemptId: attempt.attemptId },
              data: { status: 'DONE', updatedAt: at },
            });
          if (!isChanged(attempt)) continue;
          await tx.gradeChange.create({
            data: {
              attemptId: attempt.attemptId,
              actorId: input.request.actorId,
              before: attempt.before,
              after: {
                finalScore: attempt.after.finalScore,
                percentage: attempt.after.percentage,
                maxScore: attempt.after.maxTotal,
              },
              reason: input.request.reason.trim(),
              createdAt: at,
            },
          });
          await tx.attemptEventRecord.create({
            data: {
              attemptId: attempt.attemptId,
              type: 'REGRADED',
              actorId: input.request.actorId,
              serverTs: at,
              payload: {
                reason: input.request.reason.trim(),
                previewToken: preview.token,
                requestDigest,
              },
            },
          });
          if (attempt.released)
            await tx.notification.create({
              data: {
                userId: attempt.studentId,
                kind: 'REGRADE_NOTICE',
                refId: `${attempt.attemptId}:${preview.token}`,
                ...regradeNotice(attempt.attemptId, input.request.reason),
                data: { attemptId: attempt.attemptId },
                createdAt: at,
              },
            });
        }
        return {
          ok: true as const,
          appliedCount: changed.length,
          token: preview.token,
          alreadyApplied: false,
        };
      },
      { timeout: 120_000 },
    );
  } catch (error) {
    if (error instanceof RegradeRefused) return { ok: false as const, reason: error.reason };
    throw error;
  }
}

import type { Prisma } from '../prisma/generated/client/client.js';
import {
  type GradingClock,
  type GradingDb,
  type GradingTx,
  lockGradingAttempts,
  lockGradingBatches,
  teacherAttempt,
} from './grading-access.js';
import { decideGradingWrite, type GradingAction, type MarkRefusal } from './grading-policy.js';

const responseProjection = {
  select: {
    id: true,
    attemptId: true,
    revision: true,
    manualScore: true,
    manualFeedback: true,
    isExcused: true,
    needsHuman: true,
    autoScore: true,
    graderId: true,
    gradedAt: true,
    question: { select: { points: true } },
  },
} satisfies Prisma.QuestionResponseDefaultArgs;

export interface BulkGradingInput {
  actorId: string;
  clock: GradingClock;
  action: GradingAction;
  targets: readonly { attemptId: string; responseId: string; basedOn: string }[];
}

export type BulkGradingResult =
  | { ok: true; saved: readonly { responseId: string; version: string }[] }
  | {
      ok: false;
      reason: MarkRefusal | 'NOT_FOUND' | 'INVALID_SELECTION';
      responseId?: string;
      current?: {
        version: string;
        points: number | null;
        feedback: string | null;
        excused: boolean;
        graderId: string | null;
        gradedAt: string | null;
      };
    };

class BulkRefused extends Error {
  constructor(readonly result: Extract<BulkGradingResult, { ok: false }>) {
    super(result.reason);
  }
}

/** One transaction for every selected row, including 200+ papers. A refusal rolls back prior writes. */
export async function bulkGrade(
  db: GradingDb,
  input: BulkGradingInput,
): Promise<BulkGradingResult> {
  if (
    input.targets.length === 0 ||
    new Set(input.targets.map((t) => t.responseId)).size !== input.targets.length ||
    (input.action.kind === 'VOID' &&
      new Set(input.targets.map((t) => t.attemptId)).size !== input.targets.length)
  ) {
    return { ok: false, reason: 'INVALID_SELECTION' };
  }
  try {
    return await db.$transaction(
      async (tx) => {
        const ids = [...new Set(input.targets.map((t) => t.attemptId))];
        // Authorize before taking locks, then re-read under them to close the grading race.
        const allowed = await tx.examAttempt.count({
          where: { id: { in: ids }, ...teacherAttempt(input.actorId) },
        });
        if (allowed !== ids.length) throw new BulkRefused({ ok: false, reason: 'NOT_FOUND' });
        const lockedBatches = await lockGradingBatches(tx, ids);
        await lockGradingAttempts(tx, ids);
        const attempts = await tx.examAttempt.findMany({
          where: { id: { in: ids }, ...teacherAttempt(input.actorId) },
          select: {
            id: true,
            status: true,
            releasedAt: true,
            releaseMembers: { select: { batchId: true, batch: { select: { status: true } } } },
          },
        });
        // A membership inserted before the attempt lock needs a fresh ordered lock pass, never a write under an unheld batch lock.
        if (
          attempts.some((attempt) =>
            attempt.releaseMembers.some((member) => !lockedBatches.has(member.batchId)),
          )
        ) {
          throw new BulkRefused({ ok: false, reason: 'RELEASE_MEMBERSHIP_CHANGED' });
        }
        const responses = await tx.questionResponse.findMany({
          where: {
            id: { in: input.targets.map((t) => t.responseId) },
            attempt: teacherAttempt(input.actorId),
          },
          select: responseProjection.select,
        });
        const saved: { responseId: string; version: string }[] = [];
        for (const target of input.targets) {
          const attempt = attempts.find((a) => a.id === target.attemptId);
          const response = responses.find(
            (r) => r.id === target.responseId && r.attemptId === target.attemptId,
          );
          if (!attempt || !response)
            throw new BulkRefused({
              ok: false,
              reason: 'NOT_FOUND',
              responseId: target.responseId,
            });
          const reason = decideGradingWrite(
            {
              revision: response.revision,
              status: attempt.status,
              released:
                attempt.releasedAt !== null ||
                attempt.releaseMembers.some((m) => m.batch.status === 'RELEASED'),
              releasing: attempt.releaseMembers.some((m) => m.batch.status === 'RELEASING'),
              points: Number(response.question.points),
              sealedAutomatic:
                response.autoScore !== null &&
                response.manualScore === null &&
                !response.needsHuman,
            },
            target.basedOn,
            input.action,
          );
          if (reason)
            throw new BulkRefused({
              ok: false,
              reason,
              responseId: response.id,
              current: {
                version: String(response.revision),
                points: response.manualScore === null ? null : Number(response.manualScore),
                feedback: response.manualFeedback,
                excused: response.isExcused,
                graderId: response.graderId,
                gradedAt: response.gradedAt?.toISOString() ?? null,
              },
            });
          const at = new Date(input.clock.now());
          const { action } = input;
          const data: Prisma.QuestionResponseUpdateManyMutationInput = {
            revision: { increment: 1 },
            updatedAt: at,
          };
          if (action.kind === 'SCORE')
            Object.assign(data, {
              manualScore: action.points,
              manualFeedback: action.feedback,
              needsHuman: false,
              isExcused: false,
              graderId: input.actorId,
              gradedAt: at,
              wasQuickScored: action.quickScored ?? false,
            });
          if (action.kind === 'EXCUSE') data.isExcused = true;
          const written = await tx.questionResponse.updateMany({
            where: { id: response.id, revision: response.revision },
            data,
          });
          if (written.count !== 1)
            throw new BulkRefused({ ok: false, reason: 'CONFLICT', responseId: response.id });
          if (action.kind === 'SCORE' || action.kind === 'EXCUSE') {
            await tx.gradeChange.create({
              data: {
                attemptId: response.attemptId,
                responseId: response.id,
                actorId: input.actorId,
                createdAt: at,
                reason: action.kind === 'EXCUSE' ? action.reason.trim() : 'Teacher marking',
                before: {
                  points: response.manualScore === null ? null : Number(response.manualScore),
                  feedback: response.manualFeedback,
                  excused: response.isExcused,
                },
                after: {
                  points:
                    action.kind === 'SCORE'
                      ? action.points
                      : response.manualScore === null
                        ? null
                        : Number(response.manualScore),
                  feedback: action.kind === 'SCORE' ? action.feedback : response.manualFeedback,
                  excused: action.kind === 'EXCUSE',
                },
              },
            });
          }
          if (action.kind === 'FEEDBACK')
            await tx.feedback.create({
              data: {
                attemptId: response.attemptId,
                responseId: response.id,
                authorId: input.actorId,
                body: action.body,
                visibility: action.visibility,
                isDraft: action.isDraft,
                createdAt: at,
                updatedAt: at,
              },
            });
          if (action.kind === 'VOID')
            await voidAttempt(tx, response.attemptId, input.actorId, action, at);
          await tx.attemptEventRecord.create({
            data: {
              attemptId: response.attemptId,
              actorId: input.actorId,
              serverTs: at,
              type:
                action.kind === 'VOID'
                  ? 'VOIDED'
                  : action.kind === 'EXCUSE'
                    ? 'EXCUSED'
                    : 'MANUAL_GRADED',
              payload: {
                action: action.kind,
                responseId: response.id,
                basedOn: target.basedOn,
                reason:
                  action.kind === 'VOID' || action.kind === 'EXCUSE' ? action.reason.trim() : null,
              },
            },
          });
          saved.push({ responseId: response.id, version: String(response.revision + 1) });
        }
        // Only a mark or an excuse resolves a response. A comment that recomputed the status moved a `SUBMITTED`
        // paper to `PENDING_REVIEW` ahead of the auto-grader.
        if (input.action.kind === 'SCORE' || input.action.kind === 'EXCUSE') {
          for (const id of ids) {
            const unresolved = await tx.questionResponse.count({
              where: {
                attemptId: id,
                isExcused: false,
                OR: [{ needsHuman: true }, { manualScore: null, autoScore: null }],
              },
            });
            await tx.examAttempt.update({
              where: { id },
              data: { status: unresolved === 0 ? 'GRADED' : 'PENDING_REVIEW' },
            });
            if (unresolved === 0)
              await tx.reviewTask.updateMany({
                where: { attemptId: id },
                data: { status: 'DONE', updatedAt: new Date(input.clock.now()) },
              });
          }
        }
        return { ok: true, saved };
      },
      { timeout: 60_000 },
    );
  } catch (error) {
    if (error instanceof BulkRefused) return error.result;
    throw error;
  }
}

async function voidAttempt(
  tx: GradingTx,
  attemptId: string,
  actorId: string,
  action: Extract<GradingAction, { kind: 'VOID' }>,
  at: Date,
): Promise<void> {
  await tx.integrityVerdict.upsert({
    where: { attemptId },
    create: {
      attemptId,
      decidedById: actorId,
      outcome: 'VOIDED',
      reason: action.reason.trim(),
      consideredAccessibilityContext: action.consideredAccessibilityContext,
      decidedAt: at,
      createdAt: at,
    },
    update: {
      decidedById: actorId,
      outcome: 'VOIDED',
      reason: action.reason.trim(),
      consideredAccessibilityContext: action.consideredAccessibilityContext,
      decidedAt: at,
    },
  });
  // Discard totals; retain response marks and evidence for the integrity audit.
  await tx.examAttempt.update({
    where: { id: attemptId },
    data: {
      status: 'VOIDED',
      voidedReason: action.reason.trim(),
      autoScore: null,
      manualScore: null,
      finalScore: null,
      maxScore: null,
      percentage: null,
      latePenaltyApplied: null,
    },
  });
  await tx.reviewTask.updateMany({ where: { attemptId }, data: { status: 'DONE', updatedAt: at } });
}

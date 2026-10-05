import type { Actor } from '@orrery/auth/types';
import type { Clock } from '@orrery/clock';
import type { PrismaClient } from './index.js';
import { ReportDenied, requireReportTeacher } from './report-access.js';
import {
  buildLedgerRow,
  completePaperResponses,
  type LedgerAssignment,
  type LedgerRow,
  resolvedVariant,
} from './report-gradebook.js';

const PAGE_SIZE = 100;
const releasedMembership = { some: { batch: { status: 'RELEASED' as const } } };
const RELEASED_RESPONSE_PROJECTION = {
  select: {
    questionId: true,
    autoScore: true,
    manualScore: true,
    isExcused: true,
    needsHuman: true,
    question: { select: { points: true } },
  },
} as const;

function numberOf(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error('Non-finite report value');
  return number;
}

export interface ReportScope {
  readonly classroomId: string;
  readonly assignmentId?: string;
  readonly studentId?: string;
}

/** Each pull reads at most one roster page; grades are derived within each student's snapshot. */
export async function* readGradebook(
  db: PrismaClient,
  actor: Actor,
  scope: ReportScope,
  clock: Clock,
): AsyncGenerator<LedgerRow> {
  await requireReportTeacher(db, actor, scope.classroomId);
  const assignments = await db.assignment.findMany({
    where: {
      classroomId: scope.classroomId,
      status: 'PUBLISHED',
    },
    orderBy: { id: 'asc' },
    select: {
      id: true,
      titleOverride: true,
      weight: true,
      availableUntil: true,
      latePenaltyPercent: true,
      resource: { select: { title: true } },
      resourceVersion: { select: { _count: { select: { questions: true } } } },
    },
  });
  if (scope.assignmentId && !assignments.some((a) => a.id === scope.assignmentId))
    throw new ReportDenied(404);
  const definitions: LedgerAssignment[] = assignments.map((a) => ({
    id: a.id,
    title: a.titleOverride ?? a.resource.title,
    weight: numberOf(a.weight) ?? 0,
    dueAt: a.availableUntil?.getTime() ?? null,
    latePenaltyPercent: numberOf(a.latePenaltyPercent) ?? 0,
    // Snapshot questions preserve the published pool; live bank counts would rewrite history.
    possibleItemCount: a.resourceVersion._count.questions || null,
  }));
  let after: string | null = null;
  for (;;) {
    await requireReportTeacher(db, actor, scope.classroomId);
    const members: {
      id: string;
      userId: string;
      displayNameOverride: string | null;
      user: { name: string };
    }[] = await db.enrollment.findMany({
      where: {
        classroomId: scope.classroomId,
        role: 'STUDENT',
        status: 'ACTIVE',
        ...(scope.studentId ? { userId: scope.studentId } : {}),
        ...(after ? { id: { gt: after } } : {}),
      },
      select: {
        id: true,
        userId: true,
        displayNameOverride: true,
        user: { select: { name: true } },
      },
      orderBy: { id: 'asc' },
      take: PAGE_SIZE,
    });
    for (const member of members) {
      const row = await db.$transaction(
        async (tx) => {
          const overrides = await tx.assignmentStudentOverride.findMany({
            where: { studentId: member.userId, assignmentId: { in: assignments.map((a) => a.id) } },
            select: { assignmentId: true, availableUntil: true },
          });
          const dueAt = new Map(
            overrides.map((o) => [o.assignmentId, o.availableUntil?.getTime()]),
          );
          const attempts = await tx.examAttempt.findMany({
            where: {
              classroomId: scope.classroomId,
              studentId: member.userId,
              purpose: 'GRADED',
              assignmentId: { in: assignments.map((a) => a.id) },
            },
            distinct: ['assignmentId'],
            orderBy: [{ assignmentId: 'asc' }, { attemptNumber: 'desc' }],
            select: {
              id: true,
              assignmentId: true,
              status: true,
              isLate: true,
              submittedAt: true,
              variantMap: true,
            },
          });
          // Gate on these attempts' membership, including when a sibling batch was released.
          const released = await tx.examAttempt.findMany({
            where: {
              id: { in: attempts.map((a) => a.id) },
              classroomId: scope.classroomId,
              studentId: member.userId,
              purpose: 'GRADED',
              releaseMembers: releasedMembership,
            },
            select: {
              id: true,
              responses: RELEASED_RESPONSE_PROJECTION,
            },
          });
          const scores = new Map(
            released.map((a) => [
              a.id,
              a.responses.map((r) => ({
                questionId: r.questionId,
                finalScore: numberOf(r.manualScore) ?? numberOf(r.autoScore),
                points: numberOf(r.question.points) ?? 0,
                isExcused: r.isExcused,
                needsHuman: r.needsHuman,
              })),
            ]),
          );
          const releasedIds = new Set(released.map((a) => a.id));
          const paperIds = [
            ...new Set(
              attempts
                .filter((a) => releasedIds.has(a.id))
                .flatMap((a) => resolvedVariant(a.variantMap, null).questionIds),
            ),
          ];
          const paper =
            paperIds.length === 0
              ? []
              : await tx.question.findMany({
                  where: { id: { in: paperIds } },
                  select: { id: true, points: true },
                });
          const maximums = new Map(paper.map((q) => [q.id, numberOf(q.points) ?? 0]));
          const ledger = buildLedgerRow({
            studentId: member.userId,
            student: member.displayNameOverride?.trim() || member.user.name,
            assignments: definitions.map((a) => ({ ...a, dueAt: dueAt.get(a.id) ?? a.dueAt })),
            computedAt: clock.now(),
            attempts: attempts.map((a) => ({
              ...a,
              submittedAt: a.submittedAt?.getTime() ?? null,
              releasedResponses: releasedIds.has(a.id)
                ? completePaperResponses(a.variantMap, scores.get(a.id) ?? [], maximums)
                : null,
            })),
          });
          // A display filter must never remove assignments from the course denominator.
          return {
            ...ledger,
            cells: scope.assignmentId
              ? ledger.cells.filter((cell) => cell.assignmentId === scope.assignmentId)
              : ledger.cells,
          };
        },
        { isolationLevel: 'RepeatableRead' },
      );
      yield row;
    }
    if (members.length < PAGE_SIZE) return;
    after = members[members.length - 1]?.id ?? null;
  }
}

export interface SubmissionRow {
  readonly responseId: string;
  readonly attemptId: string;
  readonly assignmentId: string;
  readonly studentId: string;
  readonly questionId: string;
  readonly position: number;
  readonly answer: unknown;
  readonly submittedAt: string | null;
  readonly receipt: string | null;
}

/** Response keyset avoids loading a cohort's arbitrary student text before the first byte. */
export async function* readSubmissions(
  db: PrismaClient,
  actor: Actor,
  scope: ReportScope,
): AsyncGenerator<SubmissionRow> {
  let after: string | null = null;
  for (;;) {
    await requireReportTeacher(db, actor, scope.classroomId);
    const page: {
      id: string;
      questionId: string;
      position: number;
      answer: unknown;
      attempt: {
        id: string;
        assignmentId: string;
        studentId: string;
        submittedAt: Date | null;
        submissionReceipt: string | null;
      };
    }[] = await db.questionResponse.findMany({
      where: {
        ...(after ? { id: { gt: after } } : {}),
        attempt: {
          classroomId: scope.classroomId,
          purpose: 'GRADED',
          releaseMembers: releasedMembership,
          ...(scope.assignmentId ? { assignmentId: scope.assignmentId } : {}),
          ...(scope.studentId ? { studentId: scope.studentId } : {}),
        },
      },
      select: {
        id: true,
        questionId: true,
        position: true,
        answer: true,
        attempt: {
          select: {
            id: true,
            assignmentId: true,
            studentId: true,
            submittedAt: true,
            submissionReceipt: true,
          },
        },
      },
      orderBy: { id: 'asc' },
      take: PAGE_SIZE,
    });
    for (const r of page)
      yield {
        responseId: r.id,
        attemptId: r.attempt.id,
        assignmentId: r.attempt.assignmentId,
        studentId: r.attempt.studentId,
        questionId: r.questionId,
        position: r.position,
        answer: r.answer,
        submittedAt: r.attempt.submittedAt?.toISOString() ?? null,
        receipt: r.attempt.submissionReceipt,
      };
    if (page.length < PAGE_SIZE) return;
    after = page[page.length - 1]?.id ?? null;
  }
}

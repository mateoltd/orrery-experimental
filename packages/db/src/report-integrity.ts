import type { Actor } from '@orrery/auth/types';
import type { Clock } from '@orrery/clock';
import { EVIDENCE_RULES, type EvidenceType } from '@orrery/exam-engine/evidence';
import type { PrismaClient } from './index.js';
import { ReportDenied, requireReportTeacher } from './report-access.js';

function conclusionOf(value: string): 'NO_CONCERN' | 'NOTED' | 'REVIEW' | 'VOIDED' | null {
  return value === 'NO_CONCERN' || value === 'NOTED' || value === 'REVIEW' || value === 'VOIDED'
    ? value
    : null;
}

/** Only allowlisted device facts are presented; arbitrary payload text cannot characterise intent. */
export async function readIntegrityReportFacts(
  db: PrismaClient,
  actor: Actor,
  scope: { readonly classroomId: string; readonly attemptId: string },
  clock: Clock,
) {
  await requireReportTeacher(db, actor, scope.classroomId);
  const attempt = await db.examAttempt.findFirst({
    where: { id: scope.attemptId, classroomId: scope.classroomId, purpose: 'GRADED' },
    select: {
      id: true,
      assignmentId: true,
      preflight: true,
      status: true,
      frozenAt: true,
      droppedEventCount: true,
      verdict: {
        select: {
          outcome: true,
          reason: true,
          decidedById: true,
          decidedAt: true,
          consideredAccessibilityContext: true,
        },
      },
    },
  });
  if (attempt === null) throw new ReportDenied(404);
  const entries: {
    at: number;
    type: EvidenceType;
    severity: 'INFO' | 'WARN' | 'VIOLATION';
    phrase: string;
    crossedThreshold?: number;
    droppedEventCount?: number;
  }[] = [];
  const forceExits: { at: number; phase: string }[] = [];
  let unknownEvents = 0;
  let after = 0n;
  for (;;) {
    await requireReportTeacher(db, actor, scope.classroomId);
    const page: {
      id: bigint;
      serverTs: Date;
      type: string;
      severity: 'INFO' | 'WARN' | 'VIOLATION';
      payload: unknown;
    }[] = await db.integrityEvent.findMany({
      where: { attemptId: attempt.id, id: { gt: after } },
      orderBy: { id: 'asc' },
      take: 100,
      select: { id: true, serverTs: true, type: true, severity: true, payload: true },
    });
    for (const event of page) {
      if (!Object.hasOwn(EVIDENCE_RULES, event.type)) {
        unknownEvents += 1;
        continue;
      }
      const payload =
        event.payload !== null && typeof event.payload === 'object' && !Array.isArray(event.payload)
          ? (event.payload as Record<string, unknown>)
          : {};
      entries.push({
        at: event.serverTs.getTime(),
        type: event.type as EvidenceType,
        severity: event.severity,
        phrase: event.type.toLowerCase().replace(/_/g, ' '),
        ...(event.type === 'VIOLATION_THRESHOLD_REACHED' && typeof payload.threshold === 'number'
          ? { crossedThreshold: payload.threshold }
          : {}),
        ...(typeof payload.droppedEventCount === 'number'
          ? { droppedEventCount: payload.droppedEventCount }
          : {}),
      });
      if (event.type === 'NETWORK_LOST' && payload.phase === 'final_flush') {
        forceExits.push({
          at: event.serverTs.getTime(),
          phase: 'final flush reported a network loss',
        });
      }
    }
    if (page.length < 100) break;
    after = page[page.length - 1]?.id ?? 0n;
  }
  const preflight: Record<string, string | number | boolean | null> = {};
  if (
    attempt.preflight !== null &&
    typeof attempt.preflight === 'object' &&
    !Array.isArray(attempt.preflight)
  ) {
    for (const [key, value] of Object.entries(attempt.preflight)) {
      preflight[key] =
        value === null || ['string', 'number', 'boolean'].includes(typeof value)
          ? (value as string | number | boolean | null)
          : JSON.stringify(value);
    }
  }
  const conclusion = attempt.verdict === null ? null : conclusionOf(attempt.verdict.outcome);
  return {
    facts: {
      attemptId: attempt.id,
      entries,
      preflight,
      forceExits,
      similarityClusters: [],
      isFrozen: attempt.frozenAt !== null || attempt.status === 'FROZEN',
      droppedEventCount: attempt.droppedEventCount,
    },
    sourceNotices: [
      'Only final-flush network-loss reports are persisted; an empty force-exit list does not establish that no exits occurred.',
      ...(unknownEvents > 0
        ? [`${unknownEvents} unrecognised event(s) were not displayed; evidence is incomplete.`]
        : []),
      ...(attempt.verdict !== null && conclusion === null
        ? ['The recorded verdict has an unrecognised conclusion and requires human review.']
        : []),
    ],
    verdict:
      attempt.verdict === null || conclusion === null
        ? null
        : {
            conclusion,
            reason: attempt.verdict.reason,
            authorId: attempt.verdict.decidedById,
            at: attempt.verdict.decidedAt.getTime(),
            supersedes: null,
            consideredAccessibilityContext: attempt.verdict.consideredAccessibilityContext,
          },
    similarityAvailable: false,
    computedAt: clock.now(),
  };
}

import { assertNoScoreLeak } from '@orrery/interop';
import type { PrismaClient } from './index.js';

export const RESULTS_HEADERS = Object.freeze({
  'Cache-Control': 'private, no-store',
  Vary: 'Cookie',
});
export const SEALED_RESULTS_NOTICE =
  'Submitted. Your teacher is reviewing responses. You will be notified when results are released.';
/** `plans/07` §8: a voided attempt's scores are DISCARDED. Told plainly; never "still being reviewed". */
export const VOIDED_RESULTS_NOTICE =
  'This attempt was voided, so it has no result. Contact your teacher about what happens next.';
export const ACCOMMODATION_MARKER =
  'An accommodation was in force for this attempt. Accommodations are a right.';

export interface ResultsReceipt {
  readonly attemptId: string;
  readonly submittedAt: string | null;
  readonly receiptHash: string | null;
  readonly answers: readonly { questionId: string; answer: unknown }[];
}
export interface SealedResults {
  readonly state: 'SEALED';
  readonly notice: string;
  readonly receipt: ResultsReceipt;
}
export interface ReleasedResults {
  readonly state: 'RELEASED';
  readonly receipt: ResultsReceipt;
  /** `null` only for a batch released before migration `0014`, which did not require the time. */
  readonly releasedAt: string | null;
  readonly breakdown: {
    rawTotal: number;
    maxTotal: number;
    percentage: number | null;
    finalScore: number | null;
    latePenaltyApplied: number;
    provisional: boolean;
  };
  readonly questions: readonly {
    questionId: string;
    position: number;
    score: number | null;
    max: number;
    outcome: 'CORRECT' | 'PARTIAL' | 'INCORRECT' | 'EXCUSED' | 'AWAITING_REVIEW';
    feedback: readonly string[];
    correctAnswer: string | null;
  }[];
  readonly feedback: readonly string[];
  readonly regradeNotice: string | null;
  readonly accommodationMarker: string | null;
}
export type StudentResults = SealedResults | ReleasedResults;

/** Build from an allowlist, so hidden status and hidden marking cannot change bytes or headers. */
export function sealedResults(receipt: ResultsReceipt, voided = false): SealedResults {
  const result: SealedResults = {
    state: 'SEALED',
    notice: voided
      ? VOIDED_RESULTS_NOTICE
      : receipt.submittedAt === null
        ? 'No submission has been recorded. Contact your teacher if you need help with this attempt.'
        : SEALED_RESULTS_NOTICE,
    receipt,
  };
  assertNoScoreLeak(result);
  return result;
}

export function questionOutcome(
  score: number | null,
  max: number,
  excused: boolean,
  needsHuman: boolean,
): ReleasedResults['questions'][number]['outcome'] {
  if (excused) return 'EXCUSED';
  if (needsHuman || score === null) return 'AWAITING_REVIEW';
  if (score >= max && max > 0) return 'CORRECT';
  return score > 0 ? 'PARTIAL' : 'INCORRECT';
}

export function permittedAnswer(
  policySnapshot: unknown,
  modelAnswer: string | null,
  spec: unknown,
): string | null {
  if (
    policySnapshot === null ||
    typeof policySnapshot !== 'object' ||
    (policySnapshot as Record<string, unknown>).showCorrectAnswersAfterRelease !== true
  )
    return null;
  if (modelAnswer !== null) return modelAnswer;
  if (spec === null || typeof spec !== 'object') return null;
  const key = (spec as Record<string, unknown>).key;
  return key === undefined ? null : JSON.stringify(key);
}

/** Ownership and per-membership release are predicates of the grade query, never assignment-wide. */
export async function loadStudentResults(
  db: Pick<PrismaClient, 'examAttempt'>,
  studentId: string,
  attemptId: string,
): Promise<StudentResults | null> {
  const publicAttempt = await db.examAttempt.findFirst({
    where: { id: attemptId, studentId, purpose: 'GRADED' },
    select: {
      id: true,
      status: true,
      submittedAt: true,
      submissionReceipt: true,
      responses: {
        orderBy: { position: 'asc' },
        select: { questionId: true, answer: true },
      },
    },
  });
  if (publicAttempt === null) return null;
  const receipt: ResultsReceipt = {
    attemptId: publicAttempt.id,
    submittedAt: publicAttempt.submittedAt?.toISOString() ?? null,
    receiptHash: publicAttempt.submissionReceipt,
    answers: publicAttempt.responses.map(({ questionId, answer }) => ({ questionId, answer })),
  };
  const released = await db.examAttempt.findFirst({
    where: {
      id: attemptId,
      studentId,
      purpose: 'GRADED',
      // Voiding after release must take the marks back down, not leave discarded scores on show.
      status: { not: 'VOIDED' },
      releaseMembers: { some: { batch: { status: 'RELEASED' } } },
    },
    select: {
      finalScore: true,
      maxScore: true,
      percentage: true,
      latePenaltyApplied: true,
      policySnapshot: true,
      relaxationsApplied: true,
      accommodationId: true,
      showAccommodationOnResults: true,
      regradeNoticePendingAt: true,
      releaseMembers: {
        where: { batch: { status: 'RELEASED' } },
        orderBy: { batch: { releasedAt: 'asc' } },
        take: 1,
        select: { batch: { select: { releasedAt: true } } },
      },
      responses: {
        orderBy: { position: 'asc' },
        select: {
          questionId: true,
          position: true,
          isExcused: true,
          needsHuman: true,
          manualScore: true,
          autoScore: true,
          manualFeedback: true,
          question: {
            select: {
              points: true,
              modelAnswer: true,
              spec: true,
            },
          },
          feedback: {
            where: { visibility: 'STUDENT_AFTER_RELEASE', isDraft: false },
            orderBy: { createdAt: 'asc' },
            select: { body: true },
          },
        },
      },
      feedback: {
        where: { visibility: 'STUDENT_AFTER_RELEASE', isDraft: false, responseId: null },
        orderBy: { createdAt: 'asc' },
        select: { body: true },
      },
    },
  });
  if (released === null) return sealedResults(receipt, publicAttempt.status === 'VOIDED');
  // A legacy batch with no release time is still released; throwing here was a 500 for results
  // the student is entitled to, and a status code that differed by batch age.
  const releasedAt = released.releaseMembers[0]?.batch.releasedAt ?? null;
  const questions = released.responses.map((response) => {
    const mark = response.manualScore ?? response.autoScore;
    const score = mark === null ? null : Number(mark);
    const max = Number(response.question.points);
    return {
      questionId: response.questionId,
      position: response.position,
      score: response.isExcused ? null : score,
      max,
      outcome: questionOutcome(score, max, response.isExcused, response.needsHuman),
      feedback: [
        ...(response.manualFeedback === null ? [] : [response.manualFeedback]),
        ...response.feedback.map((f) => f.body),
      ],
      correctAnswer: permittedAnswer(
        released.policySnapshot,
        response.question.modelAnswer,
        response.question.spec,
      ),
    };
  });
  return {
    state: 'RELEASED',
    receipt,
    releasedAt: releasedAt === null ? null : releasedAt.toISOString(),
    questions,
    breakdown: {
      rawTotal: questions.reduce(
        (sum, q) => sum + (q.outcome === 'EXCUSED' ? 0 : (q.score ?? 0)),
        0,
      ),
      maxTotal: Number(released.maxScore ?? 0),
      percentage: released.percentage === null ? null : Number(released.percentage),
      finalScore: released.finalScore === null ? null : Number(released.finalScore),
      latePenaltyApplied: Number(released.latePenaltyApplied ?? 0),
      provisional: questions.some((q) => q.outcome === 'AWAITING_REVIEW'),
    },
    feedback: released.feedback.map((f) => f.body),
    regradeNotice:
      released.regradeNoticePendingAt === null
        ? null
        : 'Your results were updated. Contact your teacher if you have questions.',
    accommodationMarker:
      released.showAccommodationOnResults &&
      (released.relaxationsApplied.length > 0 || released.accommodationId !== null)
        ? ACCOMMODATION_MARKER
        : null,
  };
}

export async function setResultsAccommodationVisibility(
  db: Pick<PrismaClient, 'examAttempt'>,
  studentId: string,
  attemptId: string,
  visible: boolean,
) {
  return db.examAttempt.updateMany({
    where: { id: attemptId, studentId },
    data: { showAccommodationOnResults: visible },
  });
}

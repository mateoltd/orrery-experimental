import { type ComputedScore, computeScore, type ScoredResponse } from './release.js';

export const FORM_DIFFERENCE_COPY =
  'Students in this assessment did not all receive the same questions. Forms differed slightly in difficulty. We report how much, so you can read a score difference of less than that amount as meaning nothing.';

export interface LedgerAssignment {
  readonly id: string;
  readonly title: string;
  readonly weight: number;
  readonly dueAt: number | null;
  readonly latePenaltyPercent: number;
  readonly possibleItemCount: number | null;
}

export interface LedgerAttempt {
  readonly id: string;
  readonly assignmentId: string;
  readonly status: string;
  readonly isLate: boolean;
  readonly submittedAt: number | null;
  readonly variantMap: unknown;
  /** Only supplied by the membership-gated query, never by the metadata query. */
  readonly releasedResponses: readonly ScoredResponse[] | null;
}

export interface LedgerCell {
  readonly assignmentId: string;
  readonly assignment: string;
  readonly weight: number;
  readonly attemptId: string | null;
  readonly flag: 'onTime' | 'late' | 'missing' | 'excused' | 'void' | 'pending';
  readonly state: 'RELEASED' | 'SEALED' | 'NO_ATTEMPT' | 'EXCLUDED';
  readonly score: ComputedScore | null;
  readonly scoreNotice: string;
  readonly variant: { readonly questionIds: readonly string[]; readonly label: string };
  readonly formMean: number | null;
  readonly formVariabilitySd: number | null;
  readonly formNotice: string;
  readonly computedAt: number;
}

export interface LedgerRow {
  readonly studentId: string;
  readonly student: string;
  readonly cells: readonly LedgerCell[];
  readonly total: {
    readonly percentage: number | null;
    readonly includedWeight: number;
    readonly pendingWeight: number;
    readonly excusedWeight: number;
    readonly isProvisional: boolean;
    readonly computedAt: number;
  };
}

/** Read the recorded draw; malformed or absent records never fall back to the shared paper. */
export function resolvedVariant(map: unknown, possible: number | null): LedgerCell['variant'] {
  if (map === null || typeof map !== 'object' || Array.isArray(map)) {
    return { questionIds: [], label: 'Resolved variant unavailable' };
  }
  const entries = Object.entries(map).sort(([a], [b]) => Number(a) - Number(b));
  if (
    entries.length === 0 ||
    entries.some(
      ([slot, ids]) =>
        !/^\d+$/.test(slot) || !Array.isArray(ids) || ids.some((id) => typeof id !== 'string'),
    )
  )
    return { questionIds: [], label: 'Resolved variant unavailable' };
  const questionIds = entries.flatMap(([, ids]) => ids as string[]);
  return {
    questionIds,
    label:
      possible === null
        ? `Saw ${questionIds.length} items; possible pool size unavailable`
        : `Saw ${questionIds.length} of a possible ${possible}-item pool`,
  };
}

/** Unanswered questions still contribute their resolved maximum, never a fabricated answer row. */
export function completePaperResponses(
  map: unknown,
  responses: readonly ScoredResponse[],
  points: ReadonlyMap<string, number>,
): readonly ScoredResponse[] {
  const present = new Set(responses.map((r) => r.questionId));
  const absent = resolvedVariant(map, null).questionIds.filter((id) => !present.has(id));
  return [
    ...responses,
    ...absent.flatMap((questionId): ScoredResponse[] => {
      const maximum = points.get(questionId);
      if (maximum === undefined || !Number.isFinite(maximum) || maximum < 0) return [];
      return [{ questionId, points: maximum, finalScore: 0, isExcused: false, needsHuman: false }];
    }),
  ];
}

/** Totals stay unavailable while weighted work is missing, sealed, void, or provisional. */
export function buildLedgerRow(input: {
  readonly studentId: string;
  readonly student: string;
  readonly assignments: readonly LedgerAssignment[];
  readonly attempts: readonly LedgerAttempt[];
  readonly computedAt: number;
}): LedgerRow {
  const cells = input.assignments.map((assignment): LedgerCell => {
    if (!Number.isFinite(assignment.weight) || assignment.weight < 0) {
      throw new Error('assignment weight must be finite and nonnegative');
    }
    const attempt = input.attempts.find((a) => a.assignmentId === assignment.id);
    const flag =
      attempt?.status === 'EXCUSED'
        ? 'excused'
        : attempt?.status === 'VOIDED'
          ? 'void'
          : attempt?.submittedAt !== null && attempt?.submittedAt !== undefined
            ? attempt.isLate
              ? 'late'
              : 'onTime'
            : assignment.dueAt !== null && assignment.dueAt < input.computedAt
              ? 'missing'
              : 'pending';
    const excluded = flag === 'excused' || flag === 'void';
    const released =
      attempt?.releasedResponses !== null && attempt?.releasedResponses !== undefined;
    const variant = resolvedVariant(attempt?.variantMap, assignment.possibleItemCount);
    const expectedIds = new Set(variant.questionIds);
    const responseIds = new Set(attempt?.releasedResponses?.map((r) => r.questionId) ?? []);
    const incompletePaper =
      released &&
      (expectedIds.size === 0 ||
        expectedIds.size !== variant.questionIds.length ||
        expectedIds.size !== responseIds.size ||
        responseIds.size !== attempt.releasedResponses.length ||
        !variant.questionIds.every((id) => responseIds.has(id)));
    const score =
      !excluded && released && !incompletePaper
        ? computeScore({
            // A stale mark on a `NEEDS_HUMAN` response cannot count toward earned credit.
            responses: attempt.releasedResponses.map((r) => ({
              ...r,
              finalScore: r.needsHuman ? null : r.finalScore,
            })),
            isLate: attempt.isLate,
            latePenaltyPercent: assignment.latePenaltyPercent,
          })
        : null;
    return {
      assignmentId: assignment.id,
      assignment: assignment.title,
      weight: assignment.weight,
      attemptId: attempt?.id ?? null,
      flag,
      state: excluded
        ? 'EXCLUDED'
        : attempt === undefined
          ? 'NO_ATTEMPT'
          : released
            ? 'RELEASED'
            : 'SEALED',
      score,
      scoreNotice:
        !excluded && incompletePaper
          ? 'Score unavailable: the resolved paper records are incomplete; a missing question must not shrink the maximum.'
          : score?.finalScore === null
            ? 'No percentage is available because all possible points are excused or zero.'
            : '',
      variant,
      formMean: null,
      formVariabilitySd: null,
      formNotice:
        'Form mean and variability have not been computed; score differences cannot be interpreted as equivalent forms.',
      computedAt: input.computedAt,
    };
  });
  let includedWeight = 0;
  let pendingWeight = 0;
  let excusedWeight = 0;
  let weighted = 0;
  let isProvisional = false;
  for (const cell of cells) {
    if (cell.flag === 'excused') {
      excusedWeight += cell.weight;
      continue;
    }
    if (cell.weight === 0) continue;
    if (cell.score?.finalScore === null || cell.score === null || cell.score.isProvisional) {
      pendingWeight += cell.weight;
      isProvisional ||= cell.score?.isProvisional === true;
      continue;
    }
    includedWeight += cell.weight;
    weighted += cell.score.finalScore * cell.weight;
  }
  return {
    studentId: input.studentId,
    student: input.student,
    cells,
    total: {
      percentage:
        pendingWeight > 0 || includedWeight === 0
          ? null
          : Math.round((weighted / includedWeight) * 100) / 100,
      includedWeight,
      pendingWeight,
      excusedWeight,
      isProvisional,
      computedAt: input.computedAt,
    },
  };
}

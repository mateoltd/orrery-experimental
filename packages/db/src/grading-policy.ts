/** Pure refusals shared by single and bulk marking. Presence is advisory; `basedOn` is mandatory. */
export type GradingAction =
  | { kind: 'SCORE'; points: number; feedback: string; quickScored?: boolean }
  | { kind: 'EXCUSE'; reason: string }
  | {
      kind: 'FEEDBACK';
      body: string;
      visibility: 'TEACHER_ONLY' | 'STUDENT_AFTER_RELEASE';
      isDraft: boolean;
    }
  | {
      kind: 'VOID';
      reason: string;
      humanConfirmed: boolean;
      consideredAccessibilityContext: boolean;
    };

export interface MarkFacts {
  revision: number;
  status: string;
  released: boolean;
  releasing: boolean;
  points: number;
  sealedAutomatic: boolean;
}

export type MarkRefusal =
  | 'CONFLICT'
  | 'RELEASED_REQUIRES_REGRADE'
  | 'RELEASE_IN_PROGRESS'
  | 'RELEASE_MEMBERSHIP_CHANGED'
  | 'NOT_REVIEWABLE'
  | 'SEALED_AUTOMATIC'
  | 'INVALID_SCORE'
  | 'REASON_REQUIRED'
  | 'HUMAN_VERDICT_REQUIRED'
  | 'INVALID_FEEDBACK';

/** A comment is not a file store. The cap is far above a long paragraph per question and far below a pasted essay per paper. */
export const FEEDBACK_MAX_CHARS = 10_000;

export interface FeedbackContent {
  body: string;
  visibility: string;
  isDraft: boolean;
}

const validFeedback = (next: FeedbackContent): boolean =>
  ['TEACHER_ONLY', 'STUDENT_AFTER_RELEASE'].includes(next.visibility) &&
  typeof next.isDraft === 'boolean' &&
  typeof next.body === 'string' &&
  next.body.length <= FEEDBACK_MAX_CHARS &&
  (next.isDraft || next.body.trim() !== '');

/** The one rule for "a student can read this", shared by the write refusal and the read gate. */
const studentFacing = (feedback: { visibility: string; isDraft: boolean }): boolean =>
  feedback.visibility === 'STUDENT_AFTER_RELEASE' && !feedback.isDraft;

export interface FeedbackFacts {
  status: string;
  released: boolean;
  releasing: boolean;
  /** The row being edited, or `null` for a new comment. */
  previous: { visibility: string; isDraft: boolean } | null;
}

export type FeedbackRefusal =
  | 'INVALID_FEEDBACK'
  | 'NOT_REVIEWABLE'
  | 'STUDENT_FEEDBACK_AFTER_RELEASE'
  | 'RELEASE_IN_PROGRESS';

/**
 * Once a paper is released, or frozen for release, what its student can read does not change.
 *
 * The read gate is computed, so a comment saved after release was on the student's results page the moment it
 * committed: no notice, no history, and during `RELEASING` no review either. Teacher-only notes and drafts stay
 * writable, because nothing a student sees moves. The cost is that a typo in released feedback cannot be corrected
 * until there is a notice to send with the correction.
 */
export const decideFeedbackWrite = (
  facts: FeedbackFacts,
  next: FeedbackContent,
): FeedbackRefusal | null => {
  if (!validFeedback(next)) return 'INVALID_FEEDBACK';
  if (!['SUBMITTED', 'EXPIRED', 'PENDING_REVIEW', 'GRADED'].includes(facts.status))
    return 'NOT_REVIEWABLE';
  const moves = studentFacing(next) || (facts.previous !== null && studentFacing(facts.previous));
  if (moves && facts.released) return 'STUDENT_FEEDBACK_AFTER_RELEASE';
  if (moves && facts.releasing) return 'RELEASE_IN_PROGRESS';
  return null;
};

export const decideGradingWrite = (
  facts: MarkFacts,
  basedOn: string,
  action: GradingAction,
): MarkRefusal | null => {
  if (basedOn !== String(facts.revision)) return 'CONFLICT';
  if (facts.released) return 'RELEASED_REQUIRES_REGRADE';
  if (facts.releasing) return 'RELEASE_IN_PROGRESS';
  if (!['SUBMITTED', 'EXPIRED', 'PENDING_REVIEW', 'GRADED'].includes(facts.status))
    return 'NOT_REVIEWABLE';
  if (action.kind === 'SCORE') {
    if (facts.sealedAutomatic) return 'SEALED_AUTOMATIC';
    // Reject extra precision: silently rounding a mark changes what the teacher believes they saved.
    if (
      !Number.isFinite(action.points) ||
      action.points < 0 ||
      action.points > facts.points ||
      Math.abs(action.points * 100 - Math.round(action.points * 100)) > 1e-7
    )
      return 'INVALID_SCORE';
  }
  if ((action.kind === 'EXCUSE' || action.kind === 'VOID') && action.reason.trim() === '')
    return 'REASON_REQUIRED';
  if (action.kind === 'VOID' && !action.humanConfirmed) return 'HUMAN_VERDICT_REQUIRED';
  if (action.kind === 'FEEDBACK' && !validFeedback(action)) return 'INVALID_FEEDBACK';
  return null;
};

export const feedbackVisibleToStudent = (input: {
  releasedMembership: boolean;
  visibility: string;
  isDraft: boolean;
}): boolean => input.releasedMembership && studentFacing(input);

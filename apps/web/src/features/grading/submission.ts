/**
 * From a draft to what is sent, and from what was sent to what the screen then shows.  (P9-T2)
 *
 * ## A DRAFT IS NOT SAVABLE JUST BECAUSE IT EXISTS
 *
 * `buildSubmission` is the last place a mark can be stopped before it leaves the browser, and it refuses three
 * things: a mark that is not a mark (`parseMark` -- empty, not a number, below zero, above the question's points), an
 * excuse with no reason, and any attempt to write a mark onto a sealed auto-grade. Each refusal names the FIELD, so
 * the workspace can put focus there instead of showing a message the teacher has to hunt for.
 *
 * It is not the enforcement. A browser can be told anything; the server has to refuse the same things, and
 * `rubric.ts` is written without web imports so that it can.
 *
 * ## WHY AN EXCUSE NEEDS A REASON HERE WHEN THE PLAN ONLY SAYS "`E` EXCUSE"
 *
 * `E` is directly below `3` and `4` on a keyboard, in a workflow that is "digit, Enter, digit, Enter". One slip
 * excuses a question -- which removes it from BOTH sums in `computeScore` and so changes a percentage -- and the next
 * `Enter` saves it. A required reason turns that slip into a refusal with focus in an empty reason field. It is also
 * the record `plans/07` §8 asks every such transition to leave.
 */

import { EMPTY_DRAFT, type MarkDraft, sameDraft } from './draft';
import { canAcceptAutomaticMark, isMarkable, type ResponseFacts } from './markingState';
import { parseMark } from './rubric';

interface SubmissionCommon {
  readonly responseId: string;
  readonly questionId: string;
  /** The version the teacher was looking at. P9-T8's optimistic lock compares it; this lane only carries it. */
  readonly basedOn: string;
  readonly flagged: boolean;
}

export type MarkSubmission =
  | (SubmissionCommon & {
      readonly resolution: 'MARK';
      readonly points: number;
      readonly feedback: string;
      readonly bandId: string | null;
      readonly quickScored: boolean;
    })
  | (SubmissionCommon & {
      readonly resolution: 'EXCUSE';
      readonly reason: string;
      readonly feedback: string;
    })
  /** Keep the grader's raw score, deduction included. Writes no `manualScore`. */
  | (SubmissionCommon & { readonly resolution: 'ACCEPT_AUTO_MARK'; readonly feedback: string })
  /** A sealed response: the only thing a teacher can change is the flag. */
  | (SubmissionCommon & { readonly resolution: 'FLAG_ONLY' });

export type SubmissionField = 'score' | 'excuseReason';

export type BuiltSubmission =
  | { readonly ok: true; readonly submission: MarkSubmission }
  /** Nothing differs from what is stored. Not an error: "save and advance" simply advances. */
  | { readonly ok: true; readonly submission: null }
  | { readonly ok: false; readonly field: SubmissionField; readonly message: string };

export type SaveMarkResult =
  /** `version` is the response's new version, when the server returns one. */
  | { readonly ok: true; readonly version?: string }
  | { readonly ok: false; readonly reason: string };

/** The draft a response opens with: the saved mark if there is one, otherwise nothing. */
export const initialDraftFor = (facts: ResponseFacts): MarkDraft => ({
  ...EMPTY_DRAFT,
  score: facts.manual === null ? '' : String(facts.manual.points),
  bandId: facts.manual?.bandId ?? null,
  feedback: facts.manual?.feedback ?? '',
  excused: facts.isExcused,
  flagged: facts.flagged,
});

export const buildSubmission = (
  facts: ResponseFacts,
  draft: MarkDraft,
  excuseReasonRequired: string,
): BuiltSubmission => {
  const common: SubmissionCommon = {
    responseId: facts.responseId,
    questionId: facts.questionId,
    basedOn: facts.version,
    flagged: draft.flagged,
  };

  if (!isMarkable(facts)) {
    // SEALED. Whatever else is in the draft, only the flag can be sent -- this is the check that stops a stale or
    // hand-edited draft from carrying a mark onto an auto-grade.
    return draft.flagged === facts.flagged
      ? { ok: true, submission: null }
      : { ok: true, submission: { ...common, resolution: 'FLAG_ONLY' } };
  }

  if ((facts.manual !== null || facts.isExcused) && sameDraft(draft, initialDraftFor(facts))) {
    // ALREADY DECIDED AND NOT TOUCHED. Re-sending an unchanged mark would write a new `gradedAt` and a new audit
    // row for a decision nobody made, every time a teacher pressed Enter to move past a response they had marked.
    return { ok: true, submission: null };
  }

  if (draft.excused) {
    const reason = draft.excuseReason.trim();
    if (reason === '') return { ok: false, field: 'excuseReason', message: excuseReasonRequired };
    return {
      ok: true,
      submission: { ...common, resolution: 'EXCUSE', reason, feedback: draft.feedback },
    };
  }

  if (draft.acceptAuto && canAcceptAutomaticMark(facts)) {
    return {
      ok: true,
      submission: { ...common, resolution: 'ACCEPT_AUTO_MARK', feedback: draft.feedback },
    };
  }

  const mark = parseMark(draft.score, facts.spec.points);
  if (!mark.ok) return { ok: false, field: 'score', message: mark.message };

  return {
    ok: true,
    submission: {
      ...common,
      resolution: 'MARK',
      points: mark.points,
      feedback: draft.feedback,
      bandId: draft.bandId,
      quickScored: draft.quickScored,
    },
  };
};

/**
 * WHAT THE RESPONSE LOOKS LIKE ONCE THE SERVER HAS ACKNOWLEDGED A SUBMISSION.
 *
 * So the workspace can move on to the next response awaiting a mark without a refetch, and so the one just marked
 * stops being counted as awaiting. It is applied ONLY after an acknowledgement -- never optimistically -- and it is
 * dropped as soon as the caller supplies facts with a different version, because the server's account wins.
 */
export const applyAcknowledged = (
  facts: ResponseFacts,
  submission: MarkSubmission,
  version: string | undefined,
): ResponseFacts => {
  const base: ResponseFacts = {
    ...facts,
    flagged: submission.flagged,
    version: version ?? facts.version,
  };
  switch (submission.resolution) {
    case 'MARK':
      return {
        ...base,
        isExcused: false,
        needsHuman: false,
        manual: {
          points: submission.points,
          feedback: submission.feedback,
          bandId: submission.bandId,
        },
      };
    case 'EXCUSE':
      return { ...base, isExcused: true };
    case 'ACCEPT_AUTO_MARK':
      return {
        ...base,
        isExcused: false,
        needsHuman: false,
        // The referral is what was resolved. The raw score is untouched: that is the point of accepting.
        auto:
          facts.auto === null
            ? null
            : { ...facts.auto, flags: facts.auto.flags.filter((flag) => flag !== 'NEEDS_HUMAN') },
      };
    case 'FLAG_ONLY':
      return base;
    default: {
      const exhaustive: never = submission;
      return exhaustive;
    }
  }
};

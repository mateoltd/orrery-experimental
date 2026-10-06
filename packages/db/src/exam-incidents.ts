/**
 * IN-EXAM INCIDENT REPORTS: the channel pilot defects arrive through.  (P17-T5, reporting half)
 *
 * A student telling us something is wrong DURING the exam -- a broken question, a sim that will not
 * load, a typo, a timing problem. Without this, `P17-T4`'s "every defect triaged to fixed" has no
 * intake: pilot defects arrive as hallway complaints, which is to say they do not arrive.
 *
 * ## RULES, EACH WITH ITS REASON
 *
 * - **Own attempt only.** The reporter must own the attempt, checked the same way `submitAnswer` checks
 *   it (attempt row with matching student id). A report about somebody else's exam is either a mistake
 *   or a probe, and neither belongs in the triage queue.
 * - **`OTHER` requires `detail`.** A queue cannot act on "other", full stop -- same rule as flags.
 * - **Reports are NEVER deduplicated.** Two identical reports may be a double-submit or two sightings of
 *   an intermittent failure; dropping the second reads an intermittent sim failure as one confused
 *   student. The triage queue dedupes with judgement, which is what triage is for.
 * - **No answer content is read or stored.** The report carries questionId (which question), never the
 *   answer -- the function does not even accept an answer field, so there is nothing to leak.
 */

import type { PrismaClient } from './index.js';

export const INCIDENT_REASONS = [
  'BROKEN_QUESTION',
  'SIM_WONT_LOAD',
  'TYPO',
  'TIMING',
  'OTHER',
] as const;
export type IncidentReason = (typeof INCIDENT_REASONS)[number];

export interface ReportIncidentInput {
  readonly attemptId: string;
  readonly questionId?: string;
  readonly reason: string;
  readonly detail?: string;
}

export type ReportIncidentOutcome =
  | { readonly ok: true; readonly id: string }
  | { readonly ok: false; readonly httpStatus: 403 | 404 | 400; readonly reason: string };

export async function reportIncident(
  db: PrismaClient,
  reporterId: string,
  input: ReportIncidentInput,
): Promise<ReportIncidentOutcome> {
  if (!INCIDENT_REASONS.includes(input.reason as IncidentReason)) {
    return { ok: false, httpStatus: 400, reason: 'unknown reason' };
  }
  if (input.reason === 'OTHER' && (input.detail ?? '').trim().length === 0) {
    return { ok: false, httpStatus: 400, reason: 'OTHER needs detail a triager can act on' };
  }
  const attempt = await db.examAttempt.findFirst({
    where: { id: input.attemptId, studentId: reporterId },
    select: { id: true },
  });
  if (attempt === null) {
    return { ok: false, httpStatus: 404, reason: 'no such attempt of yours' };
  }
  if (input.questionId !== undefined) {
    const response = await db.questionResponse.findFirst({
      where: { attemptId: input.attemptId, questionId: input.questionId },
      select: { id: true },
    });
    if (response === null) {
      return { ok: false, httpStatus: 404, reason: 'no such question on this attempt' };
    }
  }
  const created = await db.examIncident.create({
    data: {
      attemptId: input.attemptId,
      questionId: input.questionId ?? null,
      reporterId,
      reason: input.reason as IncidentReason,
      detail: input.detail ?? null,
    },
    select: { id: true },
  });
  return { ok: true, id: created.id };
}

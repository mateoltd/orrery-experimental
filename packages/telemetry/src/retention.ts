/**
 * WHERE TELEMETRY IS RETAINED, WHO MAY READ IT, AND WHAT IT IS NOT GATED ON.  (P14-T14, `14` §7)
 *
 * ## THE THREE QUESTIONS, ANSWERED AS CODE BECAUSE A PARAGRAPH IS NOT A CONTROL
 *
 * `INV-TELEMETRY-2` — telemetry carries no content and no PII — says nothing about any of the three. Retention, readers
 * and release coupling are the questions a data-protection answer actually turns on, and `14` §7.2's table is a
 * specification of intent for two of them and silent on the third. So they are data here, and the test reads the data.
 *
 * ## RETENTION: 400 DAYS, THEN AGGREGATE AND DELETE  (`14` §7.2)
 *
 * The first row of that table, unchanged. What is added here is the arithmetic and the reason for the shape of the
 * answer: the decision is a function of ONE stored instant and the injected clock, so it is testable without a database,
 * and the sweep that performs the aggregation is `P14-T6` — which is a promise today, because
 * `apps/worker/src/index.ts` throws `not implemented — P14-T6`. **Naming that here is not a hedge; it is the honest
 * boundary of this file.** `retentionDecision` decides, and something else has to act.
 *
 * ## READERS: `can(actor, 'viewEvidence', 'IntegrityEvidence', …)`, AND NOT A SECOND LIST
 *
 * The matrix already answers it: `packages/auth/src/matrix.ts:916-923` grants evidence to the classroom's owner and its
 * staff and to reviewers, and refuses everyone else. This module calls that kernel rather than describing it, because a
 * second reader list in a second package is the exact failure `plans/03` §3.4 records — code and plan disagreeing about
 * who may see what, with the code right.
 *
 * **THE STUDENT IS NOT A READER, AND THAT IS THE ANSWER TO "is this a PII store?"** A student's own telemetry is about
 * their own sitting, and it is retained for 400 days, read by staff, and never handed back. `14` §7.3's access and export
 * right is the mechanism for a student to obtain it, and it goes through a background job and a signed expiring link —
 * not through this predicate.
 *
 * ## IT IS NOT GATED ON RELEASE, AND THE REASON IS NOT COMFORT
 *
 * `INV-RELEASE-2` withholds a MARK before release. Telemetry carries no mark — `findScoreBearingKeys` on an evidence
 * row is clean, and `scripts/audit-telemetry-leak.mjs` is the gate that keeps it so — so release-gating it would gate
 * nothing. It would also cost two things:
 *
 *   · **A teacher could not act on an unreleased exam.** The whole purpose of the record is the decision, and the
 *     decision has to be available before the release, not after.
 *   · **Release state would become observable to a student.** If a student's evidence were unreadable until their marks
 *     were published, then "can my teacher see my evidence" answers "are my marks out", which is a release oracle over
 *     a live assessment — a new IDOR that would have been introduced by adding a control.
 *
 * So release is NOT consulted here, and that absence is deliberate. If a future change makes telemetry carry anything
 * derivable from a mark, this file has to change with it.
 */

import { type Actor, type CanInput, can, type Decision } from '@orrery/auth/can';
import { DAY, HOUR, MINUTE, type Millis } from '@orrery/clock';

/** `14` §7.2, first row. Integrity telemetry: 400 days, then aggregated to counts and deleted. */
export const TELEMETRY_RETENTION_DAYS = 400;

/**
 * `plans/09` §7: drop events arriving more than two hours after the attempt ended.
 *
 * **TWO HOURS IS ALSO THE CEILING ON THE SIGNATURE'S WORTH.** A batch signed after a student finished their paper can
 * be assembled entirely from what they saw; the freshness bound is what stops the signature from being a licence to
 * submit an hour-old sitting as though it were live. It is a bound on how old a signed claim may be, not a tolerance.
 */
export const TELEMETRY_LATE_ARRIVAL_WINDOW: Millis = 2 * HOUR;

/**
 * `plans/09` §7: clamp `clientTs` to ±5 minutes of `serverTs`, and RECORD the clamp.
 *
 * The clamp rather than a rejection, for the reason §7 gives for the whole pipeline: telemetry may be incomplete and
 * that is acceptable. A student whose laptop slept for an hour mid-exam gets a clamped timestamp rather than no
 * timestamp, and the timeline stays readable. What must not happen is a student choosing their own `serverTs`, which is
 * why the stored row carries the server's stamp and the clamp count beside the client value rather than instead of it.
 */
export const TELEMETRY_CLOCK_SKEW_WINDOW: Millis = 5 * MINUTE;

/** The instant a row's retention clock starts: when the SERVER received it, not when the client says it happened. */
export const TELEMETRY_RETENTION_MS: Millis = TELEMETRY_RETENTION_DAYS * DAY;

export type TelemetryRetentionDecision =
  /** Inside the window. Keep the row exactly as stored. */
  | 'KEEP'
  /**
   * Past 400 days. Aggregate to per-type counts, then delete the row.
   *
   * "Aggregate THEN delete" is the order the table states and it matters: a sweep that deletes first has destroyed the
   * evidence it was going to aggregate from, so the counts would have to be invented.
   */
  | 'AGGREGATE_AND_DELETE';

/**
 * The retention decision for one row, as a function of two instants.
 *
 * `receivedAt` is the SERVER's stamp rather than the client's `at`, because a retention clock measured against a
 * client-supplied instant is a clock a client sets — the same defect `TM-04` records for the impersonation window, and
 * the same fix: the value that decides how long we keep somebody's data comes from us.
 */
export const retentionDecision = (receivedAt: Millis, now: Millis): TelemetryRetentionDecision =>
  now - receivedAt <= TELEMETRY_RETENTION_MS ? 'KEEP' : 'AGGREGATE_AND_DELETE';

/** The reader gate, as a call into the one authorisation kernel rather than a table beside it. */
export const mayReadTelemetry = (input: Omit<CanInput, 'action'>): Decision =>
  can({ ...input, action: 'viewEvidence' });

/**
 * A reader gate that cannot be satisfied by a missing `IntegrityEvidence` subject.
 *
 * Typed so the caller cannot pass `type: 'ExamAttempt'` and read a mark through the evidence predicate. The kernel would
 * happily evaluate that — it has rules for `ExamAttempt` and `viewEvidence` on it — and the difference between the two is
 * the whole of `INV-RELEASE-2`, so the predicate this module offers must not be a way to ask about anything else.
 */
export interface TelemetryReadRequest {
  readonly actor: Actor | null;
  /** The classroom the evidence belongs to. Required: every evidence rule is classroom-scoped. */
  readonly classroomId: string;
  readonly attemptId: string;
  readonly context?: CanInput['context'];
}

export const mayReadAttemptTelemetry = (request: TelemetryReadRequest): Decision =>
  mayReadTelemetry({
    actor: request.actor,
    subject: {
      type: 'IntegrityEvidence',
      id: request.attemptId,
      owningClassroomId: request.classroomId,
    },
    context: {
      scopeClassroomId: request.classroomId,
      ...request.context,
    },
  });

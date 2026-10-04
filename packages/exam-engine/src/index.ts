/**
 * `@orrery/exam-engine` -- the exam runtime's evaluation layer.
 *
 * See `escalation.ts` for why the package exists and what consolidation is still outstanding, `deadlines.ts` for the
 * per-question evaluation, and P8-T1's tracker row for the boundary work that remains.
 */

export type {
  AttemptFacts,
  AttemptVerdict,
  QuestionFacts,
  QuestionState,
  QuestionVerdict,
} from './deadlines.js';
export { evaluateAttempt } from './deadlines.js';
export type {
  AttemptTransition,
  BreachReport,
  EscalationInput,
  EscalationVerdict,
  Rung,
  RungEffect,
  TeacherDecision,
  ViolationCounts,
  ViolationKind,
} from './escalation.js';
export {
  applyRung,
  classifyBreaches,
  countStrike,
  evaluateEscalation,
  LADDER,
  maxRung,
  reinstate,
  rungIndex,
  survivesShedding,
} from './escalation.js';

export type {
  BatcherOptions,
  BatcherStats,
  BatchTransport,
  EventRule,
  EvidenceRecord,
  EvidenceType,
  Severity,
  SignedBatch,
  StrikePolicyView,
} from './evidence.js';
export {
  batchSigningInput,
  canonicalEvent,
  countsAsStrike,
  EVIDENCE_RULES,
  EvidenceBatcher,
  SERVER_ONLY_EVENTS,
} from './evidence.js';
export type {
  BulkClaimResult,
  ClaimOutcome,
  ClaimRefusal,
  QueueCounts,
  QueueFilter,
  ReviewerScope,
  ReviewQueueEntry,
  ReviewTaskStatus,
} from './review-queue.js';
export {
  ageIndicator,
  bulkClaim,
  canClaim,
  compareQueueEntries,
  matchesFilter,
  queueCounts,
} from './review-queue.js';
export type {
  PreflightReport,
  PreflightVerdict,
  QuestionDeadlineDto,
  Relaxation,
  SessionCheck,
  SessionFacts,
  SessionRefusal,
} from './session.js';
export { buildSyncPayload, checkSession, evaluatePreflight } from './session.js';
export type { OverflowResponse, WriteClass, WritePath } from './shedding.js';
/**
 * `P8-T9b`: the shedding policy. Exported because a write path in another package has to be able to ask whether it may
 * shed, and a rule that can only be read in one file is a rule the next write path will not read.
 */
export {
  mayShed,
  NEVER_SHED,
  overflowResponseFor,
  SHEDDABLE,
  SHEDDING_DOCTRINE,
  WRITE_PATHS,
  writeClassOfEvidence,
} from './shedding.js';

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
  BreachReport,
  EscalationInput,
  EscalationVerdict,
  Rung,
  ViolationCounts,
  ViolationKind,
} from './escalation.js';
export {
  classifyBreaches,
  evaluateEscalation,
  LADDER,
  maxRung,
  rungIndex,
} from './escalation.js';

/**
 * `@orrery/analytics` -- item analysis.  (P11-T1)
 *
 * Every module here carries the review correction it implements, because each one corrected something in `plans/08`
 * that was wrong in a way that would have produced a confident, misleading number.
 */

export type { CorrelationWithCi, DiscriminationResult, ItemOutcome } from './discrimination.js';
export {
  ACCEPTANCE_FLOOR,
  correctedD,
  correlationWithCi,
  isFlaggedForDiscrimination,
  pearson,
  pointBiserial,
  R_PB_MIN_N,
  rankBiserial,
  UPPER_LOWER_FRACTION,
} from './discrimination.js';
export type { DistractorAnalysis, DistractorObservation } from './distractors.js';
export { analyseDistractors, DISTRACTOR_MIN_N } from './distractors.js';
export type { FacilityBand, FacilityResult, ScoredResponse } from './facility.js';
export { facility, facilityBand } from './facility.js';
export type { TimeInput, TimeOnItem } from './time-on-item.js';
export { median, timeOnItem } from './time-on-item.js';

/**
 * `@orrery/analytics` -- item analysis.  (P11-T1)
 *
 * Every module here carries the review correction it implements, because each one corrected something in `plans/08`
 * that was wrong in a way that would have produced a confident, misleading number.
 */

export type { AppliedItem, Caveat, CaveatId, LabelledItem, ReportFacts } from './caveats.js';
export { applicableCaveats, apply, CAVEATS, FLAG_COPY, indexLabel } from './caveats.js';
export type { CorrelationWithCi, DiscriminationResult, ItemOutcome } from './discrimination.js';
export {
  ACCEPTANCE_FLOOR,
  correctedD,
  correlationWithCi,
  DISCRIMINATION_MIN_GROUP,
  DISCRIMINATION_MIN_N,
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
export type { LidFinding, LidPairInput } from './lid.js';
export {
  classifyLidPair,
  LID_ALPHA,
  LID_MIN_N,
  LID_THRESHOLD_FLOOR,
  lidThreshold,
  normalQuantile,
} from './lid.js';
export type { AlphaInput, AlphaResult, FormResponse } from './reliability.js';
export {
  ALPHA_MIN_K,
  ALPHA_MIN_N,
  cronbachAlpha,
  SPEARMAN_BROWN_MIN_K,
  spearmanBrown,
} from './reliability.js';
export type {
  Freshness,
  Invalidation,
  InvalidationReason,
  Rollup,
  RollupState,
  Served,
} from './rollups.js';
export { emptyRollup, freshness, invalidate, recompute, serve } from './rollups.js';
export type { ClusteringInput, SimilarityCluster, SimilarityEntry } from './similarity.js';
export {
  clusterByCompleteLinkage,
  clusterCopy,
  fingerprint,
  jaccard,
  MIN_CLUSTER_SIZE,
  normalise,
  SHINGLE_SIZE,
  SIMILARITY_THRESHOLD,
  shingle,
} from './similarity.js';
export type { Suppressed, SuppressibleStat } from './suppression.js';
export {
  assertSuppressedByQueryLayer,
  SUPPRESSION_FLOORS,
  suppress,
  suppressReport,
} from './suppression.js';
export type { TimeInput, TimeOnItem } from './time-on-item.js';
export { median, timeOnItem } from './time-on-item.js';
export type {
  AuditSummary,
  VariantAuditFinding,
  VariantDrawRecord,
} from './variant-audit.js';
export { auditVariantCohort, auditVariantDraw } from './variant-audit.js';

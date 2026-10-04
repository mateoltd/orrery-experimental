/**
 * Variant audit: proving that seeds and draws were applied AND logged.  (P11-T9)
 *
 * ## WHAT THIS IS FOR, AND IT IS NOT A CAVEAT
 *
 * `plans/08` §9 records the finding this exists to detect. Students receive different items by design, and
 * `01-DOMAIN-MODEL.md` §10.1 then reports ONE `percentage` per student. So **two students with identical knowledge who
 * draw forms of different mean difficulty receive different percentages.**
 *
 * The plan's own sentence about it is the standard this module is measured against: "this is not a caveat to add to a
 * report. It is the difference between a number that measures a student and a number that measures a random seed."
 *
 * ## AND AN AUDIT THAT ONLY CHECKS THE SEED IS NOT AN AUDIT
 *
 * A seed that was recorded but never applied is indistinguishable, from the seed alone, from one that was applied
 * correctly. So every check here has TWO halves:
 *
 *  · **the seed is present and well-formed** -- so the permutation can be re-derived at all, and
 *  · **the recorded order MATCHES what that seed produces** -- so the draw can be proved rather than assumed.
 *
 * A skipped shuffle is a first-class outcome here, not an absence. `ShuffleResult.skipped` names why, and an attempt
 * whose paper was ordered on purpose (`ORDER_CARRIES_MEANING`) is behaving correctly -- flagging it as an unapplied
 * shuffle would train an auditor to ignore the finding.
 */

import { type ShuffleSkipReason, shuffleQuestionOrder } from '@orrery/contracts/policy/shuffle';

/** What an attempt recorded about how its paper was drawn. */
export interface VariantDrawRecord {
  readonly attemptId: string;
  /** The seed stored on the attempt. `null` when nothing was recorded, which is the finding. */
  readonly seed: string | null;
  /** The question ids in the order the student actually received them. */
  readonly recordedOrder: readonly string[];
  /** The blueprint slot each recorded question came from, for a slot-count disclosure. */
  readonly recordedSlots?: readonly string[];
  /** Why no shuffle happened, when none did. */
  readonly skipped: ShuffleSkipReason | null;
  /** Whether shuffling was ENABLED by the policy snapshot. Recorded, because a disabled shuffle is not a fault. */
  readonly shuffleEnabled: boolean;
}

export type VariantAuditFinding =
  /** The seed reproduces the recorded order exactly. The only fully clean verdict. */
  | { readonly verdict: 'VERIFIED'; readonly detail: string }
  /** Nothing was recorded, so nothing can be re-derived and nothing can be proved. */
  | { readonly verdict: 'NO_SEED_RECORDED'; readonly detail: string }
  /** A seed exists and shuffling was enabled, but it does not reproduce the order. */
  | {
      readonly verdict: 'SEED_DOES_NOT_REPRODUCE';
      readonly detail: string;
      readonly expected: readonly string[];
    }
  /** The shuffle was declined, and the reason is one of the recorded, legitimate ones. */
  | {
      readonly verdict: 'DELIBERATELY_SKIPPED';
      readonly detail: string;
      readonly reason: ShuffleSkipReason;
    }
  /** The shuffle was declined with no reason recorded, which is indistinguishable from a silent failure. */
  | { readonly verdict: 'SKIPPED_WITHOUT_REASON'; readonly detail: string }
  /** Shuffling was disabled by policy, and that is recorded, so the order is expected to be the authored one. */
  | { readonly verdict: 'SHUFFLE_DISABLED'; readonly detail: string }
  /** The recorded order is not a permutation of the authored pool. */
  | {
      readonly verdict: 'ORDER_NOT_A_PERMUTATION';
      readonly detail: string;
      readonly missing: readonly string[];
      readonly unexpected: readonly string[];
    };

/** The skip reasons that are legitimate design outcomes rather than failures. */
const LEGITIMATE_SKIPS: ReadonlySet<ShuffleSkipReason> = new Set<ShuffleSkipReason>([
  'FEWER_THAN_THREE_OPTIONS',
  'CATCH_ALL_OPTION',
  'ORDERED_SCALE',
  'ORDER_CARRIES_MEANING',
  'SHUFFLE_DISABLED',
  'SINGLETON',
]);

const sameOrder = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index]);

/**
 * AUDIT ONE ATTEMPT'S DRAW.
 *
 * Returns a finding rather than a boolean, because the difference between "shuffling was off", "the paper was
 * deliberately ordered", "the seed is missing" and "the seed does not reproduce the order" is the entire content of an
 * audit -- and a boolean would collapse all four into one word a reader has to guess the meaning of.
 */
export const auditVariantDraw = (
  record: VariantDrawRecord,
  /** The authored pool, in authored order. Without it the permutation cannot be checked at all. */
  authoredPool: readonly string[],
): VariantAuditFinding => {
  /**
   * THE ORDER IS CHECKED AS A PERMUTATION FIRST, because a seed cannot reproduce an order that is not a permutation
   * of the pool, and reporting "seed does not reproduce" for that case would point an auditor at the seed when the
   * problem is the order.
   */
  const recorded = [...record.recordedOrder];
  const pool = [...authoredPool];
  const poolCounts = new Map<string, number>();
  for (const id of pool) poolCounts.set(id, (poolCounts.get(id) ?? 0) + 1);

  const recordedCounts = new Map<string, number>();
  for (const id of recorded) recordedCounts.set(id, (recordedCounts.get(id) ?? 0) + 1);

  const missing: string[] = [];
  const unexpected: string[] = [];
  for (const [id, count] of poolCounts) {
    const got = recordedCounts.get(id) ?? 0;
    for (let i = got; i < count; i += 1) missing.push(id);
  }
  for (const [id, count] of recordedCounts) {
    const allowed = poolCounts.get(id) ?? 0;
    for (let i = allowed; i < count; i += 1) unexpected.push(id);
  }

  if (missing.length > 0 || unexpected.length > 0) {
    return {
      verdict: 'ORDER_NOT_A_PERMUTATION',
      detail:
        `the recorded order is not a permutation of the pool: ${String(missing.length)} missing, ` +
        `${String(unexpected.length)} unexpected. A seed cannot reproduce an order that was never drawn from this pool.`,
      missing: [...new Set(missing)],
      unexpected: [...new Set(unexpected)],
    };
  }

  // A deliberately ordered paper is behaving correctly, and saying so is what keeps the other findings legible.
  if (record.skipped !== null) {
    return LEGITIMATE_SKIPS.has(record.skipped)
      ? {
          verdict: 'DELIBERATELY_SKIPPED',
          reason: record.skipped,
          detail: `the shuffle was declined for a recorded reason (${record.skipped}), so the authored order is expected`,
        }
      : {
          verdict: 'SKIPPED_WITHOUT_REASON',
          detail:
            'the shuffle was declined with no recorded reason, which is indistinguishable from a silent failure',
        };
  }

  if (!record.shuffleEnabled) {
    return {
      verdict: 'SHUFFLE_DISABLED',
      detail: 'the policy snapshot had shuffling off, so the authored order is the expected one',
    };
  }

  /**
   * NO SEED IS THE FINDING. Everything below it -- reproducing the permutation, comparing it -- is impossible without
   * one, and an attempt whose permutation cannot be re-derived cannot be regraded defensibly.
   */
  if (record.seed === null || record.seed.length === 0) {
    return {
      verdict: 'NO_SEED_RECORDED',
      detail:
        'no seed was recorded for this attempt, so its permutation cannot be re-derived and a regrade would have to ' +
        'guess. This is the finding INV-BANK-2 depends on being impossible.',
    };
  }

  // RE-DERIVE, and compare. This is the half that makes the audit an audit rather than a receipt.
  const derived = shuffleQuestionOrder(authoredPool, record.seed, { enabled: true });

  if (!sameOrder(derived.items, recorded)) {
    return {
      verdict: 'SEED_DOES_NOT_REPRODUCE',
      detail:
        `the recorded order does not match what the stored seed produces. Either the order was not drawn from this ` +
        `seed, or the pool has changed since -- and a regrade on that basis would silently change the student's paper.`,
      expected: [...derived.items],
    };
  }

  return {
    verdict: 'VERIFIED',
    detail: `the stored seed reproduces the recorded order exactly across ${String(recorded.length)} items`,
  };
};

export interface AuditSummary {
  readonly total: number;
  readonly verified: number;
  readonly deliberatelySkipped: number;
  /** Everything else. `0` is the only acceptable number here. */
  readonly unexplained: number;
  readonly findings: readonly {
    readonly attemptId: string;
    readonly finding: VariantAuditFinding;
  }[];
}

/**
 * AUDIT A COHORT, and COUNT THE UNEXPLAINED ONES.
 *
 * The summary carries four counts rather than a pass/fail, because "how many draws could not be proved" is the number
 * an auditor asks for and "how many were fine" is not a question anybody has.
 */
export const auditVariantCohort = (
  records: readonly VariantDrawRecord[],
  poolFor: (record: VariantDrawRecord) => readonly string[],
): AuditSummary => {
  const findings = records.map((record) => ({
    attemptId: record.attemptId,
    finding: auditVariantDraw(record, poolFor(record)),
  }));

  const isUnexplained = (verdict: VariantAuditFinding['verdict']): boolean =>
    verdict !== 'VERIFIED' && verdict !== 'DELIBERATELY_SKIPPED' && verdict !== 'SHUFFLE_DISABLED';

  return {
    total: records.length,
    verified: findings.filter((entry) => entry.finding.verdict === 'VERIFIED').length,
    deliberatelySkipped: findings.filter(
      (entry) =>
        entry.finding.verdict === 'DELIBERATELY_SKIPPED' ||
        entry.finding.verdict === 'SHUFFLE_DISABLED',
    ).length,
    unexplained: findings.filter((entry) => isUnexplained(entry.finding.verdict)).length,
    findings,
  };
};

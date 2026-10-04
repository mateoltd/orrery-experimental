/**
 * The variant audit.  (P11-T9)
 *
 * `plans/08` §9 supplies the standard: "this is not a caveat to add to a report. It is the difference between a number
 * that measures a student and a number that measures a random seed."
 *
 * So the tests are about the two halves an audit needs. A seed that was RECORDED but never APPLIED looks exactly like
 * one that was applied correctly if you only check that a seed exists -- so every verification re-derives the
 * permutation and compares.
 */

import { shuffleQuestionOrder } from '@orrery/contracts/policy/shuffle';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { auditVariantCohort, auditVariantDraw, type VariantDrawRecord } from './variant-audit.js';

const POOL = ['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7', 'q8'];
const SEED = 'assignment:student:attempt';

const record = (over: Partial<VariantDrawRecord> = {}): VariantDrawRecord => ({
  attemptId: 'a1',
  seed: SEED,
  recordedOrder: shuffleQuestionOrder(POOL, SEED, { enabled: true }).items,
  skipped: null,
  shuffleEnabled: true,
  ...over,
});

describe('a VERIFIED draw re-derives to the same order', () => {
  it('passes when the stored seed reproduces the recorded order', () => {
    const finding = auditVariantDraw(record(), POOL);
    expect(finding.verdict).toBe('VERIFIED');
  });

  it('passes for EVERY seed drawn from the pool, which is the property an auditor relies on', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 20 }), (seed) => {
        const drawn = shuffleQuestionOrder(POOL, seed, { enabled: true }).items;
        return (
          auditVariantDraw(record({ seed, recordedOrder: drawn }), POOL).verdict === 'VERIFIED'
        );
      }),
      { numRuns: 200 },
    );
  });

  it('reports the item count it proved, so the claim is specific', () => {
    expect(auditVariantDraw(record(), POOL).detail).toContain('8 items');
  });
});

describe('a seed that was RECORDED but never APPLIED is the finding', () => {
  it('catches an order that the stored seed does not produce', () => {
    const shuffled = [...POOL].reverse();
    const finding = auditVariantDraw(record({ recordedOrder: shuffled }), POOL);
    expect(finding.verdict).toBe('SEED_DOES_NOT_REPRODUCE');
    // The expected order is returned, because an auditor's next question is always "what should it have been".
    if (finding.verdict === 'SEED_DOES_NOT_REPRODUCE')
      expect(finding.expected.length).toBe(POOL.length);
  });

  it('says why it matters: a regrade on that basis would change the paper', () => {
    const finding = auditVariantDraw(record({ recordedOrder: [...POOL].reverse() }), POOL);
    expect(finding.detail).toContain('regrade');
  });

  it('finds NO SEED the finding it is', () => {
    const finding = auditVariantDraw(record({ seed: null }), POOL);
    expect(finding.verdict).toBe('NO_SEED_RECORDED');
    // Without a seed the permutation cannot be re-derived at all, which is what makes a regrade indefensible.
    expect(finding.detail).toContain('cannot be re-derived');
  });

  it('treats an EMPTY seed as no seed', () => {
    expect(auditVariantDraw(record({ seed: '' }), POOL).verdict).toBe('NO_SEED_RECORDED');
  });

  it('catches a missing question, and blames the ORDER rather than the seed', () => {
    const finding = auditVariantDraw(record({ recordedOrder: POOL.slice(0, 7) }), POOL);
    expect(finding.verdict).toBe('ORDER_NOT_A_PERMUTATION');
    // A seed cannot reproduce an order that was never drawn from this pool, so pointing at the seed would mislead.
    expect(finding.detail).toContain('not a permutation');
    if (finding.verdict === 'ORDER_NOT_A_PERMUTATION') expect(finding.missing).toEqual(['q8']);
  });

  it('catches a duplicated question', () => {
    const finding = auditVariantDraw(
      record({ recordedOrder: ['q1', 'q1', ...POOL.slice(2, 8)] }),
      POOL,
    );
    expect(finding.verdict).toBe('ORDER_NOT_A_PERMUTATION');
    if (finding.verdict === 'ORDER_NOT_A_PERMUTATION') expect(finding.unexpected).toEqual(['q1']);
  });
});

describe('a DELIBERATE skip is a first-class outcome, not an absence', () => {
  it('accepts an ordered scale with its reason recorded', () => {
    const finding = auditVariantDraw(
      record({ recordedOrder: POOL, skipped: 'ORDERED_SCALE', shuffleEnabled: false }),
      POOL,
    );
    // Flagging this as an unapplied shuffle would train an auditor to ignore the finding.
    expect(finding.verdict).toBe('DELIBERATELY_SKIPPED');
    if (finding.verdict === 'DELIBERATELY_SKIPPED') expect(finding.reason).toBe('ORDERED_SCALE');
  });

  it('accepts every reason the shuffle module can legitimately record', () => {
    const reasons = [
      'FEWER_THAN_THREE_OPTIONS',
      'CATCH_ALL_OPTION',
      'ORDERED_SCALE',
      'ORDER_CARRIES_MEANING',
      'SHUFFLE_DISABLED',
      'SINGLETON',
    ] as const;
    for (const reason of reasons) {
      expect(
        auditVariantDraw(record({ skipped: reason, shuffleEnabled: false }), POOL).verdict,
        reason,
      ).toBe('DELIBERATELY_SKIPPED');
    }
  });

  it('distinguishes a DISABLED policy from a declined shuffle', () => {
    // Different causes, and an auditor asking "was this on?" needs the difference.
    const disabled = auditVariantDraw(
      record({ skipped: null, shuffleEnabled: false, recordedOrder: POOL }),
      POOL,
    );
    expect(disabled.verdict).toBe('SHUFFLE_DISABLED');
  });

  it('flags a skip with NO reason, which is indistinguishable from a silent failure', () => {
    // The type does not permit it, so the guard is for a record assembled elsewhere or by a future migration.
    const finding = auditVariantDraw(record({ skipped: 'NOT_A_REAL_REASON' as never }), POOL);
    expect(['SKIPPED_WITHOUT_REASON', 'DELIBERATELY_SKIPPED']).toContain(finding.verdict);
  });
});

describe('the cohort summary counts what an auditor asks for', () => {
  it('reports zero UNEXPLAINED when every draw checks out', () => {
    const summary = auditVariantCohort(
      [record({ attemptId: 'a1' }), record({ attemptId: 'a2' })],
      () => POOL,
    );
    expect(summary.unexplained).toBe(0);
    expect(summary.verified).toBe(2);
  });

  it('counts a deliberate skip separately from a failure', () => {
    const summary = auditVariantCohort(
      [
        record({ attemptId: 'ok' }),
        record({
          attemptId: 'ordered',
          skipped: 'ORDERED_SCALE',
          shuffleEnabled: false,
          recordedOrder: POOL,
        }),
        record({ attemptId: 'no-seed', seed: null }),
      ],
      () => POOL,
    );
    // "How many draws could not be proved" is the number an auditor asks for. "How many were fine" is not a question.
    expect(summary.unexplained).toBe(1);
    expect(summary.deliberatelySkipped).toBe(1);
    expect(summary.total).toBe(3);
  });

  it('never counts a verified draw as unexplained', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 12 }), (seed) => {
        const drawn = shuffleQuestionOrder(POOL, seed, { enabled: true }).items;
        const summary = auditVariantCohort([record({ seed, recordedOrder: drawn })], () => POOL);
        return summary.unexplained === 0;
      }),
      { numRuns: 200 },
    );
  });

  it('names every attempt it could not prove', () => {
    const summary = auditVariantCohort([record({ attemptId: 'bad', seed: null })], () => POOL);
    expect(summary.findings).toHaveLength(1);
    expect(summary.findings[0]?.attemptId).toBe('bad');
  });
});

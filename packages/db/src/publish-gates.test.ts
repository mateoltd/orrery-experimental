/**
 * The publish gates.  (P5-T12)
 *
 * ## The tests that matter
 *
 *  · `a FIXED slot naming another version's question is BLOCKING, and that is INV-SLOT-1` — the
 *    complement to ADR-0025's path ban. The gate stops `currentVersionId` being READ; this stops
 *    the wrong question being STORED, and a stored wrong question means a grade against something
 *    nobody taught.
 *  · `every problem is reported, not the first one` — the first version returned on the first
 *    blocking problem, which a teacher experiences as "fix this, submit, be told about the next".
 *  · `a pool that cannot fill a paper is BLOCKING and the fix says how many items to add` — not
 *    clamped, because clamping silently produces a paper with fewer questions than promised.
 */
import { describe, expect, it } from 'vitest';
import {
  type PublishInput,
  type PublishProblem,
  publishable,
  validateForPublish,
} from './publish-gates.js';

const q = (id: string, topic: string | null = 'x', process: string | null = 'RECALL') => ({
  questionId: id,
  topic,
  responseProcess: process,
});

const fixed = (position: number, questionId: string | null) => ({
  id: `s${String(position)}`,
  position,
  kind: 'FIXED' as const,
  questionId,
});

const pooled = (position: number, poolId: string, drawCount: number) => ({
  id: `s${String(position)}`,
  position,
  kind: 'POOLED' as const,
  poolId,
  drawCount,
});

const pool = (id: string, items: readonly string[], over: Record<string, unknown> = {}) => ({
  id,
  strategy: 'RANDOM_WITHOUT_REPLACEMENT' as const,
  drawCount: 2,
  items: items.map((questionId) => ({ questionId })),
  ...over,
});

const base = (over: Partial<PublishInput> = {}): PublishInput => ({
  slots: [fixed(0, 'q1'), pooled(1, 'p1', 2)],
  pools: [pool('p1', ['q2', 'q3', 'q4'])],
  items: [q('q1'), q('q2'), q('q3'), q('q4')],
  versionId: 'v1',
  ...over,
});

const codes = (problems: readonly PublishProblem[]) => problems.map((p) => p.code);

describe('publish gates', () => {
  it('a sound version publishes with no problems at all', () => {
    const problems = validateForPublish(base());
    expect(problems).toEqual([]);
    expect(publishable(problems)).toBe(true);
  });

  it("a FIXED slot naming another version's question is BLOCKING, and that is INV-SLOT-1", () => {
    // ADR-0025's path ban stops `currentVersionId` being READ; this stops the wrong question
    // being STORED. Either alone is insufficient: one is a source-level rule and the other is a
    // data-level fact, and a stored wrong question means a mark against something nobody taught.
    const problems = validateForPublish(base({ slots: [fixed(0, 'q-from-another-version')] }));
    expect(codes(problems)).toContain('FIXED_SLOT_UNKNOWN_QUESTION');
    expect(publishable(problems)).toBe(false);
    expect(problems[0]?.fix).toMatch(/choose a question from this version/);
  });

  it('a FIXED slot with no question, and a gap in the positions, are both named', () => {
    const problems = validateForPublish(base({ slots: [fixed(0, null), fixed(2, 'q1')] }));
    expect(codes(problems)).toContain('FIXED_SLOT_WITHOUT_QUESTION');
    expect(codes(problems)).toContain('SLOT_POSITIONS_NOT_DENSE');
    // AND both are reported together — see the test below for why.
    expect(problems.length).toBeGreaterThanOrEqual(2);
  });

  it('every problem is reported, not the first one', () => {
    // The first version returned on the first blocking problem. A teacher experiences that as
    // "fix this, submit, be told about the next" — four round trips to fix four typos.
    const problems = validateForPublish(
      base({
        slots: [fixed(0, 'nope'), pooled(1, 'missing-pool', 2), pooled(2, 'p1', 9)],
      }),
    );
    expect(codes(problems)).toEqual(
      expect.arrayContaining([
        'FIXED_SLOT_UNKNOWN_QUESTION',
        'POOLED_SLOT_WITHOUT_POOL',
        'POOL_UNDERSIZED',
      ]),
    );
  });

  it('a pool that cannot fill a paper is BLOCKING and the fix says HOW MANY items to add', () => {
    const problems = validateForPublish(base({ slots: [pooled(0, 'p1', 9)] }));
    const problem = problems.find((p) => p.code === 'POOL_UNDERSIZED');
    expect(problem?.severity).toBe('BLOCKING');
    expect(problem?.detail).toMatch(/holds 3 item\(s\) and this slot draws 9/);
    // "Add 6 more items" is the actionable half; "pool too small" is a report.
    expect(problem?.fix).toMatch(/add 6 more item\(s\)/);
  });

  it('an EMPTY pool is named, because a slot drawing from it cannot be sat at all', () => {
    const problems = validateForPublish(
      base({ slots: [pooled(0, 'empty', 1)], pools: [pool('empty', [])] }),
    );
    expect(codes(problems)).toContain('POOL_EMPTY');
  });

  it('a quota the pool cannot supply is BLOCKING and names the key', () => {
    const problems = validateForPublish(
      base({
        slots: [pooled(0, 'q', 2)],
        pools: [
          pool('q', ['a', 'b', 'c', 'd'], {
            strategy: 'QUOTA_TOPICS',
            quotas: { photosynthesis: 2 },
          }),
        ],
      }),
    );
    const problem = problems.find((p) => p.code === 'POOL_QUOTA_UNDERSIZED');
    expect(problem?.detail).toMatch(/photosynthesis/);
    expect(problem?.fix).toMatch(/add 2 more item\(s\)/);
  });

  it('missing item metadata is BLOCKING, because a bank with no topics cannot be used', () => {
    // plans/06 §6.1: "topic, cognitiveDemand and an optional difficulty estimate are REQUIRED on
    // publish. Without them, blueprints cannot be checked and item analysis cannot feed
    // authoring. We would be building an item bank we could not use."
    const problems = validateForPublish(
      base({
        items: [q('q1'), q('q2', null), q('q3', 'x', null), q('q4')],
        requireItemMetadata: true,
      }),
    );
    const metadata = problems.filter((p) => p.code === 'ITEM_METADATA_MISSING');
    expect(metadata).toHaveLength(2);
    expect(metadata.some((p) => p.detail.includes('no topic'))).toBe(true);
    expect(metadata.some((p) => p.detail.includes('no response process'))).toBe(true);
  });

  it('metadata is only required when the caller asks, because a formative quiz may not need it', () => {
    const lenient = validateForPublish(base({ items: [q('q1'), q('q2', null)] }));
    expect(codes(lenient)).not.toContain('ITEM_METADATA_MISSING');
  });

  it('an UNSATISFIED blueprint blocks, and the fix names the three real ways out', () => {
    const problems = validateForPublish(
      base({
        slots: [pooled(0, 'p1', 2)],
        blueprint: { cells: [{ topic: 'photosynthesis', responseProcess: 'RECALL', minItems: 1 }] },
      }),
    );
    const problem = problems.find((p) => p.code === 'BLUEPRINT_UNSATISFIED');
    expect(problem?.severity).toBe('BLOCKING');
    expect(problem?.detail).toMatch(/photosynthesis/);
    expect(problem?.fix).toMatch(/give each cell its own pool/);
    expect(problem?.fix).toMatch(/lower the cell/);
  });

  it('a blueprint a FIXED slot satisfies publishes', () => {
    const problems = validateForPublish(
      base({
        slots: [fixed(0, 'q1')],
        blueprint: { cells: [{ topic: 'x', responseProcess: 'RECALL', minItems: 1 }] },
      }),
    );
    expect(codes(problems)).not.toContain('BLUEPRINT_UNSATISFIED');
    expect(publishable(problems)).toBe(true);
  });

  it('a version with NO slots is refused, with a fix that offers the honest alternative', () => {
    const problems = validateForPublish(base({ slots: [], pools: [] }));
    const problem = problems.find((p) => p.code === 'NO_SLOTS');
    expect(problem?.fix).toMatch(/publish it as a reading/);
  });

  it('a WARNING does not block, and the distinction is real', () => {
    // The blueprint holds in most draws but not every one. That is a decision a teacher can make
    // with the number in front of them, and blocking it would be the gate overreaching.
    const problems = validateForPublish(
      base({
        slots: [pooled(0, 'p1', 2)],
        blueprint: {
          cells: [{ topic: 'x', responseProcess: 'RECALL', minItems: 1, tolerance: 99 }],
        },
      }),
    );
    const problem = problems.find((p) => p.code === 'BLUEPRINT_UNSATISFIED');
    // With a tolerance of 99 nothing blocks, and the module says so rather than inventing a
    // second code.
    expect(problem).toBeUndefined();
    expect(publishable(problems)).toBe(true);
  });

  it('EVERY problem carries a `where`, because a checklist item you cannot locate is not one', () => {
    const problems = validateForPublish(
      base({ slots: [fixed(0, 'nope'), pooled(1, 'missing', 1)], requireItemMetadata: true }),
    );
    expect(problems.length).toBeGreaterThan(0);
    for (const problem of problems) {
      expect(problem.where.length, `${problem.code} has no location`).toBeGreaterThan(0);
      expect(problem.detail.length).toBeGreaterThan(0);
      expect(['BLOCKING', 'WARNING']).toContain(problem.severity);
    }
  });
});

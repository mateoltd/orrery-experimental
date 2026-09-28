/**
 * Assessment slot resolution.  (P5-T9)
 *
 * ## The tests that matter
 *
 *  · `adding a slot does not change ANY other slot's paper` — the whole reason for `fork` per
 *    slot. Without it, fixing a typo in question 3 rewrites three hundred students' exams, and
 *    "pinned" stops meaning anything a student would recognise.
 *  · `a draw count larger than the pool is REFUSED, not clamped` — clamping produces a paper with
 *    a different number of questions than the blueprint promised, which is the specific thing a
 *    blueprint exists to prevent.
 *  · `the same seed gives the same paper, and different seeds give different ones` — INV-BANK-2's
 *    premise, without which nothing else means anything.
 */
import { describe, expect, it } from 'vitest';
import {
  attemptSeed,
  type PoolSpec,
  resolveSlots,
  type SlotResolutionError,
  type SlotSpec,
  sameVariantMap,
} from './slots.js';

const fixed = (position: number, questionId: string): SlotSpec => ({
  id: `slot-${position}`,
  position,
  kind: 'FIXED',
  questionId,
});

const pooled = (position: number, poolId: string, drawCount = 2): SlotSpec => ({
  id: `slot-${position}`,
  position,
  kind: 'POOLED',
  poolId,
  drawCount,
});

function pool(over: Partial<PoolSpec> = {}): PoolSpec {
  return {
    id: 'pool-1',
    strategy: 'RANDOM_WITHOUT_REPLACEMENT',
    drawCount: 2,
    items: [
      { questionId: 'q1' },
      { questionId: 'q2' },
      { questionId: 'q3' },
      { questionId: 'q4' },
      { questionId: 'q5' },
      { questionId: 'q6' },
    ],
    ...over,
  };
}

describe('P5-T9 slot resolution', () => {
  it('a FIXED slot resolves to its own question, with no draw at all', () => {
    const map = resolveSlots([fixed(0, 'qA'), fixed(1, 'qB')], [pool()], 'seed-1');
    expect(map['0']).toEqual(['qA']);
    expect(map['1']).toEqual(['qB']);
  });

  it('the same seed gives the same paper, and different seeds give different ones', () => {
    // INV-BANK-2's premise. A draw that is not reproducible makes "what did this student get"
    // unanswerable a year later, which is the whole point of storing the map.
    const slots = [pooled(0, 'pool-1', 3)];
    const a = resolveSlots(slots, [pool()], 'seed-alpha');
    const b = resolveSlots(slots, [pool()], 'seed-alpha');
    const c = resolveSlots(slots, [pool()], 'seed-beta');
    expect(sameVariantMap(a, b), 'the same seed produced two different papers').toBe(true);
    expect(sameVariantMap(a, c), 'two seeds produced the same paper every time').toBe(false);
  });

  it("adding a slot does not change ANY other slot's paper", () => {
    // THE reason each slot gets its own forked stream. A single stream for the whole exam makes
    // each draw depend on every draw before it, so inserting a slot at position 1 shifts every
    // draw after it. That is how "fix a typo in question 3" becomes "rewrite the exam for three
    // hundred students", and the pinned version stops being pinned in any sense.
    const base = [pooled(0, 'pool-1', 2), pooled(1, 'pool-1', 2), pooled(2, 'pool-1', 2)];
    const withExtra = [
      pooled(0, 'pool-1', 2),
      pooled(1, 'pool-1', 2),
      pooled(2, 'pool-1', 2),
      pooled(3, 'pool-1', 2),
    ];

    let differed = 0;
    for (let i = 0; i < 25; i += 1) {
      const before = resolveSlots(base, [pool()], `seed-${i}`);
      const after = resolveSlots(withExtra, [pool()], `seed-${i}`);
      for (const key of ['0', '1', '2']) {
        if (!sameVariantMap({ [key]: before[key] ?? [] }, { [key]: after[key] ?? [] }))
          differed += 1;
      }
    }
    expect(differed, 'adding a slot moved papers that should not have moved').toBe(0);
  });

  it('a draw count larger than the pool is REFUSED, not clamped', () => {
    // Clamping would produce a paper with FEWER questions than the blueprint promised, and a
    // blueprint that silently under-delivers is worse than one that refuses to publish.
    let thrown: SlotResolutionError | null = null;
    try {
      resolveSlots(
        [pooled(0, 'small', 3)],
        [pool({ id: 'small', items: [{ questionId: 'q1' }, { questionId: 'q2' }] })],
        's',
      );
    } catch (error) {
      thrown = error as SlotResolutionError;
    }
    expect(thrown?.code).toBe('POOL_UNDERSIZED');
    expect(thrown?.detail).toMatch(/holds 2 item/);
  });

  it('slot positions must be DENSE from zero, and a gap is named', () => {
    // A gap means "position N" in a seed label is not the slot a human is looking at, so every
    // downstream label is quietly wrong rather than loudly broken.
    let thrown: SlotResolutionError | null = null;
    try {
      resolveSlots([fixed(0, 'qA'), fixed(2, 'qB')], [pool()], 's');
    } catch (error) {
      thrown = error as SlotResolutionError;
    }
    expect(thrown?.code).toBe('SLOT_POSITIONS_NOT_DENSE');
    expect(thrown?.detail).toMatch(/position 2 where 1 was expected/);
  });

  it('a FIXED slot with no question and a POOLED slot with no pool are both NAMED refusals', () => {
    const cases: readonly [SlotSpec, SlotResolutionError['code']][] = [
      [{ id: 's', position: 0, kind: 'FIXED', questionId: null }, 'FIXED_SLOT_WITHOUT_QUESTION'],
      [{ id: 's', position: 0, kind: 'POOLED', poolId: null }, 'POOLED_SLOT_WITHOUT_POOL'],
      [pooled(0, 'missing-pool'), 'UNKNOWN_POOL'],
    ];
    for (const [slot, code] of cases) {
      let thrown: SlotResolutionError | null = null;
      try {
        resolveSlots([slot], [pool()], 's');
      } catch (error) {
        thrown = error as SlotResolutionError;
      }
      expect(thrown?.code, `${JSON.stringify(slot)} was not refused as ${code}`).toBe(code);
    }
  });

  it('a draw NEVER returns the same question twice', () => {
    // Checked over many seeds rather than once, because a bug in the removal path is invisible
    // for a pool of two and obvious for a pool of six.
    for (let i = 0; i < 40; i += 1) {
      const map = resolveSlots([pooled(0, 'pool-1', 4)], [pool()], `dup-${i}`);
      const drawn = map['0'] ?? [];
      expect(drawn).toHaveLength(4);
      expect(new Set(drawn).size, `seed ${i} repeated a question`).toBe(4);
    }
  });

  it('QUOTA_TOPICS gives the number the blueprint asked for, not a number that happens to come out', () => {
    // The quota is the whole point of the strategy. A blueprint that says "two on
    // photosynthesis" must produce two, or the blueprint is decoration.
    const topicPool = pool({
      id: 'by-topic',
      strategy: 'QUOTA_TOPICS',
      items: [
        { questionId: 'p1', topic: 'photosynthesis' },
        { questionId: 'p2', topic: 'photosynthesis' },
        { questionId: 'p3', topic: 'photosynthesis' },
        { questionId: 'c1', topic: 'cells' },
        { questionId: 'c2', topic: 'cells' },
        { questionId: 'w1', topic: 'water' },
      ],
      quotas: { photosynthesis: 2, cells: 1 },
    });
    for (let i = 0; i < 20; i += 1) {
      const map = resolveSlots([pooled(0, 'by-topic', 3)], [topicPool], `quota-${i}`);
      const drawn = map['0'] ?? [];
      const photos = drawn.filter((id) => id.startsWith('p')).length;
      const cells = drawn.filter((id) => id.startsWith('c')).length;
      expect(photos, `seed ${i} broke the photosynthesis quota`).toBe(2);
      expect(cells, `seed ${i} broke the cells quota`).toBe(1);
    }
  });

  it('a quota the pool cannot supply is a REFUSAL, not a shortfall', () => {
    const thin = pool({
      id: 'thin',
      strategy: 'QUOTA_TOPICS',
      items: [{ questionId: 'w1', topic: 'water' }],
      quotas: { photosynthesis: 2 },
    });
    let thrown: SlotResolutionError | null = null;
    try {
      resolveSlots([pooled(0, 'thin', 1)], [thin], 's');
    } catch (error) {
      thrown = error as SlotResolutionError;
    }
    expect(thrown?.code).toBe('POOL_UNDERSIZED');
    expect(thrown?.detail).toMatch(/photosynthesis/);
  });

  it('weights are PROBABILITIES, and a zero weight still gets picked sometimes', () => {
    // A weight of 0 is clamped to 1 rather than dropped, because a question authored and weighted
    // to nothing is far more likely a mistake than an intent. The assertion is about the shape of
    // the distribution, not an exact count, because that is the only thing a seed sweep can say.
    const heavy = pool({
      id: 'weighted',
      items: [
        { questionId: 'common', weight: 50 },
        { questionId: 'rare', weight: 1 },
        { questionId: 'zero', weight: 0 },
      ],
      drawCount: 1,
    });
    const counts: Record<string, number> = { common: 0, rare: 0, zero: 0 };
    for (let i = 0; i < 200; i += 1) {
      const drawn = resolveSlots([pooled(0, 'weighted', 1)], [heavy], `w-${i}`)['0'] ?? [];
      for (const id of drawn) counts[id] = (counts[id] ?? 0) + 1;
    }
    expect(counts.common ?? 0).toBeGreaterThan(counts.rare ?? 0);
    // All three are reachable, which is the property a weight of 0 would have destroyed.
    expect(Object.values(counts).every((n) => n > 0)).toBe(true);
  });

  it('an incompatible pair cannot co-occur in one form', () => {
    // V-3: a pool-level constraint so a detected dependent pair cannot appear together, which
    // would otherwise be a source of random measurement error — the two items are correlated and
    // the correlation lands on whichever student got the pair.
    const constrained = pool({
      id: 'incompatible',
      items: [{ questionId: 'a' }, { questionId: 'b' }, { questionId: 'c' }, { questionId: 'd' }],
      incompatibleItemPairs: [['a', 'b']],
      drawCount: 3,
    });
    for (let i = 0; i < 40; i += 1) {
      const drawn =
        resolveSlots([pooled(0, 'incompatible', 3)], [constrained], `inc-${i}`)['0'] ?? [];
      const both = drawn.includes('a') && drawn.includes('b');
      expect(both, `seed ${i} drew the incompatible pair together`).toBe(false);
    }
  });

  it('FIXED strategy takes the head of the pool, in order, for every seed', () => {
    // A deterministic strategy that depended on the seed would not be deterministic.
    const fixedPool = pool({
      id: 'f',
      strategy: 'FIXED',
      items: [{ questionId: 'x' }, { questionId: 'y' }],
    });
    for (let i = 0; i < 5; i += 1) {
      expect(resolveSlots([pooled(0, 'f', 2)], [fixedPool], `f-${i}`)['0']).toEqual(['x', 'y']);
    }
  });

  it('the resolution order is by POSITION, not by the order the rows arrived', () => {
    // The slots come from a database and their row order is not guaranteed. If the draw depended
    // on it, two identical assessments would produce two different exams.
    const slots = [pooled(2, 'pool-1', 2), fixed(0, 'qA'), pooled(1, 'pool-1', 2)];
    const forward = resolveSlots(slots, [pool()], 'order-seed');
    const reversed = resolveSlots([...slots].reverse(), [pool()], 'order-seed');
    expect(sameVariantMap(forward, reversed)).toBe(true);
  });

  it('an empty pool is refused, and an empty assessment is not', () => {
    // Zero slots is a legitimate assessment with no questions yet; a pool with no items is a
    // pool that cannot be drawn from. Treating them alike would stop an author saving a draft.
    expect(resolveSlots([], [pool()], 's')).toEqual({});
    let thrown: SlotResolutionError | null = null;
    try {
      resolveSlots([pooled(0, 'empty', 1)], [pool({ id: 'empty', items: [] })], 's');
    } catch (error) {
      thrown = error as SlotResolutionError;
    }
    expect(thrown?.code).toBe('POOL_EMPTY');
  });

  it('an AttemptSeed is OPAQUE, so a seed cannot be stored by accident', () => {
    // The seed is the recipe for every paper in the cohort's scheme, and INV-BANK-2 says the map
    // is stored rather than the seed. Making the type opaque is what turns "somebody stored the
    // seed in a log line" from a review note into a type error at the point of storage.
    const seed = attemptSeed('cohort-2026-week-3');
    expect(seed).toBe('cohort-2026-week-3');
    expect(typeof seed).toBe('string');
  });
});

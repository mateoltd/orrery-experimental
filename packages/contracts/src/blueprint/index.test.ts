/**
 * Blueprint worst-case coverage.  (P5-T8)
 *
 * ## The test that matters most
 *
 * `the floor matches an exhaustive enumeration of every draw, for pools small enough to enumerate`
 * — the whole module is a closed form standing in for a search, and P-18's complaint about
 * sampling is only answered if the closed form is checked against the search it replaces. So
 * every N-subset is enumerated for small pools and the module's floor is compared to the true
 * minimum over all of them.
 *
 * ## The test that is unpopular but true
 *
 * `a randomised pool CANNOT guarantee blueprint coverage, and says so` — for any cell with
 * `k > 0` and a pool with `N < M`, some draw fails it. That is arithmetic, not pessimism, and the
 * module's job is to report it rather than to round it into a pass.
 */
import { describe, expect, it } from 'vitest';
import {
  type BlueprintCell,
  blueprintCoverage,
  type CellVerdict,
  type ItemFacts,
  type SlotFacts,
} from './index.js';

const cell = (
  topic: string,
  responseProcess: string,
  over: Partial<BlueprintCell> = {},
): BlueprintCell => ({
  topic,
  responseProcess,
  minItems: 1,
  tolerance: 0,
  ...over,
});

const item = (id: string, topic: string | null, responseProcess: string | null): ItemFacts => ({
  questionId: id,
  topic,
  responseProcess,
});

const pooledSlot = (
  poolSize: number,
  drawCount: number,
  poolItems: readonly ItemFacts[],
): SlotFacts => ({ kind: 'POOLED', poolSize, drawCount, poolItems });

/** Every N-subset, for pools small enough to enumerate. */
function* subsets<T>(items: readonly T[], n: number): Generator<T[]> {
  const k = Math.min(n, items.length);
  const indices = Array.from({ length: k }, (_, i) => i);
  if (k === 0) {
    yield [];
    return;
  }
  while (true) {
    yield indices.map((i) => items[i] as T);
    let i = k - 1;
    while (i >= 0 && (indices[i] as number) === items.length - k + i) i -= 1;
    if (i < 0) return;
    indices[i] = (indices[i] as number) + 1;
    for (let j = i + 1; j < k; j += 1) indices[j] = (indices[j - 1] as number) + 1;
  }
}

const countMatching = (drawn: readonly ItemFacts[], c: BlueprintCell): number =>
  drawn.filter((i) => i.topic === c.topic && i.responseProcess === c.responseProcess).length;

const verdictFor = (verdicts: readonly CellVerdict[], c: BlueprintCell): CellVerdict => {
  const found = verdicts.find(
    (v) => v.topic === c.topic && v.responseProcess === c.responseProcess,
  );
  if (found === undefined) throw new Error(`no verdict for ${c.topic}/${c.responseProcess}`);
  return found;
};

describe('blueprint worst-case coverage', () => {
  it('the floor matches an exhaustive enumeration of every draw', () => {
    // The closed form vs the search it replaces. For each pool, enumerate EVERY N-subset, find
    // the true minimum number of matching items, and compare.
    const cases: readonly {
      pool: readonly ItemFacts[];
      n: number;
      c: BlueprintCell;
    }[] = [
      {
        pool: [
          item('a', 'x', 'SHORT'),
          item('b', 'y', 'SHORT'),
          item('c', 'x', 'SHORT'),
          item('d', 'y', 'ESSAY'),
        ],
        n: 2,
        c: cell('x', 'SHORT', { minItems: 1 }),
      },
      {
        pool: [
          item('a', 'x', 'SHORT'),
          item('b', 'x', 'SHORT'),
          item('c', 'y', 'SHORT'),
          item('d', 'y', 'ESSAY'),
        ],
        n: 3,
        c: cell('x', 'SHORT', { minItems: 2 }),
      },
      {
        pool: [
          item('a', 'x', 'SHORT'),
          item('b', 'y', 'SHORT'),
          item('c', 'y', 'SHORT'),
          item('d', 'y', 'SHORT'),
          item('e', 'z', 'ESSAY'),
        ],
        n: 2,
        c: cell('y', 'SHORT', { minItems: 2 }),
      },
      {
        pool: [
          item('a', 'x', 'SHORT'),
          item('b', 'x', 'SHORT'),
          item('c', 'x', 'SHORT'),
          item('d', 'x', 'SHORT'),
        ],
        n: 4,
        c: cell('x', 'SHORT', { minItems: 4 }),
      },
    ];

    for (const { pool, n, c } of cases) {
      let trueMinimum = Number.POSITIVE_INFINITY;
      let draws = 0;
      for (const drawn of subsets(pool, n)) {
        draws += 1;
        trueMinimum = Math.min(trueMinimum, countMatching(drawn, c));
      }
      const result = blueprintCoverage({
        cells: [c],
        slots: [pooledSlot(pool.length, n, pool)],
        items: pool,
      });
      const verdict = verdictFor(result.cells, c);
      expect(draws, 'the enumeration found no draws at all').toBeGreaterThan(0);
      expect(
        verdict.worstCaseFromPools,
        `M=${pool.length} N=${n} cell=${c.topic}/${c.responseProcess} k=${String(c.minItems)}: ` +
          `closed form says ${String(verdict.worstCaseFromPools)}, enumeration says ${String(trueMinimum)}`,
      ).toBe(trueMinimum);
    }
  });

  it('a FIXED slot meets its cell exactly, and no draw can change that', () => {
    const fixed = item('f1', 'photosynthesis', 'SHORT_TEXT');
    const other = item('f2', 'cells', 'ESSAY');
    const result = blueprintCoverage({
      cells: [cell('photosynthesis', 'SHORT_TEXT', { minItems: 1 })],
      slots: [
        { kind: 'FIXED', questionId: 'f1' },
        pooledSlot(6, 3, [
          item('p1', 'water', 'SHORT_TEXT'),
          item('p2', 'water', 'SHORT_TEXT'),
          item('p3', 'water', 'SHORT_TEXT'),
          item('p4', 'water', 'SHORT_TEXT'),
          item('p5', 'water', 'SHORT_TEXT'),
          item('p6', 'water', 'SHORT_TEXT'),
        ]),
      ],
      items: [fixed, other],
    });
    expect(result.coversWorstCase).toBe(true);
    expect(result.blocksAllDraws).toBe(false);
    expect(verdictFor(result.cells, cell('photosynthesis', 'SHORT_TEXT')).fixedContributions).toBe(
      1,
    );
  });

  it('a RANDOMISED POOL CANNOT guarantee coverage, and says so in a sentence', () => {
    // The unpopular true thing. 20 of 40 items drawn from a pool where 8 match the cell: a draw
    // can be built entirely from the other 32, so it can contain ZERO matching items. There is no
    // tolerance setting that makes that safe, and a blueprint that claims otherwise is lying.
    const pool: ItemFacts[] = [
      ...Array.from({ length: 8 }, (_, i) => item(`m${i}`, 'photosynthesis', 'SHORT_TEXT')),
      ...Array.from({ length: 32 }, (_, i) => item(`o${i}`, 'cells', 'SHORT_TEXT')),
    ];
    const result = blueprintCoverage({
      cells: [cell('photosynthesis', 'SHORT_TEXT', { minItems: 1 })],
      slots: [pooledSlot(40, 20, pool)],
      items: pool,
    });
    expect(result.coversWorstCase).toBe(false);
    expect(result.blocksAllDraws).toBe(true);
    expect(result.explanations).toHaveLength(1);
    expect(result.explanations[0]).toMatch(/a draw of 20 from 40/);
    expect(result.explanations[0]).toMatch(/supplies 0/);
  });

  it('N === M is a fixed paper, and it satisfies whatever the pool contains', () => {
    // The one way a pooled slot CAN guarantee a cell: drawing everything. Which is a fixed paper
    // wearing a pool's schema, and worth the module saying so rather than hiding behind it.
    const pool: ItemFacts[] = [
      item('a', 'x', 'SHORT'),
      item('b', 'x', 'SHORT'),
      item('c', 'y', 'ESSAY'),
      item('d', 'z', 'SHORT'),
    ];
    const result = blueprintCoverage({
      cells: [cell('x', 'SHORT', { minItems: 2 })],
      slots: [pooledSlot(4, 4, pool)],
      items: pool,
    });
    expect(result.coversWorstCase).toBe(true);
    expect(verdictFor(result.cells, cell('x', 'SHORT')).worstCaseFromPools).toBe(2);
  });

  it('TOLERANCE converts a shortfall into a warning rather than a block', () => {
    const pool: ItemFacts[] = [
      ...Array.from({ length: 4 }, (_, i) => item(`m${i}`, 'x', 'SHORT')),
      ...Array.from({ length: 4 }, (_, i) => item(`o${i}`, 'y', 'SHORT')),
    ];
    // 4 of 8 drawing 2: a draw can be the two non-matching ones, so the floor is 0.
    const strict = blueprintCoverage({
      cells: [cell('x', 'SHORT', { minItems: 1 })],
      slots: [pooledSlot(8, 2, pool)],
      items: pool,
    });
    expect(strict.blocksAllDraws).toBe(true);

    const tolerant = blueprintCoverage({
      // The cell needs 1 and tolerates 1 short, so a floor of 0 passes.
      cells: [cell('x', 'SHORT', { minItems: 1, tolerance: 1 })],
      slots: [pooledSlot(8, 2, pool)],
      items: pool,
    });
    expect(tolerant.blocksAllDraws).toBe(false);
  });

  it('the floor is computed PER POOL, not across every pool in the assessment', () => {
    // A blueprint spanning two pools. The first version counted matching items across BOTH pools
    // and compared that to each pool's own M, so it told a short pool it could supply items it
    // does not hold -- the wrong direction again, and the same direction as P-18's sampling error.
    const short = [item('s1', 'x', 'SHORT'), item('s2', 'y', 'SHORT')];
    const rich = [
      item('r1', 'x', 'SHORT'),
      item('r2', 'x', 'SHORT'),
      item('r3', 'x', 'SHORT'),
      item('r4', 'y', 'SHORT'),
    ];
    const result = blueprintCoverage({
      cells: [cell('x', 'SHORT', { minItems: 1 })],
      slots: [pooledSlot(2, 2, short), pooledSlot(4, 2, rich)],
      items: [...short, ...rich],
    });
    // By hand, so the number is not just whatever the code said:
    //   short pool: M=2, N=2, p=1  ->  max(0, 2 - (2-1)) = 1
    //   rich pool:  M=4, N=2, p=3  ->  max(0, 2 - (4-3)) = 1
    // SUMMED, because the slots are independent draws: 1 + 1 = 2.
    // The first version of this test expected 3 by adding the MATCH COUNTS (1 + 3) instead of
    // the floors, which is a plausible-looking arithmetic slip and would have passed a
    // closed form that was wrong in the same direction.
    const verdict = verdictFor(result.cells, cell('x', 'SHORT'));
    expect(verdict.worstCaseFromPools).toBe(2);
    // And the check for the specific case that motivated the fix: a pool with NO matching items
    // must contribute a floor of 0 even when another pool is full of them.
    const withDeadPool = blueprintCoverage({
      cells: [cell('q', 'SHORT', { minItems: 1 })],
      slots: [
        pooledSlot(2, 2, [item('s1', 'y', 'SHORT'), item('s2', 'z', 'SHORT')]),
        pooledSlot(4, 2, rich),
      ],
      items: [item('s1', 'y', 'SHORT'), item('s2', 'z', 'SHORT'), ...rich],
    });
    const dead = verdictFor(withDeadPool.cells, cell('q', 'SHORT'));
    // Pool 1 contributes max(0, 2 - 2) = 0. Pool 2 contributes max(0, 2 - 4) = 0. So 0 either way,
    // and the cell blocks — which is correct, because NEITHER pool holds a 'q' item.
    expect(dead.availableInPools).toBe(0);
    expect(dead.blocks).toBe(true);
  });

  it('two independent pooled slots ADD their floors', () => {
    const pool: ItemFacts[] = [
      ...Array.from({ length: 4 }, (_, i) => item(`m${i}`, 'x', 'SHORT')),
      ...Array.from({ length: 4 }, (_, i) => item(`o${i}`, 'y', 'SHORT')),
    ];
    const one = blueprintCoverage({
      cells: [cell('x', 'SHORT', { minItems: 1 })],
      slots: [pooledSlot(8, 2, pool)],
      items: pool,
    });
    const two = blueprintCoverage({
      cells: [cell('x', 'SHORT', { minItems: 1 })],
      slots: [pooledSlot(8, 2, pool), pooledSlot(8, 2, pool)],
      items: pool,
    });
    expect(verdictFor(one.cells, cell('x', 'SHORT')).worstCaseFromPools).toBe(0);
    expect(verdictFor(two.cells, cell('x', 'SHORT')).worstCaseFromPools).toBe(0);
    // And with `minItems: 2` two slots give the cell twice the chance — which is why the floor is
    // a sum and not a maximum.
    const twoNeedTwo = blueprintCoverage({
      cells: [cell('x', 'SHORT', { minItems: 2 })],
      slots: [
        pooledSlot(4, 4, [
          item('m1', 'x', 'SHORT'),
          item('m2', 'x', 'SHORT'),
          item('o1', 'y', 'SHORT'),
          item('o2', 'y', 'SHORT'),
        ]),
        pooledSlot(4, 4, [
          item('m3', 'x', 'SHORT'),
          item('m4', 'x', 'SHORT'),
          item('o3', 'y', 'SHORT'),
          item('o4', 'y', 'SHORT'),
        ]),
      ],
      items: [],
    });
    expect(verdictFor(twoNeedTwo.cells, cell('x', 'SHORT')).worstCaseFromPools).toBe(4);
  });

  it('an item with NO topic or response process satisfies nothing', () => {
    // Which is the point of `plans/06` §6.1: metadata is not optional, so an untagged item cannot
    // quietly satisfy a blueprint cell and make a bank look covered when it is not.
    const untagged = item('u1', null, null);
    const result = blueprintCoverage({
      cells: [cell('x', 'SHORT', { minItems: 1 })],
      slots: [pooledSlot(2, 2, [untagged, item('t', 'y', 'SHORT')])],
      items: [untagged],
    });
    expect(verdictFor(result.cells, cell('x', 'SHORT')).worstCaseFromPools).toBe(0);
    expect(result.blocksAllDraws).toBe(true);
  });

  it('a BLUEPRINT WITH NO CELLS is satisfied, rather than a division by zero', () => {
    const result = blueprintCoverage({ cells: [], slots: [pooledSlot(4, 2, [])], items: [] });
    expect(result.coversWorstCase).toBe(true);
    expect(result.blocksAllDraws).toBe(false);
    expect(result.explanations).toEqual([]);
  });

  it('an item on the fixed list that is NOT in the item table contributes nothing', () => {
    // A fixed slot naming a question the assessment does not contain is a referential-integrity
    // problem, which is `INV-SLOT-1`'s job at publish. Here it must not be counted as coverage.
    const result = blueprintCoverage({
      cells: [cell('x', 'SHORT', { minItems: 1 })],
      slots: [{ kind: 'FIXED', questionId: 'missing' }],
      items: [],
    });
    expect(verdictFor(result.cells, cell('x', 'SHORT')).fixedContributions).toBe(0);
    expect(result.blocksAllDraws).toBe(true);
  });
});

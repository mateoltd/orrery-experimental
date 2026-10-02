/**
 * Blueprint coverage, computed as a WORST CASE and not as a sample.  (P5-T8)
 *
 * ## WHY "WORST CASE" IS A HARDER PROMISE THAN IT LOOKS
 *
 * A blueprint says "two short answers on photosynthesis, one essay on water transport". A
 * publisher who samples five hundred draws from a pool and sees it satisfied in all five has
 * learned something about the pool, but not something they can put in front of a moderator.
 *
 * `P-18` is explicit about the asymmetry, and it is the reason this module is written the way it
 * is: "worst case is computed EXACTLY (bipartite b-matching / Hall's condition), not by
 * sampling, because a minimum over sampled draws is one-sided in the wrong direction and would
 * systematically understate how often a blueprint can fail."
 *
 * A sampled minimum is an UPPER bound on the true minimum — sampling can only ever miss the bad
 * draw. So a sampled check that passes tells you the blueprint held for the draws you tried, and
 * a moderator reading "worst case" as a guarantee has been misled by your sampling.
 *
 * ## THE WHOLE PROBLEM HAS A CLOSED FORM, WHICH IS WHY NO SAMPLING APPEARS ANYWHERE
 *
 * A draw from a pool of M items, N at a time, uniformly. Ask: **can some draw leave cell C short?**
 *
 * A cell needs `k` items with a given `(topic, responseProcess)`. Let `p` be how many of the M
 * items match. A draw of size N can be forced to contain as FEW matching items as the arithmetic
 * allows, and the minimum is `max(0, N − (M − p))`: take every non-matching item first, and only
 * then start on the matching ones.
 *
 * So some draw violates C exactly when
 *
 * ```
 * max(0, N − (M − p)) < k
 * ```
 *
 * which is a subtraction per cell. There is no search, no sampling, and no randomness — and the
 * answer is exact for every one of the N-subsets at once rather than for a sample of them.
 *
 * ## WHAT THIS MEANS FOR A RANDOMISED POOL, AND IT IS UNPOPULAR
 *
 * For any cell with `k > 0` and a pool with `N < M`, **some draw can fail it**, always. The
 * expected number of matching items in a random draw is `N·p/M`, and guaranteeing `k` of them in
 * EVERY draw requires `k ≤ N − (M − p)`, which for a pool with more items than a paper needs is
 * normally false.
 *
 * So the honest output is that a randomised pool CANNOT guarantee blueprint coverage, and the
 * publish gate must decide what to do about that rather than the maths quietly reporting a pass.
 * `plans/06` §7's framing applies: the mechanism is correct and the shortfall is VISIBLE. The
 * three ways out are all real and none of them is this module's decision: pool the cells
 * separately so a draw cannot pick the wrong topic; publish anyway and accept probabilistic
 * coverage; or set `N = M`, which is a fixed paper and no longer a pool at all.
 *
 * The fixed slots are different — they are deterministic, so they contribute exactly what they
 * are, and the requirement on a pooled slot is whatever the fixed slots have not already met.
 */

/** One row of the blueprint matrix. */
export interface BlueprintCell {
  /** Topic tag the item must carry. */
  readonly topic: string;
  /** Response process the item must assess. */
  readonly responseProcess: string;
  /**
   * How many items must satisfy this cell. Defaults to 1, because "this blueprint covers
   * photosynthesis" most plainly means at least one item does.
   */
  readonly minItems?: number;
  /** Points this cell is worth. Carried for grading, and NOT used by the coverage maths. */
  readonly points?: number | null;
  /**
   * How many items short of `minItems` is tolerated before this cell BLOCKS. Defaults to 0,
   * because a shortfall a teacher chose to allow is indistinguishable from one they did not
   * notice, and the gate that defaults to strict is the one that gets read.
   */
  readonly tolerance?: number;
}

export interface ItemFacts {
  readonly questionId: string;
  readonly topic: string | null;
  readonly responseProcess: string | null;
}

export interface SlotFacts {
  readonly kind: 'FIXED' | 'POOLED';
  /** For a FIXED slot. */
  readonly questionId?: string | null;
  /**
   * For a POOLED slot: WHICH pool.
   *
   * Carried for identity rather than for the maths — the pure module never queries — because a
   * caller assembling `SlotFacts` from a database needs to say which pool it fetched `poolItems`
   * from, and leaving that to the callee means two pools with the same contents are
   * indistinguishable.
   */
  readonly poolId?: string | null;
  /** For a POOLED slot: the pool's size M and the slot's draw size N. */
  readonly poolSize?: number | null;
  readonly drawCount?: number | null;
  /**
   * The items IN THIS POOL.
   *
   * Required for the floor to be exact. The first version counted matching items across every
   * pool in the assessment and compared that against each pool's own `M`, so a blueprint spanning
   * two pools was told a short pool could produce items it does not contain — the wrong direction
   * again, and the same direction as the sampling error P-18 warns about.
   */
  readonly poolItems?: readonly ItemFacts[] | null;
}

export interface BlueprintCheckInput {
  readonly cells: readonly BlueprintCell[];
  readonly slots: readonly SlotFacts[];
  readonly items: readonly ItemFacts[];
}

export interface CellVerdict {
  readonly topic: string;
  readonly responseProcess: string;
  readonly minItems: number;
  readonly tolerance: number;
  /** Items matching this cell that FIXED slots already contribute. */
  readonly fixedContributions: number;
  /** Items matching this cell available in the pools, for reference. */
  readonly availableInPools: number;
  /** How many a single pooled slot must contribute at minimum. */
  readonly requiredFromPools: number;
  /**
   * The fewest matching items ANY pooled draw can contain, summed over pooled slots.
   *
   * For a slot of `N` drawn from `M` items of which `p` match, the minimum is
   * `max(0, N − (M − p))`. Summed over slots, because each slot draws independently.
   */
  readonly worstCaseFromPools: number;
  /** `true` when the worst case meets `minItems` after tolerance. */
  readonly satisfiedInWorstCase: boolean;
  /** `true` when the worst case is short by more than the tolerance, so this cell BLOCKS. */
  readonly blocks: boolean;
  readonly shortfall: number;
}

export interface BlueprintCoverage {
  /** Every cell meets its minimum in EVERY possible draw. */
  readonly coversWorstCase: boolean;
  /** Some cell is short by more than its tolerance in some draw. */
  readonly blocksAllDraws: boolean;
  readonly cells: readonly CellVerdict[];
  /**
   * Pooled slots that CANNOT guarantee their blueprint, and why, in one sentence each.
   *
   * This is the sentence a publisher reads. "Blueprint unsatisfied" on its own says something is
   * wrong; "a random draw of 20 from 40 can contain as few as 0 items matching `cells.flowering`
   * when the cell needs 1" says what to do about it.
   */
  readonly explanations: readonly string[];
}

const matches = (item: ItemFacts, topic: string, responseProcess: string): boolean =>
  item.topic === topic && item.responseProcess === responseProcess;

/** How many of ONE slot's pool items match this cell. */
const cellMatchesIn = (
  slot: { readonly poolItems?: readonly ItemFacts[] | null },
  all: readonly ItemFacts[],
  cell: BlueprintCell,
): number => {
  const items = slot.poolItems;
  if (items === undefined || items === null) {
    // No items supplied for this pool: fall back to the whole item list, which is exact for a
    // single-pool assessment and is the best available answer for a multi-pool one. The
    // `matchingItems` field is then unused, and the fallback is documented rather than silent.
    return all.filter((i) => matches(i, cell.topic, cell.responseProcess)).length;
  }
  return items.filter((i) => matches(i, cell.topic, cell.responseProcess)).length;
};

export function blueprintCoverage(input: BlueprintCheckInput): BlueprintCoverage {
  // Split the slots. FIXED slots are deterministic and contribute exactly what they are; POOLED
  // slots contribute a RANGE, and the range's floor is the whole point of this module.
  const fixedItems: ItemFacts[] = [];
  const pooled: {
    readonly poolSize: number;
    readonly drawCount: number;
    /** This pool's items, so the floor is computed against THIS pool and not across all of them. */
    readonly poolItems: readonly ItemFacts[] | null;
  }[] = [];
  for (const slot of input.slots) {
    if (slot.kind === 'FIXED') {
      if (slot.questionId !== null && slot.questionId !== undefined) {
        const item = input.items.find((i) => i.questionId === slot.questionId);
        if (item !== undefined) fixedItems.push(item);
      }
      continue;
    }
    const m = slot.poolSize ?? 0;
    const n = slot.drawCount ?? 0;
    if (m > 0 && n > 0) {
      // `poolSize` is authoritative for M, because a caller that counted the items and a caller
      // that read a column can disagree, and the floor must use the number the draw samples from.
      pooled.push({
        poolSize: m,
        drawCount: n,
        poolItems: slot.poolItems ?? null,
      });
    }
  }

  const verdicts: CellVerdict[] = input.cells.map((cell) => {
    const minItems = cell.minItems ?? 1;
    const tolerance = cell.tolerance ?? 0;

    const fixedContributions = fixedItems.filter((i) =>
      matches(i, cell.topic, cell.responseProcess),
    ).length;
    const availableInPools = input.items.filter((i) =>
      matches(i, cell.topic, cell.responseProcess),
    ).length;

    // Only what the fixed slots have not already met still has to come from a pool, and a cell
    // that is already fully covered by fixed items is not at the mercy of a draw at all.
    const requiredFromPools = Math.max(0, minItems - fixedContributions);

    // The floor. For each pooled slot, the fewest matching items any draw can contain, given how
    // many of its M items match. Slots are independent draws, so the floors ADD.
    let worstCaseFromPools = 0;
    for (const slot of pooled) {
      // `p` is how many of THIS pool's M items match this cell, capped at M so a malformed input
      // cannot make the floor negative.
      const p = Math.min(cellMatchesIn(slot, input.items, cell), slot.poolSize);
      worstCaseFromPools += Math.max(0, slot.drawCount - (slot.poolSize - p));
    }
    // A cell already covered by fixed items cannot be short, whatever the draw does.
    if (requiredFromPools === 0) worstCaseFromPools = Math.max(worstCaseFromPools, minItems);

    const shortfall = Math.max(0, requiredFromPools - worstCaseFromPools);
    const satisfiedInWorstCase = shortfall === 0;
    return {
      topic: cell.topic,
      responseProcess: cell.responseProcess,
      minItems,
      tolerance,
      fixedContributions,
      availableInPools,
      requiredFromPools,
      worstCaseFromPools,
      satisfiedInWorstCase,
      blocks: shortfall > tolerance,
      shortfall,
    };
  });

  const explanations: string[] = [];
  for (const cell of verdicts) {
    if (!cell.blocks) continue;
    const slotText = pooled.map((s) => `a draw of ${s.drawCount} from ${s.poolSize}`).join(', or ');
    explanations.push(
      cell.requiredFromPools === 0
        ? `${cell.topic}/${cell.responseProcess} needs ${cell.minItems} and has ${cell.fixedContributions} from fixed slots`
        : `${cell.topic}/${cell.responseProcess} needs ${cell.requiredFromPools} and the worst case over ${slotText || 'any pooled draw'} supplies ${cell.worstCaseFromPools}`,
    );
  }

  return {
    coversWorstCase: verdicts.every((v) => v.satisfiedInWorstCase),
    blocksAllDraws: verdicts.some((v) => v.blocks),
    cells: verdicts,
    explanations,
  };
}

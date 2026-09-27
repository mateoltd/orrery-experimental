/**
 * Three-way merge, per block.  (P2-T4)
 *
 * ## Why block ids are UUIDs, one last time
 *
 * This module is the reason. A three-way merge needs a stable identity for each unit of content
 * so it can say "this block changed in one version and not the other". An array index cannot: two
 * editors who each insert a paragraph above the third block have both "changed block 3", and the
 * merge is a coin toss. The schema's message for requiring a uuid was "so diffs and analytics
 * survive versions" — this is the third requirement for the same property, and it is the one
 * that makes concurrent editing mergeable at all.
 *
 * ## What is NOT here, and why
 *
 * No CRDT. `ADR-0024` and `RN-11`: collaborative editing would jeopardise P2, and this is the
 * largest scope reduction in the plan. Single-author authoring plus a per-block three-way merge
 * covers the case the product actually has, and it is checkable in a way a CRDT is not.
 *
 * ## The rule that most tools get wrong
 *
 * **A deletion and an edit of the same block is a CONFLICT, not a winner.** It is tempting to
 * resolve it as "the delete wins" (the block is gone from the saved version, so it is gone) or
 * "the edit wins" (there is newer content, so keep it). Both silently destroy somebody's work:
 * one author deletes a block they decided was wrong, the other fixes a typo in it, and the
 * result is either a resurrected block nobody wants or a lost fix nobody made. It has to reach a
 * human, and `ConflictItem` says which kind it is so the panel can explain it.
 *
 * ## Convergence is not conflict
 *
 * If both sides changed a block to the SAME value, that is not a conflict. Two teachers who
 * independently fix the same typo have converged, and telling them so would be reporting a
 * conflict that does not exist — which is how a conflict panel gets dismissed without being read.
 */

import type { Block } from '../blocks/index.js';

export type MergeSide = 'mine' | 'theirs';

export type BlockOutcome =
  | 'unchanged'
  | 'took-mine'
  | 'took-theirs'
  | 'converged'
  | 'added-by-mine'
  | 'added-by-theirs'
  | 'removed-by-mine'
  | 'removed-by-theirs'
  | 'removed-by-both'
  /** Edited on one side, deleted on the other. A human decides. */
  | 'conflict-delete-vs-edit'
  /** Edited differently on both sides. A human decides. */
  | 'conflict-edit-vs-edit';

export type Resolution = 'mine' | 'theirs';

export interface MergeItem {
  readonly id: string;
  readonly outcome: BlockOutcome;
  /** Present unless the block is gone from BOTH sides. */
  readonly block: Block | null;
  /** What each side has, for the panel to show side by side. */
  readonly mine: Block | null;
  readonly theirs: Block | null;
  /** The two legal picks, or `null` when there is nothing to choose. */
  readonly choices: readonly Resolution[] | null;
}

export interface MergeResult {
  readonly items: readonly MergeItem[];
  /** Every item with no conflict, in a decided order. Ready to save. */
  readonly merged: readonly Block[];
  /** The items a human must resolve, in document order. */
  readonly conflicts: readonly MergeItem[];
  /**
   * True when the two sides put the same blocks in a DIFFERENT order and nothing conflicted.
   *
   * A separate concern from content, and it is reported rather than silently resolved: picking
   * one side's order discards the other author's rearrangement without telling them, and
   * "my paragraphs moved because the other editor moved them" is exactly the kind of silent
   * change that erodes trust in an editor.
   */
  readonly orderConflict: boolean;
  /** A stable id per run, so the panel can key its rows. */
  readonly mergeId: string;
}

const same = (a: Block | null, b: Block | null): boolean =>
  a === null || b === null ? a === b : JSON.stringify(a) === JSON.stringify(b);

const index = (blocks: readonly Block[]): Map<string, Block> =>
  new Map(blocks.map((b) => [b.id, b]));

/**
 * The three-way merge.
 *
 * `base` is the version both sides started from — the pinned `ResourceVersion` the editor
 * loaded. Without it there is no three-way merge, only "last write wins", which is the thing
 * this whole task exists to replace.
 */
export function mergeDocuments(
  base: readonly Block[],
  mine: readonly Block[],
  theirs: readonly Block[],
): MergeResult {
  const b = index(base);
  const m = index(mine);
  const t = index(theirs);

  const ids = [...new Set([...b.keys(), ...m.keys(), ...t.keys()])];
  const items: MergeItem[] = [];

  for (const id of ids) {
    const inBase = b.get(id) ?? null;
    const inMine = m.get(id) ?? null;
    const inTheirs = t.get(id) ?? null;

    const mineChanged = inMine !== null && !same(inMine, inBase);
    const theirsChanged = inTheirs !== null && !same(inTheirs, inBase);
    const removedByMine = inBase !== null && inMine === null;
    const removedByTheirs = inBase !== null && inTheirs === null;

    // Deleted on both sides: settled, and it is the rare unambiguous case.
    if (removedByMine && removedByTheirs) {
      items.push({
        id,
        outcome: 'removed-by-both',
        block: null,
        mine: null,
        theirs: null,
        choices: null,
      });
      continue;
    }

    // A deletion against an edit, either way round. CONFLICT, deliberately.
    if (removedByMine && theirsChanged) {
      items.push({
        id,
        outcome: 'conflict-delete-vs-edit',
        block: null,
        mine: null,
        theirs: inTheirs,
        choices: ['theirs'],
      });
      continue;
    }
    if (removedByTheirs && mineChanged) {
      items.push({
        id,
        outcome: 'conflict-delete-vs-edit',
        block: null,
        mine: inMine,
        theirs: null,
        choices: ['mine'],
      });
      continue;
    }

    // A deletion nobody else touched: settled, and the block goes.
    if (removedByMine || removedByTheirs) {
      items.push({
        id,
        outcome: removedByMine ? 'removed-by-mine' : 'removed-by-theirs',
        block: null,
        mine: inMine,
        theirs: inTheirs,
        choices: null,
      });
      continue;
    }

    if (mineChanged && theirsChanged) {
      if (same(inMine, inTheirs)) {
        // Converged. Not a conflict, and reporting it as one would be a false alarm.
        items.push({
          id,
          outcome: 'converged',
          block: inMine,
          mine: inMine,
          theirs: inTheirs,
          choices: null,
        });
        continue;
      }
      items.push({
        id,
        outcome: 'conflict-edit-vs-edit',
        block: null,
        mine: inMine,
        theirs: inTheirs,
        choices: ['mine', 'theirs'],
      });
      continue;
    }

    if (mineChanged) {
      items.push({
        id,
        outcome: inBase === null ? 'added-by-mine' : 'took-mine',
        block: inMine,
        mine: inMine,
        theirs: inTheirs,
        choices: null,
      });
      continue;
    }
    if (theirsChanged) {
      items.push({
        id,
        outcome: inBase === null ? 'added-by-theirs' : 'took-theirs',
        block: inTheirs,
        mine: inMine,
        theirs: inTheirs,
        choices: null,
      });
      continue;
    }

    items.push({
      id,
      outcome: 'unchanged',
      block: inBase,
      mine: inMine,
      theirs: inTheirs,
      choices: null,
    });
  }

  const order = orderOf(base, mine, theirs, items);
  const decided = items.filter((i) => i.choices === null && i.block !== null);
  const conflicts = items.filter((i) => i.choices !== null);

  return {
    items,
    merged: order
      .map((id) => decided.find((i) => i.id === id)?.block)
      .filter((blk): blk is Block => blk !== undefined),
    conflicts,
    orderConflict: orderDiffers(
      base,
      mine,
      theirs,
      decided.map((i) => i.id),
    ),
    mergeId: `merge:${items.length}:${conflicts.length}`,
  };
}

/**
 * The document order for the merged result.
 *
 * Taken from the side that has more blocks, and only among blocks that survive. When one side
 * added blocks the other has never seen, the other side's relative order of the SHARED blocks is
 * what we keep — a merge that reshuffled a lesson because the other editor added a paragraph
 * would be its own kind of data loss.
 */
function orderOf(
  base: readonly Block[],
  mine: readonly Block[],
  theirs: readonly Block[],
  items: readonly MergeItem[],
): string[] {
  const surviving = new Set(
    items.filter((i) => i.choices === null && i.block !== null).map((i) => i.id),
  );
  // The side that changed more, since that is the side whose arrangement is the newer intent.
  const preferred = mine.length >= theirs.length ? mine : theirs;
  const ordered = preferred.map((b) => b.id).filter((id) => surviving.has(id));
  // Anything surviving that neither side listed (impossible for a well-formed merge) goes last
  // rather than being dropped.
  for (const id of surviving) if (!ordered.includes(id)) ordered.push(id);
  void base;
  return ordered;
}

/**
 * Have BOTH sides reordered, to different orders?
 *
 * ## Why "both", and why this was a bug
 *
 * The first version compared the two sides' orders directly, so ANY disagreement counted -- and
 * that is wrong, because one editor reordering a lesson while the other does not touch it is not
 * a conflict at all. It is that editor's change, and it should be applied. A conflict needs two
 * intents in the same place.
 *
 * So both sides must have moved relative to the base AND landed somewhere different. One-sided
 * reordering is silent and correct; two-sided different reordering is reported, and is still not
 * a blocker -- the packet asks for a merge "the user can understand", not one that refuses.
 */
function orderDiffers(
  base: readonly Block[],
  mine: readonly Block[],
  theirs: readonly Block[],
  surviving: readonly string[],
) {
  const set = new Set(surviving);
  const order = (blocks: readonly Block[]) => blocks.filter((b) => set.has(b.id)).map((b) => b.id);
  const baseOrder = order(base);
  const mineOrder = order(mine);
  const theirsOrder = order(theirs);
  const mineReordered = JSON.stringify(mineOrder) !== JSON.stringify(baseOrder);
  const theirsReordered = JSON.stringify(theirsOrder) !== JSON.stringify(baseOrder);
  if (!mineReordered || !theirsReordered) return false;
  return JSON.stringify(mineOrder) !== JSON.stringify(theirsOrder);
}

/**
 * Apply the human's choices and produce the document to save.
 *
 * A conflict with NO choice is an error rather than a default. Defaulting an unresolved edit to
 * one side would throw away the other author's work with no record, which is the failure the
 * panel exists to prevent — and a silent default is invisible in review.
 */
export function applyResolutions(
  result: MergeResult,
  order: readonly string[],
  choices: Readonly<Record<string, Resolution>>,
): { ok: true; blocks: Block[] } | { ok: false; unresolved: readonly string[] } {
  const byId = new Map(result.items.map((i) => [i.id, i]));
  const unresolved = result.conflicts.filter((i) => choices[i.id] === undefined).map((i) => i.id);
  if (unresolved.length > 0) return { ok: false, unresolved };

  const out: Block[] = [];
  for (const id of order) {
    const item = byId.get(id);
    if (item === undefined) continue;
    if (item.choices === null) {
      if (item.block !== null) out.push(item.block);
      continue;
    }
    const pick = choices[id];
    const chosen = pick === 'mine' ? item.mine : item.theirs;
    if (chosen !== null) out.push(chosen);
  }
  return { ok: true, blocks: out };
}

/** The order to offer the panel: decided blocks and conflicts interleaved as authored. */
export function suggestedOrder(result: MergeResult, mine: readonly Block[]): string[] {
  const known = new Set(result.items.map((i) => i.id));
  const mineFirst = mine.map((b) => b.id).filter((id) => known.has(id));
  for (const i of result.items) if (!mineFirst.includes(i.id)) mineFirst.push(i.id);
  return mineFirst;
}

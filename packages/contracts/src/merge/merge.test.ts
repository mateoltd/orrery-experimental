/**
 * Three-way merge, per block.  (P2-T4)
 *
 * ## The three tests that matter
 *
 *  · `a deletion and an edit of the same block is a CONFLICT` -- the rule most tools get wrong,
 *    and the one that silently destroys somebody's work when it is wrong.
 *  · `two editors who made the same change have CONVERGED, not conflicted` -- because a conflict
 *    panel that reports non-conflicts is a panel people learn to dismiss.
 *  · `an unresolved conflict is an ERROR, not a default` -- a default would throw away the other
 *    author's work with no record.
 */
import { describe, expect, it } from 'vitest';
import type { Block } from '../blocks/index.js';
import { applyResolutions, mergeDocuments, suggestedOrder } from './index.js';

let n = 0;
function id(): string {
  n += 1;
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

const para = (text: string, blockId = id()): Block => ({
  type: 'paragraph',
  id: blockId,
  content: [{ text }],
});
const heading = (text: string, blockId = id()): Block => ({
  type: 'heading',
  id: blockId,
  level: 1,
  content: [{ text }],
});
/** The same block with different text — the minimal "edited" difference. */
const edited = (block: Block, text: string): Block =>
  block.type === 'paragraph'
    ? ({ ...block, content: [{ text }] } as Block)
    : ({ ...block, content: [{ text }] } as Block);

const outcomeOf = (blocks: readonly Block[], blockId: string) =>
  mergeDocuments(blocks, blocks, blocks).items.find((i) => i.id === blockId)?.outcome;

describe('the three-way merge', () => {
  it('is a no-op when nobody changed anything', () => {
    const base = [heading('Tides'), para('one'), para('two')];
    const r = mergeDocuments(base, base, base);
    expect(r.conflicts).toEqual([]);
    expect(r.orderConflict).toBe(false);
    expect(r.merged).toEqual(base);
  });

  it('takes the edited side per block, without touching the other blocks', () => {
    // The whole point: two editors changed DIFFERENT blocks, so there is nothing to decide.
    const a = id();
    const b = id();
    const base = [para('intro', a), para('body', b)];
    const mine = [para('intro', a), para('body edited by me', b)];
    const theirs = [para('intro edited by them', a), para('body', b)];

    const r = mergeDocuments(base, mine, theirs);
    expect(r.conflicts).toEqual([]);
    expect(r.items.find((i) => i.id === a)?.outcome).toBe('took-theirs');
    expect(r.items.find((i) => i.id === b)?.outcome).toBe('took-mine');
    const text = (x: Block) => (x.type === 'paragraph' ? x.content[0]?.text : undefined);
    expect(r.merged.map(text)).toEqual(['intro edited by them', 'body edited by me']);
  });

  it('CONVERGED, not conflicted, when both made the same change', () => {
    // Two teachers independently fixing the same typo. Reporting this as a conflict is a false
    // alarm, and false alarms are how a conflict panel gets dismissed without being read.
    const a = id();
    const base = [para('teh typo', a)];
    const fixed = [para('the typo', a)];
    const r = mergeDocuments(base, fixed, fixed);
    expect(r.conflicts).toEqual([]);
    expect(r.items[0]?.outcome).toBe('converged');
  });

  it('carries a block added on one side and untouched on the other', () => {
    const a = id();
    const base = [para('intro', a)];
    const added = id();
    const mine = [para('intro', a), para('my new bit', added)];
    const r = mergeDocuments(base, mine, base);
    expect(r.conflicts).toEqual([]);
    expect(r.items.find((i) => i.id === added)?.outcome).toBe('added-by-mine');
    expect(r.merged).toHaveLength(2);
  });

  it('drops a block deleted on one side and untouched on the other', () => {
    const a = id();
    const b = id();
    const base = [para('keep', a), para('delete me', b)];
    const mine = [para('keep', a)];
    const r = mergeDocuments(base, mine, base);
    expect(r.conflicts).toEqual([]);
    expect(r.items.find((i) => i.id === b)?.outcome).toBe('removed-by-mine');
    expect(r.merged.map((x) => x.id)).toEqual([a]);
  });

  it('drops a block deleted on BOTH sides without asking', () => {
    const a = id();
    const base = [para('gone', a)];
    const r = mergeDocuments(base, [], []);
    expect(r.conflicts).toEqual([]);
    expect(r.items[0]?.outcome).toBe('removed-by-both');
  });
});

describe('a deletion and an edit of the same block', () => {
  it('is a CONFLICT, not a winner', () => {
    // The rule most tools get wrong. One author deletes a block they think is wrong; the other
    // fixes a typo in it. Resolving it as "delete wins" resurrects a block nobody wants, and
    // "edit wins" loses a fix nobody made. Both destroy work silently.
    const a = id();
    const base = [para('has a typo', a)];
    const r = mergeDocuments(base, [], [edited(base[0] as Block, 'typo fixed')]);

    const item = r.items.find((i) => i.id === a);
    expect(item?.outcome).toBe('conflict-delete-vs-edit');
    // Only ONE legal pick: the block is gone from one side, so the other side is the only thing
    // that can be chosen. Presenting "delete" as an option would be a third outcome, and it is
    // the one the other author already asked for.
    expect(item?.choices).toEqual(['theirs']);
    expect(r.conflicts).toHaveLength(1);
    // And nothing is auto-merged, so a half-resolved save cannot slip through.
    expect(r.merged).toEqual([]);
  });

  it('is a CONFLICT the other way round too', () => {
    const a = id();
    const base = [para('has a typo', a)];
    const r = mergeDocuments(base, [edited(base[0] as Block, 'typo fixed')], []);
    const item = r.items.find((i) => i.id === a);
    expect(item?.outcome).toBe('conflict-delete-vs-edit');
    expect(item?.choices).toEqual(['mine']);
  });

  it('a deletion against an UNCHANGED other side is not a conflict', () => {
    // The boundary that matters: it is a conflict only when the other side actually touched it.
    const a = id();
    const b = id();
    const base = [para('keep', a), para('delete me', b)];
    const r = mergeDocuments(base, [para('keep', a)], base);
    expect(r.conflicts).toEqual([]);
  });
});

describe('an edit on both sides, differently', () => {
  it('is a CONFLICT offering both picks', () => {
    const a = id();
    const base = [para('original', a)];
    const r = mergeDocuments(
      base,
      [edited(base[0] as Block, 'mine')],
      [edited(base[0] as Block, 'theirs')],
    );
    const item = r.items.find((i) => i.id === a);
    expect(item?.outcome).toBe('conflict-edit-vs-edit');
    expect(item?.choices).toEqual(['mine', 'theirs']);
    // Both versions are available to the panel, which is the "understand and choose" the packet
    // asks for -- a panel that can only show one side is not a choice.
    expect(item?.mine).not.toBeNull();
    expect(item?.theirs).not.toBeNull();
  });
});

describe('applyResolutions', () => {
  const conflicted = () => {
    const a = id();
    const b = id();
    const base = [para('original', a), para('untouched', b)];
    return {
      a,
      b,
      base,
      r: mergeDocuments(
        base,
        [edited(base[0] as Block, 'mine'), para('untouched', b)],
        [edited(base[0] as Block, 'theirs'), para('untouched', b)],
      ),
    };
  };

  it('produces the chosen document', () => {
    const { a, b, r } = conflicted();
    const out = applyResolutions(r, suggestedOrder(r, [para('x', a), para('untouched', b)]), {
      [a]: 'theirs',
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.blocks[0]?.type === 'paragraph' ? out.blocks[0].content[0]?.text : '').toBe(
      'theirs',
    );
  });

  it('an unresolved conflict is an ERROR, not a default', () => {
    // A silent default would throw away the other author's work with no record -- the exact
    // failure the panel exists to prevent, and invisible in review.
    const { a, r } = conflicted();
    const out = applyResolutions(r, suggestedOrder(r, []), {});
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.unresolved).toEqual([a]);
  });

  it('never invents a block for a deletion conflict resolved the other way', () => {
    // Resolving a delete-vs-edit to the editing side must RESURRECT the block, because that is
    // what choosing it means. Dropping it would make the choice a no-op.
    const a = id();
    const base = [para('has a typo', a)];
    const r = mergeDocuments(base, [], [edited(base[0] as Block, 'typo fixed')]);
    const out = applyResolutions(r, suggestedOrder(r, []), { [a]: 'theirs' });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.blocks).toHaveLength(1);
  });
});

describe('order', () => {
  it('reports an order conflict rather than silently picking a side', () => {
    // Picking one side's order discards the other author's rearrangement without telling them.
    // "My paragraphs moved because the other editor moved them" is its own kind of data loss.
    const a = id();
    const b = id();
    const c = id();
    // BOTH sides must have moved, and landed somewhere different. The first version of this
    // test had `mine` in base order and only `theirs` reversed, and asserted a conflict -- which
    // is a one-sided reorder, and a one-sided reorder is that editor's change, not a conflict.
    const base = [para('one', a), para('two', b), para('three', c)];
    const mine = [para('three', c), para('two', b), para('one', a)];
    const theirs = [para('two', b), para('one', a), para('three', c)];
    const r = mergeDocuments(base, mine, theirs);
    expect(r.orderConflict).toBe(true);
    // No content conflict, so nothing blocks -- the order is surfaced, not enforced.
    expect(r.conflicts).toEqual([]);
  });

  it('is not an order conflict when only one side reordered', () => {
    const a = id();
    const b = id();
    const base = [para('one', a), para('two', b)];
    const r = mergeDocuments(base, [para('two', b), para('one', a)], base);
    expect(r.orderConflict).toBe(false);
  });
});

describe('outcomes are the ones the panel knows how to explain', () => {
  it('every outcome is one of the declared ones', () => {
    // A merge outcome that nothing in the panel can render is a merge outcome that reaches a
    // human as a blank row.
    const a = id();
    const b = id();
    const c = id();
    const d = id();
    const base = [para('x', a), para('y', b)];
    const r = mergeDocuments(
      base,
      [para('x edited', a), para('new', c)],
      [para('y edited', b), para('new too', d)],
    );
    for (const item of r.items) {
      expect([
        'unchanged',
        'took-mine',
        'took-theirs',
        'converged',
        'added-by-mine',
        'added-by-theirs',
        'removed-by-mine',
        'removed-by-theirs',
        'removed-by-both',
        'conflict-delete-vs-edit',
        'conflict-edit-vs-edit',
      ]).toContain(item.outcome);
    }
  });

  it('a no-op merge reports no conflicts and no order conflict', () => {
    const blocks = [para('a'), para('b')];
    const r = mergeDocuments(blocks, blocks, blocks);
    expect(r.conflicts).toEqual([]);
    expect(r.orderConflict).toBe(false);
    expect(outcomeOf(blocks, r.items[0]?.id ?? '')).toBe('unchanged');
  });
});

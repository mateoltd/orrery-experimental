/**
 * Structural diff.  (P2-T5)
 *
 * ## The test that matters most
 *
 * `a reorder is a MOVE, not a change`. This is the whole reason the diff is structural. A
 * reordered lesson has not been reworded, and an author told "3 blocks changed" when they
 * dragged three paragraphs is an author who stops reading the summary.
 *
 * ## And the one that would have shipped a lie
 *
 * `reports NOTHING when only key order changed`. Zod reorders keys to the schema's declaration
 * order, so a naive `JSON.stringify` comparison calls a re-save an edit of every block. That is
 * the author being told they changed a lesson they did not touch.
 */
import { describe, expect, it } from 'vitest';
import type { Block } from '../blocks/index.js';
import { diffBlocks } from './index.js';

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

describe('the four outcomes', () => {
  it('reports a reorder as MOVES, not changes', () => {
    const a = id();
    const b = id();
    const c = id();
    const before = [para('one', a), para('two', b), para('three', c)];
    const after = [para('one', a), para('two', b), para('three', c)].reverse();
    const d = diffBlocks(before, after);
    expect(d.changed).toEqual([]);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
    expect(d.moved).toHaveLength(2);
    // Positions are 1-based in the summary, because a diff line that says "block 0" is a diff
    // line nobody can act on.
    expect(d.summary.join(' ')).toContain('1 → 3');
  });

  it('reports an added block with its text, so the summary is readable', () => {
    // The SAME block on both sides. Two `para('one')` calls produce two different ids, so the
    // first version of this fixture reported two ADDITIONS and asserted one.
    const a = id();
    const d = diffBlocks([para('one', a)], [para('one', a), para('a brand new paragraph')]);
    expect(d.added).toHaveLength(1);
    expect(d.summary.join('\n')).toContain('"a brand new paragraph"');
  });

  it('reports a removed block, naming what was lost', () => {
    const keep = id();
    const d = diffBlocks([para('keep', keep), para('this goes away')], [para('keep', keep)]);
    expect(d.removed).toHaveLength(1);
    expect(d.summary.join('\n')).toContain('"this goes away"');
  });

  it('reports a change PER FIELD, not "something differs"', () => {
    const a = id();
    const before = [
      {
        type: 'image',
        id: a,
        assetId: '22222222-2222-4222-8222-222222222222',
        alt: 'A diagram',
        caption: 'One',
      } as Block,
    ];
    const after = [
      {
        type: 'image',
        id: a,
        assetId: '22222222-2222-4222-8222-222222222222',
        alt: 'A clearer diagram',
        caption: 'One',
      } as Block,
    ];
    const d = diffBlocks(before, after);
    expect(d.changed).toHaveLength(1);
    // The author is told WHICH field, which is the difference between a five-second fix and a
    // hunt through the document.
    expect(d.changed[0]?.fields.map((f) => f.field)).toEqual(['alt']);
    expect(d.changed[0]?.fields[0]?.before).toBe('A diagram');
    expect(d.changed[0]?.fields[0]?.after).toBe('A clearer diagram');
  });

  it('reports both sides of a multi-field change', () => {
    const a = id();
    const b1 = { type: 'table', id: a, caption: 'Gravity', header: ['x'], rows: [['1']] } as Block;
    const a2 = {
      type: 'table',
      id: a,
      caption: 'Surface gravity',
      header: ['x'],
      rows: [['2']],
    } as Block;
    const d = diffBlocks([b1], [a2]);
    expect(d.changed[0]?.fields.map((f) => f.field).sort()).toEqual(['caption', 'rows']);
  });

  it('is identical for the same document', () => {
    const blocks = [heading('Tides'), para('one'), para('two')];
    const d = diffBlocks(blocks, blocks);
    expect(d.identical).toBe(true);
    expect(d.blocks.every((b) => b.kind === 'unchanged')).toBe(true);
    expect(d.summary).toEqual([]);
  });
});

describe('key order', () => {
  it('reports NOTHING when only key order changed', () => {
    // Zod reorders keys to the schema's declaration order, so a naive comparison calls a
    // re-save an edit of every block -- telling the author they changed a lesson they did not
    // touch. This is the same class of bug as the checksum one, and the same fix.
    const a = id();
    const block = { type: 'divider', id: a, variant: 'solid' } as Block;
    const reordered = { variant: 'solid', id: a, type: 'divider' } as unknown as Block;
    const d = diffBlocks([block], [reordered]);
    expect(d.identical).toBe(true);
    expect(d.changed).toEqual([]);
  });

  it('still reports a REAL change on a reordered block', () => {
    const a = id();
    const block = { type: 'divider', id: a, variant: 'solid' } as Block;
    const reorderedChanged = { variant: 'dashed', id: a, type: 'divider' } as unknown as Block;
    const d = diffBlocks([block], [reorderedChanged]);
    expect(d.changed).toHaveLength(1);
    expect(d.changed[0]?.fields.map((f) => f.field)).toEqual(['variant']);
  });
});

describe('a block replaced by a different type', () => {
  it('is a change, with the type difference visible', () => {
    // A paragraph turned into a heading. The ids match, so the naive path says "changed", and the
    // field list must make the type swap obvious rather than reporting nothing changed.
    const a = id();
    const before = para('Tides', a);
    const after = heading('Tides', a);
    const d = diffBlocks([before], [after]);
    expect(d.changed).toHaveLength(1);
    // `type` is excluded from the field list by design, so the change is reported as fields that
    // differ; the level field appearing IS the signal.
    expect(d.changed[0]?.fields.map((f) => f.field)).toEqual(['level']);
  });
});

describe('the summary', () => {
  it('lists every change exactly once, in the NEW document order', () => {
    const a = id();
    const b = id();
    const c = id();
    const d = id();
    const before = [para('one', a), para('two', b), para('three', c)];
    const after = [para('one', a), para('TWO edited', b), para('three', c), para('four', d)];
    const diff = diffBlocks(before, after);
    expect(diff.summary).toHaveLength(diff.blocks.filter((x) => x.kind !== 'unchanged').length);
    // And the new block's line comes after the edited one's, because the summary reads the way
    // the lesson does.
    expect(diff.summary[0]).toContain('TWO edited');
    expect(diff.summary[1]).toContain('"four"');
  });

  it('truncates a long text so one block cannot flood the summary', () => {
    const long = 'x'.repeat(200);
    const a = id();
    const d = diffBlocks([para('one', a)], [para('one', a), para(long)]);
    const line = d.summary.find((l) => l.startsWith('+')) ?? '';
    expect(line.length).toBeLessThan(80);
    expect(line).toContain('…');
  });
});

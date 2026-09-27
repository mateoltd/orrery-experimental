/**
 * Structural diff between two block lists.  (P2-T5)
 *
 * ## Structural, not textual
 *
 * A textual diff of a lesson says "line 14 changed". That is useless to an author, because a
 * lesson has no lines -- it has blocks, and a block can move without changing, change without
 * moving, or be replaced by an identical-looking one. So the unit is the **block id**, and the
 * four outcomes are the four things that can actually happen to a block:
 *
 *   · `added`   — an id the old version does not have
 *   · `removed` — an id the new version does not have
 *   · `changed` — same id, different content, reported **per field** so the author is told
 *                 "you changed the caption", not "something differs"
 *   · `moved`   — same id, identical content, different position
 *
 * `moved` being separate from `changed` is the whole reason this is structural: a lesson
 * reordered is a *different kind* of edit from a lesson reworded, and one of them is almost
 * always an accident.
 *
 * ## A block that is "changed" but whose diff is empty
 *
 * That happens, and it is worth handling rather than hiding. Re-saving a document can reorder
 * an object's keys (see `canonical.ts`), so a naive `JSON.stringify` comparison calls that a
 * change. Comparing canonical forms makes it correctly report *nothing changed*, which is the
 * answer that stops an author being told they edited a lesson when they did not.
 */

import type { Block } from '../blocks/index.js';
import { canonicalJson } from '../editor/canonical.js';

export type ChangeKind = 'added' | 'removed' | 'changed' | 'moved' | 'unchanged';

export interface FieldChange {
  readonly field: string;
  readonly before: unknown;
  readonly after: unknown;
}

export interface BlockDiff {
  readonly id: string;
  readonly kind: ChangeKind;
  /** Present for `moved` and `changed`, so the caller can say "from 3 to 7". */
  readonly from: number | null;
  readonly to: number | null;
  /** Per field, for `changed`. Empty for every other kind. */
  readonly fields: readonly FieldChange[];
}

export interface StructuralDiff {
  readonly blocks: readonly BlockDiff[];
  readonly added: readonly BlockDiff[];
  readonly removed: readonly BlockDiff[];
  readonly changed: readonly BlockDiff[];
  readonly moved: readonly BlockDiff[];
  /** True when nothing at all differs. Used to refuse a no-op version. */
  readonly identical: boolean;
  /** One line per change, for a commit-style summary. */
  readonly summary: readonly string[];
}

const index = (blocks: readonly Block[]) =>
  new Map(blocks.map((b, i) => [b.id, { block: b, at: i }]));

/** Which fields differ, ignoring key order. `canonicalJson` makes that automatic. */
function fieldChanges(before: Block, after: Block): FieldChange[] {
  const a = before as unknown as Record<string, unknown>;
  const b = after as unknown as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  const out: FieldChange[] = [];
  for (const k of keys) {
    if (k === 'type') continue; // The id is the same and the type comes with it.
    if (canonicalJson(a[k]) === canonicalJson(b[k])) continue;
    out.push({ field: k, before: a[k], after: b[k] });
  }
  return out;
}

export function diffBlocks(before: readonly Block[], after: readonly Block[]): StructuralDiff {
  const b = index(before);
  const a = index(after);
  const ids = [...new Set([...b.keys(), ...a.keys()])];
  const blocks: BlockDiff[] = [];

  for (const id of ids) {
    const was = b.get(id);
    const now = a.get(id);

    if (was === undefined && now !== undefined) {
      blocks.push({ id, kind: 'added', from: null, to: now.at, fields: [] });
      continue;
    }
    if (was !== undefined && now === undefined) {
      blocks.push({ id, kind: 'removed', from: was.at, to: null, fields: [] });
      continue;
    }
    if (was === undefined || now === undefined) continue;

    const same = canonicalJson(was.block) === canonicalJson(now.block);
    if (same) {
      // Identical content in a different place is a MOVE, and reporting it as a change would be
      // wrong in the way that matters: a reordered lesson is not a reworded one.
      if (was.at !== now.at) {
        blocks.push({ id, kind: 'moved', from: was.at, to: now.at, fields: [] });
      } else {
        blocks.push({ id, kind: 'unchanged', from: was.at, to: now.at, fields: [] });
      }
      continue;
    }
    blocks.push({
      id,
      kind: 'changed',
      from: was.at,
      to: now.at,
      fields: fieldChanges(was.block, now.block),
    });
  }

  // In the NEW document's order, so a summary reads top to bottom the way the lesson does.
  const order = new Map(after.map((blk, i) => [blk.id, i]));
  const sorted = [...blocks].sort((x, y) => {
    const xi = order.get(x.id) ?? Number.MAX_SAFE_INTEGER;
    const yi = order.get(y.id) ?? Number.MAX_SAFE_INTEGER;
    return xi - yi;
  });

  const added = sorted.filter((d) => d.kind === 'added');
  const removed = sorted.filter((d) => d.kind === 'removed');
  const changed = sorted.filter((d) => d.kind === 'changed');
  const moved = sorted.filter((d) => d.kind === 'moved');
  const identical = added.length + removed.length + changed.length + moved.length === 0;

  return {
    blocks: sorted,
    added,
    removed,
    changed,
    moved,
    identical,
    // Built from `sorted`, NOT from the four grouped arrays.
    //
    // The first version concatenated `added`, then `removed`, then `changed`, then `moved` --
    // grouped BY KIND, which contradicts the comment above about reading top to bottom. A summary
    // that lists all the additions, then all the edits, then all the moves is three separate
    // lists stapled together, and the author has to hold the document in their head to reassemble
    // it. Document order is the only order in which it reads like the lesson.
    summary: sorted
      .filter((d) => d.kind !== 'unchanged')
      .map((d) => {
        switch (d.kind) {
          case 'added':
            return `+ ${describe(after, d.id)}`;
          case 'removed':
            return `- ${describe(before, d.id)}`;
          case 'changed':
            return `~ ${describe(after, d.id)} (${d.fields.map((f) => f.field).join(', ')})`;
          default:
            return `↕ ${describe(after, d.id)} (block ${(d.from ?? 0) + 1} → ${(d.to ?? 0) + 1})`;
        }
      }),
  };
}

const describe = (blocks: readonly Block[], id: string): string => {
  const found = blocks.find((b) => b.id === id);
  if (found === undefined) return 'a block';
  const text = blockText(found);
  return text === '' ? found.type : `"${text.slice(0, 40)}${text.length > 40 ? '…' : ''}"`;
};

/** The block's own words, for a summary line. Not a rendering -- just the text an author recognises. */
function blockText(block: Block): string {
  const any_ = block as unknown as Record<string, unknown>;
  const runs = any_.content ?? any_.stem;
  if (Array.isArray(runs)) {
    return runs
      .map((r) =>
        typeof r === 'object' && r !== null && 'text' in r
          ? String((r as { text: unknown }).text)
          : '',
      )
      .join('')
      .trim();
  }
  if (typeof any_.title === 'string') return any_.title;
  if (typeof any_.latex === 'string') return any_.latex;
  return '';
}

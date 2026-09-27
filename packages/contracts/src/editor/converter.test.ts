/**
 * The converter, against the historical corpus.  (P2-T3a)
 *
 * ## Why the corpus and not hand-written blocks
 *
 * `fixtures.ts` holds seven committed historical documents covering the block types, and they
 * are already the thing the migration gate proves round-trips. Using them means this suite
 * cannot drift from the shapes the product actually stores, and a new block type cannot be added
 * to the fixtures without this test noticing that it has no round trip.
 *
 * ## The test that settles the kill-switch question
 *
 * `round-trips EVERY block in the corpus, in both directions, with no loss`. If that holds for
 * all 16 types, the converter is writable and TipTap is viable. If some block genuinely cannot
 * survive the round trip, the switch fires on evidence rather than on projection — which is the
 * entire reason this file exists before the five days do.
 */

import { describe, expect, it } from 'vitest';
import { CORPUS } from '../blocks/fixtures.js';
import { LATEST_VERSION, migrateBlocks } from '../blocks/migrate.js';
import {
  decodeDocument,
  fromEditorNode,
  isKnownType,
  KNOWN_BLOCK_TYPES,
  toEditorNode,
} from './converter.js';
// From `probe`, not `converter`: the shape is a RECORD OF THE MEASUREMENT, kept beside the
// write-up, so a later change to the converter cannot quietly edit the evidence.
import { PROSEMIRROR_NODE_SHAPE } from './probe.js';

/** Structural equality, order-insensitive for object keys. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  const ka = Object.keys(a as object).sort();
  const kb = Object.keys(b as object).sort();
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
  return ka.every((k) =>
    deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

/** Every block in the corpus, migrated to current — the shapes we actually store. */
function currentBlocks(): unknown[] {
  return CORPUS.flatMap((f) => {
    const m = migrateBlocks(f.blocks, f.schemaVersion, LATEST_VERSION);
    return m.ok ? m.blocks : [];
  });
}

describe('the editor representation converter', () => {
  it('round-trips EVERY block in the corpus, in both directions, with no loss', () => {
    const blocks = currentBlocks();
    expect(blocks.length, 'the corpus must be non-empty for this to mean anything').toBeGreaterThan(
      20,
    );
    const losses: string[] = [];
    for (const block of blocks) {
      const node = toEditorNode(block as never);
      const back = fromEditorNode(node);
      if (!back.ok) {
        losses.push(`${(block as { type: string }).type}: ${back.message}`);
        continue;
      }
      // `toEqual`, NOT `JSON.stringify` comparison. Zod emits keys in schema-declaration order,
      // so a string comparison reports three corpus blocks as "lossy" when only the key order
      // moved -- which is what first surfaced the checksum bug this file now documents.
      if (!deepEqual(back.block, block)) {
        losses.push(
          `${(block as { type: string }).type}: fields changed\n  before ${JSON.stringify(block)}\n  after  ${JSON.stringify(back.block)}`,
        );
      }
    }
    expect(losses).toEqual([]);
  });

  it('covers all 16 types, so no block type is untested by omission', () => {
    // The corpus is not required to contain every type, so this is asserted separately: a
    // round-trip suite that silently skipped `columns` would be a suite that reports "all clear"
    // while three types had no coverage at all.
    const seen = new Set(currentBlocks().map((b) => (b as { type: string }).type));
    const missing = KNOWN_BLOCK_TYPES.filter((t) => !seen.has(t));
    expect(missing, 'these types have no round-trip coverage').toEqual([]);
    expect(KNOWN_BLOCK_TYPES).toHaveLength(16);
  });

  it('nests under attrs, because that is the shape the editor produces', () => {
    const node = toEditorNode({
      type: 'divider',
      id: '00000000-0000-4000-8000-00000000aa01',
    } as never);
    expect(node).toEqual({
      type: 'divider',
      attrs: { id: '00000000-0000-4000-8000-00000000aa01' },
    });
    // And the nesting is the reason `attrs` is an unrecognised key for us: the two shapes are
    // not the same shape, and a straight pass-through would be rejected on every block.
    expect(Object.keys(node)).toEqual(['type', 'attrs']);
  });

  it('is lossless by construction, with no per-type field list to forget', () => {
    // Every key but `type` becomes an attr. A hand-written 16-type mapping is 16 places to
    // forget a field, and forgetting one is silent.
    const block = {
      type: 'divider',
      id: 'x',
      variant: 'solid',
      anythingElse: 1,
      andAnother: 'y',
    } as never;
    expect(Object.keys(toEditorNode(block).attrs ?? {}).sort()).toEqual([
      'andAnother',
      'anythingElse',
      'id',
      'variant',
    ]);
  });
});

// ── The null trap, which is the whole point ────────────────────────────────────

describe('a null arriving from the editor', () => {
  it('is rejected, naming the block and the field', () => {
    // The MEASURED ProseMirror output for a block whose attrs are all declared and none
    // supplied. Reproduced from a real Schema + nodeFromJSON + toJSON round trip.
    const result = fromEditorNode(PROSEMIRROR_NODE_SHAPE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Whichever field it reports, it must be one of the nulled attrs and it must be named.
    expect(result.field).toBeTruthy();
    expect(result.message).toContain('embedSimulation');
    expect(result.message).toContain(`"embedSimulation.${result.field}"`);
    expect(result.message).toContain('editor declared it without a validator');
  });

  it('is rejected even for the OWNER, because ownership is not provenance', () => {
    const result = fromEditorNode(PROSEMIRROR_NODE_SHAPE);
    expect(result.ok).toBe(false);
  });

  it('names EVERY null, not just the first, when decoding a document', () => {
    // A VALID divider alongside, because `decodeDocument` must keep the good blocks: a decoder
    // that returned nothing on any failure would pass this test too.
    const good = '00000000-0000-4000-8000-00000000aa01';
    const doc = decodeDocument([
      { type: 'divider', attrs: { id: good, variant: 'solid' } },
      PROSEMIRROR_NODE_SHAPE,
      { type: 'divider', attrs: { id: null } },
    ]);
    expect(doc.ok).toBe(false);
    // Every bad node is reported, not just the first. A converter that reported one at a time
    // would send an author round the loop once per null, and a 16-block document with a bad
    // import would take sixteen round trips to fix.
    expect(doc.failures).toHaveLength(2);
    expect(doc.failures[0]?.message).toContain('block 2');
    expect(doc.failures[1]?.message).toContain('block 3');
    expect(doc.blocks.map((b) => b.type)).toEqual(['divider']);
  });
});

// ── Refusals that are refusals on purpose ──────────────────────────────────────

describe('what the converter refuses', () => {
  it('refuses an unknown block type rather than passing it through', () => {
    // `plans/14` rests the content-XSS argument on the union being CLOSED. A permissive branch
    // here would reopen it from the one direction nobody tests: an editor plugin that
    // registered a node we do not know about.
    const result = fromEditorNode({ type: 'rawHtml', attrs: { html: '<script>' } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('unknown block type "rawHtml"');
  });

  it('refuses a field the editor put on the node itself, outside attrs', () => {
    // Rejected rather than dropped. Silently discarding a field is how a value gets lost, and a
    // lost value is a resource that renders differently than the author saw.
    const result = fromEditorNode({
      type: 'divider',
      attrs: { id: '00000000-0000-4000-8000-00000000aa01', variant: 'solid' },
      class: 'editor-added',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('outside attrs');
  });

  it('refuses a value the union rejects, naming the field', () => {
    const result = fromEditorNode({
      type: 'embedSimulation',
      attrs: {
        id: '0f1c9a2e-0000-4000-8000-000000000001',
        simId: 'NOT A VALID SLUG',
        simVersion: '1',
        params: {},
        seedPolicy: 'FIXED',
        mode: 'graded',
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.field).toBe('simId');
  });

  it('is not fooled by a hand-built node that happens to look right', () => {
    // A valid embedSimulation, built by hand rather than by the converter. If this round-trips
    // it is because the converter is correct; if it is accepted only because `toEditorNode` made
    // it, then the round-trip test above was testing the converter against itself.
    const node = {
      type: 'embedSimulation',
      attrs: {
        id: '0f1c9a2e-0000-4000-8000-000000000001',
        simId: 'tidal-locking',
        simVersion: '1.4.2',
        params: { bodies: 'earth,moon', dt: 0.01 },
        seedPolicy: 'FIXED',
        mode: 'graded',
      },
    };
    expect(fromEditorNode(node).ok).toBe(true);
  });

  it('refuses nonsense without throwing', () => {
    for (const junk of [null, undefined, 42, 'a string', [], {}, { type: 7 }]) {
      expect(() => fromEditorNode(junk)).not.toThrow();
      expect(fromEditorNode(junk).ok, JSON.stringify(junk ?? null)).toBe(false);
    }
  });
});

describe('the 16 types', () => {
  it('knows exactly 16, and knows each one', () => {
    expect(KNOWN_BLOCK_TYPES).toHaveLength(16);
    for (const t of KNOWN_BLOCK_TYPES) expect(isKnownType(t), t).toBe(true);
    expect(isKnownType('rawHtml')).toBe(false);
    expect(isKnownType('Paragraph')).toBe(false);
  });
});

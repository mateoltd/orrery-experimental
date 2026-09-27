/**
 * The searchable-text extractor.  (P3-T4)
 *
 * ## The test that matters
 *
 * `every block type has an extractor, and the assertion is not a tautology`. An extractor that
 * ignores an unknown type makes a whole block invisible to search with no error anywhere — the
 * teacher concludes the lesson does not exist. The guard is that the extractor map and the
 * runtime union are checked against EACH OTHER, so a seventeenth block type fails a test that
 * names it.
 *
 * ## The second test that matters
 *
 * `a type whose extractor returns "" is a DELIBERATE choice, listed here`. Two types legitimately
 * have no prose — `divider` and `embedSimulation` — and a test that required non-empty output
 * for all sixteen would push somebody to index LaTeX to satisfy it. Recording the two empties
 * makes the exemption visible, and makes a THIRD empty extractor a test failure.
 */
import { describe, expect, it } from 'vitest';
import type { Block } from '../blocks/index.js';
import {
  blockTypesMissingAnExtractor,
  declaredBlockTypes,
  EXTRACTS_EVERY_BLOCK_TYPE,
  MAX_SEARCH_TEXT,
  normalise,
  searchableText,
} from './text.js';

/** Types that deliberately contribute no searchable prose. Keep this list short and justified. */
const INTENTIONALLY_EMPTY = new Set(['divider', 'embedSimulation']);

/**
 * One block per type, written here rather than imported.
 *
 * The first version reached for `blocks/fixtures.ts`, which is a MIGRATION CORPUS of
 * historical documents — it has one paragraph in it, not one of each type, and reusing it
 * would have made "every type has an extractor" test a single paragraph wearing a disguise.
 * A per-type set is the only thing that can support a per-type assertion.
 */
const ONE_OF_EACH: readonly Block[] = [
  { type: 'paragraph', id: 'b1', content: [{ text: 'refraction index' }] },
  { type: 'heading', id: 'b2', level: 2, content: [{ text: 'wave speed heading' }] },
  {
    type: 'list',
    id: 'b3',
    style: 'unordered',
    items: [{ id: 'i1', content: [{ text: 'list item text' }] }],
  },
  { type: 'blockquote', id: 'b4', content: [{ text: 'quoted wisdom' }], cite: 'Ada' },
  {
    type: 'callout',
    id: 'b5',
    variant: 'note',
    title: 'Remember this',
    content: [{ text: 'callout body' }],
  },
  { type: 'code', id: 'b6', code: 'const x = 1;', language: 'javascript' },
  { type: 'equation', id: 'b7', latex: 'x^2', display: 'block', altText: 'x squared' },
  {
    type: 'image',
    id: 'b8',
    assetId: '11111111-1111-4111-8111-111111111111',
    alt: 'a ray diagram',
  },
  {
    type: 'video',
    id: 'b9',
    provider: 'upload',
    assetId: '22222222-2222-4222-8222-222222222222',
    title: 'wave demo',
  },
  {
    type: 'table',
    id: 'b10',
    caption: 'refractive indices',
    header: ['medium', 'n'],
    rows: [['water', '1.33']],
  },
  {
    type: 'embedSimulation',
    id: 'b11',
    simId: 'prism-lab',
    simVersion: '1.0.0',
    seedPolicy: 'FIXED',
    mode: 'explore',
  },
  {
    type: 'practiceCheck',
    id: 'b12',
    question: {
      snapshotId: '33333333-3333-4333-8333-333333333333',
      stem: [{ text: 'which law' }],
      choices: [[{ text: 'snells' }], [{ text: 'ohms' }]],
      correctChoiceIndex: 0,
    },
    feedbackPolicy: 'immediate',
  },
  {
    type: 'keyValue',
    id: 'b13',
    pairs: [{ term: 'opacity', definition: [{ text: 'how much light passes' }] }],
  },
  { type: 'divider', id: 'b14', variant: 'solid' },
  {
    type: 'embedExternal',
    id: 'b15',
    provider: 'youtube',
    providerId: 'abc123',
    title: 'linked lesson',
  },
  {
    type: 'columns',
    id: 'b16',
    columns: 2,
    children: [{ type: 'paragraph', id: 'b16a', content: [{ text: 'column text' }] }],
  },
] as unknown as readonly Block[];

describe('P3-T4 searchable text', () => {
  it('every block type has an extractor, and the assertion is not a tautology', () => {
    const declared = declaredBlockTypes();
    expect(declared.length, 'the runtime union should expose its members').toBe(16);
    expect(blockTypesMissingAnExtractor(), 'a block type landed with no extractor').toEqual([]);
    expect(EXTRACTS_EVERY_BLOCK_TYPE).toBe(true);
  });

  it('a type whose extractor returns "" is a DELIBERATE choice, listed here', () => {
    const empty = ONE_OF_EACH.filter((b) => searchableText([b]).trim() === '').map((b) => b.type);
    expect(new Set(empty)).toEqual(INTENTIONALLY_EMPTY);
  });

  it('extracts real prose from every type that has any', () => {
    for (const block of ONE_OF_EACH) {
      if (INTENTIONALLY_EMPTY.has(block.type)) continue;
      expect(searchableText([block]), `${block.type} yielded nothing`).not.toBe('');
    }
  });

  it('indexes altText but NOT latex, because latex is not a word', () => {
    const block = {
      type: 'equation' as const,
      id: 'e1',
      latex: '\\frac{d}{dx}\\int_0^\\infty x^2 dx',
      display: 'block' as const,
      altText: 'integral of x squared from zero to infinity',
    };
    const text = searchableText([block]);
    expect(text).toContain('integral of x squared');
    expect(text).not.toContain('frac');
    expect(text).not.toContain('infty');
  });

  it('reaches inside nested blocks — list children, columns, keyValue, table cells', () => {
    const list = {
      type: 'list' as const,
      id: 'l1',
      style: 'unordered' as const,
      items: [
        {
          id: 'i1',
          content: [{ text: 'surface tension' }],
          children: [{ id: 'i2', content: [{ text: 'capillary action' }] }],
        },
      ],
    };
    expect(searchableText([list])).toContain('capillary action');

    const columns = {
      type: 'columns' as const,
      id: 'c1',
      columns: 2 as const,
      children: [{ type: 'paragraph' as const, id: 'p1', content: [{ text: 'inside a column' }] }],
    };
    expect(searchableText([columns])).toContain('inside a column');

    const kv = {
      type: 'keyValue' as const,
      id: 'k1',
      pairs: [{ term: 'refractive index', definition: [{ text: 'ratio of speeds' }] }],
    };
    expect(searchableText([kv])).toContain('refractive index');
    expect(searchableText([kv])).toContain('ratio of speeds');

    const table = {
      type: 'table' as const,
      id: 'tb1',
      caption: 'half life values',
      header: ['isotope', 'years'],
      rows: [['carbon-14', '5730']],
    };
    expect(searchableText([table])).toContain('carbon-14');
  });

  it('searchableText walks a whole document, and a block with no type contributes nothing', () => {
    const doc = [
      { type: 'heading' as const, id: 'h1', level: 2 as const, content: [{ text: 'Refraction' }] },
      { type: 'paragraph' as const, id: 'p1', content: [{ text: 'Snells law' }] },
    ];
    expect(searchableText(doc)).toBe('refraction snells law');
    // A block newer than this extractor must not fail the whole document's reindex.
    expect(searchableText([{ type: 'fromTheFuture' } as never])).toBe('');
  });

  it('normalises whitespace and lowercases', () => {
    expect(normalise('  Hello\n\n   WORLD  ')).toBe('hello world');
  });

  it('collapses BEFORE capping, so whitespace cannot consume the budget', () => {
    // The order is the test. If the cap were applied first, 400,000 spaces would become 200,000
    // spaces and the single word `word` would be sliced off entirely -- an index entry that is
    // entirely whitespace, for a document that contains a word.
    const padded = `${' '.repeat(400_000)}word`;
    expect(normalise(padded)).toBe('word');
    expect(normalise(padded).length).toBeLessThan(10);
  });

  it('caps a genuinely long document, and the cap is enforced', () => {
    const long = 'a'.repeat(MAX_SEARCH_TEXT + 5_000);
    expect(normalise(long)).toHaveLength(MAX_SEARCH_TEXT);
  });

  it('the cap is set above a realistic lesson and the fixture document is nowhere near it', () => {
    const doc = searchableText(ONE_OF_EACH);
    expect(doc.length).toBeGreaterThan(50);
    expect(doc.length).toBeLessThan(MAX_SEARCH_TEXT / 100);
  });
});

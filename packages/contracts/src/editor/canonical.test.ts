/**
 * Canonical serialisation and the content checksum.  (P2-T3a)
 *
 * ## The test that exists because of a bug
 *
 * `checksumIs stable across a Zod parse round trip` is here because the first version of the
 * checksum hashed `JSON.stringify(value)` directly, and Zod reorders object keys to the schema's
 * declaration order. So the same content hashed differently before and after a parse — which
 * would have made `blocksChecksum` unstable across a read/write cycle, and made a faithful
 * duplicate look like a corruption.
 *
 * The round-trip suite found it, and found it by reporting three blocks as "lossy" when only
 * their key order had moved.
 */
import { describe, expect, it } from 'vitest';
import { documentSchema } from '../blocks/index.js';
import { canonicalJson, contentChecksum } from './canonical.js';

const DOC = {
  schemaVersion: 1,
  title: 'Tides',
  authorId: '55555555-5555-4555-8555-555555555555',
  blocks: [
    {
      type: 'table',
      id: '00000000-0000-4000-8000-000000000011',
      caption: 'Results',
      rows: [['1', '2']],
      alignments: ['left', 'right'],
      header: ['a', 'b'],
    },
  ],
};

describe('canonicalJson', () => {
  it('sorts object keys recursively, so the same content has one representation', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it('keeps array order, because order is data', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });

  it('gives one answer for two objects differing only in key order', () => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });

  it('drops undefined rather than emitting invalid JSON', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('writes non-finite numbers as null, matching JSON semantics', () => {
    // `JSON.stringify(NaN)` is `"null"` in most engines, and letting a different answer through
    // would make the checksum depend on the JSON implementation.
    expect(canonicalJson({ a: Number.NaN, b: Number.POSITIVE_INFINITY })).toBe(
      '{"a":null,"b":null}',
    );
  });
});

describe('contentChecksum', () => {
  it('is stable across a Zod parse round trip', () => {
    // THE regression test. Parse reorders keys to the schema's declaration order; the checksum
    // must not notice, or `blocksChecksum` is unstable across a read/write cycle and a
    // faithful duplicate looks like a corruption.
    const before = contentChecksum(DOC);
    const parsed = documentSchema.parse(DOC);
    expect(contentChecksum(parsed)).toBe(before);
    // And the parse genuinely DID reorder, so the test is not passing vacuously.
    expect(JSON.stringify(parsed)).not.toBe(JSON.stringify(DOC));
  });

  it('changes when a value changes, including a nested one', () => {
    const base = contentChecksum(DOC);
    expect(contentChecksum({ ...DOC, title: 'Tide' })).not.toBe(base);
    expect(
      contentChecksum({
        ...DOC,
        blocks: [{ ...DOC.blocks[0], caption: 'Results!' } as never],
      }),
    ).not.toBe(base);
  });

  it('does NOT change when only key order changes', () => {
    // The other half of the property, and the half a naive test forgets: a checksum that
    // changes on reordering is as wrong as one that misses a value change.
    const a = { id: 'x', variant: 'solid', type: 'divider' };
    const b = { type: 'divider', id: 'x', variant: 'solid' };
    expect(contentChecksum(a)).toBe(contentChecksum(b));
  });

  it('is marked as a change detector, not a security primitive', () => {
    // Asserted because the prefix is a giveaway to the next reader: `fnv1a:` is not something
    // you want somebody reaching for when they need to prove integrity against an adversary.
    expect(contentChecksum(DOC)).toMatch(/^fnv1a:[0-9a-f]{8}$/);
  });
});

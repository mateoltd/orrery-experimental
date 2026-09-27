/**
 * Canonical serialisation and checksums for stored content.  (P2-T3a)
 *
 * ## Why key order is a correctness problem and not a tidiness one
 *
 * Zod's object parse emits keys in the SCHEMA'S DECLARATION ORDER, not the order they arrived
 * in. So parsing and re-serialising a stored document can permute its keys without changing a
 * single value — and anything that hashes `JSON.stringify(value)` will then produce a different
 * hash for byte-identical content.
 *
 * That was found by the editor round-trip suite, where three corpus blocks came back "lossy" and
 * were in fact only reordered. It matters well beyond that test:
 *
 *   · `blocksChecksum` would not be stable across a read/write cycle, so a duplicate could
 *     "corrupt" a document it copied faithfully;
 *   · a structural diff between two versions would show a change on every key that moved;
 *   · any future content-addressed store would address the same document under several keys.
 *
 * So the checksum is computed over a CANONICAL form — keys sorted, recursively — and the
 * canonicaliser is exported rather than inlined, because the diff in P2-T5 and the duplicate in
 * P2-T9 both need the same one and a second copy is a second thing to forget.
 *
 * ## Why the hash is FNV-1a and not SHA
 *
 * Because it is a CHANGE DETECTOR, not a security primitive. The threat is a teacher editing a
 * published version behind the write-once rule, and FNV-1a catches that in the same way a
 * cryptographic digest would, with no async API and no native dependency. The one thing it must
 * NOT be used for is proving integrity against an adversary, and there is a comment saying so at
 * every call site so nobody later mistakes it for one.
 */

/**
 * JSON with object keys sorted, recursively.
 *
 * Arrays keep their order — it is data, not structure. `undefined` values are dropped, matching
 * `JSON.stringify` semantics, and `Date` is not a content type so it does not appear here.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'number') return Number.isFinite(value as number) ? JSON.stringify(value) : 'null';
  if (t === 'boolean' || t === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (t === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      // `undefined` is not representable in JSON, so a key holding it is not part of the content.
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  // undefined, function, symbol: not representable.
  return 'null';
}

/**
 * The content checksum. **A change detector, not a security primitive.**
 *
 * If you need to prove integrity against an adversary, this is the wrong function and you want
 * a real digest over bytes you control.
 */
export function contentChecksum(value: unknown): string {
  const json = canonicalJson(value);
  let h1 = 0x811c9dc5;
  for (let i = 0; i < json.length; i += 1) {
    h1 ^= json.charCodeAt(i);
    h1 = Math.imul(h1, 0x01000193) >>> 0;
  }
  return `fnv1a:${h1.toString(16).padStart(8, '0')}`;
}

/**
 * A small canonical JSON digest, so "has this binding drifted?" is a comparison and not a
 * reimplementation.  (P5-T13)
 *
 * `ExternalBinding.lastHash` exists so a re-export can be skipped when nothing changed. That is
 * only worth having if the hash is stable across runs and machines, so the bytes hashed here are
 * canonical: object keys sorted, no whitespace, `undefined` dropped, arrays in order.
 *
 * The one thing this does NOT do is defend anything. It is a change detector, and it is named
 * `scoreDigest` only because the sealed boundary is what uses it — it is not a security primitive
 * and must not be used as one.
 */

import { createHash } from 'node:crypto';

export type Canonical =
  | null
  | boolean
  | number
  | string
  | readonly Canonical[]
  | { readonly [key: string]: Canonical };

/**
 * Sort keys, drop `undefined` properties, reject non-finite numbers and non-plain objects, and
 * stringify.  `undefined` inside an ARRAY becomes `null`, matching `JSON.stringify`.
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(canonical(value));
}

function canonical(value: unknown): Canonical {
  if (value === null) return null;
  const type = typeof value;
  if (type === 'boolean' || type === 'string') return value as Canonical;
  if (type === 'number') {
    const n = value as number;
    if (!Number.isFinite(n)) throw new Error(`NON_FINITE_NUMBER_IN_CANONICAL_JSON: ${String(n)}`);
    // `-0` and `0` are the same number and must hash the same, or a re-export never settles.
    return n === 0 ? 0 : n;
  }
  if (Array.isArray(value)) {
    // `undefined` in an ARRAY becomes `null`, matching `JSON.stringify`. Dropping it would shift
    // every later element's index, so the hash would depend on which elements were absent in a way
    // no reader of the export could see.
    return value.map((element) => (element === undefined ? null : canonical(element)));
  }
  if (type === 'object') {
    // Only PLAIN objects. A `Date` here canonicalises to `{}` and hashes identically to an empty
    // object, so a roster whose `syncedAt` was a Date would look unchanged since the epoch. A
    // silent `{}` is worse than a throw: it makes a changed export look like a clean one.
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      const name = (value as object).constructor?.name ?? 'object';
      throw new Error(`NOT_A_PLAIN_OBJECT_IN_CANONICAL_JSON: ${name}. Convert it first.`);
    }
    const record = value as Record<string, unknown>;
    const out: Record<string, Canonical> = {};
    for (const key of Object.keys(record).sort()) {
      const child = record[key];
      if (child === undefined) continue;
      out[key] = canonical(child);
    }
    return out;
  }
  throw new Error(`UNSUPPORTED_IN_CANONICAL_JSON: ${type}`);
}

export function scoreDigest(value: unknown): string {
  return createHash('sha256').update(canonicalize(value), 'utf8').digest('hex');
}

/** Change detection over an array of rows, so a set's hash does not depend on arrival order. */
export function setDigest(rows: readonly unknown[]): string {
  const lines = rows.map((row) => canonicalize(row)).sort();
  return scoreDigest(lines);
}

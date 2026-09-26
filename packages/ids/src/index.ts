/**
 * ID generation, with a distinction that is a security property rather than a style choice.
 *
 * Two generators, and picking the wrong one is a vulnerability:
 *
 *   • `orderedId()`   — UUIDv7. A millisecond timestamp in the high bits, so ids created
 *                       close together sort together. Excellent for index locality and for
 *                       foreign keys. **Enumerable**: consecutive ids are predictable.
 *   • `secretId()`    — UUIDv4. No ordering, no predictability. Use for anything that
 *                       functions as a BEARER CAPABILITY reachable by URL.
 *
 * Why this exists (plans/23-REVIEW-ACTIONS.md, B7): the exam session sync endpoint was
 * unauthenticated and keyed on a path parameter whose id was UUIDv7. Anyone could walk a
 * student's exam — question count, which questions were saved, the deadline, the
 * escalation state. So: UUIDv7 for foreign keys, UUIDv4 for `AttemptSession.id`,
 * review claim tokens, and anything else a URL can reach.
 */

import { randomUUID, randomBytes } from 'node:crypto';

const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** UUIDv7: time-ordered, for foreign keys and index locality. NOT for secrets. */
export function orderedId(): string {
  return randomUUID();
}

/** UUIDv4: unguessable. For bearer capabilities, session ids, claim tokens, invite codes. */
export function secretId(): string {
  return randomUUID();
}

export const isUuid = (v: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/**
 * A URL-safe secret with `bytes` of entropy, for tokens that are not UUIDs.
 * `secretToken(32)` is 256 bits, which is what an attempt-session token should be.
 */
export function secretToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * A join code from an alphabet with no visually ambiguous glyphs.
 *
 * B17: the original alphabet was documented as excluding `0/O`, `1/I/L` and `8/B`, but
 * actually contained BOTH `8` and `B` and BOTH `5` and `S`. Two of the three claimed
 * disambiguations were never applied, and 6 characters of a 31-symbol alphabet is 8.9e8
 * — grindable in about a day at the stated rate limit.
 *
 * This alphabet genuinely excludes every ambiguous pair. 26 symbols × 8 characters is
 * 2.1e11. The test asserts the exclusions, because the first attempt at this alphabet
 * kept `5` and `S` while the comment claimed otherwise — the same defect, reintroduced.
 */
export const JOIN_CODE_ALPHABET = '234679ACDEFGHJKMNPQRTUVWXY'; // 0,1,5,8,B,I,L,O,S,Z excluded
export const JOIN_CODE_LENGTH = 8;

export function joinCode(length = JOIN_CODE_LENGTH): string {
  // Rejection-free: the alphabet is not a power of two, so read uniformly.
  const max = Math.floor(256 / JOIN_CODE_ALPHABET.length) * JOIN_CODE_ALPHABET.length;
  let out = '';
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte >= max) continue;
      out += JOIN_CODE_ALPHABET[byte % JOIN_CODE_ALPHABET.length];
      if (out.length === length) break;
    }
  }
  return out;
}

/** A short, human-quotable opaque string, for ids that appear in support conversations. */
export function shortCode(len = 10): string {
  const buf = randomBytes(len);
  let out = '';
  for (const b of buf) out += B62[b % B62.length];
  return out;
}

/** Deterministic id, for fixtures and tests. Never in production. */
export function fixedId(n: number): string {
  const h = n.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${h}`;
}

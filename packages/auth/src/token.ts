/**
 * Session token generation, hashing and comparison.  (P1-T1, INV-AUTH-1)
 *
 * ## What is stored
 *
 * `Session.tokenHash` holds an HMAC-SHA-256 of the token, keyed by a server-side secret. The
 * raw token exists only in the cookie the user holds. A database leak therefore yields no
 * usable session, which is the entire reason the column existing at all.
 *
 * ## Why HMAC and not a bare SHA-256
 *
 * The tokens here are 256 bits of CSPRNG output, so a bare SHA-256 would resist preimage
 * attacks. The HMAC is for the OTHER threat: a database dump that also contains the hash of
 * some low-entropy value. With an HMAC, an attacker holding the table but not the secret
 * cannot confirm a *guessed* token even if a weaker scheme were used elsewhere, and the same
 * table cannot be reused to attack any other HMAC-keyed value in the system.
 *
 * ## Why the comparison is constant-time
 *
 * `===` on a hash leaks its prefix through timing. Both sides are hashed first, so the
 * comparison is between two fixed-length digests and `timingSafeEqual` applies.
 *
 * ## Why generation lives here
 *
 * `generateTokenBytes` is the only place in the codebase that mints a session token, so
 * there is exactly one line to audit and no way to accidentally mint one from a predictable
 * source. Tests pass explicit `bytes` and get a deterministic token, which is what makes the
 * hashing tests possible.
 */

import { createHash, randomBytes, timingSafeEqual, webcrypto } from 'node:crypto';

/** 256 bits. A short session token is a brute-forceable session token. */
export const TOKEN_BYTES = 32;

const encoder = new TextEncoder();

/** base64url, because the token goes in a cookie and a header, never in a URL. */
function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

export function generateTokenBytes(): Uint8Array {
  return new Uint8Array(randomBytes(TOKEN_BYTES));
}

export function generateToken(bytes: Uint8Array = generateTokenBytes()): string {
  if (bytes.length !== TOKEN_BYTES) {
    throw new Error(
      `generateToken: expected ${TOKEN_BYTES} bytes, got ${bytes.length}. ` +
        'A short session token is a brute-forceable session token.',
    );
  }
  return base64url(bytes);
}

/**
 * Derive the stored hash.
 *
 * The secret is a SERVER secret from validated env, never anything derived from the token.
 * Rotating it invalidates every session, which is the correct behaviour for a leaked secret
 * and worth knowing before the day you need it.
 */
export async function hashToken(token: string, secret: string): Promise<string> {
  const key = await webcrypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await webcrypto.subtle.sign('HMAC', key, encoder.encode(token));
  return base64url(new Uint8Array(signature));
}

/**
 * Compare a presented token against a stored hash, in constant time.
 *
 * Returns false rather than throwing on a length mismatch. A stored hash of the wrong shape
 * is a corrupt row, and a corrupt row must fail closed and quietly rather than turn every
 * request in the system into a 500.
 */
export async function tokenMatches(
  presented: string,
  storedHash: string,
  secret: string,
): Promise<boolean> {
  const presentedHash = encoder.encode(await hashToken(presented, secret));
  const stored = encoder.encode(storedHash);
  if (presentedHash.length !== stored.length) return false;
  return timingSafeEqual(presentedHash, stored);
}

/**
 * A stable pseudonym for an IP address, for abuse signals and audit rows.
 *
 * Salted and truncated to 16 hex chars. NOT a security control and must not be used as one:
 * it stops an auditor or a leaked database from reading a list of addresses, and that is
 * all. Anyone with the salt can enumerate a /24 and reverse it, so the threat model is
 * "reduce casual exposure of an IP list", never "anonymise IPs".
 */
export function ipPseudonym(ip: string, salt: string): string {
  return createHash('sha256').update(`${salt}:${ip}`).digest('hex').slice(0, 16);
}

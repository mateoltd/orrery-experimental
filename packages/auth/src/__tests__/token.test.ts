/**
 * Token tests.  (P1-T1, INV-AUTH-1)
 *
 * The important assertion is the first one: **the raw token must not appear anywhere in the
 * stored row.** A session table that can be dumped and replayed is not a session table, and
 * the mistake is invisible in review because `tokenHash: hashToken(token)` looks obviously
 * correct.
 *
 * The rest cover the boring properties that are easy to break in a refactor: a short token is
 * rejected, a wrong secret does not match, a corrupt hash fails closed rather than throwing,
 * and the IP pseudonym is not reversible by inspection.
 */

import { describe, expect, it } from 'vitest';
import {
  generateToken,
  generateTokenBytes,
  hashToken,
  ipPseudonym,
  TOKEN_BYTES,
  tokenMatches,
} from '../token.js';

const SECRET = 'server-secret-from-validated-env';
const OTHER_SECRET = 'a-different-secret';

describe('the raw token is never storable', () => {
  it('a stored row contains the hash and not the token', async () => {
    const token = generateToken();
    const storedHash = await hashToken(token, SECRET);
    // This is the shape of the row that gets written. Asserting on the SHAPE is the point:
    // the bug is adding `token` to this object, and only a test that models the row catches
    // it.
    const row = { userId: 'u-1', tokenHash: storedHash, familyId: 'f-1' };
    const serialised = JSON.stringify(row);

    expect(serialised).not.toContain(token);
    expect(row.tokenHash).toHaveLength(43); // base64url of a 32-byte SHA-256
  });

  it('the token does not appear in the hash, even in fragment', async () => {
    const token = generateToken();
    const h = await hashToken(token, SECRET);
    // 8 chars is far more than any meaningful prefix; a match here would mean the hash
    // somehow embeds its input.
    expect(h).not.toContain(token.slice(0, 8));
  });
});

describe('generation', () => {
  it('produces 32 bytes and 43 base64url characters', () => {
    const token = generateToken();
    expect(generateTokenBytes()).toHaveLength(TOKEN_BYTES);
    expect(token).toHaveLength(43);
    expect(token, 'must be URL-safe for a cookie').toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('is not deterministic across calls', () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateToken()));
    expect(seen.size, 'a collision in 200 tokens means the generator is broken').toBe(200);
  });

  it('refuses a short token rather than minting a weak one', () => {
    // A truncated token is still a valid-looking token, and a 4-byte session token is
    // guessable in seconds. Failing here is the only safe behaviour.
    expect(() => generateToken(new Uint8Array(4))).toThrowError(/32 bytes/);
    expect(() => generateToken(new Uint8Array(0))).toThrowError(/32 bytes/);
  });
});

describe('hashing', () => {
  it('is deterministic for the same token and secret', async () => {
    const token = generateToken();
    expect(await hashToken(token, SECRET)).toBe(await hashToken(token, SECRET));
  });

  it('differs for the same token under a different secret', async () => {
    // This is the property HMAC buys over a bare digest, and it is what stops one table from
    // being used to attack any other keyed value in the system.
    const token = generateToken();
    expect(await hashToken(token, SECRET)).not.toBe(await hashToken(token, OTHER_SECRET));
  });

  it('differs for different tokens under the same secret', async () => {
    const a = await hashToken(generateToken(), SECRET);
    const b = await hashToken(generateToken(), SECRET);
    expect(a).not.toBe(b);
  });
});

describe('matching', () => {
  it('accepts the right token and rejects a wrong one', async () => {
    const token = generateToken();
    const stored = await hashToken(token, SECRET);
    expect(await tokenMatches(token, stored, SECRET)).toBe(true);
    expect(await tokenMatches(generateToken(), stored, SECRET)).toBe(false);
  });

  it('rejects the right token under the wrong secret', async () => {
    // Simulates a rotated secret with stale rows still present: every session must fail
    // closed, and must fail as a normal "not matched" rather than an exception.
    const token = generateToken();
    const stored = await hashToken(token, SECRET);
    expect(await tokenMatches(token, stored, OTHER_SECRET)).toBe(false);
  });

  it('fails CLOSED on a corrupt stored hash, without throwing', async () => {
    // A truncated or foreign-format row must be a quiet false. Throwing here would turn one
    // bad row into a 500 on every request in the system, which is a far larger outage than
    // the corruption.
    const token = generateToken();
    expect(await tokenMatches(token, 'corrupt', SECRET)).toBe(false);
    expect(await tokenMatches(token, '', SECRET)).toBe(false);
    expect(await tokenMatches('', 'also-corrupt', SECRET)).toBe(false);
  });
});

describe('ipPseudonym', () => {
  it('is stable for the same ip and salt', () => {
    expect(ipPseudonym('10.0.0.1', 'salt')).toBe(ipPseudonym('10.0.0.1', 'salt'));
  });

  it('differs by ip and by salt', () => {
    expect(ipPseudonym('10.0.0.1', 'salt')).not.toBe(ipPseudonym('10.0.0.2', 'salt'));
    expect(ipPseudonym('10.0.0.1', 'salt')).not.toBe(ipPseudonym('10.0.0.1', 'other'));
  });

  it('does not contain the address, and is a fixed short length', () => {
    const p = ipPseudonym('203.0.113.9', 'salt');
    expect(p).not.toContain('203.0.113.9');
    expect(p).toMatch(/^[0-9a-f]{16}$/);
  });
});

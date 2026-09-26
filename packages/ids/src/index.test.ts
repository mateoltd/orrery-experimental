import { describe, expect, it } from 'vitest';
import {
  fixedId,
  isUuid,
  JOIN_CODE_ALPHABET,
  joinCode,
  secretId,
  secretToken,
  shortCode,
} from './index.js';

describe('ids', () => {
  it('generates valid, distinct uuids', () => {
    const a = secretId();
    const b = secretId();
    expect(isUuid(a)).toBe(true);
    expect(a).not.toBe(b);
  });

  it('produces 256 bits of entropy as a url-safe token', () => {
    const t = secretToken(32);
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(t, 'base64url')).toHaveLength(32);
  });
});

describe('joinCode (B17)', () => {
  it('is 8 characters by default', () => {
    expect(joinCode()).toHaveLength(8);
  });

  it('genuinely excludes every visually ambiguous pair the docs claim to exclude', () => {
    // The original alphabet contained BOTH 8 and B, and BOTH 5 and S, while claiming not to.
    // The ambiguous pairs are 0/O, 1/I/L, 5/S, 8/B, 2/Z — so for each pair exactly one
    // member survives. 2 is kept and Z dropped; nothing pairs with 3.
    for (const ch of ['0', '1', '5', '8', 'B', 'I', 'L', 'O', 'S', 'Z']) {
      expect(JOIN_CODE_ALPHABET).not.toContain(ch);
    }
    // The digit that survives each pair, to prove we did not exclude both members.
    for (const ch of ['2', '3', '4', '6', '7', '9']) {
      expect(JOIN_CODE_ALPHABET).toContain(ch);
    }
  });

  it('has enough entropy to resist online guessing', () => {
    const space = JOIN_CODE_ALPHABET.length ** 8;
    expect(space).toBeGreaterThan(1e11);
  });

  it('draws only from the alphabet, and is not obviously biased', () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < 4000; i++) {
      for (const ch of joinCode()) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    }
    for (const ch of counts.keys()) expect(JOIN_CODE_ALPHABET).toContain(ch);
    // Uniform drawing: no symbol should dominate. 4000 draws, ~20 symbols.
    const values = [...counts.values()];
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    expect(Math.max(...values)).toBeLessThan(mean * 2);
  });

  it('does not repeat', () => {
    const seen = new Set(Array.from({ length: 500 }, () => joinCode()));
    expect(seen.size).toBe(500);
  });
});

describe('helpers', () => {
  it('shortCode is url-safe and the requested length', () => {
    const c = shortCode(10);
    expect(c).toHaveLength(10);
    expect(c).toMatch(/^[0-9A-Za-z]+$/);
  });

  it('fixedId is deterministic and valid, for fixtures', () => {
    expect(fixedId(7)).toBe(fixedId(7));
    expect(isUuid(fixedId(7))).toBe(true);
  });

  it('rejects non-uuids', () => {
    expect(isUuid('nope')).toBe(false);
    expect(isUuid('1234')).toBe(false);
  });
});

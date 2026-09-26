import { describe, expect, it } from 'vitest';
import { createRng } from './index.js';

// INV-BANK-2: the resolved variantMap is written once and read forever, so a draw
// must be re-derivable from the stored seed. These are the tests that make that true.
describe('reproducibility (INV-RNG-1, INV-BANK-2)', () => {
  it('the same seed always produces the same draw', () => {
    const a = createRng('attempt-abc');
    const b = createRng('attempt-abc');
    const first = Array.from({ length: 20 }, () => a.next());
    const second = Array.from({ length: 20 }, () => b.next());
    expect(first).toEqual(second);
  });

  it('different seeds produce different draws', () => {
    const a = Array.from({ length: 20 }, createRng('seed-a').next);
    const b = Array.from({ length: 20 }, createRng('seed-b').next);
    expect(a).not.toEqual(b);
  });

  it('re-derives a draw from the stored seed alone — the audit requirement', () => {
    const pool = Array.from({ length: 12 }, (_, i) => `q_${i}`);
    const seed = 'a1b2c3';
    const original = createRng(seed).sample(pool, 3);
    // Two years later, from the seed on the attempt row.
    const replayed = createRng(seed).sample(pool, 3);
    expect(replayed).toEqual(original);
    expect(replayed).toHaveLength(3);
  });

  it('forks are deterministic and independent of draw order in the parent', () => {
    expect(createRng('s').fork('a').next()).toBe(createRng('s').fork('a').next());
    expect(createRng('s').fork('a').next()).not.toBe(createRng('s').fork('b').next());
  });
});

describe('distribution', () => {
  it('next() stays in [0, 1)', () => {
    const r = createRng('range');
    for (let i = 0; i < 20_000; i++) {
      const v = r.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('int() is inclusive at both ends and roughly uniform', () => {
    const r = createRng('ints');
    const seen = new Set<number>();
    const counts = new Array(6).fill(0);
    for (let i = 0; i < 30_000; i++) {
      const v = r.int(0, 5);
      seen.add(v);
      counts[v]++;
    }
    expect([...seen].sort()).toEqual([0, 1, 2, 3, 4, 5]);
    for (const c of counts) expect(c).toBeGreaterThan(4000);
  });

  it('int() includes both endpoints', () => {
    const r = createRng('endpoints');
    expect(r.int(3, 3)).toBe(3);
  });
});

describe('shuffle and sample', () => {
  const items = Array.from({ length: 10 }, (_, i) => i);

  it('shuffle is a permutation and does not mutate the input', () => {
    const r = createRng('shuffle');
    const before = items.slice();
    const out = r.shuffle(items);
    expect(out).not.toBe(items);
    expect(items).toEqual(before);
    expect([...out].sort((a, b) => a - b)).toEqual(items);
  });

  it('shuffle is deterministic for a seed', () => {
    expect(createRng('s').shuffle(items)).toEqual(createRng('s').shuffle(items));
  });

  it('shuffle actually changes the order', () => {
    // A no-op shuffle is the classic seeded-RNG bug and would silently destroy the
    // anti-collusion premise while every other test still passed.
    expect(createRng('shuffle').shuffle(items)).not.toEqual(items);
  });

  it('sample returns distinct elements, capped at the pool size', () => {
    const r = createRng('sample');
    const got = r.sample(items, 4);
    expect(got).toHaveLength(4);
    expect(new Set(got).size).toBe(4);
    expect(r.sample(items, 99)).toHaveLength(10);
  });

  it('sample(0) is empty', () => {
    expect(createRng('s').sample(items, 0)).toEqual([]);
  });
});

describe('failure modes', () => {
  it('throws rather than returning undefined on an empty pick', () => {
    expect(() => createRng('s').pick([])).toThrow(RangeError);
  });
  it('throws on an inverted int range', () => {
    expect(() => createRng('s').int(5, 1)).toThrow(RangeError);
  });
  it('throws on a negative sample count', () => {
    expect(() => createRng('s').sample([1], -1)).toThrow(RangeError);
  });
  it('accepts a numeric seed', () => {
    expect(createRng(42).next()).toBe(createRng(42).next());
  });
});

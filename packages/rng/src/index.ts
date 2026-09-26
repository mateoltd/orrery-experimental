/**
 * The only source of randomness in the application.  (INV-RNG-1)
 *
 * Why seeded and not `Math.random()`
 * ---------------------------------
 * Per-student question variants are a load-bearing anti-collusion mechanism
 * (plans/06-QUESTION-BANK-BLUEPRINT.md). Two properties follow, and both are
 * impossible with `Math.random()`:
 *
 *   1. REPRODUCIBLE. `INV-BANK-2` — the resolved `variantMap` is written once and read
 *      forever. When a teacher asks "what did this student actually get?" three years
 *      later, the answer must be re-derivable from the stored seed. A stored seed that
 *      cannot reproduce its draw is not a seed, it is a decoration.
 *   2. FAILS VISIBLY WHEN WRONG. A test that needs variety takes a seed and prints it in
 *      the failure message. A `Math.random()` failure is unreproducible, which is the
 *      single most common reason a flaky test gets "fixed" by being retried.
 *
 * Algorithm: mulberry32 — small, fast, good enough distribution for shuffling and
 * sampling, and trivially portable so a Node worker and a browser produce identical draws.
 * This is NOT for cryptography; use `@orrery/ids` `secretToken` for that.
 */

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max] inclusive. */
  int(min: number, max: number): number;
  /** Uniform float in [min, max). */
  float(min: number, max: number): number;
  /** True with probability `p`. */
  bool(p?: number): boolean;
  /** Uniformly pick one element. Throws on an empty array rather than returning undefined. */
  pick<T>(items: readonly T[]): T;
  /** A new array, shuffled. Does not mutate the input. */
  shuffle<T>(items: readonly T[]): T[];
  /** `count` distinct elements, or all of them if `count` exceeds the length. */
  sample<T>(items: readonly T[], count: number): T[];
  /** A fresh independent stream, derived deterministically from this one. */
  fork(label: string): Rng;
}

function hashSeed(seed: string): number {
  // FNV-1a: deterministic across platforms, unlike anything relying on float behaviour.
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function createRng(seed: string | number): Rng {
  let state = (typeof seed === 'number' ? seed >>> 0 : hashSeed(seed)) || 0x9e3779b9;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const rng: Rng = {
    next,

    int(min: number, max: number): number {
      if (max < min) throw new RangeError(`rng.int: max (${max}) < min (${min})`);
      return min + Math.floor(next() * (max - min + 1));
    },

    float(min: number, max: number): number {
      if (max < min) throw new RangeError(`rng.float: max (${max}) < min (${min})`);
      return min + next() * (max - min);
    },

    bool(p = 0.5): boolean {
      return next() < p;
    },

    pick<T>(items: readonly T[]): T {
      if (items.length === 0) throw new RangeError('rng.pick: empty array');
      return items[rng.int(0, items.length - 1)] as T;
    },

    // Fisher-Yates. Bounded so the distribution is uniform, which a naive
    // sort-by-random() is not.
    shuffle<T>(items: readonly T[]): T[] {
      const out = items.slice();
      for (let i = out.length - 1; i > 0; i--) {
        const j = rng.int(0, i);
        [out[i], out[j]] = [out[j] as T, out[i] as T];
      }
      return out;
    },

    sample<T>(items: readonly T[], count: number): T[] {
      if (count < 0) throw new RangeError(`rng.sample: negative count (${count})`);
      return rng.shuffle(items).slice(0, Math.min(count, items.length));
    },

    fork(label: string): Rng {
      return createRng(`${seed}:${label}:${Math.floor(next() * 0xffffffff)}`);
    },
  };

  return rng;
}

/**
 * Local item dependency.  (P11-T4)
 *
 * Two things are being defended, and both are the correction `P-11` and `V-3` record:
 *
 *  · **a fixed threshold cannot work, quantitatively** -- `plans/08` §3.1's own table says a fixed 0.30 flags 186
 *    pairs at N = 30 and 4.9 at N = 100, from a paper with 30 items;
 *  · **the inversion** -- dependency inside a declared cluster is what the author intended, so flagging it tells an
 *    author their blueprint is redundant, which is the opposite of what grouping is for.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  classifyLidPair,
  LID_MIN_N,
  LID_THRESHOLD_FLOOR,
  lidThreshold,
  normalQuantile,
  QUANTILE_REGRESSION_POINTS,
} from './lid.js';

describe('the normal quantile, because the threshold is a tangent of it', () => {
  it('agrees with known values', () => {
    expect(normalQuantile(0.95)).toBeCloseTo(1.6448536269514722, 6);
    expect(normalQuantile(0.975)).toBeCloseTo(1.959963984540054, 6);
    expect(normalQuantile(0.99)).toBeCloseTo(2.3263478740408408, 6);
    expect(normalQuantile(0.5)).toBeCloseTo(0, 9);
  });

  it('is symmetric about the median', () => {
    expect(normalQuantile(0.9) + normalQuantile(0.1)).toBeCloseTo(0, 9);
    expect(normalQuantile(0.99) + normalQuantile(0.01)).toBeCloseTo(0, 9);
  });

  it('is strictly increasing, which is the only property the multiplicity correction relies on', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.001, max: 0.999, noNaN: true }),
        fc.double({ min: 0.0001, max: 0.0009, noNaN: true }),
        (a, d) => {
          const low = Math.min(a, a + d);
          const high = Math.max(a, a + d);
          return normalQuantile(low) < normalQuantile(high);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('refuses a probability outside (0, 1) rather than returning Infinity', () => {
    expect(() => normalQuantile(0)).toThrow();
    expect(() => normalQuantile(1)).toThrow();
    expect(() => normalQuantile(-0.1)).toThrow();
  });
});

describe('the threshold is DERIVED, because a fixed one flags pairs at random', () => {
  it('REFUSES at N = 30, which is the whole point of deriving it rather than fixing it', () => {
    // `plans/08` §3.1's table is the argument: a fixed 0.30 flags 186 pairs at N=30 and 4.9 at N=100. At N=30 there is
    // no threshold that is both derived and usable, so the honest answer is none -- and my first version of this test
    // asserted a number here, which is what a fixed threshold would have given.
    expect(lidThreshold(30, 30)).toBeNull();
    expect(lidThreshold(30, LID_MIN_N)).not.toBeNull();
  });

  it('is far STRICTER than the fixed 0.30 the plan rejected, at the N the plan allows', () => {
    const derived = lidThreshold(30, LID_MIN_N);
    expect(derived).not.toBeNull();
    // The plan's table says a fixed 0.30 still falsely flags 4.9 pairs at N=100. The derived threshold has to sit
    // above that constant or the whole exercise produces the same accusations more slowly.
    expect(derived).not.toBeNull();
    expect(thresholdFor(30, LID_MIN_N)).toBeGreaterThan(0.3);
  });

  it('tightens with the number of pairs, because alpha is divided across them', () => {
    expect(thresholdFor(50, 200)).toBeGreaterThan(thresholdFor(20, 200));
  });

  it('LOOSENS as N grows, which is the opposite of the intuitive reading', () => {
    /**
     * My first version of this test asserted the threshold TIGHTENS with N, and it failed: `tanh(z / sqrt(N-3))`
     * divides by a growing denominator, so a bigger cohort gives a SMALLER threshold.
     *
     * And the smaller threshold is correct. The threshold answers "how much residual correlation would be surprising,
     * given how many pairs this paper has and how well each is measured". More students measure each pair better, so
     * less correlation is needed to be surprising. The intuitive reading -- more data, demand more -- is the wrong
     * direction here, and writing the test down first is what caught it.
     */
    const at100 = thresholdFor(30, 100);
    const at200 = thresholdFor(30, 200);
    expect(at200).toBeLessThan(at100);
  });

  it('TIGHTENS as the number of PAIRS grows, which is the other half and the opposite direction', () => {
    // More pairs means alpha is divided across more of them, so each individual pair has to be clearer to be flagged
    // while the family-wise error rate stays at 0.05. So `k` up and `N` up move the threshold in OPPOSITE directions.
    expect(thresholdFor(60, 200)).toBeGreaterThan(thresholdFor(20, 200));
  });

  it("is pinned to the plan's 0.20 floor once the derivation falls below it", () => {
    // As N grows the derived value keeps shrinking and eventually drops under 0.20, at which point the floor takes
    // over and the answer stops moving. Without the floor, a large cohort would eventually flag nothing at all.
    // For a 30-item paper the crossover sits around N = 330: 300 is still derived, 400 is pinned. The exact point
    // depends on the paper size -- a larger paper has more pairs, so a larger `z`, so it stays derived longer -- which
    // is why this is stated as a neighbourhood rather than one number.
    expect(lidThreshold(30, 300)).toBeGreaterThan(LID_THRESHOLD_FLOOR);
    expect(lidThreshold(30, 400)).toBe(LID_THRESHOLD_FLOOR);
    expect(lidThreshold(30, 100_000)).toBe(LID_THRESHOLD_FLOOR);
  });

  it("never goes below the plan's 0.20 floor", () => {
    // A very large paper would otherwise produce a threshold so strict that nothing is ever flagged, which is a
    // different way of the same failure: no information.
    expect(thresholdFor(500, 100_000)).toBeGreaterThanOrEqual(LID_THRESHOLD_FLOOR);
  });

  it('refuses below the minimum N, because at N=30 a 0.3 rule flags a quarter of all pairs', () => {
    expect(lidThreshold(30, LID_MIN_N - 1)).toBeNull();
    expect(lidThreshold(30, LID_MIN_N)).not.toBeNull();
  });

  it('refuses a paper of fewer than two items, which has no pairs', () => {
    expect(lidThreshold(1, 500)).toBeNull();
    expect(lidThreshold(0, 500)).toBeNull();
  });

  it('stays on the scale of a correlation for any paper and cohort', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 200 }),
        fc.integer({ min: LID_MIN_N, max: 5_000 }),
        (k, n) => {
          const t = lidThreshold(k, n);
          // `tanh` of anything is inside (-1, 1), and the floor keeps it positive, so the result is a usable
          // correlation threshold rather than a number on some other scale.
          return t !== null && t >= LID_THRESHOLD_FLOOR && t <= 1;
        },
      ),
      { numRuns: 400 },
    );
  });
});

/**
 * A THRESHOLD THAT EXISTS, asserted once.
 *
 * `lidThreshold` returns `number | null`, and the null is meaningful -- it is what the function does below its minimum
 * N -- so these tests cannot simply use `!` six times: `plans/00` §6.2 bans the assertion, and more to the point an
 * assertion here would hide the very thing being tested.
 */
const thresholdFor = (itemCount: number, n: number): number => {
  const value = lidThreshold(itemCount, n);
  if (value === null)
    throw new Error(`expected a threshold for k=${String(itemCount)} n=${String(n)}`);
  return value;
};

describe('THE INVERSION: a declared cluster is never flagged', () => {
  const pair = (over: Partial<Parameters<typeof classifyLidPair>[0]> = {}) => ({
    itemA: 'q1',
    itemB: 'q2',
    residualR: 0.95,
    clusterA: null,
    clusterB: null,
    stemSimilarity: null,
    ...over,
  });

  it('records and shows a pair INSIDE a cluster rather than flagging it', () => {
    const finding = classifyLidPair(pair({ clusterA: 'forces', clusterB: 'forces' }), 30, 200);
    expect(finding.verdict).toBe('WITHIN_CLUSTER');
    // Recorded and SHOWN, per `plans/08` §3.1 -- hiding it would mean an author comparing their blueprint with a
    // published one cannot see what the tool sees.
    expect(finding.reason).toContain('declared');
  });

  it('does NOT flag a within-cluster pair even at a residual correlation of 1', () => {
    const finding = classifyLidPair(pair({ residualR: 1, clusterA: 'c', clusterB: 'c' }), 30, 500);
    expect(finding.verdict).toBe('WITHIN_CLUSTER');
  });

  it('flags the SAME correlation BETWEEN clusters', () => {
    const finding = classifyLidPair(pair({ clusterA: 'forces', clusterB: 'energy' }), 30, 200);
    expect(finding.verdict).toBe('FLAGGED');
  });

  it('treats an item with no cluster as outside every one', () => {
    const finding = classifyLidPair(pair({ clusterA: null, clusterB: null }), 30, 500);
    expect(finding.verdict).toBe('FLAGGED');
    // Two unclustered items are not "the same cluster"; they are unclustered.
    const mixed = classifyLidPair(pair({ clusterA: 'forces', clusterB: null }), 30, 500);
    expect(mixed.verdict).toBe('FLAGGED');
  });

  it('does NOT flag a between-cluster pair below the threshold', () => {
    const finding = classifyLidPair(pair({ residualR: 0.05 }), 30, 500);
    expect(finding.verdict).toBe('NOT_FLAGGED');
  });

  it('says LID is also RANDOM ERROR, per V-3, not only an inflation', () => {
    // Under per-student draws, WHICH pair a student receives determines whether their scores correlate -- so the
    // finding is about the draw as much as the items and the copy has to say so.
    const finding = classifyLidPair(pair(), 30, 200);
    expect(finding.reason).toContain('random error');
    expect(finding.reason).toContain('which pair a student receives');
  });

  it('refuses to judge any pair below the minimum N, rather than reporting an unreliable threshold', () => {
    const finding = classifyLidPair(pair(), 30, 40);
    expect(finding.verdict).toBe('TOO_FEW_RESPONSES');
    expect(finding.threshold).toBeNull();
    expect(finding.reason).toContain(String(LID_MIN_N));
  });

  it('reports the threshold it used, so a flag can be checked', () => {
    const finding = classifyLidPair(pair(), 30, 200);
    if (finding.verdict !== 'TOO_FEW_RESPONSES')
      expect(finding.threshold).toBe(lidThreshold(30, 200));
  });
});

/**
 * Pinned to known quantiles, because the failure mode of a dropped polynomial term is a SMALL PLAUSIBLE NUMBER rather
 * than an exception.  (P8-T11, found while fixing `noUncheckedIndexedAccess` errors in this file)
 */
describe('normalQuantile stays pinned to KNOWN VALUES', () => {
  for (const { p, z } of QUANTILE_REGRESSION_POINTS) {
    it(`gives ${String(z)} at p=${String(p)}`, () => {
      expect(normalQuantile(p)).toBeCloseTo(z, 6);
    });
  }

  it('REJECTS the near-plausible wrong answer the missing constant term produced', () => {
    // 0.0034 rather than 1.6449. This number would have been read as "no dependency" on every pair in a paper, and
    // nothing in the pipeline would have complained.
    expect(Math.abs(normalQuantile(0.95))).toBeGreaterThan(1);
  });

  it('is symmetric about 0.5, because the upper tail is a reflection of the lower', () => {
    for (const p of [0.025, 0.1, 0.3, 0.5, 0.7, 0.9]) {
      expect(normalQuantile(p)).toBeCloseTo(-normalQuantile(1 - p), 12);
    }
  });

  it('is monotonically increasing, which a dropped term would not preserve', () => {
    let previous = Number.NEGATIVE_INFINITY;
    for (let i = 1; i < 100; i++) {
      const z = normalQuantile(i / 100);
      expect(z, `p=${String(i / 100)}`).toBeGreaterThan(previous);
      previous = z;
    }
  });
});

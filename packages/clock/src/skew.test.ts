/**
 * Skew detection -- the tests that matter.  (P8-T2)
 *
 * The failure this guards against is not a wrong number on screen; it is a student's countdown JUMPING while they
 * watch, with nothing they did to cause it. Every test below is about telling a benign cause apart from that one.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SKEW_THRESHOLDS,
  detectSkew,
  type OffsetSample,
  offsetFromRoundTrip,
  roundTripMs,
} from './skew.js';

const sample = (offsetMs: number, rttMs = 100): OffsetSample => ({ offsetMs, rttMs });

describe('offsetFromRoundTrip', () => {
  it("is NTP's midpoint estimator", () => {
    // The server's clock runs 1_000 ms ahead. The client sends at client-time 0, the server stamps its own readings
    // (1_000 on receipt, 1_100 on send) and the client receives at client-time 100. A possible exchange: t4 >= t3 is
    // never true here, because t3 is on the SERVER's clock and t4 on the client's.
    expect(offsetFromRoundTrip(0, 1_000, 1_100, 100)).toBeCloseTo(1_000, 10);
  });

  it('agrees with the closed form on an asymmetric exchange, which is the case that matters', () => {
    // 60 ms each way, server 1_000 ms ahead of the client.
    expect(offsetFromRoundTrip(0, 1_060, 1_060, 120)).toBeCloseTo(1_000, 10);
  });

  it('is ZERO offset when the clocks already agree', () => {
    expect(offsetFromRoundTrip(0, 50, 100, 150)).toBeCloseTo(0, 10);
  });

  it('reports the round trip separately, because a slow round trip makes the midpoint useless', () => {
    // The asymmetry is why: a 3 s round trip that happened to be all server-bound would report an offset 1.5 s off,
    // and nothing downstream would know.
    expect(roundTripMs(0, 3_000)).toBe(3_000);
    expect(roundTripMs(1_000, 1_120)).toBe(120);
  });
});

describe('detectSkew', () => {
  it('reports UNKNOWN for no samples, rather than a confident stable verdict', () => {
    // A verdict invented from zero evidence is worse than none: it suppresses the warning a first sample should raise.
    expect(detectSkew([]).status).toBe('UNKNOWN');
  });

  it('reports UNKNOWN for a single sample, because one point cannot show movement', () => {
    expect(detectSkew([sample(1_000)]).status).toBe('UNKNOWN');
    expect(detectSkew([sample(1_000)]).shouldWarnStudent).toBe(false);
  });

  it('believes a steady offset', () => {
    const verdict = detectSkew([sample(1_000), sample(1_020), sample(990)]);
    expect(verdict.status).toBe('STABLE');
    expect(verdict.offsetMs).toBeCloseTo(1_000, 10);
    expect(verdict.shouldWarnStudent).toBe(false);
  });

  it('takes the MEDIAN, so one slow round trip cannot drag the offset', () => {
    /**
     * A mean would be dragged by the outlier by an arbitrary amount depending on how slow that round trip happened
     * to be. The median of a handful of samples ignores it outright, which is why this is a median and not an average.
     */
    const verdict = detectSkew([sample(1_000), sample(1_010), sample(1_000), sample(90_000, 100)]);
    expect(verdict.offsetMs).toBeLessThan(2_000);
  });

  it('DISCARDS an isolated outlier rather than believing it', () => {
    /**
     * The subtle case, and the reason a single wild packet must not reset a student's clock: one sample far from both
     * neighbours while the neighbours agree is a slow round trip, not a clock jump.
     */
    const verdict = detectSkew([sample(1_000), sample(1_010), sample(85_000)]);
    expect(verdict.status).not.toBe('SKEWED');
    expect(verdict.offsetMs).toBeLessThan(2_000);
    expect(verdict.discarded).toEqual([2]);
  });

  it('DISCARDs a sample whose round trip was too slow, however plausible its offset looks', () => {
    // A slow round trip is not evidence about the clock, it is evidence about the network. 5 s, against a 4 s
    // tolerance -- the first fixture here was 3 s, which is INSIDE the bar, so nothing was discarded and the test
    // passed for the wrong reason until the assertion was tightened.
    const verdict = detectSkew([sample(1_000, 100), sample(1_010, 120), sample(1_000, 5_000)]);
    expect(verdict.discarded).toContain(2);
    expect(verdict.offsetMs).toBeLessThan(2_000);
  });

  it('calls a STEADY movement DRIFTING, and does NOT warn the student', () => {
    /**
     * A real clock running slightly fast is not an emergency. The countdown drifts by a fraction and nobody notices;
     * warning on every resync would train students to ignore the warning that matters.
     */
    const verdict = detectSkew([sample(1_000), sample(2_500), sample(4_000)]);
    expect(verdict.status).toBe('DRIFTING');
    expect(verdict.shouldWarnStudent).toBe(false);
  });

  it('CANNOT distinguish a one-off jump from a slow packet, and treats it as the latter', () => {
    /**
     * This test exists because the distinction is IMPOSSIBLE from one series, and pretending otherwise would be the
     * worst outcome. A single sample far from the others is either a slow round trip or a clock that moved once --
     * and nothing in four timestamps can tell those apart. Believing the wild sample resets a student's clock on the
     * strength of one bad packet; believing the neighbours is the safer error, because the cost of a missed jump is
     * one re-sync while the cost of a false one is a countdown that moves for no reason.
     *
     * So it is discarded, and `SKEWED` is reserved for movement that is NOT a consistent drift (see below).
     * Telling a real transient jump apart afterwards means comparing against the PREVIOUS verdict at the call
     * site, which is history this function deliberately does not have.
     */
    const verdict = detectSkew([sample(45_000), sample(1_000), sample(1_020), sample(1_010)]);
    expect(verdict.status).toBe('STABLE');
    expect(verdict.discarded).toContain(0);
    expect(verdict.shouldWarnStudent).toBe(false);
  });

  it('calls CORROBORATED movement SKEWED, and warns the student', () => {
    /**
     * The complement of the outlier rule, and the reason it is not simply "discard anything far from the median":
     * here the deviation is corroborated by its neighbour, so it is not one slow packet -- the clock moved out and
     * back. The steps do not run one way, so it is not a drift either. The countdown is about to move under the
     * student and they are told.
     *
     * The earlier fixture for this case was `[1000, 40000, 2000, 1020]`, and it came out `STABLE`: the 40 000 was
     * ISOLATED (its neighbours agreed with each other), so it was discarded as a bad packet. That was the rule
     * working, not a bug -- corroboration is exactly what distinguishes the two cases.
     */
    const verdict = detectSkew([sample(1_000), sample(40_000), sample(40_000), sample(1_000)]);
    expect(verdict.status).toBe('SKEWED');
    expect(verdict.shouldWarnStudent).toBe(true);
    expect(verdict.discarded).toEqual([]);
  });

  it('reports a CORROBORATED jump as stable, because two samples agreeing is the new normal', () => {
    /**
     * This looks wrong until it is said out loud, so the test says it: once the device has reported the new offset
     * twice, a point-in-time verdict of "stable" is TRUE. The transient is real but it is over; detecting it means
     * comparing against the PREVIOUS verdict at the call site, not re-deriving it from the series.
     */
    const verdict = detectSkew([sample(1_000), sample(45_000), sample(45_010)]);
    expect(verdict.status).toBe('STABLE');
    expect(verdict.shouldWarnStudent).toBe(false);
    expect(verdict.offsetMs).toBeCloseTo(45_005, 10);
  });

  it('reports UNKNOWN when EVERY sample came from too slow a round trip', () => {
    const verdict = detectSkew([sample(1_000, 5_000), sample(1_010, 6_000)]);
    expect(verdict.status).toBe('UNKNOWN');
    expect(verdict.discarded).toHaveLength(2);
  });

  it('still produces a usable offset when the samples are all outliers', () => {
    // With three outliers and no majority, the fallback must not throw or return 0, which would silently set the
    // student's clock to the server's.
    const verdict = detectSkew([sample(50_000), sample(60_000), sample(70_000)]);
    expect(Number.isFinite(verdict.offsetMs)).toBe(true);
    expect(verdict.offsetMs).toBeCloseTo(60_000, 10);
  });

  it('reports STABLE for two samples that agree, rather than calling one pair a trend', () => {
    // One pair is a measurement, not a series. Calling it DRIFTING would warn on ordinary noise.
    expect(detectSkew([sample(1_000), sample(1_010)]).status).toBe('STABLE');
  });

  it('reports SKEWED for two samples that do not, because a jump needs only two points to see', () => {
    // The asymmetry with the case above is the point: two samples are too few for a TREND and exactly enough for a
    // JUMP, and a jump is the one that moves a countdown under a student.
    const verdict = detectSkew([sample(1_000), sample(45_000)]);
    expect(verdict.status).toBe('SKEWED');
    expect(verdict.shouldWarnStudent).toBe(true);
  });

  it("respects a caller's own thresholds rather than only the defaults", () => {
    const samples = [sample(0), sample(1_500), sample(3_000)];
    expect(detectSkew(samples, DEFAULT_SKEW_THRESHOLDS).status).toBe('DRIFTING');
    // With a tight tolerance the same series is a jump instead, which is the point of making them configurable.
    const tight = detectSkew(samples, {
      jitterToleranceMs: 100,
      outlierToleranceMs: 200,
      rttToleranceMs: 4_000,
      // Below the series' total movement, so the same data reads as a jump rather than a drift.
      driftToleranceMs: 1_000,
    });
    expect(tight.status).toBe('SKEWED');
    expect(tight.shouldWarnStudent).toBe(true);
  });

  it('handles a single sample with a huge offset without claiming skew', () => {
    // A first sync after a long pause can report a large offset. That is not movement, it is a first reading.
    const verdict = detectSkew([sample(3_600_000)]);
    expect(verdict.status).toBe('UNKNOWN');
    expect(verdict.offsetMs).toBe(3_600_000);
    expect(verdict.shouldWarnStudent).toBe(false);
  });
});

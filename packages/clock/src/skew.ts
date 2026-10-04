/**
 * RTT-midpoint sync and skew detection.  (P8-T2)
 *
 * ## WHY SKEW DETECTION IS NOT THE SAME PROBLEM AS COMPUTING AN OFFSET
 *
 * `clockOffset` answers "what is the offset right now". Skew detection answers the question a student actually
 * experiences: **"is the number on my screen about to jump?"** Those are different, and the difference is the whole
 * reason this is a separate module.
 *
 * A countdown that silently jumps is worse than one that is slightly wrong. If the offset moves by four seconds
 * mid-exam the student's remaining time appears to change without anything they did, and their first reasonable
 * conclusion is that the exam was taken from them. So the engine has to tell the difference between:
 *
 *  · **jitter** -- individual round trips disagree, because the network does. Normal, and must be smoothed away.
 *  · **drift** -- the offset moves steadily over many samples, which is a real clock running fast or slow.
 *  · **skew** -- the offset JUMPS, which is the device clock being corrected, or a VM being migrated, or a laptop
 *    resuming. The countdown would jump, and the student has to be told before they see it.
 *
 * ## AND A SINGLE WILD SAMPLE IS NOT SKEW
 *
 * The subtle case, and the one worth a test: one sample far from both neighbours while the neighbours agree is a slow
 * round trip, not a clock jump. Treating it as skew would reset a student's clock on the strength of one bad packet --
 * and the reset itself is the visible glitch the student notices. So an isolated outlier is DISCARDED and the
 * neighbours are believed.
 */

import { type Duration, type Millis, SECOND } from './index.js';

/**
 * NTP's estimator, as a PURE function of the four timestamps.
 *
 * `clockOffset(serverNow, rttMs)` in `index.ts` reads the host clock internally, which makes it impossible to feed a
 * known exchange into. Skew detection needs to reason over a *series* of exchanges and compare them, so the primitive
 * it compares has to be pure.
 *
 * ```
 * offset = ((T2 - T1) + (T3 - T4)) / 2
 * ```
 * where `T1` is the client send, `T2` the server send, `T3` the server receive, `T4` the client receive.
 */
export function offsetFromRoundTrip(t1: Millis, t2: Millis, t3: Millis, t4: Millis): Duration {
  return (t2 - t1 + (t3 - t4)) / 2;
}

/** The round trip's own duration. A large value makes its offset sample untrustworthy, which is what `rttTolerance` uses. */
export function roundTripMs(t1: Millis, t4: Millis): Duration {
  return t4 - t1;
}

export type SkewStatus =
  /** The offset is steady within tolerance. Use it. */
  | 'STABLE'
  /** The offset is moving consistently. Resync on the normal schedule; do not alarm the student. */
  | 'DRIFTING'
  /** The offset jumped. Resync now, and tell the student the countdown moved. */
  | 'SKEWED'
  /** Not enough samples to say anything. Use the single sample and re-measure. */
  | 'UNKNOWN';

export interface SkewThresholds {
  /**
   * How far two ordinary samples may differ before it counts as movement.
   *
   * Generous by default. A tight bound turns ordinary network jitter into a stream of `SKEWED` verdicts, and a
   * student who is told their clock jumped four times in a minute stops believing any of it.
   */
  readonly jitterToleranceMs: Duration;
  /** How far a single sample may sit from its neighbours before it is treated as an outlier and DISCARDED. */
  readonly outlierToleranceMs: Duration;
  /** A round trip longer than this makes its sample untrustworthy regardless of where it landed. */
  readonly rttToleranceMs: Duration;
  /** Consecutive samples moving the same way by more than this in total is drift rather than noise. */
  readonly driftToleranceMs: Duration;
}

export const DEFAULT_SKEW_THRESHOLDS: SkewThresholds = {
  jitterToleranceMs: 2 * SECOND,
  // Wider than the jitter tolerance on purpose: an outlier is further out than ordinary spread, and the test is
  // "could this sample be an outlier at all".
  outlierToleranceMs: 10 * SECOND,
  rttToleranceMs: 4 * SECOND,
  driftToleranceMs: 5 * SECOND,
};

export interface OffsetSample {
  readonly offsetMs: Duration;
  /** The round trip that produced it. A slow round trip makes the sample worth less. */
  readonly rttMs: Duration;
}

export interface SkewVerdict {
  readonly status: SkewStatus;
  /**
   * THE MEDIAN of the trusted samples, which is the offset to believe.
   *
   * The MEDIAN and not the mean: one slow round trip biases a mean by an arbitrary amount, and the median of a handful
   * of samples simply ignores it.
   */
  readonly offsetMs: Duration;
  /** Samples discarded as outliers or as too slow, kept so the caller can report evidence rather than a verdict alone. */
  readonly discarded: readonly number[];
  /** True when the countdown the student is watching is about to move, and they should be told. */
  readonly shouldWarnStudent: boolean;
}

/**
 * CLASSIFY A SERIES OF OFFSET SAMPLES, oldest first.
 *
 * Pure, so the ordering rules are testable without a clock, a network, or a device.
 */
export function detectSkew(
  samples: readonly OffsetSample[],
  thresholds: SkewThresholds = DEFAULT_SKEW_THRESHOLDS,
): SkewVerdict {
  // Nothing to go on. Report the single sample as-is rather than inventing a stable verdict for one data point.
  if (samples.length === 0) {
    return { status: 'UNKNOWN', offsetMs: 0, discarded: [], shouldWarnStudent: false };
  }

  /** A sample from a round trip so slow that its midpoint is not a usable estimate of anything. */
  const trustworthy = samples
    .map((sample, index) => ({ ...sample, index }))
    .filter((sample) => sample.rttMs <= thresholds.rttToleranceMs);

  const discarded = samples
    .map((sample, index) => ({ ...sample, index }))
    .filter((sample) => sample.rttMs > thresholds.rttToleranceMs)
    .map((sample) => sample.index);

  if (trustworthy.length === 0) {
    return {
      status: 'UNKNOWN',
      offsetMs: samples[0]?.offsetMs ?? 0,
      discarded,
      shouldWarnStudent: false,
    };
  }

  /**
   * DISCARD ISOLATED OUTLIERS, AND ONLY ISOLATED ONES.
   *
   * A sample whose two neighbours agree with each other, and which disagrees with both, is a slow round trip rather
   * than a clock jump.
   *
   * **The test is ISOLATION, not distance from the median.** The first version used "further than
   * `outlierTolerance` from the median", and that misclassified two things at once: a steady DRIFT of
   * 1 500 ms per sample, where every sample is far from the median and none of them is noise; and a
   * real JUMP, where the samples before it are discarded as outliers and the jump is then reported for
   * the wrong reason -- or, with tighter caller thresholds, not reported at all.
   *
   * What makes a sample noise is that every OTHER sample agrees. If they disagree, the sample is part
   * of a real discontinuity, and the discontinuity is the news.
   *
   * **COROLLARY, AND IT LOOKS WRONG UNTIL YOU SAY IT OUT LOUD: a jump that has been corroborated by a
   * second sample is no longer reported as `SKEWED`.** Once two samples agree on the new offset, that
   * is the new normal, and a point-in-time verdict of "stable" is true. The transient -- the instant
   * the student's countdown moved -- is real but it is over, and detecting it means comparing against
   * the PREVIOUS verdict at the call site rather than re-deriving it from the series here.
   */
  const kept = trustworthy.filter((sample) => {
    const others = trustworthy.filter((other) => other !== sample).map((other) => other.offsetMs);
    // Nothing to disagree with.
    if (others.length === 0) return true;
    const consensusHolds =
      Math.max(...others) - Math.min(...others) <= thresholds.jitterToleranceMs;
    const sampleIsOut =
      Math.abs(sample.offsetMs - medianOf(others)) > thresholds.outlierToleranceMs;
    return !(consensusHolds && sampleIsOut);
  });
  for (const sample of trustworthy) {
    if (!kept.includes(sample)) discarded.push(sample.index);
  }

  const trusted = (kept.length > 0 ? kept : trustworthy).map((sample) => sample.offsetMs);

  if (trusted.length < 2) {
    return {
      status: 'UNKNOWN',
      offsetMs: trusted[0] ?? 0,
      discarded,
      shouldWarnStudent: false,
    };
  }

  const spread = Math.max(...trusted) - Math.min(...trusted);
  const believed = medianOf(trusted);

  if (spread <= thresholds.jitterToleranceMs) {
    return { status: 'STABLE', offsetMs: believed, discarded, shouldWarnStudent: false };
  }

  /**
   * MOVEMENT IS EITHER A DRIFT OR A JUMP, AND THE DIRECTION IS WHAT DISTINGUISHES THEM.
   *
   * A jump is one sample far from where the others are. Drift is every step going the same way by roughly the same
   * amount. The distinction decides the response: drift resyncs quietly on the normal schedule, while a jump means
   * the countdown the student is watching is about to move under them.
   */
  const steps = trusted.slice(1).map((value, index) => value - (trusted[index] ?? 0));
  const sameDirection = steps.every((step) => step > 0) || steps.every((step) => step < 0);
  const consistentStep = sameDirection && steps.every((step) => Math.abs(step) > 0);

  if (consistentStep && spread <= thresholds.driftToleranceMs) {
    return { status: 'DRIFTING', offsetMs: believed, discarded, shouldWarnStudent: false };
  }

  return { status: 'SKEWED', offsetMs: believed, discarded, shouldWarnStudent: true };
}

/** The median. On an even count it averages the two middle values, which is the standard tie-break. */
function medianOf(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle];
  const lower = sorted[middle - 1];
  if (sorted.length % 2 === 1) return upper ?? 0;
  return ((upper ?? 0) + (lower ?? 0)) / 2;
}

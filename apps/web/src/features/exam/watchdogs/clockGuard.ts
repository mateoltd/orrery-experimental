'use client';

/**
 * `clockGuard` (P8-T6). Watches the offset from periodic syncs and reports skew. Advisory only.
 *
 * ## ADVISORY MEANS ADVISORY, AND THE TYPE SAYS SO
 *
 * `plans/09` §6's table gives this guard no escalation. A detected skew changes NOTHING about the student's exam: the
 * server is the sole enforcer of time, so a wrong local offset costs the student nothing except a briefly wrong
 * countdown.
 *
 * The temptation is to treat a large skew as a reason to warn, warn, warn. That is wrong twice over: the server does
 * not care what the client thinks the time is, and a student told their clock is wrong when it is not has been told
 * something false during an exam. So this guard reports and stops. The detection logic lives in `@orrery/clock`'s
 * `detectSkew` (P8-T2) and is not reimplemented here.
 */

// `skew` is a SIBLING MODULE in `@orrery/clock`, not part of its index, so it is imported by subpath -- which is what
// subpath exports are for, and ADR-0016 forbids the barrel alternative. Biome's import organiser merges
// `@orrery/clock` and `@orrery/clock/skew` as one specifier, which silently moves these names to the wrong module.
import { detectSkew, type SkewStatus, type SkewVerdict } from '@orrery/clock/skew';

import { type EvidenceSink, Watchdog, type WatchdogHost } from './watchdog';

export class ClockGuard extends Watchdog {
  /** The samples `detectSkew` reasons over, oldest first. Bounded: an unbounded list is a leak in a long exam. */
  private readonly samples: { offsetMs: number; rttMs: number }[] = [];
  private lastVerdict: SkewVerdict | null = null;

  constructor(
    clock: { now(): number },
    sink: EvidenceSink,
    host: WatchdogHost,
    private readonly keep = 8,
  ) {
    super(clock, sink, host);
  }

  protected subscribe(): void {
    // Nothing is subscribed to. This guard is PUSHED by the sync routine, which owns the timer, rather than owning a
    // timer of its own -- two timers for one sync is two chances to disagree about when the clock was last checked.
  }

  protected unsubscribe(): void {
    this.samples.length = 0;
  }

  /**
   * RECORD AN OFFSET SAMPLE FROM A COMPLETED SYNC.
   *
   * A sample is only reported once per VERDICT CHANGE, not once per sample. A drifting clock produces a `DRIFTING`
   * verdict on every sync, and an event per sync fills a teacher's timeline with dozens of identical entries that hide
   * the one that mattered.
   */
  record(offsetMs: number, rttMs: number): SkewStatus {
    this.samples.push({ offsetMs, rttMs });
    // Bounded, oldest dropped. A student in a three-hour exam syns every 60 s, so an unbounded list is thousands of
    // entries that make `detectSkew`'s median meaningless anyway.
    while (this.samples.length > this.keep) this.samples.shift();

    const verdict = detectSkew(this.samples);
    const previous = this.lastVerdict;
    this.lastVerdict = verdict;

    /**
     * `UNKNOWN` IS NOT A DETECTION, AND EMITTING IT AS ONE PUTS A FALSE ENTRY IN A TEACHER'S TIMELINE.
     *
     * `UNKNOWN` means "not enough samples to say" -- which is the state after the very first sync, and the state
     * whenever every round trip was too slow to use. Emitting `CLOCK_SKEW_DETECTED` for it means almost every exam
     * opens with a skew event that says nothing, and a teacher learns to ignore the kind that matters.
     *
     * So the emission is restricted to the two statuses that are findings: `DRIFTING` and `SKEWED`.
     */
    const isFinding = verdict.status === 'DRIFTING' || verdict.status === 'SKEWED';

    if (isFinding && verdict.status !== previous?.status) {
      this.emit('CLOCK_SKEW_DETECTED', {
        status: verdict.status,
        offsetMs: verdict.offsetMs,
        // Advisory, and stated in the evidence so a teacher reading the timeline sees that nothing was enforced.
        advisory: true,
        enforcedByServer: true,
        // Whether the student was warned. Always false, deliberately.
        studentWarned: false,
      });
    }
    return verdict.status;
  }

  /** The most recent verdict, or `null` before any sample. The sync banner reads this. */
  get verdict(): SkewVerdict | null {
    return this.lastVerdict;
  }
}

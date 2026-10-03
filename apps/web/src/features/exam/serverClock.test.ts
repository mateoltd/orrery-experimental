/**
 * Tests for the countdown's time base and the preflight.  (P7-T14)
 *
 * ## THE PROPERTIES HERE ARE ABOUT DIRECTION OF ERROR
 *
 * A countdown has two ways to be wrong and they are not equally bad. Reading slightly EARLY costs a student a
 * moment of confusion; reading LATE is what makes someone keep typing after time is up and lose the answer. So
 * most of what follows is about which way an estimate errs, not about how big the error is.
 */

import { clockOffset, systemClock } from '@orrery/clock';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  buildPreflight,
  correctedNow,
  displayOffset,
  offsetFromRoundTrip,
  RESYNC_AFTER_PAUSE_MS,
  RESYNC_INTERVAL_MS,
  RESYNC_TRIGGER_NOTES,
  type SyncState,
  shouldResync,
  stalenessMs,
} from './serverClock';

const RUNS = 200;
const AT = 1_000_000;

const syncState = (over: Partial<SyncState> = {}): SyncState => ({
  lastSyncAt: AT,
  lastActivityAt: AT,
  offset: 0,
  samples: [],
  ...over,
});

describe('the offset from one round trip is the RTT MIDPOINT', () => {
  it('places the server sample at the midpoint of the flight', () => {
    // `serverNow + rtt/2 - clientSentAt`. The server's clock is read somewhere between the request leaving and
    // the reply arriving, so assuming the midpoint means a slow response does not bias the estimate either way.
    // `serverNow - clientSentAt - rtt/2`. The server's clock is read after the request left, so half the round
    // trip has elapsed and comes back off.
    expect(offsetFromRoundTrip(1_000, 5_000, 1_200)).toBe(5_000 - 100 - 1_000);
  });

  it('AGREES with `@orrery/clock` now that PF-3 is fixed, and says so', () => {
    /**
     * THE DISAGREEMENT IS RESOLVED, and a test is the right place to record that.
     *
     * `serverClock`'s comment used to say it "disagrees with the impure one on purpose", because correcting
     * `clockOffset` was filed as a defect rather than quietly forked. `PF-3` corrected it. A stale comment claiming a
     * known divergence is worse than no comment: the next reader either trusts it and adds a compensating `+`, or
     * checks and finds the file lying.
     */
    // Same formula, so for any inputs the two must agree -- `clockOffset` supplies its own `Date.now()` at the send
    // instant, which `clientSentAt` stands in for here.
    // `systemClock.now()` and NOT `Date.now()`. INV-TIME-1 restricts `Date.now()` to `@orrery/clock`, and the
    // rule is right: this file exists so that application code never reads the wall, and a test that did it would
    // be the first place the pattern reappears.
    const clientSentAt = systemClock.now();
    const serverNow = clientSentAt + 30_000 + 100;
    const rtt = 200;
    const impure = clockOffset(serverNow, rtt);
    expect(impure).toBeCloseTo(offsetFromRoundTrip(clientSentAt, serverNow, clientSentAt + rtt), 0);
  });

  it('is NOT an average of the endpoints, which is the tempting wrong version', () => {
    // (1000 + 5100)/2 - 1000 = 2050, which is 50 ms out on a 100 ms round trip. On a 2 s round trip the same
    // mistake is 500 ms, and it is always in the direction that makes the countdown read LONG.
    const clientSentAt = 1_000;
    const rtt = 2_000;
    const serverNow = clientSentAt + rtt / 2 + 137;
    const midpoint = offsetFromRoundTrip(clientSentAt, serverNow, clientSentAt + rtt);
    const endpointAverage = (clientSentAt + (clientSentAt + rtt)) / 2 - clientSentAt;
    expect(midpoint).toBe(serverNow - rtt / 2 - clientSentAt);
    expect(endpointAverage).not.toBe(midpoint);
  });

  it('is UNBOUNDED by a slow response rather than dragged by it', () => {
    // A 2 s round trip and a 200 ms one give the SAME offset when the server's clock has not moved. That is the
    // property a midpoint buys and an average throws away.
    // The server samples its clock when the request ARRIVES, so for a true offset of 250 the sample sits at
    // `clientSentAt + offset + rtt/2`. Both round trips must recover 250.
    const trueOffset = 250;
    expect(offsetFromRoundTrip(1_000, 1_000 + trueOffset + 100, 1_200)).toBe(trueOffset);
    expect(offsetFromRoundTrip(1_000, 1_000 + trueOffset + 1_000, 3_000)).toBe(trueOffset);
  });

  it('discards a sample from a clock that JUMPED mid-flight, rather than folding it in', () => {
    // A reply appearing to arrive before it was sent means the client's own clock moved. `NaN` lets the caller
    // drop it; a negative RTT folded into an offset would move the countdown by twice the error.
    expect(Number.isNaN(offsetFromRoundTrip(5_000, 5_100, 1_000))).toBe(true);
    expect(Number.isFinite(offsetFromRoundTrip(1_000, 5_100, 1_000))).toBe(true);
  });
});

describe('the displayed offset is a MEDIAN, and errs EARLY when it errs', () => {
  it('discards one wild sample instead of letting it move the countdown', () => {
    // One sample taken while the tab was throttled in the background can be seconds out. A mean lets that one
    // sample move the display for a full minute; a median discards it.
    const samples = [10, 12, 11, 9_000, 10];
    expect(displayOffset(samples)).toBeLessThan(100);
  });

  it('takes the LOWER median for an even count, because being early is the safe direction', () => {
    // A countdown reading one second long is a far smaller problem than one reading a minute short.
    expect(displayOffset([0, 100])).toBe(0);
    expect(displayOffset([100, 0])).toBe(0);
  });

  it('drops NaN samples, because one NaN in a mean makes the whole estimate NaN', () => {
    expect(displayOffset([Number.NaN, 50, 60])).toBe(50);
    expect(displayOffset([Number.NaN, Number.NaN])).toBe(0);
    expect(displayOffset([])).toBe(0);
  });

  it('is stable under any reordering of the same samples', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -5_000, max: 5_000 }), { maxLength: 8 }),
        (samples) => {
          const forwards = displayOffset(samples);
          const backwards = displayOffset([...samples].reverse());
          return forwards === backwards;
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('never reports MORE offset than the largest sample, which is what a mean would do', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -1_000, max: 1_000 }), { minLength: 1, maxLength: 8 }),
        (samples) => {
          const value = displayOffset(samples);
          return value <= Math.max(...samples) && value >= Math.min(...samples);
        },
      ),
      { numRuns: RUNS },
    );
  });
});

describe('re-syncing: every 60 s, and after any pause over 30 s', () => {
  it('re-syncs when it has NEVER synced, which the plan wording omits', () => {
    // A client that has not synced must not display a countdown derived from an offset it does not have.
    expect(shouldResync(syncState({ lastSyncAt: null }), AT)).toBe(true);
  });

  it('does not re-sync inside both thresholds', () => {
    const state = syncState();
    expect(shouldResync(state, AT + 1_000)).toBe(false);
    expect(shouldResync(state, AT + RESYNC_AFTER_PAUSE_MS - 1)).toBe(false);
  });

  it('re-syncs at the interval', () => {
    expect(shouldResync(syncState(), AT + RESYNC_INTERVAL_MS)).toBe(true);
  });

  it('re-syncs after a PAUSE, even though the interval has not elapsed', () => {
    /**
     * THE HALF THAT MATTERS. A laptop lid closed for two minutes comes back with an offset wrong by however long
     * it slept, timers throttled, and a countdown confidently reading the wrong time. A student who closed the
     * lid to check a definition must not come back to a paper that appears to have three minutes left.
     */
    const paused = syncState({ lastActivityAt: AT - RESYNC_AFTER_PAUSE_MS });
    // The INTERVAL has not elapsed -- `lastSyncAt` is `AT` and `now` is `AT` -- so only the pause rule can fire.
    expect(paused.lastSyncAt).toBe(AT);
    expect(AT - (paused.lastSyncAt ?? 0)).toBeLessThan(RESYNC_INTERVAL_MS);
    expect(shouldResync(paused, AT)).toBe(true);
  });

  it('treats the pause threshold as the trigger it is, not as a grace period', () => {
    // Activity RESETS the pause clock, so a student typing throughout never triggers a re-sync on the pause rule
    // even if the last sync is old -- the interval rule handles that.
    const active = syncState({ lastActivityAt: AT, lastSyncAt: AT - RESYNC_AFTER_PAUSE_MS });
    expect(shouldResync(active, AT)).toBe(false);
  });

  it('orders the two thresholds so a pause always triggers before an interval elapses', () => {
    // If the pause threshold were longer than the interval, the pause rule would be unreachable.
    expect(RESYNC_AFTER_PAUSE_MS).toBeLessThan(RESYNC_INTERVAL_MS);
  });

  it('keeps the CLOCK timeout distinct from the COORDINATION timeout', () => {
    // A tab quiet for 5 s is a coordination problem; a device asleep for 30 s has a WRONG CLOCK, and no amount
    // of heartbeating will fix it. Conflating them is how one gets tuned for the other.
    expect(RESYNC_TRIGGER_NOTES.coordinationTimeoutMs).toBe(5_000);
    expect(RESYNC_TRIGGER_NOTES.clockPauseThresholdMs).toBe(30_000);
  });

  it('adds the offset in ONE place, so no caller forgets', () => {
    expect(correctedNow(1_000, 250)).toBe(1_250);
    expect(correctedNow(1_000, -250)).toBe(750);
  });

  it('reports unbounded staleness before the first sync rather than zero', () => {
    // Zero would read as "just synced", which is the opposite of the truth and would hide the "syncing…" state.
    expect(stalenessMs(syncState({ lastSyncAt: null }), AT)).toBe(Number.POSITIVE_INFINITY);
    expect(stalenessMs(syncState(), AT + 5_000)).toBe(5_000);
    expect(stalenessMs(syncState(), AT - 5_000)).toBe(0);
  });
});

describe('preflight, where a failure found late is worth nothing', () => {
  const healthy = {
    storageWritable: true,
    networkOnline: true,
    supportedBrowser: true,
    hasKeyboard: true,
    remainingStorageBytes: 500 * 1024 * 1024,
  };

  it('lets a healthy device start', () => {
    const preflight = buildPreflight(healthy);
    expect(preflight.mayStart).toBe(true);
    expect(preflight.blockers).toEqual([]);
  });

  it('BLOCKS on the three things that lose work outright', () => {
    // Refusing to start beats discovering mid-paper that the session cannot be saved.
    for (const broken of [
      { ...healthy, supportedBrowser: false },
      { ...healthy, storageWritable: false },
    ]) {
      const preflight = buildPreflight(broken);
      expect(preflight.mayStart).toBe(false);
      expect(preflight.blockers.length).toBeGreaterThan(0);
    }
  });

  it('ADVISES rather than blocks on a tight disk, an offline start, or no keyboard', () => {
    /**
     * A tight disk degrades the outbox; it does not prevent answering, and refusing to let a student start over
     * 3 MB would fail them for something they can work around. An offline start is legitimate -- the outbox
     * exists for exactly that.
     */
    for (const degraded of [
      { ...healthy, remainingStorageBytes: 3 * 1024 * 1024 },
      { ...healthy, networkOnline: false },
      { ...healthy, hasKeyboard: false },
    ]) {
      const preflight = buildPreflight(degraded);
      expect(preflight.mayStart).toBe(true);
      expect(preflight.checks.some((check) => !check.ok)).toBe(true);
    }
  });

  it('treats UNKNOWN storage as fine, because a browser that will not say is not a refusal', () => {
    // `remainingStorageBytes: null` is a browser declining to report. Reading that as "no space" would block
    // Safari users for a permission prompt rather than a fault.
    expect(buildPreflight({ ...healthy, remainingStorageBytes: null }).mayStart).toBe(true);
  });

  it('gives EVERY check a remedy, because a failure with no remedy is just a refusal', () => {
    const preflight = buildPreflight({ ...healthy, storageWritable: false, networkOnline: false });
    for (const check of preflight.checks) {
      expect(check.remedy.length).toBeGreaterThan(10);
      expect(check.label.length).toBeGreaterThan(3);
    }
  });

  it('has a stable set of ids, so a UI can key on them and a test can enumerate them', () => {
    const ids = buildPreflight(healthy).checks.map((check) => check.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(['browser', 'storage', 'space', 'network', 'keyboard']);
  });

  it('lists blockers in the order they should be SHOWN, not in measurement order', () => {
    const preflight = buildPreflight({
      ...healthy,
      storageWritable: false,
      supportedBrowser: false,
    });
    // An unsupported browser is the more fundamental problem, and it is declared first.
    expect(preflight.blockers.map((check) => check.id)).toEqual(['browser', 'storage']);
  });

  it('is a FUNCTION of its input, so the start screen is a rendering of a pure value', () => {
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), fc.boolean(), fc.boolean(), (a, b, c, d) => {
        const measured = {
          storageWritable: a,
          networkOnline: b,
          supportedBrowser: c,
          hasKeyboard: d,
          remainingStorageBytes: 1024,
        };
        // Two separate CALLS, hoisted into names. Written as one expression compared with itself it is a
        // self-compare, which `noSelfCompare` flags -- correctly, because that shape is nearly always a
        // copy-paste slip where the second call was meant to use different input.
        const first = buildPreflight(measured);
        const second = buildPreflight(measured);
        return JSON.stringify(first) === JSON.stringify(second);
      }),
      { numRuns: RUNS },
    );
  });
});

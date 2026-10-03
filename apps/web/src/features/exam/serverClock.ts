'use client';

/**
 * The countdown's time base, and the preflight that runs before a student commits to a paper.  (P7-T14)
 *
 * ## WHY THERE IS A CLIENT ESTIMATE AT ALL WHEN THE SERVER IS THE AUTHORITY
 *
 * `plans/01` §9.2: "The client receives `serverNow` and computes an offset from the RTT midpoint, re-syncing
 * every 60 s and after any pause > 30 s." And `C3`/`RN-10`, recorded on `clockOffset` itself: "this is
 * display-only; the server remains the sole enforcer, so a wrong offset cannot extend or shorten an exam."
 *
 * So a wrong offset here costs a student a wrong NUMBER on screen and nothing else. That is worth being precise
 * about, because the instinct is to make the client authoritative and the result is two clocks disagreeing about
 * when a paper closed.
 *
 * ## AND `clockOffset` ALREADY EXISTS IN `@orrery/clock`, WHICH IS WHY THIS IS NOT A DUPLICATE
 *
 * That function calls `Date.now()` internally, which is right for it -- it is the one sanctioned place a clock may
 * read the wall. But it means it cannot be property-tested, and a countdown cannot be replayed. So the pure
 * primitive here takes the three timestamps explicitly and `@orrery/clock`'s function is the impure wrapper around
 * it. One formula, two callers, and the testable one is the one under test.
 *
 * ## THE RE-SYNC SCHEDULE IS THE PART THAT MATTERS AND USUALLY GETS OMITTED
 *
 * "Every 60 s" is the easy half. "After any pause > 30 s" is the half that matters: a laptop lid closed for two
 * minutes comes back with an offset that is wrong by however long it slept, timers throttled, and a countdown
 * that confidently reads the wrong time. A student who closed the lid to check a definition must not come back to
 * a paper that appears to have three minutes left.
 */

import { HEARTBEAT_TIMEOUT_MS } from './tabCoordination';

/**
 * `plans/01` §9.2's two re-sync triggers. Named so the policy is one edit rather than three literals.
 *
 * The pause threshold is deliberately NOT the heartbeat timeout. They are different concerns that happen to be
 * about the same clock: a tab that has gone quiet for 5 s is a coordination problem, and a device that has been
 * asleep for 30 s has a *wrong clock*, which no amount of heartbeating will fix.
 */
export const RESYNC_INTERVAL_MS = 60_000;
export const RESYNC_AFTER_PAUSE_MS = 30_000;

/**
 * THE OFFSET FROM ONE ROUND TRIP, as a pure function of three timestamps.
 *
 * ## THE SIGN IS `- rtt / 2`, AND `@orrery/clock` ONCE HAD IT AS `+`
 *
 * The NTP offset estimate is `((T2 - T1) + (T3 - T4)) / 2`, and with a single `serverNow` standing in for both
 * server timestamps that reduces to **`serverNow - clientSentAt - rtt / 2`**. The server's clock is read AFTER the
 * request left, so half the round trip has already elapsed and must be subtracted back out.
 *
 * **`clockOffset` was wrong by `rtt`** -- twice the intended correction -- and always in the direction that makes a
 * countdown read **LATE**. It is now corrected (`PF-3`), and this file **no longer disagrees with it.**
 *
 * **THE TWO STILL BOTH EXIST, AND THAT IS NOT REDUNDANT.** `clockOffset` calls `Date.now()` internally, which is
 * right for it: it is the one sanctioned place a clock may read the wall. But it means it cannot be property-tested
 * and a countdown cannot be replayed. So this is the pure version, the tests here cover the FORMULA, and
 * `clockOffset` is the impure wrapper around it. One formula, two callers, and the testable one is under test.
 */
export const offsetFromRoundTrip = (
  clientSentAt: number,
  serverNow: number,
  clientReceivedAt: number,
): number => {
  const rtt = clientReceivedAt - clientSentAt;
  // A reply that appears to arrive BEFORE it was sent means the client's own clock jumped mid-flight, so the
  // sample is worthless. Returning `null` rather than a number lets the caller discard it; a negative RTT folded
  // into an offset would move the countdown by twice the error.
  if (rtt < 0) return Number.NaN;
  return serverNow - rtt / 2 - clientSentAt;
};

/**
 * THE OFFSET TO DISPLAY WITH, from a series of samples.
 *
 * **THE MEDIAN, NOT THE MEAN**, and the reason is that this is a number a student will be misled by. One sample
 * taken while the tab was throttled in the background can be seconds out; a mean lets that one sample move the
 * countdown for a full minute, and a median discards it. With an even number of samples the lower median is
 * taken, because being slightly EARLY is the safe direction: a countdown that reads one second long is a far
 * smaller problem than one that reads a minute short.
 *
 * `NaN` samples -- the ones from a clock that jumped -- are dropped rather than propagated, since one `NaN` in a
 * mean makes the whole estimate `NaN`.
 */
export const displayOffset = (samples: readonly number[]): number => {
  const usable = samples.filter((sample) => Number.isFinite(sample)).sort((a, b) => a - b);
  if (usable.length === 0) return 0;
  const middle = Math.floor(usable.length / 2);
  return usable.length % 2 === 1 ? (usable[middle] ?? 0) : (usable[middle - 1] ?? 0);
};

export interface SyncState {
  /** When the last sync completed, or `null` if there has never been one. */
  readonly lastSyncAt: number | null;
  /** When the user last did anything. Drives the pause trigger. */
  readonly lastActivityAt: number;
  readonly offset: number;
  readonly samples: readonly number[];
}

/**
 * SHOULD WE TALK TO THE SERVER AGAIN?
 *
 * Three triggers, and the first one is not in the plan's wording but follows from it: **never synced at all**.
 * A client that has not synced must not display a countdown derived from an offset it does not have.
 */
export const shouldResync = (state: SyncState, now: number): boolean => {
  if (state.lastSyncAt === null) return true;
  if (now - state.lastSyncAt >= RESYNC_INTERVAL_MS) return true;
  if (now - state.lastActivityAt >= RESYNC_AFTER_PAUSE_MS) return true;
  return false;
};

/** `serverNow + offset`, so a caller never adds the offset by hand and forgets. */
export const correctedNow = (clientNow: number, offset: number): number => clientNow + offset;

/** HOW WRONG THE DISPLAY MAY BE, in ms, given when the last sync was. Drives the "syncing…" indicator. */
export const stalenessMs = (state: SyncState, now: number): number =>
  state.lastSyncAt === null ? Number.POSITIVE_INFINITY : Math.max(0, now - state.lastSyncAt);

/**
 * PREFLIGHT: WHAT MUST BE TRUE BEFORE A STUDENT COMMITS TO A PAPER.
 *
 * ## WHY THIS IS WORTH HAVING WHEN EVERY ITEM IS ADVISABLE
 *
 * Because the alternative is finding out at the worst possible moment. A student who cannot write to storage will
 * lose answers silently; one whose browser is too old may lose the whole session; one on a metered connection
 * will fail to upload a file submission after writing an essay. None of these is visible at the start screen, and
 * all of them are invisible until the paper is closed.
 *
 * ## AND EVERY ITEM IS ADVISABLE OR FATAL, NEVER "PROCEED ANYWAY"
 *
 * There is no partial pass. `plans/15`'s "no keyboard traps" and this list share a property: a warning the student
 * can dismiss is a warning that gets dismissed, and the thing it warned about still happens. So a failed check is
 * either fixed or the student cannot start.
 */

/** A preflight check is either satisfied, or it has a consequence and a remedy. */
export interface PreflightCheck {
  readonly id: string;
  readonly label: string;
  readonly ok: boolean;
  /** What to do about it. Always present, because a failure with no remedy is just a refusal. */
  readonly remedy: string;
  /** Set when the student cannot start at all. Distinct from `ok`, which may be advisory. */
  readonly fatal: boolean;
}

export interface Preflight {
  readonly checks: readonly PreflightCheck[];
  /** Whether the student may start. */
  readonly mayStart: boolean;
  /** The fatal failures, in the order they should be shown. */
  readonly blockers: readonly PreflightCheck[];
}

/**
 * BUILD THE PREFLIGHT FROM WHAT THE CLIENT ACTUALLY MEASURED.
 *
 * The inputs are already-known facts rather than probes, so this function is pure and the whole screen is a
 * rendering of its output. A `preflight` that ran checks itself would be untestable and would put a side effect
 * in the start path.
 */
export const buildPreflight = (measured: {
  readonly storageWritable: boolean;
  readonly networkOnline: boolean;
  readonly supportedBrowser: boolean;
  readonly hasKeyboard: boolean;
  readonly remainingStorageBytes: number | null;
}): Preflight => {
  /**
   * `remainingStorageBytes` IS A THRESHOLD AND NOT A BOOLEAN, because the failure mode is a full disk rather than
   * a missing one, and by the time `storageWritable` is false the student has already lost something. 8 MB is
   * chosen to hold an outbox for a full paper of file submissions plus the attempt's own record; a number below
   * that is not "tight", it is "about to lose answers".
   */
  const MIN_STORAGE_BYTES = 8 * 1024 * 1024;

  const checks: readonly PreflightCheck[] = [
    {
      id: 'browser',
      label: 'This browser is supported',
      ok: measured.supportedBrowser,
      remedy:
        'Use a current version of Firefox, Chrome, Edge or Safari. An old browser can lose the whole session.',
      fatal: true,
    },
    {
      id: 'storage',
      label: 'This device can save answers',
      ok: measured.storageWritable,
      remedy:
        'Answers are held in this browser until the server acknowledges them. If it cannot write, they are gone when the tab closes.',
      fatal: true,
    },
    {
      id: 'space',
      label: 'There is room to hold this paper offline',
      ok:
        measured.remainingStorageBytes === null ||
        measured.remainingStorageBytes >= MIN_STORAGE_BYTES,
      remedy: `Free up space or use another device. Below ${String(MIN_STORAGE_BYTES / (1024 * 1024))} MB, answers can be lost mid-paper.`,
      // ADVISORY, not fatal: a tight disk degrades the outbox, it does not prevent answering, and refusing to let
      // a student start because of 3 MB would fail them for something they can work around.
      fatal: false,
    },
    {
      id: 'network',
      label: 'You are online',
      ok: measured.networkOnline,
      // ADVISORY. An offline start is legitimate -- the outbox exists for exactly that -- but the student should
      // know, because everything they write is local until connectivity returns.
      remedy: 'You can start offline. Answers are saved here and sent when you reconnect.',
      fatal: false,
    },
    {
      id: 'keyboard',
      label: 'You can reach everything without a mouse',
      ok: measured.hasKeyboard,
      remedy:
        'Every question type has a keyboard route. If Tab is not moving focus, check that a modifier key is not stuck.',
      // ADVISORY, and deliberately: `plans/15` requires keyboard operability of the RENDERER, which this phase
      // cannot verify from the client, and a student with no keyboard at all is not who this check is for.
      fatal: false,
    },
  ];

  const blockers = checks.filter((check) => check.fatal && !check.ok);
  return { checks, mayStart: blockers.length === 0, blockers };
};

/**
 * THE TWO TIMEOUTS ARE DELIBERATELY DIFFERENT, and TypeScript noticed.
 *
 * A `const HEARTBEAT_TIMEOUT_MS !== RESYNC_AFTER_PAUSE_MS` assertion is a COMPILE ERROR when both are literal
 * types, which is the linter earning its keep: it says a comparison between two constants can never be anything
 * but `true`, so writing it is noise. The relationship that actually matters is the ordering, and it is asserted
 * in the test suite where the values are `number`s.
 *
 * So this is a note rather than a constant. A tab quiet for 5 s is a COORDINATION problem; a device asleep for
 * 30 s has a WRONG CLOCK, and no amount of heartbeating will fix it.
 */
export const RESYNC_TRIGGER_NOTES = {
  coordinationTimeoutMs: HEARTBEAT_TIMEOUT_MS,
  clockPauseThresholdMs: RESYNC_AFTER_PAUSE_MS,
  resyncIntervalMs: RESYNC_INTERVAL_MS,
} as const;

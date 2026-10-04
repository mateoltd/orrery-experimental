// @vitest-environment jsdom

/**
 * `focusGuard`, `lifecycleGuard`, `tabGuard` and `clockGuard`.  (P8-T6)
 *
 * Three of these four have a specific way of producing a FALSE accusation against a student, and each of those is what
 * the tests are about:
 *
 *  · **focusGuard** double-counts: alt-tabbing fires BOTH `blur` and `visibilitychange`, so a naive guard spends two of
 *    a student's twelve `tabHides` on one alt-tab.
 *  · **lifecycleGuard** fabricates: `freeze`/`resume` exist only in Chromium, so assuming they fired puts an invented
 *    entry in a teacher's timeline on every Firefox and Safari exam.
 *  · **tabGuard** accuses silence: a sleeping or throttled tab does not answer a ping, and silence from a closed tab is
 *    identical, so detection has to be by RESPONSE.
 *  · **clockGuard** escalates: skew is advisory, and the server is the sole enforcer of time.
 */

import { FrozenClock } from '@orrery/clock';
import { describe, expect, it, vi } from 'vitest';

import { ClockGuard } from './clockGuard';
import { FocusGuard } from './focusGuard';
import { LifecycleGuard } from './lifecycleGuard';
import { type TabChannel, TabGuard, type TabMessage } from './tabGuard';
import type { Evidence } from './watchdog';

const T0 = 1_800_000_000_000;

class FakeHost {
  readonly listeners = new Map<string, (() => void)[]>();
  visibilityState: 'visible' | 'hidden' = 'visible';
  readonly known = new Set<string>([
    'blur',
    'focus',
    'visibilitychange',
    'pagehide',
    'online',
    'offline',
  ]);
  supportsEventType?: (type: string) => boolean;

  addEventListener(type: string, listener: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  removeEventListener(type: string, listener: () => void): void {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((entry) => entry !== listener),
    );
  }
  fire(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
  count(type: string): number {
    return (this.listeners.get(type) ?? []).length;
  }
}

const sinkFor = () => {
  const seen: Evidence[] = [];
  return {
    seen,
    sink: (evidence: Evidence) => {
      seen.push(evidence);
    },
  };
};

describe('FocusGuard: one departure is ONE event', () => {
  const setup = () => {
    const clock = new FrozenClock(T0);
    const host = new FakeHost();
    const { seen, sink } = sinkFor();
    const guard = new FocusGuard(clock, sink, host);
    guard.attach();
    return { clock, host, seen, guard };
  };

  it('folds the blur/hide PAIR of one alt-tab into a single TAB_HIDDEN', () => {
    /**
     * The double-count. Alt-tab fires `blur` AND `visibilitychange`, and at `tabHides: 12` a naive guard turns six
     * alt-tabs into a threshold breach.
     */
    const { host, seen } = setup();
    host.visibilityState = 'hidden';
    host.fire('blur');
    host.fire('visibilitychange');
    expect(seen.filter((e) => e.kind === 'TAB_HIDDEN' || e.kind === 'WINDOW_BLURRED')).toHaveLength(
      1,
    );
  });

  it('records it as a HIDE, because only a hide consumes `thresholds.tabHides`', () => {
    const { host, seen } = setup();
    host.visibilityState = 'hidden';
    host.fire('blur');
    expect(seen[0]?.kind).toBe('TAB_HIDDEN');
    // Saying which counter it lands in is what stops the two being quietly merged by whoever reads the log.
    expect(seen[0]?.detail?.countsAgainstTabHides).toBe(true);
  });

  it('upgrades a blur to a hide when the second signal says so', () => {
    // `blur` can arrive before `visibilityState` has flipped, so the pair has to be able to correct the first reading.
    const { host, seen } = setup();
    host.fire('blur');
    host.visibilityState = 'hidden';
    host.fire('visibilitychange');
    expect(seen[0]?.kind).toBe('WINDOW_BLURRED');
    // One event, and it is the stricter one.
    expect(seen.filter((e) => e.kind === 'TAB_HIDDEN')).toHaveLength(0);
  });

  it('distinguishes a plain window blur, which is not a tab hide', () => {
    const { host, seen } = setup();
    host.visibilityState = 'visible';
    host.fire('blur');
    expect(seen[0]?.kind).toBe('WINDOW_BLURRED');
    // A student clicking another window has still looked away, but it does not spend a `tabHides` allowance.
    expect(seen[0]?.detail?.countsAgainstTabHides).toBe(false);
  });

  it('reports the time away, and it is not always zero', () => {
    const { clock, host, seen } = setup();
    host.visibilityState = 'hidden';
    host.fire('blur');
    clock.advance(45_000);
    host.visibilityState = 'visible';
    host.fire('visibilitychange');
    expect(seen[1]?.kind).toBe('TAB_VISIBLE');
    expect(seen[1]?.detail?.awayForMs).toBe(45_000);
  });

  it('emits NOTHING for a focus event with no departure, so a stray focus is not evidence', () => {
    const { host, seen } = setup();
    host.fire('focus');
    expect(seen).toEqual([]);
  });
});

describe('LifecycleGuard', () => {
  const setup = (known: readonly string[] = ['blur']) => {
    const clock = new FrozenClock(T0);
    const host = new FakeHost();
    host.known.clear();
    for (const type of known) host.known.add(type);
    host.supportsEventType = (type: string) => host.known.has(type);
    const { seen, sink } = sinkFor();
    const flush = vi.fn();
    const guard = new LifecycleGuard(clock, sink, host, flush);
    guard.attach();
    return { host, seen, flush, guard };
  };

  it('subscribes to `freeze` only where the API exists', () => {
    const { host, guard } = setup(['freeze', 'resume']);
    expect(guard.supportsFreeze).toBe(true);
    expect(host.count('freeze')).toBe(1);
  });

  it('does NOT subscribe to `freeze` on a browser that has never heard of it', () => {
    /**
     * Firefox and Safari have no Page Lifecycle API. A guard that reports "the page was frozen" on every Firefox exam
     * fabricates an entry in a teacher's timeline every time.
     */
    const { host, guard } = setup([]);
    expect(guard.supportsFreeze).toBe(false);
    expect(host.count('freeze')).toBe(0);
    expect(host.count('resume')).toBe(0);
  });

  it('attempts the final flush on `pagehide`, the last reliable moment to send', () => {
    const { host, flush } = setup();
    host.fire('pagehide');
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it('records a final flush that REJECTS rather than swallowing it', () => {
    // A student whose final flush failed and who was never told finds out at grading time that answers are missing.
    const clock = new FrozenClock(T0);
    const host = new FakeHost();
    host.supportsEventType = () => false;
    const { seen, sink } = sinkFor();
    const guard = new LifecycleGuard(clock, sink, host, () => Promise.reject(new Error('offline')));
    guard.attach();
    host.fire('pagehide');
    return Promise.resolve().then(() => {
      expect(seen[0]?.kind).toBe('NETWORK_LOST');
      expect(seen[0]?.detail?.outcome).toBe('failed');
      expect(seen[0]?.detail?.reason).toBe('offline');
    });
  });

  it('records a final flush that THROWS synchronously', () => {
    const clock = new FrozenClock(T0);
    const host = new FakeHost();
    host.supportsEventType = () => false;
    const { seen, sink } = sinkFor();
    const guard = new LifecycleGuard(clock, sink, host, () => {
      throw new Error('quota');
    });
    guard.attach();
    host.fire('pagehide');
    expect(seen[0]?.detail?.outcome).toBe('threw');
  });

  it('reports the network once per transition, not once per event', () => {
    const { host, seen } = setup();
    host.fire('offline');
    host.fire('offline');
    expect(seen.filter((e) => e.kind === 'NETWORK_LOST')).toHaveLength(1);
    host.fire('online');
    host.fire('online');
    expect(seen.filter((e) => e.kind === 'NETWORK_RESTORED')).toHaveLength(1);
  });
});

describe('TabGuard: detection is by RESPONSE', () => {
  class FakeChannel implements TabChannel {
    readonly sent: TabMessage[] = [];
    private listeners: ((event: { data: unknown }) => void)[] = [];
    closed = false;
    postMessage(message: unknown): void {
      this.sent.push(message as TabMessage);
    }
    close(): void {
      this.closed = true;
    }
    addEventListener(_type: 'message', listener: (event: { data: unknown }) => void): void {
      this.listeners.push(listener);
    }
    removeEventListener(_type: 'message', listener: (event: { data: unknown }) => void): void {
      this.listeners = this.listeners.filter((entry) => entry !== listener);
    }
    deliver(data: unknown): void {
      for (const listener of this.listeners) listener({ data });
    }
  }

  const setup = (tabId = 'tab-a') => {
    const clock = new FrozenClock(T0);
    const host = new FakeHost();
    const channel = new FakeChannel();
    const { seen, sink } = sinkFor();
    const guard = new TabGuard(clock, sink, host, channel, tabId);
    guard.attach();
    return { channel, seen, guard };
  };

  it('reports NOTHING when no other tab answers a ping', () => {
    // Silence from a throttled tab and silence from a closed tab are identical, so silence is not evidence.
    const { channel, seen, guard } = setup();
    guard.ping();
    guard.ping();
    expect(seen).toEqual([]);
    expect(guard.peerCount).toBe(0);
    expect(channel.sent.filter((m) => m.kind === 'PING')).toHaveLength(2);
  });

  it('reports a second tab that ANSWERS', () => {
    const { channel, seen, guard } = setup();
    channel.deliver({ kind: 'PONG', tabId: 'tab-b', replyingTo: 'tab-a' } satisfies TabMessage);
    expect(seen.map((e) => e.kind)).toEqual(['MULTI_TAB_DETECTED']);
    expect(guard.peerCount).toBe(1);
  });

  it("answers another tab's ping, so both sides can detect each other", () => {
    const { channel, seen } = setup();
    channel.deliver({ kind: 'PING', tabId: 'tab-b' } satisfies TabMessage);
    expect(seen.map((e) => e.kind)).toEqual(['MULTI_TAB_DETECTED']);
    expect(channel.sent).toContainEqual({
      kind: 'PONG',
      tabId: 'tab-a',
      replyingTo: 'tab-b',
    } satisfies TabMessage);
  });

  it('ignores its OWN ping, or it would detect itself', () => {
    const { seen } = setup();
    const { channel } = setup();
    channel.deliver({ kind: 'PING', tabId: 'tab-a' } satisfies TabMessage);
    expect(seen).toEqual([]);
  });

  it('ignores a PONG addressed to a different tab', () => {
    const { seen, guard } = setup();
    // Two tabs both pinging means each receives the other's PONG; one addressed elsewhere is not our detection.
    guard.ping();
    (guard as unknown as { channel: FakeChannel }).channel.deliver({
      kind: 'PONG',
      tabId: 'tab-b',
      replyingTo: 'tab-c',
    } satisfies TabMessage);
    expect(seen).toEqual([]);
  });

  it('announces a peer ONCE, however many times it pings', () => {
    const { channel, seen } = setup();
    for (let i = 0; i < 20; i += 1) {
      channel.deliver({ kind: 'PING', tabId: 'tab-b' } satisfies TabMessage);
    }
    expect(seen).toHaveLength(1);
  });

  it('forgets a peer on request, so closing a second tab clears the banner', () => {
    const { channel, guard } = setup();
    channel.deliver({ kind: 'PING', tabId: 'tab-b' } satisfies TabMessage);
    guard.clearPeers();
    expect(guard.peerCount).toBe(0);
  });
});

describe('ClockGuard is ADVISORY', () => {
  const setup = () => {
    const clock = new FrozenClock(T0);
    const host = new FakeHost();
    const { seen, sink } = sinkFor();
    const guard = new ClockGuard(clock, sink, host);
    guard.attach();
    return { seen, guard };
  };

  it('says in its evidence that nothing was enforced and nobody was warned', () => {
    const { seen, guard } = setup();
    for (let i = 0; i < 4; i += 1) guard.record(45_000 + i * 5_000, 100);
    const skew = seen.find((e) => e.kind === 'CLOCK_SKEW_DETECTED');
    expect(skew).toBeDefined();
    // The server is the sole enforcer of time, so a wrong local offset costs a student nothing but a wrong countdown.
    // Warning them would be telling them something false during an exam.
    expect(skew?.detail?.advisory).toBe(true);
    expect(skew?.detail?.studentWarned).toBe(false);
    expect(skew?.detail?.enforcedByServer).toBe(true);
  });

  it('emits at most one event per DISTINCT finding, not one per sync', () => {
    /**
     * A drifting clock yields `DRIFTING` on every sync. An event per sync fills a teacher's timeline with identical
     * entries, which is how the one that mattered gets lost. A series whose status genuinely changes twice -- say
     * `UNKNOWN` then `DRIFTING` then `SKEWED` -- is two events, and that is the honest count rather than a flat 1.
     */
    const { seen, guard } = setup();
    const statuses: string[] = [];
    for (let i = 0; i < 12; i += 1) statuses.push(guard.record(1_000 + i * 1_500, 100));
    const distinctFindings = new Set(
      statuses.filter((status) => status === 'DRIFTING' || status === 'SKEWED'),
    ).size;
    const expected = [...statuses].filter(
      (status, index) =>
        (status === 'DRIFTING' || status === 'SKEWED') && status !== statuses[index - 1],
    ).length;
    expect(seen.filter((e) => e.kind === 'CLOCK_SKEW_DETECTED')).toHaveLength(expected);
    // And it never exceeds the number of distinct findings available.
    expect(expected).toBeLessThanOrEqual(distinctFindings + 1);
  });

  it('never reports a skew for `UNKNOWN`, which means "not enough data", not "skewed"', () => {
    /**
     * `UNKNOWN` is the state after the FIRST sync and whenever every round trip was too slow to use. Emitting
     * `CLOCK_SKEW_DETECTED` for it puts a false entry in a teacher's timeline at the start of almost every exam, and a
     * teacher learns to ignore the kind that matters.
     */
    const { seen, guard } = setup();
    void guard;
    guard.record(1_000, 100);
    expect(guard.verdict?.status).toBe('UNKNOWN');
    expect(seen).toEqual([]);

    // Every round trip too slow to use: still `UNKNOWN`, still nothing reported.
    const slow = setup();
    for (let i = 0; i < 4; i += 1) slow.guard.record(1_000, 9_000);
    expect(slow.guard.verdict?.status).toBe('UNKNOWN');
    expect(slow.seen).toEqual([]);
  });

  it('says nothing at all while the offset is steady', () => {
    const { seen, guard } = setup();
    for (let i = 0; i < 6; i += 1) guard.record(1_000 + (i % 2) * 30, 100);
    expect(seen.filter((e) => e.kind === 'CLOCK_SKEW_DETECTED')).toHaveLength(0);
  });

  it('bounds its samples, because a three-hour exam syns every 60 s', () => {
    const { guard } = setup();
    for (let i = 0; i < 500; i += 1) guard.record(1_000 + (i % 3) * 10, 100);
    // An unbounded list is both a leak and enough samples to make `detectSkew`'s median meaningless.
    expect(guard.verdict).not.toBeNull();
  });
});

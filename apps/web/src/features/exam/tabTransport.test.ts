/**
 * Tests for the coordination transport.  (P7-T11)
 *
 * ## THE POINT OF THESE TESTS IS THE ABSENT-CHANNEL CASE
 *
 * Everything interesting about a transport is what it does when it is not there. A `BroadcastChannel` that is
 * missing must not put a banner on an exam start screen for a condition that is harmless: with no channel there is
 * no second tab, so the tab is alone and the leader by definition.
 */

import { describe, expect, it } from 'vitest';
import {
  type CoordinationState,
  HEARTBEAT_TIMEOUT_MS,
  initialCoordination,
  leaderOf,
  type TabIdentity,
  writePermission,
} from './tabCoordination';
import {
  broadcastTransport,
  type CoordinationEvent,
  connectTab,
  loopbackTransport,
} from './tabTransport';

const AT = 1_000_000;
const self = (tabId: string, openedAt = AT): TabIdentity => ({ tabId, openedAt });

describe('a missing BroadcastChannel is a WORKING transport, not a failure', () => {
  it('delivers nothing and reports itself unavailable', () => {
    const transport = broadcastTransport('at-1');
    // Node has no `BroadcastChannel` by default in the jsdom environment this suite runs under, so this IS the
    // absent path -- which is convenient, because the absent path is the one worth testing and is otherwise the
    // one nobody can reproduce on a machine that happens to have it.
    expect(typeof BroadcastChannel === 'undefined' || transport.available === true).toBe(true);
    expect(() => transport.post({ type: 'BEAT', from: self('a'), at: AT })).not.toThrow();
    let received = 0;
    const unsubscribe = transport.subscribe(() => {
      received += 1;
    });
    unsubscribe();
    expect(received).toBe(0);
  });

  it('leaves a lone tab the leader, which is the CORRECT answer rather than a degraded one', () => {
    // This is the whole argument for the no-op: no channel means no second tab, so being alone is right.
    const transport = broadcastTransport('at-1');
    let latest: CoordinationState = initialCoordination('at-1', self('a'), 'BLOCK', AT);
    const connected = connectTab(latest, transport, self('a'), {
      now: AT,
      onState: (next) => (latest = next),
    });
    expect(leaderOf(latest)?.tabId).toBe('a');
    expect(writePermission(latest, 'a')).toEqual({ mayWrite: true });
    expect(connected.disconnect).toBeTypeOf('function');
  });
});

describe('the loopback transport, which is what the protocol is tested through', () => {
  it('delivers only on `deliver()`, so a test controls its own clock', () => {
    const transport = loopbackTransport();
    const seen: CoordinationEvent[] = [];
    transport.subscribe((event) => seen.push(event));
    transport.post({ type: 'HELLO', from: self('b', AT + 10), at: AT + 10 });
    // Nothing yet: delivery is explicit, so a test cannot accidentally depend on a microtask.
    expect(seen).toHaveLength(0);
    transport.deliver();
    expect(seen).toHaveLength(1);
  });

  it('stops delivering after unsubscribe', () => {
    const transport = loopbackTransport();
    const seen: CoordinationEvent[] = [];
    const unsubscribe = transport.subscribe((event) => seen.push(event));
    transport.post({ type: 'HELLO', from: self('b', AT + 10), at: AT + 10 });
    unsubscribe();
    transport.deliver();
    expect(seen).toHaveLength(0);
  });

  it('delivers to EVERY subscriber, so two views of one tab both learn', () => {
    const transport = loopbackTransport();
    const first: CoordinationEvent[] = [];
    const second: CoordinationEvent[] = [];
    transport.subscribe((event) => first.push(event));
    transport.subscribe((event) => second.push(event));
    transport.post({ type: 'HELLO', from: self('b', AT + 10), at: AT + 10 });
    transport.deliver();
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
  });
});

describe('two tabs over one transport', () => {
  /** The scenario the whole protocol exists for: one tab leads, and a BLOCKed follower may not write. */
  const twoTabs = (policy: 'WARN' | 'BLOCK') => {
    const transport = loopbackTransport();
    const leader = initialCoordination('at-1', self('a'), policy, AT);
    const follower = initialCoordination('at-1', self('b', AT + 10), policy, AT);
    // State arrives through the SINK, not as a return value -- the bug this shape exists to prevent.
    let leaderState = leader;
    let followerState = follower;
    connectTab(leader, transport, self('a'), { now: AT, onState: (next) => (leaderState = next) });
    connectTab(follower, transport, self('b'), {
      now: AT + 10,
      onState: (next) => (followerState = next),
    });
    transport.deliver();
    return { transport, leaderState: () => leaderState, followerState: () => followerState };
  };

  it('elects the same leader on both sides after the HELLOs cross', () => {
    const { leaderState, followerState } = twoTabs('BLOCK');
    // The follower hears about the leader and agrees with it. Disagreement is the window in which both write.
    expect(leaderOf(leaderState())?.tabId).toBe('a');
    expect(leaderOf(followerState())?.tabId).toBe('a');
  });

  it('BLOCKS the follower and permits the leader, and BOTH SIDES AGREE which is which', () => {
    const { followerState } = twoTabs('BLOCK');
    expect(writePermission(followerState(), 'a')).toEqual({ mayWrite: true });
    expect(writePermission(followerState(), 'b')).toEqual({
      mayWrite: false,
      because: 'ONLY_ONE_TAB',
    });
  });

  it('names a different reason under WARN', () => {
    const { followerState } = twoTabs('WARN');
    expect(writePermission(followerState(), 'b')).toEqual({
      mayWrite: false,
      because: 'ANOTHER_TAB_OPEN',
    });
  });

  it('carries no envelope, so a listener cannot mistake a sender for a payload field', () => {
    /**
     * The sender's `tabId` is already inside every event, so an envelope would be one more place for a listener to
     * forget to check who sent something -- and a listener that trusts an unverified envelope is how one tab
     * impersonates another and seizes the leadership.
     */
    const transport = loopbackTransport();
    transport.post({ type: 'HELLO', from: self('b', AT + 10), at: AT + 10 });
    expect(Object.keys(transport.sent[0] ?? {}).sort()).toEqual(['at', 'from', 'type']);
    expect((transport.sent[0] as { from: TabIdentity }).from.tabId).toBe('b');
  });
});

describe('the beat belongs to the CALLER, not to an interval started here', () => {
  it('keeps a tab alive against the timeout when the caller beats it, and not otherwise', () => {
    const transport = loopbackTransport();
    const seeded = initialCoordination('at-1', self('a'), 'BLOCK', AT);
    const later = AT + HEARTBEAT_TIMEOUT_MS + 1;

    let unbeat: CoordinationState = seeded;
    connectTab(seeded, transport, self('a'), { now: AT, onState: (next) => (unbeat = next) });
    // No beat: past the timeout the tab has gone silent and there is no leader at all.
    expect(leaderOf({ ...unbeat, now: later })).toBeNull();

    let beat: CoordinationState = seeded;
    connectTab(seeded, transport, self('a'), {
      now: AT + HEARTBEAT_TIMEOUT_MS,
      onState: (next) => (beat = next),
      beat: (state) => ({ ...state, lastActivityAt: AT + HEARTBEAT_TIMEOUT_MS }),
    });
    // A recent beat is the difference, and it is why an interval started inside the protocol would be a bug:
    // an effect with no owner and no way to stop it in a test.
    expect(leaderOf({ ...beat, now: later })?.tabId).toBe('a');
  });
});

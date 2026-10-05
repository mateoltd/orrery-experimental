// @vitest-environment jsdom

/**
 * ADVERSARIAL: a second tab, and a second device.  (P8-T15, `plans/09` §4 `multiTabPolicy`, `plans/17` §3.5
 * "concurrent writes from two devices")
 *
 * ## TWO DIFFERENT PROBLEMS SHARE THIS NAME, AND ONLY ONE OF THEM CAN BE SOLVED IN A BROWSER
 *
 *  · A second TAB is on the same device. `BroadcastChannel` reaches it, so the two can agree which of them writes,
 *    and the guarantee is exactly one writer.
 *  · A second DEVICE is not reachable by anything in this directory. Each device elects itself, both write, and the
 *    only thing that can refuse one of them is the server's revision check. That half is
 *    `adversarial-server-write.integration.test.ts`, and its `ADV-DB2` is the reason "exactly one writer" cannot yet
 *    be claimed across devices.
 *
 * So what is tested here is the tab half, and the tab DETECTOR -- which has a failure the coordination does not: it
 * emits `MULTI_TAB_DETECTED`, a `VIOLATION` that always counts as a strike, on the strength of a message from a
 * channel any same-origin script can post to.
 *
 * ## A LIMIT THAT IS NOT A DEFECT, STATED SO NOBODY READS THE FIRST TEST AS MORE THAN IT IS
 *
 * "Exactly one tab may write" holds for tabs computing from the SAME announcements. A tab whose device slept, or
 * whose `HELLO` has not arrived yet, computes from a different set and can believe it leads while another tab does
 * too. `tabCoordination.ts` says so ("revives to find itself a follower -- which is survivable"). It is survivable
 * only because the server refuses the stale write, which is why the server half matters.
 */

import { FrozenClock } from '@orrery/clock';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  applyCoordinationEvent,
  type CoordinationEvent,
  type CoordinationState,
  HEARTBEAT_TIMEOUT_MS,
  initialCoordination,
  liveTabsInElectionOrder,
  secondTabWarning,
  type TabPolicy,
  writePermission,
} from '../tabCoordination';
import { type TabChannel, TabGuard } from './tabGuard';
import type { Evidence } from './watchdog';

const T0 = 1_800_000_000_000;
const RUNS = 300;

const TAB_IDS = ['tab-a', 'tab-b', 'tab-c', 'tab-d'] as const;

/** Anything the transport can carry, from any of four tabs, at any moment in a ten-second window. */
const eventArb: fc.Arbitrary<CoordinationEvent> = fc.oneof(
  fc.record({
    type: fc.constant('HELLO' as const),
    from: fc.record({
      tabId: fc.constantFrom(...TAB_IDS),
      openedAt: fc.integer({ min: T0 - 5, max: T0 + 5 }),
    }),
    at: fc.integer({ min: T0, max: T0 + 10_000 }),
  }),
  fc.record({
    type: fc.constant('BEAT' as const),
    from: fc.record({ tabId: fc.constantFrom(...TAB_IDS), openedAt: fc.constant(T0) }),
    at: fc.integer({ min: T0, max: T0 + 10_000 }),
  }),
  fc.record({
    type: fc.constantFrom('FOCUS' as const, 'BYE' as const),
    tabId: fc.constantFrom(...TAB_IDS),
    at: fc.integer({ min: T0, max: T0 + 10_000 }),
  }),
);

const after = (policy: TabPolicy, events: readonly CoordinationEvent[]): CoordinationState =>
  events.reduce(
    applyCoordinationEvent,
    initialCoordination('attempt', { tabId: 'tab-a', openedAt: T0 }, policy, T0),
  );

describe('a second tab on the same attempt', () => {
  it('leaves exactly one live tab able to write, under BOTH policies and after any history', () => {
    /**
     * What breaks without it: two writers. Both hold a revision, both answer question 3, and whichever save lands
     * second is a 409 -- or, from the same revision, a silent overwrite.
     *
     * `WARN` is in the property on purpose. The name suggests the second tab is warned and allowed; it is refused,
     * and a `WARN` branch that returned `mayWrite: true` would be two writers with a toast.
     */
    fc.assert(
      fc.property(
        fc.constantFrom<TabPolicy>('WARN', 'BLOCK'),
        fc.array(eventArb, { maxLength: 25 }),
        (policy, events) => {
          const state = after(policy, events);
          const live = liveTabsInElectionOrder(state);
          const writers = live.filter((tab) => writePermission(state, tab.tabId).mayWrite);

          if (live.length > 0) {
            expect(writers).toHaveLength(1);
            expect(writers[0]?.tabId).toBe(live[0]?.tabId);
          }
          // A follower is REFUSED, and is told why in a word the UI can switch on.
          for (const tab of live.slice(1)) {
            expect(writePermission(state, tab.tabId)).toEqual({
              mayWrite: false,
              because: policy === 'BLOCK' ? 'ONLY_ONE_TAB' : 'ANOTHER_TAB_OPEN',
            });
          }
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('gives every tab the same answer from the same announcements, in whatever order they arrived', () => {
    // Two tabs that disagree about the leader are two writers. The transport does not promise an order ACROSS
    // senders, so the election has to be a function of the set.
    //
    // One announcement per tab, deliberately. `BroadcastChannel` does keep each sender's own messages in order, and
    // the reducer relies on it: a second `HELLO` from the same tab overwrites `lastSeenAt` with whatever time it
    // carries, so one sender's messages replayed backwards would move a live tab's heartbeat into the past and make
    // it stale. That is not reachable through the real transport and is not asserted either way here.
    fc.assert(
      fc.property(
        fc.uniqueArray(
          eventArb.filter((event) => event.type === 'HELLO'),
          { maxLength: 4, selector: (event) => (event.type === 'HELLO' ? event.from.tabId : '') },
        ),
        fc.constantFrom<TabPolicy>('WARN', 'BLOCK'),
        (hellos, policy) => {
          const forwards = after(policy, hellos);
          const backwards = after(policy, [...hellos].reverse());
          // Compared at one instant: `now` is the latest event either way.
          expect(liveTabsInElectionOrder(backwards).map((tab) => tab.tabId)[0]).toBe(
            liveTabsInElectionOrder(forwards).map((tab) => tab.tabId)[0],
          );
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('does not let a tab that crashed keep the paper locked', () => {
    // The refusal has to end. A leader that died never says `BYE`; if silence did not release the lock, a student
    // whose first tab crashed could not write another answer without knowing to reload.
    const opened = after('BLOCK', [
      { type: 'HELLO', from: { tabId: 'tab-b', openedAt: T0 + 1 }, at: T0 + 1 },
    ]);
    expect(writePermission(opened, 'tab-b').mayWrite).toBe(false);

    // Only tab-b is heard from again.
    const later = applyCoordinationEvent(opened, {
      type: 'BEAT',
      from: { tabId: 'tab-b', openedAt: T0 + 1 },
      at: T0 + HEARTBEAT_TIMEOUT_MS + 2,
    });
    expect(writePermission(later, 'tab-b')).toEqual({ mayWrite: true });
  });

  /**
   * `ADV-W4` -- KNOWN DEFECT in `tabCoordination.ts`, outside this lane.
   *
   * Under `WARN` the module answers "may the second tab write?" twice and differently:
   *
   *  · `writePermission(...).mayWrite` is `false` (and `tabCoordination.test.ts` pins it: "still refuses the second
   *    tab under `WARN`");
   *  · `secondTabWarning(...).thisTabMayWrite` is `true`, and the doc comment on `WritePermission` agrees with it
   *    ("the policy is `WARN`, so this tab may write and the student is told").
   *
   * So the banner tells a student this tab can save, and the store refuses the save. Which of the two is intended is
   * a product decision; that they disagree is not.
   */
  it('ADV-W4: tells the student the same thing the store enforces, under either policy', () => {
    for (const policy of ['WARN', 'BLOCK'] as const) {
      const state = after(policy, [
        { type: 'HELLO', from: { tabId: 'tab-b', openedAt: T0 + 1 }, at: T0 + 1 },
      ]);
      const warning = secondTabWarning(state, 'tab-b');
      expect(warning).not.toBeNull();
      expect(warning?.thisTabMayWrite, policy).toBe(writePermission(state, 'tab-b').mayWrite);
    }
  });
});

describe('the second-tab DETECTOR accuses on a response, and only on a real one', () => {
  class Channel implements TabChannel {
    readonly sent: unknown[] = [];
    private listeners: ((event: { data: unknown }) => void)[] = [];
    postMessage(message: unknown): void {
      this.sent.push(message);
    }
    close(): void {
      this.listeners = [];
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

  const setup = () => {
    const channel = new Channel();
    const seen: Evidence[] = [];
    const host = { addEventListener: () => undefined, removeEventListener: () => undefined };
    const guard = new TabGuard(
      new FrozenClock(T0),
      (evidence) => {
        seen.push(evidence);
      },
      host,
      channel,
      'tab-a',
    );
    guard.attach();
    return { channel, seen, guard };
  };

  it('accuses nobody for silence, however many pings go unanswered', () => {
    // A sleeping laptop, a throttled background tab and a closed tab are all silence. If silence were evidence, the
    // student whose machine suspended mid-exam would be recorded as having had a second session.
    const { seen, guard } = setup();
    for (let n = 0; n < 500; n += 1) guard.ping();
    expect(seen).toEqual([]);
    expect(guard.peerCount).toBe(0);
  });

  it('does not detect itself, when its own messages are echoed back to it', () => {
    // `BroadcastChannel` does not echo, and a polyfill or a relay might. An echo must not be a second tab.
    const { channel, seen, guard } = setup();
    guard.ping();
    for (const message of [...channel.sent]) channel.deliver(message);
    channel.deliver({ kind: 'PONG', tabId: 'tab-a', replyingTo: 'tab-a' });
    expect(seen).toEqual([]);
  });

  it('reports one real second tab ONCE, however long the two stay open together', () => {
    // `MULTI_TAB_DETECTED` always counts. Two tabs pinging each other every few seconds for three hours must be one
    // finding, not two thousand.
    const { channel, seen } = setup();
    for (let n = 0; n < 2_000; n += 1) {
      channel.deliver({ kind: 'PING', tabId: 'tab-b' });
      channel.deliver({ kind: 'PONG', tabId: 'tab-b', replyingTo: 'tab-a' });
    }
    expect(seen.map((evidence) => evidence.kind)).toEqual(['MULTI_TAB_DETECTED']);
  });

  it('never throws on anything the channel can carry', () => {
    fc.assert(
      fc.property(fc.anything(), (data) => {
        const { channel } = setup();
        expect(() => {
          channel.deliver(data);
        }).not.toThrow();
      }),
      { numRuns: RUNS },
    );
  });

  /**
   * `ADV-W5` -- KNOWN DEFECT in `tabGuard.ts`, outside this lane.
   *
   * The handler casts `event.data` to `TabMessage` and reads `tabId` without checking it is there. A message of
   * `{ kind: 'PING' }` has a `tabId` of `undefined`, `undefined !== 'tab-a'` is true, and the guard records a peer
   * called `undefined`, answers it, and emits `MULTI_TAB_DETECTED` -- a `VIOLATION` that `countsAsStrike` counts under
   * every policy.
   *
   * The channel is `orrery:attempt:<id>`, and any script on the origin can post to it: another page of this app, a
   * future feature that reuses the name, a browser extension's content script. None of them is a second exam session,
   * and one malformed message from any of them is a recorded accusation of one.
   */
  it('ADV-W5: accuses nobody on a message that does not identify a tab', () => {
    const malformed: unknown[] = [
      { kind: 'PING' },
      { kind: 'PING', tabId: undefined },
      { kind: 'PING', tabId: null },
      { kind: 'PING', tabId: 42 },
      { kind: 'PING', tabId: '' },
      { kind: 'PONG', replyingTo: 'tab-a' },
      { kind: 'PONG', tabId: {}, replyingTo: 'tab-a' },
    ];
    for (const data of malformed) {
      const { channel, seen, guard } = setup();
      channel.deliver(data);
      expect(seen, JSON.stringify(data)).toEqual([]);
      expect(guard.peerCount, JSON.stringify(data)).toBe(0);
      // And it does not ANSWER one either: a reply is how the other side would "detect" this tab.
      expect(channel.sent, JSON.stringify(data)).toEqual([]);
    }
  });
});

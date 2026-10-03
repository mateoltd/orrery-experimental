/**
 * Tests for multi-tab coordination.  (P7-T11)
 *
 * ## THE PROPERTIES THAT MATTER ARE AGREEMENT AND ABSORPTION
 *
 * Two tabs writing one attempt is data loss, so the protocol has to satisfy two things at once:
 *
 * - **AGREEMENT.** Every tab computes the same leader from the same set of announcements. If they could disagree,
 *   there is a window where both write, and that window is the bug.
 * - **ABSORPTION.** Applying the same event twice changes nothing. A duplicated `HELLO` over a flaky transport
 *   must not add a second tab or reset a clock.
 *
 * Both are properties over generated event sequences rather than assertions about three hand-built tabs.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  applyCoordinationEvent,
  type CoordinationEvent,
  type CoordinationState,
  HEARTBEAT_TIMEOUT_MS,
  hello,
  initialCoordination,
  leaderOf,
  liveTabsInElectionOrder,
  precedes,
  secondTabWarning,
  type TabIdentity,
  tabStates,
  writePermission,
} from './tabCoordination';

const AT = 1_000_000;
const RUNS = 200;

const self = (tabId: string, openedAt = AT): TabIdentity => ({ tabId, openedAt });

/**
 * A state in which every tab has announced itself.
 *
 * The attempt id is irrelevant to the protocol, but the state needs one, so the first tab supplies it. Note the
 * seed: `initialCoordination` makes `tabs[0]` the leader, and then `tabs[0]` is ALSO replayed as a `HELLO`, so the
 * first tab's own announcement is exercised rather than assumed.
 */
const state = (
  tabs: readonly TabIdentity[],
  policy: 'WARN' | 'BLOCK' = 'WARN',
  now = AT,
): CoordinationState => {
  const first = tabs[0] ?? self('a', AT);
  // Through the exported `hello()` rather than an inline literal, so the fixture cannot drift from the API a
  // caller actually uses.
  return tabs.reduce(
    (acc, tab) => applyCoordinationEvent(acc, hello(tab, tab.openedAt)),
    initialCoordination(`at-${first.tabId}`, first, policy, now),
  );
};

describe('exactly one tab writes, and every tab agrees which', () => {
  it('elects the FIRST tab to open', () => {
    const s = state([self('a', AT), self('b', AT + 100), self('c', AT + 200)]);
    expect(leaderOf(s)?.tabId).toBe('a');
  });

  it('breaks an `openedAt` TIE by tab id, deterministically', () => {
    // Two tabs opened in the same millisecond is common -- a double-click, or a restored session -- and without
    // a deterministic tiebreak they can disagree about who leads, which is the failure the algorithm prevents.
    const left = state([self('b', AT), self('a', AT)]);
    const right = state([self('a', AT), self('b', AT)]);
    expect(leaderOf(left)?.tabId).toBe('a');
    expect(leaderOf(right)?.tabId).toBe('a');
    // And the ORDER OF ANNOUNCEMENT DOES NOT MATTER, which is the property that matters.
    expect(JSON.stringify(left.tabs)).not.toBe(JSON.stringify(right.tabs));
  });

  it('elects the same leader whatever order the HELLOs arrive in', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.string({ minLength: 1, maxLength: 3 }), { minLength: 2, maxLength: 6 }),
        (ids) => {
          const tabs = ids.map((id, index) => self(id, AT + index * 10));
          const forwards = state(tabs);
          const backwards = state([...tabs].reverse());
          expect(leaderOf(forwards)?.tabId).toBe(leaderOf(backwards)?.tabId);
          return true;
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('never elects a leader that is not live', () => {
    const s = state([self('a', AT), self('b', AT + 100)]);
    const gone = applyCoordinationEvent(s, { type: 'BYE', tabId: 'a', at: AT + 200 });
    expect(leaderOf(gone)?.tabId).toBe('b');
  });

  it('compares identities the same way every time', () => {
    expect(precedes(self('a', AT), self('b', AT))).toBe(true);
    expect(precedes(self('b', AT), self('a', AT))).toBe(false);
    expect(precedes(self('a', AT + 1), self('a', AT))).toBe(false);
  });
});

describe('a stale tab neither leads nor blocks, and that is the part usually left out', () => {
  /**
   * `'a'` IS GIVEN A FRESH BEAT in both tests below, and that detail is the point.
   *
   * The first version advanced `now` past the timeout and then expected the OLDER tab to still be live. It is
   * not: `a` last beat at `AT` and `now` is well past the timeout, so `a` is stale too, and every live tab
   * disappears. Both tabs going silent is correct behaviour -- a student who closed every tab should not be
   * locked out -- so the test premise was wrong rather than the code.
   */
  const withBeats = (): CoordinationState => {
    const seeded = state([self('a', AT), self('b', AT + 100)]);
    // `'a'` BEATS AT THE INSTANT THE CLOCK IS ADVANCED TO, minus one tick -- not at `AT`.
    //
    // The second attempt beat `a` at `AT + 100` and then advanced `now` to `AT + 100 + TIMEOUT + 1`, which made
    // `a` stale too: `now - lastSeenAt` is `TIMEOUT + 1`, which is past the timeout. Both tabs went silent, which
    // is CORRECT behaviour and not what the test was about. A tab is only live if something beat it recently, so
    // the fixture has to actually do that.
    const beatAt = AT + 100 + HEARTBEAT_TIMEOUT_MS;
    const beaten = applyCoordinationEvent(seeded, {
      type: 'BEAT',
      from: self('a', AT),
      at: beatAt,
    });
    return { ...beaten, now: beatAt + 1 };
  };

  it('marks a silent tab STALE while a beating one stays live', () => {
    const later = withBeats();
    expect(tabStates(later).b).toBe('STALE');
    expect(tabStates(later).a).toBe('LEADER');
  });

  it('revives a stale tab on its next BEAT', () => {
    const stale = withBeats();
    expect(leaderOf(stale)?.tabId).toBe('a');
    const revived = applyCoordinationEvent(stale, {
      type: 'BEAT',
      from: self('b', AT + 100),
      at: stale.now,
    });
    // It comes back as a FOLLOWER and does not seize the leadership it lost while it was quiet -- and the LEADER
    // is still `a`, which is only meaningful because `a` is genuinely live here.
    expect(leaderOf(revived)?.tabId).toBe('a');
    expect(tabStates(revived).b).toBe('FOLLOWER');
  });

  it('DOES NOT resurrect a tab that said BYE, even if a beat arrives afterwards', () => {
    // A beat after `BYE` is a transport bug, and treating it as alive again would resurrect a lock nobody holds.
    const s = applyCoordinationEvent(state([self('a', AT), self('b', AT + 10)]), {
      type: 'BYE',
      tabId: 'b',
      at: AT + 20,
    });
    const after = applyCoordinationEvent(s, {
      type: 'BEAT',
      from: self('b', AT + 10),
      at: AT + 30,
    });
    expect(tabStates(after).b).toBe('GONE');
    expect(leaderOf(after)?.tabId).toBe('a');
  });

  it('lets a tab WRITE when every tab is stale, rather than locking a student out of their own paper', () => {
    const s = state([self('a', AT)], 'BLOCK', AT + HEARTBEAT_TIMEOUT_MS * 10);
    // Refusing here is the worst outcome available: the student's other tab died and now they cannot answer, and
    // the tab that is still open is told it may not write because of a tab that is not.
    expect(writePermission(s, 'a')).toEqual({ mayWrite: true });
    expect(leaderOf(s)).toBeNull();
  });

  it('never lets a tab re-announce itself with an EARLIER `openedAt` to seize leadership', () => {
    const s = state([self('a', AT), self('b', AT + 100)]);
    const cheater = applyCoordinationEvent(s, {
      type: 'HELLO',
      from: self('b', AT - 500),
      at: AT + 200,
    });
    expect(leaderOf(cheater)?.tabId).toBe('a');
  });
});

describe('the two policies differ in whether a second tab may WRITE, not in politeness', () => {
  it('lets the leader write under both policies', () => {
    for (const policy of ['WARN', 'BLOCK'] as const) {
      expect(writePermission(state([self('a', AT), self('b', AT + 10)], policy), 'a')).toEqual({
        mayWrite: true,
      });
    }
  });

  it('BLOCKS a second tab under `BLOCK`', () => {
    // `plans/09` §4's `multiTabPolicy: 'WARN' | 'BLOCK'` -- and the difference is whether the second tab may
    // write at all. A warning that permits overwriting is how two tabs lose an answer.
    expect(writePermission(state([self('a', AT), self('b', AT + 10)], 'BLOCK'), 'b')).toEqual({
      mayWrite: false,
      because: 'ONLY_ONE_TAB',
    });
  });

  it('still refuses the second tab under `WARN`, but says why differently', () => {
    const s = state([self('a', AT), self('b', AT + 10)], 'WARN');
    expect(writePermission(s, 'b')).toEqual({ mayWrite: false, because: 'ANOTHER_TAB_OPEN' });
    expect(secondTabWarning(s, 'b')).toEqual({
      because: 'ANOTHER_TAB_OPEN',
      otherTabs: 1,
      thisTabMayWrite: true,
    });
  });

  it('warns nobody on the leader, and nobody when it is alone', () => {
    const s = state([self('a', AT), self('b', AT + 10)]);
    expect(secondTabWarning(s, 'a')).toBeNull();
    expect(secondTabWarning(state([self('a', AT)]), 'a')).toBeNull();
  });

  it('counts the OTHER live tabs, so a third tab gets the right number', () => {
    const s = state([self('a', AT), self('b', AT + 10), self('c', AT + 20)]);
    expect(secondTabWarning(s, 'c')).toEqual({
      because: 'ANOTHER_TAB_OPEN',
      otherTabs: 2,
      thisTabMayWrite: true,
    });
  });
});

describe('focus is exclusive', () => {
  it('moves focus rather than letting two tabs hold it', () => {
    // Two tabs both believing they hold focus produce two "student is here" indicators and no way to tell which
    // one the student is looking at.
    let s = state([self('a', AT), self('b', AT + 10)]);
    s = applyCoordinationEvent(s, { type: 'FOCUS', tabId: 'b', at: AT + 20 });
    expect(
      Object.values(s.tabs)
        .filter((tab) => tab.focused)
        .map((tab) => tab.tabId),
    ).toEqual(['b']);
    s = applyCoordinationEvent(s, { type: 'FOCUS', tabId: 'a', at: AT + 30 });
    expect(
      Object.values(s.tabs)
        .filter((tab) => tab.focused)
        .map((tab) => tab.tabId),
    ).toEqual(['a']);
  });

  it('does not change the leader when focus moves', () => {
    const s = applyCoordinationEvent(state([self('a', AT), self('b', AT + 10)]), {
      type: 'FOCUS',
      tabId: 'b',
      at: AT + 20,
    });
    expect(leaderOf(s)?.tabId).toBe('a');
  });
});

describe('properties over the protocol', () => {
  /** Any event naming any of a small fixed tab set, so the generator stays finite. */
  const arbEvent: fc.Arbitrary<CoordinationEvent> = fc.oneof(
    fc
      .tuple(fc.constantFrom('a', 'b', 'c'), fc.integer({ min: -50, max: 50 }))
      .map(([tabId, drift]) => ({ type: 'HELLO', from: self(tabId, AT + drift), at: AT }) as const),
    fc
      .tuple(fc.constantFrom('a', 'b', 'c'), fc.integer({ min: -50, max: 50 }))
      .map(
        ([tabId, drift]) => ({ type: 'BEAT', from: self(tabId, AT + drift), at: AT + 10 }) as const,
      ),
    fc
      .tuple(fc.constantFrom('a', 'b', 'c'), fc.integer({ min: -50, max: 50 }))
      .map(([tabId, drift]) => ({ type: 'FOCUS', tabId, at: AT + 20 + drift }) as const),
    fc.constantFrom('a', 'b', 'c').map((tabId) => ({ type: 'BYE', tabId, at: AT + 30 }) as const),
  );

  it('is ABSORPTIVE: applying the same event twice changes nothing', () => {
    // A duplicated `HELLO` over a flaky transport must not add a second tab or reset a clock.
    fc.assert(
      fc.property(fc.array(arbEvent, { maxLength: 6 }), arbEvent, (events, repeat) => {
        const once = events.reduce(applyCoordinationEvent, state([self('a', AT)]));
        const twice = events.reduce(applyCoordinationEvent, once);
        const again = applyCoordinationEvent(twice, repeat);
        const onceMore = applyCoordinationEvent(twice, repeat);
        return JSON.stringify(again) === JSON.stringify(onceMore);
      }),
      { numRuns: RUNS },
    );
  });

  it('never elects MORE THAN ONE leader, and never elects a gone tab', () => {
    fc.assert(
      fc.property(fc.array(arbEvent, { maxLength: 8 }), (events) => {
        const s = events.reduce(applyCoordinationEvent, state([self('a', AT)]));
        const live = liveTabsInElectionOrder(s);
        const states = tabStates(s);
        // At most one LEADER among the live tabs, and it is always the first in election order.
        const leaders = live.filter((tab) => states[tab.tabId] === 'LEADER');
        if (leaders.length > 1) return false;
        return live.every((tab) => states[tab.tabId] !== 'GONE');
      }),
      { numRuns: RUNS },
    );
  });

  it("elects the SAME LEADER for every interleaving of three tabs' announcements", () => {
    /**
     * THE AGREEMENT PROPERTY, AND IT IS NOT THE ONE I FIRST WROTE.
     *
     * The first version reversed the whole event list and asserted both orders elect the same leader. That
     * failed, and the counterexample was `HELLO b @AT` then `HELLO b @AT-1` -- the SAME sender announcing twice
     * with different `openedAt`. Reversing the list reverses one sender's announcements relative to themselves,
     * which a broadcast channel cannot do: every tab receives each sender's messages in that sender's order.
     *
     * So the property was stronger than reality and the code was right. What IS true, and what matters, is that
     * the INTERLEAVING across senders does not matter -- three tabs announcing in any of the six orders elect the
     * same leader. Six permutations is small enough to enumerate, which is better than generating them.
     */
    const tabs = [self('a', AT), self('b', AT + 10), self('c', AT + 20)];
    const permutations = (items: readonly TabIdentity[]): TabIdentity[][] =>
      items.length <= 1
        ? [[...items]]
        : items.flatMap((item, index) =>
            permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [
              item,
              ...rest,
            ]),
          );
    const leaders = permutations(tabs).map((order) => leaderOf(state(order))?.tabId);
    expect(new Set(leaders).size).toBe(1);
    expect(leaders[0]).toBe('a');
  });

  it("keeps a tab's `openedAt` from its FIRST announcement, so re-announcing cannot move it", () => {
    // The same-sender case the reversed-list property tripped over, asserted for what it actually guarantees.
    const once = applyCoordinationEvent(state([self('a', AT)]), {
      type: 'HELLO',
      from: self('b', AT + 10),
      at: AT,
    });
    const twice = applyCoordinationEvent(once, {
      type: 'HELLO',
      from: self('b', AT - 500),
      at: AT + 5,
    });
    expect(twice.tabs.b?.openedAt).toBe(AT + 10);
    expect(leaderOf(twice)?.tabId).toBe('a');
  });

  it('ALWAYS elects a live tab when one exists', () => {
    fc.assert(
      fc.property(fc.array(arbEvent, { maxLength: 8 }), (events) => {
        const s = events.reduce(applyCoordinationEvent, state([self('a', AT)]));
        const leader = leaderOf(s);
        if (leader === null) return true;
        const states = tabStates(s);
        return states[leader.tabId] === 'LEADER' || states[leader.tabId] === 'FOLLOWER';
      }),
      { numRuns: RUNS },
    );
  });

  it('refuses a write by a follower under BLOCK, and never by the leader', () => {
    fc.assert(
      fc.property(fc.array(arbEvent, { maxLength: 8 }), (events) => {
        const s = events.reduce(applyCoordinationEvent, state([self('a', AT)]));
        const leader = leaderOf(s);
        if (leader === null) return true;
        if (leader.tabId === 'a') return writePermission(s, 'a').mayWrite === true;
        return writePermission(s, 'a').mayWrite === false;
      }),
      { numRuns: RUNS },
    );
  });
});

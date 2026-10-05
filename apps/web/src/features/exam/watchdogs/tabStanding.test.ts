/**
 * ONE RULE FOR "MAY THIS TAB WRITE?", AND TWO THINGS THAT REPEAT IT.  (`ADV-W4`)
 *
 * `writePermission` is what the store is told. `secondTabWarning` is what the student is told. They used to be two
 * implementations, and under `WARN` the second said "this tab may write" while the first refused the write.
 *
 * ## WHY THERE ARE TWO BLOCKS HERE AND NEITHER IS REDUNDANT
 *
 * The first block is the AGREEMENT: every tab, every policy, every history, the two say the same thing. It is what
 * goes red if somebody gives the banner its own opinion again.
 *
 * It is also blind, by construction, to the two moving TOGETHER -- `PF-8` measured exactly that on the expiry
 * matrix. Turn `WARN`'s row into `mayWrite: true` and the agreement still holds, because both sides read the row. So
 * the second block pins what the answer IS, and must not be deleted as a duplicate of the first.
 *
 * (This lives beside the watchdogs rather than in `tabCoordination.test.ts` only because of which files the task
 * that wrote it was allowed to touch.)
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  applyCoordinationEvent,
  type CoordinationEvent,
  type CoordinationState,
  initialCoordination,
  liveTabsInElectionOrder,
  secondTabWarning,
  type TabPolicy,
  tabStanding,
  writePermission,
} from '../tabCoordination';

const T0 = 1_800_000_000_000;
const RUNS = 300;

const TAB_IDS = ['tab-a', 'tab-b', 'tab-c', 'tab-d'] as const;
/** Every tab the history can mention, and one it cannot: a tab nobody has heard of still asks the question. */
const ASKERS = [...TAB_IDS, 'tab-unknown'] as const;

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

const twoTabs = (policy: TabPolicy): CoordinationState =>
  after(policy, [{ type: 'HELLO', from: { tabId: 'tab-b', openedAt: T0 + 1 }, at: T0 + 1 }]);

describe('what the student is told is what the store enforces', () => {
  it('agrees for every tab, under both policies, after any history', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<TabPolicy>('WARN', 'BLOCK'),
        fc.array(eventArb, { maxLength: 25 }),
        (policy, events) => {
          const state = after(policy, events);
          for (const tabId of ASKERS) {
            const permission = writePermission(state, tabId);
            const warning = secondTabWarning(state, tabId);
            const standing = tabStanding(state, tabId);

            // Both are the one standing, read from two sides.
            expect(permission).toEqual(standing.permission);
            if (warning !== null) expect(warning.thisTabMayWrite).toBe(permission.mayWrite);
            // A tab that is refused is never left without the banner that says so...
            if (!permission.mayWrite) expect(warning).not.toBeNull();
            // ...and a banner appears exactly when a live tab other than this one leads.
            expect(warning !== null).toBe(standing.follows);
          }
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('counts the other LIVE tabs in the banner, and never this one', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<TabPolicy>('WARN', 'BLOCK'),
        fc.array(eventArb, { maxLength: 25 }),
        (policy, events) => {
          const state = after(policy, events);
          const live = liveTabsInElectionOrder(state).map((tab) => tab.tabId);
          for (const tabId of ASKERS) {
            const warning = secondTabWarning(state, tabId);
            if (warning === null) continue;
            expect(warning.otherTabs).toBe(live.filter((id) => id !== tabId).length);
            expect(warning.otherTabs).toBeGreaterThan(0);
          }
        },
      ),
      { numRuns: RUNS },
    );
  });
});

describe('and what the answer IS, which the agreement above cannot see', () => {
  it('refuses a follower under BOTH policies, and names the policy in the reason', () => {
    // The row an edit to the policy table changes. `[false, false]` is what fails the moment `WARN` becomes "two
    // writers with a toast"; the agreement block stays green through that, as it must.
    expect(writePermission(twoTabs('WARN'), 'tab-b')).toEqual({
      mayWrite: false,
      because: 'ANOTHER_TAB_OPEN',
    });
    expect(writePermission(twoTabs('BLOCK'), 'tab-b')).toEqual({
      mayWrite: false,
      because: 'ONLY_ONE_TAB',
    });
  });

  it('tells that follower it cannot save, under BOTH policies', () => {
    // This is the line that was `true` under `WARN` while the store refused.
    for (const policy of ['WARN', 'BLOCK'] as const) {
      expect(secondTabWarning(twoTabs(policy), 'tab-b'), policy).toEqual({
        because: 'ANOTHER_TAB_OPEN',
        otherTabs: 1,
        thisTabMayWrite: false,
      });
    }
  });

  it('lets the leader write and shows it no banner, under both policies', () => {
    for (const policy of ['WARN', 'BLOCK'] as const) {
      expect(writePermission(twoTabs(policy), 'tab-a'), policy).toEqual({ mayWrite: true });
      expect(secondTabWarning(twoTabs(policy), 'tab-a'), policy).toBeNull();
      expect(tabStanding(twoTabs(policy), 'tab-a'), policy).toEqual({
        follows: false,
        otherTabs: 1,
        permission: { mayWrite: true },
      });
    }
  });

  it('never dead-ends a student: when no tab is live, the one asking may write and is shown nothing', () => {
    // `plans/09` §6.2. Every tab stale is a laptop waking up, and refusing there locks a student out of their own
    // paper on the strength of tabs that are not running.
    for (const policy of ['WARN', 'BLOCK'] as const) {
      const asleep: CoordinationState = { ...twoTabs(policy), now: T0 + 3_600_000 };
      expect(liveTabsInElectionOrder(asleep)).toEqual([]);
      for (const tabId of ASKERS) {
        expect(writePermission(asleep, tabId), `${policy} ${tabId}`).toEqual({ mayWrite: true });
        expect(secondTabWarning(asleep, tabId), `${policy} ${tabId}`).toBeNull();
      }
    }
  });
});

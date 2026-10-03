'use client';

/**
 * Multi-tab coordination: exactly one writer per attempt.  (P7-T11)
 *
 * ## WHY ONE WRITER AND NOT A WARNING
 *
 * Two tabs on one attempt is a data-loss bug, not a UX papercut. Both tabs hold a revision; both answer question 3;
 * whichever save lands second is a `409` or, worse, a silent overwrite if both were working from the same
 * revision. `plans/09` §4 offers `multiTabPolicy: 'WARN' | 'BLOCK'`, and the difference between them is not how
 * polite the warning is -- it is **whether the second tab may write at all**.
 *
 * So the coordination state here answers one question: may THIS tab write? And the answer is derived, never
 * asserted by a caller, because a caller that decides for itself is how two writers happen.
 *
 * ## LEADER ELECTION IS BY LOWEST TAB ID, AND THAT IS THE WHOLE ALGORITHM
 *
 * Every tab announces itself with a random `tabId` and a monotonically increasing `openedAt`. The writer is the
 * tab with the lowest `(openedAt, tabId)` pair -- opened first, ties broken by id. No negotiation round, no
 * election timeout, no coordinator: every tab computes the same answer from the same set of announcements, so
 * there is no window in which two tabs both believe they won.
 *
 * The tiebreak is not decoration. Two tabs opened in the same millisecond is common -- a student double-clicking,
 * or a restored session -- and without a deterministic tiebreak the tabs can disagree about who leads, which is
 * the exact failure the algorithm exists to prevent.
 *
 * ## A HEARTBEAT TIMEOUT IS NECESSARY AND IS THE PART THAT GETS LEFT OUT
 *
 * A tab that crashes, sleeps, or is closed never sends `GONE`. Without a timeout the dead tab keeps the lock and
 * the student cannot answer anything until they reload -- which is the worst possible outcome for someone whose
 * other tab died. So a tab is `STALE` after `HEARTBEAT_TIMEOUT_MS` without a beat, and a stale tab neither leads
 * nor blocks.
 *
 * `STALE` rather than `GONE` because "I have not heard from you" and "you have left" are different facts, and
 * only the second is worth telling the student.
 */

/** A tab's identity. `openedAt` breaks ties; `tabId` breaks the remaining tie. */
export interface TabIdentity {
  readonly tabId: string;
  readonly openedAt: number;
}

export type TabState = 'LEADER' | 'FOLLOWER' | 'STALE' | 'GONE';

export interface KnownTab extends TabIdentity {
  readonly state: TabState;
  /** The last time this tab was heard from. Drives `STALE`. */
  readonly lastSeenAt: number;
  /** Whether this tab currently holds focus. At most one tab can. */
  readonly focused: boolean;
}

/**
 * `plans/09` §4's `multiTabPolicy`, RESTATED rather than imported.
 *
 * `policy/index.ts` declares it inline as `z.enum(['WARN','BLOCK'])` and exports only the schema, so there is no
 * named type to import. Writing the two values out here is a duplication -- and it is checked rather than
 * assumed, because a `satisfies` against the schema's inferred union is impossible without the type, so the test
 * `covers both policy values and no others` assigns each and asserts the branch taken.
 */
export type TabPolicy = 'WARN' | 'BLOCK';

export interface CoordinationState {
  readonly attemptId: string;
  /** Every tab this one has heard of, including itself. */
  readonly tabs: Readonly<Record<string, KnownTab>>;
  readonly policy: TabPolicy;
  readonly now: number;
}

/**
 * HOW LONG BEFORE A SILENT TAB IS ASSUMED DEAD.
 *
 * Five seconds, and the reasoning is about what a false negative costs. A live tab beats about every 2 s (the
 * autosave budget in `outbox.ts`), so 5 s is two-and-a-half beats of slack for a backgrounded tab whose timers
 * are throttled. Too short and a throttled background tab is declared dead and then revives to find itself a
 * follower -- which is survivable. Too long and a crashed tab holds the lock for the length of the timeout, during
 * which the student cannot write anything at all.
 */
export const HEARTBEAT_TIMEOUT_MS = 5_000;

export const initialCoordination = (
  attemptId: string,
  self: TabIdentity,
  policy: TabPolicy,
  now: number,
): CoordinationState => ({
  attemptId,
  policy,
  now,
  tabs: { [self.tabId]: { ...self, state: 'LEADER', lastSeenAt: now, focused: true } },
});

/** The ordering that elects a leader. Exported so a test can assert two tabs agree without duplicating it. */
export const precedes = (a: TabIdentity, b: TabIdentity): boolean =>
  a.openedAt !== b.openedAt ? a.openedAt < b.openedAt : a.tabId < b.tabId;

/**
 * EVERY TAB'S STATE, recomputed. Nothing is stored as "current" because a cached leadership flag goes stale the
 * moment another tab opens, and a stale leadership flag is two writers.
 */
export const tabStates = (state: CoordinationState): Readonly<Record<string, TabState>> => {
  const out: Record<string, TabState> = {};
  for (const [id, tab] of Object.entries(state.tabs)) {
    out[id] =
      tab.state === 'GONE'
        ? 'GONE'
        : state.now - tab.lastSeenAt > HEARTBEAT_TIMEOUT_MS
          ? 'STALE'
          : tab.state;
  }
  return out;
};

/** THE TABS THAT CAN SEE THEMSELVES AS LIVE, ordered by the election. */
export const liveTabsInElectionOrder = (state: CoordinationState): readonly KnownTab[] => {
  const states = tabStates(state);
  return Object.values(state.tabs)
    .filter((tab) => states[tab.tabId] === 'LEADER' || states[tab.tabId] === 'FOLLOWER')
    .sort((a, b) => (precedes(a, b) ? -1 : 1));
};

/** THE ONE TAB THAT MAY WRITE, or `null` when every live tab has gone stale. */
export const leaderOf = (state: CoordinationState): TabIdentity | null =>
  liveTabsInElectionOrder(state)[0] ?? null;

/**
 * MAY THIS TAB WRITE?
 *
 * The single question this module exists to answer, and it is asked of the CALLER rather than answered by the
 * caller. Three outcomes, and the third is the one `plans/09`'s `BLOCK` exists for:
 *
 * - `null` -- this tab leads. Write.
 * - `'ONLY_ONE_TAB'` -- another tab leads and the policy is `BLOCK`, so this tab may read but not write.
 * - `'ANOTHER_TAB_OPEN'` -- another tab leads and the policy is `WARN`, so this tab may write and the student is
 *   told.
 */
export type WritePermission =
  | { readonly mayWrite: true }
  | { readonly mayWrite: false; readonly because: 'ONLY_ONE_TAB' | 'ANOTHER_TAB_OPEN' };

export const writePermission = (state: CoordinationState, selfTabId: string): WritePermission => {
  const leader = leaderOf(state);
  // No live tab at all -- which happens when every tab has gone stale, including this one. Writing is allowed,
  // because refusing would lock a student out of their own paper.
  if (leader === null) return { mayWrite: true };
  if (leader.tabId === selfTabId) return { mayWrite: true };
  return state.policy === 'BLOCK'
    ? { mayWrite: false, because: 'ONLY_ONE_TAB' }
    : { mayWrite: false, because: 'ANOTHER_TAB_OPEN' };
};

/** THE EVENT, which is one tab telling the others something. Everything the transport carries is one of these. */
export type CoordinationEvent =
  | { readonly type: 'HELLO'; readonly from: TabIdentity; readonly at: number }
  | { readonly type: 'BEAT'; readonly from: TabIdentity; readonly at: number }
  | { readonly type: 'FOCUS'; readonly tabId: string; readonly at: number }
  | { readonly type: 'BYE'; readonly tabId: string; readonly at: number };

/** The event every tab broadcasts when it opens, and the only one that starts an election. */
export const hello = (from: TabIdentity, at: number): CoordinationEvent => ({
  type: 'HELLO',
  from,
  at,
});

/**
 * APPLY AN EVENT. Pure, and the whole coordination protocol is these five lines.
 *
 * `HELLO` is the only event that adds a tab, so a tab cannot appear merely by being heard from. `BEAT` refreshes
 * `lastSeenAt` and does NOT reset `GONE` -- a tab that said goodbye and then sent a beat is a bug in the
 * transport, and treating it as alive again would resurrect a lock nobody is holding.
 */
export const applyCoordinationEvent = (
  state: CoordinationState,
  event: CoordinationEvent,
): CoordinationState => {
  switch (event.type) {
    case 'HELLO': {
      const held = state.tabs[event.from.tabId];
      /**
       * A TAB THAT SAID `BYE` CANNOT BE RESURRECTED BY A LATER `HELLO`, AND THAT IS AN ORDERING RULE.
       *
       * Found by the agreement property: with events `HELLO c, BYE c, BYE a` the leader is nobody, but reversed
       * -- `BYE a, BYE c, HELLO c` -- `c` is re-added and leads. The two orders disagreed, and two tabs computing
       * different leaders from the same events is the one thing this protocol must never do.
       *
       * So a `tabId` that left has left, within an attempt. A student who genuinely reopens the paper gets a new
       * tab, a new `tabId` and a fresh election, which is correct -- reopening is starting again.
       */
      if (held?.state === 'GONE') return state;
      const tabs = {
        ...state.tabs,
        /**
         * `openedAt` COMES FROM `held` WHEN THE TAB IS KNOWN, and this line was a real bug.
         *
         * The spread was `...event.from` first, so a second `HELLO` from a live tab OVERWROTE `openedAt` with
         * whatever the sender claimed -- which is precisely the "re-announce with an earlier `openedAt` to seize
         * leadership" attack the comment above it claimed to prevent. The comment was true and the code was not.
         *
         * Found by the agreement property, with the counterexample `HELLO b @AT` then `HELLO b @AT-1`: the two
         * orders produced different leaders.
         */
        [event.from.tabId]: {
          ...event.from,
          openedAt: held?.openedAt ?? event.from.openedAt,
          state: held?.state ?? 'FOLLOWER',
          lastSeenAt: event.at,
          focused: held?.focused ?? false,
        },
      };
      return { ...state, now: Math.max(state.now, event.at), tabs };
    }
    case 'BEAT': {
      const held = state.tabs[event.from.tabId];
      if (held === undefined || held.state === 'GONE') return state;
      return {
        ...state,
        now: Math.max(state.now, event.at),
        tabs: {
          ...state.tabs,
          [event.from.tabId]: { ...held, lastSeenAt: event.at },
        },
      };
    }
    case 'FOCUS': {
      const tabs = { ...state.tabs };
      // Focus is EXCLUSIVE. Two tabs both believing they hold it produces two "student is here" indicators and no
      // way to tell which one the student is looking at.
      for (const tab of Object.values(tabs)) {
        if (tab.focused) tabs[tab.tabId] = { ...tab, focused: false };
      }
      const held = tabs[event.tabId];
      if (held !== undefined) tabs[event.tabId] = { ...held, focused: true, lastSeenAt: event.at };
      return { ...state, now: Math.max(state.now, event.at), tabs };
    }
    case 'BYE': {
      const held = state.tabs[event.tabId];
      if (held === undefined) return state;
      return {
        ...state,
        now: Math.max(state.now, event.at),
        tabs: { ...state.tabs, [event.tabId]: { ...held, state: 'GONE', focused: false } },
      };
    }
    default:
      return state;
  }
};

/**
 * THE SECOND-TAB WARNING, or `null` when there is nothing to warn about.
 *
 * Only returned for a tab that is a FOLLOWER with a LIVE leader other than itself, and the message differs by
 * policy because the two policies mean different things to a student: `WARN` says "your other tab may overwrite
 * this", `BLOCK` says "this tab cannot save".
 */
export const secondTabWarning = (
  state: CoordinationState,
  selfTabId: string,
): {
  readonly because: 'ANOTHER_TAB_OPEN';
  readonly otherTabs: number;
  readonly thisTabMayWrite: boolean;
} | null => {
  const live = liveTabsInElectionOrder(state).filter((tab) => tab.tabId !== selfTabId);
  if (live.length === 0) return null;
  if (leaderOf(state)?.tabId === selfTabId) return null;
  return {
    because: 'ANOTHER_TAB_OPEN',
    otherTabs: live.length,
    thisTabMayWrite: state.policy !== 'BLOCK',
  };
};

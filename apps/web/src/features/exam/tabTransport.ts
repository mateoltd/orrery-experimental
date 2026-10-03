'use client';

/**
 * The transport for the coordination protocol: a `BroadcastChannel`, and nothing else.  (P7-T11)
 *
 * ## WHY THE PROTOLOGY IS SEPARATE AND THIS FILE HAS ALMOST NO LOGIC
 *
 * `tabCoordination.ts` decides who may write. This file moves the bytes. The separation is what made the two
 * order-dependencies in the protocol findable by property test, because a pure state machine can be replayed and a
 * `BroadcastChannel` cannot. Anything that decides anything belongs in the protocol.
 *
 * ## AND A MISSING `BroadcastChannel` IS A NO-OP, NOT A CRASH
 *
 * `BroadcastChannel` is unavailable in some browsers and in a server render. The temptation is to feature-detect
 * and warn, which puts a banner on the exam start screen for a condition that is harmless: with no channel there
 * is no second tab to coordinate with, so the tab is alone and the leader by definition.
 *
 * So the absent case is a working transport that delivers nothing. The protocol then sees one tab and elects it,
 * which is the correct answer, and the student never learns there was a channel missing.
 *
 * ## THE CHANNEL NAME INCLUDES THE ATTEMPT, SO TWO PAPERS NEVER SEE EACH OTHER
 *
 * A shared name across attempts would mean opening a second paper -- in another tab, for a different assignment --
 * makes the first tab believe a second tab is competing for the same attempt, and `BLOCK` would then refuse to let
 * a student answer a paper they have not started yet. That is a wrong refusal in a direction nobody would think to
 * test, so the name carries the attempt id.
 */

import type { CoordinationEvent, CoordinationState, TabIdentity } from './tabCoordination';
import { applyCoordinationEvent, hello } from './tabCoordination';

// RE-EXPORTED so a consumer of the transport needs one import rather than two. The type lives with the protocol
// because the protocol defines it; this module only carries it, and a second definition here would be a second
// thing to keep in step.
export type { CoordinationEvent, CoordinationState, TabIdentity };

/** What a transport must provide. Two methods, so a test can supply a loopback without a browser. */
export interface CoordinationTransport {
  post(event: CoordinationEvent): void;
  /** Unsubscribe. Returns a function rather than a handle, because a forgotten unsubscribe is a memory leak. */
  subscribe(handle: (event: CoordinationEvent) => void): () => void;
  /** False when there is no channel, which is NOT an error -- see the header. */
  readonly available: boolean;
}

/**
 * THE REAL TRANSPORT.
 *
 * `attemptId` is in the channel name, so two open papers cannot see each other's tabs. Messages carry the sender's
 * tabId already, inside the event, so no envelope is needed -- and an envelope would be one more place for a
 * listener to forget to check who sent something.
 */
export const broadcastTransport = (attemptId: string): CoordinationTransport => {
  if (typeof BroadcastChannel === 'undefined') {
    return { post: () => {}, subscribe: () => () => {}, available: false };
  }
  const channel = new BroadcastChannel(`orrery:attempt:${attemptId}`);
  const listeners = new Set<(event: CoordinationEvent) => void>();

  channel.onmessage = (message: MessageEvent<CoordinationEvent>) => {
    for (const listener of listeners) listener(message.data);
  };

  return {
    available: true,
    post: (event) => {
      channel.postMessage(event);
    },
    subscribe: (handle) => {
      listeners.add(handle);
      return () => {
        listeners.delete(handle);
        // The channel is closed when the LAST listener goes, so an exam screen that unmounts leaves nothing
        // behind. A closed channel that is still posted to is a silent no-op, which is worse than it sounds: a tab
        // that believes it is still participating would go stale and stop blocking a second tab.
        if (listeners.size === 0) channel.close();
      };
    },
  };
};

/** A LOOPBACK transport for tests, and for a single-tab fallback where no channel exists. */
export interface LoopbackTransport extends CoordinationTransport {
  /** Everything posted, in order. A test asserts on this rather than reaching into the channel. */
  readonly sent: readonly CoordinationEvent[];
  /** Deliver everything posted so far to every subscriber. Manual, because a test controls its own clock. */
  deliver(): void;
}

export const loopbackTransport = (): LoopbackTransport => {
  const sent: CoordinationEvent[] = [];
  const listeners = new Set<(event: CoordinationEvent) => void>();
  return {
    available: true,
    sent,
    post: (event) => {
      sent.push(event);
    },
    subscribe: (handle) => {
      listeners.add(handle);
      return () => listeners.delete(handle);
    },
    deliver: () => {
      for (const listener of listeners) for (const event of sent) listener(event);
    },
  };
};

/**
 * WIRE A TAB TO A TRANSPORT, AND REPORT EVERY CHANGE TO A CALLER SUPPLIED SINK.
 *
 * ## WHY THE SINK IS A CALLBACK AND NOT A RETURNED VALUE
 *
 * The first version returned `{state, disconnect}` and updated its own closure variable on delivery. So the
 * returned `state` was a SNAPSHOT taken at connect time, and every event after it was applied to a variable nobody
 * could read. In a React screen the tab would show "you are the only tab" for ever -- which is the failure this
 * whole protocol exists to prevent, presented as its opposite.
 *
 * A caller cannot observe a closure's variable, so the sink is the only shape that works. It is also the right shape
 * for React: the caller passes `setState` and re-renders, rather than the transport reaching into a component.
 *
 * ## SUBSCRIBE BEFORE POST, AND POST YOUR OWN `HELLO`
 *
 * The first version applied the hello locally, subscribed, and never POSTED it. So a tab announced itself to
 * nobody: invisible in a single-tab test, and catastrophic in the two-tab scenario, where the follower had no idea
 * a leader existed and so reported `mayWrite: true` for itself. **Two writers.**
 *
 * Subscribing first also closes the window where a reply arrives between the post and the subscription.
 *
 * ## AND THE BEAT BELONGS TO THE CALLER
 *
 * A beat is the only thing keeping a tab from going `STALE`, so the caller supplies it rather than this starting an
 * interval: an interval started inside a protocol consumer is an effect with no owner and no way to stop it in a
 * test. It is called once here, at connect time, so the initial announcement carries a live `lastActivityAt`.
 */
export const connectTab = (
  initial: CoordinationState,
  transport: CoordinationTransport,
  self: TabIdentity,
  options: {
    readonly now: number;
    /** Called on every state change, including the initial announcement. */
    readonly onState: (state: CoordinationState) => void;
    readonly beat?: (state: CoordinationState, now: number) => CoordinationState;
  },
): { readonly disconnect: () => void } => {
  let current = initial;

  const publish = (next: CoordinationState): void => {
    current = next;
    options.onState(current);
  };

  const disconnect = transport.subscribe((event) => {
    publish(applyCoordinationEvent(current, event));
  });

  const greeting = hello(self, options.now);
  publish(
    options.beat === undefined
      ? applyCoordinationEvent(current, greeting)
      : options.beat(applyCoordinationEvent(current, greeting), options.now),
  );
  transport.post(greeting);

  return { disconnect };
};

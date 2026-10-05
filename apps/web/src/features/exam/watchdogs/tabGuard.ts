'use client';

/**
 * `tabGuard` (P8-T6). Detects a second live tab through `BroadcastChannel`.
 *
 * ## DETECTION IS BY RESPONSE, NOT BY SILENCE
 *
 * The naive design is "each tab announces itself on a timer; if I hear another announcement, there are two tabs". That
 * reports a second tab for a student who simply had their laptop asleep, or whose background tab was throttled to once a
 * minute, or who closed the other tab thirty seconds ago. Every one of those is a false accusation of a second attempt,
 * and `MULTI_TAB_DETECTED` feeds the escalation ladder.
 *
 * So it is a PING AND RESPONSE. This tab pings; another tab that is genuinely alive answers. A tab that does not answer
 * is not evidence of anything, because silence from a throttled tab and silence from a closed tab are identical.
 */

import { type EvidenceSink, Watchdog, type WatchdogHost } from './watchdog';

export interface TabChannel {
  postMessage(message: unknown): void;
  close(): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
}

export type TabMessage =
  | { readonly kind: 'PING'; readonly tabId: string }
  | { readonly kind: 'PONG'; readonly tabId: string; readonly replyingTo: string };

const isTabId = (value: unknown): value is string => typeof value === 'string' && value !== '';

/**
 * READ A MESSAGE OFF THE CHANNEL, OR REFUSE IT. (`ADV-W5`)
 *
 * The handler used to CAST `event.data` to `TabMessage` and read `tabId` without checking it was there. So
 * `{ kind: 'PING' }` had a `tabId` of `undefined`, `undefined !== 'tab-a'` was true, and the guard recorded a peer
 * called `undefined`, answered it, and emitted `MULTI_TAB_DETECTED` -- a `VIOLATION` that counts as a strike under
 * every policy.
 *
 * The channel is `orrery:attempt:<id>` and any script on the origin can post to it: another page of this app, a
 * later feature that reuses the name, an extension's content script. None of them is a second exam session. So a
 * message is evidence only if it NAMES a tab, and the guard below is handed a `TabMessage` or nothing -- there is no
 * path on which it holds `unknown` and reads a field.
 *
 * It returns a fresh object rather than the one received, so nothing the sender attached travels any further.
 */
export const parseTabMessage = (data: unknown): TabMessage | null => {
  if (typeof data !== 'object' || data === null) return null;
  const { kind, tabId, replyingTo } = data as Readonly<Record<string, unknown>>;
  if (!isTabId(tabId)) return null;
  if (kind === 'PING') return { kind, tabId };
  if (kind === 'PONG' && isTabId(replyingTo)) return { kind, tabId, replyingTo };
  return null;
};

export class TabGuard extends Watchdog {
  private readonly channel: TabChannel;
  private readonly tabId: string;
  /** Tab ids seen alive in the current window. A set, because two tabs ping each other repeatedly. */
  private readonly peers = new Set<string>();
  /** Whether each peer has been announced yet, so a peer is reported once rather than on every ping. */
  private readonly announced = new Set<string>();

  constructor(
    clock: { now(): number },
    sink: EvidenceSink,
    host: WatchdogHost,
    channel: TabChannel,
    tabId: string,
  ) {
    super(clock, sink, host);
    this.channel = channel;
    this.tabId = tabId;
  }

  protected subscribe(): void {
    this.channel.addEventListener('message', this.onMessage);
  }

  protected unsubscribe(): void {
    this.channel.removeEventListener('message', this.onMessage);
  }

  private readonly onMessage = (event: { data: unknown }): void => {
    const message = parseTabMessage(event.data);
    // Unreadable, or this tab hearing itself: `BroadcastChannel` does not echo, and a polyfill or a relay might.
    if (message === null || message.tabId === this.tabId) return;

    if (message.kind === 'PING') {
      // A live tab is asking. Answer, and note it as a peer.
      this.peers.add(message.tabId);
      this.channel.postMessage({
        kind: 'PONG',
        tabId: this.tabId,
        replyingTo: message.tabId,
      } satisfies TabMessage);
      this.announce(message.tabId);
      return;
    }

    if (message.replyingTo === this.tabId) {
      // A live tab answered US. That is the detection, and it is the only detection.
      this.peers.add(message.tabId);
      this.announce(message.tabId);
    }
  };

  private announce(peerId: string): void {
    if (this.announced.has(peerId)) return;
    this.announced.add(peerId);
    this.emit('MULTI_TAB_DETECTED', { peerTabId: peerId });
  }

  /** Ask whether anyone is there. Called on a timer by the host; silence is not evidence. */
  ping(): void {
    this.channel.postMessage({ kind: 'PING', tabId: this.tabId } satisfies TabMessage);
  }

  /** Forget every peer, for after a deliberate close of a second tab. The next ping re-detects if it is still open. */
  clearPeers(): void {
    this.peers.clear();
    this.announced.clear();
  }

  get peerCount(): number {
    return this.peers.size;
  }

  /** Close the channel. Separate from `detach()` because the channel outlives the subscription. */
  close(): void {
    this.channel.close();
  }
}

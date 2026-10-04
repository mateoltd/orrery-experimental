'use client';

/**
 * `lifecycleGuard` (P8-T6). Listens to `pagehide`, `beforeunload`, and `freeze`/`resume` where they exist.
 *
 * ## `freeze` AND `resume` ARE NOT STANDARD, AND THAT IS THE POINT OF FEATURE-DETECTING THEM
 *
 * The Page Lifecycle API exists in Chromium and nowhere else. Registering a listener for `freeze` on a browser that has
 * never heard of it is harmless; ASSUMING it fired is not. A guard that reports "the page was frozen" on a browser that
 * cannot freeze pages produces a fabricated entry in a teacher's timeline, on every single exam, on every Firefox and
 * Safari.
 *
 * So the events are feature-detected at attach time and the absence is recorded as a fact about the client -- which
 * feeds P8-T3's preflight, where an unavailable capability is a relaxation rather than a silent default.
 */

import { type EvidenceSink, Watchdog, type WatchdogHost } from './watchdog';

/** Called on `pagehide`/`beforeunload` so the caller can flush the outbox. Injected: this guard does not own transport. */
export type FinalFlush = () => void | Promise<void>;

export class LifecycleGuard extends Watchdog {
  private readonly flush: FinalFlush;
  private online = true;

  constructor(clock: { now(): number }, sink: EvidenceSink, host: WatchdogHost, flush: FinalFlush) {
    super(clock, sink, host);
    this.flush = flush;
  }

  protected subscribe(): void {
    this.host.addEventListener('pagehide', this.onPageHide);
    this.host.addEventListener('online', this.onOnline);
    this.host.addEventListener('offline', this.onOffline);
    // Feature-detected: absent on Firefox and Safari, and assuming otherwise fabricates evidence.
    if (this.supports('freeze')) this.host.addEventListener('freeze', this.onFreeze);
    if (this.supports('resume')) this.host.addEventListener('resume', this.onResume);
  }

  protected unsubscribe(): void {
    this.host.removeEventListener('pagehide', this.onPageHide);
    this.host.removeEventListener('online', this.onOnline);
    this.host.removeEventListener('offline', this.onOffline);
    if (this.supports('freeze')) this.host.removeEventListener('freeze', this.onFreeze);
    if (this.supports('resume')) this.host.removeEventListener('resume', this.onResume);
  }

  /**
   * Whether the host knows this event type at all.
   *
   * The host is asked directly rather than through `instanceof`, so a test can drive it and a real `Document` answers
   * the same question. An unknown type returns false, which is the conservative answer: no evidence rather than
   * fabricated evidence.
   */
  private supports(type: string): boolean {
    const host = this.host as WatchdogHost & { supportsEventType?: (type: string) => boolean };
    return host.supportsEventType?.(type) ?? false;
  }

  private readonly onPageHide = (): void => {
    /**
     * THE FINAL FLUSH IS ATTEMPTED, AND ITS FAILURE IS NOT SUPPRESSED.
     *
     * `pagehide` is the last reliable moment to send anything, and this is where unsent answers either reach the server
     * or do not. A rejection is recorded rather than swallowed: a student whose final flush failed and who is never told
     * finds out at grading time that answers are missing, which is the worst possible time to find out.
     */
    try {
      const result = this.flush();
      if (result instanceof Promise) {
        result.catch((error: unknown) => {
          this.emit('NETWORK_LOST', {
            phase: 'final_flush',
            outcome: 'failed',
            reason: error instanceof Error ? error.message : 'unknown',
          });
        });
      }
    } catch (error) {
      this.emit('NETWORK_LOST', {
        phase: 'final_flush',
        outcome: 'threw',
        reason: error instanceof Error ? error.message : 'unknown',
      });
    }
  };

  private readonly onOffline = (): void => {
    if (!this.online) return;
    this.online = false;
    this.emit('NETWORK_LOST', { phase: 'offline_event' });
  };

  private readonly onOnline = (): void => {
    if (this.online) return;
    this.online = true;
    this.emit('NETWORK_RESTORED', { phase: 'online_event' });
  };

  private readonly onFreeze = (): void => {
    // A frozen page cannot run timers, so this is the last point at which a heartbeat can be sent.
    this.emit('NETWORK_LOST', { phase: 'frozen' });
  };

  private readonly onResume = (): void => {
    this.emit('NETWORK_RESTORED', { phase: 'resumed' });
  };

  /** Whether the host advertised the Page Lifecycle API. Feeds P8-T3's preflight report. */
  get supportsFreeze(): boolean {
    return this.supports('freeze');
  }

  get isOnline(): boolean {
    return this.online;
  }
}

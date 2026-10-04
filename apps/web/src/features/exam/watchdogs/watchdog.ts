'use client';

/**
 * The six exam watchdogs.  (P8-T4, P8-T5, P8-T6)
 *
 * `plans/09` §6 requires each to take an INJECTED CLOCK and an INJECTED SINK, so each is unit-testable without a
 * browser. That is not a testing convenience -- it is the only way these can be tested honestly. A watchdog that reads
 * `Date.now()` internally has a grace period nobody can exercise, and a grace period nobody can exercise is a grace
 * period that is wrong in production.
 *
 * ## WHY THE STATE IS HERE AND NOT IN REACT
 *
 * Every one of these is an event SOURCE attached to `document` or `window`, and every one of them outlives any render.
 * Putting the current state in a `useState` would mean the watchdog re-subscribes on every state change, and the
 * subscription itself would drop events during the re-render -- which is exactly when a student is moving fast. So each
 * guard is a plain class with `attach()`/`detach()`, and React subscribes once.
 *
 * ## AND WHY NOTHING HERE BLOCKS OR ENFORCES
 *
 * A guard DETECTS and REPORTS. Escalation is the engine's decision (`evaluateEscalation`), and the counts these produce
 * feed it. A guard that terminated an attempt would be a client-side sanction, and `plans/09` is explicit that
 * `TERMINATE` is never automatic.
 */

/** The evidence kinds the guards emit. Names match `plans/09` §6's table. */
export type EvidenceKind =
  | 'FULLSCREEN_ENTERED'
  | 'FULLSCREEN_EXITED'
  | 'FULLSCREEN_DENIED'
  | 'POINTERLOCK_ENTERED'
  | 'POINTERLOCK_LOST'
  | 'WINDOW_BLURRED'
  | 'WINDOW_FOCUSED'
  | 'TAB_HIDDEN'
  | 'TAB_VISIBLE'
  | 'NETWORK_LOST'
  | 'NETWORK_RESTORED'
  | 'MULTI_TAB_DETECTED'
  | 'CLOCK_SKEW_DETECTED';

export interface Evidence {
  readonly kind: EvidenceKind;
  /** From the INJECTED clock. Never `Date.now()` -- INV-TIME-1, and it is what makes grace testable. */
  readonly at: number;
  /** Free-form context. Never a score, never an answer: this is written to a log a teacher reads. */
  readonly detail?: Readonly<Record<string, string | number | boolean>>;
}

/**
 * WHERE EVIDENCE GOES.
 *
 * Injected because a watchdog that imports its own transport cannot be tested without one, and because P8-T7's batched
 * writer owns batching -- a guard that buffered its own events would duplicate that and produce two orderings.
 */
export type EvidenceSink = (evidence: Evidence) => void;

/** The DOM surface a guard touches, injected so a test can drive events without a browser. */
export interface WatchdogHost {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

/**
 * THE BASE, holding what every guard shares.
 *
 * Detached guards are inert by construction: `emit` refuses when `detached`, so a guard torn down mid-exam cannot
 * still be writing evidence, and a leaked subscription shows up as a test that fails rather than as a slow leak nobody
 * notices.
 */
export abstract class Watchdog {
  readonly clock: { now(): number };
  protected readonly sink: EvidenceSink;
  protected readonly host: WatchdogHost;
  private attached = false;

  constructor(clock: { now(): number }, sink: EvidenceSink, host: WatchdogHost) {
    this.clock = clock;
    this.sink = sink;
    this.host = host;
  }

  get isAttached(): boolean {
    return this.attached;
  }

  attach(): void {
    if (this.attached) return;
    this.attached = true;
    this.subscribe();
  }

  detach(): void {
    if (!this.attached) return;
    this.unsubscribe();
    this.attached = false;
  }

  protected abstract subscribe(): void;
  protected abstract unsubscribe(): void;

  protected emit(kind: EvidenceKind, detail?: Evidence['detail']): void {
    if (!this.attached) return;
    this.sink(
      detail === undefined
        ? { kind, at: this.clock.now() }
        : { kind, at: this.clock.now(), detail },
    );
  }
}

/** The minimum of `Element`/document a fullscreen guard reads. */
export interface FullscreenCapableHost extends WatchdogHost {
  readonly fullscreenElement?: Element | null;
  /** Present on `Document` in every browser that supports the Fullscreen API. */
  readonly fullscreenEnabled?: boolean;
}

/**
 * `fullscreenGuard` (P8-T4). Listens to `fullscreenchange`; reports ENTERED, EXITED and DENIED.
 *
 * ## DENIED IS DISTINCT FROM EXITED, AND THE DISTINCTION IS THE POINT
 *
 * A student whose browser refuses fullscreen -- an iframe, a managed device, a browser policy -- must not be told they
 * left it. `fullscreenchange` does not fire when a request is REFUSED, so the refusal has to be detected from the
 * rejection of `requestFullscreen()`. Conflating the two produces an integrity event against a student who never had
 * fullscreen in the first place, and the escalation ladder then acts on it.
 *
 * So `requestFullscreen`'s rejection is caught and reported as `FULLSCREEN_DENIED`, and no exit is counted.
 */
export class FullscreenGuard extends Watchdog {
  private requested = false;
  /** Set while a request is in flight, so a rejection can be attributed to a request rather than to a later exit. */
  private awaitingOutcome = false;
  /**
   * The base class stores `host` as the plain `WatchdogHost`, which is all the base needs -- but `fullscreenElement`
   * only exists on the narrowed type, so the fullscreen host is kept here too. Casting at the point of use would be
   * one unchecked cast per event; this is one field.
   */
  private readonly fullscreenHost: FullscreenCapableHost;

  constructor(clock: { now(): number }, sink: EvidenceSink, host: FullscreenCapableHost) {
    super(clock, sink, host);
    this.fullscreenHost = host;
  }

  protected subscribe(): void {
    this.host.addEventListener('fullscreenchange', this.onChange);
  }

  protected unsubscribe(): void {
    this.host.removeEventListener('fullscreenchange', this.onChange);
  }

  private readonly onChange = (): void => {
    const active = this.fullscreenHost.fullscreenElement != null;
    if (active) {
      this.awaitingOutcome = false;
      this.emit('FULLSCREEN_ENTERED');
    } else {
      // A rejection resolves without ever firing `fullscreenchange`, so this is a genuine exit and not a denial.
      this.awaitingOutcome = false;
      this.emit('FULLSCREEN_EXITED', { requested: this.requested });
    }
  };

  /**
   * ASK FOR FULLSCREEN, AND REPORT A REFUSAL AS A REFUSAL.
   *
   * Returns whether fullscreen was obtained rather than throwing, because a rejected request is an ordinary outcome on
   * a locked-down device and an unhandled rejection here would surface as an error the student cannot act on.
   */
  async request(): Promise<boolean> {
    const target = this.fullscreenHost as FullscreenCapableHost & {
      requestFullscreen?: () => Promise<void>;
    };
    if (target.requestFullscreen === undefined) {
      // No API at all is a refusal too, and the same reasoning applies: the student is not at fault.
      this.emit('FULLSCREEN_DENIED', { reason: 'unsupported' });
      return false;
    }

    this.requested = true;
    this.awaitingOutcome = true;
    try {
      await target.requestFullscreen();
      // Resolving without `fullscreenchange` means the browser accepted and we are already in fullscreen, or the event
      // is still queued. Either way nothing to report here.
      return true;
    } catch (error) {
      this.awaitingOutcome = false;
      this.emit('FULLSCREEN_DENIED', {
        reason: error instanceof Error ? error.name : 'rejected',
        // The policy is consulted by the escalation ladder; the guard only reports what happened.
        wasRequested: this.awaitingOutcome,
      });
      return false;
    }
  }

  /** True while a request is in flight and no outcome has arrived. Exposed for the recovery overlay's copy. */
  get isPending(): boolean {
    return this.awaitingOutcome;
  }
}

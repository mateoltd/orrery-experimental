'use client';

/**
 * `pointerLockGuard` (P8-T5).
 *
 * ## THE HONESTY PROBLEM, STATED BY `plans/09` §6.1
 *
 * `Escape` releases pointer lock, and browsers deliberately prevent intercepting it. **Any product claiming otherwise is
 * lying.** So this guard cannot count an `Escape`-initiated loss as a violation, cannot refuse to let `Escape` through,
 * and the copy that goes with it says pointer lock is a DETERRENT AND TRIPWIRE rather than a lock.
 *
 * ## WHY THAT FORCES A GRACE PERIOD
 *
 * The guard cannot tell an `Escape` release from any other release, because the browser will not say. So the only
 * honest implementation is to treat every loss as ambiguous and wait: a loss that is still not recovered after the
 * grace is a loss worth recording, and one recovered inside it was almost certainly the student pressing `Escape` to
 * get their cursor back.
 *
 * The grace is measured from the INJECTED clock. That is not a testing convenience -- a grace period read from
 * `Date.now()` cannot be exercised at all, and a grace period nobody can exercise is a grace period that is wrong in
 * production.
 */

import { type Evidence, type EvidenceSink, Watchdog, type WatchdogHost } from './watchdog';

/** `plans/09` §6's default: three seconds before a loss is counted. */
export const POINTER_LOCK_GRACE_MS = 3_000;

export class PointerLockGuard extends Watchdog {
  /** Set when a loss is observed and the clock starts. Null when there is no pending loss. */
  private lostAt: number | null = null;
  /** True once a loss has been counted, so one loss produces exactly one event however often it is checked. */
  private counted = false;
  private readonly graceMs: number;
  /** Whether the embedded simulation consumes `Escape` itself. Recorded, never blocked -- see §6.1. */
  private escapeBelongsToSimulation = false;

  constructor(
    clock: { now(): number },
    sink: EvidenceSink,
    host: WatchdogHost,
    graceMs: number = POINTER_LOCK_GRACE_MS,
  ) {
    super(clock, sink, host);
    this.graceMs = graceMs;
  }

  protected subscribe(): void {
    this.host.addEventListener('pointerlockchange', this.onChange);
    // A lock REQUEST can fail, which is not a loss and not an exit -- it is a refusal, and `plans/09` §6's table has no
    // event for it because nothing was lost. It is reported so the overlay can explain a cursor that never vanished.
    this.host.addEventListener('pointerlockerror', this.onLockError);
  }

  protected unsubscribe(): void {
    this.host.removeEventListener('pointerlockchange', this.onChange);
    this.host.removeEventListener('pointerlockerror', this.onLockError);
  }

  private readonly onChange = (): void => {
    const active = this.pointerLockActive();
    if (active) {
      this.recovered();
      return;
    }
    // A loss begins the grace. Nothing is emitted yet: this is the whole point.
    if (this.lostAt === null) {
      this.lostAt = this.clock.now();
      this.counted = false;
    }
  };

  private readonly onLockError = (): void => {
    // Reported as an ENTERED-never-happened rather than a loss, because nothing was lost.
    this.emit('POINTERLOCK_ENTERED', { outcome: 'refused' });
  };

  private pointerLockActive(): boolean {
    const host = this.host as WatchdogHost & { pointerLockElement?: Element | null };
    return host.pointerLockElement != null;
  }

  /** The pointer came back. Any pending loss is forgiven, because it was a trip rather than an absence. */
  recovered(): void {
    this.lostAt = null;
    this.counted = false;
  }

  /** Tell the guard whether `Escape` is meaningful to the embedded simulation, which it often is. */
  setEscapeConsumedBySimulation(consumed: boolean): void {
    this.escapeBelongsToSimulation = consumed;
  }

  get escapeIsSimulationKey(): boolean {
    return this.escapeBelongsToSimulation;
  }

  /**
   * COUNT A LOSS IF THE GRACE HAS EXPIRED.
   *
   * Called from the host's timer rather than from the event, because the decision needs a clock reading and the event
   * does not have one. Returns whether an event was emitted, so a caller can assert on it without inspecting the sink.
   */
  tick(): boolean {
    if (this.lostAt === null || this.counted) return false;
    if (this.clock.now() - this.lostAt < this.graceMs) return false;

    this.counted = true;
    const detail = {
      /** The instant the loss was observed, so a teacher can line it up against the attempt's own timeline. */
      lostAt: this.lostAt,
      /** How long it went uncounted, which is the grace the student actually got. */
      graceMs: this.graceMs,
      /**
       * WHETHER `Escape` WAS INVOLVED IS NOT KNOWABLE, and is reported as unknown rather than guessed.
       *
       * The browser will not say, so a guess here would put a fabricated fact in a teacher's timeline. `false` means
       * "not known to have been", which is the honest reading of an unobservable.
       */
      escapePossiblyInvolved: null as boolean | null,
      escapeBelongsToSimulation: this.escapeBelongsToSimulation,
    };
    this.emit('POINTERLOCK_LOST', detail);
    return true;
  }

  /** True while a loss is pending and the grace has not yet expired. The overlay's "waiting" state. */
  get isInGrace(): boolean {
    return this.lostAt !== null && !this.counted;
  }

  /** True once the loss has been counted, whether or not the pointer came back. */
  get hasCountedLoss(): boolean {
    return this.counted;
  }

  /**
   * THE COPY SAYS DETERRENT, NOT LOCK.
   *
   * A student told pointer lock cannot be escaped has been told something false, and they will find out. The sentence
   * is part of full disclosure before start (`plans/09` §7.4) and is stated here once so it cannot drift from the
   * behaviour: the guard does not intercept `Escape`, and this says so.
   */
  static readonly DISCLOSURE =
    'Pointer lock discourages leaving this page. You can always leave it, and pressing Escape releases it. ' +
    'Leaving is recorded so a teacher can review it.';
}

/** Narrow the emitted evidence for callers that only care about pointer lock. */
export const isPointerLockEvidence = (evidence: Evidence): boolean =>
  evidence.kind === 'POINTERLOCK_ENTERED' || evidence.kind === 'POINTERLOCK_LOST';

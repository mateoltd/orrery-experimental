'use client';

/**
 * `focusGuard` (P8-T6). Listens to `blur`, `focus` and `visibilitychange`.
 *
 * ## THE DOUBLE-COUNT, WHICH IS THE WHOLE REASON THIS GUARD IS NOT FOUR LINES
 *
 * Alt-tabbing fires BOTH `blur` AND `visibilitychange`. A guard that emits `WINDOW_BLURRED` on the first and
 * `TAB_HIDDEN` on the second records TWO integrity events for one alt-tab, so a student who looked away once has
 * spent two of their twelve `tabHides`. At twelve allowed, that is six alt-tabs looking like twelve.
 *
 * So the two are correlated rather than counted twice: one focus LOSS is one loss, whichever events reported it, and the
 * two kinds are told apart by `document.visibilityState` at the moment of the event. `visibilityState === 'hidden'` means
 * the tab was hidden -- that is a tab hide. Otherwise the window merely lost focus, which is what a click on another
 * window or on the OS taskbar looks like.
 *
 * The count that matters for escalation is the one `thresholds.tabHides` is compared against, so it is the hidden case
 * that increments it. A blur without a hide is still recorded -- a student looking at another window is still looking at
 * another window -- but it is a different counter, and conflating them is what makes the threshold meaningless.
 */

import { type EvidenceSink, Watchdog, type WatchdogHost } from './watchdog';

export class FocusGuard extends Watchdog {
  /** When the outstanding departure began, from the INJECTED clock. */
  private lostAt: number | null = null;
  private lostFocusWasHide = false;
  /** True between a loss and its matching regain, so one departure is one pair of events. */
  private outstanding = false;

  constructor(clock: { now(): number }, sink: EvidenceSink, host: WatchdogHost) {
    super(clock, sink, host);
  }

  protected subscribe(): void {
    this.host.addEventListener('blur', this.onBlur);
    this.host.addEventListener('focus', this.onFocus);
    this.host.addEventListener('visibilitychange', this.onVisibilityChange);
  }

  protected unsubscribe(): void {
    this.host.removeEventListener('blur', this.onBlur);
    this.host.removeEventListener('focus', this.onFocus);
    this.host.removeEventListener('visibilitychange', this.onVisibilityChange);
  }

  /** Read through a getter so a test can supply `hidden` without a `document`. */
  private get visibility(): 'visible' | 'hidden' {
    const host = this.host as WatchdogHost & {
      visibilityState?: 'visible' | 'hidden';
    };
    return host.visibilityState ?? 'visible';
  }

  private readonly onBlur = (): void => {
    this.noteLoss(this.visibility === 'hidden');
  };

  private readonly onVisibilityChange = (): void => {
    if (this.visibility === 'hidden') {
      this.noteLoss(true);
      return;
    }
    this.noteRegain();
  };

  private readonly onFocus = (): void => {
    this.noteRegain();
  };

  /**
   * ONE DEPARTURE, ONE EVENT.
   *
   * `outstanding` is the whole mechanism: the second of the blur/hide pair arrives while a loss is already outstanding,
   * so it is folded in rather than emitted. Without it, one alt-tab is two events and `tabHides` is worth half what the
   * policy says it is worth.
   */
  private noteLoss(wasHide: boolean): void {
    if (this.outstanding) {
      // The pair. Upgrade to a hide if either signal said so, because the stricter reading is the accurate one.
      this.lostFocusWasHide = this.lostFocusWasHide || wasHide;
      return;
    }
    this.outstanding = true;
    this.lostAt = this.clock.now();
    this.lostFocusWasHide = wasHide;
    this.emit(wasHide ? 'TAB_HIDDEN' : 'WINDOW_BLURRED', {
      // A hide is what consumes `thresholds.tabHides`; a plain blur is recorded against nothing, and saying so here
      // is what keeps the two counters from being quietly merged by whoever reads the log.
      countsAgainstTabHides: wasHide,
    });
  }

  private noteRegain(): void {
    if (!this.outstanding) return;
    // The duration is read BEFORE the instant is cleared. Nulling first and then reading reports an `awayForMs` of
    // zero for every single departure, which is a field nobody would notice being wrong.
    const awayForMs = this.clock.now() - (this.lostAt ?? this.clock.now());
    this.outstanding = false;
    this.lostAt = null;
    this.emit(this.lostFocusWasHide ? 'TAB_VISIBLE' : 'WINDOW_FOCUSED', { awayForMs });
  }

  /** True between a departure and the matching return. The overlay's copy uses this. */
  get isAway(): boolean {
    return this.outstanding;
  }
}

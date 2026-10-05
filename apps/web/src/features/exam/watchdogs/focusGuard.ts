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
 * So the two are correlated rather than counted twice: one DEPARTURE is one loss and one return, whichever events
 * reported it and in whatever order.
 *
 * ## A HIDE IS A TRANSITION THE GUARD OBSERVED, NOT A VALUE IT HAPPENED TO READ
 *
 * The first version asked `visibilityState` inside each handler and believed the answer, which made three different
 * mistakes out of one habit (`ADV-W1`..`ADV-W3`): a `focus` in a tab that was still hidden closed the departure, the
 * `blur` after it opened a second one, and that second one read `hidden` and charged `tabHides` again -- one hide,
 * two charges. Reading a value says what is true now. It does not say that anything HAPPENED.
 *
 * So the guard remembers the visibility it last saw, and a hide is the moment that changes. `thresholds.tabHides` is
 * charged there and nowhere else, which is what makes "never charged more often than the tab was hidden" a property
 * of the structure rather than of the event order.
 *
 * ## WHAT THIS CANNOT SEE, STATED RATHER THAN DISCOVERED
 *
 * A `blur` that arrives BEFORE the hide is reported at once as `WINDOW_BLURRED`, because nothing yet says otherwise
 * and a loss held back for a second signal is a loss never recorded when the second signal does not come. The hide
 * that follows is folded into it. So that departure is a `WINDOW_BLURRED`/`WINDOW_FOCUSED` pair which charges nothing
 * against `tabHides`, and its return says `tabWasHidden: true` so the timeline still holds the fact.
 */

import { type EvidenceKind, type EvidenceSink, Watchdog, type WatchdogHost } from './watchdog';

/**
 * WHAT THE GUARD ASKS ITS HOST, AND BOTH ARE REQUIRED.
 *
 * They were read through a cast and defaulted when missing -- `visibilityState ?? 'visible'` -- so a host that could
 * not answer was a host that always answered "visible, and focus has left", which is the accusing reading. Required
 * members make that a compile error at the one place a guard is constructed: `window` alone has neither.
 */
export interface FocusHost extends WatchdogHost {
  readonly visibilityState: 'visible' | 'hidden';
  /** `document.hasFocus()`: true while focus is anywhere inside this document, INCLUDING a frame it contains. */
  hasFocus(): boolean;
}

type Departure = 'TAB_HIDDEN' | 'WINDOW_BLURRED';

/**
 * THE RETURN THAT CLOSES EACH DEPARTURE. (`ADV-W2`)
 *
 * The return's kind used to be chosen from a flag the SECOND signal of a pair could flip, so `blur` then
 * `visibilitychange` produced `WINDOW_BLURRED` followed by `TAB_VISIBLE`: a blur that never refocused, and a tab that
 * became visible without ever being hidden. Anything pairing events to compute time away saw a student who left and
 * did not come back.
 *
 * Now the return is looked up from the kind that was actually EMITTED, and there is no other way to produce one.
 */
const RETURN_OF = {
  TAB_HIDDEN: 'TAB_VISIBLE',
  WINDOW_BLURRED: 'WINDOW_FOCUSED',
} as const satisfies Record<Departure, EvidenceKind>;

export class FocusGuard extends Watchdog {
  /** Kept narrowed, as `FullscreenGuard` keeps its own: the base stores the plain `WatchdogHost`. */
  private readonly focusHost: FocusHost;
  /**
   * The departure nobody has returned from yet, AS IT WAS REPORTED, or `null` while the student is here. One field
   * rather than three: `kind` and `since` cannot disagree about which departure they describe.
   */
  private away: { readonly kind: Departure; readonly since: number; tabWasHidden: boolean } | null =
    null;
  /** The visibility last OBSERVED. A hide is this changing, never this being read. */
  private lastVisibility: 'visible' | 'hidden' = 'visible';

  constructor(clock: { now(): number }, sink: EvidenceSink, host: FocusHost) {
    super(clock, sink, host);
    this.focusHost = host;
  }

  protected subscribe(): void {
    // A watch starts from what is true NOW. A guard attached to a tab that is already hidden has not seen it hide,
    // and one re-attached after a pause must not report a return from a departure it stopped watching.
    this.away = null;
    this.lastVisibility = this.visibility;
    this.host.addEventListener('blur', this.onBlur);
    this.host.addEventListener('focus', this.onFocus);
    this.host.addEventListener('visibilitychange', this.onVisibilityChange);
  }

  protected unsubscribe(): void {
    this.host.removeEventListener('blur', this.onBlur);
    this.host.removeEventListener('focus', this.onFocus);
    this.host.removeEventListener('visibilitychange', this.onVisibilityChange);
  }

  /** Anything that is not `hidden` is visible: the legacy states are ways of being on screen, or about to be. */
  private get visibility(): 'visible' | 'hidden' {
    return this.focusHost.visibilityState === 'hidden' ? 'hidden' : 'visible';
  }

  /**
   * EVERY HANDLER LOOKS FIRST, because the browser does not promise which event brings the news.
   *
   * `visibilityState` may already have flipped when `blur` fires, or may flip a moment after. Looking on every
   * signal means the hide is noticed by whichever arrives first and is not a change at all by the time the other does.
   */
  private observeVisibility(): void {
    const seen = this.visibility;
    if (seen === this.lastVisibility) return;
    this.lastVisibility = seen;
    if (seen === 'hidden') this.depart('TAB_HIDDEN');
    else this.comeBack();
  }

  private readonly onVisibilityChange = (): void => {
    this.observeVisibility();
  };

  private readonly onBlur = (): void => {
    this.observeVisibility();
    // Hidden already: the hide IS the departure, and the blur beside it is the same one.
    if (this.lastVisibility === 'hidden') return;
    /**
     * `ADV-W1`: FOCUS MOVING INTO THE EXAM'S OWN IFRAME IS NOT LEAVING THE EXAM.
     *
     * Every simulation question is a sandboxed frame. Clicking into one fires `blur` on this window while
     * `document.hasFocus()` stays true, because focus is still inside the document. The guard did not ask, so a
     * student using the simulation they had been told to use was recorded as `WINDOW_BLURRED` on every click --
     * dozens against `focusLosses: 25`, from the platform's own content. `plans/09` §7.1's "never penalises the
     * student for our bug", in a place its table cannot reach.
     *
     * Modelled on the documented behaviour and NOT yet observed in a browser by this codebase.
     */
    if (this.focusHost.hasFocus()) return;
    this.depart('WINDOW_BLURRED');
  };

  private readonly onFocus = (): void => {
    this.observeVisibility();
    // `ADV-W3`: a `focus` in a tab nobody can see is not a return. Treating it as one closed the departure early,
    // and the next `blur` then opened -- and charged -- a second departure for the same hide.
    if (this.lastVisibility === 'hidden') return;
    this.comeBack();
  };

  /**
   * ONE DEPARTURE, ONE EVENT.
   *
   * `away` is the whole mechanism: the second of the blur/hide pair arrives while a departure is already outstanding,
   * so it is folded in rather than emitted. Without it, one alt-tab is two events and `tabHides` is worth half what
   * the policy says it is worth.
   */
  private depart(kind: Departure): void {
    if (this.away !== null) {
      // The pair. What was reported stays reported; that the tab was also hidden is kept for the return to say.
      if (kind === 'TAB_HIDDEN') this.away.tabWasHidden = true;
      return;
    }
    this.away = { kind, since: this.clock.now(), tabWasHidden: kind === 'TAB_HIDDEN' };
    this.emit(kind, {
      // A hide is what consumes `thresholds.tabHides`; a plain blur is recorded against nothing, and saying so here
      // is what keeps the two counters from being quietly merged by whoever reads the log.
      countsAgainstTabHides: kind === 'TAB_HIDDEN',
    });
  }

  private comeBack(): void {
    // Taken into a local BEFORE the field is cleared. Nulling first and then reading reported an `awayForMs` of
    // zero for every single departure, which is a field nobody would notice being wrong.
    const away = this.away;
    if (away === null) return;
    this.away = null;
    this.emit(RETURN_OF[away.kind], {
      awayForMs: this.clock.now() - away.since,
      tabWasHidden: away.tabWasHidden,
    });
  }

  /** True between a departure and the matching return. The overlay's copy uses this. */
  get isAway(): boolean {
    return this.away !== null;
  }
}

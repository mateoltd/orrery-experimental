// @vitest-environment jsdom

/**
 * ADVERSARIAL: tab switch.  (P8-T15, `plans/09` §6 `focusGuard`, `RN-02`)
 *
 * ## THE ATTACKER HERE IS THE BROWSER, AND THE VICTIM IS THE STUDENT
 *
 * Nobody forges a `blur`. What goes wrong with a focus guard is that ONE thing the student did arrives as SEVERAL
 * events, in an order the guard did not expect, and each is counted. `thresholds.tabHides` is twelve in the EXAM
 * profile; a guard that counts an alt-tab twice makes it six, and one that counts a click as a departure makes it
 * whatever the paper's layout happens to produce.
 *
 * `guards.test.ts` pins the `blur`+`visibilitychange` pair in one order. The orders are the problem: which of the two
 * fires first, and whether `visibilityState` has already flipped when it does, differs by browser and by what the
 * student actually did (switched tab, switched window, minimised, locked the screen). So the first test here drives
 * every ordering of every departure and return a browser is known to produce, and asserts the count.
 *
 * ## WHAT IS MODELLED AND WHAT IS OBSERVED
 *
 * These run in jsdom against an injected host, which is how the guards are designed to be tested -- and it means the
 * event ORDERINGS are a model of browser behaviour, not a recording of it. Where a test depends on a specific claim
 * about a real browser (`ADV-W1`), the claim is stated and is checkable in a real one. P8-T15 did not check it in one.
 *
 * ## THE `it.fails` TESTS ARE DEFECTS IN `focusGuard.ts`, WHICH THIS LANE MAY NOT EDIT
 *
 * Green today because the assertion fails; red when the defect is fixed, and then the `.fails` comes off.
 */

import { FrozenClock } from '@orrery/clock';
import { routeWatchdogEvent } from '@orrery/exam-engine/accommodations';
import { EVIDENCE_RULES } from '@orrery/exam-engine/evidence';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { FocusGuard } from './focusGuard';
import type { Evidence } from './watchdog';

const T0 = 1_800_000_000_000;
const RUNS = 300;

class Host {
  private readonly listeners = new Map<string, (() => void)[]>();
  visibilityState: 'visible' | 'hidden' = 'visible';
  /** What `document.hasFocus()` would say. Only read by a guard that asks; see `ADV-W1`. */
  focusIsInsideTheDocument = false;

  addEventListener(type: string, listener: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  removeEventListener(type: string, listener: () => void): void {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((entry) => entry !== listener),
    );
  }
  hasFocus(): boolean {
    return this.focusIsInsideTheDocument;
  }
  fire(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
}

const setup = () => {
  const clock = new FrozenClock(T0);
  const host = new Host();
  const seen: Evidence[] = [];
  const guard = new FocusGuard(
    clock,
    (evidence) => {
      seen.push(evidence);
    },
    host,
  );
  guard.attach();
  return { clock, host, seen, guard };
};

const isLoss = (evidence: Evidence): boolean =>
  evidence.kind === 'TAB_HIDDEN' || evidence.kind === 'WINDOW_BLURRED';
const isReturn = (evidence: Evidence): boolean =>
  evidence.kind === 'TAB_VISIBLE' || evidence.kind === 'WINDOW_FOCUSED';

/** One signal a browser sends. `hide`/`show` flip `visibilityState` and THEN fire, as a browser does. */
type Signal = 'blur' | 'focus' | 'hide' | 'show';

const send = (host: Host, signal: Signal): void => {
  if (signal === 'hide') {
    host.visibilityState = 'hidden';
    host.fire('visibilitychange');
  } else if (signal === 'show') {
    host.visibilityState = 'visible';
    host.fire('visibilitychange');
  } else {
    host.fire(signal);
  }
};

/**
 * EVERY WAY ONE DEPARTURE ARRIVES, AND EVERY WAY ONE RETURN DOES.
 *
 * Switching to another WINDOW blurs without hiding. Switching TAB, minimising or locking the screen hides, and also
 * blurs -- before or after, depending on the browser. Returning mirrors it.
 */
const departures: readonly (readonly Signal[])[] = [
  ['blur'],
  ['blur', 'hide'],
  ['hide', 'blur'],
  ['hide'],
];
const returnsFor = (departure: readonly Signal[]): readonly (readonly Signal[])[] =>
  departure.includes('hide') ? [['show', 'focus'], ['focus', 'show'], ['show']] : [['focus']];

const tripArb = fc.constantFrom(...departures).chain((departure) =>
  fc.record({
    departure: fc.constant(departure),
    comeBack: fc.constantFrom(...returnsFor(departure)),
    awayMs: fc.integer({ min: 1, max: 600_000 }),
  }),
);

describe('one departure is counted once, whatever order the browser reports it in', () => {
  it('emits exactly one loss and one return per trip away, for every ordering of the signals', () => {
    /**
     * What breaks without `outstanding`: the second signal of a pair is a second event, and a student who looked away
     * six times has used all twelve of their `tabHides`.
     *
     * The count is asserted against the number of TRIPS, which is the thing the student did and the only number a
     * threshold can fairly be compared with.
     */
    fc.assert(
      fc.property(fc.array(tripArb, { minLength: 1, maxLength: 12 }), (trips) => {
        const { clock, host, seen } = setup();
        for (const trip of trips) {
          for (const signal of trip.departure) send(host, signal);
          clock.advance(trip.awayMs);
          for (const signal of trip.comeBack) send(host, signal);
          clock.advance(1_000);
        }

        expect(seen.filter(isLoss)).toHaveLength(trips.length);
        expect(seen.filter(isReturn)).toHaveLength(trips.length);
        // Strictly alternating, starting with a loss: never two departures without a return between them.
        seen.forEach((evidence, index) => {
          expect(isLoss(evidence)).toBe(index % 2 === 0);
        });
        // And never more against `tabHides` than there were trips that hid the tab.
        const hides = trips.filter((trip) => trip.departure.includes('hide')).length;
        const charged = seen.filter((e) => e.detail?.countsAgainstTabHides === true).length;
        expect(charged).toBeLessThanOrEqual(hides);
      }),
      { numRuns: RUNS },
    );
  });

  it('reports how long each trip lasted, from the injected clock and not from a second read', () => {
    fc.assert(
      fc.property(fc.array(tripArb, { minLength: 1, maxLength: 6 }), (trips) => {
        const { clock, host, seen } = setup();
        for (const trip of trips) {
          for (const signal of trip.departure) send(host, signal);
          clock.advance(trip.awayMs);
          for (const signal of trip.comeBack) send(host, signal);
        }
        expect(seen.filter(isReturn).map((e) => e.detail?.awayForMs)).toEqual(
          trips.map((trip) => trip.awayMs),
        );
      }),
      { numRuns: RUNS },
    );
  });

  it('never charges `tabHides` while the tab stays visible, however often focus leaves the window', () => {
    /**
     * `RN-02`, concretely. An on-screen keyboard, a dictation overlay, a screen magnifier's control panel, a switch-
     * access scanner: assistive technology that takes WINDOW focus without hiding anything, and takes it constantly.
     * Those are `WINDOW_BLURRED`, and the allowance a student has for leaving the tab must not be spent by them.
     */
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 200 }), (times) => {
        const { host, seen } = setup();
        for (let n = 0; n < times; n += 1) {
          send(host, 'blur');
          send(host, 'focus');
        }
        expect(seen.filter((e) => e.kind === 'TAB_HIDDEN')).toEqual([]);
        expect(seen.filter((e) => e.detail?.countsAgainstTabHides === true)).toEqual([]);
        expect(seen.filter((e) => e.kind === 'WINDOW_BLURRED')).toHaveLength(times);
      }),
      { numRuns: 50 },
    );
  });

  it('lets a student with a focus accommodation produce those events with no strike and no warning', () => {
    // The two halves joined: the guard still REPORTS (a quiet timeline has to be able to say why), and
    // `INV-ACC-1`'s routing turns every one into `INFO` with no strike. The kind-to-watchdog pairing is this test's
    // own -- nothing in the codebase maps one to the other yet -- and it is the only reading of the two names.
    const { host, seen } = setup();
    for (let n = 0; n < 40; n += 1) {
      send(host, 'blur');
      send(host, 'focus');
    }
    const routed = seen
      .filter((e) => e.kind === 'WINDOW_BLURRED')
      .map((e) =>
        routeWatchdogEvent({
          watchdog: 'FOCUS',
          severity: EVIDENCE_RULES[e.kind].severity,
          relaxations: ['DISABLE_FOCUS_NAG'],
        }),
      );

    expect(routed).toHaveLength(40);
    expect(routed.every((event) => event.recorded)).toBe(true);
    expect(routed.filter((event) => event.countsAsStrike)).toEqual([]);
    expect(new Set(routed.map((event) => event.severity))).toEqual(new Set(['INFO']));
  });

  it('says nothing once detached, so a guard torn down at submit cannot log the student closing the tab', () => {
    const { host, seen, guard } = setup();
    guard.detach();
    for (const signal of ['blur', 'hide', 'show', 'focus'] as const) send(host, signal);
    expect(seen).toEqual([]);
  });
});

describe('known defects in `focusGuard.ts`', () => {
  /**
   * `ADV-W1` -- KNOWN DEFECT, and the one most likely to matter in production. **Modelled, not observed in a
   * browser.**
   *
   * The claim about browsers: when focus moves from a page INTO an `<iframe>` on that page, the page's `window`
   * fires `blur`, and `document.hasFocus()` stays `true`, because focus is still inside the document tree. (It is the
   * standard technique for detecting a click in a cross-origin frame.)
   *
   * Every simulation question is a sandboxed iframe. So a student who clicks into the simulation they have been asked
   * to use fires `blur` on the exam window, and the guard -- which reads only `visibilityState` -- records
   * `WINDOW_BLURRED`. Clicking back out is the "return". A paper with ten simulation items generates dozens of focus
   * losses from a student who never left it, against `focusLosses: 25` in the EXAM profile: the platform's own
   * content manufacturing the evidence, which is `plans/09` §7.1's "never penalises the student for our bug" in a
   * place the table cannot reach.
   *
   * The host here answers `hasFocus()` the way a document does. The guard does not ask.
   */
  it('ADV-W1: does not count focus moving into the exam’s own iframe as leaving the exam', () => {
    const { host, seen } = setup();
    host.focusIsInsideTheDocument = true;
    send(host, 'blur');
    expect(seen).toEqual([]);
  });

  /**
   * `ADV-W2` -- KNOWN DEFECT. The pair is folded into one event, and the event that is emitted is whichever signal
   * came FIRST.
   *
   * `blur` then `visibilitychange`: the guard emits `WINDOW_BLURRED`, learns a moment later that the tab was hidden,
   * records that internally -- and then reports the return as `TAB_VISIBLE`. The timeline reads `WINDOW_BLURRED`,
   * `TAB_VISIBLE`: a blur that never refocused and a tab that became visible without ever being hidden. Anything that
   * pairs events to compute time away sees a student who left and did not come back.
   *
   * `guards.test.ts` has a test named "upgrades a blur to a hide when the second signal says so" which asserts the
   * opposite of its name (the first event stays `WINDOW_BLURRED`, zero `TAB_HIDDEN`).
   */
  it('ADV-W2: reports a return of the same kind as the departure it closes', () => {
    const { host, seen } = setup();
    send(host, 'blur');
    send(host, 'hide');
    send(host, 'show');
    send(host, 'focus');

    const pairs: Record<string, string> = {
      TAB_HIDDEN: 'TAB_VISIBLE',
      WINDOW_BLURRED: 'WINDOW_FOCUSED',
    };
    expect(seen).toHaveLength(2);
    expect(seen[1]?.kind).toBe(pairs[seen[0]?.kind ?? '']);
  });

  /**
   * `ADV-W3` -- KNOWN DEFECT, low severity, and the ordering is SYNTHETIC: found by letting the signals arrive in any
   * order at all, not by observing a browser do it.
   *
   * A `focus` while the tab is still hidden is treated as a return. A `blur` after it is then a NEW departure, read as
   * a hide because the tab is (still) hidden -- so one hide is charged to `tabHides` twice. The guard never checks
   * that a "return" happened in a tab anyone could see.
   */
  it('ADV-W3: charges `tabHides` no more often than the tab was actually hidden', () => {
    const signalArb = fc.constantFrom<Signal>('blur', 'focus', 'hide', 'show');
    fc.assert(
      fc.property(fc.array(signalArb, { maxLength: 30 }), (signals) => {
        const { host, seen } = setup();
        let hiddenTransitions = 0;
        for (const signal of signals) {
          if (signal === 'hide' && host.visibilityState === 'visible') hiddenTransitions += 1;
          send(host, signal);
        }
        const charged = seen.filter((e) => e.detail?.countsAgainstTabHides === true).length;
        expect(charged).toBeLessThanOrEqual(hiddenTransitions);
      }),
      { numRuns: RUNS },
    );
  });
});

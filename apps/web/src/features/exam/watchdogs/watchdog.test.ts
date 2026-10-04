// @vitest-environment jsdom

/**
 * The watchdogs and the recovery overlay.  (P8-T4)
 *
 * Two requirements are structural rather than editorial, and both are invisible in a code review:
 *
 *  · **the overlay is never a dead end** -- an integrity modal with a disabled button blocks the exam, and a student on
 *    a locked-down school device or in an iframe cannot leave it;
 *  · **a refusal is not an exit** -- a browser that denies fullscreen must not produce an integrity event against a
 *    student who never had it, or the escalation ladder acts on a false report.
 *
 * Both are properties over combinations of state, so both are asserted as properties here rather than by reading the
 * branches.
 */

import { FrozenClock } from '@orrery/clock';
import { describe, expect, it, vi } from 'vitest';

import { evidenceFor, type OverlayState, overlayCopy } from './recoveryOverlay';
import { type Evidence, FullscreenGuard } from './watchdog';

const T0 = 1_800_000_000_000;

/** A host a test can drive by hand, so no browser is involved and events are never missed. */
class FakeHost {
  readonly listeners = new Map<string, (() => void)[]>();
  fullscreenElement: Element | null = null;
  requestFullscreen?: () => Promise<void>;

  addEventListener(type: string, listener: () => void): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((entry) => entry !== listener),
    );
  }

  fire(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }

  get count(): number {
    return (this.listeners.get('fullscreenchange') ?? []).length;
  }
}

const harness = () => {
  const clock = new FrozenClock(T0);
  const host = new FakeHost();
  const seen: Evidence[] = [];
  const sink = vi.fn((evidence: Evidence) => {
    seen.push(evidence);
  });
  const guard = new FullscreenGuard(clock, sink, host);
  return { clock, host, seen, sink, guard };
};

describe('FullscreenGuard', () => {
  it('subscribes once and unsubscribes once', () => {
    const { host, guard } = harness();
    guard.attach();
    guard.attach();
    expect(host.count).toBe(1);
    guard.detach();
    expect(host.count).toBe(0);
    // Attaching twice must not double-count every event, which is the bug a re-render would introduce.
    guard.attach();
    expect(host.count).toBe(1);
  });

  it('reports ENTERED when fullscreen is gained', () => {
    const { host, seen, guard } = harness();
    guard.attach();
    host.fullscreenElement = {} as Element;
    host.fire('fullscreenchange');
    expect(seen.map((entry) => entry.kind)).toEqual(['FULLSCREEN_ENTERED']);
  });

  it('reports EXITED when fullscreen is lost', () => {
    const { host, seen, guard } = harness();
    guard.attach();
    host.fire('fullscreenchange');
    expect(seen.map((entry) => entry.kind)).toEqual(['FULLSCREEN_EXITED']);
  });

  it('reports a REFUSAL as DENIED and not as an exit', () => {
    /**
     * The distinction is the point. `fullscreenchange` never fires when a request is refused, so a refusal is only
     * visible from the rejection of `requestFullscreen()`. Reporting it as an exit would record an integrity event
     * against a student who never had fullscreen, and the ladder would act on it.
     */
    const { host, seen, guard } = harness();
    // Browsers reject with a `DOMException`, so the NAME is what identifies the failure. `new Error('NotAllowedError')`
    // has `name === 'Error'`, and asserting on the message would have passed for the wrong reason.
    const denied = Object.assign(new Error('fullscreen denied'), { name: 'NotAllowedError' });
    host.requestFullscreen = () => Promise.reject(denied);
    guard.attach();
    return guard.request().then((granted) => {
      expect(granted).toBe(false);
      expect(seen.map((entry) => entry.kind)).toEqual(['FULLSCREEN_DENIED']);
      expect(seen[0]?.detail?.reason).toBe('NotAllowedError');
    });
  });

  it('reports DENIED when the API is absent, for the same reason', () => {
    // A browser without the Fullscreen API has not let the student out of anything.
    const { seen, guard } = harness();
    guard.attach();
    return guard.request().then((granted) => {
      expect(granted).toBe(false);
      expect(seen[0]?.kind).toBe('FULLSCREEN_DENIED');
      expect(seen[0]?.detail?.reason).toBe('unsupported');
    });
  });

  it('does not throw on a refusal, because a locked-down device is an ordinary case', () => {
    const { host, guard } = harness();
    host.requestFullscreen = () => Promise.reject(new Error('NotAllowedError'));
    guard.attach();
    return expect(guard.request()).resolves.toBe(false);
  });

  it('stamps evidence from the INJECTED clock', () => {
    // INV-TIME-1, and it is the only reason a grace period in any of these guards is testable at all.
    const { clock, host, seen, guard } = harness();
    guard.attach();
    clock.advance(1_234);
    host.fire('fullscreenchange');
    expect(seen[0]?.at).toBe(T0 + 1_234);
  });

  it('emits NOTHING while detached, so a torn-down guard cannot keep writing evidence', () => {
    const { host, sink, guard } = harness();
    guard.attach();
    guard.detach();
    host.fire('fullscreenchange');
    expect(sink).not.toHaveBeenCalled();
  });
});

describe('the recovery overlay is never a dead end', () => {
  const base = (over: Partial<OverlayState> = {}): OverlayState => ({
    reason: 'FULLSCREEN_LOST',
    isDenial: false,
    count: 1,
    isOutOfTime: false,
    isRequestPending: false,
    canSave: true,
    ...over,
  });

  it('always offers at least one action that is not "try again", for EVERY state', () => {
    /**
     * The property. An integrity modal with nothing but a retry leaves a student who cannot retry stuck behind a
     * dialog, so the test walks the combinations rather than trusting the branches.
     */
    const reasons: OverlayState['reason'][] = [
      'FULLSCREEN_LOST',
      'FULLSCREEN_DENIED',
      'POINTER_LOCK_LOST',
      'WINDOW_BLURRED',
      'TAB_HIDDEN',
      'MULTI_TAB',
      'NETWORK_LOST',
    ];
    for (const reason of reasons) {
      for (const isDenial of [false, true]) {
        for (const isRequestPending of [false, true]) {
          for (const canSave of [false, true]) {
            for (const isOutOfTime of [false, true]) {
              const copy = overlayCopy(
                base({ reason, isDenial, isRequestPending, canSave, isOutOfTime }),
              );
              const label = `${reason}/${isDenial}/${isRequestPending}/${canSave}/${isOutOfTime}`;
              expect(copy.actions.length, label).toBeGreaterThan(0);
              expect(copy.hasWayForward, label).toBe(true);
              expect(
                copy.actions.some((a) => a.action !== 'REQUEST_FULLSCREEN'),
                label,
              ).toBe(true);
            }
          }
        }
      }
    }
  });

  it('offers to carry on when fullscreen was REFUSED, because there is nothing to return to', () => {
    const copy = overlayCopy(base({ reason: 'FULLSCREEN_DENIED', isDenial: true }));
    expect(copy.actions.map((a) => a.action)).toEqual(['CONTINUE_UNLOCKED']);
    // And it does not offer a retry it knows will fail.
    expect(copy.actions.some((a) => a.action === 'REQUEST_FULLSCREEN')).toBe(false);
  });

  it('says the browser refused, rather than telling the student to do something impossible', () => {
    const copy = overlayCopy(base({ reason: 'FULLSCREEN_DENIED', isDenial: true }));
    expect(copy.title).toContain('not available');
    expect(copy.body).toContain('will not allow fullscreen');
    // The student is not at fault and must be told so, or they will believe they have already lost marks.
    expect(copy.body).toContain('nothing is withheld');
  });

  it('suppresses the retry while a request is PENDING, since a second request will also be refused', () => {
    const copy = overlayCopy(base({ isRequestPending: true }));
    expect(copy.actions.some((a) => a.action === 'REQUEST_FULLSCREEN')).toBe(false);
    expect(copy.hasWayForward).toBe(true);
  });

  it('offers a retry when one could actually work', () => {
    const copy = overlayCopy(base());
    expect(copy.primary.action).toBe('REQUEST_FULLSCREEN');
    expect(copy.primary.label).toBe('Return to fullscreen');
  });

  it('NEVER accuses the student, on the first occurrence or the tenth', () => {
    for (const count of [1, 2, 50]) {
      for (const reason of [
        'FULLSCREEN_LOST',
        'WINDOW_BLURRED',
        'TAB_HIDDEN',
        'POINTER_LOCK_LOST',
      ] as const) {
        const copy = overlayCopy(base({ reason, count }));
        const text = `${copy.title} ${copy.body}`.toLowerCase();
        // The escalation ladder is what acts on a pattern; the overlay is not that. Being told you have been
        // "flagged" on your first alt-tab is being told something false, and the ladder acts on the false report.
        expect(text, `${reason}/${count}`).not.toMatch(
          /cheat|violat|flagged|misconduct|penal|warned/,
        );
      }
    }
  });

  it('differs between the first occurrence and a later one ONLY by saying it is recorded', () => {
    /**
     * "This has happened again, and it is recorded" is true and useful. "You have been flagged" would be neither, and
     * the ladder is what acts on a pattern -- so the only permitted difference is the word "recorded".
     */
    const first = overlayCopy(base({ count: 1 })).body;
    const later = overlayCopy(base({ count: 7 })).body;
    expect(later).not.toBe(first);
    expect(later).toContain('recorded');
    for (const text of [first, later]) {
      expect(text.toLowerCase()).not.toMatch(/cheat|violat|flagged|misconduct|penal/);
    }
  });

  it('offers submission, not continuation, once time is up', () => {
    const copy = overlayCopy(base({ isOutOfTime: true }));
    expect(copy.title).toBe('Time is up');
    expect(copy.actions.map((a) => a.action)).toContain('END_AND_SUBMIT');
    expect(copy.body).toContain('last saved answers are kept');
  });

  it('reports the SAME evidence kind the student was shown', () => {
    // The timeline must record the reason the student saw, or a teacher reviewing it sees a different event than the
    // one the student answered for.
    expect(evidenceFor('FULLSCREEN_DENIED')).toBe('FULLSCREEN_DENIED');
    expect(evidenceFor('FULLSCREEN_LOST')).toBe('FULLSCREEN_EXITED');
    expect(evidenceFor('MULTI_TAB')).toBe('MULTI_TAB_DETECTED');
  });
});

// @vitest-environment jsdom
/**
 * The save indicator and the autosave loop.  (P2-T4)
 *
 * ## The test this file is for
 *
 * "NEVER says Saved after a failure", asserted over EVERY failing path: a rejected promise, an
 * `{ok: false}` result, and a conflict. The packet says "a save failure is never silent", and
 * the way that requirement actually fails in practice is not a missing state -- it is an
 * indicator that says "Saved" while the write is failing, so the author walks away believing
 * their work is stored.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEBOUNCE_MS,
  isLegalTransition,
  SaveIndicator,
  type SaveState,
  STATE_TEXT,
  translatorFor,
  useAutosave,
} from './SaveIndicator.js';

afterEach(cleanup);

/** A controllable scheduler, so the tests do not wait 800ms of real time. */
function fakeClock() {
  let pending: (() => void) | null = null;
  return {
    schedule(fn: () => void) {
      pending = fn;
      return () => {
        pending = null;
      };
    },
    run() {
      const fn = pending;
      pending = null;
      fn?.();
    },
    get armed() {
      return pending !== null;
    },
  };
}

/** One probe, wired to the real hook, with the states it published recorded. */
function probe(opts: {
  save: () => Promise<unknown>;
  clock: ReturnType<typeof fakeClock>;
  states?: SaveState[];
}) {
  const states = opts.states ?? [];
  function Probe() {
    const { state, edit, retry } = useAutosave(() => ({ blocks: [] }), {
      save: opts.save as never,
      onState: (s) => states.push(s),
      now: () => Date.parse('2026-09-27T12:00:00Z'),
      schedule: opts.clock.schedule,
    });
    return (
      <div>
        <SaveIndicator state={state} onRetry={retry} />
        <button type="button" onClick={edit}>
          edit
        </button>
      </div>
    );
  }
  return { Probe, states };
}

const edit = () => fireEvent.click(screen.getByRole('button', { name: 'edit' }));

describe('the state machine', () => {
  it('does not allow dirty -> saved', () => {
    // A save cannot complete without having been sent, and this shortcut is exactly the shape of
    // the bug where the indicator is set optimistically on edit.
    expect(isLegalTransition('dirty', 'saved')).toBe(false);
  });

  it('allows saving -> saved, failed and conflict', () => {
    expect(isLegalTransition('saving', 'saved')).toBe(true);
    expect(isLegalTransition('saving', 'failed')).toBe(true);
    expect(isLegalTransition('saving', 'conflict')).toBe(true);
  });

  it('allows dirty DURING saving, which is what makes an edit mid-save representable', () => {
    // Without this, the mid-flight edit would be unrepresentable and would have to be dropped or
    // queued somewhere illegal.
    expect(isLegalTransition('saving', 'dirty')).toBe(true);
  });

  /**
   * THE ONLY EDIT THIS FILE NEEDED FOR `P13-T7`, AND IT IS THE SAME ASSERTION.
   *
   * `STATE_TEXT` was a `Record<kind, string>` of English and is now `(kind, t) => string`, because a
   * constant cannot consult a locale. The property under test — every state has text, because a state
   * that is only a class name is not announced — is unchanged, and it is now a stronger statement: it
   * walks the catalogue rather than a local literal, so it fails if a key is renamed as well as if one
   * is emptied.
   */
  it('every state has text, because a state that is only a class name is not announced', () => {
    const t = translatorFor();
    for (const kind of ['idle', 'dirty', 'saving', 'saved', 'failed', 'conflict'] as const) {
      expect(STATE_TEXT(kind, t), kind).toBeTruthy();
    }
  });
});

describe('SaveIndicator', () => {
  it('announces the state in TEXT, not only in a colour', () => {
    render(<SaveIndicator state={{ kind: 'saved', at: Date.parse('2026-09-27T12:00:00Z') }} />);
    expect(screen.getByRole('status').textContent).toContain('Saved');
  });

  it('uses role="alert" for a failure, because polite is a failure that gets missed', () => {
    render(<SaveIndicator state={{ kind: 'failed', attempts: 3, reason: 'the server said no' }} />);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain("Couldn't save");
    // The reason and the count are in the ACCESSIBLE TEXT, not in a tooltip.
    expect(alert.textContent).toContain('the server said no');
    expect(alert.textContent).toContain('3 attempts');
  });

  it('offers a retry on failure', () => {
    const onRetry = vi.fn();
    render(
      <SaveIndicator
        state={{ kind: 'failed', attempts: 1, reason: 'offline' }}
        onRetry={onRetry}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Try again now' }));
    expect(onRetry).toHaveBeenCalled();
  });

  it('uses role="alert" for a conflict, and says how many blocks need a decision', () => {
    render(<SaveIndicator state={{ kind: 'conflict', conflicts: 3 }} />);
    expect(screen.getByRole('alert').textContent).toContain('3 blocks need a decision');
  });

  /**
   * THE SENTENCE WAS ALREADY WRONG IN ENGLISH BEFORE ANY TRANSLATION EXISTED.
   *
   * It read `` {n} block{n === 1 ? '' : 's'} need a decision ``, so one conflicting block announced
   * "1 block need a decision" inside a `role="alert"` — a screen reader saying a grammatically broken
   * sentence to an author whose work is blocked. The verb now lives in the plural arms, which is what
   * fixes English AND is what a four-form language needs, so the two were the same change.
   */
  it("AGREES WITH ITSELF AT ONE CONFLICT, which `n === 1 ? '' : 's'` did not", () => {
    render(<SaveIndicator state={{ kind: 'conflict', conflicts: 1 }} />);
    const text = screen.getByRole('alert').textContent ?? '';
    expect(text).toContain('1 block needs a decision');
    expect(text).not.toContain('1 block need a decision');
  });

  /**
   * THE COMPONENT ACTUALLY ASKS THE FRAMEWORK, RATHER THAN CARRYING ITS OWN FORMATS.
   *
   * **WITHOUT THIS, `P13-T7` COULD HAVE BEEN SATISFIED BY A CATALOGUE NOBODY READS.** The date in the
   * `role="status"` is the same instant, the same zone and the same component — only the locale
   * differs, and it renders the way `en-US` renders that instant. A hard-coded `toISOString()` cannot
   * produce this, which is what makes the assertion evidence rather than decoration.
   */
  it('RENDERS THE SAME INSTANT THE WAY THE REQUESTED LOCALE RENDERS IT', () => {
    const at = Date.parse('2026-09-27T12:00:00Z');
    const { unmount } = render(<SaveIndicator state={{ kind: 'saved', at }} locale="en-GB" />);
    const gb = screen.getByRole('status').textContent;
    unmount();
    render(<SaveIndicator state={{ kind: 'saved', at }} locale="en-US" />);
    const us = screen.getByRole('status').textContent;
    expect(gb).toContain('27 Sept 2026');
    expect(us).toContain('Sep 27, 2026');
    expect(us).not.toBe(gb);
    // An unshipped locale falls back to the SOURCE catalogue rather than throwing: a stored profile
    // must not take the page down over a settings row.
    cleanup();
    render(<SaveIndicator state={{ kind: 'saved', at }} locale="de-DE" />);
    expect(screen.getByRole('status').textContent).toContain('27 Sept 2026');
  });

  it('ANNOUNCES THE COUNT IN THE RIGHT GRAMMATICAL NUMBER, because the string is SPOKEN', () => {
    render(<SaveIndicator state={{ kind: 'failed', attempts: 1, reason: 'offline' }} />);
    expect(screen.getByRole('alert').textContent).toContain('1 attempt so far');
    cleanup();
    render(<SaveIndicator state={{ kind: 'failed', attempts: 4, reason: 'offline' }} />);
    expect(screen.getByRole('alert').textContent).toContain('4 attempts so far');
  });

  it('says "Saving…" while in flight rather than flashing "Saved"', () => {
    // A lie that reverses is worse than a slow truth.
    render(<SaveIndicator state={{ kind: 'saving' }} />);
    expect(screen.getByRole('status').textContent).toBe('Saving…');
  });
});

describe('NEVER says Saved after a failure', () => {
  it('a rejected promise ends in failed, not saved', async () => {
    const clock = fakeClock();
    const { Probe, states } = probe({
      clock,
      save: async () => {
        throw new Error('socket hang up');
      },
    });
    render(<Probe />);
    edit();
    await act(async () => {
      clock.run();
    });
    expect(states.map((s) => s.kind)).toContain('failed');
    expect(states.map((s) => s.kind)).not.toContain('saved');
    expect(screen.getByRole('alert')).toBeTruthy();
  });

  it('an {ok:false} result ends in failed, not saved', async () => {
    const clock = fakeClock();
    const { Probe, states } = probe({
      clock,
      save: async () => ({ ok: false, reason: 'validation' }),
    });
    render(<Probe />);
    edit();
    await act(async () => {
      clock.run();
    });
    expect(states.at(-1)?.kind).toBe('failed');
    expect(states.some((s) => s.kind === 'saved')).toBe(false);
  });

  it('a conflict ends in conflict, and never in saved', async () => {
    // A 409 must not be treated as a save. Treating it as one is how an editor silently
    // overwrites somebody's work.
    const clock = fakeClock();
    const { Probe, states } = probe({
      clock,
      save: async () => ({ ok: false, reason: 'conflict', conflicts: 2, conflict: true }),
    });
    render(<Probe />);
    edit();
    await act(async () => {
      clock.run();
    });
    expect(states.at(-1)).toMatchObject({ kind: 'conflict', conflicts: 2 });
    expect(states.some((s) => s.kind === 'saved')).toBe(false);
  });

  it('shows Saving while in flight and Saved only after it settles', async () => {
    let release: (() => void) | null = null;
    const clock = fakeClock();
    const { Probe, states } = probe({
      clock,
      save: () =>
        new Promise<{ ok: true }>((resolve) => {
          release = () => resolve({ ok: true });
        }),
    });
    render(<Probe />);
    edit();
    await act(async () => {
      clock.run();
    });
    // In flight: the indicator must NOT already read "Saved".
    expect(states.map((s) => s.kind)).toEqual(['dirty', 'saving']);
    expect(screen.getByRole('status').textContent).toBe('Saving…');
    await act(async () => {
      release?.();
    });
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain('Saved');
    });
    // And the timestamp is in the ACCESSIBLE TEXT, not just in a `title`. "Saved" alone leaves a
    // screen-reader user unable to tell a save from a few minutes ago, which is the difference
    // between trusting the indicator and ignoring it.
    //
    // **THE EXPECTED VALUE CHANGED, AND STRICTLY TIGHTENED (`P13-T7`).** It was the raw ISO string
    // `2026-09-27T12:00:00.000Z`, which is the worst possible thing to hand a screen reader: no word
    // boundaries, and a machine timestamp inside a sentence about a person. It is now the locale's own
    // rendering, pinned to `en-GB`, so this assertion is about the FORMAT and not merely about the
    // presence of some characters — `toContain(new Date(...).toISOString())` would have accepted a
    // string that was still a machine timestamp.
    expect(screen.getByRole('status').textContent).toContain('at 27 Sept 2026, 12:00');
    // ...and explicitly not the ISO form, which is the property the old assertion failed to state.
    expect(screen.getByRole('status').textContent).not.toContain('2026-09-27T12:00:00.000Z');
  });
});

describe('the debounce', () => {
  it('is 800ms, as the packet specifies', () => {
    expect(DEBOUNCE_MS).toBe(800);
  });

  it('restarts the timer on each edit, so a burst is ONE save', async () => {
    const clock = fakeClock();
    const save = vi.fn(async () => ({ ok: true as const }));
    const { Probe, states } = probe({ clock, save });
    render(<Probe />);
    // Three edits in a burst: dirty three times, then one flush.
    edit();
    edit();
    edit();
    expect(states.filter((s) => s.kind === 'dirty')).toHaveLength(3);
    expect(clock.armed, 'each edit re-arms the timer').toBe(true);
    await act(async () => {
      clock.run();
    });
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('does not start a second request while one is in flight', async () => {
    // Three overlapping requests mean whichever response lands LAST sets the indicator, so a slow
    // early request can mark a failed later edit as saved.
    const clock = fakeClock();
    const save = vi.fn(() => new Promise<{ ok: true }>(() => {})); // never settles
    const { Probe } = probe({ clock, save });
    render(<Probe />);
    await act(async () => {
      edit();
      clock.run();
    });
    edit();
    edit();
    await act(async () => {
      clock.run();
    });
    expect(save).toHaveBeenCalledTimes(1);
  });
});

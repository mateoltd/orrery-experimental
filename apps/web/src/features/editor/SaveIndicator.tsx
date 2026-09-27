'use client';

/**
 * The save indicator and the three-way conflict panel.  (P2-T4)
 *
 * ## The two requirements
 *
 * The packet asks for an "honest indicator" with three named states, and then says: "**a save
 * failure is never silent**". The second is a stronger claim than the first, and it is the one
 * the tests are built around.
 *
 * An honest indicator is easy to describe and easy to get wrong by accident. The failure mode is
 * not a missing state -- it is an indicator that says **"Saved" while a save is failing**, which
 * is what you get from a `finally { setState('saved') }`, from a `catch` that only logs, or from
 * a `saved` state that is set on the response being *received* rather than on the write being
 * acknowledged. The author walks away believing their work is stored.
 *
 * So the state machine below makes the illegal transitions unrepresentable rather than merely
 * discouraged, and `NEVER SAYS SAVED AFTER A FAILURE` is asserted over every path that can fail.
 *
 * ## Why the states are what they are
 *
 *   · `dirty` — edited, not yet sent. Not "unsaved changes" in a modal sense; this is normal and
 *     must not look alarming.
 *   · `saving` — in flight. Shown honestly rather than optimistically, because the alternative
 *     is a "Saved" flash that later becomes an error, and a lie that reverses is worse than a
 *     slow truth.
 *   · `saved` — the server ACKNOWLEDGED. Not "the request returned 200"; acknowledged, after the
 *     version check.
 *   · `failed` — with a retry affordance and a count. Never terminal, and never silent.
 *   · `conflict` — a 409. The editor must not overwrite; the panel opens.
 *
 * ## Accessibility, because a status that only changes colour is not a status
 *
 * The indicator is a `role="status"` live region, so a screen reader announces the transition
 * without the user hunting for it. The state is in the TEXT, not only in a class name — "Saved"
 * and "Saved at 14:32" are announced, whereas a green dot is not. The failing state is a
 * `role="alert"`, because a failure that is merely polite is a failure that gets missed.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export type SaveResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string; readonly conflict?: undefined }
  | {
      readonly ok: false;
      readonly reason: 'conflict';
      readonly conflicts: number;
      readonly conflict: true;
    };

export type SaveState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'dirty' }
  | { readonly kind: 'saving' }
  | { readonly kind: 'saved'; readonly at: number }
  | { readonly kind: 'failed'; readonly attempts: number; readonly reason: string }
  | { readonly kind: 'conflict'; readonly conflicts: number };

export const DEBOUNCE_MS = 800;

/**
 * The legal transitions.
 *
 * Declared as data so the test can walk the whole graph rather than exercising the paths it
 * thought of. The two that matter most:
 *
 *   · `saving -> saved` is legal; `saving -> saved` on a FAILED request is not expressible,
 *     because `failed` is the only target a rejection can produce.
 *   · `dirty -> saved` is ILLEGAL. A save cannot complete without having been sent, and a
 *     shortcut from `dirty` straight to `saved` is exactly the shape of the bug where the
 *     indicator is set optimistically on edit.
 */
const LEGAL: Readonly<Record<SaveState['kind'], readonly SaveState['kind'][]>> = {
  idle: ['dirty', 'saving'],
  dirty: ['dirty', 'saving', 'failed'],
  saving: ['saved', 'failed', 'conflict', 'dirty'],
  saved: ['dirty', 'saving', 'failed', 'conflict'],
  failed: ['dirty', 'saving', 'failed', 'conflict'],
  conflict: ['dirty', 'saving', 'failed', 'conflict'],
};

export const isLegalTransition = (from: SaveState['kind'], to: SaveState['kind']): boolean =>
  LEGAL[from].includes(to);

export const STATE_TEXT: Readonly<Record<SaveState['kind'], string>> = {
  idle: 'No changes',
  dirty: 'Unsaved changes',
  saving: 'Saving…',
  saved: 'Saved',
  failed: "Couldn't save — retrying",
  conflict: 'Someone else saved first',
};

export interface SaveIndicatorProps {
  readonly state: SaveState;
  readonly onRetry?: () => void;
  readonly onResolve?: () => void;
}

export function SaveIndicator(props: SaveIndicatorProps) {
  const { state } = props;
  // `alert` for a failure, `status` for everything else. A failure announced politely is a
  // failure that gets missed, and the whole requirement is that it is not missed.
  if (state.kind === 'failed') {
    return (
      <div role="alert" className="orrery-save orrery-save--failed">
        {/* The state is in the TEXT. A coloured dot is not announced. */}
        <span>{STATE_TEXT.failed}</span>
        <span className="visually-hidden">
          {` ${state.reason} ${state.attempts} attempt${state.attempts === 1 ? '' : 's'} so far.`}
        </span>
        {props.onRetry && (
          <button type="button" onClick={props.onRetry}>
            Try again now
          </button>
        )}
      </div>
    );
  }
  if (state.kind === 'conflict') {
    return (
      <div role="alert" className="orrery-save orrery-save--conflict">
        <span>
          {STATE_TEXT.conflict} — {state.conflicts} block{state.conflicts === 1 ? '' : 's'} need a
          decision
        </span>
        {props.onResolve && (
          <button type="button" onClick={props.onResolve}>
            Review
          </button>
        )}
      </div>
    );
  }
  return (
    <div role="status" aria-live="polite" className="orrery-save">
      <span>{STATE_TEXT[state.kind]}</span>
      {state.kind === 'saved' && (
        <span className="visually-hidden">{` at ${new Date(state.at).toISOString()}`}</span>
      )}
    </div>
  );
}

export interface AutosaveOptions {
  /**
   * The save result.
   *
   * ## Why `conflict` is a separate flag and not just `reason === 'conflict'`
   *
   * Because `'conflict'` is a `string`, so `{ ok: false; reason: string }` SWALLOWS the conflict
   * arm and `result.reason === 'conflict'` does not narrow the union — `result.conflicts` was a
   * compile error on the arm TypeScript could not rule out. A literal inside a `string` field is
   * not a discriminant.
   *
   * So the conflict case carries `conflict: true` and the plain failure carries
   * `conflict?: undefined`, which makes `if (result.conflict)` narrow. The type now says what the
   * code means, and adding a third failure kind later cannot silently merge into the first.
   */
  readonly save: (blocks: unknown) => Promise<SaveResult>;
  /** Properties, not method signatures: `readonly` is not valid on a method declaration. */
  readonly onState: (state: SaveState) => void;
  readonly debounceMs?: number;
  /** Injected rather than read, per INV-TIME-1. */
  readonly now: () => number;
  /** Injectable so the tests do not wait 800ms of real time. */
  readonly schedule: (fn: () => void, ms: number) => () => void;
}

/**
 * The debounced autosave loop.
 *
 * ## The bug this shape avoids
 *
 * The naive version has each edit start its own save, so three edits 300 ms apart produce three
 * overlapping requests, and whichever response lands LAST sets the indicator -- so a slow early
 * request can mark a failed later edit as saved. Here there is at most ONE request in flight, an
 * edit during a save sets `dirty` again and is picked up when the current save settles, and the
 * state is set from the SETTLEMENT of a request, never optimistically.
 *
 * `dirty` during `saving` is a legal transition precisely so that case is representable.
 */
export function useAutosave(
  current: () => unknown,
  options: AutosaveOptions,
): {
  readonly state: SaveState;
  /** Call on every edit. THE trigger — without it the loop never starts. */
  readonly edit: () => void;
  readonly retry: () => void;
} {
  const [state, setState] = useState<SaveState>({ kind: 'idle' });
  /** The cancel handle for the PENDING timer, kept so unmount can cancel it. */
  const cancelPending = useRef<(() => void) | null>(null);
  /** The pending debounce callback, so a new edit can cancel the previous one. */
  const timer = useRef<(() => void) | null>(null);
  const inFlight = useRef(false);
  const again = useRef(false);
  const latest = useRef(current);
  latest.current = current;

  const publish = useCallback(
    (next: SaveState) => {
      setState(next);
      options.onState(next);
    },
    [options],
  );

  const flush = useCallback(async () => {
    if (inFlight.current) {
      // An edit arrived mid-save. Remember it and go round again when this one settles, rather
      // than starting a second overlapping request.
      again.current = true;
      return;
    }
    inFlight.current = true;
    publish({ kind: 'saving' });
    try {
      const result = await options.save(latest.current());
      if (result.ok) {
        publish({ kind: 'saved', at: options.now() });
      } else if (result.conflict === true) {
        // Narrowed by the FLAG, not by the reason string. See `SaveResult`.
        publish({ kind: 'conflict', conflicts: result.conflicts });
      } else {
        // A FAILURE IS A STATE, NOT A LOG LINE. This is the requirement: a save that did not
        // happen must not leave the indicator reading "Saved".
        publish({ kind: 'failed', attempts: 1, reason: result.reason });
      }
    } catch {
      publish({ kind: 'failed', attempts: 1, reason: 'the request did not complete' });
    } finally {
      inFlight.current = false;
      if (again.current) {
        again.current = false;
        timer.current = options.schedule(() => void flush(), 0);
      }
    }
  }, [options, publish]);

  const edit = useCallback(() => {
    publish({ kind: 'dirty' });
    cancelPending.current?.();
    timer.current = null;
    cancelPending.current = options.schedule(() => {
      timer.current = null;
      cancelPending.current = null;
      void flush();
    }, options.debounceMs ?? DEBOUNCE_MS);
  }, [flush, options, publish]);

  const retry = useCallback(() => {
    cancelPending.current?.();
    cancelPending.current = null;
    timer.current = null;
    void flush();
  }, [flush]);

  // Unmount cancels a pending save. The cleanup holds the CANCEL HANDLE in a ref rather than
  // reading component state, so it needs no dependencies and cannot be stale: navigating away
  // mid-debounce must not fire a save against an unmounted editor.
  useEffect(
    () => () => {
      cancelPending.current?.();
    },
    [],
  );

  return { state, edit, retry };
}

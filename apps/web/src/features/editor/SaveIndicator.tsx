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
 *
 * ## WHY THIS COMPONENT, AND NOT AN EASIER ONE  (P13-T7)
 *
 * **EVERY STRING ON THIS SCREEN IS READ ALOUD.** The whole surface is `role="status"` and
 * `role="alert"`, so a mistranslated or mis-inflected word here is spoken to a student by a screen
 * reader with no visual context to correct it — and that is also why this component was chosen to be
 * the one converted: a framework proven on static page furniture would be proven on the case where
 * getting it wrong is worst.
 *
 * It also carried the three defects `P13-T7` exists to remove, all recorded in `catalogues.ts`:
 * two English two-form plurals built by `n === 1 ? '' : 's'`, a date rendered as a raw ISO string,
 * and a sentence that was already wrong in English ("1 block need a decision").
 */

import {
  CATALOGUES,
  createTranslator,
  DEFAULT_LOCALE,
  FALLBACK_ZONE,
  type Locale,
  type MessageIssue,
  type MessageKey,
  resolveLocale,
  type Translator,
} from '@orrery/i18n';
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

/**
 * THE SIX STATES, AS MESSAGE KEYS RATHER THAN AS ENGLISH.
 *
 * A `Record<kind, string>` of English is the shape that makes a component untranslatable: the key and
 * the copy are the same string, so extracting it means renaming every lookup at every call site.
 * Keying them instead means `SaveState['kind']` and the catalogue key cannot drift, and the compiler
 * rejects a key that does not exist.
 */
const STATE_KEYS: Readonly<Record<SaveState['kind'], MessageKey>> = {
  idle: 'save.state.idle',
  dirty: 'save.state.dirty',
  saving: 'save.state.saving',
  saved: 'save.state.saved',
  failed: 'save.state.failed',
  conflict: 'save.state.conflict',
};

/**
 * What the live region says for a state.
 *
 * A FUNCTION and not a constant because a constant cannot consult the locale. The six states have
 * exactly six strings, so the risk of this being a place where copy is lost is nil — the test walks
 * all six and asserts each renders non-empty, which is the same assertion the constant version made.
 */
export const STATE_TEXT = (kind: SaveState['kind'], t: Translator): string => t(STATE_KEYS[kind]);

/**
 * THE REPORTER, WRITTEN OUT RATHER THAN INHERITED.
 *
 * **`onIssue` IS A REQUIRED ARGUMENT IN `@orrery/i18n`, BECAUSE A DEFAULTED REPORTER IS A REPORTER
 * NOBODY SETS** — and a missing key with no reporter renders as the key with nothing logged anywhere.
 * `console.warn` is this component's decision about what a gap does, and it is written out so a
 * reviewer can see it rather than inherit it. `console.error` was considered and is worse: it makes a
 * degraded page look like a broken one in a log a teacher is asked to read.
 */
const report = (issue: MessageIssue): void =>
  console.warn(
    `@orrery/i18n: ${issue.kind} for ${String(issue.key)} (${issue.locale}): ${issue.detail}`,
  );

const translators = new Map<string, Translator>();

/**
 * THE TRANSLATOR FOR A LOCALE, MEMOISED.
 *
 * **THE CATALOGUE IS CHOSEN BY THE RESOLVED LOCALE, NOT BY THE REQUESTED ONE.** `resolveLocale` turns
 * an unshipped tag into the source locale and reports that it did, so a student whose profile carries a
 * language this build dropped gets English copy rather than a crash and rather than the *wrong*
 * catalogue. Memoised because `createTranslator` is cheap but `Intl` construction is not, and this is on
 * a render path.
 */
export function translatorFor(locale: Locale | string = DEFAULT_LOCALE): Translator {
  const key = resolveLocale(locale).locale;
  const hit = translators.get(key);
  if (hit !== undefined) return hit;
  const built = createTranslator(CATALOGUES[key], {
    locale: key,
    onIssue: report,
    timeZone: FALLBACK_ZONE,
  });
  translators.set(key, built);
  return built;
}

export interface SaveIndicatorProps {
  readonly state: SaveState;
  readonly onRetry?: () => void;
  readonly onResolve?: () => void;
  /**
   * The locale to render in.
   *
   * **A PROP AND NOT A CONTEXT, AND THE REASON IS SCOPE.** `P13-T7` converts one component; the app has
   * no locale plumbing yet, so a `React.Context` here would be an invention with one reader and no
   * provider — a framework that looks finished and is not. The prop is the smallest thing that is
   * honest, and it defaults to the source locale so every existing call site is unchanged.
   *
   * The default is `DEFAULT_LOCALE` and never the browser's language, because the two differ and the
   * component must not depend on which machine rendered it.
   */
  readonly locale?: Locale | string;
}

export function SaveIndicator(props: SaveIndicatorProps) {
  const { state } = props;
  const t = translatorFor(props.locale ?? DEFAULT_LOCALE);
  // `alert` for a failure, `status` for everything else. A failure announced politely is a
  // failure that gets missed, and the whole requirement is that it is not missed.
  if (state.kind === 'failed') {
    return (
      <div role="alert" className="orrery-save orrery-save--failed">
        {/* The state is in the TEXT. A coloured dot is not announced. */}
        <span>{STATE_TEXT(state.kind, t)}</span>
        <span className="visually-hidden">
          {t('save.failure.detail', { reason: state.reason, count: state.attempts })}
        </span>
        {props.onRetry && (
          <button type="button" onClick={props.onRetry}>
            {t('save.action.retry')}
          </button>
        )}
      </div>
    );
  }
  if (state.kind === 'conflict') {
    return (
      <div role="alert" className="orrery-save orrery-save--conflict">
        {/* The VERB IS IN THE PLURAL ARMS, because it was wrong before. `1 block need a decision`. */}
        <span>{`${STATE_TEXT(state.kind, t)} — ${t('save.conflict.detail', { count: state.conflicts })}`}</span>
        {props.onResolve && (
          <button type="button" onClick={props.onResolve}>
            {t('save.action.review')}
          </button>
        )}
      </div>
    );
  }
  return (
    <div role="status" aria-live="polite" className="orrery-save">
      <span>{STATE_TEXT(state.kind, t)}</span>
      {state.kind === 'saved' && (
        /**
         * `{when, date}` AND NOT `toISOString()`, because this text is ANNOUNCED.
         *
         * `2026-09-27T12:00:00.000Z` read aloud is a stream of letters, digits and punctuation with no
         * word boundaries; read visually it is a machine timestamp inside a sentence about a person. The
         * date format is a property of the locale, so it belongs in the message — and `FALLBACK_ZONE`
         * is the zone, because an instant rendered in the host's zone differs between a developer's
         * laptop and the production server.
         */
        <span className="visually-hidden">{t('save.saved.at', { when: new Date(state.at) })}</span>
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

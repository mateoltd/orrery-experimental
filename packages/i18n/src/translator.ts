/**
 * The catalogue-facing API: a translator bound to one locale and one catalogue.
 *
 * ## WHY `onIssue` IS A REQUIRED ARGUMENT
 *
 * **AN API THAT LOOKS LOCALISATION-READY AND SILENTLY FALLS BACK TO ENGLISH IS THE FAILURE THIS
 * TASK EXISTS TO PREVENT, SO IT IS MADE IMPOSSIBLE BY CONSTRUCTION.** A defaulted reporter is a
 * reporter nobody sets, so `t('save.state.dirty')` would render the key, print nothing, and ship.
 * Making it required means the first line of every call site is a decision about what a gap does —
 * and the decision is visible in the diff rather than buried in a default.
 *
 * The gate is the enforcement point; this is the last line of defence, and the two are deliberately
 * not the same mechanism. `i18n:check` fails the build. This fails the string.
 *
 * ## WHAT A MISSING KEY DOES, AND WHY IT IS NOT A CRASH
 *
 * It reports, and it renders **the key itself**. Rendering the key rather than English is the point:
 * an English fallback in a catalogue-driven renderer looks like a working translation, so the defect
 * survives review and reaches a student. `save.state.dirty` on screen is obviously broken to the
 * next person who looks, and `save.state.dirty` is greppable in a screenshot, a log line or a bug
 * report. A missing key degrades one string; a crash would take the page a student is sitting an
 * exam on.
 */

import type { CompleteCatalogue, MessageKey } from './catalogues.js';
import { FALLBACK_ZONE } from './locale.js';
import { formatMessage, type MessageArgs, type RenderIssue } from './message.js';

/** What a render could not do properly, named so an operator can act on it. */
export interface MessageIssue {
  /**
   * `'missing-key'` — the catalogue has no entry.
   * `'missing-argument'` — the message reads an argument the caller did not pass.
   * `'bad-argument'` — an argument of the wrong type (`{n, plural}` with a string).
   * `'no-select-arm'` — the message's `select` has no arm for the value given.
   */
  readonly kind: 'missing-key' | 'missing-argument' | 'bad-argument' | 'no-select-arm';
  readonly locale: string;
  /** The catalogue key, or `null` on the keyless `formatMessage` path. */
  readonly key: string | null;
  readonly detail: string;
}

export interface TranslatorOptions {
  readonly locale: string;
  /** Required unless the caller passes one per call. See the header. */
  readonly onIssue: (issue: MessageIssue) => void;
  /**
   * The zone every `{when, date}` in this translator renders in.
   *
   * Defaults to `FALLBACK_ZONE` rather than to the host zone. A date in a message with no zone is a
   * date in `America/Chicago` on a CI server and in `Europe/London` on a laptop, and the difference
   * only shows up in a bug report.
   */
  readonly timeZone?: string;
}

export interface Translator {
  (key: MessageKey): string;
  (key: MessageKey, args: MessageArgs): string;
  /** The locale this translator formats in. Named, so a component can label a language switcher. */
  readonly locale: string;
  readonly timeZone: string;
}

/**
 * Build a translator over a catalogue.
 *
 * The parameter is `CompleteCatalogue`, so **a translator cannot be built from an incomplete
 * catalogue.** That is the type-level guarantee: deleting a key from `enUS` is a compile error at
 * the `createTranslator` call, not a render-time crash for a student. The runtime check in
 * `i18n:check` exists for what types cannot see — a catalogue loaded from JSON at runtime, or a key
 * removed from the SOURCE, where the union shrinks with it and everything still compiles.
 */
export function createTranslator(
  catalogue: CompleteCatalogue,
  options: TranslatorOptions,
): Translator {
  const locale = options.locale;
  const timeZone = options.timeZone ?? FALLBACK_ZONE;

  const report = (key: string, issue: RenderIssue): void => {
    options.onIssue({ kind: issue.kind, locale, key, detail: issue.detail });
  };

  const translate = (key: MessageKey, args?: MessageArgs): string => {
    const pattern: string | undefined = (catalogue as Record<string, string | undefined>)[key];
    if (pattern === undefined) {
      options.onIssue({
        kind: 'missing-key',
        locale,
        key,
        detail: `no entry for ${JSON.stringify(key)} in the ${locale} catalogue`,
      });
      // The KEY, not English. See the header: an English fallback looks like a working translation.
      return key;
    }
    return formatMessage(pattern, args ?? {}, { locale, timeZone }, (issue) => report(key, issue));
  };

  return Object.assign(translate, { locale, timeZone }) as Translator;
}

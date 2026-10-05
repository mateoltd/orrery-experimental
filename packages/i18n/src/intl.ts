/**
 * Locale-scoped `Intl` formatters, reachable from a component without importing a formatter by hand.
 *
 * ## WHY A BUNDLE AND NOT A `new Intl.DateTimeFormat` AT EACH CALL SITE
 *
 * **A LOCALE'S DATE FORMAT IS A PROPERTY OF THE LOCALE, NOT OF THE MESSAGE THE DATE APPEARS IN.**
 * So "how does a date look" cannot live in a message and cannot live in a component either — the
 * moment either one owns the format, the format stops being a property of the language and starts
 * being a property of whoever wrote the line first.
 *
 * `formatDeadline` in `./index.ts` already builds an `Intl.DateTimeFormat` by hand. That was correct
 * when there was exactly one caller. It is not a pattern: a second caller writing
 * `new Intl.DateTimeFormat(locale)` with a slightly different option set produces a slightly
 * different date in a slightly different place, and nothing notices, because two hand-built
 * formatters agreeing is not a thing anyone checks.
 *
 * So the access point is here, one per `Intl` namespace, taking the locale and returning the
 * formatter. `Intl.DateTimeFormat(locale)` is then reachable from any component by naming a locale
 * — which is the actual requirement — without anyone hand-rolling options or caching.
 *
 * ## THE MEMOISATION IS A CORRECTNESS MATTER, NOT AN OPTIMISATION
 *
 * Formatter construction is genuinely expensive and `Intl` does not cache for you. More importantly,
 * an app that constructs a new formatter per render is constructing a new one per render *per
 * element*, so a table of 200 rows formats 200 date columns in 200 different instants of ICU
 * initialisation. The cache key is the locale plus the serialised options, so two call sites asking
 * for the same thing share one formatter and two call sites asking for different things do not.
 *
 * The options must therefore be JSON-serialisable. They are literals at every call site, and a
 * function-valued option (`timeZoneName: () => …` is legal in `Intl`) would serialise to `null` and
 * collide. That is stated rather than defended against: nothing in this repository uses one.
 */

import { DEFAULT_LOCALE, FALLBACK_ZONE, isValidZone } from './locale.js';

export interface LocaleFormatters {
  /** `Intl.DateTimeFormat` for the locale. Cache-busted on options, so two callers can differ. */
  readonly dateTime: (options?: Intl.DateTimeFormatOptions) => Intl.DateTimeFormat;
  /** `Intl.NumberFormat` for the locale — grouping, decimal separator and digits included. */
  readonly number: (options?: Intl.NumberFormatOptions) => Intl.NumberFormat;
  /**
   * `Intl.PluralRules` for the locale.
   *
   * Exposed because this is the function that makes `n === 1 ? … : …` untenable: it is the only
   * portable answer to "which grammatical number is this count in", and it answers differently for
   * every locale.
   */
  readonly pluralRules: (options?: Intl.PluralRulesOptions) => Intl.PluralRules;
  /** `Intl.RelativeTimeFormat` for the locale. */
  readonly relativeTime: (options?: Intl.RelativeTimeFormatOptions) => Intl.RelativeTimeFormat;
}

/**
 * A KNOWN-BAD ZONE FALLS BACK TO UTC RATHER THAN THROWING.
 *
 * `Intl.DateTimeFormat` throws `RangeError` on an unknown `timeZone`, so a `timeZone` read from a
 * user profile or a stored deadline is an unhandled exception in a render path unless something
 * catches it. `isValidZone` in `./locale.ts` is the existing answer to that question and this uses
 * it, so the two cannot disagree about what counts as a zone.
 */
function safeTimeZone(zone: string | undefined): string {
  if (zone === undefined) return FALLBACK_ZONE;
  return isValidZone(zone) ? zone : FALLBACK_ZONE;
}

/**
 * One cache for four formatter kinds, keyed by kind first.
 *
 * `unknown` rather than a union of the four types because the key already names the kind, and a
 * union would force a cast at every read. The alternative — four typed maps — is more type-honest
 * and 3x the code for no behaviour a test could tell apart.
 */
const cache = new Map<string, unknown>();

function memoised<T>(kind: string, locale: string, options: object | undefined, build: () => T): T {
  const key = `${kind}|${locale}|${options === undefined ? '' : JSON.stringify(options)}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit as T;
  const built = build();
  cache.set(key, built);
  return built;
}

/**
 * THE ACCESSOR. One bundle per locale, memoised on the locale itself.
 *
 * The locale is the only thing that varies across a whole page, so the bundle is built once per
 * locale and the individual formatter calls inside it are memoised on their options.
 *
 * `locale` is a plain `string`, not `Locale`, and deliberately so: a test has to be able to ask for
 * `ar` or `pl` — the languages with four and six plural forms — because a framework that can only
 * be exercised in the two locales we happen to ship cannot be shown to handle the locales we do
 * not. Shipping is a product decision (`LOCALES`); formatting capability is not.
 */
export function localeFormatters(locale: string): LocaleFormatters {
  const safe = locale || DEFAULT_LOCALE;
  return {
    // The spread comes FIRST. `{ timeZone: safe, ...options }` lets a caller's `timeZone` overwrite the
    // validated one, which is how the invalid-zone fallback below stops existing — a config that looks
    // like it guards a value and does not.
    dateTime: (options) =>
      memoised(
        'dtf',
        safe,
        { ...options, timeZone: safeTimeZone(options?.timeZone) },
        () =>
          new Intl.DateTimeFormat(safe, { ...options, timeZone: safeTimeZone(options?.timeZone) }),
      ),
    number: (options) => memoised('nf', safe, options, () => new Intl.NumberFormat(safe, options)),
    pluralRules: (options) =>
      memoised('pr', safe, options, () => new Intl.PluralRules(safe, options)),
    relativeTime: (options) =>
      memoised('rtf', safe, options, () => new Intl.RelativeTimeFormat(safe, options)),
  };
}

/**
 * The plural categories a locale can actually produce.
 *
 * **THIS IS THE FUNCTION `i18n:check` BUILDS ITS PLURAL RULE ON, AND THE REASON IS SPECIFIC.**
 *
 * `Intl.PluralRules(locale).resolvedOptions().pluralCategories` returns the categories the locale
 * really uses — `['one','other']` for English, six entries for Arabic. So a catalogue message
 * written with only `one`/`other` can be checked against a Polish locale and found wanting *before
 * a student ever sees it*, rather than found wanting by a Polish speaker.
 *
 * Enumerating this by hand is impossible in general (it depends on CLDR, which changes), and
 * probing it by sampling integers is only approximately right. This asks ICU.
 */
export function pluralCategories(locale: string): readonly Intl.LDMLPluralRule[] {
  const resolved = new Intl.PluralRules(locale).resolvedOptions().pluralCategories as
    | Intl.LDMLPluralRule[]
    | undefined;
  // `resolvedOptions().pluralCategories` is absent from the TypeScript lib typings and from some
  // older ICU builds. Falling back to `['other']` would UNDER-report the categories and let a
  // two-form message pass for a six-form locale, which is the exact failure this is here to stop.
  // So an absent list is reported as the full CLDR category set and the gate fails loudly instead.
  return resolved ?? (['zero', 'one', 'two', 'few', 'many', 'other'] as Intl.LDMLPluralRule[]);
}

/** Does this runtime actually expose `pluralCategories`? Asserted, because `?? ` above is a real branch. */
export function hasPluralCategoryList(): boolean {
  return Array.isArray(new Intl.PluralRules('en-GB').resolvedOptions().pluralCategories);
}

/**
 * `DEFAULT_LOCALE` for a locale-less render, without importing it at every call site and hoping the
 * two stay in step.
 *
 * Returned rather than stored, so a caller cannot hold a formatter built for a locale that later
 * changes.
 */
export function formattersFor(locale: string = DEFAULT_LOCALE): LocaleFormatters {
  return localeFormatters(locale);
}

/** How many formatters are cached. Exported so a test can prove two call sites SHARE one. */
export function formatterCacheSize(): number {
  return cache.size;
}

/**
 * The message catalogues, and the declaration of which locale is the source.
 *
 * ## THIS FILE IS THE ANSWER TO "WHICH LOCALE IS THE SOURCE"
 *
 * Two catalogues compared for equality cannot tell which is authoritative. `i18n:check` prints
 * `SOURCE_LOCALE` on every run precisely so a failure names an *owner*: "en-US is missing
 * `save.state.dirty`" is a task, "the catalogues differ" is a shrug.
 *
 * ## WHAT IS IN HERE, AND WHAT IS NOT
 *
 * **ONLY THE STRINGS `P13-T7` ACTUALLY EXTRACTED.** `P13-T8` owns the en-GB and en-US catalogues, RTL
 * layout and the +30% text-expansion tests, and this file does not pre-empt it. What is here is the
 * copy from `apps/web/src/features/editor/SaveIndicator.tsx` plus the relative-distance phrases from
 * `./index.ts`, because those are the strings `P13-T7` had to move in order to prove the framework
 * is load-bearing.
 *
 * **`en-US` IS A MECHANICAL COPY AND IS NOT LOCALISATION.** It exists so `i18n:check` has a second
 * catalogue to compare against and so the gate can be shown failing; it is not a claim that en-US
 * copy has been written. `P13-T8` replaces it. Nothing here should be read as "this string is
 * correct American English" — it is correct British English with the locale tag changed.
 *
 * ## `as const` IS LOAD-BEARING, NOT DECORATION
 *
 * It is what makes `keyof typeof enGB` a literal union, which is what lets `createTranslator` reject
 * a catalogue that is missing a source key **at compile time** rather than at render time. Remove
 * `as const` and every key becomes `string`, the union collapses, and a catalogue can quietly lose a
 * key with nothing to complain. The test that catches it is `catalogue-completeness.test.ts`.
 *
 * ## NO RELATIVE IMPORTS, ON PURPOSE
 *
 * `scripts/i18n-check.mjs` loads this file directly with Node's type stripping, and Node's ESM
 * resolver requires a full `.ts` specifier for a relative import — which `tsc` refuses in a project
 * that emits. So this file has no relative imports, and the gate imports the catalogues themselves
 * rather than the package entry point, which also means the gate needs no build step.
 */

export const enGB = {
  'deadline.relative.underAMinute': 'in less than a minute',
  'deadline.relative.minutes': 'in {count, plural, one {# minute} other {# minutes}}',
  'deadline.relative.hours': 'in {count, plural, one {# hour} other {# hours}}',
  'deadline.relative.days': 'in {count, plural, one {# day} other {# days}}',

  'save.state.idle': 'No changes',
  'save.state.dirty': 'Unsaved changes',
  'save.state.saving': 'Saving…',
  'save.state.saved': 'Saved',
  'save.state.failed': "Couldn't save — retrying",
  'save.state.conflict': 'Someone else saved first',

  /**
   * WHY THIS ONE IS A MESSAGE AND NOT A TEMPLATE STRING.
   *
   * `attempts` is a count, and a count in a sentence is where the English two-form conditional
   * lives. The original code wrote `attempt${n === 1 ? '' : 's'}` inside a `role="alert"`, which is
   * read aloud by a screen reader — so this is the one plural on the screen a blind student hears.
   */
  'save.failure.detail': '{reason}: {count, plural, one {# attempt} other {# attempts}} so far.',

  /**
   * THE ORIGINAL SENTENCE WAS GRAMMATICALLY WRONG IN ENGLISH, NOT JUST UNTRANSLATABLE.
   *
   * It read `` {n} block{n === 1 ? '' : 's'} need a decision ``, so one conflicting block rendered
   * "1 block need a decision". Splitting the verb into the arms is what fixes English AND is what a
   * four-form language needs, so the two things were the same change.
   */
  'save.conflict.detail': '{count, plural, one {# block needs a} other {# blocks need a}} decision',

  'save.action.retry': 'Try again now',
  'save.action.review': 'Review',

  /**
   * A `{when, date}` PLACEHOLDER, NOT A FORMATTED STRING.
   *
   * The component used to render `new Date(at).toISOString()` — `2026-09-27T12:00:00.000Z` — into a
   * `role="status"`. Read aloud, that is a stream of letters, digits and punctuation, and read
   * visually it is a machine timestamp in a sentence about a person. The date format is a property
   * of the locale, so it lives in the message and the format comes from `Intl`.
   */
  'save.saved.at': 'at {when, date, medium}',
} as const;

/**
 * `en-US`. NOT A TRANSLATION — see the header. Kept `as const` for the same reason as `enGB`.
 */
export const enUS = {
  'deadline.relative.underAMinute': 'in less than a minute',
  'deadline.relative.minutes': 'in {count, plural, one {# minute} other {# minutes}}',
  'deadline.relative.hours': 'in {count, plural, one {# hour} other {# hours}}',
  'deadline.relative.days': 'in {count, plural, one {# day} other {# days}}',

  'save.state.idle': 'No changes',
  'save.state.dirty': 'Unsaved changes',
  'save.state.saving': 'Saving…',
  'save.state.saved': 'Saved',
  'save.state.failed': "Couldn't save — retrying",
  'save.state.conflict': 'Someone else saved first',

  'save.failure.detail': '{reason}: {count, plural, one {# attempt} other {# attempts}} so far.',

  'save.conflict.detail': '{count, plural, one {# block needs a} other {# blocks need a}} decision',

  'save.action.retry': 'Try again now',
  'save.action.review': 'Review',

  'save.saved.at': 'at {when, date, medium}',
} as const;

/** Every key the SOURCE locale defines. This union is the type-level completeness guarantee. */
export type MessageKey = keyof typeof enGB;

/** Every locale a build must ship a catalogue for, keyed by tag. */
export const CATALOGUES = {
  'en-GB': enGB,
  'en-US': enUS,
} as const;

export type CatalogueTag = keyof typeof CATALOGUES;

/**
 * A catalogue that is COMPLETE WITH RESPECT TO THE SOURCE.
 *
 * `Record<MessageKey, string>` rather than `Partial<Record<…>>`: the whole point is that a
 * translator cannot be constructed from an incomplete catalogue, and `Partial` would permit exactly
 * that. This is the type-level guarantee the gate's key check then backs at runtime, for the cases
 * type-checking cannot see (a catalogue loaded from JSON, a `as` cast, a key deleted from the source
 * itself).
 */
export type CompleteCatalogue = Readonly<Record<MessageKey, string>>;

/** Is this value a complete catalogue for the source locale? Runtime twin of `CompleteCatalogue`. */
export function isCompleteCatalogue(value: unknown): value is CompleteCatalogue {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(enGB).every((key) => typeof record[key] === 'string');
}

/** The keys `value` has that the source does not. Named, because "it differs" is not actionable. */
export function orphanKeys(value: unknown): readonly string[] {
  if (typeof value !== 'object' || value === null) return [];
  return Object.keys(value as Record<string, unknown>)
    .filter((key) => !Object.hasOwn(enGB, key))
    .sort();
}

/** The source keys `value` lacks. Named for the same reason. */
export function missingKeys(value: unknown): readonly string[] {
  if (typeof value !== 'object' || value === null) return ['<the whole catalogue>'];
  const record = value as Record<string, unknown>;
  return Object.keys(enGB)
    .filter((key) => typeof record[key] !== 'string')
    .sort();
}

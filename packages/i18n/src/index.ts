/**
 * Locale-aware rendering, and specifically the rendering of DEADLINES.  (P1-T2, plans/15 §5)
 *
 * ## Timezone is not cosmetic
 *
 * `plans/15` is blunt about this: "Deadlines always render in the user's zone, with an
 * explicit timezone label", and U-9's resolution was that a visible deadline is itself a
 * fairness intervention. A student who reads "until Friday" and means a different Friday than
 * their teacher has been given a different exam.
 *
 * So the contract of `formatDeadline` is not "give me a string". It is:
 *
 *   · the instant,
 *   · rendered in a NAMED IANA zone,
 *   · with that zone's name and its UTC offset AT THAT INSTANT shown to the user,
 *   · and with a plain-language "that is N days/hours from now" relative clause when it is
 *     close enough for the absolute time to be hard to reason about.
 *
 * ## The bug this file is most likely to have
 *
 * **Rendering the UTC offset for "now" instead of for the deadline's instant.** A deadline
 * that falls after a daylight-saving transition shows an offset that is an hour out, and it
 * is out by exactly one hour — which is precisely the error a student cannot detect and a
 * teacher cannot explain. `2026-10-25T01:30Z` is `02:30` in London in summer and `01:30` in
 * winter, and the label must say which.
 *
 * The tests here pin real DST transition instants in real zones. Not a mock, and not
 * "roughly now" — a fixed instant, so the assertion is about the calendar and not about
 * whatever day the suite happens to run.
 *
 * ## WHAT MOVED OUT, AND WHY  (P13-T7)
 *
 * The locale vocabulary — `LOCALES`, `DEFAULT_LOCALE`, `resolveLocale`, the zone helpers —
 * now lives in `./locale.ts` and is re-exported here unchanged, because `./intl.ts` needs
 * `FALLBACK_ZONE` and a zone validity check, and leaving them here would make `intl` and this
 * file import each other. Nothing outside this package can tell, which is the point.
 *
 * **`describeDistance` NO LONGER DECIDES ITS OWN PLURALS.** It used to append `'s'`
 * when `n !== 1` — `n === 1 ? … : …` — which is correct in English and wrong in every language
 * with more than two forms. The phrases are now messages in `./catalogues.ts` with real ICU
 * plural arms, selected by `Intl.PluralRules` for the locale. The English output is byte-for-byte
 * what it was, which is why the existing tests are unchanged; what changed is what happens in a
 * locale that has four forms.
 */

import type { Duration, Millis } from '@orrery/clock';
import { enGB } from './catalogues.js';
import {
  DEFAULT_LOCALE,
  FALLBACK_ZONE,
  formatOffset,
  isValidZone,
  offsetMinutesAt,
  resolveLocale,
} from './locale.js';
import { formatMessage } from './message.js';

export { type AuditFinding, type AuditReport, type AuditRule, auditCatalogues } from './audit.js';
export type { CatalogueTag, CompleteCatalogue, MessageKey } from './catalogues.js';
/**
 * `CATALOGUES` IS EXPORTED SO AN APP DOES NOT HAVE TO KNOW WHERE THEY LIVE. An app that
 * imports `enGB` by path is an app whose path is a detail of this package's layout.
 */
export { CATALOGUES, enGB, enUS } from './catalogues.js';
export {
  formatterCacheSize,
  formattersFor,
  hasPluralCategoryList,
  type LocaleFormatters,
  localeFormatters,
  pluralCategories,
} from './intl.js';
/** Re-exported unchanged from `./locale.ts`; see the header. */
export {
  DEFAULT_LOCALE,
  FALLBACK_ZONE,
  formatOffset,
  isSupportedLocale,
  isValidZone,
  LOCALES,
  type Locale,
  offsetMinutesAt,
  offsetNameFrom,
  parseOffsetName,
  resolveLocale,
  SOURCE_LOCALE,
} from './locale.js';
export type {
  DateStyle,
  MessageArgs,
  MessageArgValue,
  MessageNode,
  NumberStyle,
} from './message.js';
/** Re-exported so `@orrery/i18n` stays ONE entry point. */
export {
  categoriesCovered,
  compiledCount,
  formatMessage,
  hasPlural,
  isCategoryKeyword,
  MessageSyntaxError,
  PluralCategoryGapError,
  parseMessage,
  placeholdersIn,
} from './message.js';
export { createTranslator, type MessageIssue, type Translator } from './translator.js';

export interface DeadlineRender {
  /** The absolute local rendering, e.g. `Fri 25 Oct 2026, 01:30`. */
  readonly local: string;
  /** The explicit zone label. `U-9`: a student must never wonder which zone this is. */
  readonly zoneLabel: string;
  /** e.g. `Europe/London (GMT+01:00)`. */
  readonly zoneWithOffset: string;
  /** The UTC instant, so a screen reader or a tooltip can state it unambiguously. */
  readonly utc: string;
  /** Plain-language distance, e.g. `in 2 days`, or null when it is too far to be useful. */
  readonly relative: string | null;
  /** True when the reader's zone differs from the zone this was rendered in. */
  readonly differsFromReader: boolean;
}

export interface FormatDeadlineInput {
  readonly instant: Millis;
  /** The zone to render in. Falls back to UTC, and the fallback is visible in `zoneLabel`. */
  readonly zone: string | null | undefined;
  readonly locale: string | null | undefined;
  /** The reader's own zone, to decide whether to flag a difference. */
  readonly readerZone?: string | null;
  readonly now: Millis;
}

/**
 * Render a deadline.
 *
 * `relative` is suppressed beyond 7 days. "In 94 days" is noise that pushes the actual date
 * out of the reader's attention, and the absolute date is the thing they need. It is also
 * suppressed beyond the past, where it would be "94 days ago" — for a closed deadline the
 * date alone is right, and "in -94 days" would be a bug.
 */
export function formatDeadline(input: FormatDeadlineInput): DeadlineRender {
  const { instant, now } = input;
  const zone = input.zone && isValidZone(input.zone) ? input.zone : FALLBACK_ZONE;
  const { locale } = resolveLocale(input.locale);
  const offset = offsetMinutesAt(instant, zone);

  const formatter = new Intl.DateTimeFormat(locale, {
    timeZone: zone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  return {
    local: formatter.format(new Date(instant)),
    zoneLabel: zone,
    zoneWithOffset: `${zone} (GMT${formatOffset(offset)})`,
    // Rendered in UTC deliberately: this is the unambiguous fallback for anyone confused by
    // the local rendering, and it must not itself depend on a zone.
    utc: `${new Date(instant).toISOString().replace('.000', '')} UTC`,
    relative: describeDistance(instant, now, locale),
    differsFromReader:
      input.readerZone !== null &&
      input.readerZone !== undefined &&
      isValidZone(input.readerZone) &&
      input.readerZone !== zone,
  };
}

/**
 * Plain-language distance, or null when it would be noise.
 *
 * Deliberately coarse. "in 2 days" is a useful thing to read at a glance; "in 2 days, 4 hours
 * and 17 minutes" is a second thing to get wrong, and a student's confidence in the coarse
 * version is what matters at the moment they decide whether to start.
 *
 * Rounds UP, so a deadline 1ms away reads `in less than a minute` rather than `now`, and one
 * 60.001s away reads `in 2 minutes`. A deadline that reads `in 1 minute` when it has already
 * passed is a bug in the reassurance, not in the arithmetic.
 *
 * **`locale` IS OPTIONAL AND DEFAULTS TO THE SOURCE, NOT TO THE HOST.** The phrases are messages
 * with ICU plural arms, so the grammatical form is `Intl.PluralRules`' to choose. The old
 * `n === 1 ? '' : 's'` had no locale to consult and hard-coded English's two forms; there is no
 * spelling of that which is right anywhere but English.
 */
export function describeDistance(
  instant: Millis,
  now: Millis,
  locale: string | null | undefined = DEFAULT_LOCALE,
): string | null {
  const delta = instant - now;
  if (delta <= 0) return null;
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;
  if (delta < MINUTE) return relative('underAMinute', null, locale);
  if (delta < HOUR) return relative('minutes', Math.ceil(delta / MINUTE), locale);
  if (delta < DAY) return relative('hours', Math.ceil(delta / HOUR), locale);
  const days = Math.ceil(delta / DAY);
  if (days > 7) return null;
  return relative('days', days, locale);
}

type RelativePhrase = 'underAMinute' | 'minutes' | 'hours' | 'days';

/**
 * The four relative-distance messages, held ONCE, in the catalogue.
 *
 * `enGB` is the source catalogue rather than a second copy of these sentences: `P13-T8` is going to
 * rewrite this copy, and a second copy here would be a sentence that silently stopped being the one
 * a student reads. `resolveLocale` is applied to the locale rather than to the pattern, so a locale
 * we do not ship falls back to the source phrases — the same fallback a stored profile gets, and
 * the fallback is visible in `resolveLocale`'s `fellBack`.
 *
 * `count: null` marks the arm with no number in it. A fourth key for a sentence that is not a count
 * would make the key count a lie.
 */
function relative(
  which: RelativePhrase,
  count: number | null,
  locale: string | null | undefined,
): string {
  return formatMessage(enGB[`deadline.relative.${which}`], count === null ? {} : { count }, {
    locale: resolveLocale(locale).locale,
    timeZone: FALLBACK_ZONE,
  });
}

/**
 * Whether a deadline is close enough that the UI should escalate its treatment.
 *
 * A separate function from the rendering because the ESCALATION is a product decision
 * ("this needs a banner") and the rendering is a formatting one, and merging them means a
 * future copy change can accidentally change which deadlines get a banner.
 */
export function isUrgent(
  instant: Millis,
  now: Millis,
  threshold: Duration = 2 * 60 * 60_000,
): boolean {
  const delta = instant - now;
  return delta > 0 && delta <= threshold;
}

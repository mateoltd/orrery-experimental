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
 */

import type { Duration, Millis } from '@orrery/clock';

/** Shipped in v1. A third, non-Latin locale at GA — chosen to stress the framework. */
export const LOCALES = ['en-GB', 'en-US'] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'en-GB';

export function isSupportedLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}

/**
 * Resolve a stored locale, falling back rather than throwing.
 *
 * A profile with a locale this build does not ship must still render — a student who set
 * `de-DE` while it was available must not get a 500 because we removed it. The fallback is
 * recorded so the UI can offer to switch rather than silently changing their reading.
 */
export function resolveLocale(value: string | null | undefined): {
  locale: Locale;
  fellBack: boolean;
} {
  if (value === null || value === undefined) return { locale: DEFAULT_LOCALE, fellBack: false };
  return isSupportedLocale(value)
    ? { locale: value, fellBack: false }
    : { locale: DEFAULT_LOCALE, fellBack: true };
}

/**
 * The IANA zone used when a profile has none, and the zone the CONTENT is authored in.
 *
 * `UTC` rather than the server's local zone. A deadline stored as an instant is unaffected,
 * but anything that formats a bare date with no zone attached is affected by the process's
 * `TZ`, and a build server in `America/Chicago` must not become the product's timezone.
 */
export const FALLBACK_ZONE = 'UTC';

/** Is this a zone the runtime actually knows? */
export function isValidZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The UTC offset of `zone` AT `instant`, in minutes.
 *
 * Per-instant, not "now". Derived by formatting the instant in the zone, reading the
 * `timeZoneName: 'longOffset'` part, and parsing it — which is the only reliable way, since
 * the offset is a property of the zone's rules at that moment and there is no portable API
 * that hands it to you directly.
 */
export function offsetMinutesAt(instant: Millis, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    timeZoneName: 'longOffset',
    hour12: false,
  }).formatToParts(new Date(instant));
  return parseOffsetName(offsetNameFrom(parts));
}

/**
 * Pull the `timeZoneName` part out of a `formatToParts` result.
 *
 * Extracted purely so the no-part case is TESTABLE. Every real IANA zone emits the part, so
 * the `?? 'GMT+00:00'` fallback was unreachable through the public API and therefore
 * unverified — and an unverified default in a deadline renderer is an unverified timezone
 * label. `offsetNameFrom([])` is now directly assertable.
 */
export function offsetNameFrom(parts: readonly Intl.DateTimeFormatPart[]): string {
  return parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT+00:00';
}

/** `GMT+01:00`, `GMT-05:00`, `GMT` -> minutes east of UTC. */
export function parseOffsetName(name: string): number {
  const match = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(name);
  if (!match) return 0;
  const [, sign, hours, minutes] = match;
  const total = Number(hours) * 60 + Number(minutes ?? 0);
  return sign === '-' ? -total : total;
}

/** `+01:00` / `-05:30` / `+00:00`. */
export function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  const h = String(Math.floor(abs / 60)).padStart(2, '0');
  const m = String(abs % 60).padStart(2, '0');
  return `${sign}${h}:${m}`;
}

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
    relative: describeDistance(instant, now),
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
 */
export function describeDistance(instant: Millis, now: Millis): string | null {
  const delta = instant - now;
  if (delta <= 0) return null;
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;
  if (delta < MINUTE) return 'in less than a minute';
  if (delta < HOUR)
    return `in ${Math.ceil(delta / MINUTE)} minute${plural(Math.ceil(delta / MINUTE))}`;
  if (delta < DAY) return `in ${Math.ceil(delta / HOUR)} hour${plural(Math.ceil(delta / HOUR))}`;
  const days = Math.ceil(delta / DAY);
  if (days > 7) return null;
  return `in ${days} day${plural(days)}`;
}

const plural = (n: number): string => (n === 1 ? '' : 's');

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

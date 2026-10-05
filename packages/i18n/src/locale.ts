/**
 * The locale vocabulary: which locales ship, which one is the source, and what a zone is.
 *
 * ## WHY THIS IS A SEPARATE MODULE
 *
 * **`./intl.ts` NEEDS A FALLBACK ZONE AND A DEFAULT LOCALE, AND `./index.ts` NEEDS `./intl.ts`.**
 * Leaving the vocabulary where it was means `intl` imports `index`, `index` imports `intl`, and the
 * two depend on import order to initialise. It happens to work only because neither module reads
 * the other's exports at module-evaluation time — a property nothing enforces and a refactor breaks.
 *
 * So the vocabulary lives here and `index.ts` re-exports it, which leaves its public surface and
 * its existing tests untouched. `LOCALES` is a shipping decision; formatting capability is not, so
 * `localeFormatters` deliberately takes a plain `string` and this file is the only place a locale
 * becomes restricted to the set we happen to ship.
 */

import type { Millis } from '@orrery/clock';

/** Shipped in v1. A third, non-Latin locale at GA — chosen to stress the framework. */
export const LOCALES = ['en-GB', 'en-US'] as const;
export type Locale = (typeof LOCALES)[number];

/**
 * **THE SOURCE LOCALE, AND `i18n:check` PRINTS IT ON EVERY RUN.**
 *
 * Two catalogues compared for equality cannot tell which is authoritative, so a gate that only
 * compares them will happily report "en-US is missing 3 keys" when the real fault is that three keys
 * were deleted from `en-GB`. This value is the answer, it is exported rather than inferred, and the
 * gate names it before it reports anything.
 */
export const DEFAULT_LOCALE: Locale = 'en-GB';

/** The one locale a translator may fall back to, named as the SOURCE so the two cannot drift. */
export const SOURCE_LOCALE = DEFAULT_LOCALE;

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

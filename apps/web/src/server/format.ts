/**
 * Date formatting for labels the server owns.  (P4-T6)
 *
 * ## WHY A SERVER-SIDE FORMATTER AND NOT `toLocaleDateString`
 *
 * Because `toLocaleDateString` formats in the VIEWER's locale and timezone. A teacher in
 * Auckland and a teacher in Cardiff open the same roster and see different join dates, and both are
 * seeing "the same" data. For a school that spans more than one timezone that is not a cosmetic
 * inconsistency; it is two staff rooms disagreeing about when a child joined.
 *
 * So the server decides, once, in UTC, and the component receives a string. The rule is
 * deliberately dull: an unambiguous ISO calendar date, and nothing about the time of day, because
 * a roster is a list of people and not an audit log.
 *
 * `isoNow` is from `@orrery/clock` per INV-TIME-1. This module has no clock of its own because it
 * does not need one — it is handed the instant by the caller.
 */

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/** `2026-09-01`, and an obviously-broken marker rather than `Invalid Date` for a bad input. */
export function isoDate(instant: Date): string {
  if (Number.isNaN(instant.getTime())) return 'unknown date';
  const y = instant.getUTCFullYear();
  const m = MONTHS[instant.getUTCMonth()] ?? '???';
  const d = String(instant.getUTCDate()).padStart(2, '0');
  return `${d} ${m} ${y}`;
}

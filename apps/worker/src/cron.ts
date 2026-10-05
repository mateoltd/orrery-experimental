/**
 * A job's declared interval, translated into a cron expression — or refused.  (P0-T7)
 *
 * ## WHY THIS MODULE EXISTS RATHER THAN A `setInterval`
 *
 * `plans/03` §2 puts the worker behind Inngest precisely because a queue gives durable retries and step
 * history. A `setInterval` loop gives neither: a crash loses the tick, a slow tick piles up behind
 * itself, and there is no record of what ran. The translation from "runs every N seconds" to "a cron
 * expression" is therefore load-bearing, and it is the one place a silently-changed cadence would do
 * real damage — a retention sweep that quietly runs hourly instead of daily is a privacy failure, and
 * nobody would see it.
 *
 * ## THE HAZARD IS THAT INNGEST CRON RESOLVES TO ONE MINUTE
 *
 * A five-field cron expression — `minute hour day-of-month month day-of-week` — has no sub-minute
 * field at all. So the two failure modes a translation can have are both real here:
 *
 *   1. **Rounding silently.** A 30-second job scheduled as `* * * * *` runs half as often as declared,
 *      and the declaration in `JOBS` still says 30. Two sources of truth, one of them a lie.
 *   2. **Refusing at boot.** A job whose interval no cron field can express cannot be scheduled, and
 *      the honest response to that is a refusal at boot rather than an approximation nobody reads.
 *
 * So `cronFor` refuses both. It returns a cron expression only when the declared interval is exactly
 * what that expression will do, and it throws otherwise — carrying the reason, because "cannot
 * schedule 90 seconds" and "cannot schedule 10 seconds" have completely different fixes: the first is
 * a rounding decision for whoever declared the job, the second is `C3`'s finding that the deadline
 * sweep belongs on `pg_cron`.
 */

/** Inngest's cron has five fields and its finest resolution is one minute. */
export const CRON_FIELDS = 5;

/** The floor. Anything faster is a `pg_cron` job, and `C3` is the reason why. */
export const MINUTE_SECONDS = 60;

/**
 * Minute counts that divide an hour exactly, so a step of n in the minute field really does mean
 * "every n minutes". A minute count outside this set cannot be expressed as a step in that field
 * without lying about the cadence, which is why it is refused rather than approximated.
 */
const MINUTE_DIVISORS: readonly number[] = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30];

/**
 * Hour counts that divide a day exactly, for the same reason. A step of 3 in the hour field fires at
 * 00:00, 03:00, 06:00 … 21:00 and then not again until tomorrow, which is a nine-hour gap nobody
 * declared.
 */
const HOUR_DIVISORS: readonly number[] = [1, 2, 3, 4, 6, 8, 12, 24];

/** Why an interval cannot be scheduled. Three distinct fixes, so three distinct reasons. */
export type UnschedulableReason =
  /** Below the one-minute floor: `pg_cron`, which is where the deadline sweep lives (`C3`). */
  | 'sub-minute'
  /** Above the floor but not expressible: the declaration must change, not the cron. */
  | 'not-expressible'
  /** Not a positive whole number of seconds at all. */
  | 'invalid';

export class UnschedulableIntervalError extends Error {
  readonly everySeconds: number;
  readonly reason: UnschedulableReason;

  constructor(everySeconds: number, reason: UnschedulableReason) {
    super(message(everySeconds, reason));
    this.name = 'UnschedulableIntervalError';
    this.everySeconds = everySeconds;
    this.reason = reason;
  }
}

/**
 * THE MESSAGE NAMES THE FIX, because an operator reading a boot failure at 3 a.m. needs to know which
 * of three different decisions they are being asked to make — and because the sub-minute case has a
 * documented answer already (`pg_cron`, behind an advisory lock) that is easy to forget.
 */
function message(everySeconds: number, reason: UnschedulableReason): string {
  switch (reason) {
    case 'sub-minute':
      return (
        `${String(everySeconds)}s is below the one-minute floor of a cron expression (${CRON_FIELDS} fields, ` +
        'minute resolution). Inngest cannot schedule it; the deadline sweep runs on pg_cron behind an ' +
        'advisory lock instead, and a sub-minute job belongs there too.'
      );
    case 'not-expressible':
      return (
        `${String(everySeconds)}s has no cron expression that fires exactly that often. Round it to a ` +
        'whole number of minutes or to an hour divisor — silently scheduling a different cadence is ' +
        'how a declared interval stops meaning anything.'
      );
    case 'invalid':
      return `${String(everySeconds)} is not a positive whole number of seconds.`;
  }
}

/**
 * The cron expression for an interval, or a typed refusal.
 *
 * Five minutes becomes a five-minute step, and ten seconds throws — which is the deadline sweep's
 * declared interval, and the mechanical reason it cannot be scheduled here rather than a convention.
 */
export function cronFor(everySeconds: number): string {
  if (!Number.isInteger(everySeconds) || everySeconds <= 0) {
    throw new UnschedulableIntervalError(everySeconds, 'invalid');
  }
  if (everySeconds < MINUTE_SECONDS) {
    throw new UnschedulableIntervalError(everySeconds, 'sub-minute');
  }
  const minutes = everySeconds / MINUTE_SECONDS;
  if (!Number.isInteger(minutes)) {
    throw new UnschedulableIntervalError(everySeconds, 'not-expressible');
  }
  if (MINUTE_DIVISORS.includes(minutes)) {
    return minutes === 1 ? '* * * * *' : `*/${String(minutes)} * * * *`;
  }
  const hours = minutes / 60;
  if (Number.isInteger(hours) && HOUR_DIVISORS.includes(hours)) {
    if (hours === 24) return '0 0 * * *';
    return hours === 1 ? '0 * * * *' : `0 */${String(hours)} * * *`;
  }
  throw new UnschedulableIntervalError(everySeconds, 'not-expressible');
}

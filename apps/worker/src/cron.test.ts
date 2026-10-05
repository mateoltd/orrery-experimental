/**
 * The interval-to-cron translation, and the three ways it can be wrong.
 *
 * Every property here is stated as a refusal or an exact expression, because the failure mode this
 * module exists to prevent is a *plausible* cron string that fires at a different cadence than the one
 * `JOBS` declares. A scheduler that quietly under-runs a job is indistinguishable from a healthy one
 * until someone reads the logs.
 */

import { describe, expect, it } from 'vitest';
import { cronFor, MINUTE_SECONDS, UnschedulableIntervalError } from './cron.js';

describe('cron translation', () => {
  it('expresses every interval the scheduled jobs actually declare', () => {
    // The exact-expression cases, pinned. `* * * * *` rather than `*/1`, because a reader should be
    // able to see the cadence at a glance.
    expect(cronFor(60)).toBe('* * * * *');
    expect(cronFor(120)).toBe('*/2 * * * *');
    expect(cronFor(300)).toBe('*/5 * * * *');
    expect(cronFor(1800)).toBe('*/30 * * * *');
  });

  it('expresses hour and day cadences without pretending a step of n means every n hours', () => {
    expect(cronFor(3600)).toBe('0 * * * *');
    expect(cronFor(7200)).toBe('0 */2 * * *');
    // 24 hours is `0 0 * * *`, not `0 */24 * * *` — the hour field has no value 24.
    expect(cronFor(86_400)).toBe('0 0 * * *');
  });

  it('REFUSES a sub-minute interval rather than rounding it up', () => {
    // The deadline sweep's interval. `C3`: Inngest has no sub-minute cron, so a 10-second sweep here
    // would have to become a 60-second one — and a 60-second sweep auto-submits a minute late.
    expect(() => cronFor(10)).toThrow(UnschedulableIntervalError);
    expect(() => cronFor(10)).toThrow(/pg_cron/);
    try {
      cronFor(10);
      expect.unreachable('cronFor(10) must not return a cron expression');
    } catch (error) {
      expect(error).toBeInstanceOf(UnschedulableIntervalError);
      expect((error as UnschedulableIntervalError).reason).toBe('sub-minute');
      expect((error as UnschedulableIntervalError).everySeconds).toBe(10);
    }
  });

  it('refuses 30s specifically, because that is the cadence most likely to be wished into existence', () => {
    expect(() => cronFor(30)).toThrow(/below the one-minute floor/);
  });

  it('refuses an interval a cron field cannot express, instead of rounding it to a neighbour', () => {
    // 90s has no exact expression. Rounding down to 60s runs it more often than declared; rounding up
    // to 120s runs it less often. Both are lies, and neither is visible without reading the cron.
    for (const seconds of [90, 100, 700, 1500, 4320]) {
      expect(() => cronFor(seconds), `${String(seconds)}s must be refused`).toThrow(
        UnschedulableIntervalError,
      );
    }
    expect(() => cronFor(90)).toThrow(/no cron expression that fires exactly that often/);
  });

  it('refuses a non-interval, so a typo cannot become an unscheduled job', () => {
    for (const seconds of [0, -60, 30.5, Number.NaN]) {
      expect(() => cronFor(seconds), `${String(seconds)} must be refused`).toThrow(
        UnschedulableIntervalError,
      );
    }
    expect(() => cronFor(Number.NaN)).toThrow(/not a positive whole number/);
  });

  it('states the floor it is enforcing, so the sweep rule is readable from the module', () => {
    expect(MINUTE_SECONDS).toBe(60);
  });

  it('the error names the job interval it refused, because "unschedulable" alone is not actionable', () => {
    const error = new UnschedulableIntervalError(3000, 'not-expressible');
    expect(error.message).toContain('3000');
    expect(error.name).toBe('UnschedulableIntervalError');
  });
});

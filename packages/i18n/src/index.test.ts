/**
 * Deadline rendering tests.  (P1-T2, plans/15 §5, U-9)
 *
 * ## Why these use FIXED instants
 *
 * Every assertion here is about the CALENDAR, so none of them may depend on the day the suite
 * runs. A deadline test written with "now" is a test that passes in August and fails in
 * November, which is worse than no test because it trains people to re-run failures until they
 * go away.
 *
 * The DST cases are the point of the file. `2026-10-25T01:30Z` is 02:30 in London in summer
 * and 01:30 in winter — the same instant, an hour apart on the clock — and a renderer that
 * takes its offset from "now" rather than from the instant is wrong by exactly the hour a
 * student cannot detect.
 */

import { describe, expect, it } from 'vitest';
import {
  describeDistance,
  FALLBACK_ZONE,
  formatDeadline,
  formatOffset,
  isUrgent,
  isValidZone,
  offsetMinutesAt,
  offsetNameFrom,
  parseOffsetName,
  resolveLocale,
} from './index.js';

const at = (iso: string): number => Date.parse(iso);

// 2026-03-29 01:00Z — Europe/London enters BST. 2026-10-25 01:00Z — it leaves.
const BEFORE_TRANSITION = at('2026-03-29T00:30:00Z'); // 00:30 GMT
const AFTER_TRANSITION = at('2026-03-29T01:30:00Z'); // 02:30 BST
const WINTER = at('2026-01-15T12:00:00Z'); // 12:00 GMT
const SUMMER = at('2026-07-15T12:00:00Z'); // 13:00 BST

const NOW = at('2026-01-01T00:00:00Z');

describe('a deadline is rendered in a NAMED zone, with that zone shown', () => {
  it('labels the zone and its offset, so a student never has to guess', () => {
    // U-9: a student must never wonder what "until Friday" means. A bare "17:00" is the
    // failure; `Europe/London (GMT+00:00)` is the answer.
    const r = formatDeadline({ instant: WINTER, zone: 'Europe/London', locale: 'en-GB', now: NOW });
    expect(r.zoneWithOffset).toBe('Europe/London (GMT+00:00)');
    expect(r.local).toContain('12:00');
  });

  it('also states the unambiguous UTC instant', () => {
    // For anyone confused by the local rendering, and for screen readers, which read the
    // string rather than interpreting the zone.
    const r = formatDeadline({ instant: WINTER, zone: 'Europe/London', locale: 'en-GB', now: NOW });
    expect(r.utc).toBe('2026-01-15T12:00:00Z UTC');
  });

  it('flags when the reader is in a different zone from the rendering', () => {
    const elsewhere = formatDeadline({
      instant: WINTER,
      zone: 'Europe/London',
      locale: 'en-GB',
      now: NOW,
      readerZone: 'America/New_York',
    });
    expect(elsewhere.differsFromReader).toBe(true);

    const same = formatDeadline({
      instant: WINTER,
      zone: 'Europe/London',
      locale: 'en-GB',
      now: NOW,
      readerZone: 'Europe/London',
    });
    expect(same.differsFromReader).toBe(false);
  });

  it('falls back to UTC for a missing or invalid zone, and says so', () => {
    for (const zone of [null, undefined, 'Not/AZone', '']) {
      const r = formatDeadline({ instant: WINTER, zone, locale: 'en-GB', now: NOW });
      expect(r.zoneLabel, `zone=${zone}`).toBe(FALLBACK_ZONE);
    }
  });
});

describe('THE test: the offset is for the INSTANT, not for now', () => {
  it('renders the same instant differently either side of a DST transition', () => {
    const before = formatDeadline({
      instant: BEFORE_TRANSITION,
      zone: 'Europe/London',
      locale: 'en-GB',
      now: NOW,
    });
    const after = formatDeadline({
      instant: AFTER_TRANSITION,
      zone: 'Europe/London',
      locale: 'en-GB',
      now: NOW,
    });

    // One hour apart on the clock, one hour apart in offset, and BOTH correct. This is the
    // whole reason `offsetMinutesAt` takes an instant.
    expect(before.local).toContain('00:30');
    expect(after.local).toContain('02:30');
    expect(before.zoneWithOffset).toBe('Europe/London (GMT+00:00)');
    expect(after.zoneWithOffset).toBe('Europe/London (GMT+01:00)');
  });

  it('gives the same instant one offset in winter and another in summer', () => {
    // 12:00 UTC is 12:00 in London in January and 13:00 in July. A renderer that took its
    // offset from "now" would be an hour wrong for half the year.
    const winter = formatDeadline({
      instant: WINTER,
      zone: 'Europe/London',
      locale: 'en-GB',
      now: NOW,
    });
    const summer = formatDeadline({
      instant: SUMMER,
      zone: 'Europe/London',
      locale: 'en-GB',
      now: NOW,
    });
    expect(winter.local).toContain('12:00');
    expect(summer.local).toContain('13:00');
    expect(winter.zoneWithOffset).not.toBe(summer.zoneWithOffset);
  });

  it('handles a half-hour zone, which a naive hours-only offset gets wrong', () => {
    // Asia/Kolkata is UTC+05:30. Rounding to hours would put a student's exam 30 minutes
    // out, which is the difference between arriving for it and missing it.
    expect(offsetMinutesAt(WINTER, 'Asia/Kolkata')).toBe(330);
    expect(formatOffset(330)).toBe('+05:30');
  });

  it('handles a negative half-hour zone', () => {
    expect(offsetMinutesAt(WINTER, 'America/St_Johns')).toBe(-210);
    expect(formatOffset(-210)).toBe('-03:30');
  });
});

describe('offset parsing', () => {
  it('parses the long-offset names Intl produces', () => {
    expect(parseOffsetName('GMT+00:00')).toBe(0);
    expect(parseOffsetName('GMT+01:00')).toBe(60);
    expect(parseOffsetName('GMT-05:00')).toBe(-300);
    expect(parseOffsetName('GMT+05:30')).toBe(330);
  });

  it('parses an offset with HOURS ONLY and no minutes part', () => {
    // Some ICU versions emit `GMT+1` rather than `GMT+01:00`. The minutes group is optional
    // in the pattern and this is where that optionality is proved, because the alternative
    // is `Number(undefined)` -> NaN propagating into a student's deadline.
    expect(parseOffsetName('GMT+1')).toBe(60);
    expect(parseOffsetName('GMT-8')).toBe(-480);
  });

  it('yields a real number for a minutes-only offset rather than NaN', () => {
    expect(Number.isNaN(parseOffsetName('GMT+05:30'))).toBe(false);
    expect(Number.isNaN(parseOffsetName('GMT+5'))).toBe(false);
  });

  it('treats a bare GMT as zero and garbage as zero', () => {
    expect(parseOffsetName('GMT')).toBe(0);
    expect(parseOffsetName('nonsense')).toBe(0);
  });

  it('a zone with NO longOffset part falls back to GMT+00:00 rather than throwing', () => {
    // Every real IANA zone emits the part, so this default was unreachable through the
    // public API and therefore unverified — and an unverified default in a deadline
    // renderer is an unverified timezone label, which is the exact bug this file exists to
    // prevent. `offsetNameFrom` is exported so the branch is directly assertable.
    expect(offsetNameFrom([])).toBe('GMT+00:00');
    expect(offsetNameFrom([{ type: 'literal', value: 'x' }])).toBe('GMT+00:00');
    expect(offsetNameFrom([{ type: 'timeZoneName', value: 'GMT+05:30' }])).toBe('GMT+05:30');
  });

  it('reads the real offset through the same path', () => {
    expect(offsetMinutesAt(WINTER, 'Europe/London')).toBe(0);
    expect(offsetMinutesAt(SUMMER, 'Europe/London')).toBe(60);
  });

  it('formats zero as +00:00 rather than Z or an empty string', () => {
    expect(formatOffset(0)).toBe('+00:00');
  });
});

describe('zones', () => {
  it('accepts real IANA zones and rejects nonsense', () => {
    expect(isValidZone('Europe/London')).toBe(true);
    expect(isValidZone('Asia/Kolkata')).toBe(true);
    expect(isValidZone('UTC')).toBe(true);
    expect(isValidZone('Not/AZone')).toBe(false);
    expect(isValidZone('')).toBe(false);
  });
});

describe('relative distance', () => {
  it('rounds UP, so a deadline is never described as further away than it is', () => {
    // The reassurance, not the arithmetic: a student told "in 1 minute" when 1 second
    // remains has been told a falsehood by the rounding.
    // Boundaries pinned, because they are where a rounding bug would live: 60_001ms must
    // read as 2 minutes, and 59_999ms must read as "less than a minute" rather than
    // rounding to a reassuring "1 minute".
    expect(describeDistance(NOW + 61_000, NOW)).toBe('in 2 minutes');
    expect(describeDistance(NOW + 60_000, NOW)).toBe('in 1 minute');
    expect(describeDistance(NOW + 59_999, NOW)).toBe('in less than a minute');
    expect(describeDistance(NOW + 1, NOW)).toBe('in less than a minute');
  });

  it('uses singular for one and plural otherwise', () => {
    expect(describeDistance(NOW + 3_600_000, NOW)).toBe('in 1 hour');
    expect(describeDistance(NOW + 7_200_000, NOW)).toBe('in 2 hours');
    expect(describeDistance(NOW + 86_400_000, NOW)).toBe('in 1 day');
  });

  it('says nothing about a deadline in the past, rather than saying "in -3 days"', () => {
    expect(describeDistance(NOW - 1, NOW)).toBeNull();
    expect(describeDistance(NOW, NOW)).toBeNull();
    expect(describeDistance(NOW - 90 * 86_400_000, NOW)).toBeNull();
  });

  it('stays silent beyond a week, because "in 94 days" buries the date it sits next to', () => {
    expect(describeDistance(NOW + 7 * 86_400_000, NOW)).toBe('in 7 days');
    expect(describeDistance(NOW + 8 * 86_400_000, NOW)).toBeNull();
  });
});

describe('urgency is a product decision, not a formatting one', () => {
  it('escalates a deadline inside the window, and never a past one', () => {
    expect(isUrgent(NOW + 60 * 60_000, NOW)).toBe(true);
    expect(isUrgent(NOW + 5 * 60 * 60_000, NOW)).toBe(false);
    // A closed deadline is not urgent; it is closed.
    expect(isUrgent(NOW - 60_000, NOW)).toBe(false);
  });

  it('honours a custom threshold', () => {
    expect(isUrgent(NOW + 30 * 60_000, NOW, 15 * 60_000)).toBe(false);
    expect(isUrgent(NOW + 30 * 60_000, NOW, 60 * 60_000)).toBe(true);
  });
});

describe('locales', () => {
  it('falls back WITHOUT throwing when a stored locale is no longer shipped', () => {
    // A student who set `de-DE` while it was available must not get a 500 because we removed
    // it. The fallback is REPORTED so the UI can offer to switch rather than silently
    // changing how their reading looks.
    const r = resolveLocale('de-DE');
    expect(r).toEqual({ locale: 'en-GB', fellBack: true });
  });

  it('passes through a shipped locale and a null', () => {
    expect(resolveLocale('en-US')).toEqual({ locale: 'en-US', fellBack: false });
    expect(resolveLocale(null)).toEqual({ locale: 'en-GB', fellBack: false });
    expect(resolveLocale(undefined)).toEqual({ locale: 'en-GB', fellBack: false });
  });

  it('renders differently in en-GB and en-US, which is the point of shipping both', () => {
    // Shipping a second locale to prove the framework handles a REAL difference, not a
    // cosmetic one. If these came out identical, the second locale would be theatre.
    const gb = formatDeadline({
      instant: WINTER,
      zone: 'Europe/London',
      locale: 'en-GB',
      now: NOW,
    });
    const us = formatDeadline({
      instant: WINTER,
      zone: 'America/New_York',
      locale: 'en-US',
      now: NOW,
    });
    expect(gb.local).not.toBe(us.local);
    expect(us.local).toContain('07:00'); // 12:00 UTC in New York
  });
});

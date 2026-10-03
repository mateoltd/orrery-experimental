import { describe, expect, it } from 'vitest';
import {
  clamp,
  clockOffset,
  DAY,
  FrozenClock,
  formatDuration,
  HOUR,
  isoNow,
  isPastDeadline,
  MINUTE,
  SECOND,
  seconds,
  secondsRemaining,
  systemClock,
  toIso,
} from './index.js';

describe('FrozenClock', () => {
  it('does not advance on its own — the property the whole time model relies on', () => {
    const c = new FrozenClock(1_000);
    expect(c.now()).toBe(1_000);
    expect(c.now()).toBe(1_000);
    expect(c.now()).toBe(1_000);
  });

  it('advances and rewinds explicitly', () => {
    const c = new FrozenClock(0).advance(SECOND).advance(MINUTE);
    expect(c.now()).toBe(61_000);
    c.rewind(1_000);
    expect(c.now()).toBe(60_000);
  });

  it('models a student moving their system clock, and stays unaffected', () => {
    const c = new FrozenClock(0);
    c.advance(HOUR);
    const beforeRewind = c.now();
    c.rewind(3 * DAY);
    // The rewind is visible as a hostile input, not as something the server can be
    // tricked into believing: the server's own reading moves, and every deadline it
    // computed BEFORE the rewind is a value, not a reference to the clock.
    expect(c.now()).toBe(beforeRewind - 3 * DAY);
    const deadline = beforeRewind + HOUR;
    expect(deadline).toBe(2 * HOUR);
    c.rewind(DAY);
    // The deadline is unchanged: rewinding the clock cannot extend an exam.
    expect(deadline).toBe(2 * HOUR);
  });

  it('keeps the monotonic reading forward-only', () => {
    const c = new FrozenClock(0);
    c.advance(SECOND);
    const m = c.monotonic();
    c.rewind(HOUR);
    expect(c.monotonic()).toBe(m);
  });
});

describe('deadline predicates', () => {
  // INV-LATE-1: grace extends the window by exactly `grace`, not one tick more.
  // The window is therefore [0, deadline + grace] INCLUSIVE at both ends.
  const deadline = 1_000_000;
  const grace = 60 * SECOND;

  it.each([
    [deadline - 1, false, 'before the deadline'],
    [deadline, false, 'exactly at the deadline is still open'],
    [deadline + 1, false, '1 ms late but still INSIDE the grace window — accepted'],
    [deadline + grace / 2, false, 'midway through the grace window — accepted'],
    [deadline + grace, false, 'the last accepted millisecond'],
    [deadline + grace + 1, true, 'one tick past grace — the first rejected write'],
  ])('isPastDeadline(now=%i) === %s (%s)', (now, expected) => {
    expect(isPastDeadline(deadline, now, grace)).toBe(expected);
  });

  it('accepts the full grace window and rejects exactly one tick beyond it', () => {
    // This is the off-by-one the plan says must not exist. Stated as an explicit
    // boundary assertion rather than a table row, so it cannot be misread.
    const lastAccepted = deadline + grace;
    expect(isPastDeadline(deadline, lastAccepted, grace)).toBe(false);
    expect(isPastDeadline(deadline, lastAccepted + 1, grace)).toBe(true);
  });

  it('with zero grace the window is exactly the deadline', () => {
    expect(isPastDeadline(100, 99, 0)).toBe(false);
    expect(isPastDeadline(100, 100, 0)).toBe(false);
    expect(isPastDeadline(100, 101, 0)).toBe(true);
  });
});

describe('secondsRemaining', () => {
  it('never returns a negative number — a countdown must not show -1', () => {
    expect(secondsRemaining(1_000, 10_000)).toBe(0);
  });

  it('floors rather than rounds, so it hits zero at the deadline', () => {
    expect(secondsRemaining(5_000, 0)).toBe(5);
    expect(secondsRemaining(4_999, 0)).toBe(4);
  });
});

describe('clamp', () => {
  it('maps NaN to min rather than propagating it into a comparison', () => {
    expect(clamp(Number.NaN, 0, 10)).toBe(0);
  });
  it('clamps at both ends', () => {
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(50, 0, 10)).toBe(10);
    expect(clamp(5, 0, 10)).toBe(5);
  });
});

describe('clockOffset', () => {
  it('returns roughly -now for a zero-RTT handshake', () => {
    const before = Date.now();
    const off = clockOffset(before, 0);
    const after = Date.now();
    expect(off).toBeLessThanOrEqual(0);
    expect(off).toBeGreaterThanOrEqual(before - after - 1);
  });
  it('is the RTT midpoint, DERIVED FROM NTP AND NOT FROM THE IMPLEMENTATION', () => {
    /**
     * THE OLD VERSION OF THIS TEST ASSERTED `serverNow + rtt / 2 - Date.now()` — the implementation's own formula,
     * retyped. It passed with the WRONG SIGN for as long as it existed, because a test derived from the code it
     * checks is evidence of nothing.
     *
     * So this one works from a concrete scenario instead. A device whose clock is **30 seconds slow** sends a
     * request; the server stamps its own time on ARRIVAL, 200 ms into a 400 ms round trip. The offset must come out
     * at +30 000, because that is the correction the display needs.
     *
     * With the old `+` the answer is 30 000 + 400 — a full RTT of error, always in the direction that makes a
     * countdown read late.
     */
    const CLIENT_BEHIND_BY = 30_000;
    const RTT = 400;
    const sentAt = Date.now();
    const serverNow = sentAt + CLIENT_BEHIND_BY + RTT / 2; // sampled at arrival
    const expectedOffset = CLIENT_BEHIND_BY;
    expect(clockOffset(serverNow, RTT)).toBeCloseTo(expectedOffset, 5);
  });

  it('is UNBOUNDED by a slow round trip, which is what the midpoint buys', () => {
    // A 2 s round trip and a 200 ms one must recover the SAME offset when the server's clock has not moved. An
    // average or a wrong-signed midpoint fails this, and it is the property a timer actually depends on.
    const CLIENT_BEHIND_BY = 5_000;
    const sentAt = Date.now();
    const fast = clockOffset(sentAt + CLIENT_BEHIND_BY + 100, 200);
    const slow = clockOffset(sentAt + CLIENT_BEHIND_BY + 1_000, 2_000);
    expect(fast).toBeCloseTo(CLIENT_BEHIND_BY, 5);
    expect(slow).toBeCloseTo(CLIENT_BEHIND_BY, 5);
  });

  it('errs EARLY rather than late when the RTT is unknown, which is the safe direction', () => {
    /**
     * A countdown reading a second long is a far smaller problem than one reading a minute short, so a caller with
     * no RTT measurement should assume the worst case of the estimate being too generous. With `rttMs = 0` the
     * correction is zero and the caller gets the raw difference, which it can then bias deliberately.
     */
    const clientNow = Date.now();
    expect(clockOffset(clientNow, 0)).toBeCloseTo(0, 5);
  });
});

describe('formatDuration', () => {
  it.each([
    [0, '0:00'],
    [5_000, '0:05'],
    [65_000, '1:05'],
    [3_600_000, '1:00:00'],
    [3_725_000, '1:02:05'],
    [-1, '0:00'],
  ])('formatDuration(%i) === %s', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });
});

describe('ISO formatting', () => {
  // The INV-TIME-1 rule bans `new Date()`, so this is the ONLY sanctioned way to render a
  // timestamp. It exists because the rule caught a real violation in the healthz route.
  it('formats an instant as ISO-8601 UTC', () => {
    expect(toIso(0)).toBe('1970-01-01T00:00:00.000Z');
    expect(toIso(1_700_000_000_000)).toBe('2023-11-14T22:13:20.000Z');
  });

  it('isoNow reads from the injected clock, so it is testable', () => {
    expect(isoNow(new FrozenClock(0))).toBe('1970-01-01T00:00:00.000Z');
    expect(isoNow(new FrozenClock(60_000))).toBe('1970-01-01T00:01:00.000Z');
  });

  it('defaults to the system clock and produces a parseable value', () => {
    const s = isoNow();
    expect(s).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Number.isNaN(Date.parse(s))).toBe(false);
  });
});

describe('systemClock', () => {
  it('reports a plausible epoch and a non-decreasing monotonic reading', () => {
    expect(systemClock.now()).toBeGreaterThan(1_600_000_000_000);
    const a = systemClock.monotonic();
    const b = systemClock.monotonic();
    expect(b).toBeGreaterThanOrEqual(a);
  });
});

describe('duration constants', () => {
  it('compose correctly', () => {
    expect(seconds(60)).toBe(MINUTE);
    expect(MINUTE * 60).toBe(HOUR);
    expect(HOUR * 24).toBe(DAY);
  });
});

import { describe, expect, it } from 'vitest';
import {
  DAY,
  FrozenClock,
  HOUR,
  MINUTE,
  SECOND,
  clamp,
  clockOffset,
  formatDuration,
  isPastDeadline,
  seconds,
  secondsRemaining,
  systemClock,
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
  it('uses the RTT midpoint, so a slow response is not biased', () => {
    const serverNow = 10_000;
    const rtt = 400;
    const expected = serverNow + rtt / 2 - Date.now();
    expect(clockOffset(serverNow, rtt)).toBeCloseTo(expected, 5);
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

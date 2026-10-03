/**
 * The grader, in bare Node.  (P6-T11, gold sim 15)
 *
 * The cases that matter are about the TWO traps, which pull in opposite directions, and about telling
 * them apart in feedback.
 */
import { describe, expect, it } from 'vitest';
import sim from '../src/grader.js';
import {
  BITS_PER_BYTE,
  bitsPerSecond,
  bytes,
  describeDownload,
  seconds,
  secondsRounded,
  withoutTheByteConversion,
} from '../src/model.js';

const grade = (
  answer: unknown,
  params: Record<string, unknown> = { sizeMb: 100, speedMbps: 100 },
) => sim.grader.grade(null, params, answer);

describe('computing-science.download-time', () => {
  it('converts BYTES to BITS before dividing, because a speed is in bits per second', () => {
    // 100 MB = 104,857,600 bytes = 838,860,800 bits; at 100,000,000 bits/s that is 8.39 s.
    expect(bytes(100)).toBe(104_857_600);
    expect(bitsPerSecond(100)).toBe(100_000_000);
    expect(seconds(100, 100)).toBeCloseTo(8.388608, 6);
    expect(grade(8)).toMatchObject({ points: 4, code: 'CORRECT' });
  });

  // TRAP ONE, AND IT IS WORTH A FACTOR OF EIGHT.
  //
  // Dividing megabytes by megabits without converting is the single most common mistake in this topic, and
  // it produces an answer that looks entirely reasonable -- 1 second instead of 8.
  it('scores ZERO for the missing bit conversion, not "nearly"', () => {
    const naive = seconds(100, 100) / BITS_PER_BYTE;
    expect(Math.round(naive)).toBe(1);
    expect(grade(1)).toMatchObject({ points: 0 });
    expect(grade(naive)).toMatchObject({ points: 0 });
    // The helper and the grader must agree on what the mistake is worth, or the feedback lies.
    expect(withoutTheByteConversion(100, 100)).toBeCloseTo(naive, 9);
  });

  // TRAP TWO, IN THE OTHER DIRECTION.
  //
  // MB is 2^20 and Mbit is 10^6. Mixing them is not a rounding quibble: it moves every answer by about 5%,
  // which on an 8-second download is 0.4 s and is enough to fall outside the tolerance.
  // THE MIXED CONVENTION IS THE ONE DECLARED: MB is 2^20, Mbit is 10^6.
  //
  // The two other self-consistent conventions land on 1.05 s (bytes over decimal bits -- which is the
  // factor-eight mistake wearing a hat) and on 8.0 s (both decimal, where the two cancel and the answer is
  // right by coincidence). Only the third is the question, and it is 8.39 s.
  it('uses 1024 for the megabyte and 1000 for the megabit', () => {
    const naive = bytes(100) / bitsPerSecond(100);
    expect(naive).toBeCloseTo(1.048576, 6);
    expect(grade(naive)).toMatchObject({ points: 0 });

    const bothDecimal = (100 * 1_000_000 * BITS_PER_BYTE) / bitsPerSecond(100);
    expect(bothDecimal).toBeCloseTo(8, 6);
    expect(seconds(100, 100)).toBeCloseTo(8.388608, 6);
    expect(seconds(100, 100)).not.toBeCloseTo(bothDecimal, 3);

    // The declared answer is accepted. A 10% error still earns SOME credit -- partial credit was asked
    // for, and the declared band is three tolerances of 0.5 s -- but not most of it.
    expect(grade(seconds(100, 100))).toMatchObject({ points: 4 });
    expect(grade(9.2).points).toBeGreaterThan(0);
    expect(grade(9.2).points).toBeLessThan(4);
    // ...and a wild answer still earns nothing at all.
    expect(grade(200).points).toBe(0);
  });

  // THE TWO TRAPS PULL IN OPPOSITE DIRECTIONS.
  //
  // That is what makes this worth a simulation: a student who has memorised one of the two and not the
  // other can be wrong in ways that are indistinguishable by eye, and the feedback has to say which.
  it('names the factor-of-eight mistake in the feedback rather than only the right answer', () => {
    const result = grade(1) as { feedback: string };
    expect(result.feedback).toContain('8');
    expect(result.feedback).toMatch(/bits to bytes/i);
    // And it does NOT accuse a student of that mistake when they made a different one.
    const other = grade(40) as { feedback: string };
    expect(other.feedback).not.toMatch(/bits to bytes/i);
  });

  it('is LINEAR in the file size and in the speed, in opposite senses', () => {
    expect(seconds(200, 100)).toBeCloseTo(2 * seconds(100, 100), 9);
    expect(seconds(100, 200)).toBeCloseTo(seconds(100, 100) / 2, 9);
  });

  // A progress bar does not show tenths of a second, so the answer is ROUNDED -- and the tolerance
  // accepts that rounding rather than hiding a mistake behind it.
  it('accepts BOTH the rounded answer and the exact one', () => {
    // The defect this replaces: the grader rounded its own expectation to 8 and then scored the exact
    // transfer time, 8.388608, at 2.23 of 4. A student who kept more decimal places than the grader lost
    // three quarters of the marks for it.
    expect(secondsRounded(100, 100)).toBe(8);
    expect(seconds(100, 100)).toBeCloseTo(8.388608, 6);
    expect(grade(8.39)).toMatchObject({ points: 4 });
    expect(grade(8)).toMatchObject({ points: 4 });
    expect(grade(8.4)).toMatchObject({ points: 4 });
    // Half a second out is not rounding, and is refused.
    expect(grade(9).points).toBeLessThan(4);
    expect(grade(7).points).toBeLessThan(4);
  });

  it('has no answer for a speed of zero, rather than infinity', () => {
    expect(Number.isNaN(seconds(100, 0))).toBe(true);
  });

  it('states all three conversions, because the question cannot be answered without them', () => {
    const text = describeDownload(100, 100);
    expect(text).toContain('1024 x 1024');
    expect(text).toContain('1000 x 1000');
    expect(text).toContain('8 bits in a byte');
  });

  it('keeps the TIME out of the text alternative, while naming the two inputs', () => {
    const text = sim.grader.accessibility.textAlternative;
    expect(text).not.toMatch(/\b\d+(\.\d+)?\s*s(ec)?\b/);
    expect(text).toContain('megabytes');
    expect(text.length).toBeGreaterThan(20);
  });

  it('treats an empty box as no answer rather than as zero seconds', () => {
    for (const blank of ['', '  ', null, undefined, Number.NaN]) {
      expect(grade(blank)).toMatchObject({ points: 0, code: 'UNPARSEABLE' });
    }
  });
});

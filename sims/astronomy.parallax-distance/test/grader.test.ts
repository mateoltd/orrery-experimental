/**
 * The grader, in bare Node.  (P6-T11, gold sim 13)
 *
 * The cases that matter are about a RELATIONSHIP THAT RUNS BACKWARDS, and about small answers where an
 * absolute tolerance goes wrong.
 */
import { describe, expect, it } from 'vitest';
import sim from '../src/grader.js';
import {
  describeParallax,
  format,
  lightYears,
  PARSEC_IN_LIGHT_YEARS,
  type ParallaxParams,
  parallaxOf,
  parsecs,
} from '../src/model.js';

const grade = (answer: unknown, params: ParallaxParams = { parallax: 0.1, inLightYears: false }) =>
  sim.grader.grade(null, params, answer);

describe('astronomy.parallax-distance', () => {
  it('answers in PARSECS, which is the reciprocal with no arithmetic in the unit', () => {
    // One parsec is DEFINED as the distance at which the parallax is one arcsecond, so the number is the
    // reciprocal and the unit comes from the definition.
    expect(parsecs(1)).toBe(1);
    expect(parsecs(0.1)).toBe(10);
    expect(grade(10)).toMatchObject({ points: 4, code: 'CORRECT' });
  });

  // THE RELATIONSHIP RUNS BACKWARDS, AND THAT IS THE POINT.
  //
  // Every other simulation's answer grows with its inputs. This one SHRINKS: a bigger parallax is a
  // closer star. A student who multiplies instead of dividing is wrong by a factor of the answer's own
  // magnitude, which no tolerance will absorb -- so these must score ZERO, not "nearly".
  it('scores ZERO for the reciprocal mistake, at both ends of the range', () => {
    expect(grade(0.01, { parallax: 0.1, inLightYears: false }).points).toBe(0);
    expect(grade(1 / 0.1 / 100, { parallax: 0.1, inLightYears: false }).points).toBe(0);
    // And at the other end: 0.05 arcsec is 20 parsecs, and 0.05 parsecs is the mistake.
    expect(grade(20, { parallax: 0.05, inLightYears: false }).points).toBe(4);
    expect(grade(0.05, { parallax: 0.05, inLightYears: false }).points).toBe(0);
  });

  // SMALL ANSWERS, WHERE AN ABSOLUTE TOLERANCE GOES WRONG.
  //
  // The declared range gives answers from 0.5 to 20 parsecs. A tolerance of half a parsec is a tenth of
  // the whole range at one end and half the answer at the other, so grading has to be relative.
  it('tolerates the same RELATIVE error at both ends of the range', () => {
    const small = parsecs(2); // 0.5 parsecs
    const large = parsecs(0.05); // 20 parsecs
    // 2% off each: within tolerance at both magnitudes.
    expect(grade(small * 1.02, { parallax: 2, inLightYears: false }).points).toBe(4);
    expect(grade(large * 1.02, { parallax: 0.05, inLightYears: false }).points).toBe(4);
    // 25% off each: outside at both.
    expect(grade(small * 1.25, { parallax: 2, inLightYears: false }).points).toBeLessThan(4);
    expect(grade(large * 1.25, { parallax: 0.05, inLightYears: false }).points).toBeLessThan(4);
  });

  it('converts to light years only when asked, because that is a conversion and not a definition', () => {
    expect(lightYears(1)).toBeCloseTo(PARSEC_IN_LIGHT_YEARS, 5);
    expect(grade(PARSEC_IN_LIGHT_YEARS, { parallax: 1, inLightYears: true }).points).toBe(4);
    // The parsec answer must NOT be accepted when light years were asked for.
    expect(grade(1, { parallax: 1, inLightYears: true }).points).toBe(0);
    // ...and the light-year answer must not be accepted when parsecs were asked for.
    expect(grade(PARSEC_IN_LIGHT_YEARS, { parallax: 1, inLightYears: false }).points).toBe(0);
  });

  it('round-trips, which is the check that the reciprocal is a reciprocal', () => {
    for (const parallax of [0.05, 0.1, 0.5, 1, 2]) {
      expect(parallaxOf(parsecs(parallax))).toBeCloseTo(parallax, 9);
    }
  });

  it('has no answer at all for a parallax of zero, rather than infinity', () => {
    expect(Number.isNaN(parsecs(0))).toBe(true);
    expect(Number.isNaN(parsecs(-1))).toBe(true);
    expect(format(Number.NaN)).toBe('undefined');
  });

  // Three decimal places would print 10 parsecs as "10.000" and 0.5 as "0.500".
  it('prints SIGNIFICANT figures, so the answer does not arrive padded with zeros', () => {
    expect(format(10)).toBe('10');
    expect(format(0.5)).toBe('0.5');
    expect(format(3.26156)).toBe('3.26156');
    expect(format(20)).toBe('20');
  });

  it('says which way the relationship runs, because that is what students get wrong', () => {
    expect(describeParallax(0.2, false)).toContain('CLOSER');
    expect(describeParallax(0.2, true)).toContain('LIGHT YEARS');
  });

  it('keeps the distance out of the text alternative', () => {
    const text = sim.grader.accessibility.textAlternative;
    expect(text).not.toMatch(/\b\d+(\.\d+)?\s*(pc|parsecs|light years)\b/);
    expect(text.length).toBeGreaterThan(20);
  });

  it('treats an empty box as no answer rather than as a distance of zero', () => {
    // Zero is a real number and a student could type it; it is not the answer to anything here.
    for (const blank of ['', '  ', null, undefined, Number.NaN]) {
      expect(grade(blank)).toMatchObject({ points: 0, code: 'UNPARSEABLE' });
    }
  });

  it('quotes the distance in feedback, so the student can see which way to go', () => {
    const result = grade(1) as { feedback: string };
    expect(result.feedback).toContain('parsecs');
  });
});

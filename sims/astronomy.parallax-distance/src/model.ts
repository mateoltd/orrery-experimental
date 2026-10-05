/**
 * The model. Pure, DOM-free, deterministic.  (P6-T11, gold sim 13)
 *
 * ## THE RELATIONSHIP RUNS BACKWARDS, AND THAT IS THE POINT
 *
 * Every other simulation's answer grows with its inputs. This one's answer SHRINKS: a star with a
 * parallax of 0.1 arcseconds is 10 parsecs away, and a star with a parallax of 0.01 is 100. A student who
 * treats the formula like the others divides instead of multiplying and is wrong by a factor of the
 * answer's own magnitude, which no tolerance will absorb.
 *
 * ## WHY THE NUMBERS ARE SO SMALL
 *
 * The answer is `1 / p`, so for a parallax between 0.05 and 2 arcseconds the distance is between 0.5 and
 * 20 parsecs. Those are small numbers, and small numbers are where an ABSOLUTE tolerance goes wrong: a
 * tolerance of 0.5 parsec is a tenth of the whole range at one end and half the answer at the other. The
 * grading is relative for that reason, and there is a test at both ends of the range.
 *
 * ## ARCSECONDS ARE NOT SECONDS OF TIME
 *
 * An arcsecond is an ANGLE, and `1 / p` produces parsecs because parsecs are DEFINED as the distance at
 * which a star has a parallax of one arcsecond. So there is no arithmetic in the unit at all: the number
 * is the reciprocal, and the unit comes from the definition.
 */

/** The whole scale, as a definition rather than as arithmetic. */
export const PARSEC_IN_LIGHT_YEARS = 3.26156;

export interface ParallaxParams {
  /** Annual parallax in ARCSECONDS. The only input that matters. */
  readonly parallax: number;
  /** Whether to also report the distance in light years, which is where unit slips show up. */
  readonly inLightYears: boolean;
}

export const clamp = (params: ParallaxParams): ParallaxParams => ({
  // THE TRUE BRANCH WAS THE PREDICATE, NOT THE VALUE: `Number.isFinite(params.parallax) ?
  // Number.isFinite(params.parallax) : 0.5` returns a BOOLEAN for every well-formed input, and
  // `Math.max(0.05, true)` is `Math.max(0.05, 1)` -- so `clamp` replaced the student's chosen parallax
  // with 1 arcsec whatever it was. The guard asked a question and answered with the question.
  parallax: Math.min(2, Math.max(0.05, Number.isFinite(params.parallax) ? params.parallax : 0.5)),
  inLightYears: Boolean(params.inLightYears),
});

/** Distance in parsecs. The reciprocal, with no arithmetic in the unit. */
export function parsecs(parallaxArcsec: number): number {
  if (!(parallaxArcsec > 0)) return Number.NaN;
  return 1 / parallaxArcsec;
}

/** The same distance in light years, which is a conversion and not a definition. */
export function lightYears(parallaxArcsec: number): number {
  return parsecs(parallaxArcsec) * PARSEC_IN_LIGHT_YEARS;
}

/** Round-trip: the parallax a star at this distance would show. Used to check the reciprocal. */
export const parallaxOf = (distanceParsecs: number): number =>
  distanceParsecs > 0 ? 1 / distanceParsecs : Number.NaN;

export function describeParallax(parallaxArcsec: number, wantLightYears: boolean): string {
  return (
    `A star is measured to have an annual parallax of ${format(parallaxArcsec)} arcseconds, measured ` +
    `against the Earth's orbit around the Sun. Larger parallax means CLOSER. ` +
    (wantLightYears
      ? `Work out the distance in LIGHT YEARS.`
      : `Work out the distance in PARSECS.`) +
    ` One parsec is the distance at which a star has a parallax of exactly one arcsecond.`
  );
}

export function format(value: number): string {
  if (!Number.isFinite(value)) return 'undefined';
  // Significant figures, not decimal places: the answer spans 0.5 to 20 parsecs, and three decimal places
  // would print 10 parsecs as "10.000" and 0.5 as "0.500".
  if (value === 0) return '0';
  const magnitude = Math.ceil(Math.log10(Math.abs(value)));
  const rounded =
    Math.round(value * 10 ** Math.max(0, 6 - magnitude)) / 10 ** Math.max(0, 6 - magnitude);
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

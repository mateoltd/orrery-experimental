/**
 * The model. Pure, DOM-free, deterministic.  (P6-T11, gold sim 9)
 *
 * ## THE QUESTION IS NOT "WHAT IS N?" AND THAT IS THE POINT
 *
 * Every other simulation asks the student to read a number off a display or compute one from a
 * formula. This one gives a burette reading in centimetres and a volume in millilitres, and the answer
 * is neither of those numbers: the student has to notice that 23.4 cm is 234 mL, then divide by the
 * 250 mL flask. Three numbers go in and a fourth comes out, and none of the inputs is the answer.
 *
 * A simulation platform that has only ever graded "what the widget says" has not been tested against a
 * student who has to decide what the widget is asking. `plans/20` gives every chemistry question a
 * simulator, and most of them will look like this one.
 *
 * ## THE READING IS NOT ALWAYS AN INTEGER
 *
 * A burette is read to the bottom of the meniscus and the convention is to include ONE decimal place,
 * so the readings are always given to 0.1 mL. The first version read them as whole millilitres and
 * produced 234 mL where the picture said 23.4, and the grader compared against 234 with a tolerance of
 * 0.5 -- so a student who read the burette correctly failed. The unit conversion is part of the
 * question, and it has to happen before the arithmetic, not after it.
 */

/** The flask the student fills, and the only volume the chemistry cares about. */
export const FLASK_ML = 250;

export interface ConcentrationParams {
  /** Burette reading in centimetres, always to 0.1. */
  readonly buretteCm: number;
  /** The flask's actual volume, so "is this the right dilution" is answerable. */
  readonly flaskMl: number;
}

export const clamp = (params: ConcentrationParams): ConcentrationParams => ({
  buretteCm: Math.min(50, Math.max(0, Number.isFinite(params.buretteCm) ? params.buretteCm : 0)),
  flaskMl: Math.min(1000, Math.max(1, Number.isFinite(params.flaskMl) ? params.flaskMl : FLASK_ML)),
});

/** CENTIMETRES OF BURETTE ARE NOT MILLILITRES OF SOLUTION. */
export const toMillilitres = (centimetres: number): number => round(centimetres * 10, 1);

/** The moles delivered, from the concentration of the stock solution. */
export const moles = (millilitres: number, stockMolar: number): number =>
  millilitres * stockMolar * 1e-3;

/**
 * The thing being asked for: the CONCENTRATION, which is neither input number.
 *
 * MOLES PER LITRE, SO THE MILLILITRES HAVE TO BECOME LITRES. The first version divided moles by the
 * flask volume in millilitres and got 9.36e-5 -- that is mol/mL, a thousand times too small, and the
 * grader would have accepted 0.0000936 mol/L as the correct answer to a question whose answer is
 * 0.0936 mol/L. A dilution question that silently reports the wrong unit is worse than no question,
 * because the student is graded confidently against a value nothing in chemistry has ever meant.
 */
export function concentration(millilitres: number, flaskMl: number, stockMolar: number): number {
  return round(moles(millilitres, stockMolar) / (flaskMl / 1000), 6);
}

export const round = (value: number, places: number): number => {
  const factor = 10 ** places;
  const rounded = Math.round(value * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
};

/** No number appears here. The answer is what the student works out from these three figures. */
export function describeConcentration(
  readingCm: number,
  flaskMl: number,
  stockMolar: number,
): string {
  return (
    `A burette is read to ${format(readingCm)} centimetres above a mark, and that reading is delivered ` +
    `into a ${format(flaskMl)} millilitre volumetric flask containing stock solution of concentration ` +
    `${format(stockMolar)} moles per litre. The flask is then made up to its mark with water. Work out ` +
    `the concentration of the diluted solution.`
  );
}

/**
 * SIX SIGNIFICANT FIGURES, NOT THREE DECIMAL PLACES.
 *
 * Feedback quotes intermediate values so a student can see where their working went wrong, and three
 * decimal places is the wrong unit for that: 0.0234 mol printed as "0.023" is a different number from
 * the one on the student's page, and the last digit they needed to check against is the one that
 * disappeared. Decimal places are a fixed offset from zero; a titration spans four orders of magnitude,
 * so the rounding has to follow the magnitude.
 */
export function format(value: number): string {
  if (!Number.isFinite(value)) return 'undefined';
  if (value === 0) return '0';
  const magnitude = Math.ceil(Math.log10(Math.abs(value)));
  const rounded = round(value, Math.max(0, 6 - magnitude));
  const text = String(rounded);
  return Object.is(rounded, -0) ? '0' : text;
}

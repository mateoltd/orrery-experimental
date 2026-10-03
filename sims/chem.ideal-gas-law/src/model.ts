/**
 * The model. Pure, DOM-free, deterministic.  (P6-T11, gold sim 3)
 *
 * ## `R` IS NOT A PARAMETER
 *
 * The gas constant is `8.314 J/(mol·K)`. Making it configurable would let a teacher "solve" PV = nRT with
 * a constant that is not the gas constant, and the student would learn the shape of the law without the
 * law. The same reasoning put `g` outside the projectile sim's parameters, and it is worth stating once
 * per sim: **a value that is not a choice is not a parameter.**
 *
 * ## UNITS ARE PART OF THE ANSWER, NOT PART OF THE NUMBER
 *
 * Temperature in kelvin is what the law uses, and a student who answers in Celsius is not wrong so much as
 * answering a different question — 100 °C is 373 K, and the difference is not a rounding error. So the
 * answer is reported in kelvin, named in the field, and the alternative text says kelvin too.
 */

export interface GasParams {
  /** Pressure, kilopascals. */
  readonly p: number;
  /** Volume, litres. */
  readonly v: number;
  /** Amount of substance, moles. */
  readonly n: number;
}

/** The gas constant, J/(mol·K). Fixed, for the reason above. */
export const R = 8.314;

export const kelvinFromCelsius = (celsius: number): number => celsius + 273.15;
export const celsiusFromKelvin = (kelvin: number): number => kelvin - 273.15;

/** `T = PV / nR`, in kelvin. */
export function temperature(params: GasParams): number {
  return (params.p * params.v) / (params.n * R);
}

/**
 * One sentence for the text alternative.
 *
 * Derived, never hard-coded. A caption that says "101.3 kPa" when the slider says 100 is worse than no
 * caption, because a screen-reader user has no way to check it.
 */
export function describeGas(params: GasParams): string {
  const kelvin = temperature(params);
  const celsius = celsiusFromKelvin(kelvin);
  return (
    `${format(params.n)} moles of gas at ${format(params.p)} kilopascals in ${format(params.v)} litres ` +
    `reach ${format(kelvin)} kelvin, which is ${format(celsius)} degrees Celsius.`
  );
}

/** Two decimals, no trailing `.0`, and a non-finite value named rather than printed. */
export const format = (value: number): string => {
  if (!Number.isFinite(value)) return 'undefined';
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? '0' : String(rounded);
};

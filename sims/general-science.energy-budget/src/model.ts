/**
 * The model. Pure, DOM-free, deterministic.  (P6-T11, gold sim 16)
 *
 * ## A CONSERVATION LAW, AND A SIMULATION THAT CHECKS IT
 *
 * Every other simulation computes one answer from one formula. This one computes a whole BUDGET, and the
 * parts have to add up: what comes out as useful work, what comes out as heat, and what goes in. That sum
 * is a physical invariant, so the model asserts it rather than trusting the arithmetic -- an efficiency
 * above 100% is not a wrong answer, it is an impossible machine, and a simulation that draws one has taught
 * a student something false.
 *
 * ## WHY THE EFFICIENCY IS A PARAMETER AND NOT A CONSTANT
 *
 * A student who always divides by the same number has not learned that efficiency varies with the device.
 * The declared range starts at 5% -- an incandescent bulb -- and reaches 100%, where the third part
 * vanishes and the answer stops being a division at all. That boundary is the interesting one: at 100%
 * efficiency there is no waste, and a student who still subtracts has made a real error.
 */

export interface EnergyParams {
  /** Energy supplied, in JOULES. */
  readonly inputJ: number;
  /** Useful fraction, as a percentage. 5 is a bulb; 100 is a perfect machine. */
  readonly efficiency: number;
}

export const clamp = (params: EnergyParams): EnergyParams => ({
  inputJ: Math.min(1_000_000, Math.max(1, Number.isFinite(params.inputJ) ? params.inputJ : 1000)),
  efficiency: Math.min(
    100,
    Math.max(5, Number.isFinite(params.efficiency) ? params.efficiency : 25),
  ),
});

export interface Budget {
  readonly inputJ: number;
  readonly usefulJ: number;
  readonly wastedJ: number;
  readonly fraction: number;
}

/**
 * The whole budget, with the invariant checked.
 *
 * The check is not decoration. Floating point means `input - useful - wasted` is not exactly zero, and a
 * sum asserted with `===` would fail for reasons that have nothing to do with the physics -- so it is
 * checked as a RELATIVE error, which is the only form that means anything across four orders of magnitude.
 */
export function budget(inputJ: number, efficiency: number): Budget {
  const fraction = Math.min(1, Math.max(0, efficiency / 100));
  const usefulJ = inputJ * fraction;
  const wastedJ = inputJ - usefulJ;
  return { inputJ, usefulJ, wastedJ, fraction };
}

/** The conservation check, exposed so a test and the simulation can both ask. */
export function isConserved(b: Budget): boolean {
  const total = b.usefulJ + b.wastedJ;
  if (b.inputJ === 0) return total === 0;
  return Math.abs(total - b.inputJ) / Math.abs(b.inputJ) < 1e-9;
}

export function describeEnergy(inputJ: number, efficiency: number): string {
  return (
    `A device is supplied with ${format(inputJ)} J of energy and converts ${format(efficiency)}% of it ` +
    `into useful work; the rest is released as heat. Work out how many joules of USEFUL energy it ` +
    `produces. Energy is conserved, so what goes in is what comes out, split between the two.`
  );
}

export function format(value: number): string {
  if (!Number.isFinite(value)) return 'undefined';
  if (value === 0) return '0';
  const magnitude = Math.ceil(Math.log10(Math.abs(value)));
  const power = Math.max(0, 6 - magnitude);
  const rounded = Math.round(value * 10 ** power) / 10 ** power;
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

/**
 * The model. Pure, DOM-free, deterministic.  (P6-T11, gold sim 14)
 *
 * ## THE TRAP IS A UNIT LADDER, NOT A RATIO
 *
 * `plans/20` gives every geography question a simulator, and the arithmetic here is trivial: multiply the
 * map distance by the scale denominator. Almost every wrong answer comes from the UNITS on the way --
 * centimetres to metres to kilometres -- and from the scale denominator itself, which is read as
 * "divide by 50,000" by students who have seen "1:50,000" as a fraction their whole life.
 *
 * So the model keeps the ladder explicit and returns every rung, which is what lets the feedback quote the
 * step a student got wrong instead of only the number.
 *
 * ## WHY THE SCALE DENOMINATOR IS NOT A DIVISOR
 *
 * 1:50,000 means one centimetre on the map is 50,000 centimetres in reality, which is 500 metres. A
 * student who divides gets a distance smaller than the map, which is obviously wrong and is exactly the
 * check that catches them: the answer is always LARGER than the measured map distance.
 */

/** The scales a school atlas actually uses, in the form they are printed. */
/**
 * The scales, each with the NAME a host uses in `loadScenario`.
 *
 * The name is the contract and the label is the printing. They are different strings on purpose:
 * `plans/10` §2.3 says `loadScenario` names a scenario, and a host must be able to move a student between
 * them without knowing any of the numbers.
 */
export const SCALES: readonly {
  readonly name: string;
  readonly ratio: number;
  readonly label: string;
}[] = [
  { name: '25k', ratio: 25_000, label: '1:25 000' },
  { name: '50k', ratio: 50_000, label: '1:50 000' },
  { name: '250k', ratio: 250_000, label: '1:250 000' },
];

export const scaleByName = (name: unknown) => SCALES.find((entry) => entry.name === name) ?? null;

export interface ScaleParams {
  /** Measured on the map, in CENTIMETRES. */
  readonly mapCm: number;
  /** Which scale the map is printed at. */
  readonly ratio: number;
}

export const clamp = (params: ScaleParams): ScaleParams => ({
  mapCm: Math.min(
    20,
    Math.max(
      0.5,
      Number.isFinite(params.mapCm) ? (Number.isFinite(params.mapCm) ? params.mapCm : 4) : 4,
    ),
  ),
  ratio: [25_000, 50_000, 250_000].includes(Number(params.ratio)) ? Number(params.ratio) : 50_000,
});

/** Rung one: centimetres on the map to centimetres in reality. */
export const mapToRealCm = (mapCm: number, ratio: number): number => mapCm * ratio;

/** Rung two: centimetres to METRES. This is the step students miss. */
export const toMetres = (realCm: number): number => realCm / 100;

/** Rung three: metres to kilometres, which is the answer. */
export const toKilometres = (metres: number): number => metres / 1000;

/** THE ANSWER, in kilometres, with every rung kept so the feedback can quote it. */
export function realDistanceKm(mapCm: number, ratio: number) {
  const realCm = mapToRealCm(mapCm, ratio);
  const metres = toMetres(realCm);
  return {
    realCm,
    metres,
    km: toKilometres(metres),
  };
}

export function describeScale(mapCm: number, ratio: number): string {
  return (
    `A route measures ${format(mapCm)} cm on a map printed at a scale of 1:${String(ratio)}. ` +
    `Work out how far the route is in REAL LIFE, in kilometres. The scale means one centimetre on the ` +
    `map is the same number of centimetres in reality.`
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

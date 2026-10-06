/**
 * The model. Pure, DOM-free, deterministic.  (P12-T2, card 48 `chemistry.solution-concentration`)
 *
 * ## "ADD 100 cm³ OF WATER" AND "MAKE UP TO 100 cm³" ARE TWO DIFFERENT QUESTIONS
 *
 * That is the card's focus and the reason there are two volume parameters rather than one slider. Adding
 * water increases the volume; making up to a volume requires REMOVING solution if the target is smaller than
 * what you started with. One "dilute" action cannot ask the difference, so `method` chooses which of the two
 * declared volumes is used, and `finalVolume` is floored at the starting volume rather than silently
 * accepted — a dilution that quietly removed solute is a different experiment.
 *
 * ## `c₁V₁ = c₂V₂` IS APPLIED TO THE ACTUAL VOLUMES, AND THE MISCONCEPTION IS THE VERB
 *
 * The card's focus is that "add 100 cm³ of water" and "make up to 100 cm³" are two DIFFERENT scenarios, and
 * the student mistake is reading the second as the first. Starting from 50 cm³, adding 100 cm³ of water
 * gives 150 cm³; making up TO 100 cm³ gives 100 cm³; and a student who treats them as the same thing is off
 * by half. So `method` chooses which declared volume is used and the two paths never share an arithmetic
 * step.
 *
 * ## THE CARD'S MISCONCEPTION (1) IS ARITHMETICALLY TRUE AS WRITTEN
 *
 * "Adding 100 cm³ of water to 100 cm³ of solution halves the concentration" is CORRECT —
 * `c₂ = c₁ × 100/200 = c₁/2` — so it is not a misconception and no simulation can target it. The
 * misconception this simulation CAN target, and does, is reading "make up to" as "add". The card's wording is
 * at `docs/11-SIM-CARDS.md:487` and §8 of this simulation's spec card records the discrepancy.
 */

export type Method = 'add' | 'make-up';

export interface SolutionParams {
  /** The starting molarity, mol/dm³. */
  readonly molarity: number;
  /** The starting volume, cm³. */
  readonly volume: number;
  /** Volume of WATER ADDED, cm³. Used when `method` is `add`. */
  readonly water: number;
  /** Volume MADE UP TO, cm³. Used when `method` is `make-up`, and must be at least the starting volume. */
  readonly finalVolume: number;
  /** Which of the two the student is doing. */
  readonly method: Method;
  /** Molar mass of the solute, g/mol, so ppm can be reported alongside molarity. */
  readonly molarMass: number;
}

export const MIN_MOLARITY = 0.01;
export const MAX_MOLARITY = 2;
export const MIN_VOLUME = 10;
export const MAX_VOLUME = 500;
/** Sodium chloride, declared rather than configurable: a molar mass is a property of the substance. */
export const MOLAR_MASS = 58.44;
export const GRAMS_PER_MOL = 'g/mol';

export const clamp = (raw: Partial<SolutionParams>): SolutionParams => {
  const number = (value: unknown, fallback: number): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const volume = Math.min(MAX_VOLUME, Math.max(MIN_VOLUME, number(raw.volume, 50)));
  const water = Math.min(MAX_VOLUME, Math.max(0, number(raw.water, 50)));
  // `make-up` to a SMALLER volume is impossible without removing solution, so the floor is the starting
  // volume. Clamping rather than refusing keeps every combination a teacher can set into a gradable question,
  // and the clamp is declared here rather than discovered by a student.
  const finalVolume = Math.min(MAX_VOLUME, Math.max(volume, number(raw.finalVolume, 100)));
  return {
    molarity: Math.min(MAX_MOLARITY, Math.max(MIN_MOLARITY, number(raw.molarity, 0.1))),
    volume,
    water,
    finalVolume,
    method: raw.method === 'add' ? 'add' : 'make-up',
    molarMass: Math.min(200, Math.max(1, number(raw.molarMass, MOLAR_MASS))),
  };
};

/**
 * The volume the solute ends up in, which is the quantity the whole card turns on.
 *
 * ADD:   V₂ = V₁ + water        (the water becomes part of the volume)
 * MAKE UP: V₂ = finalVolume      (the solvent is added until the TOTAL is finalVolume)
 */
export function finalVolumeOf(params: SolutionParams): number {
  return params.method === 'add' ? params.volume + params.water : params.finalVolume;
}

/** The amount of solute, in moles. DILUTION CHANGES NEITHER THIS NOR THE MASS. */
export function moles(params: SolutionParams): number {
  return params.molarity * (params.volume / 1000);
}

/** `c₁V₁ = c₂V₂`, evaluated on the ACTUAL volumes rather than on the added water. */
export function dilutedMolarity(params: SolutionParams): number {
  const final = finalVolumeOf(params);
  return (params.molarity * params.volume) / final;
}

/** Parts per million by MASS, which needs the solute's molar mass — a second declared unit, not a synonym. */
export function ppm(params: SolutionParams): number {
  const grams = moles(params) * params.molarMass;
  return (grams / (finalVolumeOf(params) / 1000)) * 1e6;
}

/**
 * Whether the final volume is what the student said it was.
 *
 * `false` for `make-up` to a target below the starting volume, which the clamp has already floored — so this
 * reports a fact about the CLAMPED parameters and never a contradiction the host cannot see.
 */
export function feasible(params: SolutionParams): boolean {
  return params.method === 'add' || params.finalVolume >= params.volume;
}

/** The solute's mass in grams, for the "before" table. Grams, not kilograms: the student is reading a label. */
export function molarMassOf(params: SolutionParams): number {
  return params.molarMass;
}

export const format = (value: number, places = 4): string => {
  if (!Number.isFinite(value)) return 'undefined';
  const factor = 10 ** places;
  const rounded = Math.round(value * factor) / factor;
  return Object.is(rounded, -0) ? '0' : String(rounded);
};

/** The text alternative, DERIVED, and it names the two methods separately. */
export function describeSolution(params: SolutionParams): string {
  const final = finalVolumeOf(params);
  return (
    `${format(params.molarity, 3)} moles per litre in ${format(params.volume, 0)} cm³ of solution, ` +
    `${params.method === 'add' ? `with ${format(params.water, 0)} cm³ of water added` : `made up to a total of ${format(params.finalVolume, 0)} cm³`}. ` +
    `That is ${format(moles(params))} moles in ${format(final, 0)} cm³, so the diluted molarity is ` +
    `${format(dilutedMolarity(params))} mol per litre and the concentration is ${format(ppm(params), 1)} ppm.`
  );
}

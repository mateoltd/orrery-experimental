/**
 * The model. Pure, DOM-free, deterministic.  (P12-T2, card 8 `astronomy.tides`)
 *
 * ## THE SPRING/NEAP BEAT IS AN INTERFERENCE, NOT A RULE
 *
 * The card's focus: "the tide is computed as a HARMONIC SUM — the M2 and S2 constituents — so the
 * spring/neap beat emerges from the interference of two periods rather than from a rule". So there is no
 * `if (phase === 'new moon') range *= 2` anywhere in this file. There are two sinusoids at 12.4206012 h and
 * 12.0000 h, they are added, and the envelope they produce beats with a period of 14.77 days because that is
 * what two close frequencies do. A student who moves the lunar phase watches the beat move; one who has been
 * told "spring tides are at the new moon" has been told a consequence and not the cause.
 *
 * ## RESONANCE IS REPORTED, NOT ASSERTED
 *
 * "a resonant basin has a tide far larger than its forcing and a sim that could not produce one would teach
 * that tides are always small." The basin response is a linear oscillator's shape factor with a declared
 * quality factor, so at `natural == M2` the amplification is exactly `Q0` — large, finite, and reachable from
 * the declared parameter ranges. `RESONANT` is then a THRESHOLD on a computed number, not a lookup.
 *
 * ## THE BEAT PERIOD IS POORLY CONDITIONED, AND THE CARD SAYS SO
 *
 * `1/|1/T_M2 − 1/T_S2|` is a difference of two reciprocals of numbers 0.42 apart. The card's float hazard is
 * exactly this: a student computing it from two-decimal constituents gets 14.6 days where the three-decimal
 * answer is 14.77, which is a rounding disagreement and not an error. So the beat period is REPORTED rather
 * than asked for, and it is not one of the graded fields.
 */

/** M2, the principal lunar semidiurnal constituent. HOURS, and to seven figures because it is a constant. */
export const T_M2 = 12.4206012;
/** S2, the principal solar semidiurnal constituent. HOURS. */
export const T_S2 = 12;
/** Constituent amplitudes, metres, before the basin responds to them. */
export const A_M2 = 1;
export const A_S2 = 0.46;

/**
 * The basin's quality factor, DECLARED and NOT A PARAMETER.
 *
 * The same reasoning put `R` outside the ideal-gas sim's parameters (`chem.ideal-gas-law/src/model.ts:6`):
 * a value that is not a choice is not a parameter. Making it one would let a teacher "resonate" a basin by
 * declaring it.
 */
export const Q0 = 30;

/** Above this amplification the basin is reported as resonant. A threshold on a number, not a lookup. */
export const RESONANT_AMPLIFICATION = 10;

export interface TideParams {
  /** The basin's own natural period, hours. Equal to `T_M2` for a resonant estuary. */
  readonly natural: number;
  /** Hours since the start of the spring-neap cycle, 0 to about 30. */
  readonly hours: number;
  /** The lunar phase in days, 0 to 29.53. Drives the beat, not a rule. */
  readonly phase: number;
}

export const MIN_NATURAL = 1;
export const MAX_NATURAL = 30;
export const MAX_HOURS = 24 * 30;
export const SYNODIC_MONTH = 29.530588;

export const clamp = (raw: Partial<TideParams>): TideParams => {
  const number = (value: unknown, fallback: number): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  return {
    natural: Math.min(MAX_NATURAL, Math.max(MIN_NATURAL, number(raw.natural, T_M2))),
    hours: Math.min(MAX_HOURS, Math.max(0, number(raw.hours, 24 * 7))),
    phase: Math.min(SYNODIC_MONTH, Math.max(0, number(raw.phase, 0))),
  };
};

/**
 * A driven linear oscillator's steady-state magnification, for a forcing period `T`.
 *
 * `1 / sqrt((1 − (T/ω₀)²)² + (T/(Q₀ω₀))²)` — at `T = ω₀` this is exactly `Q₀`, so the peak is finite and
 * reachable rather than a division by zero, which is what makes `resonant` a measurable threshold.
 */
export function amplificationFor(forcing: number, natural: number): number {
  const ratio = forcing / natural;
  const real = 1 - ratio * ratio;
  const imaginary = ratio / Q0;
  return 1 / Math.hypot(real, imaginary);
}

/** The two constituents' amplitudes after the basin has responded to each of them. */
export function constituentAmplitudes(natural: number): { m2: number; s2: number } {
  return { m2: A_M2 * amplificationFor(T_M2, natural), s2: A_S2 * amplificationFor(T_S2, natural) };
}

/**
 * The water height at `hours`, as the SUM of the two constituents.
 *
 * No rule, no phase table, and no `new moon` branch: the beat is what two close sinusoids do.
 */
export function height(params: TideParams): number {
  const { m2, s2 } = constituentAmplitudes(params.natural);
  const lunar =
    m2 *
    Math.cos((2 * Math.PI * params.hours) / T_M2 + (2 * Math.PI * params.phase) / SYNODIC_MONTH);
  const solar = s2 * Math.cos((2 * Math.PI * params.hours) / T_S2);
  return lunar + solar;
}

/**
 * The tidal RANGE over the stated window: high water minus low water, in metres.
 *
 * Sampled on a FIXED grid of whole minutes so the answer is a function of the parameters alone. A range found
 * by scanning until the derivative changes sign depends on the step size, which is a number the marking key
 * and the screen would have to agree about for no pedagogical reason.
 */
export function tidalRange(params: TideParams): number {
  const stepMinutes = 1;
  const steps = Math.floor((params.hours * 60) / stepMinutes);
  let high = -Infinity;
  let low = Infinity;
  for (let i = 0; i <= steps; i += 1) {
    const at: TideParams = { ...params, hours: (i * stepMinutes) / 60 };
    const level = height(at);
    if (level > high) high = level;
    if (level < low) low = level;
  }
  return high - low;
}

/** The semidiurnal period, hours — the M2 constituent's own period, and never the beat's. */
export const semidiurnalPeriod = (): number => T_M2;

/**
 * The beat period between M2 and S2, in DAYS.
 *
 * REPORTED, NEVER ASKED FOR. The card names the conditioning: this is a difference of two reciprocals of
 * numbers 0.42 apart, so it is poorly conditioned and a two-decimal arithmetic route disagrees with a
 * three-decimal one by about a day.
 */
export function beatPeriodHours(): number {
  return 1 / Math.abs(1 / T_M2 - 1 / T_S2);
}

/**
 * The beat period in DAYS: 14.77, which is what the card states.
 *
 * THE DIVISION BY 24 IS NOT COSMETIC. The card writes the formula as
 * `1/(1/12.42 − 1/12.00)` and calls the result 14.77 days, but that expression is in HOURS and evaluates to
 * 354.4. The card's own arithmetic is dimensionally wrong by a factor of 24, and the figure it quotes is
 * right. See §5 of this simulation's spec card.
 */
export function beatPeriodDays(): number {
  return beatPeriodHours() / 24;
}

/**
 * The ENVELOPE of the summed curve: the instantaneous spring/neap amplitude.
 *
 * This is `|M2| + |S2|` — the largest water level the two constituents could produce at this instant, which
 * is what the words "spring tide" and "neap tide" actually name. It exists so the simulation can MARK the
 * springs and neaps by where they fall rather than by a table of which day of the cycle they are on.
 */
export function envelope(params: TideParams): number {
  const { m2, s2 } = constituentAmplitudes(params.natural);
  const lunar = Math.abs(
    m2 *
      Math.cos((2 * Math.PI * params.hours) / T_M2 + (2 * Math.PI * params.phase) / SYNODIC_MONTH),
  );
  const solar = Math.abs(s2 * Math.cos((2 * Math.PI * params.hours) / T_S2));
  return lunar + solar;
}

/**
 * Whether the basin is near resonance with M2.
 *
 * A THRESHOLD on the computed amplification rather than `natural == T_M2`, so "nearly resonant" is a real
 * band and a student can find a basin that is close without being told where the boundary is.
 */
export function resonant(natural: number): boolean {
  return amplificationFor(T_M2, natural) >= RESONANT_AMPLIFICATION;
}

/** The amplification of the DOMINANT constituent, which is what the answer field reports. */
export function amplification(natural: number): number {
  const { m2, s2 } = constituentAmplitudes(natural);
  return Math.max(m2, s2);
}

/**
 * Read a yes/no answer, because `asNumber` returns `null` for a boolean and `numeric` would report
 * UNPARSEABLE for a student who answered `true`.
 *
 * The three spellings are the ones a select, a checkbox and a text box produce. The SDK has no helper for
 * this — `asNumber` is the only reader — so each simulation with a boolean field carries its own, and the
 * reason is the same in each: refusing `yes` teaches a student the host's preferred spelling rather than the
 * tides.
 */
export function asBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  const text = String(value ?? '')
    .trim()
    .toLowerCase();
  if (['true', 'yes', '1'].includes(text)) return true;
  if (['false', 'no', '0'].includes(text)) return false;
  return null;
}

export const format = (value: number, places = 3): string => {
  if (!Number.isFinite(value)) return 'undefined';
  const factor = 10 ** places;
  const rounded = Math.round(value * factor) / factor;
  return Object.is(rounded, -0) ? '0' : String(rounded);
};

/** The text alternative, DERIVED, and it states the beat rather than expecting the student to derive it. */
export function describeTides(params: TideParams): string {
  return (
    `A coastline with a tide curve for ${format(params.hours, 0)} hours from a basin whose natural period ` +
    `is ${format(params.natural, 3)} hours, starting at lunar phase day ${format(params.phase, 2)} of a ` +
    `${format(SYNODIC_MONTH, 2)}-day cycle. The tide is the sum of the M2 constituent (${format(T_M2, 7)} ` +
    `hours) and the S2 constituent (${format(T_S2, 3)} hours), and their interference beats every ` +
    `${format(beatPeriodDays(), 2)} days. The range over that window is ${format(tidalRange(params))} metres, ` +
    `the semidiurnal period is ${format(T_M2, 4)} hours, the basin amplifies by ` +
    `${format(amplification(params.natural))} and it is ${resonant(params.natural) ? 'near resonance' : 'not near resonance'}.`
  );
}

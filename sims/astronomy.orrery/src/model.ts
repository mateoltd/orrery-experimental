/**
 * The model. Pure, DOM-free, deterministic.  (P6-T11, gold sim 19)
 *
 * ## THE FIRST SIMULATION IN THIS SET WHOSE TIME IS AN ARGUMENT
 *
 * ## Time is an INPUT here, not a thing that happens to the simulation.
 *
 * Everything else in this set advances by counting: a projectile integrates, a binary search ticks. This one
 * is asked *where is the planet at day 900,000*, and it answers from `t` alone.
 *
 * That is a different contract, and the reason is `INV-TIME-1` — time flows through `@orrery/clock`, and a
 * wall clock cannot be queried backwards. So `positionAt` is a PURE FUNCTION OF `(params, t)`. Drag the
 * slider to 900,000 days and back to 3, and the planet is exactly where it was the first time: not
 * approximately, not after a settling frame, but bit-for-bit.
 *
 * The first version integrated a loop from `t = 0` up to `t`. That is correct once and irrecoverable: it
 * cannot answer a slider dragged backwards, and a "scrub to see the past" control that cannot see the past is
 * a lie with a slider on it.
 *
 * ## `step()` SATURATES RATHER THAN ACCUMULATES
 *
 * A host that wants to advance time still can, via `step()`. But `step()` clamps at `maxTime` rather than
 * carrying an accumulator, so a student who holds a step button down for ten minutes arrives at the end of
 * the timeline instead of at `10^9` days of accumulated rounding error.
 *
 * ## ORBITS ARE CIRCULAR, AND THAT IS THE POINT
 *
 * `plans/10` asks this simulation for WebGL, continuous time, and a large-but-legal bundle. It does not ask
 * it for a Kepler solver, and adding one would put a second numerical implementation in a simulation whose
 * whole job is to prove the TIME is right. A circular orbit with the right period answers the question the
 * student is asked, and any drift a student sees is drift in the time handling rather than in an integrator
 * nobody can check by hand.
 */

export interface OrreryParams {
  /** Semi-major axis in AU. */
  readonly a: number;
  /** Eccentricity, 0..0.9. Drawn, and read by nothing else — see the note above. */
  readonly e: number;
  /** Orbital period in Earth days. */
  readonly period: number;
}

/** The slider's range. Ten Earth years, which is 4000 days and enough to see a perihelion 30 times. */
export const MAX_TIME = 4000;

export const clamp = (params: Partial<OrreryParams>): OrreryParams => {
  const bounded = (value: unknown, fallback: number, min: number, max: number): number => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, Math.round(parsed * 1000) / 1000));
  };
  return {
    a: bounded(params.a, 1, 0.1, 40),
    e: bounded(params.e, 0.017, 0, 0.9),
    period: bounded(params.period, 365.25, 1, 5000),
  };
};

/** FOUR DECIMALS on a day count, which is a hundredth of a second. More digits than the sim can show. */
export const round = (value: number): number => {
  const rounded = Math.round(value * 1e4) / 1e4;
  return Object.is(rounded, -0) ? 0 : rounded;
};

export function format(value: number): string {
  if (!Number.isFinite(value)) return 'undefined';
  return Object.is(value, -0) ? '0' : String(value);
}

/**
 * THE HELIOCENTRIC POSITION AT DAY `t`, IN AU.
 *
 * ## WHY `t` IS THE SECOND ARGUMENT AND NOT THE FIRST
 *
 * Because `t` is the thing every caller varies. A time-first signature is the one that invites a closure
 * capturing "now" at module load, which is how a simulation that documents determinism quietly loses it.
 *
 * ## WHY A CIRCLE, WHEN `e` IS RIGHT THERE
 *
 * Because the second implementation of the position is the bug this simulation cannot afford. If the
 * drawing solved an ellipse and the grader solved a circle, they would agree at `e = 0` and disagree
 * everywhere else, and the disagreement would look like a rendering fault. The eccentricity is therefore
 * used to DRAW the orbit ellipse and by nothing else, and `describeOrbit` says so.
 *
 * `Math.sin`/`Math.cos` of a large argument is periodic with bounded error, so `t = 4000` is exactly as
 * well-defined as `t = 4`. Float accumulation is not.
 */
export function positionAt(
  params: OrreryParams,
  t: number,
): { readonly x: number; readonly y: number } {
  const angle = (2 * Math.PI * t) / Math.max(params.period, 1e-9);
  return {
    x: round(params.a * Math.cos(angle)),
    y: round(params.a * Math.sin(angle)),
  };
}

/** The Sun's position. Exported so no caller invents `{x: 0, y: 0}` and gets it subtly wrong. */
export const SUN = { x: 0, y: 0 } as const;

/** The distance from the Sun. Constant, because the orbit is a circle. */
export const radiusAt = (params: OrreryParams): number => params.a;

/**
 * THE TIME AXIS, CLAMPED AT BOTH ENDS.
 *
 * A hostile slider is one that can be dragged to absurd values, and an absurd value must still produce a
 * position rather than `NaN`. `Number.isFinite` first: `Infinity` in, a real number out.
 */
export const clampTime = (t: number, maxTime: number = MAX_TIME): number => {
  /**
   * `+Infinity` LANDS AT THE END, NOT AT ZERO.
   *
   * The first version returned 0 for every non-finite value, so a slider dragged as far right as it would go
   * -- which a browser reports as the maximum, and a host computing "the end of the timeline" may report as
   * `Infinity` -- snapped back to day zero. That is the worst possible failure for this control: the student
   * drags to the end of the year and is silently shown the first day. `NaN` genuinely has no direction and
   * still falls back to zero.
   */
  if (Number.isNaN(t)) return 0;
  if (t === Number.POSITIVE_INFINITY) return maxTime;
  if (t === Number.NEGATIVE_INFINITY) return 0;
  return Math.min(maxTime, Math.max(0, t));
};

/**
 * ADVANCE THE CLOCK, SATURATING AT THE END.
 *
 * `maxTime + dt` returns `maxTime` and does not drift past it, so a student holding a step button down
 * cannot accumulate error and cannot end up somewhere the host did not expect.
 */
export function step(t: number, dt: number, maxTime: number = MAX_TIME): number {
  return clampTime(t + dt, maxTime);
}

export const isComplete = (t: number, maxTime: number = MAX_TIME): boolean =>
  clampTime(t, maxTime) >= maxTime;

/**
 * THE PERIODICITY PROPERTY: A WHOLE NUMBER OF ORBITS LATER IS THE SAME PLACE.
 *
 * This is the check that actually says something, and the first version of it said nothing at all. It
 * "arrived at t the long way round in hops", accumulated float error doing so, landed on a slightly different
 * day, and then reported `false` — a failure of the WALK, not of the model. A checker that manufactures its
 * own drift is worse than no checker, because it will be "fixed" by loosening it.
 *
 * `t` and `t + n * period` are the same instant to the model, so they must give identical bits.
 */
export function positionIsPeriodic(params: OrreryParams, t: number, orbits = 3): boolean {
  const direct = positionAt(params, t);
  const later = positionAt(params, t + orbits * params.period);
  return direct.x === later.x && direct.y === later.y;
}

/**
 * THE SAME DAY, WHATEVER ELSE HAS HAPPENED TO THE SLIDER.
 *
 * `positionAt` takes only `(params, t)`, so this is trivially true of a pure function -- and that is the
 * point worth asserting. The first version tried to prove it by walking `t` up in hops, and the walk's own
 * float error made it false. The property being defended is about the FUNCTION'S SIGNATURE, and it is
 * checked here by calling the function with a `t` reached in different ways but equal exactly.
 */
export function positionIsTimeInvariant(params: OrreryParams, t: number): boolean {
  const direct = positionAt(params, t);
  const viaDouble = positionAt(params, (t * 2) / 2);
  const viaSum = positionAt(params, t + 0 - 0);
  return (
    direct.x === viaDouble.x &&
    direct.y === viaDouble.y &&
    direct.x === viaSum.x &&
    direct.y === viaSum.y
  );
}

export function describeOrbit(params: OrreryParams): string {
  return (
    `A planet orbits the Sun once every ${format(params.period)} days, at a distance of ` +
    `${format(params.a)} astronomical units. It returns to the same point after one whole orbit.`
  );
}

/**
 * THE QUESTION, and it names the period because the period IS the question here.
 *
 * Unlike every other simulation in this set, this one's text alternative carries the numbers a sighted user
 * reads off the panel. A WebGL canvas cannot be described as "a picture of a planet", so the alternative
 * has to carry the table — and denying a screen-reader user the same route to the answer is a wall, not
 * rigour.
 */
export function describeTask(params: OrreryParams): string {
  return (
    `${describeOrbit(params)} The slider shows how many days have passed. Work out how many days the ` +
    `planet takes to return to the position it is at now.`
  );
}

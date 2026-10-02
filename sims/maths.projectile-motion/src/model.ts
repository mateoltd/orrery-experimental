/**
 * The physics. Pure, and shared by both targets.  (P6-T4, gold sim 1)
 *
 * ## WHY THIS FILE IS SEPARATE FROM `browser.ts` AND `grader.ts`
 *
 * `INV-SIM-2`: `simulate` must run identically in a browser and in Node, because that is what makes
 * server-side grading and deterministic conformance possible. If the physics lived in the render
 * file, the grader would import a canvas. So it lives here, is imported by both, and the dual-target
 * gate proves neither bundle grew a DOM reference on the way.
 */

export interface ProjectileParams {
  readonly speed: number;
  readonly angle: number;
  readonly gravity: number;
}

export interface ProjectileState {
  /** Sim time in seconds. */
  readonly t: number;
}

export interface ProjectilePoint {
  readonly x: number;
  readonly y: number;
  readonly vy: number;
}

export const MAX_FLIGHT_SECONDS = 30;

export const initialState = (): ProjectileState => ({ t: 0 });

/**
 * Position at time `t`. One launch, no air resistance — the model is stated precisely enough to be
 * checked, which `plans/10` §7 asks of a spec card and a reviewer is entitled to.
 */
export function simulate(
  params: ProjectileParams,
  _state: ProjectileState,
  t: number,
): ProjectilePoint {
  const radians = (params.angle * Math.PI) / 180;
  const vx = params.speed * Math.cos(radians);
  const vy = params.speed * Math.sin(radians);
  return {
    x: vx * t,
    y: vy * t - 0.5 * params.gravity * t * t,
    vy: vy - params.gravity * t,
  };
}

/** When it lands, by solving `y = 0` for `t > 0`. */
export function flightTime(params: ProjectileParams): number {
  const vy = params.speed * Math.sin((params.angle * Math.PI) / 180);
  if (vy <= 0) return 0;
  return (2 * vy) / params.gravity;
}

/** How far it goes. The identity `R = v² sin(2θ) / g`, computed the long way so it agrees. */
export function range(params: ProjectileParams): number {
  return simulate(params, initialState(), flightTime(params)).x;
}

/** The peak, which the text alternative quotes. */
export function apex(params: ProjectileParams): { height: number; at: number } {
  const vy = params.speed * Math.sin((params.angle * Math.PI) / 180);
  return { height: (vy * vy) / (2 * params.gravity), at: vy / params.gravity };
}

/** Sampled points for drawing, including the landing point so the arc ends on the ground. */
export function trajectory(params: ProjectileParams, steps = 60): ProjectilePoint[] {
  const end = flightTime(params);
  const points: ProjectilePoint[] = [];
  for (let i = 0; i <= steps; i += 1) {
    points.push(simulate(params, initialState(), (end * i) / steps));
  }
  return points;
}

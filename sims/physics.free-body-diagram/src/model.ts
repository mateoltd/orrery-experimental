/**
 * The model. Pure, DOM-free, deterministic.  (P6-T11, gold sim 18)
 *
 * ## THE FIRST SIMULATION THE MACHINE DOES NOT DECIDE
 *
 * Every other simulation here answers with a number, a set, or a sequence, and the grader compares it to an
 * expectation. A free-body diagram is none of those. "Weight 19.62 N down, normal force 19.62 N up,
 * friction 3 N left" is a set of vectors with magnitudes, and whether that earns 3 of 4 depends on
 * judgements a matcher cannot make: is a student who wrote 20 N instead of 19.62 wrong, or right and using
 * their school's `g = 10`?
 *
 * So this simulation collects what the student asserted and hands the bundle to a person. `rubric()` in the
 * SDK refuses a decision with no reason, because a mark a teacher cannot explain cannot be appealed.
 *
 * ## `g` IS 9.81 AND THAT IS THE FIRST MISCONCEPTION
 *
 * A 2 kg crate weighs 19.62 N and not 20. A student who writes 20 has done the multiplication correctly and
 * rounded `g` to the value their school uses. Whether that earns marks is a judgement, not a calculation —
 * which is exactly why this is a rubric simulation and not a tolerance one.
 *
 * ## AND THE SCENARIO REALLY IS AN EQUILIBRIUM CASE
 *
 * The crate moves at CONSTANT SPEED, so weight and normal cancel. `netForce` is exported so a test can assert
 * that, because otherwise the prompt would be teaching students to look for a resultant that does not exist.
 */

export interface ScenarioParams {
  readonly mass: number;
  readonly friction: number;
}

export type Component = 'up' | 'down' | 'left' | 'right';

/** One force the student asserted: a magnitude and the way it points. */
export interface Vector {
  readonly name: string;
  readonly magnitude: number;
  readonly component: Component;
}

export const WEIGHT_PER_KILO = 9.81;

/** TWO DECIMALS, because 19.62 is not 19.6 and the difference is the misconception. */
export const round2 = (value: number): number => {
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? 0 : rounded;
};

export function weightNewtons(massKg: number): number {
  return round2(massKg * WEIGHT_PER_KILO);
}

export const clamp = (params: Partial<ScenarioParams>): ScenarioParams => {
  const bounded = (value: unknown, fallback: number, max: number, min: number): number => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, Math.round(parsed * 10) / 10));
  };
  return {
    mass: bounded(params.mass, 2, 20, 0.5),
    friction: bounded(params.friction, 3, 20, 0),
  };
};

/**
 * THE FORCES THAT ARE THERE, for the default crate.
 *
 * Weight down, normal force up, friction right — a crate dragged to the LEFT at constant speed, so friction
 * opposes the motion and points right. A student who omits the normal force has made a different mistake
 * from one who misaims the friction, and both are visible in what they assert, which is what makes this
 * worth a rubric rather than a matcher.
 */
export function forcesFor(params: ScenarioParams): readonly Vector[] {
  const weight = weightNewtons(params.mass);
  return [
    { name: 'weight', magnitude: weight, component: 'down' },
    { name: 'normal force', magnitude: weight, component: 'up' },
    { name: 'friction', magnitude: params.friction, component: 'right' },
  ];
}

/**
 * THE NET FORCE, which for the vertical pair is zero, and is the answer to a question nobody asked.
 *
 * Exported so a test can assert the scenario really is an equilibrium case in the axis that matters.
 */
export function netForce(forces: readonly Vector[]): number {
  let x = 0;
  let y = 0;
  for (const force of forces) {
    if (force.component === 'right') x += force.magnitude;
    if (force.component === 'left') x -= force.magnitude;
    if (force.component === 'up') y += force.magnitude;
    if (force.component === 'down') y -= force.magnitude;
  }
  return round2(Math.sqrt(x * x + y * y));
}

/** The vertical resultant only, which is what a crate at constant speed pins to zero. */
export function verticalNetForce(forces: readonly Vector[]): number {
  let y = 0;
  for (const force of forces) {
    if (force.component === 'up') y += force.magnitude;
    if (force.component === 'down') y -= force.magnitude;
  }
  return round2(y);
}

/**
 * THE QUESTION, without the answer in it.
 *
 * The mass and the friction are the question's own inputs and belong here. The WEIGHT does not: `19.62` in
 * the text alternative would hand over the number a student is asked to derive, in the exact place a
 * screen-reader user is told to look.
 */
export function describeForces(params: ScenarioParams): string {
  return (
    `A crate of ${format(params.mass)} kg rests on a rough horizontal floor. A rope pulls it to the LEFT ` +
    `and it moves at CONSTANT SPEED. Draw a free-body diagram: for every force you believe acts, give its ` +
    `magnitude in newtons and the direction it points. The floor pushes back, and the friction opposing the ` +
    `motion is ${format(params.friction)} N.`
  );
}

export function format(value: number): string {
  if (!Number.isFinite(value)) return 'undefined';
  return Object.is(value, -0) ? '0' : String(value);
}

/**
 * WHAT THE STUDENT ASSERTED, as a bundle for a person to mark.
 *
 * Claims rather than a score. The claims are what a rubric is applied TO, and flattening them into marks
 * before a human has looked is the failure this whole simulation exists to prevent.
 */
export interface RubricClaim {
  readonly claim: string;
  /** The student's own words. A teacher reads this, not the simulation. */
  readonly evidence: string;
  /** ALWAYS `null`. See the header: `false` would report a judgement nobody made. */
  readonly correct: null;
}

export function claimsFrom(answer: unknown): readonly RubricClaim[] {
  if (answer === null || typeof answer !== 'object') return [];
  const record = answer as { claims?: unknown };
  if (!Array.isArray(record.claims)) return [];
  const claims: RubricClaim[] = [];
  for (const entry of record.claims) {
    if (entry === null || typeof entry !== 'object') continue;
    const item = entry as { claim?: unknown; evidence?: unknown };
    const claim = typeof item.claim === 'string' ? item.claim.trim() : '';
    if (claim === '') continue;
    claims.push({
      claim,
      evidence: typeof item.evidence === 'string' ? item.evidence.trim() : '',
      correct: null,
    });
  }
  return claims;
}

/** One line per claim, for the host's rubric panel. */
export function summariseClaims(claims: readonly RubricClaim[]): string {
  if (claims.length === 0) return 'no claims were submitted';
  return claims.map((claim, index) => `${String(index + 1)}. ${claim.claim}`).join('; ');
}

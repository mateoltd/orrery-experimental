/**
 * The model. Pure, DOM-free, deterministic.  (P6-T11, gold sim 8)
 *
 * ## SCENARIOS ARE LOAD-BEARING HERE, WHICH IS WHY THEY EXIST
 *
 * `s = ut + ½at²` is one formula and it is useless without knowing which situation the numbers describe.
 * A stone dropped, a ball thrown up and a trolley rolling all use it, and all three give different
 * answers from similar-looking numbers. So the SCENARIO decides the initial velocity and the acceleration,
 * and the student's adjustable quantity is time.
 *
 * That makes `capabilities.scenarios` a real claim rather than a list of names nobody reads: the host and
 * the teacher choose the situation, and the simulation answers for it.
 *
 * ## AN UNKNOWN SCENARIO NAME CHANGES NOTHING
 *
 * `plans/10` §2.3 has a specific error for this: `loadScenario named a scenario not in the manifest's
 * list`. Silently falling back to a default would put a student in a physics situation nobody asked for,
 * and the numbers would be wrong in a way nothing reports.
 */

export interface Scenario {
  readonly name: string;
  readonly label: string;
  /** Initial velocity, m/s. Positive is upwards or forwards. */
  readonly u: number;
  /** Acceleration, m/s². Free fall is negative. */
  readonly a: number;
}

export const SCENARIOS: readonly Scenario[] = [
  { name: 'dropped', label: 'A stone dropped from rest', u: 0, a: -9.81 },
  { name: 'thrown', label: 'A ball thrown upwards at 15 m/s', u: 15, a: -9.81 },
  { name: 'rolled', label: 'A trolley rolling at a steady 6 m/s', u: 6, a: 0 },
];

export interface KinematicsParams {
  readonly scenario: string;
  /** Time, seconds. The student's one adjustable quantity. */
  readonly t: number;
}

export const findScenario = (name: unknown): Scenario | null =>
  SCENARIOS.find((scenario) => scenario.name === name) ?? null;

export const isScenarioName = (name: unknown): boolean => findScenario(name) !== null;

/** Displacement, metres, from `s = ut + ½at²`. */
export function displacement(scenario: Scenario, t: number): number {
  return scenario.u * t + 0.5 * scenario.a * t * t;
}

/** The height above the throw point: positive while rising, negative once it has fallen past. */
export const height = displacement;

/** One sentence, and it must not contain the displacement — that is the answer. */
export function describeKinematics(scenario: Scenario, t: number): string {
  const at = format(t);
  if (scenario.name === 'rolled') {
    return (
      `${scenario.label}, travelling at a steady ${format(scenario.u)} metres per second. ` +
      `After ${at} seconds it has travelled a distance that does not depend on time squared, ` +
      `because the acceleration is zero. The task is to work out how far.`
    );
  }
  const up = scenario.u > 0;
  return (
    `${scenario.label}. Its acceleration is ${format(scenario.a)} metres per second squared, ` +
    `which is gravity acting downwards. After ${at} seconds the task is to work out how far it has ` +
    `moved, ${up ? 'and whether it is still going up' : 'straight down'}.`
  );
}

export const format = (value: number): string => {
  if (!Number.isFinite(value)) return 'undefined';
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? '0' : String(rounded);
};

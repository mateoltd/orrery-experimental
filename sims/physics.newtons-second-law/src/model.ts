/**
 * The model. Pure, DOM-free, deterministic.  (P6-T11, gold sim 4)
 *
 * ## F = ma, REARRANGED THREE WAYS
 *
 * Most "solve for x" exercises are three separate questions wearing a coat. This one is genuinely one:
 * the same relationship, with the unknown chosen by the student, and the answer is whichever quantity
 * they asked for. That makes the ENUM parameter load-bearing rather than decorative — the answer's SHAPE
 * changes with it, which no previous gold sim does.
 *
 * ## A ZERO OR NEGATIVE MASS IS NOT A MASS
 *
 * `m = 0` divides by zero and `m < 0` is not physical. Both return `null` rather than a number, for the
 * same reason the linear sim's flat line returns `null`: a non-finite value that reaches a grader turns
 * every tolerance comparison into `NaN > NaN`, which is false, and a student is marked wrong for the
 * simulation's arithmetic rather than for their answer.
 */

export type SolveFor = 'acceleration' | 'force' | 'mass';

export const SOLVE_FOR: readonly SolveFor[] = ['acceleration', 'force', 'mass'];
export interface NewtonParams {
  /** Net force, newtons. A GIVEN unless `solveFor` is `force`. */
  readonly force: number;
  /** Mass, kilograms. A GIVEN unless `solveFor` is `mass`. */
  readonly mass: number;
  /** Acceleration, m/s². A GIVEN unless `solveFor` is `acceleration`. */
  readonly accel: number;
  readonly solveFor: SolveFor;
}

export const isSolveFor = (value: unknown): value is SolveFor =>
  typeof value === 'string' && (SOLVE_FOR as readonly string[]).includes(value);

/** Acceleration, m/s². `null` when the mass is not physical. */
export function acceleration(params: NewtonParams): number | null {
  if (!(params.mass > 0)) return null;
  return params.force / params.mass;
}

/** Force, newtons, from mass and acceleration. */
export function force(params: NewtonParams): number | null {
  if (!(params.mass > 0)) return null;
  return params.mass * params.accel;
}

/**
 * Mass, kilograms.
 *
 * ## THE ACCELERATION IS A GIVEN, NOT A DERIVED ONE
 *
 * The first version computed `mass = force / acceleration` where `acceleration` was itself
 * `force / mass` — so it handed back the mass it had been given and the question was circular. It also
 * produced a beautifully wrong answer: 24 N on 4 kg "solved for mass" returned 4, when the student is
 * asked for 6. The declared `expect.grade` caught it on the first run, which is the entire argument for
 * honouring a manifest's own expectations.
 *
 * `plans/10` gives the host no way to declare an equation with a variable on both sides, so the fix is
 * three parameters where the one being SOLVED FOR is ignored and the other two are the givens. Which is
 * also how the question is really set: "a 24 N force acts on a body accelerating at 6 m/s² — find the
 * mass."
 */
export function mass(params: NewtonParams): number | null {
  // Two ways there is no mass, and both are "no answer" rather than a number:
  //  - `a === 0` is indeterminate: any mass at all gives zero net force, so F says nothing;
  //  - `F === 0` at a non-zero acceleration gives a mass of ZERO, which is not a mass.
  //
  // The second one was missed by the first version, which returned 0 and the grader then reported "The
  // mass is 0 kg" to a student who had correctly said there was none.
  if (params.accel === 0) return null;
  const derived = params.force / params.accel;
  return derived > 0 ? derived : null;
}

/** The quantity the student asked for. The answer's NAME is part of the answer. */
export function solve(params: NewtonParams): { name: string; unit: string; value: number | null } {
  if (params.solveFor === 'force') return { name: 'Force', unit: 'N', value: force(params) };
  if (params.solveFor === 'mass') return { name: 'Mass', unit: 'kg', value: mass(params) };
  return { name: 'Acceleration', unit: 'm/s²', value: acceleration(params) };
}

/** Which parameter the student does NOT need, so the panel can say so rather than let it mislead. */
export const ignoredParam = (solveFor: SolveFor): 'force' | 'mass' | 'accel' => {
  if (solveFor === 'force') return 'force';
  if (solveFor === 'mass') return 'mass';
  return 'accel';
};

/**
 * One sentence, from the same functions the panel draws from.
 *
 * Naming the GIVENS and the UNKNOWN both matters: "4" is not an answer to "what is the mass?", and a
 * caption that omitted it would leave a screen-reader user guessing which of three numbers was wanted.
 */
export function describeNewton(params: NewtonParams): string {
  const solved = solve(params);
  const ignored = ignoredParam(params.solveFor);
  if (solved.value === null) {
    const why =
      ignored === 'force'
        ? 'a zero acceleration carries no force'
        : 'a mass of zero or less is not a mass';
    return `These values give no ${solved.name.toLowerCase()} to report: ${why}.`;
  }
  const givens = (['force', 'mass', 'accel'] as const)
    .filter((name) => name !== ignored)
    .map((name) =>
      name === 'force'
        ? `a net force of ${format(params.force)} newtons`
        : name === 'mass'
          ? `a mass of ${format(params.mass)} kilograms`
          : `an acceleration of ${format(params.accel)} metres per second squared`,
    )
    .join(' acting with ');
  return `With ${givens}, the ${solved.name.toLowerCase()} is ${format(solved.value)} ${solved.unit}.`;
}

export const format = (value: number): string => {
  if (!Number.isFinite(value)) return 'undefined';
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? '0' : String(rounded);
};

/**
 * The model. Pure, DOM-free, deterministic.  (P6-T11, gold sim 22)
 *
 * ## THE FIRST SIMULATION WHOSE STATE IS PRODUCED BY INTEGRATION
 *
 * Every simulation so far has answered `positionAt(t)` — a pure function of a number. This one ADVANCES:
 * the angle at step `n + 1` is computed from the angle at step `n`. That is a categorically different contract,
 * and it is the one the plan means by `physics.pendulum | fixed-timestep determinism`.
 *
 * ## WHY THE TIMESTEP IS FIXED, AND WHY THAT IS THE WHOLE SUBJECT
 *
 * A pendulum integrated at whatever step the browser happened to give it produces a DIFFERENT TRAJECTORY on a
 * 144 Hz laptop than on a 60 Hz one, because a larger step is a coarser approximation of the same integral. The
 * simulation would still be "correct" — the energy would still be nearly conserved, the period would still be
 * about two seconds — and it would be wrong in the only way that matters for a student who scrubs backwards
 * and expects the same pendulum.
 *
 * So the step is a CONSTANT, the step COUNT is the state, and time is `step * DT`. The renderer may draw at
 * whatever rate it likes; it asks the model for a step number and gets an answer that does not depend on how
 * fast it asked. A slow frame makes the animation choppy, which is a cosmetic problem with a cosmetic fix.
 *
 * ## THE INTEGRATOR IS SYMPLECTIC ON PURPOSE
 *
 * Semi-implicit (symplectic) Euler, not plain Euler. Plain Euler adds energy every step and the pendulum winds
 * up; symplectic Euler adds energy and then removes it, and the error stays bounded and oscillatory instead of
 * growing without limit. For a simulation whose entire claim is "this trajectory is reproducible and
 * physically honest", an integrator that slowly gains energy would be a self-refuting choice — and the test
 * that catches it is `energyDoesNotDrift`.
 */

/** The fixed timestep, in seconds. `1/240` is small enough that the period is right to a few parts in a thousand. */
export const DT = 1 / 240;

/** Gravity, in m/s². */
export const G = 9.81;

/** The length of the pendulum, in metres. The only parameter that sets the period. */
export const LENGTH = 1;

export interface PendulumParams {
  /** Length in metres. Longer is slower, by `sqrt(L)`. */
  readonly length: number;
  /** Initial angle in RADIANS. Degrees are the trap; see `degToRad`. */
  readonly start: number;
}

/**
 * THE START ANGLE IS CAPPED, AND THE CAP IS IN DEGREES.
 *
 * ## WHY THE CAP EXISTS
 *
 * Past about 60 degrees the small-angle formula `2*pi*sqrt(L/g)` is far enough off that a student checking
 * their arithmetic against this simulation concludes the textbook is wrong. It is not wrong, it is an
 * APPROXIMATION, and the simulation would be teaching "textbooks are unreliable" by accident.
 *
 * ## AND THE RADIAN CAP IS DERIVED FROM IT, NOT WRITTEN ALONGSIDE IT
 *
 * The clamp used to hold `1.05` — which is 60.16 degrees — while the constant said 60. So a pendulum clamped
 * to its limit sat 0.16 degrees past the angle the file claimed was the maximum, the parameter panel and the
 * model disagreed about the range, and the test caught it by failing on a rounding error. Two declarations of
 * one bound is exactly the drift this repository keeps finding; deriving one from the other removes it.
 */
export const MAX_START_DEG = 60;

/** The same bound in radians, which is what the integrator takes. */
export const MAX_START_RAD = (MAX_START_DEG * Math.PI) / 180;

export const clamp = (params: Partial<PendulumParams>): PendulumParams => {
  const length = Number(params.length);
  const start = Number(params.start);
  return {
    // 0.2 m to 4 m. Below 0.2 the period is under a second and the animation is a blur; above 4 m it is over
    // four seconds and a student waits. Both bounds are UX, and both are enforced in ONE place.
    length: Number.isFinite(length)
      ? Math.min(4, Math.max(0.2, Math.round(length * 100) / 100))
      : 1,
    // The start angle is capped at 60 degrees. Past about 70 the small-angle approximation behind the
    // textbook period is far enough off that a student checking `T = 2*pi*sqrt(L/g)` against the simulation
    // concludes the formula is wrong -- and it is the formula that has been quietly assumed all along.
    start: Number.isFinite(start) ? Math.min(MAX_START_RAD, Math.max(-MAX_START_RAD, start)) : 0.5,
  };
};

/** Degrees to radians, because that is how a student thinks and how a parameter panel is labelled. */
export const degToRad = (degrees: number): number => (degrees * Math.PI) / 180;
export const radToDeg = (radians: number): number => (radians * 180) / Math.PI;

/** The angle beyond which the small-angle formula is too far off to be worth quoting. */

export interface PendulumState {
  /** Angle from vertical, in radians. */
  readonly angle: number;
  /** Angular velocity, in radians per second. */
  readonly velocity: number;
  /** THE STEP COUNT IS THE STATE. Not the time — the count, because the count is what is reproducible. */
  readonly steps: number;
}

/** The opening position, at rest. */
export const initialState = (params: PendulumParams): PendulumState => ({
  angle: params.start,
  velocity: 0,
  steps: 0,
});

/** The restoring acceleration: `-g/L * sin(angle)`, which is the whole of the physics. */
export function acceleration(angle: number, length: number): number {
  const value = -(G / Math.max(length, 1e-9)) * Math.sin(angle);
  // `-0 * 1` is `-0`, and `Object.is(-0, 0)` is FALSE. A state checksum built from this number would then
  // differ between a pendulum at rest and one at rest by a hair's width, and a test asserting `toBe(0)` would
  // fail for no reason a student could explain. Normalised here so the two are indistinguishable, which is
  // what "the pendulum is at rest hanging straight down" means.
  return value === 0 ? 0 : value;
}

/**
 * ONE STEP, SEMI-IMPLICIT EULER.
 *
 * ## THE ORDER IS THE WHOLE POINT
 *
 * 1. `velocity += acceleration(angle) * DT` — use the CURRENT angle
 * 2. `angle += velocity * DT` — use the NEW velocity
 *
 * Plain Euler does both from the old values, which is first-order and adds energy. Reversing the order makes
 * it second-order and symplectic: the error oscillates around the true trajectory instead of growing. The
 * difference is visible in this simulation's own energy plot within a few hundred steps, which is exactly
 * where a student would be looking.
 */
export function stepOnce(state: PendulumState, length: number): PendulumState {
  const velocity = state.velocity + acceleration(state.angle, length) * DT;
  const angle = state.angle + velocity * DT;
  return { angle, velocity, steps: state.steps + 1 };
}

/**
 * RUN `n` STEPS FROM THE STARTING POSITION.
 *
 * A pure function of `(n, params)` — the same discipline as the orrery's `positionAt(t)`, and for the same
 * reason. **INTEGRATION AND REPLAYABILITY ARE NOT IN CONFLICT**: the integration happens inside, deterministically,
 * from a fixed start, so step 400 is the same number whether you arrived by pressing step 400 times or by
 * arriving at 399 and once more.
 *
 * `maxSteps` is capped because this is a loop and a host that sends `steps: 1e9` would hang the browser tab
 * with no error — a denial of service by parameter.
 */
export function runTo(params: PendulumParams, n: number): PendulumState {
  const capped = Math.min(Math.max(Math.round(n), 0), 200_000);
  let state = initialState(params);
  for (let index = 0; index < capped; index += 1) state = stepOnce(state, params.length);
  return state;
}

/** The time in seconds at a given step. THE ONLY PLACE `DT` IS MULTIPLIED INTO A TIME. */
export const timeAt = (steps: number): number => steps * DT;

/**
 * THE PERIOD, from the SMALL-ANGLE FORMULA: `2 * pi * sqrt(L / g)`.
 *
 * This is the number a student is asked to reproduce, and the reason the start angle is capped at 60 degrees:
 * past that the formula is far enough off that matching it is impossible, and the simulation would be
 * teaching "the textbook formula is wrong" by accident.
 */
export function smallAnglePeriod(length: number): number {
  return 2 * Math.PI * Math.sqrt(Math.max(length, 1e-9) / G);
}

/**
 * THE PERIOD MEASURED FROM THE TRAJECTORY: ONE FULL SWING.
 *
 * ## A TURNING POINT TO A TURNING POINT IS **HALF** A PERIOD
 *
 * This is the bug that made every physics assertion in this simulation vacuous. The first version detected
 * the reversal of the velocity's sign and returned the time between two consecutive reversals — which is the
 * bob going from one extreme to the OTHER extreme and back, and is therefore `T / 2`. It agreed with
 * `2*pi*sqrt(L/g)` to within 1% for every length, which is what a half-period agrees to, so it looked
 * plausible in casual use and wrong in every test.
 *
 * `TWO` reversals are needed, not one. Verified: at L = 1 the two are at steps 249 and 745, which is 2.06 s,
 * and the formula says 2.006 s.
 *
 * ## A REVERSAL IS WHERE THE VELOCITY CHANGES SIGN, AND ZERO IS NOT A SIGN
 *
 * At the turning point the velocity is exactly zero for an instant, so `Math.sign(0)` is `0` and comparing
 * signs across it says "0 became -1", which is not a reversal. The direction is tracked explicitly and zero is
 * skipped, so a momentary stop at the extreme is not counted twice.
 */
export function measuredPeriod(params: PendulumParams): number {
  // Four nominal periods of headroom. The measurement cannot disagree with the formula about how long to look:
  // a simulation 10% SLOWER than the small-angle value still finds its period rather than returning NaN, which
  // would make the comparison a comparison against NaN.
  /**
   * THE LOOK-AHEAD IS DERIVED FROM THE PERIOD, NOT FROM A STEP BUDGET.
   *
   * The first version bounded the search at a fixed 200,000 steps. That is 833 seconds — which covers three
   * periods of a 4 m pendulum ONLY IF the period is ~2 s, and `4 * sqrt(4) = 4.012 s` needs a third reversal at
   * around step 4,440. So it fitted, and then the arithmetic of the cap rather than the physics decided: at
   * L = 4 the function returned `NaN`, the test above it asserted `NaN > 3.97` and failed with a message about
   * an expectation rather than about a missing number.
   *
   * So the search is bounded by TIME and scaled by the period, which is the quantity the answer is measured
   * in. `MAX_STEPS` then caps the work for a pathological length rather than defining it.
   */
  const MAX_STEPS = 200_000;
  const needed = Math.ceil((smallAnglePeriod(params.length) / DT) * 4) + 8;
  const limit = Math.min(MAX_STEPS, Math.max(needed, 64));
  let state = initialState(params);
  let direction = 0;
  let reversals = 0;
  let firstReversalStep = 0;

  for (let index = 0; index < limit; index += 1) {
    state = stepOnce(state, params.length);

    if (state.velocity === 0) {
      // THE BOB IS MOMENTARILY STILL AT THE EXTREME. That is not a direction, and treating it as one counts
      // one swing as two.
      continue;
    }
    const next = state.velocity > 0 ? 1 : -1;
    if (direction !== 0 && next !== direction) {
      reversals += 1;
      if (reversals === 1) firstReversalStep = state.steps;
      // THREE reversals, not two. Consecutive reversals are `max -> min` and `min -> max`, so the gap between
      // the FIRST and the SECOND is a HALF period -- which is what the two-reversal version returned, and it
      // agreed with the formula to within 1% for every length, so it read as plausible and was half. The
      // third reversal is the return to the starting extreme, and only that is a whole swing.
      if (reversals === 3) return timeAt(state.steps - firstReversalStep);
    }
    direction = next;
  }
  return Number.NaN;
}

/** The total mechanical energy, which a real pendulum conserves and a bad integrator does not. */
export function energy(state: PendulumState, length: number): number {
  const kinetic = 0.5 * (state.velocity * length) ** 2;
  // `1 - cos(angle)` rather than `angle^2 / 2`, because the exact form is what the energy check must use.
  const potential = G * length * (1 - Math.cos(state.angle));
  return kinetic + potential;
}

export const round = (value: number): number => {
  const rounded = Math.round(value * 1e6) / 1e6;
  return Object.is(rounded, -0) ? 0 : rounded;
};

export function format(value: number): string {
  if (!Number.isFinite(value)) return 'undefined';
  return String(Number(value.toFixed(4)));
}

/**
 * THE ENERGY PLOT, sampled at every `n`th step.
 *
 * Exported so the test can assert on it directly. A plot a student can see is a claim; a plot a test can read
 * is a fact, and this simulation needs both.
 */
export function energySeries(params: PendulumParams, steps: number, every: number): number[] {
  const series: number[] = [];
  let state = initialState(params);
  series.push(round(energy(state, params.length)));
  for (let index = 1; index <= steps; index += 1) {
    state = stepOnce(state, params.length);
    if (index % Math.max(every, 1) === 0) series.push(round(energy(state, params.length)));
  }
  return series;
}

/** THE QUESTION. It asks for the period, and it does not state the formula. */
export function describeTask(params: PendulumParams): string {
  return (
    `A pendulum of length ${format(params.length)} m is pulled ${format(Math.abs(radToDeg(params.start)))} ` +
    `degrees from vertical and released. Work out how long one complete swing takes, and type that number of ` +
    `seconds in the box.`
  );
}

/** FOR THE TEXT ALTERNATIVE. It gives the length, which is the input — and never the period. */
export function describeAlternative(params: PendulumParams): string {
  return (
    `A pendulum swings back and forth. Its length is ${format(params.length)} metres and it is pulled ` +
    `${format(Math.abs(radToDeg(params.start)))} degrees from vertical before being released. The task is to ` +
    `work out how many seconds one complete swing takes.`
  );
}

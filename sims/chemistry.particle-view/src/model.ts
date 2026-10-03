/**
 * The model. Pure, DOM-free, deterministic.  (P6-T11, gold sim 24)
 *
 * ## THIS IS THE FIRST SIMULATION WHOSE STATE IS BIG ENOUGH FOR THE BUDGET TO BE A REAL CONSTRAINT
 *
 * Twenty-three simulations so far, and the largest state was forty comparisons. This one holds a thousand
 * particles with positions and velocities, which is the corner `plans/10` calls "large state, event-driven".
 * It exists partly for the chemistry and partly because until now nothing in the tree was big enough to
 * exercise the 350 KB bundle budget or the state checksum at size.
 *
 * ## AND IT ADVANCES, FOR THE PENDULUM'S REASON
 *
 * A particle's next position comes from its current position and velocity, so this INTEGRATES rather than
 * evaluating a picture from a clock. That brings the pendulum's discipline with it: a FIXED `dt`, a step COUNT
 * as the state, and `runTo(step)` pure in `(params, step)`. A frame-rate-dependent gas would give a different
 * collision count on a 144 Hz monitor than on a 60 Hz one, which for this question is not a rendering detail
 * but a different answer.
 *
 * ## AND COLLISIONS ARE RESOLVED BY SWAPPING VELOCITIES
 *
 * Two overlapping particles exchange velocities and are pushed apart. That is not an approximation: momentum
 * and kinetic energy are both conserved exactly by a velocity swap, so a student cannot detect the
 * bookkeeping. Resolving an elastic collision from two positions and two velocities instead is more code,
 * throws energy away every time, and needs an overlap test that fails exactly when three particles meet --
 * which at this density they do, constantly.
 */

/** Particles in the default view. `MAX_PARTICLES` is the honest upper bound the renderer can draw at 60 fps. */
export const PARTICLES = 1000;
export const MIN_PARTICLES = 200;
export const MAX_PARTICLES = 2000;

/** The box, in metres. A 20 cm cube at 1 atm. */
export const DEFAULT_BOX = 0.2;

/** Steps per second. Slow enough that a collision is visible rather than a blur. */
export const STEPS_PER_SECOND = 120;
export const DT = 1 / STEPS_PER_SECOND;

export const KELVIN_MIN = 50;
export const KELVIN_MAX = 900;
export const MAX_SEED = 99999;

export interface GasParams {
  readonly kelvin: number;
  readonly box: number;
  readonly particles: number;
}

export const clampKelvin = (raw: unknown): number => {
  const value = Number(raw);
  // NaN-SAFE. `Math.round(NaN)` is NaN, and a NaN speed turns every particle's position into NaN within one
  // step -- where it fails SILENTLY: nothing draws, and the counter freezes at whatever it had reached.
  // The lower bound is 50 K because argon is a solid at 84 K, and a gas of solid lumps is not a gas.
  return Number.isFinite(value)
    ? Math.min(KELVIN_MAX, Math.max(KELVIN_MIN, Math.round(value)))
    : 300;
};

export const clampBox = (raw: unknown): number => {
  const value = Number(raw);
  return Number.isFinite(value)
    ? Math.min(0.5, Math.max(0.05, Math.round(value * 1000) / 1000))
    : DEFAULT_BOX;
};

export const clampParticleCount = (raw: unknown): number => {
  const value = Number(raw);
  return Number.isFinite(value)
    ? Math.min(MAX_PARTICLES, Math.max(MIN_PARTICLES, Math.round(value)))
    : PARTICLES;
};

export const clampSeed = (raw: unknown): number => {
  const value = Number(raw);
  return Number.isFinite(value) ? Math.min(MAX_SEED, Math.max(0, Math.round(value))) : 20240;
};

export const clamp = (params: Partial<GasParams> | undefined): GasParams => ({
  kelvin: clampKelvin(params?.kelvin),
  box: clampBox(params?.box),
  particles: clampParticleCount(params?.particles),
});

/**
 * HOW FAR A PARTICLE TRAVELS IN ONE STEP, IN BOX-WIDTHS. This is the number that has to be small.
 *
 * ## WHY THIS IS NOT 430 m/s
 *
 * The first version used argon's real RMS speed of 430 m/s against a 0.2 m box, which is honest physics and a
 * useless simulation: at `DT = 1/120` a particle crosses the whole box about EIGHTEEN times between collision
 * tests. Every collision was missed by aliasing, so the count fell as the particles sped up -- measured
 * 9552/s at 100 K against 7500/s at 900 K, i.e. a gas that collides LESS when it is hotter. The picture was
 * a blur and the answer was backwards, and both were invisible because the numbers still looked like counts.
 *
 * So the speed is expressed in box-widths per step and the scale is chosen to be WATCHABLE. The ratio between
 * temperatures is unchanged and that is the whole lesson: `sqrt(T)`, so doubling the temperature gives 1.41x
 * the speed and not 2x. A simulation that scaled speed linearly with temperature would let a student confirm
 * that wrong ratio from the picture, which is worse than showing nothing.
 */
/**
 * HOW FAR A PARTICLE TRAVELS IN ONE STEP, IN BOX-WIDTHS. This is the number that must be SMALL.
 *
 * ## WHY THIS IS NOT 430 m/s
 *
 * The first version used argon's real RMS speed of 430 m/s against a 0.2 m box: honest physics, useless
 * simulation. At `DT = 1/120` a particle crosses the whole box about EIGHTEEN times between collision tests,
 * so every collision was missed by aliasing and the count FELL as the particles sped up -- 9552/s at 100 K
 * against 7500/s at 900 K, a gas that collides less when it is hotter. The picture was a blur and the answer
 * was backwards, and neither was visible because the numbers still looked like counts.
 *
 * A twelfth of a box-width per step is the largest value that still reads as motion rather than a smear, and
 * it keeps every particle inside the cell its neighbours occupy, so the sorted sweep below actually finds the
 * pairs that overlap.
 *
 * ## AND THE RATIO BETWEEN TEMPERATURES IS THE WHOLE LESSON
 *
 * `sqrt(T)`, so doubling the temperature gives 1.41x the speed and NOT 2x. A simulation that scaled speed
 * linearly with temperature would let a student confirm that wrong ratio from the picture, which is worse than
 * showing nothing at all.
 */
export const WIDTHS_PER_STEP_AT_300K = 1 / 12;

/**
 * THE ATOM'S DIAMETER AS A FRACTION OF THE DEFAULT BOX.
 *
 * A twentieth of a box is roughly the mean spacing of a thousand atoms in it, so atoms begin within touching
 * distance of their neighbours and the gas has collisions to count from the first step. It is deliberately
 * larger than a real argon atom's diameter would suggest: at true atomic scale in a room-sized box the gas
 * would be almost empty and the count would be zero, which is honest and useless.
 */
export const DIAMETER_FRACTION = 1 / 20;

/** ARGON'S REAL RMS SPEED AT 300 K, kept so the slowdown factor is derived rather than asserted. */
export const RMS_AT_300K = 430;

/**
 * SPEED IN METRES PER SECOND, from the watchable scale.
 *
 * ## THE UNITS ARE THE POINT, AND AN EARLIER VERSION GOT THEM WRONG
 *
 * `box * WIDTHS_PER_STEP_AT_300K / DT` is the only expression here that is metres per second. An earlier
 * draft wrote `box * WIDTHS_PER_STEP_AT_300K` and called it a speed, which is metres per STEP and therefore
 * 120 times too small -- and then named the constant `RMS_AT_300K` and left a comment saying argon does 430.
 * Nothing contradicted anything on screen, so nothing failed. A constant whose name and whose units disagree
 * is the sort of defect that survives a review, because each line is locally plausible.
 */
export const speedFor = (kelvin: number, box: number): number => {
  const clamped = clamp({ kelvin, box });
  return (clamped.box * WIDTHS_PER_STEP_AT_300K * Math.sqrt(clamped.kelvin / 300)) / DT;
};

/** HOW MUCH SLOWER THAN REAL ARGON THE ANIMATION IS, as a derived number the feedback can quote. */
export const slowdownFactor = (kelvin: number, box: number): number =>
  RMS_AT_300K / Math.sqrt(kelvin / 300) / speedFor(kelvin, box);

export interface Particle {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
}

export interface GasState {
  readonly particles: readonly Particle[];
  readonly step: number;
  /** COLLISIONS SINCE STEP 0. Counted, never inferred from a formula. */
  readonly collisions: number;
  /** Collisions in the most recent step. Kept so the rate can be shown without smoothing the variation away. */
  readonly lastCollisions: number;
}

/** xorshift32. `Math.random()` would make the collision rate unreproducible for the student as well as us. */
function randomFor(seed: number): () => number {
  let state = Math.imul(clampSeed(seed) + 0x9e37, 0x85ebca6b) >>> 0;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 4294967296;
  };
}

/**
 * THE CLOUD, LAID OUT ON A GRID AND THEN JITTERED.
 *
 * ## A THOUSAND RANDOM POSITIONS OVERLAP, AND THAT OVERLAP IS A FAKE SPIKE
 *
 * Placed uniformly at random, a fraction of a thousand particles start coincident, and the first step resolves
 * every one of them as a "collision". The student reads a burst in the first second as physics, and the number
 * they then report is a function of how the file was written rather than of the gas. A grid with a tenth of a
 * cell of jitter is visibly disordered but not interpenetrating, so the first second's count is comparable
 * with the second's.
 *
 * ## AND EVERY PARTICLE MOVES AT THE ONE SPEED THE TEMPERATURE GIVES IT
 *
 * The distribution's SPREAD is not drawn. A real gas has a spread of speeds, and drawing one would be more
 * faithful, but it would also make the collision rate depend on the spread, and the question is about how the
 * rate scales with temperature. One speed keeps that answer legible; the spread is the honest simplification
 * and it is recorded here rather than hidden.
 */
export function seededParticles(params: GasParams, seed: number): readonly Particle[] {
  const clamped = clamp(params);
  const random = randomFor(seed);
  const speed = speedFor(clamped.kelvin, clamped.box);
  const side = Math.ceil(Math.sqrt(clamped.particles));
  const cell = clamped.box / side;
  const particles: Particle[] = [];

  for (let id = 0; id < clamped.particles; id += 1) {
    const column = id % side;
    const row = Math.floor(id / side);
    const x = (column + 0.1 + random() * 0.8) * cell;
    const y = (row + 0.1 + random() * 0.8) * cell;
    const angle = random() * Math.PI * 2;
    particles.push({
      id,
      x: Math.min(clamped.box, Math.max(0, x)),
      y: Math.min(clamped.box, Math.max(0, y)),
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
    });
  }
  return particles;
}

export const initialState = (params: GasParams, seed: number): GasState => ({
  particles: seededParticles(params, seed),
  step: 0,
  collisions: 0,
  lastCollisions: 0,
});

/**
 * ONE STEP, and the collision sweep that makes a thousand particles affordable.
 *
 * ## ONLY ADJACENT PAIRS ARE TESTED, AND THE SORT IS WHAT MAKES THAT SOUND
 *
 * The naive double loop is half a million pair tests per step, which at 120 steps a second hangs the browser
 * on the first frame. Sorting by x and testing each particle against the next few finds every overlap that
 * matters in O(n), because two particles can only touch if they are within a cell of each other in x.
 *
 * ## AND THE COUNT IS A LOWER BOUND, WHICH THE FEEDBACK SAYS OUT LOUD
 *
 * The test is on where particles END UP, so two that pass close but not exactly head-on are missed -- and a
 * genuine collision between particles far apart in the list is missed too. With `DT` this coarse the sampling
 * error dominates any finer test, so the number is honestly a count of the collisions this simulation RESOLVED.
 * Presenting it as an exact collision rate would be a number with no physical meaning.
 */
/**
 * THE MOST SUBSTEPS ONE FRAME MAY TAKE. Exported so the test can assert every exposed temperature fits
 * inside it, rather than the cap being discovered at runtime by a physics that has quietly stopped resolving.
 */
export const SUBSTEP_CEILING = 16;

function step(state: GasState, params: GasParams): GasState {
  const clamped = clamp(params);
  const { box } = clamped;
  const side = Math.ceil(Math.sqrt(clamped.particles));
  /**
   * THE GRID CELL, used only to size the neighbour sweep.
   *
   * It is NOT the collision distance, and conflating the two is why the rate came out identical for every box.
   */
  const cell = box / side;
  /**
   * THE COLLISION DISTANCE: A FIXED FRACTION OF THE DEFAULT BOX, NOT OF THE CURRENT ONE.
   *
   * ## WHY THIS IS NOT `cell`
   *
   * Using the cell as the collision distance made the gas SCALE-INVARIANT, and the rate came out identical to
   * the digit for boxes of 0.3, 0.2, 0.1 and 0.05 metres -- a thirty-six-fold change in density producing no
   * change at all.
   *
   * The arithmetic: density goes as `1/box^2`, the cell -- and so the collision cross-section -- goes as
   * `box^2`, and the two cancel exactly. The simulation had accidentally made itself immune to the one
   * variable the question is about.
   *
   * ## WHAT AN ATOM'S SIZE ACTUALLY DEPENDS ON
   *
   * Nothing about argon depends on how big a box you put it in. So the diameter is a property of the GAS and
   * is anchored to `DEFAULT_BOX`, which is what makes the rate rise as the box shrinks and the gas thickens.
   */
  const diameter = DEFAULT_BOX * DIAMETER_FRACTION;
  // THE FASTEST PARTICLE'S DISPLACEMENT IN ONE STEP, and the substep count it forces.
  //
  // This is the bug that made the whole simulation backwards. The detector only tested pairs within one cell,
  // and a particle moves `WIDTHS_PER_STEP_AT_300K * sqrt(T/300)` box-widths per step -- so at 900 K it travels
  // 0.6 widths, more than half the cell the detector can see. Raising the temperature moved particles FURTHER
  // between tests, so MORE of them passed unobserved, and the count FELL: 54333/s at 100 K against 32185/s at
  // 900 K. A gas that collides less when it is hotter is not a gas.
  //
  // Nothing about that was visible in the numbers. Every one was a plausible count, the picture looked like a
  // gas, and the only symptom was a trend that was backwards -- which is why the first test written for it is
  // the trend, not the value.
  const fastest = speedFor(clamped.kelvin, clamped.box);
  const displacement = (fastest * DT) / cell;
  // SUBDIVIDE UNTIL NO PARTICLE MOVES MORE THAN HALF A CELL. Half rather than a whole cell because the test
  // is on the pair's separation and two particles can close twice the gap between them.
  let substeps = Math.max(1, Math.ceil(displacement * 2));
  /**
   * A CEILING ON SUBSTEPPING, so one rendered frame cannot turn into hundreds of thousand-element sorts.
   *
   * At 900 K the honest count is around ten. The ceiling is above every temperature the manifest exposes, and
   * a test asserts that -- so the cap can never quietly become the reason the physics is wrong. If a future
   * parameter range needs more, that test fails and the ceiling is raised deliberately rather than by
   * hitting it at runtime.
   */
  if (substeps > SUBSTEP_CEILING) substeps = SUBSTEP_CEILING;
  const sub = DT / substeps;

  let particles = [...state.particles];
  let collisions = 0;

  for (let tick = 0; tick < substeps; tick += 1) {
    const next: Particle[] = new Array(particles.length);
    for (let index = 0; index < particles.length; index += 1) {
      const particle = particles[index];
      if (particle === undefined) continue;
      /**
       * THE WALL REVERSES THE VELOCITY, NOT JUST THE POSITION.
       *
       * This is the defect that made the gas stand still. `reflect` folded an overshooting position back into
       * the box but left the velocity pointing INTO the wall, so a particle within one substep of a wall was
       * reflected to the inside, immediately crossed the wall again, and was folded back -- forever. Measured:
       * the x coordinate of particle 0 was identical at step 0, 1, 2 and 3, and its y coordinate stopped
       * changing after the first step.
       *
       * The gas still LOOKED alive: the collision counter climbed, because a trapped particle keeps colliding
       * with its neighbours in place. So every rate in this file was a count of particles jiggling in corners,
       * which is why the rate was identical across boxes of 0.3, 0.2, 0.1 and 0.05 metres to the digit -- the
       * geometry had no effect on anything because most of the gas was not moving.
       *
       * A wall in an ideal gas reverses the velocity component perpendicular to it. Folding the position
       * alone is not a weak approximation, it is a particle trapped in a corner.
       */
      const [x, xDirection] = reflect(particle.x + particle.vx * sub, box);
      const [y, yDirection] = reflect(particle.y + particle.vy * sub, box);
      next[index] = {
        id: particle.id,
        x,
        y,
        vx: particle.vx * xDirection,
        vy: particle.vy * yDirection,
      };
    }

    // SORTED BY X, so a pair that can touch must be adjacent or nearly so: two particles within a cell of each
    // other in x cannot be far apart in the ordering. The alternative -- every pair against every pair -- is
    // half a million tests per step for a thousand particles, which hangs the browser on the first frame.
    const order = next
      .map((_particle, index) => index)
      .sort((left, right) => {
        const a = next[left];
        const b = next[right];
        return (a?.x ?? 0) - (b?.x ?? 0);
      });

    for (let index = 0; index < order.length - 1; index += 1) {
      const leftIndex = order[index];
      const rightIndex = order[index + 1];
      if (leftIndex === undefined || rightIndex === undefined) continue;
      const left = next[leftIndex];
      const right = next[rightIndex];
      if (left === undefined || right === undefined) continue;
      // ONE CELL is the widest separation worth testing; beyond it nothing can overlap.
      if (right.x - left.x > diameter) continue;
      const dx = right.x - left.x;
      const dy = right.y - left.y;
      if (dx * dx + dy * dy >= diameter * diameter) continue;
      // SWAP THE VELOCITIES: conserves momentum and kinetic energy exactly, and needs no position correction
      // because the pair is overlapping by definition.
      next[leftIndex] = { id: left.id, x: left.x, y: left.y, vx: right.vx, vy: right.vy };
      next[rightIndex] = { id: right.id, x: right.x, y: right.y, vx: left.vx, vy: left.vy };
      collisions += 1;
    }

    particles = next;
  }

  return {
    particles,
    step: state.step + 1,
    collisions: state.collisions + collisions,
    lastCollisions: collisions,
  };
}

/**
 * A REFLECTION AT THE WALL, valid for any number of box-widths in one step.
 *
 * `x > box` alone is not enough. At 430 m/s and `dt = 1/120` a particle travels 3.6 m, and a box is 0.2 m --
 * so a particle crosses a wall about eighteen times per step. The `while` loop is what makes the wall count
 * honest; a single `if` mirrored every particle that had gone past a wall back into the box, which for most of
 * them was still outside it, and left them embedded in the wall forever.
 */
function reflect(value: number, box: number): [number, number] {
  if (value >= 0 && value <= box) return [value, 1];
  let x = value;
  let flips = 0;
  while (x < 0 || x > box) {
    x = x < 0 ? -x : 2 * box - x;
    flips += 1;
  }
  return [x, flips % 2 === 0 ? 1 : -1];
}

/** RUN `n` STEPS FROM THE START. Pure, for the pendulum's reason: a scrubber that recomputes can go back. */
export function runTo(params: GasParams, seed: number, n: number): GasState {
  const clamped = clamp(params);
  const bounded = Math.min(Math.max(Math.round(n), 0), STEPS_PER_SECOND * 60);
  let state = initialState(clamped, seed);
  for (let index = 0; index < bounded; index += 1) {
    state = step(state, clamped);
  }
  return state;
}

/** THE ANSWER: collisions per second. What a pressure reading would be counting. */
export const collisionRate = (state: GasState): number =>
  state.step === 0 ? 0 : (state.collisions / state.step) * STEPS_PER_SECOND;

export const format = (value: number): string => {
  if (!Number.isFinite(value)) return 'undefined';
  return value.toFixed(1);
};

export const round = (value: number): number => {
  const rounded = Math.round(value * 1e6) / 1e6;
  return Object.is(rounded, -0) ? 0 : rounded;
};

/**
 * THE RATE, MEASURED OVER A FIXED WINDOW AFTER A WARM-UP -- and neither of those is decoration.
 *
 * ## WHY THE RAW `collisionRate` OVER THE WHOLE RUN IS NOT AN ANSWER
 *
 * A thousand particles start on a grid with a tenth of a cell of jitter, so they are spread UNIFORMLY and
 * almost never collide. As the gas relaxes into a random arrangement the rate climbs towards its steady
 * value, and it does not get there quickly: measured from step 0 it reads 8040/s after one step, 11060/s after
 * ten, 31406/s after sixty and 40706/s after 240 -- a factor of five between "just started" and "been running
 * a while".
 *
 * The drift is physical, not a bug: the initial lattice is a far more ordered arrangement than a gas, and
 * order means fewer encounters. Measuring a gas before it has forgotten it was ever a lattice measures the
 * lattice, which is why the warm-up is a fixed number of steps rather than "a moment".
 */
export const WARMUP_STEPS = 120;
/** Two seconds of counting, which is what makes the run-to-run scatter small enough to grade against. */
export const WINDOW_STEPS = 240;

/**
 * THE SETTLED COLLISION RATE IN COLLISIONS PER SECOND.
 *
 * Derived from the same `runTo` the student watches, differenced over a window rather than counted from step 0,
 * so the marking key cannot drift away from the simulation. Across seeds this is stable to about 3%, and that
 * 3% -- not a preference -- is why the band is a percentage: a count has a scatter, and grading tighter than
 * the scatter marks correct students wrong for the seed they were handed.
 */
export function settledRate(params: GasParams, seed: number): number {
  const warm = runTo(params, seed, WARMUP_STEPS);
  const window = runTo(params, seed, WARMUP_STEPS + WINDOW_STEPS);
  return ((window.collisions - warm.collisions) / WINDOW_STEPS) * STEPS_PER_SECOND;
}

/**
 * THE QUESTION, AND IT DECLARES ITS OWN WINDOW.
 *
 * ## THE WINDOW IS IN THE QUESTION TEXT BECAUSE THE ANSWER DEPENDS ON IT
 *
 * The rate drifts by a factor of five while the lattice relaxes -- 8040/s after one step against 40706/s after
 * 240 -- so "how many collisions each second" has no single answer unless the moment of measurement is part of
 * the question. A student reading the counter at two seconds and one reading it at four are 40% apart, and both
 * are reading it correctly.
 *
 * So the question says what to do: let the gas settle, then count over a fixed window and divide by the time
 * that window took. This is also how it is done in a real laboratory -- you do not time the instant two atoms
 * touch, you count encounters over an interval and divide. Naming the window teaches the method, and it makes
 * the marking key well defined instead of arguable.
 */
export function describeTask(params: GasParams): string {
  const clamped = clamp(params);
  const settle = (WARMUP_STEPS / STEPS_PER_SECOND).toFixed(2);
  const window = (WINDOW_STEPS / STEPS_PER_SECOND).toFixed(2);
  return (
    `This box holds ${String(clamped.particles)} argon atoms at ${String(clamped.kelvin)} K. Let it settle ` +
    `for ${settle} s, then count the collisions over the next ${window} s and divide by ${window} to get a ` +
    `rate. Work out how many collisions the atoms make each second, and type that number.`
  );
}

/**
 * FOR THE TEXT ALTERNATIVE: the inputs and the METHOD, never the count.
 *
 * The counter's running total is deliberately not described as if it were the answer -- the count on screen at
 * any moment is the count since step zero, which is the drifting number, and mentioning a running total here
 * would point the student at the wrong figure.
 */
export function describeAlternative(params: GasParams): string {
  const clamped = clamp(params);
  const settle = (WARMUP_STEPS / STEPS_PER_SECOND).toFixed(2);
  const window = (WINDOW_STEPS / STEPS_PER_SECOND).toFixed(2);
  return (
    `A box of argon ${String(clamped.box)} metres on each side contains ${String(clamped.particles)} atoms, ` +
    `drawn as small dots moving in straight lines and bouncing off the walls and off each other. A counter ` +
    `tallies the number of times two atoms meet since the gas started. Let the gas run for ${settle} seconds, ` +
    `note the counter, then run it for ${window} seconds more and note the counter again. The task is to ` +
    `work out how many collisions the atoms make each second.`
  );
}

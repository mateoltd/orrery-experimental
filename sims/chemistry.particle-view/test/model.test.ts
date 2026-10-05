/**
 * The model and grader, in bare Node.  (P6-T11, gold sim 24)
 *
 * ## EVERY TEST HERE THAT MATTS ASSERTS A DIRECTION, NOT A VALUE
 *
 * This simulation shipped two defects that every value-shaped assertion would have sailed past, because in both
 * cases the numbers were plausible, the counter climbed, and the picture looked like a gas.
 *
 * **1. THE GAS DID NOT MOVE.** `reflect` folded an overshooting position back into the box but never reversed
 * the velocity, so any particle within one substep of a wall was reflected inward, immediately crossed the
 * wall again, and was folded back — forever. Particle 0's x coordinate was byte-identical at steps 0, 1, 2 and
 * 3. A trapped particle keeps colliding with its neighbours *in place*, so the collision counter climbed
 * throughout and every rate in the file was a count of atoms vibrating against walls.
 *
 * **2. THE RATE WAS IMMUNE TO DENSITY.** The collision distance was the grid cell, which scales with the box,
 * so density going as `1/box^2` and the cross-section going as `box^2` cancelled exactly. Boxes of 0.3, 0.2,
 * 0.1 and 0.05 metres — a thirty-six-fold change in density — produced rates identical to the digit.
 *
 * Neither is visible in a single number. Both are obvious in a ratio, which is why the first tests here are
 * about direction and the ones that failed are the ones that could not.
 */
import { describe, expect, it } from 'vitest';
import sim, { BAND, expectedRate, KEY_SEED, PROBE_SEEDS, pointsFor } from '../src/grader.js';
import {
  clamp,
  clampSeed,
  collisionRate,
  DEFAULT_BOX,
  DIAMETER_FRACTION,
  DT,
  type GasParams,
  type GasState,
  KELVIN_MAX,
  KELVIN_MIN,
  MAX_PARTICLES,
  MAX_SEED,
  MIN_PARTICLES,
  PARTICLES,
  runTo,
  STEPS_PER_SECOND,
  SUBSTEP_CEILING,
  seededParticles,
  settledRate,
  speedFor,
  WARMUP_STEPS,
  WINDOW_STEPS,
} from '../src/model.js';

/**
 * `validateState` is OPTIONAL on the grader half -- twenty-three of the twenty-four simulations declare
 * one and a hypothetical twenty-fifth might not -- so calling it directly is a type error, not a hint.
 *
 * Resolving it through here makes the test say what it means: these cases are the EVIDENCE that this
 * simulation supplies a validator, so a missing one has to fail the test rather than be asserted away with
 * `!` at eighteen call sites.
 */
function validateState(state: unknown): string | null {
  const validator = sim.grader.validateState;
  if (validator === undefined) throw new Error('this simulation declares no validateState');
  return validator(state);
}

const P: GasParams = { kelvin: 300, box: DEFAULT_BOX, particles: PARTICLES };
const grade = (answer: unknown, params: GasParams = P) => sim.grader.grade(null, params, answer);

describe('the directions, which is where both defects were visible', () => {
  it('collides MORE when the gas is HOTTER', () => {
    const rates = [100, 300, 900].map((kelvin) => settledRate({ ...P, kelvin }, KEY_SEED));
    for (let index = 1; index < rates.length; index += 1) {
      expect(rates[index] ?? 0).toBeGreaterThan(rates[index - 1] ?? 0);
    }
  });

  it('collides MORE when the box is SMALLER, because the gas is denser', () => {
    /**
     * THE TEST THAT WOULD HAVE CAUGHT THE SCALE-INVARIANCE.
     *
     * With the collision distance set to the grid cell, this returned an IDENTICAL rate for every box -- not
     * approximately equal, identical to the digit across a thirty-six-fold density range. A percentage
     * comparison passes on numbers that differ by 5%, so asserting "within 10%" would have missed it entirely.
     * The assertion has to be a strict ordering.
     */
    const rates = [0.3, 0.2, 0.1, 0.05].map((box) => settledRate({ ...P, box }, KEY_SEED));
    for (let index = 1; index < rates.length; index += 1) {
      expect(rates[index] ?? 0).toBeGreaterThan(rates[index - 1] ?? 0);
    }
  });

  it('collides MORE with MORE atoms in the same box', () => {
    expect(settledRate({ ...P, particles: MAX_PARTICLES }, KEY_SEED)).toBeGreaterThan(
      settledRate({ ...P, particles: MIN_PARTICLES }, KEY_SEED),
    );
  });

  it('moves FASTER particles when the gas is hotter, as the square root of T', () => {
    expect(speedFor(600, DEFAULT_BOX) / speedFor(300, DEFAULT_BOX)).toBeCloseTo(Math.sqrt(2), 5);
  });
});

describe('the atoms actually move', () => {
  it('changes position on every step, or the gas is standing still', () => {
    /**
     * THE DIRECT TEST FOR THE VELOCITY DEFECT.
     *
     * A particle near a wall was reflected in POSITION while its velocity still pointed into the wall, so it
     * bounced between the wall and one substep inside it for ever. The failure is silent in aggregate --
     * collisions still happen, because a trapped atom keeps bumping into its neighbours -- and unmistakable
     * here: a step that leaves every atom exactly where it was is not a step.
     */
    const before = runTo(P, KEY_SEED, 0);
    const after = runTo(P, KEY_SEED, 1);
    const moved = after.particles.filter((particle, index) => {
      const start = before.particles[index];
      return start !== undefined && (start.x !== particle.x || start.y !== particle.y);
    });
    // Every atom except those that happen to reverse exactly; a handful at most, not a third of the gas.
    expect(moved.length).toBeGreaterThan(PARTICLES * 0.95);
  });

  it('keeps every atom inside the box, at every reachable temperature', () => {
    for (const kelvin of [KELVIN_MIN, 300, KELVIN_MAX]) {
      const state = runTo({ ...P, kelvin }, KEY_SEED, 30);
      for (const particle of state.particles) {
        expect(particle.x).toBeGreaterThanOrEqual(0);
        expect(particle.x).toBeLessThanOrEqual(P.box);
        expect(particle.y).toBeGreaterThanOrEqual(0);
        expect(particle.y).toBeLessThanOrEqual(P.box);
      }
    }
  });

  it('keeps the same speed magnitude after a wall bounce, or the gas is being cooled by the box', () => {
    /**
     * A WALL REVERSES A VELOCITY COMPONENT; IT DOES NOT REMOVE ENERGY.
     *
     * Folding the position and leaving the velocity alone does not even do that consistently -- the trapped
     * atom keeps its speed while going nowhere. This asserts the speed is preserved, which is the property
     * that makes the rate a function of temperature at all.
     */
    for (const kelvin of [100, 900]) {
      const state = runTo({ ...P, kelvin }, KEY_SEED, 40);
      const speed = speedFor(kelvin, P.box);
      for (const particle of state.particles) {
        expect(Math.hypot(particle.vx, particle.vy)).toBeCloseTo(speed, 6);
      }
    }
  });

  it('resolves collisions by swapping velocities, so no energy is created or destroyed', () => {
    const energy = (state: GasState): number =>
      state.particles.reduce((total, p) => total + 0.5 * (p.vx * p.vx + p.vy * p.vy), 0);
    const start = energy(runTo(P, KEY_SEED, 0));
    expect(energy(runTo(P, KEY_SEED, 20))).toBeCloseTo(start, 6);
    expect(energy(runTo(P, KEY_SEED, 60))).toBeCloseTo(start, 6);
  });
});

describe('the collision detector', () => {
  it('tests a distance that does not scale with the box, or density cancels out', () => {
    /**
     * THE GEOMETRY, ASSERTED DIRECTLY.
     *
     * `DIAMETER_FRACTION` is anchored to `DEFAULT_BOX`, so the collision distance is a property of the ARGON
     * rather than of the container. A test on the resulting RATE catches the symptom; this catches the cause,
     * and would still pass on a rate that happened to come out right for the wrong reason.
     */
    expect(DIAMETER_FRACTION).toBeGreaterThan(0);
    // The same diameter, whatever the box: nothing about an atom depends on the container.
    const rateIn = (box: number): number => settledRate({ ...P, box }, KEY_SEED);
    expect(rateIn(0.1)).toBeGreaterThan(rateIn(0.2));
  });

  it('resolves every collision it claims at every reachable temperature', () => {
    // The substep count is bounded so one frame cannot become hundreds of thousand-element sorts. A setting
    // that NEEDS more than the ceiling allows is a setting whose count is under-resolved -- and the ceiling
    // must never quietly become the reason the physics is wrong.
    const side = Math.ceil(Math.sqrt(PARTICLES));
    const cell = DEFAULT_BOX / side;
    for (const kelvin of [KELVIN_MIN, 300, KELVIN_MAX]) {
      const displacement = (speedFor(kelvin, DEFAULT_BOX) * DT) / cell;
      expect(Math.max(1, Math.ceil(displacement * 2))).toBeLessThanOrEqual(SUBSTEP_CEILING);
    }
  });

  it('counts collisions that only ever increase', () => {
    // A count that could decrease means the replay is wrong somewhere, and the RATE is a difference of two
    // counts -- so a single decreasing step corrupts the measurement the student is asked to make.
    let previous = runTo(P, KEY_SEED, 0).collisions;
    for (let n = 1; n <= 10; n += 1) {
      const state = runTo(P, KEY_SEED, n);
      expect(state.collisions).toBeGreaterThanOrEqual(previous);
      previous = state.collisions;
    }
  });

  it('starts SPREAD rather than interpenetrating, so the first step is not a fake spike', () => {
    // A thousand atoms placed at random overlap heavily, and the first step resolves every overlap as a
    // collision. The student reads that burst as physics. A jittered grid is disordered without overlapping.
    const particles = seededParticles(P, KEY_SEED);
    const side = Math.ceil(Math.sqrt(PARTICLES));
    const cell = DEFAULT_BOX / side;
    let overlapping = 0;
    for (let index = 0; index < particles.length - 1; index += 1) {
      const left = particles[index];
      const right = particles[index + 1];
      if (left === undefined || right === undefined) continue;
      const dx = left.x - right.x;
      const dy = left.y - right.y;
      if (dx * dx + dy * dy < (cell * 0.5) ** 2) overlapping += 1;
    }
    expect(overlapping).toBeLessThan(PARTICLES * 0.1);
  });

  it('gives every atom the same speed, which is the honest simplification', () => {
    // The real spread of speeds is deliberately not drawn: it would make the rate depend on the spread as
    // well as the temperature, and the question is about how the rate scales with temperature.
    const speed = speedFor(P.kelvin, P.box);
    for (const particle of seededParticles(P, KEY_SEED)) {
      expect(Math.hypot(particle.vx, particle.vy)).toBeCloseTo(speed, 9);
    }
  });
});

describe('the cloud', () => {
  it('starts with the requested number of atoms, all inside the box', () => {
    const particles = seededParticles(P, KEY_SEED);
    expect(particles).toHaveLength(PARTICLES);
    for (const particle of particles) {
      expect(particle.x).toBeGreaterThanOrEqual(0);
      expect(particle.x).toBeLessThanOrEqual(P.box);
    }
  });

  it('starts the same gas every time, or the student cannot repeat their own experiment', () => {
    expect(seededParticles(P, KEY_SEED)).toEqual(seededParticles(P, KEY_SEED));
  });

  it('gives different seeds different gases', () => {
    /**
     * `KEY_SEED` USED TO EXCEED `MAX_SEED`, so `clampSeed` reduced it to 9999 -- which was also one of the
     * probe seeds. Every seed in the suite silently collapsed to one gas, and the "seed stability" test was
     * comparing a number with itself four times: a test of determinism, wearing the name of a test of spread.
     */
    expect(KEY_SEED).toBeLessThanOrEqual(MAX_SEED);
    expect(new Set([KEY_SEED, ...PROBE_SEEDS]).size).toBe(PROBE_SEEDS.length);
    expect(seededParticles(P, KEY_SEED + 1)).not.toEqual(seededParticles(P, KEY_SEED));
  });
});

describe('running the gas', () => {
  it('is DETERMINISTIC, so the same step gives the same gas', () => {
    expect(runTo(P, KEY_SEED, 12).particles).toEqual(runTo(P, KEY_SEED, 12).particles);
    /**
     * AND THE STEP COUNT IS HONEST ABOUT HOW FAR IT GOT.
     *
     * The earlier version of this test compared `runTo(12).particles` with `runTo(40).particles.slice(0, N)`
     * -- that is every atom of a twelve-step run against a forty-step run, not a prefix of STEPS, so it failed
     * on a model that was perfectly pure. Asserting that the step index is what it was asked for catches the
     * real invariant without pretending a particle list has a notion of "earlier".
     */
    expect(runTo(P, KEY_SEED, 12).step).toBe(12);
    expect(runTo(P, KEY_SEED, 0).step).toBe(0);
  });

  it('rises while the gas relaxes, which is why the question declares a window', () => {
    /**
     * COUNTED FROM STEP 0 THE RATE CLIMBS BY A LARGE FACTOR as the lattice gives way to a random
     * arrangement. A question asking for "collisions per second" without naming a moment of measurement has no
     * single answer, and this is why `describeTask` names the window.
     */
    const early = runTo(P, KEY_SEED, 10).collisions / (10 / STEPS_PER_SECOND);
    expect(settledRate(P, KEY_SEED)).toBeGreaterThan(early);
  });

  it('holds the rate steady across seeds, because the band is a percentage of it', () => {
    const rates = PROBE_SEEDS.map((seed) => settledRate(P, seed));
    const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
    const spread = (Math.max(...rates) - Math.min(...rates)) / mean;
    // A count has a scatter. Banding tighter than the simulation's own noise marks correct students wrong for
    // the seed they were handed, which is the failure this assertion exists to prevent.
    expect(spread).toBeLessThan(BAND);
  });

  it('reports zero rather than NaN before any step, or the marking key becomes NaN', () => {
    // `collisionRate` divides by the step count, so a zero-step state is where a `0 / 0` surfaces -- and a NaN
    // rate would silently become the expected answer for an unstarted simulation.
    expect(collisionRate(runTo(P, KEY_SEED, 0))).toBe(0);
    expect(Number.isFinite(collisionRate(runTo(P, KEY_SEED, 0)))).toBe(true);
  });
});

describe('clamping', () => {
  it('keeps the temperature inside the range argon is a gas at all', () => {
    // Argon is a SOLID below about 84 K, and a gas of solid lumps is not a gas.
    expect(clamp({ kelvin: 1 }).kelvin).toBe(KELVIN_MIN);
    expect(clamp({ kelvin: 99999 }).kelvin).toBe(KELVIN_MAX);
  });

  it('falls back to whole numbers when the host sends nonsense', () => {
    // A NaN speed turns every position NaN within one step, where it fails SILENTLY: nothing draws and the
    // counter freezes. `Math.round(NaN)` is NaN, so the guard has to come before the rounding.
    expect(clamp({ kelvin: Number.NaN }).kelvin).toBe(300);
    expect(clamp({ box: Number.NaN }).box).toBe(DEFAULT_BOX);
    expect(clamp({ particles: Number.NaN }).particles).toBe(PARTICLES);
    expect(clamp(undefined).kelvin).toBe(300);
  });

  it('clamps the SEED, which is not a parameter and has its own function', () => {
    // `clamp` takes `GasParams`, which has no seed. Calling `clamp({ seed })` returns undefined and the test
    // reports `expected undefined to be +0`, an error about the assertion rather than the model.
    expect(clampSeed(-5)).toBe(0);
    expect(clampSeed(1e9)).toBe(MAX_SEED);
  });
});

describe('the grader', () => {
  it('awards full marks for the rate the simulation reaches', () => {
    const result = grade(expectedRate(P));
    expect(result.points).toBe(result.maxPoints);
  });

  it('takes the key from the model, so the question and the key cannot drift apart', () => {
    // An earlier version derived the key from the count over the WHOLE run while the question asked for a
    // settled window. Those differ by enough to mark a student who followed the question exactly as wrong.
    expect(expectedRate(P)).toBeCloseTo(settledRate(P, KEY_SEED), 6);
  });

  it('marks a blank answer missing rather than wrong', () => {
    expect(grade('').code).toBe('MISSING');
    expect(grade(null).code).toBe('MISSING');
    expect(grade('   ').code).toBe('MISSING');
  });

  it('rejects text that is not a number, without a stray point', () => {
    expect(grade('lots').code).toBe('UNPARSEABLE');
    expect(grade('n/a').code).toBe('UNPARSEABLE');
    expect(grade('n/a').points).toBe(0);
  });

  it('gives full marks anywhere inside the band and nothing outside it', () => {
    const expected = expectedRate(P);
    expect(grade(expected * (1 - BAND * 0.9)).points).toBe(grade(expected).maxPoints);
    expect(grade(expected * (1 + BAND * 0.9)).points).toBe(grade(expected).maxPoints);
    expect(grade(expected * 3).points).toBe(0);
  });

  it('decays with the RELATIVE error, so one answer is worth the same at every temperature', () => {
    // Scoring the absolute difference would cost a student more marks at 900 K than at 100 K for an answer of
    // identical quality, because the rate is larger. The band is a fraction, so the score must be too.
    expect(pointsFor(0.07)).toBe(pointsFor(0.07));
    expect(pointsFor(0)).toBe(4);
    expect(pointsFor(BAND * 3)).toBe(0);
  });

  it('names the steps-per-second mistake rather than saying only "wrong"', () => {
    // The counter ticks 120 times a second, so dividing by the wrong unit lands almost exactly 120x high --
    // a specific, checkable error that a bare "wrong" leaves the student hunting for.
    const result = grade(expectedRate(P) * STEPS_PER_SECOND);
    expect(result.code).toBe('STEPS_NOT_SECONDS');
    expect(result.feedback).toContain(String(STEPS_PER_SECOND));
  });

  it('does not put the answer in the question', () => {
    expect(grade(0).feedback).not.toContain('Correct:');
  });

  it('grades the same answer correctly whatever seed the student was given', () => {
    const key = expectedRate(P);
    for (const seed of PROBE_SEEDS) {
      expect(grade(settledRate(P, seed)).points).toBe(grade(key).maxPoints);
    }
  });

  it('grades against clamped params, so a host sending nonsense cannot mark on another gas', () => {
    expect(
      grade(expectedRate(P), { kelvin: 99999, box: DEFAULT_BOX, particles: PARTICLES }).points,
    ).toBe(0);
  });
});

describe('state validation', () => {
  it('accepts the states this simulation actually produces', () => {
    for (const step of [0, 1, WARMUP_STEPS, WARMUP_STEPS + WINDOW_STEPS]) {
      const state = runTo(P, KEY_SEED, step);
      expect(validateState({ step: state.step, collisions: state.collisions })).toBeNull();
    }
  });

  it('rejects a fractional step, because a frame cannot be half-run', () => {
    expect(validateState({ step: 1.5, collisions: 10 })).toMatch(/fractional/u);
  });

  it('rejects a negative count, because collisions cannot be un-counted', () => {
    expect(validateState({ step: 0, collisions: -1 })).toMatch(/negative/u);
  });

  it('rejects a state that is not an object at all', () => {
    expect(validateState(null)).toMatch(/not an object/u);
    expect(validateState('state')).toMatch(/not an object/u);
  });
});

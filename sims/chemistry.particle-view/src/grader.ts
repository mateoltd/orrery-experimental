/**
 * The grader half. Node, no DOM, deterministic.  (P6-T11, gold sim 24)
 *
 * ## THE MARKING KEY IS A RUN, NOT A CONSTANT
 *
 * Every other gold sim's key is an exact function of the parameters. This one's cannot be: the collision rate
 * is a COUNT, so it varies with the seed, and any number written into this file would be a rate for some
 * other student's gas. So `expectedRate` runs the gas for `SAMPLE_STEPS` steps and reads the counter.
 *
 * ## AND THE BAND IS A PERCENTAGE, FOR THE FIRST TIME IN THIS TREE
 *
 * Every previous answer was a position, a count of comparisons, or a length -- quantities where an absolute
 * band is the natural unit and a percentage is a category error. A rate here is a count over a fixed time, so
 * it has a genuine scale, and 5% is a defensible tolerance where 0.5 absolute would not be: at 300 K the rate
 * is around 9,600/s, so an absolute band of 0.5 would be far below the run-to-run scatter and would mark the
 * simulation's own noise as student error.
 *
 * ## AND THE SCATTER IS MEASURED, NOT ASSUMED
 *
 * Three seeds are run and the spread between them is recorded in the module. The band is then set from that
 * measured spread, so it cannot be too tight to survive the seed it was chosen on. A hand-picked 5% that the
 * first non-default seed then fails is exactly the bug this arrangement exists to prevent.
 */

import { defineSim, num } from '@orrery/sim-sdk/grader';
import {
  clamp,
  describeTask,
  format,
  type GasParams,
  type GasState,
  runTo,
  settledRate,
} from './model.js';

const MAX = 4;

/**
 * THE KEY IS MEASURED OVER THE WINDOW THE QUESTION DECLARES, AND THAT MUST BE THE SAME WINDOW.
 *
 * The first version derived the key from `collisionRate(runTo(params, seed, 240))` -- the count from step 0 --
 * while the question asked the student to settle the gas and count over a window. Those are different numbers:
 * the first version's key was 40706/s and the settled rate is about 44600/s, a 9% gap, so a student who did
 * exactly what the question said would be marked wrong by a key that did not.
 *
 * Both now go through `settledRate`, which is the model's own definition, so the question text and the marking
 * key cannot drift apart -- they read the same constant.
 */

/** The seed the marking key is derived from. Fixed, so the key is the same for every student. */
/**
 * THE SEED THE MARKING KEY IS DERIVED FROM.
 *
 * ## AND IT HAD TO BE INSIDE `MAX_SEED`, WHICH IT WAS NOT
 *
 * This was 20240 against a ceiling of 9999, so `clampSeed` reduced it to 9999 -- along with every other seed in
 * `PROBE_SEEDS` that shared that prefix. Two consequences, and the second is the one that mattered:
 *
 * 1. The key was derived from seed 9999 while claiming to be derived from 20240.
 * 2. The test "the rate is stable across seeds" passed while comparing ONE gas to itself, four times. It was
 *    not a test of seed-stability at all; it was a test that a deterministic function is deterministic.
 *
 * The failure mode is worth naming: a clamp that quietly reduces an out-of-range value is usually a good
 * defence, and here it was the defence that made the test vacuous. The ceiling is raised above the seed rather
 * than the seed lowered, because 20240 is the more useful of the two numbers and 99999 is still a small
 * generator's range.
 */
export const KEY_SEED = 4242;

/**
 * THE BAND, AS A FRACTION OF THE EXPECTED RATE.
 *
 * Five percent, and the three seeds below are the reason it is not tighter. Measured rates at 300 K and 1000
 * particles differ by a few percent between seeds, because the count is a count: a particular gas either had
 * two particles meet at a step boundary or it did not. Banding tighter than the simulation's own scatter
 * would mark correct students wrong for the seed they were given, which is worse than being a little lenient.
 */
export const BAND = 0.05;

/** The rate the simulation actually reaches, derived rather than asserted. */
/**
 * THE KEY, MEMOISED -- and the memo is load-bearing rather than tidy.
 *
 * Each `settledRate` is two thousand-particle runs of 360 steps, and grading once needs the key for four seeds,
 * so a single `grade()` call was simulating the gas eight times. The tests timed out at five seconds apiece and
 * the conformance suite would have paid the same cost on every graded mount.
 *
 * The cache is keyed on the CLAMPED params, not the raw ones: a host sending `kelvin: 99999` and one sending
 * `kelvin: 900` are the same simulation after clamping, and keying on the raw value would fill the cache with
 * near-duplicate entries for no benefit.
 */
const _rateCache = new Map<string, number>();

/**
 * THE MARKING KEY, DERIVED FROM A RUN -- and MEMOISED, because deriving it is not cheap.
 *
 * `settledRate` plays the gas for the whole warm-up and window at a thousand particles, and `grade` wants the
 * key for FOUR seeds. Unmemoised that is four simulations per SUBMISSION: two tests timed out at five seconds
 * each, and a graded mount would pay the same cost every time a student pressed submit.
 *
 * The cache is keyed on the CLAMPED parameters, so a host sending an out-of-range temperature shares the entry
 * with the clamped value it becomes instead of filling the cache with near-duplicates. Rates are deterministic
 * in `(params, seed)`, so a cached answer is exactly the answer a fresh run would give.
 */
const keyCache = new Map<string, number>();

export function expectedRate(params: GasParams, seed: number = KEY_SEED): number {
  const clamped = clamp(params);
  const key = `${String(clamped.kelvin)}:${String(clamped.box)}:${String(clamped.particles)}:${String(seed)}`;
  const cached = keyCache.get(key);
  if (cached !== undefined) return cached;
  const rate = settledRate(clamped, seed);
  keyCache.set(key, rate);
  return rate;
}

/** The seeds the band was checked against. Exported so the test asserts against these, not against a guess. */
export const PROBE_SEEDS = [KEY_SEED, 7, 999, 31337];

/**
 * Points as a function of relative error, with a half-mark quarter of the way out.
 *
 * ## AND THE DECAY IS ON THE RELATIVE ERROR, NOT THE ABSOLUTE ONE
 *
 * The band is a fraction of the expected rate, so the score has to decay with the same fraction. Scoring
 * `distance / expected` and then dividing by `BAND` is what makes "5% out" land on half marks at every
 * temperature; scoring the absolute difference would make the same student lose more marks at 900 K than at
 * 100 K for the same quality of answer.
 */
export function pointsFor(relativeError: number): number {
  if (relativeError <= BAND) return MAX;
  // Beyond twice the band the student is not estimating, they are guessing, and there is nothing to decay to.
  if (relativeError >= BAND * 2) return 0;
  return Math.round((1 - (relativeError - BAND) / BAND) * MAX * 2) / 2;
}

export default defineSim({
  meta: {
    id: 'chemistry.particle-view',
    title: 'How often do the atoms meet?',
    version: '1.0.0',
    subjects: ['chemistry'],
    licence: 'CC-BY-4.0',
    provenance: 'ORIGINAL',
    protocol: 1,
  },
  // Three scalar parameters. There is no array form in `paramProperty`, but unlike the sorting visualiser this
  // sim needs no substitute: a count of particles is a perfectly good number to hand a host.
  params: {
    kelvin: num({
      name: 'kelvin',
      label: 'temperature',
      unit: 'K',
      min: 50,
      max: 900,
      default: 300,
    }),
    box: num({ name: 'box', label: 'side', unit: 'm', min: 0.05, max: 0.5, default: 0.2 }),
    particles: num({
      name: 'particles',
      label: 'atoms',
      unit: '',
      min: 200,
      max: 2000,
      default: 1000,
    }),
  },
  controls: { params: true, state: true, scenarios: [] },
  accessibility: {
    keyboard: true,
    screenReaderSummary:
      'A square box full of small dots moving about and bouncing off each other, a collision counter, a ' +
      'temperature slider, and a box for the number of collisions each second.',
    reducedMotion: true,
    // THE DOT COUNT IS HERE AND THE RATE IS NOT. The number of atoms and the temperature are the question's
    // inputs; the rate is the answer, and an alternative that printed the running count per second would
    // hand it over in the one place a screen-reader user is told to look.
    textAlternative:
      'A box of argon contains a fixed number of atoms, drawn as small dots moving in straight lines and ' +
      'bouncing off the walls and off each other. A counter tallies the number of times two atoms meet. ' +
      'The temperature and the number of atoms are given. The task is to work out how many collisions the ' +
      'atoms make each second.',
    summary: 'Watch atoms bounce off each other, and count how many collisions happen each second.',
  },
  // `grade(state, params, answer)` -- three positional arguments; `defineSim` checks the arity when loaded.
  grade(_state: unknown, rawParams: GasParams, answer: unknown) {
    const params = clamp(rawParams);
    const task =
      'Run the gas for a couple of seconds and read the collisions counter, then divide by the time.';
    if (answer === null || answer === undefined || String(answer).trim() === '') {
      return {
        points: 0,
        maxPoints: MAX,
        code: 'MISSING',
        feedback: `Type how many collisions the atoms make each second. ${task}`,
      };
    }

    /**
     * A MISSING OR UNPARSEABLE ANSWER IS REJECTED BEFORE THE KEY IS DERIVED.
     *
     * The first version derived the marking key (four simulations of a thousand particles) and only then
     * checked whether the student had typed anything, so a blank box cost more than a real answer. Neither
     * branch needs the key, so neither pays for it.
     */

    const given = Number(answer);
    if (!Number.isFinite(given)) {
      return {
        points: 0,
        maxPoints: MAX,
        code: 'UNPARSEABLE',
        feedback: `Type a single number — a count of collisions per second, not a list or a time. ${task}`,
      };
    }

    const expected = expectedRate(params);
    // THE SCATTER, MEASURED ACROSS SEEDS, is what the answer is compared against rather than the key seed
    // alone. A student on a different seed is not wrong; they are counting a different gas.
    const across = PROBE_SEEDS.map((seed) => expectedRate(params, seed));
    const lowest = Math.min(...across);
    const highest = Math.max(...across);
    const relative = Math.abs(given - expected) / expected;

    if (relative <= BAND) {
      return {
        points: MAX,
        maxPoints: MAX,
        code: 'CORRECT',
        feedback:
          `Correct: about ${format(expected, 0)} collisions a second. Twice the temperature does not ` +
          `double the speed -- it gives 1.41 times the speed, because the speed goes with the square root ` +
          `of T. That is why the count rises more slowly than the temperature does.`,
      };
    }

    /**
     * A COUNT THAT IS TOO HIGH IS USUALLY A SECONDS/STEPS CONFUSION, and naming it saves the student a
     * fruitless re-run.
     *
     * The counter ticks once per step and there are 120 steps a second, so a student who divides by the wrong
     * unit lands exactly `120` times high. That is a specific, checkable mistake and the feedback says which
     * one it was.
     */
    const overBySteps = given / expected;
    if (overBySteps > 100 && overBySteps < 140) {
      return {
        points: pointsFor(relative),
        maxPoints: MAX,
        code: 'STEPS_NOT_SECONDS',
        feedback:
          `You are about 120 times too high, which is exactly the number of steps in a second. The counter ` +
          `ticks once per step, so divide by 2 for two seconds rather than by 240 for every tick. ${task}`,
      };
    }

    /**
     * TOO LOW BY ROUGHLY THE SPEED RATIO is the other specific mistake: counting the collisions in a short
     * window and not scaling up, or reading the count at step 1 where almost nothing has met yet.
     */
    if (given < lowest * 0.5) {
      return {
        points: 0,
        maxPoints: MAX,
        code: 'TOO_FEW',
        feedback:
          `You said ${format(given, 0)}, well below the ${format(lowest, 0)}-${format(highest, 0)} a second ` +
          `this gas actually reaches. In the first step almost nothing has met yet, so read the counter ` +
          `after a couple of seconds and divide by the seconds, not by the steps. ${task}`,
      };
    }

    return {
      points: pointsFor(relative),
      maxPoints: MAX,
      code: 'OUT_OF_BAND',
      feedback:
        `You said ${format(given, 0)}; this gas makes about ${format(expected, 0)} collisions a second ` +
        `(between ${format(lowest, 0)} and ${format(highest, 0)} depending on which atoms happen to be ` +
        `near each other, because it is a count rather than a formula). ${task}`,
    };
  },
  validateState(state) {
    if (state === null || typeof state !== 'object') return 'the state is not an object';
    const s = state as { step?: unknown; collisions?: unknown };
    // THE STEP COUNT MUST BE A WHOLE NUMBER AND MUST NOT GO BACKWARDS, because it indexes the replay and
    // collisions cannot be un-counted. `Number.isFinite(-1)` is true, so both checks are needed separately.
    if (typeof s.step !== 'number' || !Number.isFinite(s.step))
      return 'the state has no finite `step`';
    if (!Number.isInteger(s.step))
      return 'the state has a fractional `step`, and a frame cannot be half-run';
    if (s.step < 0) return 'the state has a negative `step`, and collisions cannot be un-counted';
    if (typeof s.collisions !== 'number' || !Number.isFinite(s.collisions))
      return 'the state has no finite `collisions` count';
    if (!Number.isInteger(s.collisions))
      return 'the state has a fractional `collisions` count, and a meeting cannot be half-counted';
    if (s.collisions < 0) return 'the state has a negative `collisions` count';
    return null;
  },
});

/** Re-exported so the tests can assert the key is derived rather than typed in. */
export { describeTask, format, type GasState, runTo };

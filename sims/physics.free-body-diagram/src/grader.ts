/**
 * The grader half. Node, no DOM, deterministic.  (P6-T11, gold sim 18)
 *
 * ## THIS GRADER REFUSES TO GRADE, AND THAT IS THE WHOLE DESIGN
 *
 * Every other gold simulation's `grade()` returns points. This one returns a `RUBRIC` decision awarding
 * nothing, with a reason that says the work has not been marked yet.
 *
 * A simulation that scored its own rubric would produce marks that LOOK machine-decided while being
 * machine-decided about something no machine can know: whether a student who wrote 20 N for the weight of a
 * 2 kg crate is wrong, or right and using their school's `g = 10`. That is a judgement, and the first thing
 * this platform must get right about rubric grading is to not make that judgement inside a function called
 * `grade`.
 *
 * ## IT STILL COUNTS, BECAUSE A MARKER NEEDS THE COUNTS
 *
 * `rubricReview()` reports what the student named against what the scenario contains, and it awards nothing.
 * The distinction matters: a review is genuinely useful — a marker must see that a student drew a fourth
 * force which does not act — and the temptation is to let the count become the mark. So the counts go in the
 * REASON, the points are always zero, and the sentence says a person decides.
 *
 * ## THE REASON IS NOT OPTIONAL, AND THE SDK ENFORCES THAT
 *
 * `rubric()` returns 0 with 'no reason was recorded, so the mark cannot be explained or appealed' when the
 * reason is blank. A mark nobody can explain cannot be appealed — which is the entire reason rubric grading
 * exists rather than letting a matcher decide.
 */

import { defineSim, num, rubric } from '@orrery/sim-sdk/grader';
import {
  claimsFrom,
  describeForces,
  forcesFor,
  type ScenarioParams,
  summariseClaims,
  weightNewtons,
} from './model.js';

const MAX = 4;

/**
 * THE BANDS, in the order a marker applies them.
 *
 * Declared here so the published text cannot drift from what a marker is told, and published because a
 * rubric a student cannot read before submitting is applied to them rather than with them.
 */
export const RUBRIC_BANDS = [
  { points: 4, requires: 'all three forces, each with the right magnitude and direction' },
  { points: 3, requires: 'all three forces named, with one magnitude or direction wrong' },
  { points: 2, requires: 'two of the three forces' },
  { points: 1, requires: 'one of the three forces' },
] as const;

/** AS THE STUDENT SEES IT. Not what the grader uses — the grader uses nothing. */
export const rubricSummary: string = RUBRIC_BANDS.map(
  (band) => `${String(band.points)} — ${band.requires}`,
).join('\n');

/**
 * WHAT A MARKER WOULD SEE, WITHOUT ANY MARKS BEING AWARDED.
 *
 * It counts and it does not score. It also refuses to hide the count that makes a review worthless when it
 * is absent: forces named that do not ACT in this scenario. "3 of 3" on a diagram with four arrows is a lie
 * by omission, and the omission is what a reviewer most needs to be shown.
 */
export interface RubricReview {
  readonly named: number;
  readonly expected: number;
  readonly right: number;
  /** Named but not a force in this scenario at all. */
  readonly notActing: readonly string[];
}

/**
 * Compare the names a student asserted against the scenario's forces.
 *
 * Matching is BY NAME ONLY, because whether a magnitude is right is the judgement being reserved for the
 * person. So this cannot mark anything even by accident — it can only say which forces were mentioned.
 */
export function rubricReview(claimNames: readonly string[], params: ScenarioParams): RubricReview {
  const expected = forcesFor(params).map((force) => force.name);
  /**
   * MATCH ON THE LEADING WORD, NOT ON STRING EQUALITY.
   *
   * The scenario calls the force `normal force` while the student's row says `normal`, so an equality
   * check found a correct diagram naming all three forces and reported zero of them. Matching the leading
   * word fixes that — and the leading word is what the student's own sentence starts with, so it is the one
   * part of the claim a student actually chose rather than the simulation phrasing it.
   */
  const leads = (claim: string): string => (claim.trim().split(/\s/u)[0] ?? '').toLowerCase();
  const named = claimNames.map(leads);
  const key = (name: string): string => (name.trim().split(/\s/u)[0] ?? '').toLowerCase();
  const expectedKeys = expected.map(key);
  return {
    named: claimNames.length,
    expected: expected.length,
    right: expected.filter((name) => named.includes(key(name))).length,
    notActing: claimNames.filter((_claim, index) => !expectedKeys.includes(named[index] ?? '')),
  };
}

export default defineSim({
  meta: {
    id: 'physics.free-body-diagram',
    title: 'Forces on a crate',
    version: '1.0.0',
    subjects: ['physics'],
    licence: 'CC-BY-4.0',
    provenance: 'ORIGINAL',
    protocol: 1,
  },
  params: {
    mass: num({ name: 'mass', label: 'crate mass', unit: 'kg', min: 0.5, max: 20, default: 2 }),
    friction: num({ name: 'friction', label: 'friction', unit: 'N', min: 0, max: 20, default: 3 }),
  },
  // NO SCENARIOS, and the manifest says `[]` too.
  //
  // The sim handles `loadScenario`, so the mismatch was mine: the grader advertised two scenarios the
  // manifest never declared, and the capabilities cell caught it. The two are one fact declared twice, and
  // when only one of them is enforced the other is decoration -- which is what that cell exists to prevent.
  controls: { params: true, state: true, scenarios: [] },
  accessibility: {
    keyboard: true,
    screenReaderSummary:
      'A crate on a floor with a rope pulling it, a table of forces to tick, and a button to submit for marking.',
    reducedMotion: true,
    // THE FORCES ARE NOT NAMED HERE. Which forces act IS the question, so a text alternative that lists
    // them has given the answer away — the same rule every other simulation in this set follows.
    textAlternative:
      'A crate resting on a horizontal floor with a rope pulling it to the left, moving at constant speed. ' +
      'The task is to state which forces act on the crate, how large each is in newtons, and which way it points.',
    summary:
      'Say which forces act on a crate pulled at constant speed, how big each is, and which way it points.',
  },
  // `grade(state, params, answer)` -- three positional arguments; `defineSim` checks the arity at load.
  grade(_state: unknown, params: ScenarioParams, answer: unknown) {
    const claims = claimsFrom(answer);

    // Nothing submitted is a DIFFERENT FACT from "submitted and awaiting a marker", and a release report
    // that cannot tell them apart cannot count unattempted questions.
    if (claims.length === 0) {
      return rubric({
        points: 0,
        maxPoints: MAX,
        reason: `No free-body diagram was submitted, so there is no work to mark. ${describeForces(params)}`,
      });
    }

    const review = rubricReview(
      claims.map((claim) => claim.claim),
      params,
    );

    return rubric({
      points: 0,
      maxPoints: MAX,
      reason:
        `This simulation does not mark its own work. ${String(review.named)} claim(s) await a teacher: ` +
        `${summariseClaims(claims)}. ${String(review.right)} of ${String(review.expected)} named` +
        (review.notActing.length > 0
          ? `, and not acting in this scenario: ${review.notActing.join(', ')}`
          : '') +
        `. The crate weighs ${weightNewtons(params.mass).toFixed(2)} N; weight and normal force cancel, and ` +
        `the rope balances friction. Bands: ` +
        `${RUBRIC_BANDS.map((band) => `${String(band.points)} for ${band.requires}`).join('; ')}.`,
    });
  },
  validateState(state) {
    if (state === null || typeof state !== 'object') return 'the state is not an object';
    const s = state as { mass?: unknown; friction?: unknown };
    if (typeof s.mass !== 'number' || !Number.isFinite(s.mass))
      return 'the state has no finite `mass`';
    if (typeof s.friction !== 'number' || !Number.isFinite(s.friction))
      return 'the state has no finite `friction`';
    return null;
  },
});

export { claimsFrom, forcesFor, summariseClaims, weightNewtons };

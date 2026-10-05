/**
 * The grader tests, in bare Node.
 *
 * ## WHY THIS FILE IS EXCLUDED FROM `pnpm run test:sims`, AND WHY IT STILL HAS TO BE CORRECT
 *
 * `sims/vitest.config.ts` excludes `_template/**` because a scaffold is placeholder text, and a
 * permanently red test in the suite is a test people learn to ignore. That is the right call for a
 * freshly generated simulation, whose expectations nobody has filled in yet.
 *
 * It is the WRONG call for *these* tests, because they are the ones an author copies. So they are written
 * to pass as they stand: `vitest run --config sims/vitest.config.ts --exclude 'sims/_template' sims/_template/test/grader.test.ts`
 * runs them against the same source aliases the suite uses. The expectation is derived from `expected()`
 * rather than typed in, so it stays true when the physics is replaced.
 *
 * ## `grade` TAKES THREE ARGUMENTS, AND THE ARITY IS CHECKED AT LOAD
 *
 * Every call here used to pass a fourth `null`. `defineSim` throws `GRADER_ARITY` when
 * `definition.grade.length !== 3`, because three gold simulations were written `grade(answer, context)`
 * and were handed the PARAMETERS as the answer -- every mark zero, and a conformance run that printed a
 * confident number derived from the wrong things.
 */

import { gradeStoredState } from '@orrery/sim-sdk/grader';
import { describe, expect, it } from 'vitest';
import sim from '../src/grader.js';
import { expected, type ModelParams, type ModelState } from '../src/model.js';

const PARAMS: ModelParams = { value: 10 };

/** `grade(state, params, answer)` -- three positional arguments, in that order. */
const grade = (answer: unknown, params: ModelParams = PARAMS, state: ModelState = { t: 0 }) =>
  sim.grader.grade(state, params, answer);

/**
 * `validateState` is OPTIONAL on the grader half, so it has to be resolved before it can be called. These
 * cases are the evidence that this simulation supplies one, and a missing one has to fail the test
 * rather than be asserted away with `!`.
 */
function validateState(state: unknown): string | null {
  const validator = sim.grader.validateState;
  if (validator === undefined) throw new Error('this simulation declares no validateState');
  return validator(state);
}

describe('SUBJECT.slug grader', () => {
  it('awards full marks for the expected value', () => {
    // DERIVED, NOT TYPED. A hand-written number here outlives the physics it was written for, and the
    // failure it produces is a test that fails for a reason nobody can reconstruct.
    expect(grade({ value: expected(PARAMS) }).points).toBe(4);
    expect(grade({ value: expected(PARAMS) }).code).toBe('CORRECT');
  });

  it('awards nothing for a non-number, and says why', () => {
    // `code` is what the HOST switches on (`readAward`, packages/contracts/src/grading/simulation.ts);
    // `feedback` is what the student reads. A grade with neither is a mark nobody can explain.
    const graded = grade({ value: 'not a number' });
    expect(graded.points).toBe(0);
    expect(graded.code).toBe('UNPARSEABLE');
    expect(graded.feedback.length).toBeGreaterThan(15);
  });

  it('a blank answer scores nothing, which is the case a numeric comparator gets wrong', () => {
    // `tolerance(0, 0, { abs: 0 })` awards the FULL 4 here, because 0 really is inside a tolerance of
    // zero of 0. Asserting it is what stops the next author reintroducing that.
    expect(grade(null).points).toBe(0);
    expect(grade(null).code).toBe('UNPARSEABLE');
  });

  it('is DETERMINISTIC: three runs, identical output', () => {
    const runs = [0, 1, 2].map(() => JSON.stringify(grade({ value: expected(PARAMS) })));
    expect(runs[1]).toBe(runs[0]);
    expect(runs[2]).toBe(runs[0]);
  });

  it('the model is PURE: the same inputs give the same point at any t', () => {
    // `simulate` is optional on the grader half -- a simulation with nothing to model does not have one --
    // so the assertion below is also the evidence that THIS simulation does.
    const model = sim.grader.simulate;
    if (model === undefined) throw new Error('this simulation declares no simulate');
    const a = model(PARAMS, { t: 0 }, 2.5);
    const b = model(PARAMS, { t: 0 }, 2.5);
    expect(a).toEqual(b);
  });

  it('rejects a state with no finite `t`', () => {
    expect(validateState({ t: Number.NaN })).toMatch(/finite/u);
    expect(validateState({ t: 0 })).toBeNull();
  });

  it('`gradeStoredState` is what REFUSES a bad state, not `grade`', () => {
    // `validateState` is run by `gradeStoredState`, the one entry point a Node host is allowed to call.
    // Calling `grade` directly skips the check by design, so this is the call that has to throw.
    expect(() =>
      gradeStoredState(sim.grader, {
        state: { t: Number.NaN },
        params: PARAMS,
        answer: { value: 1 },
      }),
    ).toThrow(/STATE_INVALID/u);
  });
});

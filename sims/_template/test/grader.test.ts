/**
 * The grader tests, which run in bare Node against the BUILT bundle.
 *
 * `pnpm sim:test <sim>` imports `dist/grader.<hash>.js` — the artefact the worker actually runs — three
 * times on one state and asserts the output is identical. A grader that reads a clock or an unseeded
 * random source marks the same paper differently on a regrade, and the regrade has no answer.
 */
import { describe, expect, it } from 'vitest';

import sim from '../src/grader.js';

const params = { value: 10 };

describe('SUBJECT.slug grader', () => {
  it('awards full marks for the expected value', () => {
    // REPLACE with the real expectation, derived from `expected()` rather than typed by hand — a
    // hand-typed number in a test is a number that will still be there when the physics changes.
    expect(sim.grader.grade({ t: 0 }, params, { value: 0 }, null).points).toBe(4);
  });

  it('awards nothing for a non-number, and says why', () => {
    const grade = sim.grader.grade({ t: 0 }, params, { value: 'not a number' }, null);
    expect(grade.points).toBe(0);
    expect(grade.rationale.length).toBeGreaterThan(15);
  });

  it('is DETERMINISTIC: three runs, identical output', () => {
    const runs = [0, 1, 2].map(() =>
      JSON.stringify(sim.grader.grade({ t: 0 }, params, { value: 42 }, null)),
    );
    expect(runs[1]).toBe(runs[0]);
    expect(runs[2]).toBe(runs[0]);
  });

  it('the model is PURE: the same inputs give the same point at any t', () => {
    const a = sim.grader.simulate(params, { t: 0 }, 2.5);
    const b = sim.grader.simulate(params, { t: 0 }, 2.5);
    expect(a).toEqual(b);
  });

  it('rejects a state with no finite `t`', () => {
    expect(() => sim.grader.grade({ t: Number.NaN }, params, { value: 1 }, null)).toThrow(
      /STATE_INVALID/,
    );
  });
});

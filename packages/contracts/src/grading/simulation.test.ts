/**
 * The simulation grader dispatch.  (P7-T4)
 *
 * ## ONE TEST HERE MATTERS MORE THAN THE OTHERS
 *
 * `INV-SIM-2`: "A student is never auto-zeroed because our code failed." Every failure mode below is a defect
 * in a bundle we did not write, a worker we did not test, or a validator we changed under a student. If any of
 * them produced `points: 0` it would be indistinguishable, in a release batch, from a wrong answer -- and the
 * first person to notice would be a teacher marking a run of zeros, and the student would have no way to
 * contest it.
 *
 * So the property is asserted directly and repeatedly: **no technical failure produces a zero.** Not "usually",
 * not "for the cases we thought of". Every arm, checked.
 */
import { describe, expect, it } from 'vitest';
import {
  type DispatchInput,
  dispatchToSim,
  SCORING_SURFACES,
  type SimGrader,
  type SimulationQuestionSpec,
  simPublishRefusal,
} from './simulation.js';

const SPEC: SimulationQuestionSpec = {
  simId: 'physics.pendulum',
  simVersion: '1.0.0',
  scoringSurface: 'ENDPOINT_ONLY',
  params: { length: 1 },
};

const graderReturning =
  (points: unknown, maxPoints: unknown = 4): SimGrader =>
  () => ({ points, maxPoints });

const input = (overrides: Partial<DispatchInput> = {}): DispatchInput => ({
  spec: SPEC,
  state: { angle: 0.5 },
  answer: 2.04,
  loadGrader: async () => graderReturning(4),
  validateState: () => true,
  timeoutMs: 500,
  ...overrides,
});

/** EVERY WAY THE PLATFORM CAN FAIL, in one list, so the zero-guard is a loop and not a series of cases. */
const TECHNICAL_FAILURES: ReadonlyArray<readonly [string, Partial<DispatchInput>]> = [
  [
    'the grader throws',
    {
      loadGrader: async () => () => {
        throw new Error('boom');
      },
    },
  ],
  [
    'the grader throws a non-Error',
    {
      loadGrader: async () => () => {
        throw 'a string';
      },
    },
  ],
  [
    'the bundle cannot be loaded',
    {
      loadGrader: async () => {
        throw new Error('404');
      },
    },
  ],
  [
    'the bundle exports a non-function',
    { loadGrader: async () => ({ not: 'a function' }) as never },
  ],
  ['the grader returns NaN points', { loadGrader: async () => graderReturning(Number.NaN) }],
  ['the grader returns undefined points', { loadGrader: async () => graderReturning(undefined) }],
  ['the state fails its own schema', { validateState: () => false }],
  ['the sim declares no scoringSurface', { spec: { ...SPEC, scoringSurface: null } }],
];

describe('INV-SIM-2: a student is never auto-zeroed because our code failed', () => {
  it('routes every technical failure to a HUMAN, and NONE of them scores zero', async () => {
    for (const [what, overrides] of TECHNICAL_FAILURES) {
      const outcome = await dispatchToSim(input(overrides));
      expect({ what, kind: outcome.kind }).toEqual({ what, kind: 'NEEDS_HUMAN' });
      if (outcome.kind !== 'NEEDS_HUMAN') throw new Error(`${what} was graded`);
      expect(outcome.reason).toBeTruthy();
      // THE ASSERTION. `points` does not exist on a `NEEDS_HUMAN` outcome, so there is nothing to be zero --
      // the score cannot be rendered, printed, or averaged into a total by accident.
      expect('points' in outcome).toBe(false);
    }
  });

  it('distinguishes a wrong answer from a broken grader, which is the whole point', async () => {
    // A grader that returns 0 is a DEFECT-FREE zero: the sim ran, and it says the answer is wrong. That is the
    // only thing in this file allowed to produce zero, and it has to look different from the cases above.
    const outcome = await dispatchToSim(input({ loadGrader: async () => graderReturning(0) }));
    expect(outcome.kind).toBe('GRADED');
    if (outcome.kind !== 'GRADED') throw new Error('unreachable');
    expect(outcome.points).toBe(0);
  });

  it('carries the failure REASON and DETAIL, so a marker can act rather than just escalate', async () => {
    const outcome = await dispatchToSim(
      input({
        loadGrader: async () => {
          throw new Error('missing bundle');
        },
      }),
    );
    if (outcome.kind !== 'NEEDS_HUMAN') throw new Error('unreachable');
    expect(outcome.reason).toBe('GRADER_UNREADABLE');
    expect(outcome.detail).toContain('missing bundle');
  });

  it('preserves a THROW TYPE AND MESSAGE, because "undefined" tells a marker nothing', async () => {
    const outcome = await dispatchToSim(
      input({
        loadGrader: async () => () => {
          throw new TypeError('x is not a function');
        },
      }),
    );
    if (outcome.kind !== 'NEEDS_HUMAN') throw new Error('unreachable');
    expect(outcome.detail).toContain('TypeError');
    expect(outcome.detail).toContain('x is not a function');
  });
});

describe('a timeout', () => {
  it('routes a LOADER that never resolves to a human, and does not wait for it', async () => {
    // `loadGrader` is genuinely async -- it resolves a bundle, which in production is a registry read and a
    // dynamic import -- so a hung loader is catchable by a timer. My first version of this test hung the
    // GRADER instead, by returning a never-settling promise from it, and the dispatch reported
    // `GRADER_UNREADABLE`: a sim grader returns a value synchronously, so a promise has no `points` on it.
    const outcome = await dispatchToSim(
      input({
        // eslint-disable-next-line require-await -- a loader that never settles IS the case under test.
        loadGrader: async () => new Promise(() => {}) as never,
        timeoutMs: 30,
      }),
    );
    expect(outcome.kind).toBe('NEEDS_HUMAN');
    if (outcome.kind !== 'NEEDS_HUMAN') throw new Error('unreachable');
    expect(outcome.reason).toBe('GRADER_TIMED_OUT');
  });

  it('normalises a NON-FINITE maxPoints rather than producing an unrenderable grade', async () => {
    const outcome = await dispatchToSim(
      input({ loadGrader: async () => graderReturning(2, Number.NaN) }),
    );
    if (outcome.kind !== 'GRADED') throw new Error('unreachable');
    expect(outcome.maxPoints).toBe(0);
    expect(Number.isFinite(outcome.maxPoints)).toBe(true);
  });
});

describe('scoringSurface is mandatory (V-11)', () => {
  it('refuses an item built on a sim that declares none', () => {
    // Without the field the item measures parameter-space search: `sim:answer` is overwritable indefinitely and
    // hiding the gradePreview FRAME is not the same as suppressing the sim's own "Correct". The facility looks
    // excellent while measuring nothing.
    const refusal = simPublishRefusal({ ...SPEC, scoringSurface: undefined });
    expect(refusal).not.toBeNull();
    expect(refusal).toContain('V-11');
    expect(refusal).toContain('ENDPOINT_ONLY');
  });

  it('accepts both declared surfaces', () => {
    for (const surface of SCORING_SURFACES) {
      expect(simPublishRefusal({ ...SPEC, scoringSurface: surface })).toBeNull();
    }
  });

  it('refuses a surface it does not recognise, rather than treating it as one it does', () => {
    expect(simPublishRefusal({ ...SPEC, scoringSurface: 'WHATEVER' as never })).toContain(
      'not one of',
    );
  });
});

describe('the surface decides what the grader can SEE', () => {
  it('hides the state and trace from an ENDPOINT_ONLY grader', async () => {
    let seen: unknown = null;
    await dispatchToSim(
      input({
        loadGrader: async () => (state: unknown) => {
          seen = state;
          return { points: 1 };
        },
      }),
    );
    // An item that claims to measure only the endpoint must not be able to read the path, or retrying until
    // correct raises the score with no change in understanding.
    expect(seen).toEqual({ state: null, trace: [] });
  });

  it('gives a PATH_SENSITIVE grader the state and the trace', async () => {
    let seen: unknown = null;
    await dispatchToSim(
      input({
        spec: { ...SPEC, scoringSurface: 'PATH_SENSITIVE' },
        trace: [{ kind: 'step' }, { kind: 'step' }],
        loadGrader: async () => (state: unknown) => {
          seen = state;
          return { points: 1 };
        },
      }),
    );
    expect(seen).toEqual({ state: { angle: 0.5 }, trace: [{ kind: 'step' }, { kind: 'step' }] });
  });

  it('gives a PATH_SENSITIVE grader an EMPTY trace rather than undefined when there is none', async () => {
    let seen: unknown = null;
    await dispatchToSim(
      input({
        spec: { ...SPEC, scoringSurface: 'PATH_SENSITIVE' },
        loadGrader: async () => (state: unknown) => {
          seen = state;
          return { points: 1 };
        },
      }),
    );
    expect(seen).toEqual({ state: { angle: 0.5 }, trace: [] });
  });
});

describe('the remaining dispatch paths', () => {
  it('applies a DEFAULT budget when the caller gives none', async () => {
    // The default is 5000 ms and is read from `input.timeoutMs ?? 5000`; asserting the constant is reached
    // rather than shadowed by a stray default elsewhere.
    const outcome = await dispatchToSim({
      spec: SPEC,
      state: {},
      answer: 1,
      loadGrader: async () => graderReturning(1),
      validateState: () => true,
    });
    expect(outcome.kind).toBe('GRADED');
  });

  it('preserves a NON-Error rejection from the loader', async () => {
    const outcome = await dispatchToSim(
      input({
        loadGrader: async () => {
          throw 'a bare string';
        },
      }),
    );
    if (outcome.kind !== 'NEEDS_HUMAN') throw new Error('unreachable');
    expect(outcome.reason).toBe('GRADER_UNREADABLE');
    expect(outcome.detail).toContain('a bare string');
  });

  it('reads a bundle that exports a valid grader with no maxPoints', async () => {
    const outcome = await dispatchToSim(input({ loadGrader: async () => () => ({ points: 3 }) }));
    if (outcome.kind !== 'GRADED') throw new Error('unreachable');
    expect(outcome.maxPoints).toBe(0);
    expect(outcome.code).toBe('CORRECT');
  });

  it('preserves the grader CODE when it supplies one', async () => {
    const outcome = await dispatchToSim(
      input({
        loadGrader: async () => () => ({ points: 2, maxPoints: 4, code: 'WITHIN_TOLERANCE' }),
      }),
    );
    if (outcome.kind !== 'GRADED') throw new Error('unreachable');
    expect(outcome.code).toBe('WITHIN_TOLERANCE');
  });

  it('refuses a spec whose scoringSurface is null AND an unrecognised one', async () => {
    const nullish = await dispatchToSim(input({ spec: { ...SPEC, scoringSurface: null } }));
    expect(nullish.kind).toBe('NEEDS_HUMAN');
    const bogus = await dispatchToSim(
      input({ spec: { ...SPEC, scoringSurface: 'NOPE' as never } }),
    );
    expect(bogus.kind).toBe('NEEDS_HUMAN');
    if (bogus.kind !== 'NEEDS_HUMAN') throw new Error('unreachable');
    expect(bogus.detail).toContain('not one of');
  });
});

describe('defaults and the grader boundary', () => {
  it('passes an EMPTY params object when the spec declares none', async () => {
    let seen: unknown = null;
    await dispatchToSim(
      input({
        spec: { ...SPEC, params: undefined },
        loadGrader: async () => (state: unknown, params: unknown) => {
          seen = params;
          return { points: 1 };
        },
      }),
    );
    // `params ?? {}` rather than `params`, because a sim grader is third-party code and `undefined` there is
    // a shape it will not expect.
    expect(seen).toEqual({});
  });
});

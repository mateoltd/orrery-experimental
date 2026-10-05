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
import type { QuestionSpec } from '../question/index.js';
import { grade } from './index.js';
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
  // `ADV-S4`: the four values `Number()` turns into `0`. Each of these was `GRADED` with zero marks.
  ['the grader returns null points', { loadGrader: async () => graderReturning(null) }],
  ['the grader returns empty-string points', { loadGrader: async () => graderReturning('') }],
  ['the grader returns empty-array points', { loadGrader: async () => graderReturning([]) }],
  ['the grader returns false points', { loadGrader: async () => graderReturning(false) }],
  // `ADV-S5`: an award outside the range the bundle itself declared, and a bundle that declared none.
  ['the grader awards above its maximum', { loadGrader: async () => graderReturning(1e9) }],
  ['the grader awards below zero', { loadGrader: async () => graderReturning(-50) }],
  ['the grader declares no maximum', { loadGrader: async () => () => ({ points: 3 }) }],
  ['the state fails its own schema', { validateState: () => false }],
  // `ADV-S3`: this one REJECTED, so the loop below never received an outcome to inspect.
  [
    'the validator throws',
    {
      validateState: () => {
        throw new TypeError('Do not know how to serialize a BigInt');
      },
    },
  ],
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
        loadGrader: async () => new Promise(() => {}) as never,
        timeoutMs: 30,
      }),
    );
    expect(outcome.kind).toBe('NEEDS_HUMAN');
    if (outcome.kind !== 'NEEDS_HUMAN') throw new Error('unreachable');
    expect(outcome.reason).toBe('GRADER_TIMED_OUT');
  });

  it('REFUSES a NON-FINITE maxPoints rather than producing an unrenderable grade', async () => {
    /**
     * THIS TEST WAS INVERTED BY `ADV-S5`, and what it used to assert is the finding.
     *
     * It asserted that `{ points: 2, maxPoints: NaN }` is `GRADED` with `maxPoints: 0`, and called that "normalising".
     * It never looked at `points`, which was still `2` -- so the grade it pinned was TWO MARKS OUT OF ZERO: above its
     * own ceiling, and unrenderable as a fraction, which is the thing its title said it prevented. No implementation
     * can keep that outcome `GRADED` and hold `points <= maxPoints` without turning the `2` into a `0`, and a zero
     * invented because a bundle garbled a field is the auto-zero `INV-SIM-2` forbids. So it is a refusal.
     */
    const outcome = await dispatchToSim(
      input({ loadGrader: async () => graderReturning(2, Number.NaN) }),
    );
    expect(outcome).toEqual({
      kind: 'NEEDS_HUMAN',
      reason: 'GRADER_UNREADABLE',
      detail: 'the grader returned maxPoints=NaN, so there is no range to read points=2 against',
    });
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
          return { points: 1, maxPoints: 1 };
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
          return { points: 1, maxPoints: 1 };
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
          return { points: 1, maxPoints: 1 };
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

  it('does NOT read a grader that declares no maxPoints as a grade', async () => {
    /**
     * INVERTED BY `ADV-S5`, for the same reason as the non-finite case above.
     *
     * This asserted that `{ points: 3 }` is "a valid grader with no maxPoints" and is `GRADED` with `maxPoints: 0`
     * -- three marks out of zero. A bound the bundle may decline to declare is not a bound: `{ points: 1e9 }` took
     * the same path. `Grade` in `@orrery/sim-sdk` requires `maxPoints`, so a bundle built on the SDK always has one.
     */
    const outcome = await dispatchToSim(input({ loadGrader: async () => () => ({ points: 3 }) }));
    expect(outcome).toEqual({
      kind: 'NEEDS_HUMAN',
      reason: 'GRADER_UNREADABLE',
      detail:
        'the grader returned maxPoints=undefined, so there is no range to read points=3 against',
    });
  });

  it('supplies the default CODE when the grader gives none', async () => {
    // The half of the inverted test that was about something else, kept: no `code` reads as `CORRECT`.
    const outcome = await dispatchToSim(
      input({ loadGrader: async () => () => ({ points: 3, maxPoints: 4 }) }),
    );
    expect(outcome).toEqual({ kind: 'GRADED', points: 3, maxPoints: 4, code: 'CORRECT' });
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
        loadGrader: async () => (_state: unknown, params: unknown) => {
          seen = params;
          return { points: 1, maxPoints: 1 };
        },
      }),
    );
    // `params ?? {}` rather than `params`, because a sim grader is third-party code and `undefined` there is
    // a shape it will not expect.
    expect(seen).toEqual({});
  });
});

describe('ADV-S3: a validator that cannot give a verdict routes to a human, and the bundle is never loaded', () => {
  /** Counts loads, because "the bundle never saw the state" is the half of the guarantee that is lost quietly. */
  const counting = () => {
    const calls = { loaded: 0 };
    const loadGrader = async (): Promise<SimGrader> => {
      calls.loaded += 1;
      return graderReturning(4);
    };
    return { calls, loadGrader };
  };

  it('RESOLVES when the validator throws, with the throw in the detail', async () => {
    // What breaks without it: the dispatch REJECTS, so one unreadable state fails the whole submission instead
    // of sending one question to a marker -- and it is the arm a malformed state reaches first.
    const { calls, loadGrader } = counting();
    const outcome = await dispatchToSim(
      input({
        loadGrader,
        validateState: () => {
          throw new TypeError('Do not know how to serialize a BigInt');
        },
      }),
    );
    expect(outcome).toEqual({
      kind: 'NEEDS_HUMAN',
      reason: 'STATE_FAILED_ITS_SCHEMA',
      detail:
        'physics.pendulum@1.0.0 state could not be checked against its declared stateSchema: ' +
        'TypeError: Do not know how to serialize a BigInt',
    });
    expect(calls.loaded).toBe(0);
  });

  it('resolves even when the thing thrown cannot be turned into a string', async () => {
    // `String(Object.create(null))` is itself a TypeError, so a `catch` that describes its error with `String`
    // rejects from inside the handler. Same for an `Error` whose `message` is a getter that throws.
    const hostile = new Error('never read');
    Object.defineProperty(hostile, 'message', {
      get: () => {
        throw new Error('the message getter threw');
      },
    });
    for (const thrown of [Object.create(null) as unknown, hostile]) {
      const outcome = await dispatchToSim(
        input({
          validateState: () => {
            throw thrown;
          },
        }),
      );
      expect(outcome).toEqual({
        kind: 'NEEDS_HUMAN',
        reason: 'STATE_FAILED_ITS_SCHEMA',
        detail:
          'physics.pendulum@1.0.0 state could not be checked against its declared stateSchema: ' +
          'something that could not be described',
      });
    }
  });

  it('keeps the plain refusal for a validator that says `false`', async () => {
    const outcome = await dispatchToSim(input({ validateState: () => false }));
    expect(outcome).toEqual({
      kind: 'NEEDS_HUMAN',
      reason: 'STATE_FAILED_ITS_SCHEMA',
      detail: 'physics.pendulum@1.0.0 state does not satisfy its declared stateSchema',
    });
  });

  it('accepts ONLY `true`, so a truthy non-verdict does not validate every state', async () => {
    /**
     * The check was `!verdict`. The validators most likely to be wired in return TRUTHY values on failure: an
     * `async` one returns a promise, and a `safeParse` returns `{ success: false }`. Both read as "valid", and the
     * state went to the bundle unchecked.
     */
    const cases: ReadonlyArray<readonly [unknown, string]> = [
      [Promise.resolve(false), '[object]'],
      [{ success: false }, '[object]'],
      [1, '1'],
      ['true', '"true"'],
      [undefined, 'undefined'],
      [null, 'null'],
    ];
    for (const [verdict, shown] of cases) {
      const { calls, loadGrader } = counting();
      const outcome = await dispatchToSim(
        input({ loadGrader, validateState: (() => verdict) as never }),
      );
      expect(outcome).toEqual({
        kind: 'NEEDS_HUMAN',
        reason: 'STATE_FAILED_ITS_SCHEMA',
        detail: `physics.pendulum@1.0.0 state was not validated: the validator returned ${shown} rather than a verdict`,
      });
      expect(calls.loaded).toBe(0);
    }
  });
});

describe('ADV-S4: an award that is not already a number is never read as one', () => {
  it('routes every non-number `points` to a human, naming what was returned', async () => {
    /**
     * The first four are the bug: `Number(null)`, `Number('')`, `Number([])` and `Number(false)` are all `0`, so a
     * bundle that could not compute a score and said so with `null` was reported as GRADED, ZERO MARKS.
     *
     * The rest are here so the fix is "nothing is coerced" and not "four more special cases": `'4'` and `true`
     * coerce to marks ABOVE zero, which is the same defect paying out instead of costing.
     */
    const cases: ReadonlyArray<readonly [unknown, string]> = [
      [null, 'null'],
      ['', '""'],
      [[], '[array]'],
      [false, 'false'],
      ['4', '"4"'],
      [true, 'true'],
      [[4], '[array]'],
      [{}, '[object]'],
      [4n, '4n'],
      [() => 4, '[function]'],
      [Symbol('four'), 'Symbol(four)'],
      [undefined, 'undefined'],
      [Number.NaN, 'NaN'],
      [Number.POSITIVE_INFINITY, 'Infinity'],
      [Number.NEGATIVE_INFINITY, '-Infinity'],
    ];
    for (const [points, shown] of cases) {
      const outcome = await dispatchToSim(
        input({ loadGrader: async () => graderReturning(points) }),
      );
      expect(outcome).toEqual({
        kind: 'NEEDS_HUMAN',
        reason: 'GRADER_UNREADABLE',
        detail: `the grader returned points=${shown}`,
      });
    }
  });

  it('still reads a real zero as a mark, which is the only zero this module may report', async () => {
    const outcome = await dispatchToSim(input({ loadGrader: async () => graderReturning(0) }));
    expect(outcome).toEqual({ kind: 'GRADED', points: 0, maxPoints: 4, code: 'CORRECT' });
  });

  it('routes a return that is not an object at all to a human', async () => {
    const cases: ReadonlyArray<readonly [unknown, string]> = [
      [null, 'null'],
      [undefined, 'undefined'],
      [4, '4'],
      ['4/4', '"4/4"'],
      [true, 'true'],
    ];
    for (const [returned, shown] of cases) {
      const outcome = await dispatchToSim(
        input({ loadGrader: async () => (() => returned) as never }),
      );
      expect(outcome).toEqual({
        kind: 'NEEDS_HUMAN',
        reason: 'GRADER_UNREADABLE',
        detail: `the grader returned ${shown} rather than a grade`,
      });
    }
  });

  it('reads an async grader as unreadable, because a promise has no `points` on it', async () => {
    const outcome = await dispatchToSim(
      input({ loadGrader: async () => (async () => ({ points: 4, maxPoints: 4 })) as never }),
    );
    expect(outcome).toEqual({
      kind: 'NEEDS_HUMAN',
      reason: 'GRADER_UNREADABLE',
      detail: 'the grader returned points=undefined',
    });
  });

  it('reads each field ONCE, so a getter cannot answer one thing to the check and another to the mark', async () => {
    let reads = 0;
    const outcome = await dispatchToSim(
      input({
        loadGrader: async () => () => ({
          get points() {
            reads += 1;
            return reads === 1 ? 4 : 1e9;
          },
          maxPoints: 4,
        }),
      }),
    );
    expect(outcome).toEqual({ kind: 'GRADED', points: 4, maxPoints: 4, code: 'CORRECT' });
    expect(reads).toBe(1);
  });

  it('files a getter that THROWS under the grader, not under the dispatch', async () => {
    const outcome = await dispatchToSim(
      input({
        loadGrader: async () => () => ({
          get points(): number {
            throw new RangeError('computed lazily, and wrongly');
          },
          maxPoints: 4,
        }),
      }),
    );
    expect(outcome).toEqual({
      kind: 'NEEDS_HUMAN',
      reason: 'GRADER_THREW',
      detail: 'RangeError: computed lazily, and wrongly',
    });
  });

  it('resolves when the grader or the loader throws something that cannot be described', async () => {
    const thrower: SimGrader = () => {
      throw Object.create(null);
    };
    expect(await dispatchToSim(input({ loadGrader: async () => thrower }))).toEqual({
      kind: 'NEEDS_HUMAN',
      reason: 'GRADER_THREW',
      detail: 'something that could not be described',
    });
    expect(
      await dispatchToSim(
        input({
          loadGrader: async () => {
            throw Object.create(null);
          },
        }),
      ),
    ).toEqual({
      kind: 'NEEDS_HUMAN',
      reason: 'GRADER_UNREADABLE',
      detail: 'could not load grader: something that could not be described',
    });
  });
});

describe('ADV-S5: a bundle may award only inside the range it declared', () => {
  it('REFUSES an award outside the range, and does not clamp it into a mark', async () => {
    /**
     * What breaks without it: `1e9` and `-50` are GRADED outcomes carrying exactly those numbers.
     *
     * And what a CLAMP would break instead: `-50` becomes zero marks and `1e9` becomes full marks, both invented
     * by us from a grader that has just contradicted itself. So the assertion is the whole outcome -- there is no
     * `points` on it to be clamped, zeroed, or averaged.
     */
    const cases: ReadonlyArray<readonly [number, string]> = [
      [1_000_000_000, '1000000000'],
      [-50, '-50'],
      [4.000001, '4.000001'],
      [-0.5, '-0.5'],
      [-Number.MIN_VALUE, '-5e-324'],
    ];
    for (const [points, shown] of cases) {
      const outcome = await dispatchToSim(
        input({ loadGrader: async () => graderReturning(points) }),
      );
      expect(outcome).toEqual({
        kind: 'NEEDS_HUMAN',
        reason: 'GRADER_UNREADABLE',
        detail: `the grader awarded ${shown}, outside the 0 to 4 it declared`,
      });
    }
  });

  it('passes every award inside the range through UNCHANGED, the ends included', async () => {
    for (const points of [0, 0.5, 2.5, 4]) {
      const outcome = await dispatchToSim(
        input({ loadGrader: async () => graderReturning(points) }),
      );
      expect(outcome).toEqual({ kind: 'GRADED', points, maxPoints: 4, code: 'CORRECT' });
    }
  });

  it('refuses when no usable range is declared, so omitting the ceiling is not a way round it', async () => {
    const cases: ReadonlyArray<readonly [unknown, string]> = [
      [undefined, 'undefined'],
      [null, 'null'],
      [Number.NaN, 'NaN'],
      [Number.POSITIVE_INFINITY, 'Infinity'],
      ['4', '"4"'],
      [-4, '-4'],
    ];
    for (const [maxPoints, shown] of cases) {
      const outcome = await dispatchToSim(
        input({ loadGrader: async () => () => ({ points: 1_000_000_000, maxPoints }) }),
      );
      expect(outcome).toEqual({
        kind: 'NEEDS_HUMAN',
        reason: 'GRADER_UNREADABLE',
        detail: `the grader returned maxPoints=${shown}, so there is no range to read points=1000000000 against`,
      });
    }
  });

  it('grades a zero-weight item, where the only award in range is zero', async () => {
    expect(await dispatchToSim(input({ loadGrader: async () => graderReturning(0, 0) }))).toEqual({
      kind: 'GRADED',
      points: 0,
      maxPoints: 0,
      code: 'CORRECT',
    });
    const over = await dispatchToSim(input({ loadGrader: async () => graderReturning(1, 0) }));
    expect(over.kind).toBe('NEEDS_HUMAN');
  });

  it('reports `-0` as `0`, in the award and in the ceiling', async () => {
    // `-0` is in range, and `toBe` is `Object.is`, so this fails on a `-0` that a stored `0` would not equal.
    const outcome = await dispatchToSim(input({ loadGrader: async () => graderReturning(-0, -0) }));
    if (outcome.kind !== 'GRADED')
      throw new Error('a zero award on a zero-weight item was refused');
    expect(outcome.points).toBe(0);
    expect(outcome.maxPoints).toBe(0);
  });

  it('holds 0 <= points <= maxPoints on EVERY graded outcome, whatever the bundle returns', async () => {
    const values: readonly unknown[] = [
      -50,
      -1,
      -0,
      0,
      1,
      4,
      5,
      1e9,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      null,
      undefined,
      '',
      '4',
      [],
      false,
      true,
      {},
    ];
    let graded = 0;
    for (const points of values) {
      for (const maxPoints of values) {
        const outcome = await dispatchToSim(
          input({ loadGrader: async () => () => ({ points, maxPoints }) }),
        );
        if (outcome.kind !== 'GRADED') continue;
        graded += 1;
        expect(outcome.points).toBeGreaterThanOrEqual(0);
        expect(outcome.points).toBeLessThanOrEqual(outcome.maxPoints);
        // And a graded outcome is exactly what the bundle said: nothing was moved into range to get here.
        expect(outcome.points).toBe(points === 0 ? 0 : points);
        expect(outcome.maxPoints).toBe(maxPoints === 0 ? 0 : maxPoints);
      }
    }
    // The pairs that ARE grades, counted, so the loop cannot pass by refusing everything: with ceilings
    // {-0, 0, 1, 4, 5, 1e9} and awards {-0, 0, 1, 4, 5, 1e9}, an award is in range when it is <= the ceiling.
    expect(graded).toBe(2 * 6 + 4 + 3 + 2 + 1);
  });

  it('leaves `rawPoints` alone: a PENALTY may still be negative, because it is not an award', () => {
    /**
     * `plans/07` section 3.2 stores `rawPoints` unclamped so that `NG` can go below zero; the floor belongs in the
     * attempt total. The bound above is on a different quantity -- what a third-party bundle AWARDED, in
     * `SimOutcome.points` -- and it must not have leaked into the scoring policy's own arithmetic.
     *
     * One correct key of four options, two wrong selections, `NG`: 0 right minus 2 wrong, times 4 marks per key.
     */
    const penalised = grade({
      spec: {
        id: 'q1',
        points: 4,
        gradingMode: 'AUTO',
        shuffleOptions: false,
        estimatedSeconds: 60,
        cognitiveDemand: 'APPLY',
        tags: [],
        type: 'multi_select',
        choices: [
          { id: 'a', text: 'A' },
          { id: 'b', text: 'B' },
          { id: 'c', text: 'C' },
          { id: 'd', text: 'D' },
        ],
        key: { choiceIds: ['a'] },
        partialCredit: 'NG',
      } as QuestionSpec,
      response: { choiceIds: ['b', 'c'] },
    });
    expect(penalised.rawPoints).toBe(-8);
    expect(penalised.points).toBe(0);
  });
});

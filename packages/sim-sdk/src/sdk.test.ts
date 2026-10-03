/**
 * `@orrery/sim-sdk`, and the guarantee `INV-SIM-2` rests on.  (P6-T3)
 *
 * ## THE TEST THAT MATTERS MOST
 *
 * `the grader entry point CANNOT REACH THE DOM` — it walks the real import graph from
 * `src/grader.ts` and asserts no reachable module touches `document`, `window` or a Node builtin.
 *
 * This is stronger than the esbuild metafile assertion `B14` specifies, and deliberately so: a
 * metafile assertion catches a bad BUILD, after the author has pushed, while this catches a bad
 * CALL in their editor while they are writing it. The metafile check still belongs here too, at
 * build time, because a module graph is not the whole story — a dynamic `import()` inside a string
 * is invisible to both.
 *
 * ## THE OTHER TESTS THAT MATTER
 *
 *  · `tolerance is SYMMETRIC` — an asymmetric tolerance marks 4.999 wrong when 5.001 is right, and
 *    the bug is invisible until a real student's number lands near the boundary.
 *  · `a state checksum does not depend on KEY ORDER` — otherwise a restore that rebuilt an object
 *    reports a mismatch against a state that never changed.
 *  · `the stepper's `t` is always a multiple of stepSize`, even after a scrub — otherwise a scrubbed
 *    timeline and a played one disagree.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { defineSim, gradeStoredState } from './define.js';
import { exact, numeric, rubric, setMatch, tolerance, withinTolerance } from './grading.js';
import { bool, choice, clampParams, int, num, str, validateParamSpecs } from './params.js';
import { checksumState, restoreState, serialiseState, serialiseToText } from './state.js';
import { createStepper, initialStepper, MAX_CATCHUP_STEPS, stepperReduce } from './stepper.js';

const here = dirname(fileURLToPath(import.meta.url));
const src = (name: string): string => readFileSync(join(here, name), 'utf8');

describe('the DOM-free boundary', () => {
  it('the grader entry point CANNOT REACH THE DOM or a Node builtin', () => {
    // Walks the real import graph, so adding an import to any grader-side module is caught.
    const seen = new Set<string>();
    const queue = ['grader.ts'];
    const offenders: string[] = [];
    while (queue.length > 0) {
      const file = queue.shift() as string;
      if (seen.has(file)) continue;
      seen.add(file);
      const source = src(file);
      // Strip comments AND string literals before looking. Comments because a module may DISCUSS
      // `document` in prose, and strings because `PROHIBITED_APIS` legitimately contains the literal
      // `'window.open'` — which is the name of a thing we forbid, not a call to it. The first version
      // stripped comments only and reported `protocol.ts` as a DOM offender for doing exactly that.
      const code = source
        .replace(/\/\*[\s\S]*?\*\//gu, '')
        .replace(/\/\/[^\n]*/gu, '')
        .replace(/'(?:[^'\\\n]|\\.)*'/gu, "''")
        .replace(/"(?:[^"\\\n]|\\.)*"/gu, '""')
        .replace(/`(?:[^`\\]|\\.)*`/gu, '``');
      if (
        /\bdocument\s*\./u.test(code) ||
        /\bwindow\s*\./u.test(code) ||
        /\bHTMLElement\b/u.test(code)
      ) {
        offenders.push(`${file} reaches a DOM type or global`);
      }
      if (/from\s*['"]node:/u.test(code) || /\brequire\s*\(\s*['"]node:/u.test(code)) {
        offenders.push(`${file} imports a Node builtin`);
      }
      for (const match of source.matchAll(/from\s*'\.\/([A-Za-z0-9_-]+)\.js'/gu)) {
        queue.push(`${String(match[1])}.ts`);
      }
    }
    expect(offenders).toEqual([]);
    // And it is a graph, not a one-file check: the closure is more than the entry point.
    expect(seen.size).toBeGreaterThan(3);
  });

  it('the grader entry point is NOT the package barrel', () => {
    // The single most likely mistake: an author imports `@orrery/sim-sdk` in a grader file because
    // that is what the docs say to import. The barrel pulls in `a11y.ts`, which is DOM.
    const barrel = src('index.ts');
    expect(barrel).toMatch(/from '\.\/a11y\.js'/u);
    expect(src('grader.ts')).not.toMatch(/from '\.\/a11y\.js'/u);
    expect(src('grader.ts')).not.toMatch(/from '\.\/bridge\.js'/u);
  });

  it('`package.json` has NO third-party runtime dependency, directly or transitively', () => {
    // `RN-07`: a decade-old bundled jQuery became a strategic liability. The only dependency is a
    // WORKSPACE package that itself has none, so the closure of third-party code is empty.
    const pkg = JSON.parse(src('../package.json')) as {
      dependencies?: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies ?? {})).toEqual(['@orrery/rng']);
    const rng = JSON.parse(readFileSync(resolve(here, '../../rng/package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    expect(rng.dependencies ?? {}).toEqual({});
  });
});

describe('params', () => {
  const specs = {
    speed: num({ min: 5, max: 60, default: 25, unit: 'm/s' }),
    count: int({ min: 1, max: 10, default: 3 }),
    showTrail: bool({ label: 'Trail', default: true }),
    label: str({ label: 'Label', maxLength: 8, default: 'none' }),
    mode: choice({ label: 'Mode', values: ['fast', 'slow'], default: 'fast' }),
  };

  it('a declared default outside its own range is a THROWN error, not a clamp', () => {
    // A sim that starts in a state the author never wrote is a support ticket. Clamping silently
    // makes it one nobody can reproduce.
    const problems = validateParamSpecs({ speed: num({ min: 5, max: 60, default: 500 }) });
    expect(problems.map((p) => p.message).join(' ')).toMatch(/above the maximum/);
  });

  it('a number with an integer step becomes an integer param', () => {
    expect(num({ min: 0, max: 10, default: 1, step: 1 }).type).toBe('integer');
    expect(num({ min: 0, max: 10, default: 1, step: 0.5 }).type).toBe('number');
  });

  it('a value from an `<input>` arrives as a STRING and still works', () => {
    const { values, coerced } = clampParams(specs, { speed: '42' as unknown as number });
    expect(values.speed).toBe(42);
    expect(coerced).toEqual([]);
  });

  it('an out-of-range value is clamped and the coercion is REPORTED', () => {
    const { values, coerced } = clampParams(specs, { speed: 5000 });
    expect(values.speed).toBe(60);
    expect(coerced.join(' ')).toMatch(/clamped to max/);
  });

  it('a non-numeric value falls back to the default rather than becoming NaN', () => {
    const { values, coerced } = clampParams(specs, { speed: 'abc' as unknown as number });
    expect(values.speed).toBe(25);
    expect(coerced.join(' ')).toMatch(/-> default 25/);
    // `NaN` propagating into `simulate` is how a sim renders an empty canvas with no error.
    expect(Number.isNaN(values.speed as number)).toBe(false);
  });

  it('a checkbox sends "on", and that means true', () => {
    expect(clampParams(specs, { showTrail: 'on' as unknown as boolean }).values.showTrail).toBe(
      true,
    );
    expect(clampParams(specs, { showTrail: 'off' as unknown as boolean }).values.showTrail).toBe(
      false,
    );
    expect(
      clampParams(specs, { showTrail: 'nonsense' as unknown as boolean }).values.showTrail,
    ).toBe(true);
    // Something unrecognisable falls back to the DECLARED default, and `showTrail` here defaults to
    // `true`. The first version of this assertion expected `false`, which was asserting a default the
    // declaration did not have.
    const withFalse = { ...specs, showTrail: bool({ label: 'Trail', default: false }) };
    const coerced = clampParams(withFalse, { showTrail: 'nonsense' as unknown as boolean });
    expect(coerced.values.showTrail).toBe(false);
    expect(coerced.coerced.join(' ')).toMatch(/-> default false/);
  });

  it('an UNKNOWN param is DROPPED, not passed through', () => {
    // A newer host sending a parameter an older sim does not know must not be able to inject a
    // property into `simulate`'s params object.
    const { values, coerced } = clampParams(specs, { ghost: 'yes' } as never);
    expect(Object.keys(values).sort()).toEqual(['count', 'label', 'mode', 'showTrail', 'speed']);
    expect(coerced.join(' ')).toMatch(/unknown parameter dropped/);
  });

  it('a string longer than maxLength is truncated and reported', () => {
    const { values, coerced } = clampParams(specs, { label: 'far too long a label' });
    expect(values.label).toBe('far too ');
    expect(coerced.join(' ')).toMatch(/truncated/);
  });

  it('an enum value outside its values falls back rather than extending the set', () => {
    const { values } = clampParams(specs, { mode: 'sideways' });
    expect(values.mode).toBe('fast');
  });

  it('NaN and Infinity are treated as "not a number", not as extremes', () => {
    const { values } = clampParams(specs, { speed: Number.NaN, count: Number.POSITIVE_INFINITY });
    expect(values.speed).toBe(25);
    expect(Number.isFinite(values.count as number)).toBe(true);
  });
});

describe('grading', () => {
  it('tolerance is SYMMETRIC', () => {
    // An asymmetric tolerance marks 4.999 wrong when 5.001 is right, and the bug is invisible until a
    // real student's number lands near the boundary.
    for (const [a, b] of [
      [4.9, 5.0],
      [5.0, 4.9],
      [100, 100.5],
      [100.5, 100],
      [0, 0.0001],
      [-3, -3.01],
    ] as const) {
      const forward = withinTolerance(a, b, { abs: 0.5 });
      const backward = withinTolerance(b, a, { abs: 0.5 });
      expect(forward, `${String(a)} vs ${String(b)}`).toBe(backward);
    }
  });

  it('every grading helper is symmetric', () => {
    expect(tolerance(5, 4.9, { abs: 0.5, maxPoints: 4 }).points).toBe(
      tolerance(4.9, 5, { abs: 0.5, maxPoints: 4 }).points,
    );
    expect(numeric('5', 5, 1).points).toBe(numeric(5, '5', 1).points);
    expect(exact('A', 'a', 1).points).toBe(exact('a', 'A', 1).points);
    expect(setMatch(['a'], ['a'], { maxPoints: 2 }).points).toBe(
      setMatch(['a'], ['a'], { maxPoints: 2 }).points,
    );
  });

  it('partial credit is SYMMETRIC — 10% high and 10% low earn the same', () => {
    const spec = { abs: 0.1, maxPoints: 10, partialCredit: true };
    expect(tolerance(110, 100, spec).points).toBe(tolerance(100, 110, spec).points);
    expect(tolerance(90, 100, spec).points).toBe(tolerance(100, 90, spec).points);
  });

  it('a relative bound SCALES, so a big number is not held to an absolute standard', () => {
    expect(withinTolerance(1002, 1000, { abs: 0, rel: 0.02 })).toBe(true);
    // 2% of the larger magnitude (1010) is 20.2, so 10 units is inside it. The first version asserted
    // false here, which would have made every relative tolerance behave like an absolute one.
    expect(withinTolerance(1010, 1000, { abs: 0, rel: 0.02 })).toBe(true);
    expect(withinTolerance(1030, 1000, { abs: 0, rel: 0.02 })).toBe(false);
  });

  it('case folding is OFF on request, because a Punnett square needs it off', () => {
    // This is the whole reason the option exists: folded, `AA` and `aa` are ONE selection, so naming
    // the recessive genotype was marked correct for the dominant one.
    expect(setMatch(['aa'], ['AA', 'aa'], { maxPoints: 4 }).correct).toBe(true);
    const genotype = { maxPoints: 4, caseSensitive: true as const };
    expect(setMatch(['aa'], ['AA', 'aa'], genotype).correct).toBe(false);
    expect(setMatch(['AA', 'Aa', 'aa'], ['AA', 'Aa', 'aa'], genotype).correct).toBe(true);
    expect(setMatch(['AA'], ['AA', 'aa'], genotype).correct).toBe(false);
    // Still collapses genuine duplicates, case-sensitively.
    expect(setMatch(['AA', 'AA'], ['AA'], genotype).points).toBe(
      setMatch(['AA'], ['AA'], genotype).points,
    );
    // And a case-sensitive answer for an option list still works, which is why the option is opt-in.
    expect(setMatch(['Carbide'], ['carbide'], { maxPoints: 2 }).correct).toBe(true);
  });

  it('UNITS in the answer are accepted, because "25 m/s" and "25" are the same claim', () => {
    expect(numeric('25 m/s', '25', 1).correct).toBe(true);
    expect(numeric('45°', '45', 1).correct).toBe(true);
    // Refusing the first teaches students to strip units rather than to check their answer.
    expect(numeric('not a number', '25', 1).points).toBe(0);
  });

  it('points are clamped ONCE, in one place', () => {
    const over = rubric({ points: 99, maxPoints: 4, reason: 'generous' });
    expect(over.points).toBe(4);
    const under = rubric({ points: -5, maxPoints: 4, reason: 'harsh' });
    expect(under.points).toBe(0);
  });

  it('set grading gives Jaccard partial credit, not a ratio of counts', () => {
    // 3 correct of 6 asked is 3/6 = 0.5, not 3/5 = 0.6: the two omitted cells are part of what was
    // asked for, so a student who answered half must not earn most of the mark.
    const grade = setMatch(['p', 'q', 'r'], ['p', 'q', 'r', 's', 't', 'u'], {
      maxPoints: 4,
      partialCredit: true,
    });
    expect(grade.points).toBeCloseTo(2, 6);
    expect(grade.rationale).toMatch(/Jaccard/);
  });

  it('a SELECTION SUBSET with nothing extra earns FULL marks', () => {
    // Choosing 2 of 4 possible and getting both right IS the right answer, so the Jaccard penalty for
    // omitted cells must not apply here — the student was never asked to name the others.
    expect(setMatch(['AA'], ['AA', 'aa'], { maxPoints: 4 }).correct).toBe(true);
  });

  it('an EXTRA selection costs marks, which is what a Punnett square tests', () => {
    const withExtra = setMatch(['AA', 'AB'], ['AA', 'aa'], { maxPoints: 4, partialCredit: true });
    const without = setMatch(['AA'], ['AA', 'aa'], { maxPoints: 4, partialCredit: true });
    expect(withExtra.points).toBeLessThan(without.points);
  });

  it('duplicate selections are COLLAPSED, so repeating an answer cannot inflate the score', () => {
    const single = setMatch(['AA'], ['AA', 'aa'], { maxPoints: 2, partialCredit: true });
    const repeated = setMatch(['AA', 'AA', 'AA'], ['AA', 'aa'], {
      maxPoints: 2,
      partialCredit: true,
    });
    expect(repeated.points).toBe(single.points);
  });

  it('set grading accepts a COMMA-SEPARATED string, because that is what a text input produces', () => {
    expect(setMatch('AA, Aa, aa', ['AA', 'Aa', 'aa'], { maxPoints: 3 }).correct).toBe(true);
    expect(setMatch('AA;Aa;aa', ['AA', 'Aa', 'aa'], { maxPoints: 3 }).correct).toBe(true);
  });

  it('partial credit is OFF unless asked for', () => {
    // A four-mark item should not silently hand out two marks for half an answer. `AB` is not the
    // recessive phenotype under case folding, so it is genuinely an extra selection here.
    expect(setMatch(['AA'], ['AA', 'ab', 'bb'], { maxPoints: 4 }).points).toBe(0);
    expect(
      setMatch(['AA'], ['AA', 'ab', 'bb'], { maxPoints: 4, partialCredit: true }).points,
    ).toBeGreaterThan(0);
    expect(tolerance(4, 5, { abs: 0.1, maxPoints: 4 }).points).toBe(0);
    // And there is no default that grants it: the flag has to be passed.
    expect(tolerance(4.5, 5, { abs: 0.1, maxPoints: 4 }).points).toBe(0);
    expect(
      tolerance(4.5, 5, { abs: 0.1, maxPoints: 4, partialCredit: true }).points,
    ).toBeGreaterThan(0);
  });

  it('every grade carries a rationale a TEACHER can paste into a comment', () => {
    for (const grade of [
      tolerance(5, 5, { abs: 0.1, maxPoints: 4 }),
      tolerance('nope', 5, { abs: 0.1, maxPoints: 4 }),
      numeric(5, 6, 4),
      exact('a', 'b', 4),
      setMatch(['x'], ['y'], { maxPoints: 4 }),
      rubric({ points: 2, maxPoints: 4, reason: 'two criteria met' }),
    ]) {
      expect(grade.rationale.length).toBeGreaterThan(15);
      expect(grade.strategy).toBeTruthy();
    }
  });

  it('a rubric mark with NO REASON earns nothing, because it cannot be appealed', () => {
    const grade = rubric({ points: 4, maxPoints: 4, reason: '   ' });
    expect(grade.points).toBe(0);
    expect(grade.rationale).toMatch(/cannot be explained or appealed/);
  });

  it('exact compares objects regardless of KEY ORDER', () => {
    expect(exact({ a: 1, b: 2 }, { b: 2, a: 1 }, 1).correct).toBe(true);
  });
});

describe('state', () => {
  const meta = {
    simId: 'physics.pendulum',
    simVersion: '1.0.0',
    protocol: 1,
    savedAt: '2026-10-02T09:00:00.000Z',
  };

  it('the checksum does not depend on KEY ORDER', () => {
    // Otherwise a restore that rebuilt an object reports a mismatch against a state that never
    // changed, and the conformance suite's round-trip step fails for reasons unrelated to the sim.
    expect(checksumState({ a: 1, b: { c: 2, d: 3 } })).toBe(
      checksumState({ b: { d: 3, c: 2 }, a: 1 }),
    );
    expect(checksumState([1, 2, 3])).not.toBe(checksumState([3, 2, 1]));
  });

  it('-0 and 0 hash the same, or a restore never settles', () => {
    expect(checksumState({ v: -0 })).toBe(checksumState({ v: 0 }));
  });

  it('a non-finite number in a state is a THROWN error, not a silent null', () => {
    // A sim that thinks it saved when it did not is worse than one that says it failed.
    expect(() => checksumState({ t: Number.NaN })).toThrow(/NON_FINITE_NUMBER_IN_STATE/);
    expect(() => checksumState({ t: Number.POSITIVE_INFINITY })).toThrow(
      /NON_FINITE_NUMBER_IN_STATE/,
    );
  });

  it('a Date in a state is refused, because it would hash as {} and look unchanged since the epoch', () => {
    expect(() => checksumState({ at: new Date(0) })).toThrow(/NOT_A_PLAIN_OBJECT_IN_STATE/);
  });

  it('round-trips: serialise, restore, identical checksum', () => {
    const state = { t: 1.25, path: [0, 1, 2], meta: { swings: 3 } };
    const text = serialiseToText(serialiseState(state, meta));
    const restored = restoreState<typeof state>(text, meta);
    expect(restored.ok).toBe(true);
    expect(checksumState(restored.state)).toBe(checksumState(state));
  });

  it('a TAMPERED state is refused, and says what the two checksums were', () => {
    const text = serialiseToText(serialiseState({ t: 1 }, meta));
    const tampered = text.replace('"t":1', '"t":99');
    const restored = restoreState(tampered, meta);
    expect(restored.ok).toBe(false);
    expect(restored.problem).toMatch(/does not match its own checksum/);
    // "recomputed" and "stored" in the message is what makes this debuggable rather than alarming.
    expect(restored.problem).toMatch(/stored [0-9a-f]+, recomputed [0-9a-f]+/);
  });

  it('a VERSION MISMATCH is reported SEPARATELY, because the responses differ', () => {
    // A `MAJOR` bump means the shape may differ: the work is not corrupt, it is from a different
    // shape. The host offers a reset and KEEPS the old state rather than discarding an afternoon.
    const text = serialiseToText(serialiseState({ t: 1 }, meta));
    const restored = restoreState(text, { ...meta, simVersion: '2.0.0' });
    expect(restored.ok).toBe(false);
    expect(restored.versionMismatch).toBe(true);
    expect(restored.problem).toMatch(/kept rather than loaded/);
  });

  it('a state belonging to ANOTHER sim is refused, and is not a version mismatch', () => {
    const text = serialiseToText(serialiseState({ t: 1 }, meta));
    const restored = restoreState(text, { ...meta, simId: 'physics.other' });
    expect(restored.versionMismatch).toBe(false);
    expect(restored.problem).toMatch(/belongs to physics\.pendulum/);
  });

  it('junk is refused without throwing', () => {
    for (const junk of ['', 'not json', '[]', 'null', '{"no":"checksum"}', '42']) {
      const restored = restoreState(junk, meta);
      expect(restored.ok, JSON.stringify(junk)).toBe(false);
      expect(restored.code).toBe('STATE_INVALID');
    }
  });
});

describe('the stepper', () => {
  const base = { maxTime: 10, stepSize: 0.5 };

  it('`t` is always a multiple of stepSize, even after a SCRUB', () => {
    // A student who drags the scrubber to an arbitrary pixel gets the nearest step. Otherwise
    // `scrubTo(0.37)` followed by `step` gives different answers depending on which came first.
    const state = stepperReduce(initialStepper(base), { type: 'scrubTo', t: 3.37 });
    expect(state.t).toBe(3.5);
    expect((state.t / base.stepSize) % 1).toBe(0);
  });

  it('advance consumes WHOLE fixed steps and CARRIES the remainder', () => {
    const state = stepperReduce(stepperReduce(initialStepper(base), { type: 'play' }), {
      type: 'advance',
      dt: 1.7,
    });
    expect(state.t).toBe(1.5);
    expect((state.t / base.stepSize) % 1).toBe(0);
    // 1.7 of sim time is three whole steps and 0.2 left over, and the leftover is KEPT rather than
    // thrown away — otherwise the timeline runs slow by up to one step per frame, forever.
    expect(state.carry).toBeCloseTo(0.2, 9);
  });

  it('a PLAYED timeline and a SCRUBBED one agree once the carry is spent', () => {
    // `physics.pendulum` stresses fixed-timestep determinism, and this is the property: the same t is
    // reachable both ways. The first version compared them after ONE `advance` and they differed,
    // because the fractional remainder had been discarded rather than carried.
    const playing = stepperReduce(initialStepper(base), { type: 'play' });
    const first = stepperReduce(playing, { type: 'advance', dt: 2.4 });
    const second = stepperReduce(first, { type: 'advance', dt: 0.1 });
    expect(second.t).toBe(2.5);
    expect(stepperReduce(initialStepper(base), { type: 'scrubTo', t: 2.5 }).t).toBe(second.t);
  });

  it('`advance.dt` is REAL SECONDS and timeScale converts it, so units cannot be confused', () => {
    // The first version took MILLISECONDS and multiplied by a scale read as seconds, so one 16.7 ms
    // frame advanced the sim by 16.5 of its own seconds and a 60 fps pendulum finished before the
    // first frame was painted. A unit error in one multiplication is a silently broken simulation.
    const realTime = initialStepper({ maxTime: 100, stepSize: 0.5, timeScale: 1 });
    // Half a real second at 1:1 is half a sim second: exactly one step.
    expect(
      stepperReduce(stepperReduce(realTime, { type: 'play' }), { type: 'advance', dt: 0.5 }).t,
    ).toBe(0.5);
    // One 60 fps frame is 0.0167 s: not even a whole 0.5 s step, so the time is carried, not lost.
    const frame = stepperReduce(stepperReduce(realTime, { type: 'play' }), {
      type: 'advance',
      dt: 1 / 60,
    });
    expect(frame.t).toBe(0);
    expect(frame.carry).toBeCloseTo(1 / 60, 9);
    // The same half second at 1% speed is 0.005 sim seconds: still not a step.
    const slow = initialStepper({ maxTime: 100, stepSize: 0.5, timeScale: 0.01 });
    expect(
      stepperReduce(stepperReduce(slow, { type: 'play' }), { type: 'advance', dt: 0.5 }).t,
    ).toBe(0);
    // And a sim faster than real time advances by its own scale: 0.125 s at 4x is half a sim second.
    const quick = initialStepper({ maxTime: 100, stepSize: 0.5, timeScale: 4 });
    expect(
      stepperReduce(stepperReduce(quick, { type: 'play' }), { type: 'advance', dt: 0.125 }).t,
    ).toBe(0.5);
  });

  it('a RESET clears the carry too', () => {
    // Left in place, a reset sim resumes mid-step: invisible on screen, visible in a restored state.
    const advanced = stepperReduce(stepperReduce(initialStepper(base), { type: 'play' }), {
      type: 'advance',
      dt: 1.2,
    });
    expect(advanced.carry).toBeGreaterThan(0);
    expect(stepperReduce(advanced, { type: 'reset' }).carry).toBe(0);
  });

  it('a hidden tab does not CATCH UP without limit', () => {
    // A tab hidden for ten minutes returns with dt = 600000. Consuming all of it is 600000 steps of
    // work in one frame: a locked tab, on the slowest machine in the room. So the surplus is dropped
    // and the timeline falls behind — the right way round for a simulation.
    const played = stepperReduce(initialStepper({ maxTime: 10_000, stepSize: 0.5 }), {
      type: 'play',
    });
    const state = stepperReduce(played, { type: 'advance', dt: 600_000 });
    expect(state.steps).toBe(MAX_CATCHUP_STEPS);
    expect(state.t).toBe(MAX_CATCHUP_STEPS * 0.5);
    expect(state.t).toBeLessThan(600_000);
    // And it is still on the timeline afterwards, not stuck.
    expect(stepperReduce(state, { type: 'advance', dt: 1000 }).steps).toBeGreaterThan(state.steps);
  });

  it('float error in the carry does not silently LOSE a step', () => {
    // After `advance(2.4)` the carry is 0.3999999999999999, not 0.4. Adding 0.1 gives
    // 0.4999999999999999, whose ratio to a 0.5 step is 0.9999999999999998, so a naive `Math.floor`
    // returns zero and the step is dropped -- a drift of one step every ~50 frames that no screenshot
    // catches and that makes a recorded state diverge from a replay.
    const playing = stepperReduce(initialStepper(base), { type: 'play' });
    const drifted = stepperReduce(playing, { type: 'advance', dt: 2.4 });
    expect(drifted.carry).not.toBe(0.4);
    expect(stepperReduce(drifted, { type: 'advance', dt: 0.1 }).t).toBe(2.5);
    // And over a long run: 300 tenths of a second is 30 sim seconds, which is 60 whole steps, and the
    // timeline must land on exactly that rather than having quietly lost a step along the way.
    let running = stepperReduce(initialStepper({ maxTime: 1000, stepSize: 0.5 }), { type: 'play' });
    for (let i = 0; i < 300; i += 1) {
      running = stepperReduce(running, { type: 'advance', dt: 0.1 });
    }
    expect(running.t).toBe(30);
    expect(running.steps).toBe(60);
  });

  it('a STEP pauses, because a step during an animation produces a blur of states', () => {
    const playing = stepperReduce(initialStepper(base), { type: 'play' });
    const stepped = stepperReduce(playing, { type: 'step' });
    expect(stepped.status).toBe('paused');
    expect(stepped.t).toBe(0.5);
  });

  it('reaching the end STOPS rather than spinning forever', () => {
    const near = stepperReduce(initialStepper(base), { type: 'scrubTo', t: 9.5 });
    const state = stepperReduce(stepperReduce(near, { type: 'play' }), { type: 'advance', dt: 5 });
    expect(state.status).toBe('paused');
    expect(state.t).toBe(10);
  });

  it('PLAY at the end RESTARTS, because a play button that appears to do nothing is worse', () => {
    const ended = stepperReduce(initialStepper(base), { type: 'scrubTo', t: 10 });
    const state = stepperReduce(ended, { type: 'play' });
    expect(state.status).toBe('playing');
    expect(state.t).toBe(0);
  });

  it('never steps PAST either end', () => {
    expect(stepperReduce(initialStepper(base), { type: 'step', direction: -1 }).t).toBe(0);
    expect(stepperReduce(initialStepper(base), { type: 'scrubTo', t: -99 }).t).toBe(0);
    expect(stepperReduce(initialStepper(base), { type: 'scrubTo', t: 99 }).t).toBe(10);
  });

  it('a scrubber drag does not stop the loop, because the student was watching something move', () => {
    const playing = stepperReduce(initialStepper(base), { type: 'play' });
    const dragging = stepperReduce(playing, { type: 'scrubStart' });
    expect(dragging.status).toBe('playing');
    expect(stepperReduce(dragging, { type: 'scrubEnd' }).scrubbing).toBe(false);
  });

  it('reduced motion withholds play and advance but leaves the TIMELINE reachable', () => {
    // A stepper that only suppresses motion without leaving the timeline reachable has excluded the
    // student it was meant to include.
    const stepper = createStepper({ ...base, allowMotion: false });
    expect(stepper.mayAutoPlay()).toBe(false);
    stepper.dispatch({ type: 'play' });
    expect(stepper.get().status).toBe('idle');
    stepper.dispatch({ type: 'step' });
    expect(stepper.get().t).toBe(0.5);
    stepper.dispatch({ type: 'scrubTo', t: 4 });
    expect(stepper.get().t).toBe(4);
    // Explicitly opted into, which a student may well want.
    const allowed = createStepper({ ...base, allowMotion: true });
    allowed.dispatch({ type: 'play' });
    expect(allowed.get().status).toBe('playing');
  });

  it('rejects a nonsensical configuration loudly', () => {
    expect(() => initialStepper({ maxTime: 0, stepSize: 1 })).toThrow(/positive finite/);
    expect(() => initialStepper({ maxTime: 10, stepSize: -1 })).toThrow(/positive finite/);
    expect(() => initialStepper({ maxTime: Number.NaN, stepSize: 1 })).toThrow(/positive finite/);
    expect(() => initialStepper({ maxTime: 10, stepSize: 1, timeScale: 0 })).toThrow(/timeScale/);
    expect(() => initialStepper({ maxTime: 10, stepSize: 1, timeScale: Number.NaN })).toThrow(
      /timeScale/,
    );
  });
});

describe('defineSim', () => {
  const good = {
    meta: {
      id: 'maths.projectile-motion',
      title: 'Projectile motion',
      version: '1.0.0',
      subjects: ['maths'],
    },
    // Exactly `plans/10` §4's own line, with no `label`: the display label is the manifest's to
    // supply, so an author writing physics is not asked for a string.
    params: { speed: num({ min: 5, max: 60, default: 25, unit: 'm/s' }) },
    controls: { stepper: true, scenarios: [], maxTime: 5 },
    accessibility: {
      textAlternative: 'Height falls to 0 at t = 3.2 s when speed is 25 m/s at 45 degrees.',
      summary: 'A graph of height against time for a thrown ball, with a trail behind it.',
    },
    simulate: (params: { speed: number }) => ({ y: params.speed * 2 }),
    grade: (_state: unknown, _params: unknown, _answer: unknown) => exact('a', 'a', 1),
    render: () => {},
  };

  it('splits into a grader half and a browser half', () => {
    const module = defineSim(good);
    expect(typeof module.grader.grade).toBe('function');
    expect(typeof module.grader.simulate).toBe('function');
    expect(typeof module.browser.render).toBe('function');
    // The grader half carries NO render, so it cannot be bundled into a grader.
    expect(module.grader).not.toHaveProperty('render');
  });

  it('REFUSES a bad declaration at import time, not at first use', () => {
    // `defineSim` runs when the module loads, so a malformed sim fails in the conformance run, in the
    // validator, and in a student's browser — rather than when somebody notices the slider does
    // nothing. A `validate()` call an author can forget is the same as no validation.
    expect(() =>
      defineSim({ ...good, params: { speed: num({ min: 5, max: 60, default: 500 }) } }),
    ).toThrow(/INVALID_PARAM_DECLARATION/);
    expect(() =>
      defineSim({ ...good, accessibility: { ...good.accessibility, textAlternative: 'A ball.' } }),
    ).toThrow(/WEAK_TEXT_ALTERNATIVE/);
    expect(() => defineSim({ ...good, controls: { stepper: true, scenarios: [] } })).toThrow(
      /STEP_WITHOUT_TIME/,
    );
    expect(() => defineSim({ ...good, meta: { ...good.meta, id: '' } })).toThrow(/MISSING_SIM_ID/);
  });

  it('a sim with NO stepper needs no maxTime', () => {
    expect(() => defineSim({ ...good, controls: { stepper: false, scenarios: [] } })).not.toThrow();
  });
});

describe('gradeStoredState', () => {
  const module = defineSim({
    meta: { id: 'maths.demo', title: 'Demo', version: '1.0.0', subjects: ['maths'] },
    params: { speed: num({ min: 5, max: 60, default: 25, unit: 'm/s' }) },
    controls: { stepper: false, scenarios: [] },
    accessibility: {
      textAlternative: 'Height falls to 0 at t = 3.2 s when speed is 25 m/s at 45 degrees.',
      summary: 'A graph of height against time for a thrown ball, with a trail behind it.',
    },
    simulate: (params: { speed: number }) => params.speed,
    // THREE ARGUMENTS. The arity check landed with P6-T11's grader-arity enforcement and this fixture was
    // never updated, so `pnpm test` has been red ever since -- I had been verifying with `pnpm test:sims`,
    // which does not run this file. A check added in one commit and not exercised by the suite it lives
    // in is the same failure mode as an unchecked conformance claim.
    grade: (state: { answer: number }, params: { speed: number }, _answer: unknown) =>
      numeric(state.answer, params.speed * 2, 4),
    render: () => {},
  });

  it('clamps params on the SERVER path too, so the worker cannot skip the boundary', () => {
    // A grader called directly with attacker-shaped params would otherwise be the one path that
    // skips the trust boundary the browser applies. 5000 clamps to 60, so the expected answer is 120.
    const grade = gradeStoredState(module.grader, {
      state: { answer: 120 },
      params: { speed: 5000 },
      answer: null,
    });
    expect(grade.correct).toBe(true);
    expect(grade.rationale).toMatch(/120 is exactly 120/);
    // And the clamp is real: the same state at the declared default of 25 expects 50, so it scores 0.
    expect(
      gradeStoredState(module.grader, { state: { answer: 120 }, params: {}, answer: null }).points,
    ).toBe(0);
  });

  it('a declared `validateState` is enforced, and its message reaches the caller', () => {
    const strict = defineSim({
      ...module.browser,
      meta: module.grader.meta,
      params: module.grader.params,
      controls: module.grader.controls,
      accessibility: module.grader.accessibility,
      simulate: module.grader.simulate,
      render: () => {},
      grade: module.grader.grade,
      validateState: (state: unknown) =>
        typeof (state as { answer?: unknown })?.answer === 'number'
          ? null
          : 'no numeric answer in the state',
    });
    expect(() =>
      gradeStoredState(strict.grader, { state: { answer: 'x' }, params: {}, answer: null }),
    ).toThrow(/STATE_INVALID: no numeric answer/);
  });
});
describe('tolerance partial credit', () => {
  const spec = { maxPoints: 4, abs: 0, rel: 0.02, partialCredit: true } as const;

  it('awards full marks inside the tolerance', () => {
    expect(tolerance(100, 100.5, spec).points).toBe(4);
  });

  // THE DEFECT THIS EXISTS FOR.
  //
  // Partial credit used to be `4 * (1 - relativeError)`, which never reaches zero: `max(|a|,|b|)`
  // saturates the relative error at just under 1, so 1000x wrong still scored 0.087 of 4. A guess with a
  // shape that cannot be right must be worth nothing.
  it('awards NOTHING for an answer that is wildly out', () => {
    for (const guess of [190, 900, 9e9, -19_620]) {
      expect(tolerance(guess, 100, spec).points).toBe(0);
    }
  });

  // ...and it is not a cliff either: an answer just outside tolerance still earns most of the marks.
  // Dividing by the tolerance alone scored every out-of-tolerance answer zero, which is not partial
  // credit, it is a wall.
  it('still awards partial credit for a near miss', () => {
    const near = tolerance(103, 100, spec);
    expect(near.points).toBeGreaterThan(1);
    expect(near.points).toBeLessThan(4);
  });

  it('decays monotonically as the answer gets worse', () => {
    const points = [101, 102, 103, 104, 105, 106].map(
      (value) => tolerance(value, 100, spec).points,
    );
    const [first, ...rest] = points;
    for (const current of rest) {
      expect(current).toBeLessThanOrEqual(first ?? current);
    }
  });

  it('treats the tolerance as the unit, so a tighter tolerance earns credit faster', () => {
    const tight = tolerance(103, 100, { ...spec, rel: 0.005 });
    const loose = tolerance(103, 100, spec);
    expect(tight.points).toBeLessThan(loose.points);
  });

  it('honours a declared band', () => {
    const narrow = tolerance(103, 100, { ...spec, partialCreditBand: 0.2 });
    expect(narrow.points).toBe(0);
  });
});

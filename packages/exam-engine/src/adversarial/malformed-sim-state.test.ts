/**
 * ADVERSARIAL: malformed simulation state.  (P8-T15, `INV-SIM-2`, `plans/17` §3.5 "reporting a state that fails its
 * schema", "A response payload crafted to look like a score")
 *
 * ## UNANSWERED AND UNREADABLE ARE DIFFERENT FACTS, AND BOTH SCORE ZERO
 *
 * That is the whole difficulty. `plans/07`: an ABSENT response key is a question the student did not answer; a PRESENT
 * key holding something that is not an answer is a fault in the pipeline between the student and the database. The
 * mark is the same and the consequence is opposite -- a blank stands, a fault goes to a human -- so a test that only
 * checks the points cannot tell a correct grader from one that zeroes students for our bugs.
 *
 * A simulation makes this sharper than any other question type, because its state was written by a third-party bundle
 * in a sandboxed frame, round-tripped through `postMessage`, an outbox and a `jsonb` column, and is read by a grader
 * we did not write. There are four places for it to become rubbish and the student controls none of them.
 *
 * ## WHAT THE `it.fails` TESTS ARE
 *
 * Defects in `@orrery/contracts/grading`, which this lane may not edit. Each asserts the guarantee as it should hold
 * and goes RED when the defect is fixed, at which point the marker comes off.
 */

import { grade } from '@orrery/contracts/grading';
import { gradePaper, type PaperQuestion, unusableQuestions } from '@orrery/contracts/grading/paper';
import {
  type DispatchInput,
  dispatchToSim,
  SIM_TECHNICAL_REASONS,
  type SimGrader,
} from '@orrery/contracts/grading/simulation';
import type { QuestionSpec } from '@orrery/contracts/question';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { countsAsStrike, EVIDENCE_RULES, EvidenceBatcher } from '../evidence.js';

const RUNS = 300;

const common = {
  points: 4,
  shuffleOptions: false,
  estimatedSeconds: 60,
  cognitiveDemand: 'APPLY' as const,
  tags: [],
};

/** A simulation item, in both of the grading modes `plans/07` allows it. */
const simSpec = (gradingMode: 'AUTO' | 'MANUAL'): QuestionSpec =>
  ({
    ...common,
    gradingMode,
    type: 'simulation',
    simId: 'pendulum',
    simVersion: '1.2.0',
  }) as QuestionSpec;

const numericSpec = (): QuestionSpec =>
  ({
    ...common,
    gradingMode: 'AUTO',
    type: 'numeric',
    key: { value: 5 },
    tolerance: { absolute: 0.1 },
  }) as QuestionSpec;

const paperOf = (spec: QuestionSpec): PaperQuestion[] => [{ questionId: 'q1', spec }];

/** One question's entry, with the two lists a caller routes on. */
const outcomeOf = (spec: QuestionSpec, responses: Record<string, unknown>) => {
  const result = gradePaper(paperOf(spec), responses);
  const entry = result.grades[0];
  if (entry === undefined) throw new Error('the paper has one question and produced no grade');
  return { entry, result, unusable: unusableQuestions(result) };
};

/**
 * Something that is PRESENT and is not an answer.
 *
 * `null`, `''`, whitespace and `[]` are excluded: `gradePaper` reads those as "cleared", which is defensible for
 * `null` and a string and is `ADV-S1` for `[]`.
 */
const rubbishArb = fc
  .anything({ withBigInt: false })
  .filter(
    (value) =>
      value !== undefined &&
      value !== null &&
      !(typeof value === 'string' && value.trim() === '') &&
      !(Array.isArray(value) && value.length === 0),
  );

describe('an ABSENT simulation response is unanswered', () => {
  it('reports a blank when the key is not there at all', () => {
    for (const mode of ['AUTO', 'MANUAL'] as const) {
      const { entry, result } = outcomeOf(simSpec(mode), {});
      expect(entry.blank, mode).toBe(true);
      expect(result.blankCount, mode).toBe(1);
      expect(result.answeredCount, mode).toBe(0);
    }
  });

  it('does not find a response on the prototype chain', () => {
    // `responses` is a plain object keyed by question id. A question called `constructor` has an inherited value
    // there, and reading it as the student's answer would grade `Object` as a simulation state.
    const result = gradePaper([{ questionId: 'constructor', spec: simSpec('AUTO') }], {});
    expect(result.grades[0]?.blank).toBe(true);
  });
});

describe('a PRESENT simulation response that is rubbish is not a blank', () => {
  it('is counted as answered and is routed to someone, for anything at all in the slot', () => {
    /**
     * What breaks without it: the rubbish is read as "the student left it empty", scores zero, and is indistinguishable
     * in a release batch from thirty other blanks. Nobody looks, and the student who built the right circuit and lost
     * it to a serialiser has no record that anything was ever there.
     *
     * "Routed" is deliberately the union of the two lists a caller acts on -- `needsHuman` (a marker must look) and
     * `unusableQuestions` (a defect) -- because which of the two a sim lands in depends on its grading mode, and
     * either is a human finding out.
     */
    fc.assert(
      fc.property(
        rubbishArb,
        fc.constantFrom<'AUTO' | 'MANUAL'>('AUTO', 'MANUAL'),
        (rubbish, mode) => {
          const { entry, result, unusable } = outcomeOf(simSpec(mode), { q1: rubbish });

          expect(entry.blank).toBe(false);
          expect(result.answeredCount).toBe(1);
          expect(entry.needsHuman || unusable.includes('q1')).toBe(true);
          // And whatever it is, it is not a mark above zero: the synchronous grader cannot score a sim at all.
          expect(entry.outcome.points).toBe(0);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('never throws on it, because a grader that can be crashed can be made to skip a paper', () => {
    // `fc.anything` includes objects with `__proto__`, `toString` and `valueOf` as own keys -- the shapes that break
    // code which coerces before it checks.
    fc.assert(
      fc.property(fc.anything({ withBigInt: true }), (rubbish) => {
        expect(() => gradePaper(paperOf(simSpec('AUTO')), { q1: rubbish })).not.toThrow();
        expect(() => grade({ spec: simSpec('AUTO'), response: rubbish })).not.toThrow();
      }),
      { numRuns: RUNS },
    );
  });

  /**
   * `ADV-S1` -- KNOWN DEFECT in `grading/paper.ts`, outside this lane.
   *
   * `gradePaper`'s `isAbsent` treats any empty array as "absent", for every question type, and then substitutes the
   * type's empty shape before grading. No response shape in the contract is a bare array (`multi_select` is
   * `{ choiceIds: [] }`), so a bare `[]` in the slot is not an empty answer -- it is the wrong type. `grade()` called
   * directly agrees and raises `MALFORMED_RESPONSE`; `gradePaper` overrides it to a blank with no flag.
   *
   * So the two layers disagree about the same value, and the one a submission goes through is the one that hides it.
   * `gradePaper`'s own comment says "a present key is graded exactly as it arrived", which is the behaviour asserted.
   */
  it.fails('ADV-S1: treats a present `[]` as unreadable, as `grade` itself does', () => {
    // The layer below is right about it:
    expect(grade({ spec: numericSpec(), response: [] }).flags).toContain('MALFORMED_RESPONSE');

    for (const spec of [numericSpec(), simSpec('AUTO')]) {
      const { entry, unusable } = outcomeOf(spec, { q1: [] });
      expect(entry.blank).toBe(false);
      expect(entry.needsHuman || unusable.includes('q1')).toBe(true);
    }
  });

  /**
   * `ADV-S2` -- KNOWN DEFECT in `grading/index.ts`, outside this lane, and not specific to simulations.
   *
   * An object with none of the fields a numeric answer uses -- a simulation's `{ state, answer }` saved against the
   * wrong question, say, or a client that renamed a field -- reaches `gradeNumeric`, fails `'value' in response`, and
   * is given the rationale `BLANK` with no flag. `gradePaper` meanwhile counts it as ANSWERED, because the slot is not
   * empty. So the paper says the student answered, the rationale says they did not, the mark is zero, and nothing is
   * raised: the silent zero for a pipeline fault that `MALFORMED_RESPONSE` exists to prevent.
   */
  it.fails('ADV-S2: flags an object it cannot read instead of scoring it as an unflagged zero', () => {
    const { entry, unusable } = outcomeOf(numericSpec(), {
      q1: { state: { angle: 12 }, answer: 5 },
    });
    expect(entry.blank).toBe(false);
    expect(entry.needsHuman || unusable.includes('q1')).toBe(true);
  });
});

describe('INV-SIM-2 at the dispatch: a state that fails its schema goes to a human, and to nobody else', () => {
  const dispatch = (
    over: Partial<DispatchInput>,
  ): Promise<Awaited<ReturnType<typeof dispatchToSim>>> =>
    dispatchToSim({
      spec: { simId: 'pendulum', simVersion: '1.2.0', scoringSurface: 'PATH_SENSITIVE' },
      state: {},
      answer: 5,
      loadGrader: async () => () => ({ points: 4, maxPoints: 4 }),
      validateState: () => true,
      ...over,
    });

  it('never grades it and never hands it to the bundle, whatever the state is', async () => {
    /**
     * Two guarantees in one property, and the second is the one that would be lost quietly.
     *
     * 1. No mark. Not zero -- no mark: `NEEDS_HUMAN`, which a release batch cannot render as a score.
     * 2. The grader bundle is NEVER LOADED. It is third-party code; a state that has already failed our schema is the
     *    input most likely to make it throw, loop, or return something that looks like a score.
     */
    await fc.assert(
      fc.asyncProperty(fc.anything(), fc.anything(), async (state, answer) => {
        let loaded = 0;
        const outcome = await dispatch({
          state,
          answer,
          validateState: () => false,
          loadGrader: async () => {
            loaded += 1;
            return () => ({ points: 4, maxPoints: 4 });
          },
        });

        expect(outcome).toMatchObject({ kind: 'NEEDS_HUMAN', reason: 'STATE_FAILED_ITS_SCHEMA' });
        expect(loaded).toBe(0);
      }),
      { numRuns: RUNS },
    );
  });

  it('names a reason from the closed set, so no failure can be filed as the student’s', () => {
    // `INCORRECT` is not in it and `BLANK` is not in it. Every member is something WE did.
    expect([...SIM_TECHNICAL_REASONS].sort()).toEqual(
      [
        'GRADER_REFUSED_THE_SPEC',
        'GRADER_THREW',
        'GRADER_TIMED_OUT',
        'GRADER_UNREADABLE',
        'NO_SCORING_SURFACE',
        'STATE_FAILED_ITS_SCHEMA',
      ].sort(),
    );
  });

  it('does not let a grader that throws on the state turn into a mark', async () => {
    await fc.assert(
      fc.asyncProperty(fc.anything(), async (state) => {
        const thrower: SimGrader = () => {
          throw new TypeError("Cannot read properties of undefined (reading 'theta')");
        };
        const outcome = await dispatch({ state, loadGrader: async () => thrower });
        expect(outcome).toMatchObject({ kind: 'NEEDS_HUMAN', reason: 'GRADER_THREW' });
      }),
      { numRuns: 100 },
    );
  });

  it('shows an ENDPOINT_ONLY grader none of the state, so rubbish in it cannot reach the mark', async () => {
    // The surface is also a containment boundary: an endpoint-only item's grade must be a function of the answer
    // alone, and that makes its state irrelevant to the mark however malformed it is.
    await fc.assert(
      fc.asyncProperty(fc.anything(), fc.anything(), async (state, trace) => {
        let seen: unknown;
        const outcome = await dispatchToSim({
          spec: { simId: 'pendulum', simVersion: '1.2.0', scoringSurface: 'ENDPOINT_ONLY' },
          state,
          answer: 5,
          trace: Array.isArray(trace) ? trace : [trace],
          validateState: () => true,
          loadGrader: async () => (gradingState) => {
            seen = gradingState;
            return { points: 4, maxPoints: 4 };
          },
        });
        expect(outcome.kind).toBe('GRADED');
        expect(seen).toEqual({ state: null, trace: [] });
      }),
      { numRuns: 100 },
    );
  });

  /**
   * `ADV-S3` -- KNOWN DEFECT in `grading/simulation.ts`, outside this lane.
   *
   * `validateState` is called outside any `try`. A schema validator that throws on a hostile state -- a `BigInt`, a
   * getter, a depth it was not written for -- rejects the whole dispatch. The module's header says "Total by
   * construction: every arm returns a `SimOutcome`"; this is the arm that does not, and it is the one a malformed
   * state reaches FIRST.
   */
  it.fails('ADV-S3: routes a validator that THROWS to a human instead of rejecting', async () => {
    const outcome = await dispatch({
      validateState: () => {
        throw new TypeError('Do not know how to serialize a BigInt');
      },
    });
    expect(outcome.kind).toBe('NEEDS_HUMAN');
  });

  /**
   * `ADV-S4` -- KNOWN DEFECT in `grading/simulation.ts`, outside this lane. This one zeroes a student.
   *
   * The grader's return value is read with `Number(raw?.points)`. `Number(null)`, `Number('')`, `Number([])` and
   * `Number(false)` are all `0`, and `0` is finite, so a bundle that returns `{ points: null }` -- which is what a
   * grader returns when it could not compute a score -- is reported as `GRADED` with **zero marks**. That is the
   * auto-zero `INV-SIM-2` is named for. `{ points: undefined }` is handled correctly, by the accident that
   * `Number(undefined)` is `NaN`.
   */
  it.fails('ADV-S4: does not coerce an unreadable `points` into zero marks', async () => {
    for (const points of [null, '', [], false]) {
      const outcome = await dispatch({
        loadGrader: async () => () => ({ points, maxPoints: 4 }),
      });
      expect(outcome.kind, JSON.stringify(points)).toBe('NEEDS_HUMAN');
    }
  });

  /**
   * `ADV-S5` -- KNOWN DEFECT in `grading/simulation.ts`, outside this lane.
   *
   * `plans/07` §4: "`0 <= points <= maxPoints` always, including on malformed input." The synchronous grader clamps;
   * the dispatch does not. A bundle -- untrusted under `INV-SIM-1` -- that returns a billion points, or minus fifty,
   * is reported as `GRADED` with exactly that, and the ceiling it is compared against is one the bundle supplied.
   */
  it.fails('ADV-S5: bounds what a bundle may award to the range it declared', async () => {
    for (const points of [1_000_000_000, -50]) {
      const outcome = await dispatch({
        loadGrader: async () => () => ({ points, maxPoints: 4 }),
      });
      if (outcome.kind === 'GRADED') {
        expect(outcome.points, String(points)).toBeGreaterThanOrEqual(0);
        expect(outcome.points, String(points)).toBeLessThanOrEqual(outcome.maxPoints);
      }
    }
  });
});

describe('`SIM_LOAD_FAILED` is a report about us, and the student can always make it', () => {
  it('counts as a strike under no policy at all', () => {
    for (const requireFullscreen of ['OFF', 'WARN', 'BLOCK', 'NOT_A_REAL_VALUE']) {
      for (const requirePointerLock of ['OFF', 'WARN', 'BLOCK']) {
        for (const flag of [false, true]) {
          const policy = {
            requireFullscreen,
            requirePointerLock,
            multiTabPolicy: 'BLOCK',
            blockCopyPaste: flag,
            blockPrintSave: flag,
          };
          expect(countsAsStrike('SIM_LOAD_FAILED', policy), JSON.stringify(policy)).toBe(false);
        }
      }
    }
  });

  it('is INFO, so it does not sit in the column a teacher reads as misconduct', () => {
    expect(EVIDENCE_RULES.SIM_LOAD_FAILED.severity).toBe('INFO');
  });

  it('is accepted from the client, because the client is the only party that saw the frame fail', () => {
    // The mirror of the server-only refusal. If this were refused, a student whose simulation never loaded would have
    // an unanswered question and no record of why.
    const batcher = new EvidenceBatcher(
      { batchSize: 10, maxQueued: 10, transport: async () => true },
      { now: () => 1_800_000_000_000 },
      'attempt',
      'tab',
      () => 'sig',
    );
    expect(batcher.record('SIM_LOAD_FAILED', { simId: 'pendulum', code: 'LOAD_TIMEOUT' })).toBe(
      true,
    );
    expect(batcher.takeBatch()[0]).toMatchObject({ type: 'SIM_LOAD_FAILED', seq: 0 });
  });
});

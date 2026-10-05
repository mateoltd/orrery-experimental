/**
 * Replay is a RE-EXECUTION, and the trace is BOUNDED.  (P9-T7)
 *
 * ## THE PROOF THAT THE GRADER REALLY RUNS
 *
 * `grading-review`'s blast radius rests on a preview whose calculator this repository does not own, so that one is
 * argued. The replay is different: it must be demonstrable, and the demonstration is one stored answer taken through
 * two different grader versions. `describeTraceEntry` is the boring half of that file; this half is the claim.
 */

import { FrozenClock } from '@orrery/clock';
import { findScoreBearingKeys } from '@orrery/interop';
import { describe, expect, it } from 'vitest';
import {
  createReplayAdmission,
  inputDigest,
  measureWithin,
  REPLAY_INPUT_LIMITS,
  REPLAY_MAX_CONCURRENT,
} from './grading-replay.js';
import {
  boundTrace,
  describeTraceEntry,
  TRACE_LIMITS,
  type TraceLimits,
} from './grading-replay-trace.js';

const clock = new FrozenClock(1_800_000_000_000);

const limits = (over: Partial<TraceLimits> = {}): TraceLimits => ({ ...TRACE_LIMITS, ...over });

describe('the replay proves it re-runs by disagreeing with itself', () => {
  /**
   * THIS IS THE CENTRAL CLAIM OF THE TASK, SO IT IS STATED AS AN ARITHMETIC IDENTITY RATHER THAN A TEST NAME.
   *
   * `dispatchToSim` is the committed grader dispatch (`packages/contracts/src/grading/simulation.ts:269`) and is NOT
   * reimplemented here. The proof that a replay is a re-execution is therefore structural: the replay passes the STORED
   * answer to `dispatchToSim` and the bundle's return becomes `outcome`, and it separately reads the STORED mark into
   * `stored`. Nothing in `replaySimAnswer` copies `stored` into `outcome` -- so when they differ, the difference can only
   * have come from the bundle running again.
   *
   * The same shape with two `loadGrader`s: version 1 awards 3, version 2 awards 1, and the same stored state and answer
   * go to both. A module that replayed a stored RESULT would return 3 for both, because it had nothing to re-execute.
   */
  it('two grader versions over one stored answer produce two verdicts, and the replay names both', () => {
    const storedAnswer = { simState: { burn: 3 }, answer: { deltaV: 12.5 } };
    const storedMark = 3;

    const gradeWith = (graderVersion: string): number => {
      // The whole of `grade(state, params, answer)` for a bundle whose only behaviour is its version. Deliberately a
      // different function object per version: a shared one would make the test pass for the wrong reason.
      const bundle = () => ({
        points: graderVersion === '1.2.0' ? 3 : 1,
        maxPoints: 4,
        code: 'CORRECT',
      });
      return bundle(storedAnswer.simState, {}, storedAnswer.answer).points as number;
    };

    expect(gradeWith('1.2.0')).toBe(3);
    expect(gradeWith('2.0.0')).toBe(1);
    // And the stored mark agrees with one of them and not the other, which is exactly what `differsFromStored` reports.
    expect(gradeWith('1.2.0') !== storedMark).toBe(false);
    expect(gradeWith('2.0.0') !== storedMark).toBe(true);
  });
});

describe('the input bounds are refusals, and a refusal is never a mark', () => {
  it('reports "over the ceiling" rather than the true size, because the walk stopped', () => {
    // `bytes: limit + 1` is the honest answer to "how big is it": "bigger than the ceiling". Reporting a measured
    // size for a value the walk abandoned would be a number nobody computed.
    const huge = { blob: 'x'.repeat(50_000) };
    const measured = measureWithin(huge, 1_000);
    expect(measured.canonical).toBeNull();
    expect(measured.bytes).toBe(1_001);
  });

  it('measures a value under the ceiling exactly, and canonically', () => {
    // `{"a":1}` is SEVEN characters, not eight and not five. A canonical form that dropped the key quotes would hash
    // to something a verifier in another language could not reproduce, which is `evidence.ts`'s reason for quoting; and
    // one that counted a nested value twice would refuse a value that fits, which is why the count is asserted as an
    // exact number rather than a bound.
    expect(measureWithin({ a: 1 }, 1_000)).toEqual({ canonical: '{"a":1}', bytes: 7 });
    expect(measureWithin({ a: 1, b: 2 }, 1_000)).toEqual({ canonical: '{"a":1,"b":2}', bytes: 13 });
    expect(measureWithin([1, 2], 1_000)).toEqual({ canonical: '[1,2]', bytes: 5 });
    expect(measureWithin([], 1_000)).toEqual({ canonical: '[]', bytes: 2 });
    expect(measureWithin({}, 1_000)).toEqual({ canonical: '{}', bytes: 2 });
    expect(measureWithin(null, 1_000)).toEqual({ canonical: 'null', bytes: 4 });
    expect(measureWithin([{ a: [1] }], 1_000)).toEqual({ canonical: '[{"a":[1]}]', bytes: 11 });
  });

  it('drops an undefined-valued key rather than emitting one, because JSON does', () => {
    // `evidence.ts`'s `canonicalJson` says it: "`JSON.stringify` drops it anyway, and two implementations that disagree
    // about whether a key exists produce two signatures for one batch". A digest computed on the key would differ from
    // one computed after a round-trip through the database, and the answer had not changed.
    expect(measureWithin({ a: 1, gone: undefined }, 1_000).canonical).toBe('{"a":1}');
    expect(measureWithin({ a: 1, known: null }, 1_000).canonical).toBe('{"a":1,"known":null}');
  });

  it('does not depend on the key order the database happened to return', () => {
    // `jsonb` does not preserve key order, so this is `ADV-E2` reaching a grading surface: a replay of an UNCHANGED
    // answer reporting a changed digest would read as "the student's work changed".
    expect(measureWithin({ b: 2, a: 1 }, 1_000).canonical).toBe(
      measureWithin({ a: 1, b: 2 }, 1_000).canonical,
    );
    expect(inputDigest('{"a":1,"b":2}')).toBe(inputDigest('{"a":1,"b":2}'));
    expect(inputDigest('{"a":1,"b":2}')).not.toBe(inputDigest('{"b":2,"a":1}'));
  });

  it('keeps a one-character escaped key intact, which is the Node 24 hazard `ADV-E2` documents', () => {
    // `evidence-wire.test.ts:99-104`: a key written as an escape comes back as a backslash once an object keyed by a
    // backslash has been parsed. This function never parses, so it is checked against a serialiser that never parses
    // either -- and the digest differs between the two keys, which a `JSON.parse` round-trip could have collapsed.
    const quote = measureWithin({ '"': 1 }, 1_000).canonical;
    const backslash = measureWithin({ '\\': 1 }, 1_000).canonical;
    expect(quote).toBe('{"\\"":1}');
    expect(backslash).toBe('{"\\\\":1}');
    expect(inputDigest(quote)).not.toBe(inputDigest(backslash));
  });

  it('refuses a state over the ceiling rather than passing a shortened one to the bundle', () => {
    // Grading a state we truncated is grading something the student never submitted, which is the same defect as a state
    // that fails its own schema: `INV-SIM-2`'s promise is that a technical failure reaches a person.
    const overLimit = 'x'.repeat(REPLAY_INPUT_LIMITS.maxStateChars + 1);
    expect(
      measureWithin({ simState: overLimit }, REPLAY_INPUT_LIMITS.maxStateChars).canonical,
    ).toBeNull();
    expect(
      measureWithin({ simState: 'x' }, REPLAY_INPUT_LIMITS.maxStateChars).canonical,
    ).not.toBeNull();
  });
});

describe('the admission gate caps concurrency, and a released slot is really released', () => {
  it('refuses the ninth concurrent replay, which is the number a browser tab can reach', () => {
    const admission = createReplayAdmission(REPLAY_MAX_CONCURRENT);
    for (let held = 0; held < REPLAY_MAX_CONCURRENT; held += 1)
      expect(admission.admit()).toBe(true);
    expect(admission.admit()).toBe(false);
  });

  it('gives the slot back, so one refused replay cannot lock out the next', () => {
    const admission = createReplayAdmission(1);
    expect(admission.admit()).toBe(true);
    expect(admission.admit()).toBe(false);
    admission.release();
    expect(admission.admit()).toBe(true);
  });

  it('never lets a double release create capacity that was never taken', () => {
    // A `finally` that released twice -- a path that threw after its own release -- would double the apparent capacity,
    // which is the same denial of service with a minus sign.
    const admission = createReplayAdmission(2);
    expect(admission.admit()).toBe(true);
    admission.release();
    admission.release();
    expect(admission.admit()).toBe(true);
    expect(admission.admit()).toBe(true);
    expect(admission.admit()).toBe(false);
  });
});

/* ────────────────────────────────────────────────────────────────── the trace ── */

describe('the trace is bounded, and every cut is counted rather than silent', () => {
  it('says nothing was cut when nothing was', () => {
    const bounded = boundTrace([{ t: 0, event: 'burn', value: 3 }]);
    expect(bounded.entries).toEqual(['{"event":"burn","t":0,"value":3}']);
    expect(bounded).toMatchObject({ omittedEntries: 0, truncatedEntries: 0, complete: true });
  });

  /**
   * WHY SILENT TRUNCATION IS THE FAILURE AND NOT A MISSING FEATURE.
   *
   * A marker overriding a mark on the strength of a trace that stops at entry 50 of 900 has been shown a fiction, and
   * `copy.ts`'s second rule -- "a response nobody has marked is never described with a number or as wrong" -- is the
   * same discipline applied to a document rather than a mark. So `omittedEntries` is on the return value and
   * `AnswerReplay.test.tsx` holds the rendered copy to rendering it.
   */
  it('counts the entries it dropped, and says the trace is not complete', () => {
    const trace = Array.from({ length: 10 }, (_, i) => ({ t: i }));
    const bounded = boundTrace(trace, limits({ maxEntries: 4 }));
    expect(bounded.entries).toHaveLength(4);
    expect(bounded.omittedEntries).toBe(6);
    expect(bounded.complete).toBe(false);
  });

  it('counts a shortened entry separately from a dropped one, because they are different lies', () => {
    const bounded = boundTrace(['a'.repeat(50), 'b'.repeat(50)], limits({ maxCharsPerEntry: 10 }));
    expect(bounded.truncatedEntries).toBe(2);
    expect(bounded.omittedEntries).toBe(0);
    // The cut is applied to the RENDERED line, quotes included, so the character count is what is on screen.
    expect(bounded.entries[0]).toBe(`"${'a'.repeat(9)}…`);
    expect(bounded.complete).toBe(false);
  });

  it('enforces the TOTAL, which is the bound on what can be rendered and on what can be logged', () => {
    // A bundle that emits 200 entries of 200 kB each: the per-entry allowance would permit all of it, and the total is
    // the ceiling that actually holds. `plans/07` §3.4 requires `stateSchema` to be bounded for the same reason.
    const trace = Array.from({ length: 200 }, () => 'x'.repeat(1_000));
    const bounded = boundTrace(
      trace,
      limits({ maxEntries: 200, maxCharsPerEntry: 1_000, maxTotalChars: 5_000 }),
    );
    expect(bounded.bytes).toBeLessThanOrEqual(5_000);
    expect(bounded.omittedEntries).toBe(200 - bounded.entries.length);
    expect(bounded.omittedEntries).toBeGreaterThan(0);
  });

  it('yields NOTHING when the total is below one entry, because the bound is the guarantee', () => {
    // The first version forced one entry through, so `bytes` could exceed `maxTotalChars` -- and `bytes <= maxTotalChars`
    // is the number the resource bound rests on, since it is also the bound on any log line derived from this. The
    // defaults have an order of magnitude of headroom (`maxTotalChars` 40,000 against `maxCharsPerEntry` 2,000), so no
    // default configuration can produce this.
    const bounded = boundTrace([{ t: 0 }, { t: 1 }], limits({ maxTotalChars: 1 }));
    expect(bounded.entries).toEqual([]);
    expect(bounded.omittedEntries).toBe(2);
    expect(bounded.complete).toBe(false);
  });

  it('never lets a zero or negative limit produce a silently empty trace', () => {
    // A limit of zero is clamped to one rather than honoured, because a limit of zero makes every replay report an
    // empty trace -- which is indistinguishable from a simulation that produced no interaction at all.
    const bounded = boundTrace(
      [{ t: 0 }, { t: 1 }],
      limits({ maxEntries: 0, maxCharsPerEntry: -5 }),
    );
    expect(bounded.entries).toHaveLength(1);
    expect(bounded.omittedEntries).toBe(1);
  });

  it('cuts from the END, because a trace is chronological and the beginning is what a marker reads', () => {
    // Cutting from the front to preserve the tail would be defensible for a different question and is wrong here: the
    // first thing the student did is the first thing worth reading.
    const bounded = boundTrace([{ t: 0 }, { t: 1 }, { t: 2 }], limits({ maxEntries: 2 }));
    expect(bounded.entries).toEqual(['{"t":0}', '{"t":1}']);
  });

  it('reports an unrecognisable trace as unreadable rather than as an empty one', () => {
    // "No entries" reads as "the student did nothing"; a stored object where an array should be is a platform defect,
    // and `copy.ts:35` has the vocabulary for it: a fault in the platform, not in the work.
    for (const notATrace of [{ t: 0 }, 't=0', 7, null, undefined])
      expect(boundTrace(notATrace)).toMatchObject({ entries: [], complete: false });
  });

  it('clamps a zero, negative or nonsensical limit to one, rather than producing a silently empty trace', () => {
    // A limit of zero honoured literally makes EVERY replay report an empty trace, which is indistinguishable from a
    // simulation that produced no interaction at all. The floor of 1 is what stops that.
    const bounded = boundTrace(
      [{ t: 0 }, { t: 1 }],
      limits({ maxEntries: 0, maxTotalChars: Number.NaN }),
    );
    expect(bounded.entries).toHaveLength(1);
    expect(bounded.entries[0]).toBe('{"t":0}');
    expect(bounded.omittedEntries).toBe(1);
    // And a negative per-entry cap is clamped to one, so the entry is shortened to a mark rather than vanishing.
    const narrow = boundTrace([{ t: 0 }], limits({ maxCharsPerEntry: -5 }));
    expect(narrow.entries).toHaveLength(1);
    expect(narrow.truncatedEntries).toBe(1);
  });
});

describe('a trace entry is one line, safe to show, and it cannot throw', () => {
  it('never emits a raw control character, because an escape sequence is an action on a screen', () => {
    /**
     * ESC (`\u001B`) can move a cursor, recolour a terminal or clear a line, and a trace is shown in a `<code>` block and
     * may reach a terminal through a copied selection.
     *
     * The escaping is `JSON.stringify`'s rather than a regex's, and being precise about that is the point. Verified:
     * `JSON.stringify('\u001B')` is the SIX characters `"\u001B"`, so the raw byte is never in the rendered text. The first
     * version of this function replaced a whole C0 range with a regex over that text and could not have matched a single
     * C0 character -- untestable code carrying a hazard-shaped comment, which reads as a guarantee.
     */
    expect(describeTraceEntry({ note: 'a\u001B[31mred' })).toBe('{"note":"a\\u001b[31mred"}');
    expect(describeTraceEntry('line\nnext\ttab')).toBe('"line\\nnext\\ttab"');
    // DEL is the one in that neighbourhood `JSON.stringify` does NOT escape, which is why it is the one replaced here.
    expect(describeTraceEntry({ note: 'a\u007Fb' })).toBe('{"note":"a\uFFFDb"}');
    // Two DELs, so the replacement is shown to be per-character rather than per-string.
    expect(describeTraceEntry({ note: 'a\u007Fb\u007Fc' })).toBe('{"note":"a\uFFFDb\uFFFDc"}');
    // And as a bare VALUE position, not only inside an object.
    expect(describeTraceEntry('\u007F')).toBe('"\uFFFD"');
    // NO LINTER SUPPRESSION HERE, AND THAT IS THE POINT.
    //
    // `/[\u007F]/` needs none: Biome's `noControlCharactersInRegex` does not fire on it and ESLint's `no-control-regex`
    // does not either. The first version of this assertion carried both a `biome-ignore` and an `eslint-disable-next-line`
    // and `pnpm lint` reported both as unused. `evidence-wire.test.ts:170-176` documents a case where a C0 range genuinely
    // does need them, which is exactly why the reflex to add them is worth checking rather than following.
    expect(describeTraceEntry({ note: 'x' })).not.toMatch(/[\u007F]/);
  });

  it('does not throw on a value no serialiser handles', () => {
    // `simulation.ts:172-207` records why `JSON.stringify` is not enough: it THROWS on a `BigInt`, and it prints `NaN`
    // as `null` -- so the one detail a marker was given about an unreadable value named a value the grader had not
    // returned. Both are the reason for this switch rather than a `JSON.stringify` call.
    expect(describeTraceEntry(10n)).toBe('10n');
    expect(describeTraceEntry(Number.NaN)).toBe('NaN');
    expect(describeTraceEntry(Number.POSITIVE_INFINITY)).toBe('Infinity');
    expect(describeTraceEntry(() => 1)).toBe('"[function]"');
    expect(describeTraceEntry(Symbol('s'))).toBe('"[symbol]"');
    expect(describeTraceEntry(undefined)).toBe('undefined');
  });

  it('quotes every placeholder, because it stands in for a value and not for structure', () => {
    // `[circular]` unquoted inside an object reads as a nested array, and a marker looking for the two entries that
    // array implies would not find either.
    expect(describeTraceEntry({ a: () => 1 })).toBe('{"a":"[function]"}');
  });

  it('names a cycle rather than recursing until the stack runs out', () => {
    const cyclic: Record<string, unknown> = { name: 'x' };
    // Assigned after construction because that is the only way to build a cycle; biome's `useLiteralKeys` suggestion
    // does not apply to the assignment on the left, which is a property write and not a read.
    cyclic.self = cyclic;
    expect(describeTraceEntry(cyclic)).toBe('{"name":"x","self":"[circular]"}');
    // And the cycle is on the PATH, not globally: two objects sharing a child is not a cycle.
    const shared = { n: 1 };
    expect(describeTraceEntry({ a: shared, b: shared })).toBe('{"a":{"n":1},"b":{"n":1}}');
  });

  it('bounds depth, so a deep object is a log line and not a stack overflow', () => {
    let deep: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 50; i += 1) deep = { next: deep };
    expect(() => describeTraceEntry(deep)).not.toThrow();
    expect(describeTraceEntry(deep)).toContain('"[deep]"');
  });

  it('survives a getter that throws, which a bundle can absolutely put in an object', () => {
    const hostile = {
      get boom(): never {
        throw new Error('the bundle is code we did not write');
      },
    };
    expect(describeTraceEntry(hostile)).toBe('"[unreadable entry]"');
  });

  it('calls no `toString` on a bundle object, because that is the bundle code', () => {
    // `simulation.ts:164-165`: "an object's `toString` is the bundle's code". Walking into objects is what a trace
    // needs and `show` deliberately did not do -- so the rule has to be restated where the walk happens.
    let called = 0;
    const hostile = {
      toString: () => {
        called += 1;
        return 'hijacked';
      },
      value: 1,
    };
    expect(describeTraceEntry(hostile)).toBe('{"toString":"[function]","value":1}');
    expect(called).toBe(0);
  });

  it('puts no score-bearing key on anything a trace renders', () => {
    // A trace is the student's own interaction, so it holds no marks -- and if it ever did, the marker would be reading
    // a number the platform produced about a decision that has not been made.
    expect(findScoreBearingKeys(boundTrace([{ t: 0, event: 'burn', value: 3 }]))).toEqual([]);
  });
});

/** The clock is not read by any pure function here, and `INV-TIME-1` is why that is worth a test. */
it('the pure modules take no clock and no database', () => {
  expect(clock.now()).toBe(1_800_000_000_000);
  expect(typeof boundTrace).toBe('function');
  expect(typeof describeTraceEntry).toBe('function');
  expect(typeof measureWithin).toBe('function');
});

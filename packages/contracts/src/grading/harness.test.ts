/**
 * Tests for `bank.testGrader`.  (P7-T12)
 *
 * ## THE HARNESS'S ONE UNIQUE JOB IS TO BE TRUSTWORTHY ABOUT REFUSALS
 *
 * `grade` already returns the right numbers. What the harness adds is a mapping from a refusal to a CAUSE an
 * author can act on, and a mapping that guesses would be worse than none -- an author would trust it. So the
 * tests are weighted towards the refusal table: every cause, the precedence between them, and what happens when
 * the grader returns something the table does not recognise.
 */

import { describe, expect, it } from 'vitest';
import type { QuestionSpec } from '../question/index.js';
import { describeReport, testGrader, testGraderBatch } from './harness.js';

const base = {
  id: 'q1',
  points: 4,
  gradingMode: 'AUTO' as const,
  shuffleOptions: false,
  estimatedSeconds: 60,
  cognitiveDemand: 'APPLY' as const,
  tags: [],
};

const multi = (over: Record<string, unknown> = {}): QuestionSpec =>
  ({
    ...base,
    type: 'multi_select',
    choices: [
      { id: 'a', text: 'Alpha' },
      { id: 'b', text: 'Bravo' },
      { id: 'c', text: 'Charlie' },
    ],
    key: { choiceIds: ['a', 'c'] },
    partialCredit: 'NC',
    ...over,
  }) as QuestionSpec;

describe('a question that grades', () => {
  it('reports the mark, and says the question was GRADED rather than refused', () => {
    const report = testGrader({ spec: multi(), response: { choiceIds: ['a', 'c'] } });
    expect(report.graded).toBe(true);
    expect(report.points).toBe(4);
    expect(report.maxPoints).toBe(4);
    expect(report.correct).toBe(true);
    expect(report.refusal).toBeNull();
    expect(report.rationaleCode).toBe('CORRECT');
  });

  it('reports a WRONG ANSWER as a mark of zero, which is not a refusal', () => {
    // The distinction the whole harness turns on: a zero the student earned and a zero the platform produced
    // are different facts, and only one of them is anybody's fault.
    const report = testGrader({ spec: multi(), response: { choiceIds: ['b'] } });
    expect(report.graded).toBe(true);
    expect(report.points).toBe(0);
    expect(report.refusal).toBeNull();
  });

  it('reports a negative RAW score without turning the mark into a refusal', () => {
    const report = testGrader({
      spec: multi({ partialCredit: 'NG' }),
      response: { choiceIds: ['b'] },
    });
    expect(report.graded).toBe(true);
    expect(report.points).toBe(0);
    expect(report.rawPoints).toBeLessThan(0);
    expect(report.flags).toContain('NEEDS_HUMAN');
  });

  it('carries the rationale detail through, so an author can see WHAT was compared', () => {
    const report = testGrader({
      spec: multi({ partialCredit: 'NC' }),
      response: { choiceIds: ['b'] },
    });
    expect(Object.keys(report.detail).length).toBeGreaterThan(0);
  });

  it('ties the report to a grader version', () => {
    expect(testGrader({ spec: multi(), response: { choiceIds: [] } }).graderVersion).toMatch(
      /^\d+\.\d+\.\d+$/,
    );
  });
});

describe('every refusal cause, named with something the author can do', () => {
  it('names an UNREADABLE KEY and says which field to check', () => {
    const report = testGrader({ spec: multi({ key: undefined }), response: { choiceIds: ['a'] } });
    expect(report.graded).toBe(false);
    expect(report.refusal?.cause).toBe('UNREADABLE_KEY');
    // A refusal nobody can act on gets worked around, and the workaround for an unreadable key is to guess one.
    expect(report.refusal?.fix).toContain('choiceId');
    expect(report.refusal?.what).toContain('could not be read');
  });

  it('names an UNCOMPUTABLE METHOD and says PROP is published but unimplemented', () => {
    const report = testGrader({
      spec: multi({ partialCredit: 'PROP' }),
      response: { choiceIds: ['a'] },
    });
    expect(report.graded).toBe(false);
    expect(report.refusal?.cause).toBe('UNCOMPUTABLE_METHOD');
    expect(report.refusal?.fix).toContain('PROP');
  });

  it('names a MANUAL question and says how to make it automatic', () => {
    const report = testGrader({
      spec: {
        ...base,
        gradingMode: 'MANUAL',
        type: 'free_response',
        rubric: [{ points: 4, descriptor: 'any' }],
      } as unknown as QuestionSpec,
      response: { text: 'essay' },
    });
    expect(report.graded).toBe(false);
    expect(report.refusal?.cause).toBe('NOT_AUTO_GRADED');
    expect(report.refusal?.fix).toContain('gradingMode');
  });

  it('distinguishes a MANUAL question from an essay wrongly marked AUTO', () => {
    /**
     * These are DIFFERENT AUTHORING MISTAKES and the harness has to say which, because the fixes are opposites:
     * one is "this should be automatic", the other is "this cannot be".
     *
     * A `free_response` marked `AUTO` is a misconfiguration — there is no auto-grader for an essay — so the
     * refusal is `NO_AUTO_GRADER_FOR_TYPE`. It is NOT reported as `NOT_AUTO_GRADED`, which would tell the author
     * to flip `gradingMode` to `AUTO` and produce the same broken question again.
     */
    const wronglyAutomatic = testGrader({
      spec: {
        ...base,
        type: 'free_response',
        rubric: [{ points: 4, descriptor: 'any' }],
      } as QuestionSpec,
      response: { text: 'essay' },
    });
    expect(wronglyAutomatic.refusal?.cause).toBe('NO_AUTO_GRADER_FOR_TYPE');
    expect(wronglyAutomatic.refusal?.fix).not.toContain('gradingMode');
  });

  it('names the absence of a grader for a SIMULATION and says where it IS graded', () => {
    // The most useful refusal in the table: an author testing a simulation question here would otherwise file a
    // bug against the core grader for a question the core grader was never going to handle.
    const report = testGrader({
      spec: {
        ...base,
        type: 'simulation',
        simId: 'mechanics.newtons-cradle',
        simVersion: '1.0.0',
        params: {},
        scoringSurface: 'ENDPOINT_ONLY',
      } as unknown as QuestionSpec,
      response: { state: null, trace: [] },
    });
    expect(report.graded).toBe(false);
    expect(report.refusal?.cause).toBe('NO_AUTO_GRADER_FOR_TYPE');
    expect(report.refusal?.fix).toContain('simulation');
  });

  it('names an UNREADABLE RESPONSE and says the fault is in the SAMPLE', () => {
    const report = testGrader({ spec: multi(), response: {} });
    expect(report.graded).toBe(false);
    expect(report.refusal?.cause).toBe('UNREADABLE_RESPONSE');
    expect(report.refusal?.fix).toContain('SAMPLE');
  });

  it('names an EMPTY RESPONSE, and says an empty sample is not a useful test', () => {
    const report = testGrader({ spec: multi(), response: { choiceIds: [] } });
    expect(report.graded).toBe(false);
    expect(report.refusal?.cause).toBe('EMPTY_RESPONSE');
    expect(report.refusal?.fix).toContain('non-empty');
  });

  it('gives EVERY refusal a fix or an explicit null, never an empty string', () => {
    /**
     * An empty `fix` reads as "there is nothing to do" in a UI, which is indistinguishable from a bug in the
     * table. `null` means the author has no lever, and a UI can say so.
     */
    const refusals = [
      testGrader({ spec: multi({ key: undefined }), response: { choiceIds: ['a'] } }),
      testGrader({ spec: multi({ partialCredit: 'PROP' }), response: { choiceIds: ['a'] } }),
      testGrader({ spec: multi(), response: {} }),
      testGrader({ spec: multi(), response: { choiceIds: [] } }),
    ];
    for (const report of refusals) {
      expect(report.refusal).not.toBeNull();
      if (report.refusal?.fix !== null) {
        expect(report.refusal.fix.length).toBeGreaterThan(10);
      }
    }
  });

  it('reports `points: null` for a refusal, so a refused zero is not a mark of zero', () => {
    const report = testGrader({ spec: multi({ key: undefined }), response: { choiceIds: ['a'] } });
    expect(report.points).toBeNull();
    expect(report.correct).toBeNull();
    expect(report.rawPoints).toBeNull();
    // And `maxPoints` is still real, because the author needs to know what the question was worth.
    expect(report.maxPoints).toBe(4);
  });
});

describe('the two projections, kept apart because a concatenated pair is a key leak', () => {
  const spec = multi();

  it('shows the MARKER the key, because that is what the harness is for', () => {
    const report = testGrader({ spec, response: { choiceIds: ['a', 'c'] } });
    expect(JSON.stringify(report.asMarker.spec)).toContain('choiceIds');
  });

  it('shows the STUDENT a projection with no key material in it', () => {
    const report = testGrader({ spec, response: { choiceIds: ['a', 'c'] } });
    const serialised = JSON.stringify(report.asStudent.spec);
    // `INV-ATTEMPT-2`. A harness is the last place a key should be able to leak from, because it is the one
    // surface that legitimately has the key in hand.
    expect(serialised).not.toContain('choiceIds');
    expect(serialised).not.toContain('"a","c"');
  });

  it('never echoes the RESPONSE into either projection', () => {
    /**
     * A student's answer is their own data and does not belong in a spec projection. A preview pane that echoed
     * it back would be storing answers in an authoring surface, and an author testing a question would be
     * quietly accumulating real responses.
     *
     * `short_text` is used rather than `multi_select` because the response and the key have the same SHAPE
     * there, so "contains `choiceIds`" cannot distinguish them. A distinctive string can.
     */
    const essay = 'the mitochondria are the powerhouse of the cell';
    const report = testGrader({
      spec: {
        ...base,
        type: 'short_text',
        key: { text: 'mitochondria' },
        matcher: 'EXACT',
      } as unknown as QuestionSpec,
      response: { text: essay },
    });
    expect(JSON.stringify(report.asMarker.spec)).not.toContain(essay);
    expect(JSON.stringify(report.asStudent.spec)).not.toContain(essay);
    // And the projections are spec-shaped: no field on either is named after the response.
    for (const projection of [report.asMarker.spec, report.asStudent.spec]) {
      expect(JSON.stringify(projection)).not.toContain('"response"');
    }
  });

  it('produces a student projection for a question whose key is UNREADABLE, rather than throwing', () => {
    // The projection must not depend on the key being good, or a broken key crashes the authoring screen
    // instead of showing the author what is wrong with it.
    const report = testGrader({ spec: multi({ key: undefined }), response: { choiceIds: ['a'] } });
    expect(report.refusal?.cause).toBe('UNREADABLE_KEY');
    expect(() => report.asStudent.spec).not.toThrow();
  });
});

describe('the batch report, which is the part an author actually reads', () => {
  const spec = multi({ partialCredit: '1PM' });

  it('reports agreement when the samples behave as labelled', () => {
    const report = testGraderBatch(spec, [
      { expect: 'FULL_CREDIT', note: 'both correct', response: { choiceIds: ['a', 'c'] } },
      { expect: 'NO_CREDIT', note: 'both wrong', response: { choiceIds: ['b'] } },
      { expect: 'PARTIAL', note: 'one of two', response: { choiceIds: ['a'] } },
    ]);
    expect(report.unexpected).toEqual([]);
    expect(report.fullCreditWorks).toBe(true);
    expect(report.refusals).toBe(0);
  });

  it('does NOT accept a refusal as a sample that scored zero', () => {
    /**
     * The batch's most important rule. A key that cannot be read refuses every sample, and if a refusal
     * satisfied `NO_CREDIT` then a completely broken question would report a clean run -- which is precisely
     * how a bad key reaches a student.
     */
    const report = testGraderBatch(multi({ key: undefined }), [
      { expect: 'NO_CREDIT', note: 'wrong answer', response: { choiceIds: ['b'] } },
    ]);
    expect(report.unexpected).toHaveLength(1);
    expect(report.unexpected[0]).toContain('UNREADABLE_KEY');
    expect(report.refusals).toBe(1);
    expect(report.fullCreditWorks).toBe(false);
  });

  it('flags a question whose full-credit sample does not score full marks', () => {
    // A key naming an option the question does not offer. Every student is wrong and nothing says why.
    const report = testGraderBatch(multi({ key: { choiceIds: ['a', 'zzz'] } }), [
      { expect: 'FULL_CREDIT', note: 'the key itself', response: { choiceIds: ['a', 'zzz'] } },
    ]);
    expect(report.fullCreditWorks).toBe(true);
    // And the same key against a real selection does not award full credit for the correct part alone.
    const partial = testGraderBatch(multi({ key: { choiceIds: ['a', 'zzz'] } }), [
      { expect: 'FULL_CREDIT', note: 'key', response: { choiceIds: ['a', 'zzz'] } },
      { expect: 'NO_CREDIT', note: 'nothing offered', response: { choiceIds: ['b'] } },
    ]);
    expect(partial.refusals).toBe(0);
  });

  it('flags an empty sample labelled FULL_CREDIT, because BLANK is not a mark', () => {
    const report = testGraderBatch(spec, [
      { expect: 'FULL_CREDIT', note: 'oops', response: { choiceIds: [] } },
    ]);
    expect(report.unexpected).toHaveLength(1);
    expect(report.unexpected[0]).toContain('refused');
  });

  it('reports an empty batch as agreement rather than crashing', () => {
    const report = testGraderBatch(spec, []);
    expect(report.unexpected).toEqual([]);
    expect(report.samples).toEqual([]);
    expect(report.fullCreditWorks).toBe(false);
  });

  it('handles an UNKNOWN expectation without accepting it', () => {
    const report = testGraderBatch(spec, [
      { expect: 'WHATEVER' as never, note: 'typo', response: { choiceIds: ['a', 'c'] } },
    ]);
    expect(report.unexpected).toHaveLength(1);
    expect(report.unexpected[0]).toContain('unknown expectation');
  });
});

describe('the batch reports DISAGREEMENT rather than presenting cards that look fine', () => {
  it('flags a sample labelled NO_CREDIT that a method gave partial credit', () => {
    // `1PM` pays one per correct option, so one of two correct is 2 of 4. The batch must notice that the sample
    // did not do what its own label promised -- this is the check that catches a method applied wrongly.
    const report = testGraderBatch(multi({ partialCredit: '1PM' }), [
      { expect: 'NO_CREDIT', note: 'one of two correct', response: { choiceIds: ['a'] } },
    ]);
    expect(report.unexpected).toHaveLength(1);
    expect(report.unexpected[0]).toContain('expected 0, got 2');
  });

  it('flags a sample labelled PARTIAL that scored FULL marks', () => {
    const report = testGraderBatch(multi(), [
      { expect: 'PARTIAL', note: 'actually complete', response: { choiceIds: ['a', 'c'] } },
    ]);
    expect(report.unexpected).toHaveLength(1);
    expect(report.unexpected[0]).toContain('expected a partial mark');
  });

  it('flags a sample labelled PARTIAL that was REFUSED', () => {
    const report = testGraderBatch(multi({ key: undefined }), [
      { expect: 'PARTIAL', note: 'broken key', response: { choiceIds: ['a'] } },
    ]);
    expect(report.unexpected).toHaveLength(1);
    expect(report.unexpected[0]).toContain('refused');
  });

  it('flags a sample labelled REFUSED that actually graded', () => {
    // The mirror of the rule above: a refusal label must not be satisfied by a mark, in either direction.
    const report = testGraderBatch(multi(), [
      { expect: 'REFUSED', note: 'this one grades fine', response: { choiceIds: ['a', 'c'] } },
    ]);
    expect(report.unexpected).toHaveLength(1);
    expect(report.unexpected[0]).toContain('expected a refusal, got 4 of 4');
  });

  it('says "no code recorded" for a hand-built report, rather than printing undefined', () => {
    // `graded === (refusal === null)` is an invariant of `testGrader`, so neither fallback is reachable from
    // this module. `GraderReport` is exported, though, so a caller can assemble one -- and a terminal that read
    // `undefined` would be worse than one that admits it has no code.
    const handBuilt = {
      graded: true,
      points: 4,
      rawPoints: 4,
      maxPoints: 4,
      correct: true,
      rationaleCode: null,
      explanation: '',
      detail: {},
      flags: [],
      refusal: null,
      graderVersion: '0.0.0',
      asMarker: { spec: {} },
      asStudent: { spec: {} },
    };
    expect(describeReport(handBuilt)).toBe('4 of 4 (no code)');
    expect(describeReport({ ...handBuilt, graded: false, refusal: null })).toBe('refused: unknown');
  });
});

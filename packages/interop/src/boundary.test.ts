/**
 * The boundary at runtime.  (P5-T13)
 *
 * The compile-time half of this guarantee is `assert.types.ts` and is checked by `tsc`. This file
 * covers the half that runs in production: the guard functions, the refusal messages, and the
 * digest's stability.
 */
import { describe, expect, it } from 'vitest';
import {
  assertGradeIsExportable,
  assertNoScoreLeak,
  type BoundaryInput,
  buildStudentGrade,
  findScoreBearingKeys,
  isReleased,
  isSealed,
  SCORE_BEARING_KEYS,
} from './boundary.js';
import {
  assertExportIsAuditable,
  CodecRegistry,
  EXTERNAL_KINDS,
  emptyMappingReport,
  isExternalDirection,
  isExternalKind,
  type MappingReport,
  NON_PORTABLE_FEATURES,
} from './codec.js';
import { canonicalize, scoreDigest, setDigest } from './digest.js';

const base = (over: Partial<BoundaryInput> = {}): BoundaryInput => ({
  released: false,
  attemptId: 'attempt-1',
  assignmentId: 'assignment-1',
  submittedAt: '2026-09-28T08:41:00.000Z',
  answers: [
    { questionId: 'q1', answer: 'the student wrote this', submittedAt: '2026-09-28T08:40:00.000Z' },
  ],
  score: {
    rawTotal: 7,
    maxTotal: 10,
    percentage: 70,
    perQuestion: [
      {
        questionId: 'q1',
        score: 7,
        max: 10,
        outcome: 'PARTIAL',
        feedback: 'good',
        correctAnswer: 'the key',
      },
    ],
  },
  releasedAt: null,
  regradeNotice: null,
  ...over,
});

describe('the sealed/released boundary', () => {
  it('a SEALED payload carries no score-bearing key at ANY depth', () => {
    const sealed = buildStudentGrade(base());
    expect(isSealed(sealed)).toBe(true);
    // Walking the real serialised JSON, not the object graph: a getter that only appears when a
    // payload is stringified is exactly the kind of thing this check has to see.
    expect(findScoreBearingKeys(JSON.parse(JSON.stringify(sealed)))).toEqual([]);
    expect(JSON.stringify(sealed)).not.toContain('70');
    expect(JSON.stringify(sealed)).not.toContain('correctAnswer');
  });

  it('DROPS the score rather than nulling it, and does not leave the key behind', () => {
    // The score is in hand. The sealed object is constructed from the fields we are willing to
    // say, not from the record minus its secrets.
    const sealed = buildStudentGrade(base()) as unknown as Record<string, unknown>;
    expect('score' in sealed).toBe(false);
    expect(Object.keys(sealed).sort()).toEqual(['receipt', 'state']);
  });

  it('refuses to hand a sealed grade to a codec, and says WHY in the message', () => {
    const sealed = buildStudentGrade(base());
    expect(() => assertGradeIsExportable(sealed)).toThrow(/does not exist yet — not a zero/);
  });

  it('a RELEASED_WITHOUT_A_SCORE build throws instead of quietly going back to sealed', () => {
    // Returning "submitted, awaiting review" for a batch that WAS released is a lie with a
    // receipt hash on it, and the student cannot tell the difference.
    expect(() =>
      buildStudentGrade(base({ released: true, score: null, releasedAt: null })),
    ).toThrow(/RELEASED_WITHOUT_A_SCORE/);
    expect(() => buildStudentGrade(base({ released: true, score: null }))).toThrow(
      /RELEASED_WITHOUT_A_SCORE/,
    );
  });

  it('catches a hand-built payload, so bypassing the builder does not help', () => {
    expect(() =>
      assertNoScoreLeak({ state: 'SEALED', receipt: {}, score: { rawTotal: 7 } }),
    ).toThrow(/SCORE_LEAK.*\.score \(score\)/);
    expect(() => assertNoScoreLeak({ a: { b: [{ total: 3 }] } })).toThrow(/\$\.a\.b\[0\]\.total/);
  });

  it('flags the fields that are a score WITHOUT being called one', () => {
    // `maxTotal` travels with `rawTotal`, and a student holding both can divide. `excusedCount`
    // moves the denominator. These were "harmless" fields at some point.
    const keys = [...SCORE_BEARING_KEYS];
    for (const key of [
      'maxTotal',
      'percentage',
      'correctCount',
      'excusedCount',
      'outcome',
      'grade',
    ]) {
      expect(keys, `${key} must be in SCORE_BEARING_KEYS`).toContain(key);
    }
    expect(findScoreBearingKeys({ result: { maxTotal: 10, excusedCount: 2 } })).toHaveLength(2);
  });

  it("does NOT flag a student's own answers, or the receipt", () => {
    // §6.2: before release a student sees their submission time, the receipt hash and their own
    // answers. Flagging those would make the guard useless, because the fix would be to delete
    // things a student is entitled to.
    const sealed = buildStudentGrade(base());
    expect(findScoreBearingKeys(sealed)).toEqual([]);
    expect(findScoreBearingKeys({ totalQuestions: 12, questionId: 'q1' })).toEqual([]);
  });

  it('the receipt hash is STABLE and identical across two builds', () => {
    const a = buildStudentGrade(base());
    const b = buildStudentGrade(base());
    expect(a.receipt.receiptHash).toBe(b.receipt.receiptHash);
    // And it moves when the work does.
    const c = buildStudentGrade(
      base({
        answers: [{ questionId: 'q1', answer: 'edited', submittedAt: '2026-09-28T08:40:30.000Z' }],
      }),
    );
    expect(c.receipt.receiptHash).not.toBe(a.receipt.receiptHash);
  });

  it('a RELEASED payload carries the score, because that is what release is for', () => {
    // The guard is "no score may cross while SEALED". Running it on the released arm rejects every
    // real release, which is how a check gets switched off.
    const released = buildStudentGrade(
      base({ released: true, releasedAt: '2026-09-28T09:00:00.000Z' }),
    );
    expect(released.score.rawTotal).toBe(7);
    expect(() => assertNoScoreLeak(released)).toThrow(/SCORE_LEAK/);
  });

  it('narrows both ways', () => {
    const sealed = buildStudentGrade(base());
    const released = buildStudentGrade(
      base({ released: true, releasedAt: '2026-09-28T09:00:00.000Z' }),
    );
    expect(isReleased(sealed)).toBe(false);
    expect(isReleased(released)).toBe(true);
    expect(assertGradeIsExportable(released).score.rawTotal).toBe(7);
  });
});

describe('the codec registry', () => {
  const ctx = (over: Partial<Parameters<typeof assertExportIsAuditable>[0]> = {}) => ({
    kind: 'QTI_ASSESSMENT' as const,
    binding: { externalId: 'qti-1', localType: 'ResourceVersion', localId: 'v1', tenantId: null },
    items: ['q1', 'q2'],
    ...over,
  });

  it('B13: a QTI export that names no items is refused, because the audit would name nothing', () => {
    expect(() => assertExportIsAuditable(ctx({ items: [] }))).toThrow(/UNNAMEABLE_EXPORT/);
  });

  it('B13: a duplicated item id is refused, because the audit would name it once', () => {
    expect(() => assertExportIsAuditable(ctx({ items: ['q1', 'q1'] }))).toThrow(
      /DUPLICATE_ITEM_IN_EXPORT: q1/,
    );
  });

  it('a roster sync needs no item list, so it is not asked for one', () => {
    expect(() =>
      assertExportIsAuditable(ctx({ kind: 'ONEROSTER_CLASS', items: [] })),
    ).not.toThrow();
  });

  it('refuses an unknown kind and a duplicate codec', () => {
    const registry = new CodecRegistry();
    const codec = {
      kind: 'ONEROSTER_CLASS' as const,
      mappingVersion: '1',
      encode: async () => ({ ok: true }),
      portable: [],
      NOTPortable: [],
    };
    expect(registry.registerExport(codec).exportCodec('ONEROSTER_CLASS')).toBeDefined();
    expect(() => registry.registerExport(codec)).toThrow(/DUPLICATE_EXPORT_CODEC/);
    expect(() => registry.registerExport({ ...codec, kind: 'NOPE' as never })).toThrow(
      /UNKNOWN_KIND/,
    );
    expect(registry.registered()).toEqual(['ONEROSTER_CLASS']);
  });

  it('a mapping report starts empty and stays honest — no silent loss', () => {
    const report: MappingReport = emptyMappingReport();
    expect(report).toEqual({ imported: [], approximated: [], dropped: [], ignored: [] });
  });

  it('names the four kinds and validates both enums', () => {
    expect(EXTERNAL_KINDS).toHaveLength(4);
    expect(isExternalKind('QTI_ASSESSMENT')).toBe(true);
    expect(isExternalKind('QTI_ASSESSMENT_V2')).toBe(false);
    expect(isExternalDirection('BIDIRECTIONAL')).toBe(true);
    expect(isExternalDirection('both')).toBe(false);
  });

  it('§2.3: the things that do NOT travel are named in code, not only in a manifest', () => {
    // A manifest is written by the exporter and read by someone else. A peer who imports our maths
    // quiz gets the questions and the marks, not the exam conditions.
    expect(NON_PORTABLE_FEATURES.join(' ')).toMatch(/integrity policy/);
    expect(NON_PORTABLE_FEATURES).toHaveLength(6);
  });
});

describe('the digest', () => {
  it('sorts keys and drops undefined PROPERTIES, so the same document hashes the same', () => {
    expect(canonicalize({ b: 1, a: 2, c: undefined })).toBe('{"a":2,"b":1}');
    // In an ARRAY, `undefined` becomes `null` like JSON does. Dropping it would shift every later
    // index, so the hash would depend on absence in a way nobody reading the export could see.
    expect(canonicalize([3, undefined, 2])).toBe('[3,null,2]');
    expect(scoreDigest({ a: 1, b: 2 })).toBe(scoreDigest({ b: 2, a: 1 }));
  });

  it('refuses a Date, which would otherwise hash as {} and look unchanged since the epoch', () => {
    // The silent case is the dangerous one: a roster whose `syncedAt` was a Date would be
    // indistinguishable from one with no timestamp at all, so a changed export reads as clean.
    expect(() => canonicalize({ at: new Date(0) })).toThrow(/NOT_A_PLAIN_OBJECT.*Date/);
    expect(() => canonicalize({ at: new Map() })).toThrow(/NOT_A_PLAIN_OBJECT/);
  });

  it('treats -0 as 0, or a re-export never settles', () => {
    expect(scoreDigest({ v: -0 })).toBe(scoreDigest({ v: 0 }));
  });

  it('refuses NaN and Infinity rather than hashing them as null', () => {
    expect(() => canonicalize({ v: Number.NaN })).toThrow(/NON_FINITE_NUMBER/);
    expect(() => canonicalize({ v: Number.POSITIVE_INFINITY })).toThrow(/NON_FINITE_NUMBER/);
    expect(() => canonicalize({ v: () => 1 })).toThrow(/UNSUPPORTED_IN_CANONICAL_JSON/);
  });

  it('a SET digest does not depend on arrival order', () => {
    // `lastHash` exists so a re-export can be skipped when nothing changed, which only works if
    // a roster arriving in a different order is not a change.
    expect(setDigest([{ id: 'a' }, { id: 'b' }])).toBe(setDigest([{ id: 'b' }, { id: 'a' }]));
    expect(setDigest([{ id: 'a' }, { id: 'b' }])).not.toBe(setDigest([{ id: 'a' }, { id: 'c' }]));
  });
});

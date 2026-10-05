/**
 * The outbound chokepoint, and the negative cases it exists for.  (P10-T10)
 *
 * ## THE ORDER MATTERS: THE DEFECT COMES FIRST
 *
 * The first test asserts that the PRE-EXISTING guard misses the payloads `plans/16` describes. **That assertion is the
 * reason this file exists**, and it is written as an empty result rather than as `expect(...).not.toThrow()` so that it
 * reads as a measurement instead of as a blessing. If somebody later adds `scoreGiven` to `SCORE_BEARING_KEYS`, this
 * test goes red and they have to come here and decide whether the chokepoint's widened list is still the right answer --
 * which is the conversation the guard should provoke.
 *
 * ## WHAT "NEGATIVE CASE" MEANS HERE, AND WHY BOTH KINDS ARE NEEDED
 *
 *  · **AN UNRELEASED ATTEMPT WITH A REAL SCORE IN THE DATABASE** -- covered by
 *    `packages/db/src/interop-boundary.integration.test.ts`, because this package has no dependencies and cannot read a
 *    database. Here the score is a `ReleasedScore` in hand, which is the same object the DB test builds from a real row.
 *  · **A NESTED PAYLOAD SHAPE SOMEONE COULD SMUGGLE A MARK THROUGH** -- several of them, below, because the smuggle is
 *    always in the ENVELOPE: it is a `Record<string, unknown>` from a codec nobody audited, and the sealed arm's type
 *    cannot stop an unknown value.
 */

import { describe, expect, it } from 'vitest';
import {
  assertNoScoreLeak,
  buildStudentGrade,
  findScoreBearingKeys,
  type Grade,
  type ReleasedGrade,
  type SealedGrade,
} from './boundary.js';
import * as outbound from './outbound.js';
import {
  assertNoInteropScoreLeak,
  findInteropScoreBearingKeys,
  INTEROP_SCORE_BEARING_KEYS,
  isOutboundStandard,
  LTI_AGS_SCORE_KEYS,
  OUTBOUND_STANDARDS,
  type OutboundStandard,
  type OutboundTarget,
  outboundIdentity,
  prepareOutbound,
  XAPI_SCORE_KEYS,
} from './outbound.js';

const RECEIPT = {
  attemptId: 'att-1',
  assignmentId: 'asg-1',
  submittedAt: '2026-10-05T09:00:00.000Z',
  receiptHash: 'deadbeef',
  answers: [
    {
      questionId: 'q1',
      answer: { selectedChoiceIndex: 0 },
      submittedAt: '2026-10-05T09:00:00.000Z',
    },
  ],
} as const;

const target = (standard: OutboundStandard): OutboundTarget => ({
  standard,
  bindingId: 'bind-1',
  externalId: 'ext-1',
  attemptId: 'att-1',
  assignmentId: 'asg-1',
});

/**
 * A SEALED GRADE WITH A REAL SCORE STILL IN HAND.
 *
 * **THE SCORE IS DELIBERATELY PRESENT AND DELIBERATELY IGNORED**, and that is the whole shape of the hazard: the
 * database has the mark, the record in memory has the mark, and the payload must not. A fixture that only ever built a
 * `SealedGrade` with `score: null` would test a code path nobody ships.
 */
const SEALED_WITH_A_SCORE_IN_HAND = {
  released: false,
  attemptId: 'att-1',
  assignmentId: 'asg-1',
  submittedAt: RECEIPT.submittedAt,
  answers: [...RECEIPT.answers],
  score: { rawTotal: 18, maxTotal: 30, percentage: 60, perQuestion: [] },
  releasedAt: null,
  regradeNotice: null,
} as const;

const RELEASED: ReleasedGrade = {
  state: 'RELEASED',
  receipt: { ...RECEIPT, answers: [...RECEIPT.answers] },
  score: {
    rawTotal: 18,
    maxTotal: 30,
    percentage: 60,
    perQuestion: [
      {
        questionId: 'q1',
        score: 18,
        max: 30,
        outcome: 'PARTIAL',
        feedback: 'Nearly.',
        correctAnswer: null,
      },
    ],
  },
  releasedAt: '2026-10-05T12:00:00.000Z',
  regradeNotice: null,
};

describe("P10-T10: the pre-existing guard misses the standards' own score field names", () => {
  it('finds NOTHING in an AGS grade passback carrying a real mark', () => {
    /**
     * **THIS IS THE DEFECT, MEASURED.** `{ scoreGiven: 87, scoreMaximum: 100 }` is the payload `plans/16` §4.1
     * describes, with `activityProgress` the only field the old set would have caught. The walker returns an empty array,
     * and so the guard passes it.
     *
     * Note what is NOT happening: nobody overrode a guard, nobody weakened a list, and no test failed. The list was
     * written from a student-facing DTO (`P5-T13`'s `ReleasedGrade`) and these field names have never appeared in one.
     */
    const agsPayload = {
      scoreGiven: 87,
      scoreMaximum: 100,
      activityProgress: 'Completed',
    };
    expect(findScoreBearingKeys(agsPayload)).toEqual([]);
    /**
     * `.not.toThrow()` ON A LEAK GUARD READS LIKE AN ENDORSEMENT, so the comment above says what the line is: a
     * measurement of a hole. If somebody adds `scoreGiven` to `SCORE_BEARING_KEYS`, this line goes red and they have to
     * come here and decide whether the widened list is still the right answer.
     */
    expect(() => assertNoScoreLeak(agsPayload)).not.toThrow();
    // ...and the chokepoint does not.
    expect(() => assertNoInteropScoreLeak(agsPayload, 'LTI_AGS')).toThrow(/INTEROP_SCORE_LEAK/);
  });

  it('finds NOTHING in an xAPI `scored` statement carrying a real mark', () => {
    // `plans/16` §3's `scored` verb, in the shape a codec that flattened `score` away would emit.
    const statement = {
      verb: 'http://adlnet.gov/expapi/verbs/scored',
      result: { raw: 87, success: true },
    };
    expect(findScoreBearingKeys(statement)).toEqual([]);
  });

  it('DOES catch the nested shape that happens to reuse a name the old set knew', () => {
    /**
     * The contrast that makes the defect legible: `result.score.raw` IS caught, because the walker matches the PARENT key
     * `score`. So a codec author who knew the list would be caught for one spelling of the same fact and not the other,
     * which is the worst of both outcomes and the reason the fix is a widened set rather than a better message.
     */
    expect(findScoreBearingKeys({ result: { score: { raw: 87 } } })).toEqual([
      { path: '$.result.score', key: 'score' },
    ]);
  });

  it('widens the set by UNION, so nothing the sealed results view relies on is lost', () => {
    for (const key of findScoreBearingKeys({
      finalScore: 1,
      percentage: 2,
      correctAnswer: 'x',
      outcome: 'CORRECT',
    }))
      expect(INTEROP_SCORE_BEARING_KEYS.has(key.key), `${key.key} must still be watched`).toBe(
        true,
      );
    expect(INTEROP_SCORE_BEARING_KEYS.size).toBeGreaterThan(LTI_AGS_SCORE_KEYS.size);
    expect(INTEROP_SCORE_BEARING_KEYS.size).toBeGreaterThan(XAPI_SCORE_KEYS.size);
  });

  it('does NOT watch `duration`, because `plans/16` §3 requires time-on-task statements before release', () => {
    /**
     * **THE LIST IS NOT AS WIDE AS IT COULD BE, ON PURPOSE.** An earlier draft watched `duration`, `min` and `max`; all
     * three were removed. `duration` because `plans/16` §3 lists "time on task" under `experienced`, which is a
     * pre-release statement the plan requires; `min`/`max` because they are ordinary words and a payload carrying
     * `{ min: 0, max: 100 }` for a zoom level is not a leak.
     *
     * A guard that refuses payloads the plan requires gets weakened until it stops objecting, and `boundary.ts` records
     * exactly that happening to `assertNoScoreLeak` in its first version. If somebody believes `duration` leaks, this is
     * the test to change, deliberately, with that argument made.
     */
    expect(XAPI_SCORE_KEYS.has('duration')).toBe(false);
    expect(XAPI_SCORE_KEYS.has('min')).toBe(false);
    expect(XAPI_SCORE_KEYS.has('max')).toBe(false);
    expect(findInteropScoreBearingKeys({ result: { duration: 'PT1M' } })).toEqual([]);
    expect(findInteropScoreBearingKeys({ zoom: { min: 0, max: 100 } })).toEqual([]);
  });
});

describe('P10-T10: the chokepoint refuses an unreleased attempt that holds a real score', () => {
  it('drops the score in hand and emits a body with no score field at all', () => {
    const grade: Grade = buildStudentGrade(SEALED_WITH_A_SCORE_IN_HAND);
    expect(grade.state).toBe('SEALED');

    for (const standard of OUTBOUND_STANDARDS) {
      const body = prepareOutbound({ target: target(standard), grade });
      expect(body.state).toBe('SEALED');
      // Not "the score is null". ABSENT, on the object and in the serialised bytes.
      expect(Object.keys(body)).not.toContain('score');
      expect(body.body).not.toContain('scoreGiven');
      expect(body.body).not.toContain('rawTotal');
      expect(findInteropScoreBearingKeys(JSON.parse(body.body))).toEqual([]);
    }
  });

  it('drops the ANSWERS as well, because an answer set is a fingerprint and `plans/16` §3 forbids it', () => {
    /**
     * `AttemptReceipt.answers` is not score-bearing by any key in any list, so no guard on keys would ever stop it --
     * and it is the larger disclosure. Who answered which question, in which order, is a signature that identifies one
     * student across exams.
     */
    const grade: Grade = buildStudentGrade(SEALED_WITH_A_SCORE_IN_HAND);
    expect(grade.state).toBe('SEALED');
    const body = prepareOutbound({ target: target('XAPI'), grade });
    expect(body.body).not.toContain('selectedChoiceIndex');
    expect(body.body).not.toContain('answers');
    // The hash is `buildStudentGrade`'s own, not this file's constant: the boundary owns it and a fixture that
    // hard-coded one would pass whatever the boundary computed.
    expect(body.state === 'SEALED' ? body.identity.receiptHash : null).toBe(
      grade.state === 'SEALED' ? grade.receipt.receiptHash : null,
    );
    expect(body.state === 'SEALED' ? Object.keys(body.identity) : null).toEqual([
      'attemptId',
      'assignmentId',
      'submittedAt',
      'receiptHash',
    ]);
  });

  it('posts no placeholder, because a zero is a mark and a null is a promise', () => {
    /**
     * `plans/16` §4.1: "no line item score is posted at all -- not a zero, not a placeholder." **A placeholder's whole
     * problem is that its presence or absence is a signal**: a recipient who polls can tell a pending submission from an
     * unmarked one, which is the timing information `INV-RELEASE-2` is about.
     */
    const grade: Grade = buildStudentGrade(SEALED_WITH_A_SCORE_IN_HAND);
    const body = prepareOutbound({ target: target('LTI_AGS'), grade });
    const document = JSON.parse(body.body) as Record<string, unknown>;
    expect('score' in document).toBe(false);
    expect('scoreGiven' in document).toBe(false);
    expect(body.body).not.toContain('null');
  });
});

describe('P10-T10: the negative case that matters is a NESTED envelope', () => {
  /**
   * EVERY SHAPE HERE IS ONE SOMEBODY WOULD WRITE.
   *
   * The sealed arm's TYPE is airtight, and it is airtight about the fields we declared. `envelope` is
   * `Record<string, unknown>` because a codec's real payload has fields we have not enumerated yet, and that is
   * precisely where a mark gets put -- so the runtime scan exists for the envelope and these are its test cases.
   */
  const SMUGGLES: readonly { readonly what: string; readonly envelope: Record<string, unknown> }[] =
    [
      {
        what: 'the AGS field names at the top level of an extension',
        envelope: { scoreGiven: 87, scoreMaximum: 100 },
      },
      {
        what: 'a mark under `extensions`, which is where xAPI puts everything third-party',
        envelope: {
          'https://w3id.org/xapi/extensions/orrery': { score: { raw: 87, max: 100 } },
        },
      },
      {
        what: 'a verdict rather than a number, which is a score a student can read',
        envelope: { result: { success: true, completion: true } },
      },
      {
        what: 'an ARRAY of per-item results, one level deeper than any list a reviewer would read',
        envelope: { grading: [{ questionId: 'q1', outcome: 'CORRECT' }] },
      },
      {
        what: 'a nested array of arrays, which is how an LTI deep-linking response nests `lineItems`',
        envelope: { lineItems: [[{ scoreGiven: 87 }]] },
      },
      {
        what: 'the release verdict itself, under the key `state` on a nested object',
        envelope: { studentReleaseState: { state: 'RELEASED', finalScore: 87 } },
      },
      {
        what: 'a field name our own schema uses, which is why the union includes `SCORE_BEARING_KEYS` at all',
        envelope: { breakdown: { rawTotal: 18, maxTotal: 30, percentage: 60 } },
      },
    ];

  for (const { what, envelope } of SMUGGLES) {
    it(`refuses ${what}`, () => {
      const grade: Grade = buildStudentGrade(SEALED_WITH_A_SCORE_IN_HAND);
      expect(() => prepareOutbound({ target: target('XAPI'), grade, envelope })).toThrow(
        /INTEROP_SCORE_LEAK/,
      );
    });
  }

  it('refuses the same smuggled envelope on BOTH standards, because a codec does not know which one is checking', () => {
    const grade: Grade = buildStudentGrade(SEALED_WITH_A_SCORE_IN_HAND);
    for (const standard of OUTBOUND_STANDARDS) {
      expect(() =>
        prepareOutbound({ target: target(standard), grade, envelope: { scoreGiven: 87 } }),
      ).toThrow(/INTEROP_SCORE_LEAK/);
    }
  });

  it('names the PATH, so a codec author is told where to look rather than only that something is wrong', () => {
    /**
     * **TWO VIOLATIONS, NOT ONE**, and the second is the interesting one: the xAPI extension key is a URL, so the path
     * reads `$.https://w3id.org/xapi/extensions/orrery.score` rather than a bracketed form. That is the same path format
     * `boundary.ts`'s walker produces, deliberately kept identical so the two cannot be told apart by their output --
     * see the drift test below.
     */
    const violations = findInteropScoreBearingKeys({
      'https://w3id.org/xapi/extensions/orrery': { score: { raw: 87 } },
    });
    expect(violations.map((v) => [v.path, v.key])).toEqual([
      ['$.https://w3id.org/xapi/extensions/orrery.score', 'score'],
      ['$.https://w3id.org/xapi/extensions/orrery.score.raw', 'raw'],
    ]);
  });

  it("agrees with `boundary.ts`'s walker on every key the two sets share, so they cannot drift apart", () => {
    /**
     * TWO WALKERS IN ONE PACKAGE IS A DRIFT RISK, and the mitigation is not a comment: on a payload built only from
     * names in `SCORE_BEARING_KEYS`, the two must return identical paths. A payload that also contains an interop-only
     * name is excluded from the comparison -- that is the whole difference between them.
     */
    const shared = {
      finalScore: 60,
      percentage: 60,
      rawTotal: 18,
      maxTotal: 30,
      outcome: 'PARTIAL',
      correctAnswer: 'B',
      nested: [{ correct: true }, { excusedCount: 0 }],
    };
    // Compared on `{path, key}` rather than with `toEqual` on the violations, because `InteropViolation` carries a
    // `standard` the narrow `PayloadViolation` has no field for. The PATHS are the thing that must not drift.
    const narrow = (
      rows: readonly { path: string; key: string }[],
    ): { path: string; key: string }[] => rows.map(({ path, key }) => ({ path, key }));
    expect(narrow(findInteropScoreBearingKeys(shared))).toEqual(
      narrow(findScoreBearingKeys(shared)),
    );
  });

  it('refuses `completion: false` too, because an allowed FALSE becomes a signal once a TRUE ever appears', () => {
    /**
     * The over-broad-list question, asked honestly rather than assumed. `completion: false` says "not finished", which on
     * its own reveals nothing about a mark -- so a reader could reasonably allow it.
     *
     * **It is refused anyway, and the reason is that the VALUE is not what the recipient can use.** If `false` is
     * permitted and `true` is forbidden, the recipient polls until the payload changes, and the payload changing is the
     * release signal. `INV-RELEASE-2` is "no difference in status", and a field that is allowed one of two values is a
     * one-bit channel. The fix for a codec that needs a lifecycle flag is `verb`/`activityProgress`, not a permissive
     * exception here.
     */
    const grade: Grade = buildStudentGrade(SEALED_WITH_A_SCORE_IN_HAND);
    expect(() =>
      prepareOutbound({
        target: target('XAPI'),
        grade,
        envelope: { result: { completion: false } },
      }),
    ).toThrow(/INTEROP_SCORE_LEAK/);
  });

  it('ALLOWS an envelope with no mark in it, or the guard would be switched off within a month', () => {
    /**
     * The positive case, and it is the one that keeps the negative cases credible. `plans/16` §3's `experienced`
     * statements carry a duration and a platform, and they are pre-release by design -- which is why `duration` is not on
     * the watched list. `activityProgress` is watched, so the AGS lifecycle state is NOT offered here as an example of
     * what gets through; it is a plan decision this boundary takes the stricter side of.
     */
    const grade: Grade = buildStudentGrade(SEALED_WITH_A_SCORE_IN_HAND);
    const body = prepareOutbound({
      target: target('XAPI'),
      grade,
      envelope: {
        verb: 'http://adlnet.gov/expapi/verbs/experienced',
        result: { duration: 'PT82M' },
        context: { platform: 'https://w3id.org/xapi/lms/course' },
      },
    });
    expect(body.state).toBe('SEALED');
    expect(() => assertNoInteropScoreLeak({ result: { duration: 'PT1M' } }, 'XAPI')).not.toThrow();
    expect(findInteropScoreBearingKeys(body.envelope)).toEqual([]);
  });
});

describe("P10-T10: a released attempt may send a score, in the standard's own shape", () => {
  it('emits `scoreGiven`/`scoreMaximum`/`activityProgress` for AGS', () => {
    const body = prepareOutbound({ target: target('LTI_AGS'), grade: RELEASED });
    expect(body.state).toBe('RELEASED');
    expect(body.state === 'RELEASED' ? body.score : null).toEqual({
      scoreGiven: 18,
      scoreMaximum: 30,
      activityProgress: 'Completed',
    });
  });

  it('emits `raw`/`max`/`success` for xAPI, and derives success rather than guessing a pass mark', () => {
    const body = prepareOutbound({ target: target('XAPI'), grade: RELEASED });
    expect(body.state === 'RELEASED' ? body.score : null).toEqual({
      raw: 18,
      max: 30,
      success: false,
      completion: true,
    });
  });

  it('is the ONLY way to get bytes: the export list is pinned, and this package cannot send anything', async () => {
    /**
     * THE "ONLY PATH" CLAIM, HALF OF IT, AND THE HALF THAT CAN BE CHECKED FROM INSIDE THE PACKAGE.
     *
     * A name-regex over the exports is the wrong instrument -- it matched `isOutboundStandard` and `outboundIdentity` on
     * their names while neither can produce a payload. So the check is the WHOLE export list, pinned: adding a second
     * outbound constructor is now a visible diff in this line rather than something a reader has to notice.
     *
     * The other half -- that no OTHER FILE in the repository names an interop score key, and that this package has no
     * dependency it could reach the network through -- is `scripts/audit-outbound.mjs`, because that claim is about the
     * source tree and not about a module's own exports.
     */
    expect(Object.keys(outbound).sort()).toEqual([
      'INTEROP_SCORE_BEARING_KEYS',
      'LTI_AGS_SCORE_KEYS',
      'OUTBOUND_STANDARDS',
      'XAPI_SCORE_KEYS',
      'assertNoInteropScoreLeak',
      'findInteropScoreBearingKeys',
      'isOutboundStandard',
      'outboundIdentity',
      'prepareOutbound',
    ]);
  });

  it('refuses an unknown standard rather than scanning a vocabulary nobody has read', () => {
    expect(isOutboundStandard('LTI_AGS')).toBe(true);
    expect(isOutboundStandard('ONEROSTER_GRADEBOOK')).toBe(false);
    const grade: Grade = buildStudentGrade(SEALED_WITH_A_SCORE_IN_HAND);
    expect(() =>
      prepareOutbound({
        target: { ...target('XAPI'), standard: 'MADE_UP' as OutboundStandard },
        grade,
      }),
    ).toThrow(/OUTBOUND_UNKNOWN_STANDARD/);
  });

  it('keeps `outboundIdentity` total, so a caller cannot build an identity from something that is not a receipt', () => {
    /**
     * The narrowing is a FUNCTION rather than a type, for the reason `release.ts` gives about a cast into `Prisma`
     * shapes: a cast to `OutboundIdentity` would compile against a `Record<string, unknown>` and quietly carry whatever
     * answers were in it. Reading four named fields off a receipt cannot.
     */
    const sealed: SealedGrade = {
      state: 'SEALED',
      receipt: { ...RECEIPT, answers: [...RECEIPT.answers] },
    };
    expect(outboundIdentity(sealed.receipt)).toEqual({
      attemptId: 'att-1',
      assignmentId: 'asg-1',
      submittedAt: RECEIPT.submittedAt,
      receiptHash: 'deadbeef',
    });
    expect(Object.keys(outboundIdentity(sealed.receipt))).not.toContain('answers');
  });
});

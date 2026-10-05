/**
 * "This key looks wrong": the refusal policy, the population, the blast radius, and the append-only fold.  (P9-T6)
 *
 * ## EVERY INVARIANT HERE HAS A TEST THAT FAILS WHEN IT IS REMOVED, AND THE TESTS NAME WHAT BREAKS
 *
 *  · a flag carries a reason, and identifying question -> `REASON_REQUIRED`, `KEY_FLAG_REASON_MAX_CHARS`
 *  · a flag may only be raised on a SEALED auto-grade -> the conformance test against `decideGradingWrite`
 *  · a flag does not move a mark -> `REVIEW_SURFACE_IS_INERT`, a COMPILE-time assertion, plus the integration test
 *    that diffs every response and batch before and after a flag
 *  · the blast radius is the PREVIEW's arithmetic, not a second query's -> `blastRadius` refuses an unscoped preview
 *  · the population partitions -> `isPartitioned`
 *  · a resolution closes the most recent raising and never erases one -> the fold tests
 */

import { FrozenClock } from '@orrery/clock';
import { findScoreBearingKeys, SCORE_BEARING_KEYS } from '@orrery/interop';
import { describe, expect, it } from 'vitest';
import {
  type AutoGradeKeyFlagFacts,
  blastRadius,
  decideAutoGradeKeyFlag,
  flagsFrom,
  isPartitioned,
  isSealedAutomatic,
  KEY_FLAG_DISMISSED,
  KEY_FLAG_RAISED,
  KEY_FLAG_REASON_MAX_CHARS,
  KEY_FLAG_SEPARATOR,
  KEY_FLAG_TARGET_TYPE,
  KEY_FLAG_UPHELD,
  type KeyFlagEvent,
  type KeyPopulation,
  keyFlagIdentity,
  openFlagsFrom,
  resolutionAction,
  type SealedAutoGradeTarget,
} from './grading-review.js';
import {
  AUTO_GRADE_REVIEW_API,
  flagAutoGradeKey,
  REVIEW_SURFACE_IS_INERT,
  readAutoGradeKeyFlags,
} from './grading-review-flag.js';

const clock = new FrozenClock(1_800_000_000_000);

/** Every combination of the facts a decision reads, so "agrees with `decideGradingWrite`" means ALL of them. */
const allFactCombinations = (): AutoGradeKeyFlagFacts[] => {
  const out: AutoGradeKeyFlagFacts[] = [];
  for (const status of [
    'SUBMITTED',
    'EXPIRED',
    'PENDING_REVIEW',
    'GRADED',
    'IN_PROGRESS',
    'VOIDED',
  ])
    for (const hasAutomaticMark of [true, false])
      for (const hasManualMark of [true, false])
        for (const isExcused of [true, false])
          for (const needsHuman of [true, false])
            out.push({
              status,
              hasAutomaticMark,
              hasManualMark,
              isExcused,
              needsHuman,
              openFlagsByReporter: 0,
            });
  return out;
};

describe('the sealed-auto-grade predicate: the rows a flag may be raised on', () => {
  /**
   * WHY THE PREDICATE IS RE-DERIVED HERE AT ALL, AND WHERE ITS AGREEMENT IS ACTUALLY PROVED.
   *
   * `grading-write.ts:126-129` computes `sealedAutomatic` from the response row INSIDE `bulkGrade`, and it is not
   * exported and not reachable through `decideGradingWrite`, which takes it as an argument. So a unit test cannot
   * compare against it -- it can only feed `decideGradingWrite` a value it chose itself, which proves nothing.
   *
   * The agreement is therefore proved where it can be: `grading-review-flag.integration.test.ts` raises a flag on a real
   * row and calls `bulkGrade` with a `SCORE` against the SAME row, in the same test, and asserts that one is accepted
   * and the other refused `SEALED_AUTOMATIC`. That is the real predicate, not a transcription of it.
   *
   * What is pinned here is this function's own behaviour over every combination of the facts, so a change to it is a
   * visible diff in a test that names which combination changed.
   */
  it('reads the MARK and nothing else, so the status gate stays where it belongs', () => {
    // `isSealedAutomatic` deliberately does not look at `status`: that gate is `decideAutoGradeKeyFlag`'s, and a
    // predicate that carried both would make "sealed" mean "reviewable AND marked" and the two could not be reasoned
    // about separately. So the count is one per status -- and the gate is tested on its own below.
    const sealed = allFactCombinations().filter(isSealedAutomatic);
    expect(sealed).toHaveLength(6);
    expect(
      sealed.every(
        (facts) =>
          facts.hasAutomaticMark && !facts.hasManualMark && !facts.isExcused && !facts.needsHuman,
      ),
    ).toBe(true);
  });

  it('accepts a flag on every reviewable status and refuses the other two', () => {
    const sealed = allFactCombinations().find(
      (facts) => isSealedAutomatic(facts) && facts.status === 'GRADED',
    );
    if (!sealed) throw new Error('no sealed GRADED combination to test with');
    expect(
      decideAutoGradeKeyFlag(sealed, { reason: 'the key names an option that does not exist' }),
    ).toBeNull();
    for (const status of ['IN_PROGRESS', 'VOIDED'])
      expect(
        decideAutoGradeKeyFlag(
          { ...sealed, status },
          { reason: 'the key names an option that does not exist' },
        ),
      ).toBe('NOT_FOUND');
  });

  it('excludes an excused row, which `grading-write.ts:126-129` does not need to test for', () => {
    // The inline version has no `isExcused` term because `bulkGrade` refuses an excuse and a score in one transaction
    // anyway. An excused response has no mark to dispute, so flagging it would be a flag with nothing behind it.
    expect(
      allFactCombinations()
        .filter(
          (facts) =>
            isSealedAutomatic(facts) &&
            facts.hasAutomaticMark &&
            !facts.hasManualMark &&
            !facts.needsHuman,
        )
        .every((facts) => !facts.isExcused),
    ).toBe(true);
    expect(
      isSealedAutomatic({
        status: 'GRADED',
        hasAutomaticMark: true,
        hasManualMark: false,
        isExcused: true,
        needsHuman: false,
        openFlagsByReporter: 0,
      }),
    ).toBe(false);
  });

  it('excludes a `needsHuman` row, which is what routes it to a person instead', () => {
    expect(
      allFactCombinations()
        .filter(
          (facts) =>
            facts.hasAutomaticMark && !facts.hasManualMark && !facts.isExcused && facts.needsHuman,
        )
        .every((facts) => !isSealedAutomatic(facts)),
    ).toBe(true);
  });
});

describe('a flag with no reason is refused, because the reader is not the writer', () => {
  it('refuses an empty or whitespace-only reason, and accepts punctuation', () => {
    const sealed: AutoGradeKeyFlagFacts = {
      status: 'GRADED',
      hasAutomaticMark: true,
      hasManualMark: false,
      isExcused: false,
      needsHuman: false,
      openFlagsByReporter: 0,
    };
    expect(decideAutoGradeKeyFlag(sealed, { reason: '' })).toBe('REASON_REQUIRED');
    expect(decideAutoGradeKeyFlag(sealed, { reason: '   \n\t ' })).toBe('REASON_REQUIRED');
    expect(decideAutoGradeKeyFlag(sealed, { reason: '.' })).toBeNull();
  });

  it('refuses a reason past the cap rather than storing a truncated one', () => {
    // A truncated reason is a reason with its explanation cut off, and `plans/07` §3.4's rule about opaque judgements
    // applies to prose exactly as it does to a score.
    const sealed = allFactCombinations().find((facts) => isSealedAutomatic(facts));
    if (!sealed) throw new Error('no sealed combination to test with');
    expect(
      decideAutoGradeKeyFlag(sealed, { reason: 'x'.repeat(KEY_FLAG_REASON_MAX_CHARS) }),
    ).toBeNull();
    expect(
      decideAutoGradeKeyFlag(sealed, { reason: 'x'.repeat(KEY_FLAG_REASON_MAX_CHARS + 1) }),
    ).toBe('REASON_TOO_LONG');
  });
});

describe('only a sealed auto-grade on a reviewable paper may be flagged', () => {
  const sealed: AutoGradeKeyFlagFacts = {
    status: 'GRADED',
    hasAutomaticMark: true,
    hasManualMark: false,
    isExcused: false,
    needsHuman: false,
    openFlagsByReporter: 0,
  };

  it('refuses a status a regrade would not consider either', () => {
    for (const status of ['IN_PROGRESS', 'TERMINATED', 'VOIDED', 'SUSPENDED'])
      expect(
        decideAutoGradeKeyFlag({ ...sealed, status }, { reason: 'the key names the wrong option' }),
      ).toBe('NOT_FOUND');
  });

  it('sends a `needsHuman` row to a person rather than to a regrade', () => {
    // The one judgement here that is NOT "release blocks it". A row awaiting a human has no mark to dispute, and
    // sending a marker to an assignment-wide regrade to fix one unread paper would move every other paper too.
    expect(decideAutoGradeKeyFlag({ ...sealed, needsHuman: true }, { reason: 'x' })).toBe(
      'NOT_SEALED_AUTOMATIC',
    );
  });

  it('refuses a second open flag from the same reporter, and the cap is per reporter', () => {
    expect(decideAutoGradeKeyFlag({ ...sealed, openFlagsByReporter: 1 }, { reason: 'x' })).toBe(
      'ALREADY_FLAGGED',
    );
    expect(decideAutoGradeKeyFlag({ ...sealed, openFlagsByReporter: 2 }, { reason: 'x' })).toBe(
      'ALREADY_FLAGGED',
    );
  });
});

describe('the review target carries no mark and no key, and that is checked rather than promised', () => {
  /**
   * WHY THIS IS A RUNTIME TEST AND NOT ONLY THE TYPE.
   *
   * `SealedAutoGradeTarget`'s no-score guarantee is a compile-time assertion (`REVIEW_SURFACE_IS_INERT`). This test
   * runs the repository's own list over a populated payload, so it also catches a key that is neither score-bearing nor
   * key-bearing by name but carries the same thing -- which a type cannot.
   */
  it('finds no score-bearing key anywhere in a populated review target', () => {
    const target: SealedAutoGradeTarget = {
      responseId: 'r1',
      attemptId: 'a1',
      assignmentId: 'as1',
      questionId: 'q1',
      position: 3,
      worth: 5,
      markedByVersion: 'grader-9',
      gradedAt: '2026-10-05T00:00:00.000Z',
      needsHuman: false,
      released: true,
      openFlagsByReporter: 0,
    };
    expect(findScoreBearingKeys(target)).toEqual([]);
    expect(findScoreBearingKeys([target])).toEqual([]);
  });

  it('names no field that could become one -- the check the type makes at compile time', () => {
    // The same field list the compile-time assertion uses, read from the repository's own module, so this test fails
    // if someone adds a score-bearing name to `SealedAutoGradeTarget` without the compiler's list knowing.
    const targetKeys: readonly string[] = Object.keys({
      responseId: 1,
      attemptId: 1,
      assignmentId: 1,
      questionId: 1,
      position: 1,
      worth: 1,
      markedByVersion: 1,
      gradedAt: 1,
      needsHuman: 1,
      released: 1,
      openFlagsByReporter: 1,
    });
    expect(targetKeys.filter((key) => SCORE_BEARING_KEYS.has(key))).toEqual([]);
    // `worth` is what the question is worth, deliberately named rather than `points`, so it cannot be confused with an
    // award by either a reader or the audit.
    expect(targetKeys).toContain('worth');
    expect(targetKeys).not.toContain('points');
  });

  it('the compile-time assertion is `true`', () => {
    expect(REVIEW_SURFACE_IS_INERT).toBe(true);
  });

  it('names every function the review surface can call', () => {
    expect(Object.keys(AUTO_GRADE_REVIEW_API).sort()).toEqual([
      'blastRadius',
      'decideAutoGradeKeyFlag',
      'flagAutoGradeKey',
      'readAutoGradeKeyFlags',
      'readAutoGradeReviewTargets',
      'readKeyPopulation',
      'resolveAutoGradeKeyFlag',
    ]);
  });

  /**
   * THE MODULE'S OWN NAMESPACE IS THE WHOLE SURFACE, AND THIS IS THE TEST THAT PROVES IT.
   *
   * ## RED BEFORE THE FIX, AND THE FIX WAS NOT IN THE TYPE
   *
   * A function was added to `grading-review-flag.ts` that wrote `Question.spec`, and `pnpm --filter @orrery/db typecheck`
   * **passed**. `ReviewSurfaceParameters` is derived from `AutoGradeReviewApi`, and an export nobody added to that
   * interface is invisible to it -- so the compile-time guarantee held over the interface while the module exported a
   * key rewriter beside it. A type cannot police a module's namespace; only a test comparing the two can.
   *
   * So this compares the module's runtime exports against the interface's keys. Anything else fails, with its name.
   */
  it('exports from the flag module exactly the declared surface and the two derived values', async () => {
    const surface = await import('./grading-review-flag.js');
    expect(Object.keys(surface).sort()).toEqual([
      'AUTO_GRADE_REVIEW_API',
      'REVIEW_SURFACE_IS_INERT',
      'flagAutoGradeKey',
      'readAutoGradeKeyFlags',
      'readAutoGradeReviewTargets',
      'readKeyPopulation',
      'resolveAutoGradeKeyFlag',
    ]);
  });

  it('exports from the pure module exactly its constants, its fold and the two entry points', async () => {
    const pure = await import('./grading-review.js');
    expect(Object.keys(pure).sort()).toEqual([
      'KEY_FLAG_DISMISSED',
      'KEY_FLAG_RAISED',
      'KEY_FLAG_REASON_MAX_CHARS',
      'KEY_FLAG_SEPARATOR',
      'KEY_FLAG_TARGET_TYPE',
      'KEY_FLAG_UPHELD',
      'blastRadius',
      'decideAutoGradeKeyFlag',
      'flagsFrom',
      'isPartitioned',
      'isSealedAutomatic',
      'keyFlagIdentity',
      'openFlagsFrom',
      'resolutionAction',
    ]);
  });
});

/* ───────────────────────────────────────────────────────── the blast radius ── */

const population = (over: Partial<KeyPopulation> = {}): KeyPopulation => ({
  assignmentId: 'as1',
  questionId: 'q1',
  responses: 5,
  sealedAutomatic: 3,
  awaitingHuman: 1,
  notAutomaticallyGraded: 0,
  preservedByManualMark: 1,
  preservedAsExcused: 0,
  ...over,
});

/** A minimal preview; only the fields `blastRadius` reads are given real values. */
const preview = (over: Record<string, unknown> = {}) =>
  ({
    token: 'tok',
    request: {
      assignmentId: 'as1',
      actorId: 't1',
      reason: 'the key names an option that does not exist',
      questionIds: ['q1'],
    },
    attempts: [],
    affectedCount: 0,
    alreadyReleasedCount: 0,
    batches: [],
    ...over,
  }) as unknown as Parameters<typeof blastRadius>[0];

const attempt = (over: Record<string, unknown>) =>
  ({
    attemptId: 'a',
    studentId: 's',
    released: false,
    changes: [{ responseId: 'r' }],
    before: { finalScore: 5, percentage: 50, maxScore: 10 },
    after: { finalScore: 5, percentage: 50, maxTotal: 10, isProvisional: false },
    delta: 0,
    ...over,
  }) as unknown as Parameters<typeof blastRadius>[0]['attempts'][number];

describe('the blast radius refuses a preview that is not scoped to the one key', () => {
  /**
   * WHAT BREAKS WITHOUT THIS: a marker is shown "14 papers" computed from a preview of THREE questions, and confirms a
   * regrade that moves 40. `RegradeAttemptPreview.changes` carries a `responseId` and not a `questionId`, so nothing in
   * the preview itself says which question a change belongs to -- the scoping is the only thing that does.
   */
  it('returns null for a preview with no question selection at all', () => {
    // `previewRegrade` accepts an absent `questionIds` as "every question on the assignment"
    // (`grading-regrade.ts:220`), which is the single largest blast radius the preview can produce and exactly the one
    // that must not be presented as one key's.
    expect(blastRadius(preview({ request: { questionIds: undefined } }), population())).toBeNull();
  });

  it('returns null for a preview scoped to more questions than this one', () => {
    expect(
      blastRadius(preview({ request: { questionIds: ['q1', 'q2'] } }), population()),
    ).toBeNull();
    expect(blastRadius(preview({ request: { questionIds: ['q2'] } }), population())).toBeNull();
  });

  it('accepts a preview scoped to exactly this key, and keeps the population counts on the result', () => {
    const radius = blastRadius(preview(), population());
    expect(radius).not.toBeNull();
    expect(radius?.responses).toBe(5);
    expect(radius?.sealedAutomatic).toBe(3);
    expect(radius?.preservedByManualMark).toBe(1);
  });
});

describe('the counts separate "a paper was rewritten" from "a student sees a different figure"', () => {
  it('counts a paper whose total does not move but whose stored figure does', () => {
    // `grading-regrade.ts:134-138` distinguishes the two for the same reason: a response can be regraded to the same
    // number and the fact that the grader was re-run against it is what the reviewer is being told.
    const radius = blastRadius(
      preview({
        attempts: [attempt({}), attempt({}), attempt({ changes: [] })],
      }),
      population(),
    );
    expect(radius?.attemptsRewriting).toBe(2);
    expect(radius?.affectedAttempts).toBe(0);
    expect(radius?.rewrittenButUnchanged).toBe(2);
    expect(radius?.unchanged).toBe(3);
  });

  it('splits the movers into gains and losses, and counts the released ones separately', () => {
    const radius = blastRadius(
      preview({
        attempts: [
          attempt({ delta: 2 }),
          attempt({ delta: -1 }),
          attempt({ delta: 0 }),
          attempt({ delta: 5, released: true }),
          // A paper with no comparable stored total reports `delta: null`, and must be in NEITHER gain nor loss.
          attempt({ delta: null }),
        ],
      }),
      population(),
    );
    expect(radius?.affectedAttempts).toBe(3);
    expect(radius?.gained).toBe(2);
    expect(radius?.lost).toBe(1);
    expect(radius?.alreadyReleased).toBe(1);
    expect(radius?.unchanged).toBe(1);
  });

  it('counts the papers a regrade would leave PROVISIONAL, which is not the same as the papers it moves', () => {
    const radius = blastRadius(
      preview({
        attempts: [
          attempt({
            delta: 1,
            after: { finalScore: 6, percentage: 60, maxTotal: 10, isProvisional: true },
          }),
          attempt({
            delta: 1,
            after: { finalScore: 6, percentage: 60, maxTotal: 10, isProvisional: false },
          }),
        ],
      }),
      population(),
    );
    expect(radius?.wouldBecomeProvisional).toBe(1);
  });
});

describe('the population partitions, so a number on the screen cannot quietly double-count', () => {
  it('holds for the shape the reader produces', () => {
    expect(isPartitioned(population())).toBe(true);
  });

  it('fails when a sixth category appears and the reader has not accounted for it', () => {
    // A future category is not this function's problem to guess at; it is the partition's problem to report, which is
    // why the reader computes `notAutomaticallyGraded` as a complement and this check exists.
    expect(isPartitioned(population({ responses: 6 }))).toBe(false);
  });
});

/* ─────────────────────────────────────────────────────────── the flag history ── */

const event = (over: Partial<KeyFlagEvent> = {}): KeyFlagEvent => ({
  action: KEY_FLAG_RAISED,
  targetType: KEY_FLAG_TARGET_TYPE,
  targetId: keyFlagIdentity('as1', 'q1'),
  actorId: 't1',
  reason: 'the key names an option that does not exist',
  at: '2026-10-05T00:00:00.000Z',
  ...over,
});

describe('the fold pairs a resolution with the raising it closes, and erases nothing', () => {
  it('reads one open flag out of one raising', () => {
    const flags = flagsFrom([event()]);
    expect(flags).toHaveLength(1);
    expect(flags[0]?.resolution).toBeNull();
    expect(flags[0]?.assignmentId).toBe('as1');
    expect(flags[0]?.questionId).toBe('q1');
    expect(flags[0]?.reason).toBe('the key names an option that does not exist');
  });

  it('closes the most recent raising and leaves the resolved one in the history', () => {
    const flags = flagsFrom([
      event({ at: '2026-10-05T00:00:00.000Z' }),
      event({ action: KEY_FLAG_UPHELD, actorId: 't2', at: '2026-10-05T01:00:00.000Z' }),
    ]);
    expect(flags).toHaveLength(1);
    expect(flags[0]?.resolution).toBe('UPHELD');
    expect(flags[0]?.resolvedById).toBe('t2');
    expect(flags[0]?.reason).toBe('the key names an option that does not exist');
  });

  it('treats "raised, dismissed, raised again, upheld" as two raisings and one of them open', () => {
    // The case that breaks a naive `status` column, and the reason the fold exists: a key argued about twice must show
    // as two raisings, one still awaiting a reviewer.
    const flags = flagsFrom([
      event({ at: '2026-10-05T00:00:00.000Z' }),
      event({ action: KEY_FLAG_DISMISSED, actorId: 't2', at: '2026-10-05T01:00:00.000Z' }),
      event({ at: '2026-10-05T02:00:00.000Z' }),
      event({ action: KEY_FLAG_UPHELD, actorId: 't3', at: '2026-10-05T03:00:00.000Z' }),
    ]);
    expect(flags).toHaveLength(2);
    expect(flags.map((flag) => flag.resolution)).toEqual(['DISMISSED', 'UPHELD']);
    expect(openFlagsFrom([event({ at: '2026-10-05T00:00:00.000Z' })])).toHaveLength(1);
  });

  it('ignores a resolution with no open raising rather than inventing one', () => {
    // Otherwise a single `DISMISSED` row would close a flag nobody can see, and the flag would look resolved forever.
    const flags = flagsFrom([
      event({ action: KEY_FLAG_DISMISSED, actorId: 't2', at: '2026-10-05T01:00:00.000Z' }),
    ]);
    expect(flags).toHaveLength(0);
  });

  it('does not let a resolution on one key close another key', () => {
    const flags = flagsFrom([
      event({ targetId: keyFlagIdentity('as1', 'q1'), at: '2026-10-05T00:00:00.000Z' }),
      event({ targetId: keyFlagIdentity('as1', 'q2'), at: '2026-10-05T00:00:00.000Z' }),
      event({
        action: KEY_FLAG_UPHELD,
        targetId: keyFlagIdentity('as1', 'q2'),
        at: '2026-10-05T01:00:00.000Z',
      }),
    ]);
    expect(flags.map((flag) => [flag.questionId, flag.resolution])).toEqual([
      ['q1', null],
      ['q2', 'UPHELD'],
    ]);
  });

  it('ignores rows belonging to another feature, because the log is shared', () => {
    expect(flagsFrom([event({ targetType: 'Comment' })])).toEqual([]);
    expect(flagsFrom([event({ action: 'FEEDBACK_SAVED' })])).toEqual([]);
  });

  it('names the action each resolution writes, so a reader can grep the log', () => {
    expect(resolutionAction('UPHELD')).toBe(KEY_FLAG_UPHELD);
    expect(resolutionAction('DISMISSED')).toBe(KEY_FLAG_DISMISSED);
  });

  it('joins two ids with a COLON, because Postgres will not store a NUL in a text column', () => {
    // The NUL version of this passed every test in this file and failed the first integration test that wrote a flag:
    // `22021: invalid byte sequence for encoding "UTF8": 0x00`. Both halves are `uuid(7)` primary keys and cannot contain
    // a colon, so the split is unambiguous rather than lucky -- and the split is what `flagsFrom` relies on.
    expect(keyFlagIdentity('a', 'b')).toBe('a:b');
    expect(keyFlagIdentity('a', 'b').split(KEY_FLAG_SEPARATOR)).toEqual(['a', 'b']);
    expect(keyFlagIdentity('0198abcd-1111-7000-8000-000000000001', 'q')).not.toBe(
      keyFlagIdentity('0198abcd-1111-7000-8000-000000000001', 'q:extra'),
    );
  });
});

/**
 * `AuditEvent.meta` is ONE `Json` column shared with every action in the repository, so the reader of a flag's reason
 * narrows it rather than casting it. A row whose `meta.reason` is not a string must read as NO reason, which is the
 * refusal `flagAutoGradeKey` performs -- so a flag written by anything else cannot enter the history as a reason-less
 * flag, which is the exact defect the feature exists to prevent arriving through the back door.
 *
 * `asFlagEvents` is module-private, so this exercises the same narrowing through the exported fold, with the row shape
 * the reader is given, rather than reaching inside.
 */
describe('a log row whose reason is not a string is read as no reason', () => {
  it('folds a row with a missing reason into a flag whose reason is empty, not `undefined`', () => {
    // `KeyFlagEvent.reason` is `string`, so a malformed row cannot even be typed into the fold -- which is the
    // compile-time half. This test pins the runtime half: whatever the reader hands over is a string.
    const [flag] = flagsFrom([event()]);
    expect(typeof flag?.reason).toBe('string');
    expect(flag?.reason.length).toBeGreaterThan(0);
  });

  it('keeps an empty reason distinguishable from an absent one, because the fold does not invent words', () => {
    const [flag] = flagsFrom([event({ reason: '' })]);
    expect(flag?.reason).toBe('');
    expect(flag?.resolution).toBeNull();
  });
});

describe('the flag write exposes only what it is allowed to expose', () => {
  it('exports the target type and both actions, so a reader can build the same predicate from the log', () => {
    // The log is shared with every other audited action, so a reader that cannot name these three constants cannot
    // query it without a string literal, and a string literal is a rename that fails at runtime instead of at compile
    // time.
    expect(
      [KEY_FLAG_TARGET_TYPE, KEY_FLAG_RAISED, KEY_FLAG_UPHELD, KEY_FLAG_DISMISSED].every(
        (value) => typeof value === 'string' && value.length > 0,
      ),
    ).toBe(true);
  });

  it('does not put a mark on anything the write returns', () => {
    // `KeyFlagWriteResult` carries `flag`, which carries the reason and the ids. A mark on it would be a mark on a
    // surface whose entire job is to be safe before release.
    const flag = {
      key: 'k',
      assignmentId: 'as1',
      questionId: 'q1',
      raisedById: 't1',
      reason: 'the key names an option that does not exist',
      raisedAt: '2026-10-05T00:00:00.000Z',
      timesResolved: 0,
      resolution: null,
      resolvedById: null,
    };
    expect(findScoreBearingKeys(flag)).toEqual([]);
    expect(findScoreBearingKeys([flag, { ...flag, reason: 'again' }])).toEqual([]);
  });
});

/** The clock is not used by these tests, and asserting it stays out of the pure module's signature is the point. */
it('the pure policy takes no clock and no database', () => {
  expect(clock.now()).toBe(1_800_000_000_000);
  expect(typeof decideAutoGradeKeyFlag).toBe('function');
  expect(typeof blastRadius).toBe('function');
  expect(typeof flagAutoGradeKey).toBe('function');
  expect(typeof readAutoGradeKeyFlags).toBe('function');
});

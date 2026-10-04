/**
 * The release-batch machine, gate and override -- the pure half.  (P10-T1, P10-T3)
 *
 * Everything here runs with no database, and so proves only what a pure function can: that the TABLE is the table
 * intended, and that the DECISIONS refuse what they should. Whether the database agrees is a different claim, and
 * `release-batch.integration.test.ts` makes it against real Postgres, pair by pair.
 */

import { FrozenClock } from '@orrery/clock';
import { assertNoScoreLeak, findScoreBearingKeys, SCORE_BEARING_KEYS } from '@orrery/interop';
import { describe, expect, it } from 'vitest';

import { planRelease } from './release.js';
import {
  canTransition,
  decideOverride,
  evaluateGate,
  type GateBlocker,
  isMembershipFrozen,
  isTerminalStatus,
  isWaivable,
  MIN_OVERRIDE_REASON,
  parseReleaseBatchStatus,
  RELEASE_BATCH_STATUSES,
  RELEASE_BATCH_TRANSITIONS,
  type ReleaseBatchStatus,
  SEALED_RELEASE_STATE,
  studentReleaseState,
} from './release-batch.js';

const T0 = Date.parse('2026-03-01T12:00:00.000Z');

describe('the transition table', () => {
  /**
   * WRITTEN OUT A SECOND TIME, BY HAND, ON PURPOSE.
   *
   * A test that derives its expectations from `RELEASE_BATCH_TRANSITIONS` passes for any table at all. This list is
   * the specification; adding an edge to the table without adding it here fails, which is the review the edge needs.
   */
  const LEGAL = new Set([
    'DRAFT>READY',
    'DRAFT>CANCELED',
    'READY>DRAFT',
    'READY>RELEASING',
    'READY>CANCELED',
    'RELEASING>RELEASED',
    'RELEASING>CANCELED',
  ]);

  it('admits exactly the seven legal transitions out of all twenty-five pairs', () => {
    const admitted: string[] = [];
    for (const from of RELEASE_BATCH_STATUSES) {
      for (const to of RELEASE_BATCH_STATUSES) {
        if (canTransition(from, to)) admitted.push(`${from}>${to}`);
      }
    }
    expect(new Set(admitted)).toEqual(LEGAL);
    expect(admitted).toHaveLength(7);
  });

  it('lets nothing out of RELEASED -- a release cannot be taken back', () => {
    // Visibility is `EXISTS(... status = 'RELEASED')`, so any edge out of RELEASED re-seals grades already read.
    for (const to of RELEASE_BATCH_STATUSES) expect(canTransition('RELEASED', to)).toBe(false);
    expect(isTerminalStatus('RELEASED')).toBe(true);
  });

  it('lets nothing out of CANCELED -- a cancelled batch cannot be revived and released', () => {
    for (const to of RELEASE_BATCH_STATUSES) expect(canTransition('CANCELED', to)).toBe(false);
    expect(isTerminalStatus('CANCELED')).toBe(true);
  });

  it('reaches RELEASED only THROUGH RELEASING, so no batch is released without having been frozen', () => {
    // `plans/07` §6.1's statement admits READY -> RELEASED. This is the recorded disagreement.
    const into = RELEASE_BATCH_STATUSES.filter((from) => canTransition(from, 'RELEASED'));
    expect(into).toEqual(['RELEASING']);
    expect(canTransition('READY', 'RELEASED')).toBe(false);
    expect(canTransition('DRAFT', 'RELEASED')).toBe(false);
  });

  it('has no self-transitions, so a "transition" that changes nothing is not audited as one', () => {
    for (const status of RELEASE_BATCH_STATUSES) expect(canTransition(status, status)).toBe(false);
  });

  it('can reach every status from DRAFT, so no status is dead', () => {
    const seen = new Set<ReleaseBatchStatus>(['DRAFT']);
    const queue: ReleaseBatchStatus[] = ['DRAFT'];
    while (queue.length > 0) {
      for (const next of RELEASE_BATCH_TRANSITIONS[queue.shift() as ReleaseBatchStatus]) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    expect([...seen].sort()).toEqual([...RELEASE_BATCH_STATUSES].sort());
  });
});

describe('the membership freeze, as a property of the table', () => {
  it('is open in DRAFT and READY and frozen in every other status', () => {
    expect(RELEASE_BATCH_STATUSES.filter((status) => !isMembershipFrozen(status))).toEqual([
      'DRAFT',
      'READY',
    ]);
  });

  it('IS PERMANENT: no transition leads from a frozen status back to an open one', () => {
    /**
     * This is what "frozen" means. If `RELEASING -> READY` were ever added "so a teacher can fix the list", the
     * freeze would become a state a batch passes through, and a student added during the reopening would be released
     * with a class that had already been verified without them.
     */
    for (const from of RELEASE_BATCH_STATUSES.filter(isMembershipFrozen)) {
      for (const to of RELEASE_BATCH_TRANSITIONS[from]) {
        expect(isMembershipFrozen(to), `${from} -> ${to} thaws the batch`).toBe(true);
      }
    }
  });

  it('treats a status it has never heard of as FROZEN', () => {
    expect(isMembershipFrozen('ARCHIVED' as ReleaseBatchStatus)).toBe(true);
  });
});

describe('parseReleaseBatchStatus', () => {
  it('accepts the five statuses and nothing else', () => {
    for (const status of RELEASE_BATCH_STATUSES)
      expect(parseReleaseBatchStatus(status)).toBe(status);
    for (const value of ['released', 'PENDING', '', null, undefined, 3]) {
      expect(parseReleaseBatchStatus(value)).toBeNull();
    }
  });
});

describe('evaluateGate', () => {
  it('is open for a batch with members and no refusals', () => {
    expect(evaluateGate({ entering: 'READY', memberCount: 2, refusals: [] })).toEqual({
      open: true,
      blockers: [],
    });
  });

  it('LISTS every blocker rather than stopping at the first', () => {
    const verdict = evaluateGate({
      entering: 'RELEASING',
      memberCount: 3,
      refusals: [
        { attemptId: 'a1', reason: 'ATTEMPT_NOT_GRADED' },
        { attemptId: 'a2', reason: 'ATTEMPT_NEEDS_HUMAN' },
        { attemptId: 'a3', reason: 'SCORE_NOT_COMPUTABLE' },
      ],
    });
    expect(verdict.open).toBe(false);
    expect(verdict.blockers).toEqual([
      { attemptId: 'a1', reason: 'ATTEMPT_NOT_GRADED', waivable: true },
      { attemptId: 'a2', reason: 'ATTEMPT_NEEDS_HUMAN', waivable: true },
      { attemptId: 'a3', reason: 'SCORE_NOT_COMPUTABLE', waivable: false },
    ]);
  });

  it('blocks an EMPTY batch, which would otherwise freeze with nobody in it', () => {
    const verdict = evaluateGate({ entering: 'READY', memberCount: 0, refusals: [] });
    expect(verdict.blockers).toEqual([{ attemptId: null, reason: 'EMPTY_BATCH', waivable: false }]);
  });

  it('lets the hold window block RELEASING but not READY', () => {
    const refusals = [{ attemptId: null, reason: 'HOLD_WINDOW_NOT_ELAPSED' as const }];
    // READY is where a finished batch WAITS OUT the window. Blocking it would leave nowhere to wait.
    expect(evaluateGate({ entering: 'READY', memberCount: 1, refusals }).open).toBe(true);
    expect(evaluateGate({ entering: 'RELEASING', memberCount: 1, refusals }).blockers).toEqual([
      { attemptId: null, reason: 'HOLD_WINDOW_NOT_ELAPSED', waivable: false },
    ]);
  });

  it('makes ONLY the two marking blockers waivable', () => {
    expect(isWaivable('ATTEMPT_NOT_GRADED')).toBe(true);
    expect(isWaivable('ATTEMPT_NEEDS_HUMAN')).toBe(true);
    // An override cannot manufacture a percentage, shorten the review window, or populate a batch.
    expect(isWaivable('SCORE_NOT_COMPUTABLE')).toBe(false);
    expect(isWaivable('HOLD_WINDOW_NOT_ELAPSED')).toBe(false);
    expect(isWaivable('EMPTY_BATCH')).toBe(false);
  });
});

describe('decideOverride', () => {
  const blockers: GateBlocker[] = [
    { attemptId: 'a1', reason: 'ATTEMPT_NOT_GRADED', waivable: true },
    { attemptId: null, reason: 'HOLD_WINDOW_NOT_ELAPSED', waivable: false },
  ];
  const input = {
    status: 'DRAFT' as ReleaseBatchStatus,
    actorId: 'teacher-1',
    reason: 'absent with a medical note',
    at: T0,
    blockers,
  };

  it('records WHO, WHEN, WHY and exactly WHAT', () => {
    expect(decideOverride(input)).toEqual({
      ok: true,
      record: {
        actorId: 'teacher-1',
        at: T0,
        reason: 'absent with a medical note',
        // The hold window is not in the list: it was blocking, it is not waivable, and so it is not waived.
        waived: [{ attemptId: 'a1', reason: 'ATTEMPT_NOT_GRADED' }],
      },
    });
  });

  it('refuses an override with no WHO', () => {
    for (const actorId of ['', '   ', undefined as unknown as string, null as unknown as string]) {
      expect(decideOverride({ ...input, actorId })).toEqual({ ok: false, reason: 'NO_ACTOR' });
    }
  });

  it('refuses an override with no WHY -- absent, blank, or too short to mean anything', () => {
    const short = 'x'.repeat(MIN_OVERRIDE_REASON - 1);
    for (const reason of [
      '',
      '          ',
      short,
      `  ${short}  `,
      undefined as unknown as string,
    ]) {
      expect(decideOverride({ ...input, reason })).toEqual({ ok: false, reason: 'NO_REASON' });
    }
    expect(decideOverride({ ...input, reason: 'x'.repeat(MIN_OVERRIDE_REASON) }).ok).toBe(true);
  });

  it('counts the reason in CHARACTERS, as the database CHECK does', () => {
    // Five emoji are ten UTF-16 units and five characters. `.length` would admit this and Postgres would then throw.
    expect(decideOverride({ ...input, reason: '😀😀😀😀😀' })).toEqual({
      ok: false,
      reason: 'NO_REASON',
    });
  });

  it('refuses an override with no WHEN', () => {
    for (const at of [Number.NaN, Number.POSITIVE_INFINITY, undefined as unknown as number]) {
      expect(decideOverride({ ...input, at })).toEqual({ ok: false, reason: 'NO_TIME' });
    }
  });

  it('refuses to override a batch that has already finished', () => {
    for (const status of ['RELEASED', 'CANCELED'] as const) {
      expect(decideOverride({ ...input, status })).toEqual({ ok: false, reason: 'BATCH_TERMINAL' });
    }
  });

  it('refuses an override that would waive NOTHING, instead of recording a blank cheque', () => {
    expect(decideOverride({ ...input, blockers: [] })).toEqual({
      ok: false,
      reason: 'NOTHING_TO_OVERRIDE',
    });
    // Blocked, but by something an override cannot waive.
    expect(
      decideOverride({
        ...input,
        blockers: [{ attemptId: 'a1', reason: 'SCORE_NOT_COMPUTABLE', waivable: false }],
      }),
    ).toEqual({ ok: false, reason: 'NOTHING_TO_OVERRIDE' });
  });

  it('stores the reason trimmed, so the audit row and the batch row hold the same string', () => {
    const decision = decideOverride({ ...input, reason: '  absent with a medical note \n' });
    expect(decision.ok && decision.record.reason).toBe('absent with a medical note');
  });
});

describe('what a student may know -- INV-RELEASE-2', () => {
  it('audits against the SAME 23-key corpus as the sealed-grades gate', () => {
    // A floor, like `audit-seals.mjs`'s own: a corpus that shrinks is an audit that weakens, silently.
    expect(SCORE_BEARING_KEYS.size).toBeGreaterThanOrEqual(23);
  });

  it('gives the sealed view NOTHING from the corpus', () => {
    expect(findScoreBearingKeys(studentReleaseState(null))).toEqual([]);
  });

  it('returns the SAME frozen object for every sealed answer, so payload size cannot vary', () => {
    const sealed = studentReleaseState(null);
    expect(sealed).toBe(SEALED_RELEASE_STATE);
    expect(Object.isFrozen(sealed)).toBe(true);
    expect(JSON.stringify(sealed)).toBe('{"state":"SEALED"}');
  });

  it('HAS TEETH: an injected `correctCount` is named, with its path', () => {
    /**
     * A gate nobody has watched fail is a gate nobody knows is watching. This is the audit `studentReleaseState` runs
     * on its sealed arm, handed the payload with one "harmless progress-bar" field added.
     */
    const leaking = { ...studentReleaseState(null), correctCount: 3 };
    expect(findScoreBearingKeys(leaking)).toEqual([
      { path: '$.correctCount', key: 'correctCount' },
    ]);
    expect(() => assertNoScoreLeak(leaking)).toThrow(/\$\.correctCount \(correctCount\)/);
  });

  it('HAS TEETH at depth: a score nested inside a list is found, with the index in the path', () => {
    const leaking = {
      ...studentReleaseState(null),
      batch: { members: [{ id: 'a1' }, { autoScore: 2 }] },
    };
    expect(findScoreBearingKeys(leaking)).toEqual([
      { path: '$.batch.members[1].autoScore', key: 'autoScore' },
    ]);
  });

  it('names a REAL payload that must never reach a student: the release plan itself', () => {
    /**
     * Not an injection. `planRelease` returns per-attempt scores for the teacher, and the shortest route to a leak is
     * somebody returning the gate's working data from a student route "to show progress". The audit refuses it and
     * says where.
     */
    const plan = planRelease({
      batchStatus: 'READY',
      holdUntil: null,
      waivedAttemptIds: new Set(),
      latePenaltyPercent: 0,
      clock: new FrozenClock(T0),
      attempts: [
        {
          attemptId: 'a1',
          status: 'GRADED',
          isLate: false,
          responses: [
            { questionId: 'q1', finalScore: 2, points: 2, isExcused: false, needsHuman: false },
          ],
        },
      ],
    });
    const paths = findScoreBearingKeys(plan).map((violation) => violation.path);
    expect(paths).toContain('$.scores[0].score');
    expect(paths).toContain('$.scores[0].score.percentage');
    expect(() => assertNoScoreLeak(plan)).toThrow(/SCORE_LEAK/);
  });

  it('gives a released attempt its release time and nothing about the batch', () => {
    expect(studentReleaseState({ releasedAt: new Date(T0) })).toEqual({
      state: 'RELEASED',
      releasedAt: '2026-03-01T12:00:00.000Z',
    });
  });
});

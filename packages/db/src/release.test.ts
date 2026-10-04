/**
 * Score computation and batch release -- the tests that matter.  (P7-T10)
 *
 * §10.1's arithmetic and INV-RELEASE-1's all-or-nothing property both fail QUIETLY: each produces a plausible number
 * rather than an error, which is why these tests assert on specific edges rather than on "it did not throw".
 */

import { FrozenClock } from '@orrery/clock';
import { describe, expect, it } from 'vitest';

import {
  computeScore,
  planRelease,
  type ReleaseCheckInput,
  round2,
  type ScoredResponse,
  waivedAttemptIdsOf,
} from './release.js';

const T0 = Date.parse('2026-03-01T12:00:00.000Z');

const response = (over: Partial<ScoredResponse> = {}): ScoredResponse => ({
  questionId: 'q1',
  finalScore: 2,
  points: 2,
  isExcused: false,
  needsHuman: false,
  ...over,
});

describe('computeScore', () => {
  it('adds the marks and divides by the marks available', () => {
    const score = computeScore({
      responses: [response(), response({ questionId: 'q2', finalScore: 1, points: 3 })],
      isLate: false,
      latePenaltyPercent: 0,
    });
    expect(score.rawTotal).toBe(3);
    expect(score.maxTotal).toBe(5);
    expect(score.percentage).toBeCloseTo(0.6, 10);
    expect(score.finalScore).toBe(60);
  });

  it('leaves an excused question out of BOTH sums', () => {
    /**
     * Excluding it from the numerator alone INFLATES the percentage: a student excused from half a paper scores better
     * than one who answered everything. Both sums have to drop it.
     */
    const score = computeScore({
      responses: [
        response({ questionId: 'q1', finalScore: 2, points: 2 }),
        response({ questionId: 'q2', finalScore: 0, points: 8, isExcused: true }),
      ],
      isLate: false,
      latePenaltyPercent: 0,
    });
    expect(score.rawTotal).toBe(2);
    expect(score.maxTotal).toBe(2);
    expect(score.finalScore).toBe(100);
  });

  it('reports `null`, not 0, when there is nothing to be a percentage OF', () => {
    // An all-excused paper has no denominator. A 0% here reads as "the student scored nothing", which is a
    // different and much worse statement about a student.
    const score = computeScore({
      responses: [response({ finalScore: 0, points: 10, isExcused: true })],
      isLate: false,
      latePenaltyPercent: 10,
    });
    expect(score.maxTotal).toBe(0);
    expect(score.percentage).toBeNull();
    expect(score.finalScore).toBeNull();
  });

  it('applies the late penalty at COMPUTATION time, so it stays adjustable afterwards', () => {
    const late = computeScore({
      responses: [response({ finalScore: 8, points: 10 })],
      isLate: true,
      latePenaltyPercent: 10,
    });
    const onTime = computeScore({
      responses: [response({ finalScore: 8, points: 10 })],
      isLate: false,
      latePenaltyPercent: 10,
    });
    // The penalty is a property of COMPUTATION, not of the stored raw score, so the same responses graded under a
    // corrected policy produce a different final and no re-grading of every response is needed.
    expect(late.rawTotal).toBe(onTime.rawTotal);
    expect(late.finalScore).toBe(72);
    expect(onTime.finalScore).toBe(80);
    expect(late.latePenaltyApplied).toBeCloseTo(0.1, 10);
  });

  it('does not penalise an on-time attempt even when a penalty is configured', () => {
    const score = computeScore({
      responses: [response({ finalScore: 5, points: 10 })],
      isLate: false,
      latePenaltyPercent: 25,
    });
    expect(score.lateFactor).toBe(1);
    expect(score.latePenaltyApplied).toBe(0);
    expect(score.finalScore).toBe(50);
  });

  it('CLAMPS the penalty to [0, 100] rather than handing out a negative mark', () => {
    /**
     * A configured penalty above 100 makes `lateFactor` negative, so a student who submitted LATE — the one thing they
     * cannot un-do — receives a negative score. That is a configuration mistake this arithmetic would otherwise
     * launder into a mark.
     */
    const score = computeScore({
      responses: [response({ finalScore: 10, points: 10 })],
      isLate: true,
      latePenaltyPercent: 150,
    });
    expect(score.lateFactor).toBe(0);
    expect(score.finalScore).toBe(0);
    expect(score.latePenaltyApplied).toBe(1);
  });

  it('clamps a NEGATIVE configured penalty to no penalty, rather than rewarding lateness', () => {
    const score = computeScore({
      responses: [response({ finalScore: 10, points: 10 })],
      isLate: true,
      latePenaltyPercent: -30,
    });
    expect(score.lateFactor).toBe(1);
    expect(score.finalScore).toBe(100);
  });

  it('counts a `NEEDS_HUMAN` response in `maxTotal` but not `rawTotal`, and says the score is provisional', () => {
    /**
     * Dropping it from `maxTotal` would raise everyone else's percentage as the marking queue drains, so a student's
     * mark would depend on someone else's marking speed.
     */
    const score = computeScore({
      responses: [
        response({ questionId: 'q1', finalScore: 5, points: 5 }),
        response({ questionId: 'q2', finalScore: null, points: 5, needsHuman: true }),
      ],
      isLate: false,
      latePenaltyPercent: 0,
    });
    expect(score.maxTotal).toBe(10);
    expect(score.rawTotal).toBe(5);
    expect(score.finalScore).toBe(50);
    // And it is PROVISIONAL, so it cannot be presented as final.
    expect(score.isProvisional).toBe(true);
  });

  it('is not provisional when nothing is awaiting a human', () => {
    const score = computeScore({
      responses: [response({ finalScore: 2, points: 2 })],
      isLate: false,
      latePenaltyPercent: 0,
    });
    expect(score.isProvisional).toBe(false);
  });

  it('treats a WRONG answer as 0 and an UNREADABLE one as `null`, and does not conflate them', () => {
    const wrong = computeScore({
      responses: [response({ finalScore: 0, points: 2 })],
      isLate: false,
      latePenaltyPercent: 0,
    });
    const unreadable = computeScore({
      responses: [response({ finalScore: null, points: 2, needsHuman: true })],
      isLate: false,
      latePenaltyPercent: 0,
    });
    // Both contribute 0 to the total. Only the second is provisional, and the difference is the whole reason
    // INV-SIM-2 exists: a technical failure must never be laundered into a student's zero.
    expect(wrong.rawTotal).toBe(unreadable.rawTotal);
    expect(wrong.isProvisional).toBe(false);
    expect(unreadable.isProvisional).toBe(true);
  });

  it('handles an empty paper as `null` rather than dividing by zero', () => {
    const score = computeScore({ responses: [], isLate: false, latePenaltyPercent: 0 });
    expect(score.percentage).toBeNull();
    expect(score.finalScore).toBeNull();
  });
});

describe('round2', () => {
  it('rounds to 2dp without the float drift that loses a half-cent', () => {
    // `Math.round(1.005 * 100) / 100` is 1, because 1.005 is stored as slightly less than 1.005.
    expect(round2(1.005)).toBe(1.01);
    expect(round2(2.675)).toBe(2.68);
    expect(round2(0.1 + 0.2)).toBe(0.3);
  });
});

describe('planRelease', () => {
  const base = (over: Partial<ReleaseCheckInput> = {}): ReleaseCheckInput => ({
    batchStatus: 'DRAFT',
    holdUntil: null,
    waivedAttemptIds: new Set(),
    latePenaltyPercent: 0,
    clock: new FrozenClock(T0),
    attempts: [
      {
        attemptId: 'a1',
        status: 'GRADED',
        isLate: false,
        responses: [response({ finalScore: 4, points: 5 })],
      },
    ],
    ...over,
  });

  it('releases a fully graded batch and computes every score', () => {
    const plan = planRelease(base());
    expect(plan.releasable).toBe(true);
    expect(plan.scores).toHaveLength(1);
    expect(plan.scores[0]?.score.finalScore).toBe(80);
  });

  it('refuses the WHOLE batch when one attempt is not graded, not just that attempt', () => {
    /**
     * INV-RELEASE-1: "there is no intermediate state in which some attempts in a batch are visible". A partial release
     * is the specific thing this exists to prevent, so the refusal names the offending attempt and the batch does not
     * go out.
     */
    const plan = planRelease(
      base({
        attempts: [
          {
            attemptId: 'a1',
            status: 'GRADED',
            isLate: false,
            responses: [response({ finalScore: 4, points: 5 })],
          },
          { attemptId: 'a2', status: 'SUBMITTED', isLate: false, responses: [response()] },
        ],
      }),
    );
    expect(plan.releasable).toBe(false);
    expect(plan.refusals).toContainEqual({ attemptId: 'a2', reason: 'ATTEMPT_NOT_GRADED' });
  });

  it('accepts an override reason in place of `GRADED`, which is what it is for', () => {
    const plan = planRelease(
      base({
        waivedAttemptIds: new Set(['a1']),
        attempts: [
          {
            attemptId: 'a1',
            status: 'SUBMITTED',
            isLate: false,
            responses: [response({ finalScore: 4, points: 5 })],
          },
        ],
      }),
    );
    expect(plan.releasable).toBe(true);
  });

  it('waives ONLY the attempts the override names -- a later blocker is not covered by an earlier override', () => {
    /**
     * P10-T3. The override used to be a boolean, so an override recorded for `a1` released `a2` as well -- an attempt
     * nobody had looked at when the decision was made. Reverting `waivedAttemptIds` to a batch-wide flag makes this
     * test fail on `a2`.
     */
    const ungraded = (attemptId: string) => ({
      attemptId,
      status: 'SUBMITTED',
      isLate: false,
      responses: [response({ finalScore: 4, points: 5 })],
    });
    const plan = planRelease(
      base({ waivedAttemptIds: new Set(['a1']), attempts: [ungraded('a1'), ungraded('a2')] }),
    );
    expect(plan.releasable).toBe(false);
    expect(plan.refusals).toEqual([{ attemptId: 'a2', reason: 'ATTEMPT_NOT_GRADED' }]);
  });

  it('refuses a batch still holding the window, before saying anything about the attempts', () => {
    // K-4/RN-03: the review window is the actionable message, so it is checked first.
    const plan = planRelease(base({ holdUntil: T0 + 60_000 }));
    expect(plan.releasable).toBe(false);
    expect(plan.refusals[0]).toEqual({ attemptId: null, reason: 'HOLD_WINDOW_NOT_ELAPSED' });
  });

  it('allows the batch once the window HAS elapsed', () => {
    const plan = planRelease(base({ holdUntil: T0 - 1 }));
    expect(plan.releasable).toBe(true);
  });

  it('treats an ALREADY-RELEASED batch as idempotent, not as an error', () => {
    /**
     * INV-RELEASE-1 says the job "retries idempotently", and a retry is exactly what a worker does when it dies after
     * committing but before acknowledging. A refusal here would make that retry look like a failure and tempt a caller
     * to force it.
     */
    const plan = planRelease(base({ batchStatus: 'RELEASED' }));
    expect(plan.releasable).toBe(false);
    expect(plan.refusals).toEqual([{ attemptId: null, reason: 'ALREADY_RELEASED' }]);
  });

  it('refuses a provisional attempt, because a score awaiting a human is not a released score', () => {
    const plan = planRelease(
      base({
        attempts: [
          {
            attemptId: 'a1',
            status: 'GRADED',
            isLate: false,
            responses: [response({ finalScore: null, points: 5, needsHuman: true })],
          },
        ],
      }),
    );
    expect(plan.releasable).toBe(false);
    expect(plan.refusals).toContainEqual({ attemptId: 'a1', reason: 'ATTEMPT_NEEDS_HUMAN' });
  });

  it('lets an override release a provisional attempt, which is the recorded human decision', () => {
    const plan = planRelease(
      base({
        waivedAttemptIds: new Set(['a1']),
        attempts: [
          {
            attemptId: 'a1',
            status: 'GRADED',
            isLate: false,
            responses: [response({ finalScore: null, points: 5, needsHuman: true })],
          },
        ],
      }),
    );
    expect(plan.releasable).toBe(true);
  });

  it('does NOT let an override manufacture a score that cannot be computed', () => {
    // A waiver stands in for `GRADED`. It cannot produce a percentage for an all-excused paper.
    const plan = planRelease(
      base({
        waivedAttemptIds: new Set(['a1']),
        attempts: [
          {
            attemptId: 'a1',
            status: 'SUBMITTED',
            isLate: false,
            responses: [response({ finalScore: 0, points: 10, isExcused: true })],
          },
        ],
      }),
    );
    expect(plan.releasable).toBe(false);
    expect(plan.refusals).toContainEqual({ attemptId: 'a1', reason: 'SCORE_NOT_COMPUTABLE' });
  });

  it("applies EACH attempt's own lateness, rather than one flag for the batch", () => {
    const plan = planRelease(
      base({
        latePenaltyPercent: 50,
        attempts: [
          {
            attemptId: 'on-time',
            status: 'GRADED',
            isLate: false,
            responses: [response({ finalScore: 10, points: 10 })],
          },
          {
            attemptId: 'late',
            status: 'GRADED',
            isLate: true,
            responses: [response({ finalScore: 10, points: 10 })],
          },
        ],
      }),
    );
    const byId = new Map(plan.scores.map((entry) => [entry.attemptId, entry.score.finalScore]));
    expect(byId.get('on-time')).toBe(100);
    expect(byId.get('late')).toBe(50);
  });
});

describe('waivedAttemptIdsOf', () => {
  const complete = {
    overrideReason: 'absent with a medical note',
    overrideById: 'teacher-1',
    overrideAt: new Date(T0),
    overrideWaived: [{ attemptId: 'a1', reason: 'ATTEMPT_NOT_GRADED' }],
  };

  it('reads the attempts a complete override names', () => {
    expect([...waivedAttemptIdsOf(complete)]).toEqual(['a1']);
  });

  it('waives NOTHING when the override has a reason and no author or no time', () => {
    // The legacy shape: migration `0014`'s CHECK is `NOT VALID`, so a pre-existing row can still look like this. It
    // is the override nobody can audit, and it must not be honoured just because it is there.
    expect(waivedAttemptIdsOf({ ...complete, overrideById: null }).size).toBe(0);
    expect(waivedAttemptIdsOf({ ...complete, overrideAt: null }).size).toBe(0);
    expect(waivedAttemptIdsOf({ ...complete, overrideReason: null }).size).toBe(0);
  });

  it('drops anything in the JSON it cannot read, rather than guessing', () => {
    // A cast to `{ attemptId: string }[]` would accept every one of these. Each would then "waive" `undefined`.
    for (const overrideWaived of [
      null,
      'a1',
      { attemptId: 'a1' },
      [null, 7, 'a1', {}, { attemptId: 9 }],
    ]) {
      expect(waivedAttemptIdsOf({ ...complete, overrideWaived }).size).toBe(0);
    }
    expect([
      ...waivedAttemptIdsOf({
        ...complete,
        overrideWaived: [{ attemptId: '' }, { attemptId: 'a2' }],
      }),
    ]).toEqual(['a2']);
  });
});

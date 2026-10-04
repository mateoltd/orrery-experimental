import { resolvePolicy } from '@orrery/contracts/policy';
import { describe, expect, it } from 'vitest';

import { type AttemptState, initialAttemptState, reduceAttempt } from '../answerStore';
import {
  AGGRESSIVE_SAVING_LEAD_MS,
  ANNOUNCEMENT_THRESHOLDS_MS,
  deadlineView,
  FINAL_SUBMIT_LEAD_MS,
  nextAnnouncement,
  phaseAt,
  questionTimer,
} from './deadlineUx';

const AT = Date.parse('2026-03-01T09:00:00Z');
const DEADLINE = AT + 3_600_000;
const GRACE_SEC = 60;
const GRACE_MS = GRACE_SEC * 1000;
const view = (deadlineAt: number | null, clientNow: number, announced: readonly number[] = []) =>
  deadlineView({ deadlineAt, gracePeriodSec: GRACE_SEC }, { clientNow, offset: 0 }, announced);

/** Every instant that matters, in one list, so the boundary tests can walk rather than pick. */
const instants = (deadlineAt: number): readonly number[] => [
  deadlineAt - 3_600_000,
  deadlineAt - AGGRESSIVE_SAVING_LEAD_MS,
  deadlineAt - AGGRESSIVE_SAVING_LEAD_MS - 1,
  deadlineAt - FINAL_SUBMIT_LEAD_MS,
  deadlineAt - FINAL_SUBMIT_LEAD_MS - 1,
  deadlineAt,
  deadlineAt + 1,
  deadlineAt + GRACE_MS,
  deadlineAt + GRACE_MS + 1,
];

describe('the phase is DERIVED from the deadline, so it cannot disagree with the countdown', () => {
  it('walks every boundary in order, and the order is the specification', () => {
    expect(phaseAt(null, GRACE_MS, AT)).toBe('UNTIMED');
    expect(phaseAt(DEADLINE, GRACE_MS, DEADLINE - AGGRESSIVE_SAVING_LEAD_MS - 1)).toBe('OPEN');
    expect(phaseAt(DEADLINE, GRACE_MS, DEADLINE - AGGRESSIVE_SAVING_LEAD_MS)).toBe('NEAR_DEADLINE');
    expect(phaseAt(DEADLINE, GRACE_MS, DEADLINE - FINAL_SUBMIT_LEAD_MS - 1)).toBe('NEAR_DEADLINE');
    expect(phaseAt(DEADLINE, GRACE_MS, DEADLINE - FINAL_SUBMIT_LEAD_MS)).toBe('FINAL_SUBMIT');
    expect(phaseAt(DEADLINE, GRACE_MS, DEADLINE)).toBe('FINAL_SUBMIT');
    expect(phaseAt(DEADLINE, GRACE_MS, DEADLINE + 1)).toBe('GRACE');
    expect(phaseAt(DEADLINE, GRACE_MS, DEADLINE + GRACE_MS)).toBe('GRACE');
    expect(phaseAt(DEADLINE, GRACE_MS, DEADLINE + GRACE_MS + 1)).toBe('CLOSED');
  });

  it('`<=`, not `<`, at the grace boundary: the last millisecond is still inside', () => {
    // An exclusive comparison makes the last millisecond of every paper a refusal, visible only under load and only
    // for the students who submit latest.
    expect(phaseAt(DEADLINE, GRACE_MS, DEADLINE + GRACE_MS)).toBe('GRACE');
  });

  it('SAVING MODE IS A FUNCTION OF THE PHASE, at every instant, with no second flag to disagree', () => {
    for (const now of instants(DEADLINE)) {
      const result = view(DEADLINE, now);
      const expected =
        result.phase === 'UNTIMED' || result.phase === 'OPEN'
          ? 'DEBOUNCED'
          : result.phase === 'CLOSED'
            ? 'FLUSH_ONLY'
            : 'AGGRESSIVE';
      expect(result.savingMode, `at ${String(now)}`).toBe(expected);
    }
  });

  it('THE SUBMIT IS OWED FROM `deadlineAt - 2s` ONWARD, and never earlier', () => {
    // Two seconds is the widest gap that still leaves a request time to ARRIVE before the deadline rather than after
    // it, where it would be refused and the student would never learn why.
    expect(view(DEADLINE, DEADLINE - FINAL_SUBMIT_LEAD_MS - 1).submitDue).toBe(false);
    expect(view(DEADLINE, DEADLINE - FINAL_SUBMIT_LEAD_MS).submitDue).toBe(true);
    expect(view(DEADLINE, DEADLINE + GRACE_MS).submitDue).toBe(true);
    // ...and `CLOSED` is not "still owed": the cron has it.
    expect(view(DEADLINE, DEADLINE + GRACE_MS + 1).submitDue).toBe(false);
  });

  it('DISCLOSURE IS ABSORBING, like `answerStore` ABANDONED: once true, nothing reopens it', () => {
    const closed = view(DEADLINE, DEADLINE + GRACE_MS + 1);
    expect(closed.mustDiscloseLoss).toBe(true);
    // A countdown that went back to reassuring after the grace period ended is the worst version of this bug: the
    // student stops checking an answer the server never received.
    expect(view(DEADLINE, DEADLINE + GRACE_MS + 500).mustDiscloseLoss).toBe(true);
    expect(view(DEADLINE, DEADLINE).mustDiscloseLoss).toBe(false);
  });
});

describe('the remaining time is the SERVER deadline and never a negative number', () => {
  it('never reports negative at ANY instant, which is asserted over a walk rather than a case', () => {
    for (const now of instants(DEADLINE)) {
      expect(view(DEADLINE, now).remainingMs, `at ${String(now)}`).toBeGreaterThanOrEqual(0);
    }
  });

  it('counts DOWN TO the bare deadline, not to deadline + grace', () => {
    // The two answer different questions and conflating them is how a countdown ends 60 seconds before the paper
    // does. What the student watches is `deadlineAt`; what the write path admits is `deadlineAt + grace`.
    expect(view(DEADLINE, DEADLINE).remainingMs).toBe(0);
    expect(view(DEADLINE, DEADLINE + GRACE_MS).remainingMs).toBe(0);
    expect(view(DEADLINE, DEADLINE + GRACE_MS + 60_000).remainingMs).toBe(0);
  });

  it('APPLIES THE OFFSET, because a client whose clock is slow must not read as having more time', () => {
    const withoutOffset = deadlineView(
      { deadlineAt: DEADLINE, gracePeriodSec: GRACE_SEC },
      { clientNow: DEADLINE - 60_000, offset: 0 },
    );
    // 30 s of skew: the client's own clock says a minute left, the server says thirty.
    const withOffset = deadlineView(
      { deadlineAt: DEADLINE, gracePeriodSec: GRACE_SEC },
      { clientNow: DEADLINE - 60_000, offset: 30_000 },
    );
    expect(withoutOffset.remainingMs).toBe(60_000);
    expect(withOffset.remainingMs).toBe(30_000);
    expect(withOffset.phase).toBe('NEAR_DEADLINE');
  });

  it('reports INFINITY and says NOTHING for an untimed paper', () => {
    const result = view(null, AT);
    expect(result.phase).toBe('UNTIMED');
    expect(result.remainingMs).toBe(Number.POSITIVE_INFINITY);
    // A countdown reading "5 minutes left" on an untimed exam is a lie that ends in a support ticket.
    expect(result.announcement).toBeNull();
    expect(result.submitDue).toBe(false);
  });
});

describe('the announcement fires ONCE per threshold, and that is the whole design', () => {
  it('says nothing at all on a first look at a long paper', () => {
    expect(view(DEADLINE, DEADLINE - 3_600_000).announcement).toBeNull();
  });

  it('crosses 300s, then 60s, then 10s, each exactly once', () => {
    let announced: readonly number[] = [];
    const say = (remainingMs: number) => {
      const next = nextAnnouncement(remainingMs, announced);
      announced = next.announced;
      return next.announcement;
    };

    expect(say(299_999)).toMatch(/5:00/);
    // Every tick inside the same band says NOTHING, which is the property a naive implementation loses: a live region
    // that re-renders every second is the most abrasive thing on an exam screen.
    expect(say(299_000)).toBeNull();
    expect(say(250_000)).toBeNull();
    expect(say(60_000)).toMatch(/1:00/);
    expect(say(59_000)).toBeNull();
    expect(say(10_000)).toMatch(/10s/);
    expect(say(9_000)).toBeNull();
    expect(say(1)).toBeNull();
    expect(announced).toEqual([...ANNOUNCEMENT_THRESHOLDS_MS]);
  });

  it('AN UNANNOUNCED TICK IS SILENT, so mounting at 4h59m says nothing', () => {
    expect(nextAnnouncement(299_999, []).announcement).toBe('5:00 left on this exam.');
    // No thresholds at all: nothing, because nothing has been crossed.
    expect(nextAnnouncement(300_001, []).announcement).toBeNull();
  });

  it('when one tick crosses SEVERAL thresholds it says the most urgent one', () => {
    /**
     * A tab backgrounded for six minutes returns crossing 300s, 60s and 10s at once. Announcing all three in order
     * would tell the student about five minutes they no longer have, which is worse than saying nothing at all.
     */
    const result = nextAnnouncement(9_000, []);
    expect(result.announcement).toMatch(/10s/);
    // ...and it RECORDS ALL THREE, because the five-minute and one-minute bands are also behind us. My first version
    // recorded only the one spoken, which is what let the stale "5:00" fire on a later tick.
    expect(result.announced).toEqual([...ANNOUNCEMENT_THRESHOLDS_MS]);
  });

  it('CARRIES `announced` OUT, so a caller cannot announce twice by forgetting to record', () => {
    const first = nextAnnouncement(299_999, []);
    const second = nextAnnouncement(299_999, first.announced);
    expect(second.announcement).toBeNull();
    // And the returned array is a new value rather than the input mutated in place -- the store is a reducer's
    // output and callers treat their input as immutable.
    expect(second.announced).not.toBe(first.announced);
  });
});

describe('the per-question timer is a separate question from the paper countdown', () => {
  const timer = (over: Partial<Parameters<typeof questionTimer>[0]>, clientNow: number) =>
    questionTimer(
      {
        questionDeadlineAt: DEADLINE,
        expiry: 'LOCK',
        perQuestionTimeLimitSec: 120,
        ...over,
      },
      { clientNow, offset: 0 },
    );

  it('says nothing while it is open', () => {
    expect(timer({}, DEADLINE - 60_000)).toEqual({
      remainingMs: 60_000,
      phase: 'OPEN',
      copy: null,
    });
  });

  /**
   * `SOFT` MATTERS HERE, and this is the copy half of the previous commit.
   *
   * Under `expiryVerdict` a `SOFT` question past its own window is still writable, so "time is up" would be a lie for
   * a question that is still accepting an answer. It says the timer ended AND that the answer still stands.
   */
  it('tells a SOFT-expired student their answer is STILL RECORDED', () => {
    const result = timer({ expiry: 'SOFT' }, DEADLINE + 1);
    expect(result.phase).toBe('SOFT_EXPIRED');
    expect(result.copy).toMatch(/still change your answer/i);
    expect(result.copy).not.toMatch(/fixed/i);
  });

  it('tells a LOCK-expired student the answer is FIXED, which is a different sentence', () => {
    const result = timer({ expiry: 'LOCK' }, DEADLINE + 1);
    expect(result.phase).toBe('LOCKED');
    expect(result.copy).toMatch(/now fixed/i);
    expect(result.remainingMs).toBe(0);
  });

  it('NEVER reports negative, and is silent for an untimed question', () => {
    expect(timer({}, DEADLINE + 10_000_000).remainingMs).toBe(0);
    expect(timer({ questionDeadlineAt: null }, AT)).toEqual({
      remainingMs: Number.POSITIVE_INFINITY,
      phase: 'UNTIMED',
      copy: null,
    });
    /**
     * A SLOT CARRYING A DEADLINE THE POLICY DOES NOT DESCRIBE IS REPORTED AS UNTIMED, and my test asserted `LOCKED`
     * first. `LOCKED` would have been wrong: with no per-question limit `expiryInstruction` reads `NONE`, so no term
     * has anything to act on and nothing has expired. The first draft of this function carried a `termApplies` flag to
     * reach that conclusion through a second branch, which was dead code -- the check above already returns.
     */
    expect(timer({ expiry: 'SOFT', perQuestionTimeLimitSec: null }, DEADLINE + 1).phase).toBe(
      'UNTIMED',
    );
  });

  it('applies the offset like the paper countdown, because they share the one corrected instant', () => {
    expect(
      questionTimer(
        { questionDeadlineAt: DEADLINE, expiry: 'LOCK', perQuestionTimeLimitSec: 120 },
        { clientNow: DEADLINE - 60_000, offset: 30_000 },
      ).remainingMs,
    ).toBe(30_000);
  });
});

/**
 * THE TIMER AND THE PAPER ARE INDEPENDENT, and this is the case that makes the distinction matter.
 *
 * A question window can close while the paper is wide open. If the per-question timer were derived from the attempt's
 * phase it would show an open countdown over a question that stopped accepting answers an hour ago.
 */
describe('a question window can close while the paper is wide open', () => {
  it('and the two views do not shadow each other', () => {
    const state: AttemptState = initialAttemptState({
      attemptId: 'at1',
      policy: resolvePolicy({ mode: 'EXAM', versionPolicy: { perQuestionExpiry: 'LOCK' } }),
      deadlineAt: DEADLINE,
      slots: [{ questionId: 'q1', questionDeadlineAt: AT - 61_000 }],
    });
    const now = AT;

    expect(
      questionTimer(
        { questionDeadlineAt: AT - 61_000, expiry: 'LOCK', perQuestionTimeLimitSec: 120 },
        { clientNow: now, offset: 0 },
      ).phase,
    ).toBe('LOCKED');

    // The paper itself is nowhere near over.
    expect(view(DEADLINE, now).phase).toBe('OPEN');
    expect(view(DEADLINE, now).remainingMs).toBe(3_600_000);
    // ...and the student may still write OTHER questions.
    const other = reduceAttempt(state, { type: 'OPEN_QUESTION', questionId: 'q1', at: AT });
    expect(Object.keys(other.answers)).toHaveLength(0);
  });
});

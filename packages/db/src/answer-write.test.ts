/**
 * Write acceptance for an answer save -- the tests that matter.  (P7-T9)
 *
 * `plans/01` §9.1's five-clause expression has three ways to be subtly wrong, and all three are invisible in the
 * happy path:
 *
 *  · **`idempotencyKey` checked LAST** — `plans/01` lists it last, so implementing it in that order looks faithful
 *    and is a bug. A client retrying after a 409 resends the same key with the same stale revision; with revision
 *    first, the retry 409s again forever and the student can never recover.
 *  · **a first answer treated as stale** — `storedRevision` of -1 (the response does not exist yet) means the current
 *    revision is 0, so a client expecting 0 is right. Getting this wrong 409s the FIRST answer to every question.
 *  · **a rejection recorded as a success** — B8: the idempotency ledger used to hold rejected writes too, so a retry
 *    after a 409 returned a false 2xx and the student saw a green tick over an answer that was never stored.
 */

import { FrozenClock } from '@orrery/clock';
import { describe, expect, it } from 'vitest';

import { decideWrite, type WriteDecisionInput } from './answer-write.js';

const T0 = Date.parse('2026-03-01T10:00:00.000Z');

/** A frozen clock at an instant, so a deadline test does not sleep. */
const clockAt = (iso: string): FrozenClock => new FrozenClock(Date.parse(iso));
const at = (iso: string): number => Date.parse(iso);

/**
 * `perQuestionExpiry: 'LOCK'` is the fixture default, and the reason is worth one line.
 *
 * These tests predate the term reaching the write path at all, and every case in them was written against
 * `plans/01` §9.1's formula -- which omits `perQuestionExpiry` and therefore treats every term identically. `LOCK`
 * is the term that reproduces that reading exactly, so it is the one that keeps these assertions meaning what they
 * meant; switching them to `SOFT` would quietly change what each case is testing. The `SOFT` behaviour is asserted
 * on its own in `describe('perQuestionExpiry', ...)` below and across the whole matrix in
 * `apps/web/src/features/exam/expiryAgreement.test.ts`.
 */
const base = (over: Partial<WriteDecisionInput> = {}): WriteDecisionInput => ({
  attemptStatus: 'IN_PROGRESS',
  questionDeadlineAt: null,
  deadlineAt: null,
  expectedRevision: 0,
  storedRevision: -1,
  isDuplicate: false,
  questionInAttempt: true,
  perQuestionExpiry: 'LOCK',
  perQuestionTimeLimitSec: null,
  graceMs: 0,
  clock: new FrozenClock(T0),
  ...over,
});

describe('accepting', () => {
  it('accepts a first answer and makes it revision 1', () => {
    // The first answer to every question arrives with `storedRevision` -1 and `expectedRevision` 0.
    const decision = decideWrite(base());
    expect(decision).toEqual({ ok: true, nextRevision: 1, isLate: false });
  });

  it('accepts an edit at the current revision', () => {
    const decision = decideWrite(base({ expectedRevision: 3, storedRevision: 3 }));
    expect(decision).toEqual({ ok: true, nextRevision: 4, isLate: false });
  });

  it('records `isLate` for a write inside the grace window, which is a fact worth keeping', () => {
    const deadline = at('2026-03-01T10:00:30.000Z');
    // 40s past a 10:00:30 deadline, with 60s of grace: accepted, but late.
    const decision = decideWrite(
      base({ deadlineAt: deadline, graceMs: 60_000, clock: clockAt('2026-03-01T10:01:10.000Z') }),
    );
    expect(decision).toEqual({ ok: true, nextRevision: 1, isLate: true });
  });

  it('has no window to be late against when neither deadline is set', () => {
    const decision = decideWrite(base({ clock: clockAt('2030-01-01T00:00:00.000Z') }));
    expect(decision).toEqual({ ok: true, nextRevision: 1, isLate: false });
  });
});

describe('the duplicate key, and why it is checked FIRST', () => {
  it('replays the STORED status and body rather than recomputing them', () => {
    const decision = decideWrite(
      base({
        isDuplicate: true,
        storedResponseStatus: 200,
        storedResponseBody: { choiceIds: ['b'] },
        storedRevision: 7,
      }),
    );
    expect(decision).toEqual({
      ok: 'replayed',
      status: 200,
      body: { choiceIds: ['b'] },
      revision: 7,
    });
  });

  it('does NOT bump the revision, because a replay is not a write', () => {
    const decision = decideWrite(
      base({ isDuplicate: true, storedRevision: 7, expectedRevision: 7 }),
    );
    // C18: returning a recomputed revision desynchronised the client, so every later write 409'd.
    expect(decision.ok).toBe('replayed');
    expect(decision.ok === 'replayed' && decision.revision).toBe(7);
  });

  it('replays the STORED status even when it was not 200', () => {
    // If the original was refused, the replay must not report success. A replay that turns a 409 into a 200 is the
    // false green tick B8 describes.
    const decision = decideWrite(base({ isDuplicate: true, storedResponseStatus: 409 }));
    expect(decision.ok === 'replayed' && decision.status).toBe(409);
  });

  it('a retry after a 409 SUCCEEDS, which is the whole reason for the ordering', () => {
    /**
     * The bug this pins: the client resends the SAME `idempotencyKey` with the SAME stale revision. With the revision
     * clause evaluated first, this 409s again -- forever. The student can never recover and the only way out is to
     * lose the answer.
     */
    const retry = decideWrite(
      base({
        isDuplicate: true,
        expectedRevision: 1,
        storedRevision: 2, // someone else moved it on
        storedResponseBody: { choiceIds: ['a'] },
      }),
    );
    expect(retry.ok).toBe('replayed');
  });
});

describe('rejecting', () => {
  it('refuses a closed attempt, and says the attempt is closed rather than blaming the clock', () => {
    const decision = decideWrite(
      base({ attemptStatus: 'SUBMITTED', deadlineAt: at('2026-03-01T09:00:00.000Z') }),
    );
    expect(decision.ok).toBe(false);
    // Deadline first would tell a student who already submitted that "time is up", which is both wrong and alarming.
    expect(decision.ok === false && decision.reason).toBe('ATTEMPT_NOT_IN_PROGRESS');
    expect(decision.ok === false && decision.message).toContain('SUBMITTED');
  });

  it('refuses a question that is not in this attempt', () => {
    const decision = decideWrite(base({ questionInAttempt: false }));
    expect(decision.ok === false && decision.reason).toBe('QUESTION_NOT_IN_ATTEMPT');
  });

  it('refuses a question past ITS window, naming that question rather than the exam', () => {
    const decision = decideWrite(
      base({
        questionDeadlineAt: at('2026-03-01T10:00:10.000Z'),
        deadlineAt: at('2026-03-01T11:00:00.000Z'),
        clock: clockAt('2026-03-01T10:00:11.000Z'),
      }),
    );
    expect(decision.ok === false && decision.reason).toBe('QUESTION_DEADLINE_PASSED');
    // The tighter, more useful door: "time is up for this question" beats "time is up for the exam" when both hold.
    expect(decision.ok === false && decision.message).toContain('this question');
  });

  it('refuses a write past the attempt deadline, and INV-LATE-1 says the last value STANDS', () => {
    const decision = decideWrite(
      base({
        deadlineAt: at('2026-03-01T10:00:00.000Z'),
        clock: clockAt('2026-03-01T10:00:01.000Z'),
      }),
    );
    expect(decision.ok === false && decision.reason).toBe('ATTEMPT_DEADLINE_PASSED');
    // Not accepted, and not zeroed. A rejection is not a zero: that is the difference between "too slow" and
    // "wrong", and collapsing them drives facility down and r_pb toward correlation with speed.
    expect(decision.ok === false && decision.message).toContain('last saved answer stands');
  });

  it('a rejection is never a conflict, so the client does not offer keep-mine/keep-theirs', () => {
    const decision = decideWrite(base({ attemptStatus: 'GRADED' }));
    expect(decision.ok === false && decision.isConflict).toBe(false);
  });

  it('never returns an empty message, because an unexplained rejection is a support ticket', () => {
    const inputs: readonly WriteDecisionInput[] = [
      base({ attemptStatus: 'EXPIRED' }),
      base({ questionInAttempt: false }),
      base({ questionDeadlineAt: at('2026-03-01T09:59:59.000Z') }),
      base({ deadlineAt: at('2026-03-01T09:59:59.000Z') }),
      base({ expectedRevision: 9, storedRevision: 2 }),
    ];
    for (const input of inputs) {
      const decision = decideWrite(input);
      expect(decision.ok).toBe(false);
      if (decision.ok === false) {
        expect(decision.message.trim().length, decision.reason).toBeGreaterThan(0);
        expect(decision.reason.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('the revision clause', () => {
  it('reports a conflict WITH the server copy, so the student can choose', () => {
    const decision = decideWrite(
      base({ expectedRevision: 1, storedRevision: 2, storedResponseBody: { choiceIds: ['c'] } }),
    );
    expect(decision.ok).toBe(false);
    if (decision.ok === false) {
      expect(decision.reason).toBe('STALE_REVISION');
      // `plans/01`'s "409 with the server copy" is what makes the conflict resolvable. A bare 409 makes the student
      // reload and lose their work.
      expect(decision.isConflict).toBe(true);
      expect(decision.serverAnswer).toEqual({ choiceIds: ['c'] });
      expect(decision.serverRevision).toBe(2);
    }
  });

  it('treats a not-yet-created response as revision 0, so the FIRST answer is never stale', () => {
    /**
     * `storedRevision` is -1 when the response does not exist. Reading that as "the stored revision is -1" makes
     * every client's `expectedRevision` of 0 wrong, and 409s the first answer to every question on the exam.
     */
    const decision = decideWrite(base({ storedRevision: -1, expectedRevision: 0 }));
    expect(decision).toEqual({ ok: true, nextRevision: 1, isLate: false });
  });

  it('is checked AFTER validity, so an invalid write is not reported as a conflict', () => {
    // A closed attempt and a stale revision at once: the attempt is the real problem, and offering a merge dialog
    // would be nonsense.
    const decision = decideWrite(
      base({ attemptStatus: 'SUBMITTED', expectedRevision: 9, storedRevision: 2 }),
    );
    expect(decision.ok === false && decision.reason).toBe('ATTEMPT_NOT_IN_PROGRESS');
    expect(decision.ok === false && decision.isConflict).toBe(false);
  });
});

describe('grace', () => {
  it('zero grace is a hard deadline: one millisecond past is refused', () => {
    const decision = decideWrite(
      base({
        deadlineAt: at('2026-03-01T10:00:00.000Z'),
        clock: clockAt('2026-03-01T10:00:00.001Z'),
      }),
    );
    expect(decision.ok === false && decision.reason).toBe('ATTEMPT_DEADLINE_PASSED');
  });

  it('a write exactly ON the deadline is accepted, so the boundary is not off by one', () => {
    const decision = decideWrite(
      base({
        deadlineAt: at('2026-03-01T10:00:00.000Z'),
        clock: clockAt('2026-03-01T10:00:00.000Z'),
      }),
    );
    expect(decision.ok).toBe(true);
  });

  it('exactly the grace period past is still accepted', () => {
    const decision = decideWrite(
      base({
        deadlineAt: at('2026-03-01T10:00:00.000Z'),
        graceMs: 5_000,
        clock: clockAt('2026-03-01T10:00:05.000Z'),
      }),
    );
    expect(decision.ok).toBe(true);
  });
});

/**
 * `perQuestionExpiry` REACHES THE WRITE PATH NOW, AND DID NOT.
 *
 * `expiryInstruction` -- the function carrying `plans/01` §9.4's vocabulary -- had no production caller in this
 * repository, and `ATTEMPT_SELECT` did not read `policySnapshot` at all, so the term a teacher chose could not reach
 * a write decision. `SOFT` therefore behaved as `LOCK`: a question froze `grace` seconds after its own timer ended,
 * with nothing saying so. These are the server-side halves; `apps/web/src/features/exam/expiryAgreement.test.ts`
 * walks the same cells through all three implementations.
 */
describe('perQuestionExpiry', () => {
  const QUESTION_DEADLINE = T0 + 60_000;
  const ATTEMPT_DEADLINE = T0 + 3_600_000;
  const GRACE_MS = 60_000;
  /** Past the question's own window plus grace, while the paper is still open. */
  const PAST_THE_QUESTION = QUESTION_DEADLINE + GRACE_MS + 1;

  const timed = (term: 'SOFT' | 'LOCK' | 'AUTO_SUBMIT') => ({
    perQuestionExpiry: term,
    perQuestionTimeLimitSec: 60,
    graceMs: GRACE_MS,
    questionDeadlineAt: QUESTION_DEADLINE,
    deadlineAt: ATTEMPT_DEADLINE,
  });

  it('SOFT accepts the write and RECORDS IT AS LATE, because editable is not on time', () => {
    const decision = decideWrite(base({ ...timed('SOFT'), clock: clockAt('2026-03-01T10:02:00.001Z') }));
    expect(decision.ok).toBe(true);
    // The `isLate` flag is what `plans/09` §7 means by "log only": the answer stands AND the lateness is kept.
    if (decision.ok === true) expect(decision.isLate).toBe(true);
  });

  it('LOCK refuses it, naming the QUESTION', () => {
    const decision = decideWrite(base({ ...timed('LOCK'), clock: clockAt('2026-03-01T10:02:00.001Z') }));
    expect(decision.ok).toBe(false);
    if (decision.ok === false) expect(decision.reason).toBe('QUESTION_DEADLINE_PASSED');
  });

  it('AUTO_SUBMIT refuses it as well -- so SOFT is the ONLY term that changes here', () => {
    const decision = decideWrite(base({ ...timed('AUTO_SUBMIT'), clock: clockAt('2026-03-01T10:02:00.001Z') }));
    expect(decision.ok).toBe(false);
  });

  it('and the three terms are distinguishable, which is the only proof the term survived', () => {
    const outcomes = (['SOFT', 'LOCK', 'AUTO_SUBMIT'] as const).map(
      (term) => decideWrite(base({ ...timed(term), clock: clockAt('2026-03-01T10:02:00.001Z') })).ok,
    );
    // If this ever reads `[false, false, false]` the term has stopped carrying information and every agreement
    // test elsewhere would still be green, because they only compare modules against each other.
    expect(outcomes).toEqual([true, false, false]);
  });

  it('SOFT does NOT outlive the paper: INV-LATE-1 still refuses, naming the ATTEMPT', () => {
    const decision = decideWrite(
      base({ ...timed('SOFT'), clock: clockAt('2026-03-01T11:01:00.001Z') }),
    );
    expect(decision.ok).toBe(false);
    if (decision.ok === false) expect(decision.reason).toBe('ATTEMPT_DEADLINE_PASSED');
  });

  it('NO per-question limit means the term cannot bite, whatever it says', () => {
    for (const term of ['SOFT', 'LOCK', 'AUTO_SUBMIT'] as const) {
      const decision = decideWrite(
        base({
          perQuestionExpiry: term,
          perQuestionTimeLimitSec: null,
          deadlineAt: ATTEMPT_DEADLINE,
          clock: clockAt('2026-03-01T10:30:00.000Z'),
        }),
      );
      expect(decision.ok).toBe(true);
    }
  });

  it('the boundary is the QUESTION window on its own terms, not the attempt deadline', () => {
    // Sanity on the fixture itself: `PAST_THE_QUESTION` really is past the question window and really is inside
    // the paper's, so the SOFT/LOCK difference above is caused by the term and by nothing else.
    expect(PAST_THE_QUESTION).toBeGreaterThan(QUESTION_DEADLINE + GRACE_MS);
    expect(PAST_THE_QUESTION).toBeLessThan(ATTEMPT_DEADLINE + GRACE_MS);
  });
});

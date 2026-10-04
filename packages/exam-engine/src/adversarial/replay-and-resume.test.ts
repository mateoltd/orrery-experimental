/**
 * ADVERSARIAL: replayed saves, and a reload mid-exam -- the pure halves.  (P8-T15, `INV-LATE-1`, `C18`, `B8`)
 *
 * ## THESE TWO ARE ONE AXIS SEEN FROM TWO ENDS
 *
 * A reload is how a save comes to be replayed: the page goes away between the write and its acknowledgement, the
 * outbox still holds the write, and the reopened client sends it again. So "refresh must not double-count an
 * autosave" and "a duplicate key is a replay, not a write" are the same guarantee, and the attacker's version of it
 * is the same too -- **anything a reload or a retry can do that a continuous sitting could not is a way to buy time
 * or rewrite an answer.**
 *
 * Three things a student could hope a reload does, each of which must be false:
 *
 *  · reopen a paper that closed;
 *  · restart a clock;
 *  · get a write past a deadline by presenting it as a retry.
 *
 * ## WHAT IS HERE AND WHAT IS NOT
 *
 * Here: the decisions, which are pure. The half that needs a database -- that a replay appends NO revision, and that a
 * stored refusal replays as a refusal -- is in
 * `apps/web/src/features/exam/watchdogs/adversarial-server-write.integration.test.ts`, against real Postgres, because
 * "appends nothing" is a property of what a table contains afterwards and a pure test cannot observe an absence. The
 * client half of a reload (the outbox and the reducer) is in `adversarial-clock-and-resume.test.ts` beside it.
 */

import { profileFor } from '@orrery/contracts/policy';
import { evaluateWrite, type WriteRequest } from '@orrery/contracts/policy/deadline';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { type AttemptFacts, evaluateAttempt } from '../deadlines.js';
import { buildSyncPayload, checkSession, type SessionFacts } from '../session.js';

const T0 = 1_800_000_000_000;
const HOUR = 3_600_000;
const RUNS = 400;

const statusArb = fc.constantFrom<WriteRequest['attemptStatus']>(
  'NOT_STARTED',
  'IN_PROGRESS',
  'SUBMITTED',
  'GRADED',
  'EXPIRED',
);

const requestArb: fc.Arbitrary<WriteRequest> = fc.record({
  attemptStatus: statusArb,
  deadlineAt: fc.option(fc.integer({ min: T0, max: T0 + HOUR }), { nil: null }),
  questionDeadlineAt: fc.option(fc.integer({ min: T0, max: T0 + HOUR }), { nil: null }),
  expectedRevision: fc.nat({ max: 5 }),
  serverRevision: fc.nat({ max: 5 }),
  idempotencyKeySeen: fc.boolean(),
});

describe('a duplicate idempotency key is a replay, never a second decision', () => {
  it('is an idempotent success whatever has happened to the attempt since', () => {
    /**
     * What breaks without it: `C18`. The first write was accepted; the acknowledgement was lost; by the time the
     * retry lands the attempt is SUBMITTED, or the deadline has passed, or the revision has moved. If the retry were
     * RE-DECIDED it would be refused, the client would conclude its answer was never stored, and it would show the
     * student a failure for work the server has.
     *
     * `idempotent: true` is asserted as well as `accept`, because it is the flag that tells the caller NOT to append:
     * an acceptance without it is a second revision.
     */
    fc.assert(
      fc.property(
        requestArb,
        fc.integer({ min: T0 - HOUR, max: T0 + 3 * HOUR }),
        fc.integer({ min: 0, max: 300 }),
        (request, now, gracePeriodSec) => {
          const decision = evaluateWrite(
            { gracePeriodSec },
            { ...request, idempotencyKeySeen: true },
            now,
          );
          expect(decision).toEqual({ accept: true, idempotent: true });
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('never marks a FIRST write idempotent, or a real save would be answered with a replay and append nothing', () => {
    fc.assert(
      fc.property(
        requestArb,
        fc.integer({ min: T0 - HOUR, max: T0 + 3 * HOUR }),
        fc.integer({ min: 0, max: 300 }),
        (request, now, gracePeriodSec) => {
          const decision = evaluateWrite(
            { gracePeriodSec },
            { ...request, idempotencyKeySeen: false },
            now,
          );
          if (decision.accept) expect(decision.idempotent).toBe(false);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('gives a FRESH key no amnesty: a late write resent under a new key is still a late write', () => {
    /**
     * The attacker's reading of idempotency. A replay is honoured past the deadline, so: send the answer late, and
     * call it a retry. It must not work, and what stops it is that the amnesty attaches to a key the SERVER has
     * already seen -- which is not something a client can assert. (`INV-LATE-1`.)
     */
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 300 }),
        fc.integer({ min: 1, max: HOUR }),
        fc.nat({ max: 5 }),
        (gracePeriodSec, lateBy, revision) => {
          const request: WriteRequest = {
            attemptStatus: 'IN_PROGRESS',
            deadlineAt: T0,
            questionDeadlineAt: null,
            expectedRevision: revision,
            serverRevision: revision,
            idempotencyKeySeen: false,
          };
          const now = T0 + gracePeriodSec * 1000 + lateBy;
          expect(evaluateWrite({ gracePeriodSec }, request, now)).toEqual({
            accept: false,
            reason: 'ATTEMPT_DEADLINE_PASSED',
          });
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('refuses a new write on every attempt that is not in progress, so a reload cannot write to a closed paper', () => {
    fc.assert(
      fc.property(
        requestArb,
        statusArb.filter((status) => status !== 'IN_PROGRESS'),
        fc.integer({ min: T0 - HOUR, max: T0 + 3 * HOUR }),
        (request, attemptStatus, now) => {
          const decision = evaluateWrite(
            { gracePeriodSec: 60 },
            { ...request, attemptStatus, idempotencyKeySeen: false },
            now,
          );
          expect(decision).toEqual({ accept: false, reason: 'ATTEMPT_NOT_IN_PROGRESS' });
        },
      ),
      { numRuns: RUNS },
    );
  });
});

describe('a reload cannot reopen a paper or restart a clock', () => {
  const policyArb = fc
    .constantFrom<'SOFT' | 'LOCK' | 'AUTO_SUBMIT'>('SOFT', 'LOCK', 'AUTO_SUBMIT')
    .map((perQuestionExpiry) => ({
      ...profileFor('EXAM'),
      perQuestionExpiry,
      perQuestionTimeLimitSec: 120,
    }));

  const factsArb: fc.Arbitrary<AttemptFacts> = fc.record({
    attemptId: fc.constant('attempt'),
    status: fc.constantFrom('IN_PROGRESS', 'SUBMITTED', 'FROZEN', 'EXPIRED'),
    deadlineAt: fc.option(fc.integer({ min: T0, max: T0 + HOUR }), { nil: null }),
    questions: fc
      .array(
        fc.record({
          deadlineAt: fc.option(fc.integer({ min: T0, max: T0 + HOUR }), { nil: null }),
          answered: fc.boolean(),
          isExcused: fc.boolean(),
        }),
        { minLength: 1, maxLength: 5 },
      )
      .map((questions) =>
        questions.map((question, index) => ({
          questionId: `q${String(index)}`,
          deadlineAt: question.deadlineAt,
          isExcused: question.isExcused,
          ...(question.answered ? { answeredAt: T0 } : {}),
        })),
      ),
  });

  /** Two instants, the second no earlier than the first: a sitting, then the reload that follows it. */
  const instantsArb = fc
    .tuple(
      fc.integer({ min: T0 - HOUR, max: T0 + 2 * HOUR }),
      fc.integer({ min: 0, max: 2 * HOUR }),
    )
    .map(([first, gap]) => [first, first + gap] as const);

  it('keeps a closed attempt closed at every later instant', () => {
    /**
     * CLOSURE IS MONOTONE IN SERVER TIME. The facts are the server's and do not change on a reload; only `now` does,
     * and only forwards. So if any later instant could find the paper open again, reloading at the right moment
     * would reopen it.
     *
     * What breaks without it: a window comparison that is right at the deadline and wrong past the end of grace, or
     * an `AUTO_SUBMIT` that is forgotten once the question that triggered it stops being the latest one.
     */
    fc.assert(
      fc.property(
        policyArb,
        factsArb,
        instantsArb,
        fc.integer({ min: 0, max: 120_000 }),
        (policy, facts, [before, after], graceMs) => {
          const first = evaluateAttempt(policy, facts, before, graceMs);
          const second = evaluateAttempt(policy, facts, after, graceMs);

          if (first.isClosed) {
            expect(second.isClosed).toBe(true);
            expect(second.isOpen).toBe(false);
            expect(second.nextQuestionId).toBeNull();
          }
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('never shows more time after a reload than before it, for the attempt or for any question', () => {
    fc.assert(
      fc.property(
        policyArb,
        factsArb,
        instantsArb,
        fc.integer({ min: 0, max: 120_000 }),
        (policy, facts, [before, after], graceMs) => {
          const first = evaluateAttempt(policy, facts, before, graceMs);
          const second = evaluateAttempt(policy, facts, after, graceMs);

          if (first.remainingMs !== null) {
            expect(second.remainingMs).not.toBeNull();
            expect(second.remainingMs ?? 0).toBeLessThanOrEqual(first.remainingMs);
          }
          first.questions.forEach((question, index) => {
            expect(second.questions[index]?.remainingMs ?? 0).toBeLessThanOrEqual(
              Math.max(question.remainingMs, 0),
            );
            // A question that was not open does not become open by waiting.
            if (question.state !== 'OPEN') expect(second.questions[index]?.state).not.toBe('OPEN');
          });
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('closes on the attempt STATUS alone, even at an instant before the deadline', () => {
    // A SUBMITTED attempt with an hour left on the clock is the reload that matters: the student submitted, thinks
    // better of it, and reloads. The deadline has not passed, and the paper must still be shut.
    fc.assert(
      fc.property(policyArb, factsArb, (policy, facts) => {
        fc.pre(facts.status !== 'IN_PROGRESS');
        const verdict = evaluateAttempt(policy, facts, T0 - HOUR, 60_000);
        expect(verdict.isClosed).toBe(true);
        expect(verdict.nextQuestionId).toBeNull();
        expect(verdict.questions.every((question) => question.state === 'ATTEMPT_CLOSED')).toBe(
          true,
        );
      }),
      { numRuns: RUNS },
    );
  });

  it('re-sends the deadline the server holds on every sync, untouched by when the sync happened', () => {
    /**
     * A resumed client rebuilds its countdown from the sync payload. If that payload derived the deadline from the
     * moment it was built (`now + limit`), every reload would be a fresh full-length paper.
     */
    fc.assert(
      fc.property(
        fc.integer({ min: T0, max: T0 + 3 * HOUR }),
        fc.option(fc.integer({ min: T0, max: T0 + HOUR }), { nil: null }),
        (now, deadlineAt) => {
          const payload = buildSyncPayload({
            sessionId: 'session',
            attemptId: 'attempt',
            attemptStatus: 'IN_PROGRESS',
            now,
            startedAt: T0 - HOUR,
            deadlineAt,
            gracePeriodSec: 60,
            policy: profileFor('EXAM'),
            escalationState: 'NONE',
            questionDeadlines: [{ questionId: 'q0', deadlineAt: T0 + 120_000, state: 'OPEN' }],
            saveStateByQuestion: {},
          });
          expect(payload.deadlineAt).toBe(deadlineAt);
          expect(payload.startedAt).toBe(T0 - HOUR);
          expect(payload.serverNow).toBe(now);
          expect(payload.questionDeadlines).toEqual([
            { questionId: 'q0', deadlineAt: T0 + 120_000, state: 'OPEN' },
          ]);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('keeps a session that was refused, refused: an expired or revoked token does not recover by being presented later', () => {
    const sessionArb: fc.Arbitrary<SessionFacts> = fc.record({
      id: fc.constant('session'),
      attemptId: fc.constant('attempt'),
      tabId: fc.constant('tab'),
      expiresAt: fc.integer({ min: T0, max: T0 + HOUR }),
      revokedAt: fc.option(fc.integer({ min: T0, max: T0 + HOUR }), { nil: null }),
      revokedReason: fc.constant(null),
    });
    fc.assert(
      fc.property(
        sessionArb,
        fc.constantFrom('IN_PROGRESS', 'SUBMITTED', 'FROZEN'),
        instantsArb,
        (session, status, [before, after]) => {
          const first = checkSession(session, status, before);
          const second = checkSession(session, status, after);
          if (!first.ok) expect(second.ok).toBe(false);
        },
      ),
      { numRuns: RUNS },
    );
  });
});

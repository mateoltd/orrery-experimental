import type { Clock } from '@orrery/clock';
import type { ExamPolicy } from '@orrery/contracts/policy';
import { resolvePolicy } from '@orrery/contracts/policy';
import { decideWrite, type WriteDecisionInput } from '@orrery/db/answer-write';
import { evaluateAttempt } from '@orrery/exam-engine/deadlines';
import { describe, expect, it } from 'vitest';

import { type AttemptState, canAnswer, initialAttemptState, reduceAttempt } from './answerStore';

/**
 * THE THREE IMPLEMENTATIONS MUST AGREE, AND THIS FILE IS WHY THEY NOW DO.
 *
 * ## THE DEFECT THIS TEST EXISTS TO CLOSE
 *
 * `perQuestionExpiry` is the term a teacher picks to decide what happens to an answer at its question's deadline.
 * `plans/01` §9.4 gives it three behaviours: `SOFT` "logs and leaves it editable until the OVERALL deadline",
 * `LOCK` freezes, `AUTO_SUBMIT` freezes and finalises.
 *
 * **Nothing on the write path consulted it.** `packages/db`'s `decideWrite` compared
 * `now > questionDeadlineAt + graceMs` and refused, unconditionally; `apps/web`'s `canAnswer` did the same; and
 * `@orrery/exam-engine`'s `evaluateAttempt` -- which had the term and honoured `SOFT` -- reported the question
 * `SOFT_EXPIRED` and **writable**. So two implementations agreed with each other and both contradicted the third,
 * and the pair that agreed were both wrong against the plan: `SOFT` and `LOCK` had become the same configuration
 * differing only by a log line.
 *
 * The reason the client's half was the dangerous half is that `reduceAttempt`'s `ANSWER` case returns the state
 * unchanged when `canAnswer` refuses. That is **silent**: no queued write, no revision bump, no error. A student
 * typing into a `SOFT`-expiry question past its window watched every keystroke go nowhere and had no way to find
 * out why. `canAnswer`'s own comment claimed the requirement it was violating -- "the client must not be stricter
 * than the server, or a student loses an answer the server would have taken".
 *
 * ## WHY A MATRIX AND NOT THREE HAND-PICKED CASES
 *
 * The disagreement lived at exactly one point in the space -- "question window passed, attempt window open, term is
 * `SOFT`" -- and any hand-written case naming it would have been written by someone who already knew where to look.
 * The defect was invisible precisely because nobody was looking. Walking every `(term x instant)` combination and
 * asserting the three agree is the guarantee; the individual cells are just how it is checked.
 *
 * **`apps/web` IS THE ONLY PLACE THIS TEST CAN LIVE**, which is worth noting rather than hiding: it is the one
 * package that depends on `@orrery/db`, `@orrery/exam-engine` and `@orrery/contracts` at once. A test that needs all
 * three implementations in scope has nowhere else to go, and that is an argument for the single shared function --
 * if the modules had depended on each other more directly the duplication would have been harder to write.
 *
 * ## ⚠️ WHAT THE MATRIX CANNOT SEE, MEASURED RATHER THAN ASSUMED
 *
 * I patched the built `expiryVerdict` back to the pre-fix behaviour -- refuse every passed question window, ignore
 * the term -- and re-ran this file. **Four tests went red and the three matrix cases stayed GREEN**, because a
 * defect introduced *into the shared function* keeps all three callers in agreement. That is the honest limit of an
 * agreement test: it detects divergence between callers, and it is blind by construction to the three of them moving
 * together.
 *
 * So the `describe('the term has to keep meaning something')` block below is not decoration and must not be deleted
 * as "covered by the matrix". It is the only thing pinning what the answer *is*, rather than that the three agree on
 * it, and its `[true, false, false]` assertion is what fails when the three terms become interchangeable.
 */

const T0 = 1_700_000_000_000;

/**
 * `monotonic` returns the same instant as `now`, deliberately.
 *
 * Every cell in this file is evaluated at ONE instant, so there is no elapsed time to measure and the monotonic
 * reading is never consulted -- but `Clock` requires it, and returning a different number would be inventing a clock
 * that disagrees with itself. The honest stand-in for "no time passes in this test" is that both report the same
 * instant.
 */
const clockAt = (now: number): Clock => ({ now: () => now, monotonic: () => now });

const TERMS = ['SOFT', 'LOCK', 'AUTO_SUBMIT'] as const;

/** Instants chosen to land inside every region of the two windows: before, at, inside grace, and after. */
const INSTANTS: readonly number[] = [
  T0 - 120_000,
  T0 - 1,
  T0,
  T0 + 1,
  T0 + 30_000,
  T0 + 60_000,
  T0 + 60_001,
  T0 + 120_000,
];

const policyWith = (over: Partial<ExamPolicy>): ExamPolicy =>
  resolvePolicy({ mode: 'EXAM', versionPolicy: over });

const QUESTION_DEADLINE = T0 + 60_000;
const ATTEMPT_DEADLINE = T0 + 3_600_000;
const GRACE_MS = 60_000;

/** `decideWrite`'s input for one cell. Every other field is held constant, because only time and term vary. */
const writeInput = (
  term: (typeof TERMS)[number],
  now: number,
  questionDeadlineAt: number | null,
  deadlineAt: number | null,
): WriteDecisionInput => ({
  attemptStatus: 'IN_PROGRESS',
  questionDeadlineAt,
  deadlineAt,
  expectedRevision: 0,
  storedRevision: -1,
  isDuplicate: false,
  questionInAttempt: true,
  perQuestionExpiry: term,
  perQuestionTimeLimitSec: questionDeadlineAt === null ? null : 60,
  graceMs: GRACE_MS,
  clock: clockAt(now),
});

/**
 * `canAnswer`'s input for one cell, as a real store state rather than a hand-built object.
 *
 * **THE TERM IS A PARAMETER, BECAUSE MY FIRST FIXTURE HARD-CODED `EXAM_PROFILE_DEFAULTS` AND THREE TESTS FAILED.**
 * The EXAM profile ships `perQuestionExpiry: 'SOFT'` **with `perQuestionTimeLimitSec: null`**, and
 * `expiryInstruction` reads `NONE` when there is no per-question limit -- so `SOFT` correctly became "no term at
 * all" and every `SOFT` case asserted a refusal. The fixture was wrong and the implementation was right, and it is
 * the same trap `readExpiry`'s note describes on the server: a term with no window to act on is not a term.
 *
 * So the window and the limit travel together here, and the one place that wants no window says so explicitly.
 */
const storeState = (
  term: (typeof TERMS)[number] | 'NONE',
  questionDeadlineAt: number | null,
  deadlineAt: number | null,
): AttemptState => {
  const timed = questionDeadlineAt !== null;
  const base = initialAttemptState({
    attemptId: 'attempt-1',
    policy: policyWith({
      ...(term === 'NONE' ? {} : { perQuestionExpiry: term }),
      perQuestionTimeLimitSec: timed ? 60 : null,
    }),
    slots: [{ questionId: 'q1', questionDeadlineAt }],
    deadlineAt,
  });
  // An `OPEN_QUESTION` so the slot carries the window rather than being replaced by the store.
  return reduceAttempt(base, { type: 'OPEN_QUESTION', questionId: 'q1', at: T0 });
};

const acceptedBy = (
  term: (typeof TERMS)[number],
  now: number,
  qd: number | null,
  d: number | null,
): boolean => {
  const decision = decideWrite(writeInput(term, now, qd, d));
  // A replay is not a refusal and must not be read as one; the ledger is empty here so it cannot occur, and
  // asserting that keeps the helper honest if a future cell ever sets `isDuplicate`.
  return decision.ok === true || decision.ok === 'replayed';
};

describe('INV: one expiry verdict, three callers', () => {
  it.each(TERMS)(
    '%s: decideWrite, canAnswer and evaluateAttempt agree at every instant',
    (term) => {
      const policy = policyWith({ perQuestionExpiry: term, perQuestionTimeLimitSec: 60 });
      const state0 = (t: (typeof TERMS)[number]): AttemptState =>
        storeState(t, QUESTION_DEADLINE, ATTEMPT_DEADLINE);

      for (const now of INSTANTS) {
        const server = acceptedBy(term, now, QUESTION_DEADLINE, ATTEMPT_DEADLINE);
        const client = canAnswer(state0(term), 'q1', now).allowed;
        const engine = evaluateAttempt(
          policy,
          {
            attemptId: 'attempt-1',
            status: 'IN_PROGRESS',
            deadlineAt: ATTEMPT_DEADLINE,
            questions: [{ questionId: 'q1', deadlineAt: QUESTION_DEADLINE }],
          },
          now,
          GRACE_MS,
        ).questions[0]?.writable;

        expect({ now, side: 'client', writable: client }).toEqual({
          now,
          side: 'client',
          writable: server,
        });
        expect({ now, side: 'engine', writable: engine }).toEqual({
          now,
          side: 'engine',
          writable: server,
        });
      }
    },
  );

  it('agrees with NO per-question window too, so a term cannot matter where there is no window', () => {
    for (const now of INSTANTS) {
      const server = acceptedBy('LOCK', now, null, ATTEMPT_DEADLINE);
      const state = storeState('NONE', null, ATTEMPT_DEADLINE);
      expect(canAnswer(state, 'q1', now).allowed).toBe(server);
    }
  });
});

/**
 * `SOFT` IS NOT `LOCK`, and this is the assertion that says so out loud.
 *
 * Without it the fix is invisible: if both terms behaved identically, every agreement test above would still pass,
 * and a future change could collapse `SOFT` back into `LOCK` without a single test going red. So the cells are
 * named here rather than left implicit in a loop.
 */
describe('the term has to keep meaning something', () => {
  const pastQuestionWindow = QUESTION_DEADLINE + GRACE_MS + 1;

  it('SOFT keeps a question writable past its own window, up to the attempt deadline', () => {
    const now = pastQuestionWindow;
    expect(acceptedBy('SOFT', now, QUESTION_DEADLINE, ATTEMPT_DEADLINE)).toBe(true);
    const state = storeState('SOFT', QUESTION_DEADLINE, ATTEMPT_DEADLINE);
    expect(canAnswer(state, 'q1', now).allowed).toBe(true);
  });

  it('and it records the write as LATE, because editable is not on time', () => {
    const decision = decideWrite(
      writeInput('SOFT', pastQuestionWindow, QUESTION_DEADLINE, ATTEMPT_DEADLINE),
    );
    expect(decision.ok).toBe(true);
    if (decision.ok === true) expect(decision.isLate).toBe(true);
  });

  it('LOCK refuses the same write, and SOFT must differ from it', () => {
    expect(acceptedBy('LOCK', pastQuestionWindow, QUESTION_DEADLINE, ATTEMPT_DEADLINE)).toBe(false);
    expect(acceptedBy('LOCK', pastQuestionWindow, QUESTION_DEADLINE, ATTEMPT_DEADLINE)).not.toBe(
      acceptedBy('SOFT', pastQuestionWindow, QUESTION_DEADLINE, ATTEMPT_DEADLINE),
    );
  });

  it('AUTO_SUBMIT refuses it AND takes the whole attempt with it', () => {
    const policy = policyWith({ perQuestionExpiry: 'AUTO_SUBMIT' });
    const verdict = evaluateAttempt(
      policy,
      {
        attemptId: 'attempt-1',
        status: 'IN_PROGRESS',
        deadlineAt: ATTEMPT_DEADLINE,
        questions: [
          { questionId: 'q1', deadlineAt: QUESTION_DEADLINE },
          // Comfortably inside its own window, and must still be closed: the policy term submits the ATTEMPT.
          { questionId: 'q2', deadlineAt: ATTEMPT_DEADLINE },
        ],
      },
      pastQuestionWindow,
      GRACE_MS,
    );
    expect(
      verdict.questions.every(
        (question) => question.state === 'AUTO_SUBMITTED' || question.state === 'ATTEMPT_CLOSED',
      ),
    ).toBe(true);
    expect(verdict.isClosed).toBe(true);
  });

  /**
   * `SOFT` IS **NOT** UNBOUNDED. `INV-LATE-1` still governs the attempt deadline, and "editable until the overall
   * deadline" means until it -- not past it. A widening that swallowed the attempt window would have replaced one
   * defect with a worse one, so the edge is pinned rather than assumed.
   */
  it('SOFT does not survive the attempt window: INV-LATE-1 still refuses', () => {
    const afterEverything = ATTEMPT_DEADLINE + GRACE_MS + 1;
    expect(acceptedBy('SOFT', afterEverything, QUESTION_DEADLINE, ATTEMPT_DEADLINE)).toBe(false);
    const state = storeState('SOFT', QUESTION_DEADLINE, ATTEMPT_DEADLINE);
    expect(canAnswer(state, 'q1', afterEverything).allowed).toBe(false);
  });

  it('and a refusal names the PAPER when both windows have passed, not the question', () => {
    const decision = decideWrite(
      writeInput('LOCK', ATTEMPT_DEADLINE + GRACE_MS + 1, QUESTION_DEADLINE, ATTEMPT_DEADLINE),
    );
    expect(decision.ok).toBe(false);
    if (decision.ok === false) expect(decision.reason).toBe('ATTEMPT_DEADLINE_PASSED');
  });
});

/**
 * THE SILENT-DROP HALF.
 *
 * Agreement on the verdict is necessary but not sufficient: `canAnswer` refusing is only dangerous because
 * `reduceAttempt` refuses *silently*. So the assertion is about the reducer's behaviour, not about `canAnswer`'s
 * return value -- a store that queued the write anyway, or refused it loudly, would both be acceptable; the one
 * that drops it is the defect.
 */
describe('the client is not silent', () => {
  it('a SOFT-expired answer IS recorded, queued and bumped', () => {
    const now = QUESTION_DEADLINE + GRACE_MS + 1;
    const before = storeState('SOFT', QUESTION_DEADLINE, ATTEMPT_DEADLINE);
    const after = reduceAttempt(before, {
      type: 'ANSWER',
      questionId: 'q1',
      answer: { choiceIds: ['a'] },
      idempotencyKey: 'k1',
      at: now,
    });

    expect(Object.hasOwn(after.answers, 'q1')).toBe(true);
    expect(after.queued).toHaveLength(1);
    expect(after.revisions.q1).toBe(1);
  });

  it('a LOCK-expired answer is dropped -- and THAT is a refusal the store already had', () => {
    const now = QUESTION_DEADLINE + GRACE_MS + 1;
    const before = reduceAttempt(storeState('LOCK', QUESTION_DEADLINE, ATTEMPT_DEADLINE), {
      type: 'ANSWER',
      questionId: 'q1',
      answer: { choiceIds: ['a'] },
      idempotencyKey: 'k0',
      at: T0,
    });
    const after = reduceAttempt(before, {
      type: 'ANSWER',
      questionId: 'q1',
      answer: { choiceIds: ['b'] },
      idempotencyKey: 'k1',
      at: now,
    });

    // The earlier value stands and NOTHING NEW is queued. The queue still holds the first answer -- my first
    // version asserted `toHaveLength(0)` and failed, because the on-time write at `T0` was legitimately queued and
    // I had forgotten it was there. `INV-LATE-1` is behaving correctly; it is the SOFT case above that was losing
    // work silently.
    expect(after.queued.map((write) => write.seq)).toEqual([1]);
    expect(after.answers.q1).toEqual({ choiceIds: ['a'] });
    expect(after.revisions.q1).toBe(1);
  });

  it('the store never reports a negative remaining window, at any instant', () => {
    for (const now of INSTANTS) {
      const verdict = evaluateAttempt(
        policyWith({ perQuestionExpiry: 'SOFT', perQuestionTimeLimitSec: 60 }),
        {
          attemptId: 'attempt-1',
          status: 'IN_PROGRESS',
          deadlineAt: ATTEMPT_DEADLINE,
          questions: [{ questionId: 'q1', deadlineAt: QUESTION_DEADLINE }],
        },
        now,
        GRACE_MS,
      );
      for (const question of verdict.questions)
        expect(question.remainingMs).toBeGreaterThanOrEqual(0);
    }
  });
});

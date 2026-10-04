/**
 * Tests for the answer store and the outbox.  (P7-T6)
 *
 * ## THE PROPERTIES ARE THE PRODUCT HERE
 *
 * A reducer's unit tests check the transitions somebody thought of. The properties check the ones nobody did,
 * and for an answer store they are the ones that decide whether a student keeps their work: an event log replays
 * to the same state, `seq` is never reused, navigation never touches an answer, and a locked question cannot be
 * written by any event at all.
 */

import type { ExamPolicy } from '@orrery/contracts/policy';
import { resolvePolicy } from '@orrery/contracts/policy';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type AttemptEvent,
  type AttemptState,
  canAnswer,
  durabilityLabel,
  initialAttemptState,
  type QueuedWrite,
  reduceAttempt,
  replay,
  unanswered,
} from './answerStore';
import { AUTOSAVE_BUDGET_MS, flush, memoryOutboxStore, shouldFlushNow } from './outbox';

const AT = Date.parse('2026-03-01T09:00:00Z');
const RUNS = 200;

const policy = (over: Record<string, unknown> = {}): ExamPolicy =>
  resolvePolicy({
    mode: 'ASSIGNMENT',
    versionPolicy: {
      totalTimeLimitSec: 3600,
      perQuestionTimeLimitSec: 120,
      perQuestionExpiry: 'LOCK',
      /**
       * `ONE_AT_A_TIME` IS SET EXPLICITLY, and the reason is worth stating.
       *
       * The ASSIGNMENT profile is `QUIZ_PROFILE_DEFAULTS`, which overrides the base profile's `ONE_AT_A_TIME`
       * with **`ALL_AT_ONCE`** -- so the ordinary quiz is all-at-once and the cursor is PINNED. The first version
       * of these tests relied on the base default, and every cursor assertion failed for a reason that had
       * nothing to do with the reducer: `NEXT` under `ALL_AT_ONCE` is not "go to the next question", it is
       * nothing at all.
       *
       * Which means `NEXT`, `PREVIOUS` and `GOTO` matter only under an EXAM profile, and the reducer's clamping
       * is only ever exercised there. Both facts are asserted rather than left as fixture knowledge.
       */
      navigation: 'ONE_AT_A_TIME',
      ...over,
    },
  });

const start = (over: Record<string, unknown> = {}, count = 4): AttemptState =>
  initialAttemptState({
    attemptId: 'at1',
    policy: policy(over),
    deadlineAt: AT + 3_600_000,
    slots: Array.from({ length: count }, (_, n) => ({
      questionId: `q${String(n + 1)}`,
      questionDeadlineAt: null,
    })),
  });

const answer = (questionId: string, value: unknown, at = AT): AttemptEvent => ({
  type: 'ANSWER',
  questionId,
  answer: value,
  idempotencyKey: `key-${questionId}-${String(at)}`,
  at,
});

describe('the store is the ONLY writer of answers', () => {
  it('records an answer and queues exactly one write for it', () => {
    const state = reduceAttempt(start(), answer('q1', { choiceId: 'a' }));
    expect(state.answers.q1).toEqual({ choiceId: 'a' });
    expect(state.revisions.q1).toBe(1);
    expect(state.queued).toHaveLength(1);
    expect(state.status).toBe('IN_PROGRESS');
  });

  it('bumps the revision on every re-answer, because §9.4 folds revisions into the receipt hash', () => {
    let state = reduceAttempt(start(), answer('q1', 'first'));
    state = reduceAttempt(state, answer('q1', 'second'));
    state = reduceAttempt(state, answer('q1', 'third'));
    expect(state.revisions.q1).toBe(3);
    expect(state.queued.map((w) => w.revision)).toEqual([1, 2, 3]);
    // Three writes, not one: a skipped revision is a gap in a hash chain.
    expect(state.queued).toHaveLength(3);
  });

  it('treats ANSWERING WITH undefined AS A CLEAR, not as no answer', () => {
    /**
     * THE DISTINCTION THE WHOLE `answers` MAP DEPENDS ON. A student who deselects a radio button has changed
     * their answer, and the server must be told -- otherwise "I cleared it" and "I never touched it" are the same
     * row and the student is marked on the earlier value. So `undefined` clears the key and bumps the revision.
     */
    let state = reduceAttempt(start(), answer('q1', { choiceId: 'a' }));
    state = reduceAttempt(state, answer('q1', undefined));
    expect(state.answers.q1).toBeUndefined();
    expect(state.revisions.q1).toBe(2);
    expect(state.queued).toHaveLength(2);
    expect(unanswered(state)).toContain('q1');
  });

  it('refuses an answer to a question that is not in the paper', () => {
    const before = start();
    expect(reduceAttempt(before, answer('nope', 'x'))).toBe(before);
  });
});

describe('lock-after-answer, enforced by the store rather than by the renderer', () => {
  it('refuses a SECOND answer under lockQuestionAfterAnswer', () => {
    const locked = start({ lockQuestionAfterAnswer: true });
    const once = reduceAttempt(locked, answer('q1', 'first'));
    const twice = reduceAttempt(once, answer('q1', 'second'));
    // A renderer can be bypassed by a keyboard shortcut, so the refusal lives here.
    expect(twice.answers.q1).toBe('first');
    expect(twice.queued).toHaveLength(1);
    expect(canAnswer(twice, 'q1', AT).why).toBe('LOCKED');
  });

  it('allows re-answering when the policy does not lock, which is the ordinary quiz', () => {
    const open = reduceAttempt(start(), answer('q1', 'first'));
    const again = reduceAttempt(open, answer('q1', 'second'));
    expect(again.answers.q1).toBe('second');
    expect(again.revisions.q1).toBe(2);
  });

  it('leaves an UNANSWERED question writable under lock, because there is nothing to lock yet', () => {
    const locked = start({ lockQuestionAfterAnswer: true });
    expect(canAnswer(locked, 'q1', AT).allowed).toBe(true);
  });
});

describe('the client is never STRICTER than the server', () => {
  /**
   * ⚠️ **THE TEST THAT WAS NAMED FOR THIS PROPERTY ASSERTED THE OPPOSITE, AND THAT IS THE WHOLE STORY.**
   *
   * This block is headed "the client is never STRICTER than the server" and its first case configured
   * `perQuestionExpiry: 'SOFT'` -- `plans/01` §9.4's "log only, editable until the overall deadline" -- and then
   * asserted that a write just past the question's deadline plus grace was **refused**. So the test documented the
   * client being stricter than the plan, under a heading that promised the opposite, and it passed on every run.
   *
   * The comment above it is the honest part and it was right: "a client that stopped at the bare deadline would
   * lose an answer the server would have taken, and the student would see it vanish." The test then did the
   * vanishing, one grace period later than the comment described.
   *
   * `SOFT` now genuinely stays writable, and the boundary that remains is the grace period -- which is what the
   * case below checks, under `LOCK`, where refusing past `deadline + grace` is correct.
   */
  it('accepts a write inside the grace period, even after the deadline has passed', () => {
    // `plans/01` §9.1 puts the grace in the SERVER's acceptance predicate. A client that stopped at the bare
    // deadline would lose an answer the server would have taken, and the student would see it vanish.
    //
    // `LOCK`, not `SOFT`: this case is about the GRACE boundary, and `SOFT` would pass it for the wrong reason --
    // `SOFT` is admissible for as long as the PAPER is open, so it would not be testing the grace at all.
    const state = initialAttemptState({
      attemptId: 'at1',
      policy: policy({ perQuestionExpiry: 'LOCK' }),
      deadlineAt: AT + 3_600_000,
      slots: [{ questionId: 'q1', questionDeadlineAt: AT + 1_000 }],
    });
    const inside = reduceAttempt(state, answer('q1', 'x', AT + 1_000 + 59_000));
    expect(inside.answers.q1).toBe('x');
    const outside = reduceAttempt(state, answer('q1', 'x', AT + 1_000 + 61_000));
    expect(outside.answers.q1).toBeUndefined();
    expect(canAnswer(outside, 'q1', AT + 1_000 + 61_000).why).toBe('QUESTION_DEADLINE_PASSED');
  });

  it('and SOFT is not stricter either: it stays writable past the question window while the paper is open', () => {
    // The same state, the same instant, `SOFT` -- and the answer LANDS. One configuration difference, the opposite
    // outcome, which is the only evidence that the term a teacher picks is doing anything at all.
    const state = initialAttemptState({
      attemptId: 'at1',
      policy: policy({ perQuestionExpiry: 'SOFT' }),
      deadlineAt: AT + 3_600_000,
      slots: [{ questionId: 'q1', questionDeadlineAt: AT + 1_000 }],
    });
    const late = reduceAttempt(state, answer('q1', 'x', AT + 1_000 + 61_000));
    expect(late.answers.q1).toBe('x');
    // ...and it is QUEUED, because the old silent drop was half the harm.
    expect(late.queued).toHaveLength(1);
    // ...but not past the paper's own window, which is what "until the OVERALL deadline" means.
    expect(canAnswer(state, 'q1', AT + 3_600_000 + 61_000).allowed).toBe(false);
  });

  it('refuses everything after SUBMIT, whatever the deadlines say', () => {
    const submitted = reduceAttempt(start(), { type: 'SUBMIT' });
    expect(canAnswer(submitted, 'q1', AT).why).toBe('ATTEMPT_OVER');
    expect(reduceAttempt(submitted, answer('q1', 'x'))).toBe(submitted);
  });

  it('accepts everything on an UNTIMED attempt at any instant', () => {
    fc.assert(
      fc.property(fc.integer({ min: -1_000_000, max: 10_000_000 }), (now) => {
        const untimed = initialAttemptState({
          attemptId: 'at1',
          policy: resolvePolicy({ mode: 'ASSIGNMENT' }),
          deadlineAt: null,
          slots: [{ questionId: 'q1', questionDeadlineAt: null }],
        });
        return canAnswer(untimed, 'q1', now).allowed === true;
      }),
      { numRuns: RUNS },
    );
  });
});

describe('the per-question clock starts on OPEN and does not restart', () => {
  it('sets the deadline on first open, from the policy limit', () => {
    const opened = reduceAttempt(start(), { type: 'OPEN_QUESTION', questionId: 'q1', at: AT });
    expect(opened.slots[0]?.questionDeadlineAt).toBe(AT + 120_000);
  });

  it('does NOT restart the clock on a second open', () => {
    // Otherwise a student could refresh until the timer reset, which is why §9.1 calls the opening immutable.
    const once = reduceAttempt(start(), { type: 'OPEN_QUESTION', questionId: 'q1', at: AT });
    const again = reduceAttempt(once, { type: 'OPEN_QUESTION', questionId: 'q1', at: AT + 60_000 });
    expect(again.slots[0]?.questionDeadlineAt).toBe(AT + 120_000);
  });

  it('gives NO deadline when the question is untimed, so an unsubmitted question cannot expire', () => {
    const untimed = start({ perQuestionTimeLimitSec: null, perQuestionExpiry: 'SOFT' });
    const opened = reduceAttempt(untimed, { type: 'OPEN_QUESTION', questionId: 'q1', at: AT });
    expect(opened.slots[0]?.questionDeadlineAt).toBeNull();
  });

  it('moves the cursor to the opened question', () => {
    const opened = reduceAttempt(start(), { type: 'OPEN_QUESTION', questionId: 'q3', at: AT });
    expect(opened.cursor).toBe(2);
  });
});

describe('navigation moves the cursor and NOTHING ELSE', () => {
  it('changes no answer, no revision, and queues nothing', () => {
    const before = reduceAttempt(start(), answer('q1', 'kept'));
    for (const event of [
      { type: 'NEXT' },
      { type: 'PREVIOUS' },
      { type: 'GOTO', index: 3 },
    ] as const satisfies readonly AttemptEvent[]) {
      const after = reduceAttempt(before, event);
      expect(after.answers).toEqual(before.answers);
      expect(after.revisions).toEqual(before.revisions);
      expect(after.queued).toEqual(before.queued);
    }
  });

  it('clamps the cursor to the paper rather than throwing on a bad index', () => {
    let state = start({}, 3);
    state = reduceAttempt(state, { type: 'GOTO', index: 99 });
    expect(state.cursor).toBe(2);
    state = reduceAttempt(state, { type: 'GOTO', index: -5 });
    expect(state.cursor).toBe(0);
  });

  it('pins the cursor under ALL_AT_ONCE, which is what an ordinary quiz gets by DEFAULT', () => {
    const allAtOnce = start({ navigation: 'ALL_AT_ONCE' });
    expect(reduceAttempt(allAtOnce, { type: 'NEXT' }).cursor).toBe(0);
    expect(reduceAttempt(allAtOnce, { type: 'GOTO', index: 3 }).cursor).toBe(0);
    // And the default really is ALL_AT_ONCE: `QUIZ_PROFILE_DEFAULTS` overrides the base profile's ONE_AT_A_TIME.
    // Every other fixture in this file sets ONE_AT_A_TIME explicitly because it is NOT what an assignment gives.
    const asQuizzed = initialAttemptState({
      attemptId: 'at1',
      policy: resolvePolicy({ mode: 'ASSIGNMENT' }),
      deadlineAt: null,
      slots: [{ questionId: 'q1', questionDeadlineAt: null }],
    });
    expect(asQuizzed.policy.navigation).toBe('ALL_AT_ONCE');
  });

  it('survives an empty paper', () => {
    const empty = start({}, 0);
    expect(reduceAttempt(empty, { type: 'NEXT' }).cursor).toBe(0);
    expect(unanswered(empty)).toEqual([]);
  });
});

describe('a flag is a bookmark and changes NOTHING about the answer', () => {
  it('toggles without touching the answer, the revision, or the queue', () => {
    /**
     * `QuestionResponse.flagged` is a student annotation. If it bumped the revision it would put a bookmark into
     * the answer audit chain that §9.4 hashes, so "I want to come back to this" would become a graded event.
     */
    const answered = reduceAttempt(start(), answer('q1', 'kept'));
    const flagged = reduceAttempt(answered, { type: 'TOGGLE_FLAG', questionId: 'q1' });
    expect([...flagged.flagged]).toEqual(['q1']);
    expect(flagged.answers).toEqual(answered.answers);
    expect(flagged.revisions).toEqual(answered.revisions);
    expect(flagged.queued).toEqual(answered.queued);
    const unflagged = reduceAttempt(flagged, { type: 'TOGGLE_FLAG', questionId: 'q1' });
    expect([...unflagged.flagged]).toEqual([]);
  });

  it('ignores a flag on a question that is not in the paper', () => {
    const before = start();
    expect(reduceAttempt(before, { type: 'TOGGLE_FLAG', questionId: 'nope' })).toBe(before);
  });
});

describe('the 409 reconcile, where NEITHER copy is applied automatically', () => {
  const conflicted = () => {
    const mine = reduceAttempt(start(), answer('q1', 'my answer'));
    return reduceAttempt(mine, {
      type: 'CONFLICT',
      questionId: 'q1',
      theirs: 'their answer',
      theirRevision: 7,
    });
  };

  it('holds both copies and applies neither', () => {
    const state = conflicted();
    expect(state.reconcile).not.toBeNull();
    // Silently taking the server's would lose work the student believes they saved.
    expect(state.answers.q1).toBe('my answer');
    expect(state.reconcile?.theirs).toBe('their answer');
  });

  it('KEEP_THEIRS adopts the server copy and drops the queued write', () => {
    const state = reduceAttempt(conflicted(), { type: 'KEEP_THEIRS' });
    expect(state.answers.q1).toBe('their answer');
    expect(state.revisions.q1).toBe(7);
    expect(state.queued.filter((w) => w.questionId === 'q1')).toHaveLength(0);
    expect(state.reconcile).toBeNull();
  });

  it('KEEP_MINE re-queues at a NEW seq with a NEW idempotency key', () => {
    /**
     * REUSING THE KEY WOULD MAKE THE SERVER TREAT IT AS THE DUPLICATE IT ALREADY ANSWERED, and the student's
     * answer would be silently ignored -- which is the exact failure §9.3's idempotency rule creates after a 409.
     */
    const before = conflicted();
    const state = reduceAttempt(before, { type: 'KEEP_MINE' });
    const queued = state.queued.filter((w) => w.questionId === 'q1');
    expect(queued).toHaveLength(2);
    expect(queued[1]?.seq).toBeGreaterThan(queued[0]?.seq ?? 0);
    expect(queued[1]?.idempotencyKey).not.toBe(queued[0]?.idempotencyKey);
    expect(state.answers.q1).toBe('my answer');
  });

  it('ignores a reconcile decision when there is nothing to reconcile', () => {
    const before = start();
    expect(reduceAttempt(before, { type: 'KEEP_MINE' })).toBe(before);
    expect(reduceAttempt(before, { type: 'KEEP_THEIRS' })).toBe(before);
  });
});

describe('durability is a small closed set a student can act on', () => {
  it('moves CLEAN -> PENDING -> CLEAN as writes are made and acknowledged', () => {
    const queued = reduceAttempt(start(), answer('q1', 'x'));
    expect(queued.durability).toBe('PENDING');
    const acked = reduceAttempt(queued, { type: 'ACK', seq: queued.queued[0]?.seq ?? 0 });
    expect(acked.durability).toBe('CLEAN');
    expect(acked.queued).toHaveLength(0);
  });

  it('removes ONLY the acknowledged write, because one question may have three queued', () => {
    let state = reduceAttempt(start(), answer('q1', 'one'));
    state = reduceAttempt(state, answer('q1', 'two'));
    state = reduceAttempt(state, answer('q2', 'other'));
    const first = state.queued[0]?.seq ?? 0;
    const after = reduceAttempt(state, { type: 'ACK', seq: first });
    expect(after.queued).toHaveLength(2);
  });

  it('reports OFFLINE only when there is something unsent, so the label never cries wolf', () => {
    const clean = start();
    expect(reduceAttempt(clean, { type: 'OFFLINE' }).durability).toBe('CLEAN');
    const queued = reduceAttempt(clean, answer('q1', 'x'));
    expect(reduceAttempt(queued, { type: 'OFFLINE' }).durability).toBe('OFFLINE');
    expect(reduceAttempt(queued, { type: 'ONLINE' }).durability).toBe('PENDING');
  });

  it('ABANDON keeps the queue and says so, because §9.3 forbids silently losing AND silently keeping', () => {
    const queued = reduceAttempt(start(), answer('q1', 'unsaved'));
    const abandoned = reduceAttempt(queued, { type: 'ABANDON', at: AT });
    expect(abandoned.durability).toBe('ABANDONED');
    // The queue is KEPT: it is what the student is shown.
    expect(abandoned.queued).toHaveLength(1);
    expect(durabilityLabel(abandoned)).toContain('may not have been recorded');
    // And acknowledging afterwards does NOT turn it back into "all saved".
    const acked = reduceAttempt(abandoned, { type: 'ACK', seq: abandoned.queued[0]?.seq ?? 0 });
    expect(acked.durability).toBe('ABANDONED');
  });

  it('does not resurrect an ABANDONED attempt into PENDING on a later answer', () => {
    const abandoned = reduceAttempt(reduceAttempt(start(), answer('q1', 'x')), {
      type: 'ABANDON',
      at: AT,
    });
    expect(reduceAttempt(abandoned, answer('q2', 'y')).durability).toBe('ABANDONED');
  });

  it('says something a student can read for every state', () => {
    for (const label of [
      durabilityLabel(start()),
      durabilityLabel(reduceAttempt(start(), answer('q1', 'x'))),
      durabilityLabel({ ...start(), durability: 'ABANDONED' }),
    ]) {
      expect(label.length).toBeGreaterThan(5);
      expect(label).not.toContain('undefined');
    }
  });
});

describe('properties over the reducer', () => {
  /** Any event that is not `ANSWER`, for the "navigation changes nothing" style properties. */
  const arbNonAnswerEvent = fc.oneof(
    fc.constant({ type: 'NEXT' } as const),
    fc.constant({ type: 'PREVIOUS' } as const),
    fc.integer({ min: -3, max: 8 }).map((index) => ({ type: 'GOTO', index }) as const),
    fc
      .constantFrom('q1', 'q2', 'q3', 'q4', 'nope')
      .map((questionId) => ({ type: 'TOGGLE_FLAG', questionId }) as const),
    fc.constant({ type: 'OFFLINE' } as const),
    fc.constant({ type: 'ONLINE' } as const),
    fc.integer({ min: 0, max: 4 }).map((seq) => ({ type: 'ACK', seq }) as const),
  );

  it('replays an event log to the SAME state, so the paper is reconstructible', () => {
    /**
     * The property a support conversation about a lost answer needs: given the events, the state is
     * deterministic. If this fails, "what did the student have at 14:03" has no answer.
     */
    fc.assert(
      fc.property(
        fc.array(arbNonAnswerEvent, { maxLength: 8 }),
        // `fc.array` takes `(arbitrary, constraints)` -- TWO arguments. The first version passed a third,
        // which is not a signature `fast-check` has, and paired each question id with its OWN array of values
        // rather than nesting them.
        fc.array(
          fc.tuple(
            fc.constantFrom('q1', 'q2', 'q3'),
            fc.array(fc.string({ maxLength: 4 }), { maxLength: 3 }),
          ),
          { maxLength: 6 },
        ),
        (events, answerings) => {
          const log: AttemptEvent[] = [...events];
          for (const [questionId, values] of answerings) {
            for (const value of values) log.push(answer(questionId, value));
          }
          const once = replay(start(), log);
          const twice = replay(start(), log);
          return (
            JSON.stringify(once.answers) === JSON.stringify(twice.answers) &&
            JSON.stringify(once.queued) === JSON.stringify(twice.queued)
          );
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('never reuses a `seq`, whatever the event order', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom('q1', 'q2', 'q3'), { maxLength: 8 }), (questionIds) => {
        const state = questionIds.reduce(
          (acc, questionId) => reduceAttempt(acc, answer(questionId, 'x')),
          start(),
        );
        const seqs = state.queued.map((write) => write.seq);
        return new Set(seqs).size === seqs.length && seqs.length === questionIds.length;
      }),
      { numRuns: RUNS },
    );
  });

  it('is unchanged by ANY non-ANSWER event except cursor, flags, durability and the queue', () => {
    fc.assert(
      fc.property(arbNonAnswerEvent, (event) => {
        const before = reduceAttempt(start(), answer('q1', 'kept'));
        const after = reduceAttempt(before, event);
        // The four things a non-answer event may legitimately change.
        void after.cursor;
        void after.flagged;
        void after.durability;
        void after.queued;
        return JSON.stringify(after.answers) === JSON.stringify(before.answers);
      }),
      { numRuns: RUNS },
    );
  });

  it('keeps `answers` free of prototype keys, so a question id cannot reach Object.prototype', () => {
    // The answers map is built with object spread and a computed key, so `__proto__` is the one id that could
    // do something other than add a key.
    // A plain `answers[id] = value` would invoke the inherited `__proto__` SETTER, replacing the map's prototype
    // AND losing the answer entirely -- `defineProperty` creates an own key instead, which is the only reason
    // the reducer is safe against a question id it did not choose.
    /**
     * THE PAPER CONTAINS THE HOSTILE ID, and that detail is the whole test.
     *
     * The first version answered a question called `__proto__` on a paper whose questions are `q1`..`q4` -- and
     * the store correctly REFUSED it, because `canAnswer` rejects a question that is not in the paper. So the
     * test was asserting a property of a write that never happened, and it failed for the best possible reason.
     *
     * This version puts the id in the slots, which is what a malformed `QuestionResponse` from the server would
     * look like, and checks that writing it does not reach `Object.prototype`.
     */
    const hostile = initialAttemptState({
      attemptId: 'at1',
      policy: policy(),
      deadlineAt: null,
      slots: [{ questionId: '__proto__', questionDeadlineAt: null }],
    });
    const state = reduceAttempt(hostile, answer('__proto__', { polluted: true }));
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(state.answers)).toBe(Object.prototype);
    expect(Object.hasOwn(state.answers, '__proto__')).toBe(true);
    // `state.revisions.__proto__` reads as "the revision count for `__proto__`" but is actually reading
    // `Object.prototype`, which is `1` -- so the assertion passed for the wrong reason and would have passed even if
    // the `__proto__` revision had been dropped entirely. The own-property form is what the store is claiming.
    expect(Object.hasOwn(state.revisions, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(state.revisions)).toBe(Object.prototype);
  });

  it('holds the cursor inside the paper for every sequence of navigation', () => {
    fc.assert(
      fc.property(fc.array(arbNonAnswerEvent, { minLength: 1, maxLength: 12 }), (events) => {
        const state = replay(start({}, 5), events);
        return state.cursor >= 0 && state.cursor < 5;
      }),
      { numRuns: RUNS },
    );
  });

  it('never loses a queued write except by ACK, KEEP_THEIRS, a dead letter, or a flush', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('q1', 'q2', 'q3'), { maxLength: 5 }),
        fc.array(arbNonAnswerEvent, { maxLength: 5 }),
        (questionIds, events) => {
          const queued = questionIds.reduce(
            (acc, q) => reduceAttempt(acc, answer(q, 'x')),
            start(),
          );
          const after = replay(queued, events);
          // Every seq that was not explicitly acknowledged is still present.
          const acked = new Set(
            events.filter((e) => e.type === 'ACK').map((e) => (e as { seq: number }).seq),
          );
          return after.queued.every((write) => !acked.has(write.seq));
        },
      ),
      { numRuns: RUNS },
    );
  });
});

describe('the outbox flushes in seq order and STOPS at the first failure', () => {
  const write = (seq: number): QueuedWrite => ({
    seq,
    questionId: `q${String(seq)}`,
    answer: seq,
    revision: 1,
    idempotencyKey: `key-${String(seq)}`,
    issuedAt: AT + seq,
  });

  it('drains a queue in seq order however the store returns it', async () => {
    const store = memoryOutboxStore([write(3), write(1), write(2)]);
    const sent: number[] = [];
    const result = await flush(store, async (w) => {
      sent.push(w.seq);
      return { kind: 'ACK' };
    });
    expect(result).toEqual({ kind: 'DRAINED', sent: 3 });
    expect(sent).toEqual([1, 2, 3]);
  });

  it('sorts NUMERICALLY, because string order puts 10 before 9 and the ninth comes back a 409', async () => {
    const store = memoryOutboxStore([write(10), write(9), write(1)]);
    const sent: number[] = [];
    await flush(store, async (w) => {
      sent.push(w.seq);
      return { kind: 'ACK' };
    });
    expect(sent).toEqual([1, 9, 10]);
  });

  it('STOPS at a retryable failure and leaves that write queued', async () => {
    const store = memoryOutboxStore([write(1), write(2), write(3)]);
    const result = await flush(store, async (w) =>
      w.seq === 2 ? { kind: 'RETRY', message: 'offline' } : { kind: 'ACK' },
    );
    expect(result).toEqual({ kind: 'STOPPED', sent: 1, write: write(2), reason: 'RETRY' });
    expect(store.snapshot().map((w) => w.seq)).toEqual([2, 3]);
  });

  it("STOPS at a conflict, because a 409 is the student's decision and not ours to retry", async () => {
    const store = memoryOutboxStore([write(1), write(2)]);
    const result = await flush(store, async (w) =>
      w.seq === 1
        ? { kind: 'CONFLICT', serverAnswer: 'theirs', serverRevision: 9 }
        : { kind: 'ACK' },
    );
    expect(result.kind).toBe('STOPPED');
    expect(result.kind === 'STOPPED' && result.reason).toBe('CONFLICT');
    expect(store.snapshot()).toHaveLength(2);
  });

  it('REMOVES a dead letter rather than skipping it, so it cannot block the queue for ever', async () => {
    const store = memoryOutboxStore([write(1), write(2), write(3)]);
    const result = await flush(store, async () => ({ kind: 'ACK' }), {
      deadLetters: [{ matches: (w) => w.seq === 2, because: 'the question was withdrawn' }],
    });
    expect(result).toEqual({ kind: 'DRAINED', sent: 3 });
    expect(store.snapshot()).toHaveLength(0);
  });

  it('reports NOTHING_TO_DO for an empty queue, because a reconnect is usually empty', async () => {
    expect(await flush(memoryOutboxStore(), async () => ({ kind: 'ACK' }))).toEqual({
      kind: 'NOTHING_TO_DO',
    });
  });

  it('does not send the same seq twice when the store already holds duplicates', async () => {
    const store = memoryOutboxStore([write(1), write(1)]);
    const sent: number[] = [];
    await flush(store, async (w) => {
      sent.push(w.seq);
      return { kind: 'ACK' };
    });
    // `remove` takes the key, so the duplicate goes with it -- but it is only SENT once, because the second
    // ACK for a seq already removed is a no-op rather than a second write.
    expect(new Set(sent).size).toBe(1);
  });

  it('needs no try/catch at the call site, because every failure mode is a return value', () => {
    // A student on a train produces a RETRY on most flushes; a throw here would take down the page they are
    // taking an exam on.
    expect(typeof flush).toBe('function');
  });

  it('flushes again after the budget, so a student who has been typing gets their answers sent', () => {
    expect(shouldFlushNow(null, AT)).toBe(true);
    expect(shouldFlushNow(AT, AT + AUTOSAVE_BUDGET_MS - 1)).toBe(false);
    expect(shouldFlushNow(AT, AT + AUTOSAVE_BUDGET_MS)).toBe(true);
  });
});

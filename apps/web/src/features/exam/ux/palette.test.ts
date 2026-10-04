import { resolvePolicy } from '@orrery/contracts/policy';
import { describe, expect, it } from 'vitest';

import { type AttemptState, initialAttemptState, reduceAttempt } from '../answerStore';
import { palette, paletteTarget } from './palette';

const AT = Date.parse('2026-03-01T09:00:00Z');
/**
 * `perQuestionExpiry: 'LOCK'` IS SET EXPLICITLY, and the reason is worth recording rather than tidying away.
 *
 * `EXAM_PROFILE_DEFAULTS.perQuestionExpiry` is **`'SOFT'`**, so a fixture written the obvious way -- resolve the EXAM
 * profile, give a question a deadline an hour ago, assert it is closed -- produces a question that is still writable,
 * because `SOFT` means "editable until the overall deadline". Three tests failed on exactly this before the fixture
 * said which term it meant.
 *
 * That is the previous commit's fix showing up here, which is the best evidence I have that it landed: the term a
 * teacher picks now changes real behaviour, loudly enough to break a test that forgot to pick one.
 */
const POLICY = resolvePolicy({
  mode: 'EXAM',
  versionPolicy: {
    navigation: 'ONE_AT_A_TIME',
    perQuestionTimeLimitSec: 120,
    perQuestionExpiry: 'LOCK',
  },
});

const stateWith = (
  slots: number,
  over: (state: AttemptState) => AttemptState = (state) => state,
): AttemptState =>
  over(
    initialAttemptState({
      attemptId: 'at1',
      policy: POLICY,
      deadlineAt: AT + 3_600_000,
      slots: Array.from({ length: slots }, (_, i) => ({
        questionId: `q${String(i + 1)}`,
        questionDeadlineAt: null,
      })),
    }),
  );

const answered = (state: AttemptState, questionId: string, value: unknown): AttemptState =>
  reduceAttempt(state, {
    type: 'ANSWER',
    questionId,
    answer: value,
    idempotencyKey: `${questionId}-1`,
    at: AT,
  });

describe('the palette reports ANSWERED and UNANSWERED, and there is no third state', () => {
  it('classifies every question, and a flagged question keeps its answer state', () => {
    const state = answered(
      reduceAttempt(stateWith(3), { type: 'TOGGLE_FLAG', questionId: 'q2' }),
      'q1',
      { choiceIds: ['a'] },
    );
    const result = palette(state, AT);

    expect(result.entries.map((entry) => entry.status)).toEqual([
      'ANSWERED',
      'UNANSWERED',
      'UNANSWERED',
    ]);
    // Orthogonal, not a replacement: flagging q2 must not make it look answered.
    expect(result.entries[1]?.flagged).toBe(true);
    expect(result.entries[1]?.status).toBe('UNANSWERED');
  });

  it('carries NO CORRECTNESS ANYWHERE, and that is a property rather than a promise', () => {
    /**
     * The tempting palette is a green tick per question. That is a sealed grade on a screen mid-exam (`INV-RELEASE-2`),
     * and it is the most useful signal in an auto-graded paper, so a student who saw it could revise precisely the
     * questions it named.
     *
     * There is no field for correctness in `AttemptState`, which is good, but "there is no field" is weaker than
     * "nothing changes when correctness changes" -- so the model is walked over the vocabulary and, separately, two
     * states differing only in what a grader would think of the answers must render identically.
     */
    const result = palette(answered(stateWith(2), 'q1', { choiceIds: ['a'] }), AT);
    /**
     * THE LABELS AND THE SUMMARY, NOT THE WHOLE OBJECT. My first version stringified the entire result and banned the
     * word "true" -- which fails on `flagged: true`, a boolean with no opinion in it. Scanning a serialised struct for
     * substrings is the wrong instrument: it cannot tell a boolean from a claim, so it fails for a reason unrelated to
     * the guarantee and would be quietly deleted the first time somebody added a field.
     */
    const spoken = [...result.entries.map((entry) => entry.label), result.summary]
      .join(' ')
      .toLowerCase();
    for (const word of [
      'correct',
      'wrong',
      'right',
      'mark',
      'score',
      'passed',
      'failed',
      'green',
      'tick',
    ]) {
      expect(spoken, `"${word}" must not appear in anything a student reads`).not.toContain(word);
    }

    const allRight = answered(stateWith(2), 'q1', { choiceIds: ['the-correct-one'] });
    const allWrong = answered(stateWith(2), 'q1', { choiceIds: ['the-wrong-one'] });
    expect(palette(allRight, AT)).toEqual(palette(allWrong, AT));
  });

  it('says UNANSWERED for an answer CLEARED to nothing, because that is what the store can see', () => {
    /**
     * `answerStore` records an answer of `undefined` by DELETING the key, so "cleared every option" and "never touched
     * it" are one stored fact. A palette that invented a distinction the store cannot represent would be asserting
     * something it does not know -- and it would disagree with the grader, which reads the same absence as a blank.
     */
    const cleared = answered(answered(stateWith(1), 'q1', { choiceIds: ['a'] }), 'q1', undefined);
    expect(palette(cleared, AT).entries[0]?.status).toBe('UNANSWERED');
  });

  it('reports LOCKED only when the policy locks, and a LOCKED question is still REACHABLE', () => {
    /**
     * This is the decision with the most behind it. `lockQuestionAfterAnswer` is about WRITING: the answer may not
     * change. It is not about READING, and a student who cannot go back and look at what they wrote has been
     * deprived of review for no reason the policy states.
     *
     * `answerStore.canAnswer` refuses the write and answers a different question, so its `LOCKED` reason is
     * deliberately NOT propagated into `blockedBecause`.
     */
    const locking = stateWith(2, (state) => ({
      ...state,
      policy: resolvePolicy({
        mode: 'EXAM',
        versionPolicy: { lockQuestionAfterAnswer: true, perQuestionExpiry: 'LOCK' as const },
      }),
    }));
    const state = answered(locking, 'q1', { choiceIds: ['a'] });
    const result = palette(state, AT);

    expect(result.entries[0]?.status).toBe('LOCKED');
    expect(result.entries[0]?.blockedBecause).toBeNull();
    expect(paletteTarget(state, AT, 0).permitted).toBe(true);
  });

  it('counts what a student can still change, and a LOCKED answer is not in it', () => {
    const locking = stateWith(2, (state) => ({
      ...state,
      policy: resolvePolicy({
        mode: 'EXAM',
        versionPolicy: { lockQuestionAfterAnswer: true, perQuestionExpiry: 'LOCK' as const },
      }),
    }));
    const state = answered(locking, 'q1', { choiceIds: ['a'] });
    const result = palette(state, AT);
    // `answered` COUNTS a locked one: `LOCKED` is `ANSWERED` plus "you may not change it", and a summary that failed
    // to account for a two-question paper would tell a student one of their questions does not exist.
    expect(result.answered).toBe(1);
    expect(result.unanswered).toBe(1);
    // ...but `open` excludes it, which is the distinction: a locked question cannot be changed.
    expect(result.open).toBe(1);
  });
});

describe('the student may go anywhere, and a closed one says so instead of doing nothing', () => {
  it('permits a jump in EITHER direction, because ONE_AT_A_TIME is about PRESENTATION', () => {
    /**
     * `ONE_AT_A_TIME` means one question is presented at a time -- no scrolling a whole paper. If it also meant the
     * paper was a one-way corridor, a student who mis-clicked question 4 could never reach question 1 again without
     * replaying 2 and 3, and under `perQuestionTimeLimitSec` that is punitive.
     *
     * The policy already has the mechanism for "you may not return": `lockQuestionAfterAnswer`. Navigation that blocked
     * return would make that flag redundant.
     */
    const state = stateWith(5);
    for (const index of [0, 4, 2]) {
      expect(paletteTarget(state, AT, index).permitted, `question ${String(index + 1)}`).toBe(true);
    }
  });

  it('permits going to the question already shown, so the current item is never a dead control', () => {
    expect(paletteTarget(stateWith(3), AT, 0).permitted).toBe(true);
  });

  it('refuses a CLOSED window WITH A REASON, rather than silently ignoring the click', () => {
    /**
     * The alternative is a `disabled` button, which is not focusable -- so a student using a screen reader cannot
     * discover that the question exists or why it is closed. `aria-disabled` keeps it discoverable and a refusal with
     * a reason keeps the click from being a no-op, which is the quieter version of the dead end `plans/09` §6.2
     * exists to prevent.
     */
    const state = reduceAttempt(
      stateWith(3, (base) => ({
        ...base,
        slots: [
          { questionId: 'q1', questionDeadlineAt: AT - 61_000 },
          { questionId: 'q2', questionDeadlineAt: null },
          { questionId: 'q3', questionDeadlineAt: null },
        ],
      })),
      // MOVE THE CURSOR OFF THE CLOSED QUESTION before testing the refusal, because `paletteTarget` always permits
      // the question already shown. Testing index 0 against a state whose cursor is 0 asserts that rule fails.
      { type: 'GOTO', index: 1 },
    );
    const result = palette(state, AT);

    expect(result.entries[0]?.status).toBe('WINDOW_CLOSED');
    expect(result.entries[0]?.blockedBecause).toBe('QUESTION_DEADLINE_PASSED');
    const target = paletteTarget(state, AT, 0);
    expect(target.permitted).toBe(false);
    expect(target.why).toMatch(/time is up/i);
    // ...and an OPEN question in the same palette is still reachable, so the palette is not disabled wholesale.
    expect(paletteTarget(state, AT, 1).permitted).toBe(true);
  });

  it('refuses every OTHER destination once the attempt is over, and says the attempt is closed', () => {
    const submitted = reduceAttempt(stateWith(3), { type: 'SUBMIT' });
    // The cursor is at 0, and index 0 is therefore NOT tested here -- `paletteTarget` always permits the question
    // already shown, because refusing to look at a closed paper is not a service. My first version looped `[0, 1]`
    // and failed on 0, which is the rule working rather than the rule being wrong.
    for (const index of [1, 2]) {
      const target = paletteTarget(submitted, AT, index);
      expect(target.permitted, `question ${String(index + 1)}`).toBe(false);
      expect(target.why).toMatch(/closed/i);
    }
    expect(paletteTarget(submitted, AT, submitted.cursor).permitted).toBe(true);
  });

  it('refuses a position that does not exist, rather than reading undefined', () => {
    const target = paletteTarget(stateWith(2), AT, 9);
    expect(target.permitted).toBe(false);
    expect(target.why).toMatch(/no question/i);
  });
});

describe('the labels are computed here, not in JSX', () => {
  it('names every entry with its position and its state', () => {
    const state = answered(stateWith(2), 'q1', { choiceIds: ['a'] });
    expect(palette(state, AT).entries[0]?.label).toBe('Question 1 of 2, answered');
    expect(palette(state, AT).entries[1]?.label).toBe('Question 2 of 2, not answered');
  });

  it('says "window closed" and "locked" in words, because a student cannot act on a colour', () => {
    const closed = stateWith(1, (base) => ({
      ...base,
      slots: [{ questionId: 'q1', questionDeadlineAt: AT - 61_000 }],
    }));
    expect(palette(closed, AT).entries[0]?.label).toBe('Question 1 of 1, window closed');

    const locking = stateWith(1, (base) => ({
      ...base,
      policy: resolvePolicy({
        mode: 'EXAM',
        versionPolicy: { lockQuestionAfterAnswer: true, perQuestionExpiry: 'LOCK' as const },
      }),
    }));
    expect(palette(answered(locking, 'q1', 'x'), AT).entries[0]?.label).toContain('locked');
  });

  it('says a flagged question is flagged FOR REVIEW, which is a note to self and not a warning', () => {
    const state = reduceAttempt(stateWith(1), { type: 'TOGGLE_FLAG', questionId: 'q1' });
    expect(palette(state, AT).entries[0]?.label).toContain('flagged for review');
  });

  /**
   * `showQuestionNumbers: false` HIDES THE AUTHORED NUMBER, NOT THE POSITION.
   *
   * Two different facts. The authored number is what a teacher's paper prints and can differ from the order this
   * student drew -- that is the one the policy is about. The position within the paper is unavoidable for navigation
   * and is visible anyway by counting, so the palette falls back to it and says so.
   */
  it('falls back to position when the authored number is hidden', () => {
    const hidden = stateWith(2, (base) => ({
      ...base,
      policy: resolvePolicy({
        mode: 'EXAM',
        versionPolicy: { showQuestionNumbers: false, navigation: 'ONE_AT_A_TIME' },
      }),
    }));
    expect(palette(hidden, AT).entries[0]?.label).toBe('Question of 2, not answered');
  });

  it('describes an EMPTY paper rather than rendering forty unlabelled buttons', () => {
    const empty = palette(stateWith(0), AT);
    expect(empty.entries).toHaveLength(0);
    expect(empty.summary).toMatch(/no questions/i);
  });

  it('summarises in counts a student can act on, and never as a percentage', () => {
    const state = answered(answered(stateWith(4), 'q1', 'x'), 'q3', 'y');
    expect(palette(state, AT).summary).toBe('2 questions answered, 2 questions not answered');
  });
});

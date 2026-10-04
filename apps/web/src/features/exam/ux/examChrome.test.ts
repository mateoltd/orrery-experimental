import { resolvePolicy } from '@orrery/contracts/policy';
import { describe, expect, it } from 'vitest';

import { type AttemptState, initialAttemptState, reduceAttempt } from '../answerStore';
import { LEAVE_MESSAGE, leaveDecision } from './leaveAndReturn';
import { submitConfirm } from './submitConfirm';

const AT = Date.parse('2026-03-01T09:00:00Z');
const DEADLINE = AT + 3_600_000;

const POLICY = resolvePolicy({
  mode: 'EXAM',
  versionPolicy: {
    navigation: 'ONE_AT_A_TIME',
    perQuestionExpiry: 'LOCK',
    gracePeriodSec: 60,
  },
});

const stateWith = (over: Partial<Parameters<typeof initialAttemptState>[0]> = {}): AttemptState =>
  initialAttemptState({
    attemptId: 'at1',
    policy: POLICY,
    deadlineAt: DEADLINE,
    slots: [
      { questionId: 'q1', questionDeadlineAt: null },
      { questionId: 'q2', questionDeadlineAt: null },
      { questionId: 'q3', questionDeadlineAt: null },
    ],
    ...over,
  });

const at = (offsetMs: number) => ({ clientNow: AT + offsetMs, offset: 0 });

const answer = (state: AttemptState, questionId: string, value: unknown, atMs = AT): AttemptState =>
  reduceAttempt(state, {
    type: 'ANSWER',
    questionId,
    answer: value,
    idempotencyKey: `${questionId}-${String(atMs)}`,
    at: atMs,
  });

describe('the submit dialog depends on NOTHING about whether an answer is right', () => {
  /**
   * `INV-RELEASE-2` DOES NOT SAY "NO SCORE FIELD". It says no score may be *INFERABLE*, and it enumerates a count of
   * correct answers among the ways that happens. "You got 4 of 5 right, submit anyway?" is the obvious design and it is
   * completely forbidden: it is the single most useful signal in an auto-graded paper, and a student who saw it
   * mid-exam could revise precisely the questions it names.
   *
   * `AttemptState` has no key in it, so this cannot grade -- but "there is no field for it" is a weaker promise than
   * "nothing it renders changes when correctness changes", so that is what is asserted.
   */
  it('renders IDENTICALLY for correct and incorrect answers', () => {
    const allRight = answer(stateWith(), 'q1', { choiceIds: ['the-correct-one'] });
    const allWrong = answer(stateWith(), 'q1', { choiceIds: ['the-wrong-one'] });

    expect(submitConfirm(allRight, at(0))).toEqual(submitConfirm(allWrong, at(0)));

    /**
     * THE VOCABULARY SCAN IS GONE, AND IT FAILED TWICE BEFORE I ACCEPTED THAT.
     *
     * The dialog contains the phrases "**not a wrong answer**" and "it is **scored** as a blank" -- both required by
     * `plans/07`, both denials of a verdict rather than verdicts. So a scan for 'wrong' failed on a disclaimer, and
     * narrowing it to 'score' failed on the next one.
     *
     * **A SUBSTRING SCAN CANNOT TELL A CLAIM FROM A DENIAL OF ONE**, and every attempt to rescue it by pruning the word
     * list produces a weaker test that passes for a new reason. So it is replaced by the check that actually states
     * the guarantee: no VALUE from an answer reaches the output. That is a data-flow assertion, it does not care what
     * the copy says, and it fails for the right reason if somebody adds a "you got N of M right" line.
     */
    const rendered = JSON.stringify(submitConfirm(allRight, at(0)));
    expect(rendered, 'no answer VALUE may reach the dialog').not.toContain('the-correct-one');
    expect(rendered).not.toContain('the-wrong-one');
    // ...and no question id either, which is what a "jump to question 3" affordance would smuggle in alongside it.
    expect(rendered).not.toContain('q1');
  });

  it('says NOTHING to a student who has answered everything AND had it saved', () => {
    /**
     * The `ACK` is not incidental. `reduceAttempt`'s `ANSWER` case QUEUES a write, so a store where three questions
     * are answered is a store with three unsaved writes -- and the dialog is right to speak. My first version forgot
     * that and asserted silence about a state that genuinely had something pending.
     *
     * The store's own property makes the correct fixture a little awkward: nothing else clears `queued`, so the only
     * way to reach "all answered and all acknowledged" is to ACK each `seq`.
     */
    let complete = answer(answer(answer(stateWith(), 'q1', 'a'), 'q2', 'b'), 'q3', 'c');
    for (const write of complete.queued)
      complete = reduceAttempt(complete, { type: 'ACK', seq: write.seq });
    expect(complete.queued).toHaveLength(0);
    // Interrupting a student who is finished, to confirm they are finished, is the modal that trains people to click
    // through dialogs without reading them.
    expect(submitConfirm(complete, at(0))).toBeNull();
  });
});

describe('it is never a dead end, as a PROPERTY rather than a promise', () => {
  it('always offers at least one action, across every combination that matters', () => {
    /**
     * `plans/09` §6.2's rule -- an integrity modal with one disabled button BLOCKS the exam -- applies here too, and the
     * difference is that a submit dialog appears at the moment a student is most ready to leave.
     *
     * So it is walked rather than asserted in a case: four states x four instants, and every result has somewhere to
     * go.
     */
    const variants: readonly AttemptState[] = [
      stateWith(),
      answer(stateWith(), 'q1', 'a'),
      reduceAttempt(stateWith(), { type: 'OFFLINE' }),
      reduceAttempt(answer(stateWith(), 'q1', 'a'), { type: 'SUBMIT' }),
    ];
    const offsets = [0, DEADLINE - AT, DEADLINE - AT + 60_001, DEADLINE - AT + 10 * 60_000];

    for (const state of variants) {
      for (const offset of offsets) {
        const dialog = submitConfirm(state, at(offset));
        if (dialog === null) continue;
        expect(dialog.actions.length, `offset ${String(offset)}`).toBeGreaterThan(0);
        // At most one primary, so a keyboard user's focus is unambiguous.
        expect(dialog.actions.filter((action) => action.primary).length).toBeLessThanOrEqual(1);
        // Every action is one of the three known kinds -- no button that does nothing.
        for (const action of dialog.actions) {
          expect(['SUBMIT', 'CANCEL', 'NONE']).toContain(action.kind);
        }
      }
    }
  });

  it('offers NO submit action once the paper is closed, rather than one that will fail', () => {
    const state = answer(stateWith(), 'q1', 'a');
    const dialog = submitConfirm(state, at(DEADLINE - AT + 60_001));
    expect(dialog?.closed).toBe(true);
    // A button that fails is worse than no button: the student presses it, waits, and learns the outcome from an
    // error rather than from a sentence written before they committed.
    expect(dialog?.actions.map((action) => action.kind)).not.toContain('SUBMIT');
  });

  it('keeps the REVERSIBLE choice off the default key', () => {
    const dialog = submitConfirm(stateWith(), at(0));
    // Enter in a hurry must keep the paper, not send it.
    expect(dialog?.actions.find((action) => action.primary)?.kind).toBe('SUBMIT');
    const cancel = dialog?.actions.find((action) => action.kind === 'CANCEL');
    expect(cancel?.primary).toBe(false);
    expect(cancel?.label).toMatch(/keep working/i);
  });
});

describe('CLOSED outranks UNSAVED outranks UNANSWERED', () => {
  it('says the PAPER is over rather than listing unanswered questions', () => {
    const dialog = submitConfirm(stateWith(), at(DEADLINE - AT + 10 * 60_000));
    expect(dialog?.heading).toMatch(/time is up/i);
    const text = dialog?.detail.join(' ') ?? '';
    // Telling a student whose paper closed four minutes ago that they have unanswered questions is technically true
    // and actively harmful.
    expect(text).not.toMatch(/no answer/i);
    // ...and the disclosure the plan requires in exactly this situation.
    expect(text).toMatch(/may not have been recorded/i);
  });

  it('says SUBMITTED, not "time is up", for an attempt already submitted', () => {
    const submitted = reduceAttempt(stateWith(), { type: 'SUBMIT' });
    expect(submitConfirm(submitted, at(0))?.heading).toMatch(/already been submitted|submitted/i);
  });

  it('BLOCKS on unsaved writes, because proceeding loses something irreversible', () => {
    const queued = reduceAttempt(answer(stateWith(), 'q1', 'a'), { type: 'OFFLINE' });
    const dialog = submitConfirm(queued, at(0));
    expect(dialog?.blocking).toBe(true);
    expect(dialog?.detail.join(' ')).toMatch(/not yet reached the server/i);
  });

  it('does NOT block just because questions are unanswered -- nothing is lost by a second look', () => {
    const dialog = submitConfirm(stateWith(), at(0));
    expect(dialog?.blocking).toBe(false);
  });
});

describe('an unanswered question is named by POSITION and never by its answer', () => {
  it('lists the positions, so a student can go back and answer them', () => {
    const dialog = submitConfirm(answer(stateWith(), 'q2', 'a'), at(0));
    const text = dialog?.detail.join(' ') ?? '';
    expect(text).toMatch(/#1, #3/);
  });

  it('says a blank is scored as a BLANK, which is not the same as wrong', () => {
    // `plans/07` grades an absent key as a blank and never as zero, and a student told "1 question wrong" has been told
    // something the grader will not agree with.
    const dialog = submitConfirm(stateWith(), at(0));
    expect(dialog?.detail.join(' ')).toMatch(/not a wrong answer/i);
  });

  it('applies the clock OFFSET, because a slow client must not think it has more time', () => {
    const state = stateWith({ deadlineAt: AT + 30_000 });
    /**
     * 120 s of skew, not 31 s. The bare deadline is 30 s out but the GRACE is 60 s, so a 31 s offset leaves the write
     * window open -- `AT + 31_000 > AT + 30_000 + 60_000` is false. My first version asserted `closed` here and got
     * `undefined`, and the implementation was right: a client 31 s slow still has a minute of grace.
     */
    expect(submitConfirm(state, { clientNow: AT, offset: 120_000 })?.closed).toBe(true);
    // ...and a well-synced client at the same instant still sees the paper as open. One fact, two clocks, two answers.
    expect(submitConfirm(state, { clientNow: AT, offset: 0 })?.closed).toBe(false);
  });
});

describe('leaving never pauses the clock, and the product never pretends it does', () => {
  it('always says the clock continues, and always that the attempt is resumable', () => {
    for (const state of [stateWith(), answer(stateWith(), 'q1', 'a')]) {
      for (const departure of ['UNLOAD', 'IN_APP_NAVIGATION'] as const) {
        const decision = leaveDecision(state, departure);
        expect(decision.clockContinues, departure).toBe(true);
        expect(decision.resumable, departure).toBe(true);
      }
    }
  });

  /**
   * THE BROWSER WILL NOT LET US SAY ANYTHING, AND `message` IS `null` RATHER THAN ABSENT.
   *
   * `beforeunload` can suppress its own dialog and modern browsers show THEIR string; there is no API for custom copy.
   * So `UNLOAD` carries no message at all. Typed `null` rather than omitted for the reason `Evidence['detail']` was
   * widened to admit it in P8-T5: an absent field reads as "nothing to say" and `false` reads as "we said no", and both
   * assert something nobody knows. Any copy here would be a claim about a browser behaviour we cannot implement.
   */
  it('carries NO message for an unload, because we cannot write one', () => {
    expect(leaveDecision(answer(stateWith(), 'q1', 'a'), 'UNLOAD').message).toBeNull();
  });

  it('gives an in-app departure a real sentence, and says nothing when nothing is at stake', () => {
    expect(leaveDecision(answer(stateWith(), 'q1', 'a'), 'IN_APP_NAVIGATION').message).toBe(
      LEAVE_MESSAGE,
    );
    // An untouched paper is empty; leaving costs nothing and a dialog about it is noise.
    expect(leaveDecision(stateWith(), 'IN_APP_NAVIGATION').warn).toBe(false);
  });

  it('the sentence promises saving AND continuation, and claims nothing about fairness', () => {
    // A product that pauses is lying, because the server's timer did not pause. It says what is true instead.
    expect(LEAVE_MESSAGE).toMatch(/saved on this device/i);
    expect(LEAVE_MESSAGE).toMatch(/time keeps running/i);
    expect(LEAVE_MESSAGE).toMatch(/come back/i);
  });

  it('asks first when there is something to lose: queued writes, any answer, or an open window', () => {
    expect(leaveDecision(stateWith(), 'UNLOAD').warn).toBe(false);

    const answered = answer(stateWith(), 'q1', 'a');
    expect(leaveDecision(answered, 'UNLOAD').warn).toBe(true);

    /**
     * QUEUED WRITES ALONE ARE ENOUGH, and this has to be asserted on the SHAPE rather than through the reducer.
     *
     * `reduceAttempt` cannot produce it: `ANSWER` is the only event that queues a write and it always sets an answer,
     * so "queued but nothing answered" is unreachable through the store. The rule is still worth stating -- it is the
     * strongest of the three, and it is what `answerStore`'s `ABANDONED` exists for -- and `leaveDecision` takes a
     * `Pick` precisely so its rules can be checked independently of how the store happens to reach them.
     *
     * **AND THE HONEST CONSEQUENCE: today `answered` subsumes this.** Every queued write implies an answer, so
     * `queued` adds nothing the other two clauses do not already catch. It is kept because that is a property of the
     * reducer, not of this rule, and a future event that queues without answering would need it.
     */
    const queuedOnly = {
      ...stateWith(),
      answers: {},
      queued: [
        {
          seq: 1,
          questionId: 'q1',
          answer: { choiceIds: ['a'] },
          revision: 1,
          idempotencyKey: 'k1',
          issuedAt: AT,
        },
      ],
    };
    expect(leaveDecision(queuedOnly, 'UNLOAD').warn).toBe(true);

    // An open per-question window is enough: a timer that expires while the student is away is a surprise.
    const windowed = stateWith({
      slots: [{ questionId: 'q1', questionDeadlineAt: AT + 60_000 }],
    });
    expect(leaveDecision({ ...windowed, answers: {} }, 'UNLOAD').warn).toBe(true);
  });

  it('never treats elapsed time or unanswered questions as a reason to warn', () => {
    // Neither is lost by leaving, and warning on them would train a student to dismiss the dialog that matters.
    expect(leaveDecision(stateWith(), 'UNLOAD').warn).toBe(false);
  });
});

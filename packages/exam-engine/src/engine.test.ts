/**
 * Escalation and deadline evaluation -- the tests that matter.  (P8-T1, P8-T2)
 *
 * Both modules exist to stop three callers -- the browser before a write, the server on the write path, and the teacher
 * tooling -- from each deriving the same decision slightly differently. So the tests are about the decisions where a
 * plausible-looking implementation gets the WRONG answer, and every one of those has a consequence for a real student.
 */

import { profileFor } from '@orrery/contracts/policy';
import { describe, expect, it } from 'vitest';

import { evaluateAttempt } from './deadlines.js';
import { classifyBreaches, evaluateEscalation, LADDER, maxRung, rungIndex } from './escalation.js';

const T0 = Date.parse('2026-03-01T12:00:00.000Z');

const thresholds = (over: Record<string, number | null> = {}) => ({
  fullscreenExits: 3,
  focusLosses: null,
  tabHides: null,
  pointerLockLosses: null,
  copyAttempts: null,
  ...over,
});

describe('a null threshold means NOT POLICED, and never means zero', () => {
  it('does not report a breach for a kind with a null threshold', () => {
    const report = classifyBreaches({
      counts: { focusLoss: 500 },
      thresholds: thresholds(),
      ladder: LADDER,
    });
    // `count > null` is true in JavaScript, so a `count > threshold` test with no null guard forbids EVERY kind of
    // violation for EVERY policy. A quiz silently becomes a proctored exam and the code reads plausibly.
    expect(report.breached).toEqual([]);
    expect(report.unpoliced).toContain('focusLoss');
  });

  it('reports the unpoliced kinds, so "not policed" is visible rather than inferred from silence', () => {
    const report = classifyBreaches({ counts: {}, thresholds: thresholds(), ladder: LADDER });
    expect(report.unpoliced).toEqual(['focusLoss', 'tabHide', 'pointerLockLoss', 'copyAttempt']);
  });

  it('treats a threshold of ZERO as forbidden on the FIRST violation, not never', () => {
    // 0 and null are opposite policies and must not collapse into each other.
    const report = classifyBreaches({
      counts: { fullscreenExit: 1 },
      thresholds: thresholds({ fullscreenExits: 0 }),
      ladder: LADDER,
    });
    expect(report.breached).toContain('fullscreenExit');
  });

  it('does not divide by zero when a threshold is zero', () => {
    const verdict = evaluateEscalation({
      counts: { fullscreenExit: 4 },
      thresholds: thresholds({ fullscreenExits: 0 }),
      ladder: LADDER,
    });
    expect(Number.isFinite(verdict.report.worstOvershoot)).toBe(true);
  });
});

describe('breaching a threshold', () => {
  it('counts the threshold-th violation as the breach, not the one after it', () => {
    // "up to 3" and "more than 3" differ by exactly one violation, and the student cannot tell which they are in.
    const at = classifyBreaches({
      counts: { fullscreenExit: 3 },
      thresholds: thresholds(),
      ladder: LADDER,
    });
    const below = classifyBreaches({
      counts: { fullscreenExit: 2 },
      thresholds: thresholds(),
      ladder: LADDER,
    });
    expect(at.breached).toEqual(['fullscreenExit']);
    expect(below.breached).toEqual([]);
  });

  it('ignores a negative count rather than treating it as a breach', () => {
    // Evidence counts only accumulate. A negative would be a bug upstream and must not become an accusation.
    const report = classifyBreaches({
      counts: { fullscreenExit: -5 },
      thresholds: thresholds(),
      ladder: LADDER,
    });
    expect(report.breached).toEqual([]);
  });
});

describe('the escalation rung', () => {
  it('does not escalate when nothing is breached', () => {
    const verdict = evaluateEscalation({ counts: {}, thresholds: thresholds(), ladder: LADDER });
    expect(verdict.rung).toBe('NONE');
    expect(verdict.freezesAttempt).toBe(false);
  });

  it('escalates by the NUMBER OF DISTINCT KINDS, so three behaviours outrank one repeated five times', () => {
    /**
     * The inversion this guards against: a student who left fullscreen five times committed ONE kind of violation,
     * repeatedly. A student who left fullscreen once, hid the tab once and lost focus once committed THREE. The second
     * is the one worth escalating.
     */
    const repeated = evaluateEscalation({
      counts: { fullscreenExit: 5 },
      thresholds: thresholds({ fullscreenExits: 3 }),
      ladder: LADDER,
    });
    const varied = evaluateEscalation({
      counts: { fullscreenExit: 3, tabHide: 3, focusLoss: 3 },
      thresholds: thresholds({ fullscreenExits: 3, tabHides: 3, focusLosses: 3 }),
      ladder: LADDER,
    });
    expect(rungIndex(varied.rung)).toBeGreaterThan(rungIndex(repeated.rung));
  });

  it('does NOT escalate further for being FURTHER past a threshold', () => {
    // `worstOvershoot` is carried for the teacher's timeline and deliberately does not drive the rung: escalating on
    // depth makes one repeated mistake worse than several different ones, which is the same inversion.
    const slightly = evaluateEscalation({
      counts: { fullscreenExit: 3 },
      thresholds: thresholds({ fullscreenExits: 3 }),
      ladder: LADDER,
    });
    const badly = evaluateEscalation({
      counts: { fullscreenExit: 500 },
      thresholds: thresholds({ fullscreenExits: 3 }),
      ladder: LADDER,
    });
    expect(badly.rung).toBe(slightly.rung);
  });

  it('honours a policy whose ladder is EMPTY, escalating to nothing', () => {
    // `ladder[depth - 1]` on an empty array is `undefined`, which would otherwise become a rung named "undefined".
    const verdict = evaluateEscalation({
      counts: { fullscreenExit: 99 },
      thresholds: thresholds({ fullscreenExits: 3 }),
      ladder: [],
    });
    expect(verdict.rung).toBe('NONE');
    // The breach is still REPORTED even though nothing escalates: "we decided not to act" and "nothing happened" are
    // different facts and the teacher's timeline needs the first one.
    expect(verdict.reasons).toEqual(['fullscreenExit']);
  });

  it('stops at the top of the ladder rather than running off the end', () => {
    const verdict = evaluateEscalation({
      counts: { fullscreenExit: 9, tabHide: 9, focusLoss: 9, pointerLockLoss: 9, copyAttempt: 9 },
      thresholds: thresholds({
        fullscreenExits: 3,
        focusLosses: 3,
        tabHides: 3,
        pointerLockLosses: 3,
        copyAttempts: 3,
      }),
      ladder: LADDER,
    });
    expect(verdict.rung).toBe('FREEZE_AND_SUBMIT');
    expect(verdict.freezesAttempt).toBe(true);
  });

  it('stops at the top of a ladder that does not include the freeze rung', () => {
    // A policy with two rungs must not freeze a student just because it ran out of rungs -- and it must never
    // terminate one at all, because there is no `TERMINATE` to reach.
    const verdict = evaluateEscalation({
      counts: { fullscreenExit: 9, tabHide: 9, focusLoss: 9, pointerLockLoss: 9, copyAttempt: 9 },
      thresholds: thresholds({
        fullscreenExits: 3,
        focusLosses: 3,
        tabHides: 3,
        pointerLockLosses: 3,
        copyAttempts: 3,
      }),
      ladder: ['WARN', 'REQUIRE_RELOCK'],
    });
    expect(verdict.rung).toBe('REQUIRE_RELOCK');
    expect(verdict.freezesAttempt).toBe(false);
  });

  it('names WHICH kinds were responsible', () => {
    // The student is told what happened, not merely that something did.
    const verdict = evaluateEscalation({
      counts: { tabHide: 4, copyAttempt: 2 },
      thresholds: thresholds({ tabHides: 3, copyAttempts: 2 }),
      ladder: LADDER,
    });
    expect(verdict.reasons).toEqual(['tabHide', 'copyAttempt']);
  });

  it('`maxRung` never softens an outcome, so merging evidence cannot lower a sanction', () => {
    expect(maxRung('WARN', 'FREEZE_AND_SUBMIT')).toBe('FREEZE_AND_SUBMIT');
    expect(maxRung('FREEZE_AND_SUBMIT', 'WARN')).toBe('FREEZE_AND_SUBMIT');
    expect(maxRung('NONE', 'NONE')).toBe('NONE');
    // `NONE` sits below `WARN`, so a policy cannot escalate to it by accident.
    expect(rungIndex('NONE')).toBeLessThan(rungIndex('WARN'));
  });
});

describe('evaluateAttempt', () => {
  const policy = profileFor('EXAM');
  const attempt = (over: Record<string, unknown> = {}) => ({
    attemptId: 'a1',
    status: 'IN_PROGRESS',
    deadlineAt: T0 + 3_600_000,
    questions: [
      { questionId: 'q1', deadlineAt: T0 + 60_000, answeredAt: T0 - 1_000 },
      { questionId: 'q2', deadlineAt: T0 + 120_000 },
    ],
    ...over,
  });

  it('reports an open question as OPEN with time remaining', () => {
    const verdict = evaluateAttempt(policy, attempt(), T0);
    const q2 = verdict.questions.find((q) => q.questionId === 'q2');
    expect(q2?.state).toBe('OPEN');
    expect(q2?.remainingMs).toBe(120_000);
    expect(verdict.isOpen).toBe(true);
  });

  it('lands the student where they LEFT OFF, not at question 1', () => {
    // `ONE_AT_A_TIME` advances on submission, so a returning student resumes rather than restarting.
    const verdict = evaluateAttempt(policy, attempt(), T0);
    expect(verdict.nextQuestionId).toBe('q2');
  });

  it('falls back to the first still-open question once everything open is answered', () => {
    const verdict = evaluateAttempt(
      policy,
      attempt({
        questions: [
          { questionId: 'q1', deadlineAt: T0 + 60_000, answeredAt: T0 - 1_000 },
          { questionId: 'q2', deadlineAt: T0 + 120_000, answeredAt: T0 - 500 },
        ],
      }),
      T0,
    );
    // Still `q1`: there is nothing left to submit, and review is allowed.
    expect(verdict.nextQuestionId).toBe('q1');
  });

  it('keeps a `SOFT_EXPIRED` question WRITABLE and flags it late', () => {
    const soft = { ...policy, perQuestionExpiry: 'SOFT' as const };
    const verdict = evaluateAttempt(soft, attempt(), T0 + 130_000);
    const q2 = verdict.questions.find((q) => q.questionId === 'q2');
    expect(q2?.state).toBe('SOFT_EXPIRED');
    // The distinction matters: conflating "late" with "closed" produces either a question that silently stops
    // accepting answers, or a late flag on a question that is still open.
    expect(q2?.isLate).toBe(true);
    expect(q2?.remainingMs).toBe(0);
  });

  it('FREEZES a `LOCK` question, so the last accepted answer stands', () => {
    const lock = { ...policy, perQuestionExpiry: 'LOCK' as const };
    const verdict = evaluateAttempt(lock, attempt(), T0 + 130_000);
    expect(verdict.questions.find((q) => q.questionId === 'q2')?.state).toBe('LOCKED');
  });

  it('treats `AUTO_SUBMIT` as ending the ATTEMPT, not just the question', () => {
    /**
     * The policy term is per question but what it does is submit -- `plans/01` §9.1 has `AUTO_SUBMIT` freeze the answer
     * AND mark the attempt final. A state that closed only the question would leave a student on a submitted exam still
     * able to answer the rest, which is the opposite of what the teacher configured.
     */
    const auto = { ...policy, perQuestionExpiry: 'AUTO_SUBMIT' as const };
    const verdict = evaluateAttempt(
      auto,
      attempt({
        questions: [
          { questionId: 'q1', deadlineAt: T0 - 1 },
          { questionId: 'q2', deadlineAt: T0 + 3_600_000 },
        ],
      }),
      T0,
    );
    expect(verdict.questions[0]?.state).toBe('AUTO_SUBMITTED');
    // q2 is comfortably inside its own window, and it is still closed, because the attempt is over.
    expect(verdict.questions[1]?.state).toBe('ATTEMPT_CLOSED');
    expect(verdict.isClosed).toBe(true);
    expect(verdict.isOpen).toBe(false);
    expect(verdict.nextQuestionId).toBeNull();
  });

  it('reports the ATTEMPT as the reason once the whole window has closed', () => {
    const verdict = evaluateAttempt(policy, attempt(), T0 + 3_700_000);
    // Not "time is up for question 2" -- the real reason is that the exam is finished, and the misleading message is
    // the one that makes a student think they lost a question.
    expect(verdict.questions.every((q) => q.state === 'ATTEMPT_CLOSED')).toBe(true);
    expect(verdict.isClosed).toBe(true);
    expect(verdict.remainingMs).toBe(0);
  });

  it('never shows NEGATIVE remaining time', () => {
    // A countdown rendering -0:01 is worse than one reading 0:00.
    const verdict = evaluateAttempt(policy, attempt(), T0 + 9_999_999);
    for (const question of verdict.questions)
      expect(question.remainingMs).toBeGreaterThanOrEqual(0);
    expect(verdict.remainingMs).toBe(0);
  });

  it('reports a SUBMITTED attempt as closed whatever the questions say', () => {
    const verdict = evaluateAttempt(policy, attempt({ status: 'SUBMITTED' }), T0);
    expect(verdict.isOpen).toBe(false);
    expect(verdict.nextQuestionId).toBeNull();
  });

  it('never points the student at an EXCUSED question', () => {
    const verdict = evaluateAttempt(
      policy,
      attempt({
        questions: [
          { questionId: 'q1', deadlineAt: T0 + 60_000, answeredAt: T0 - 1_000 },
          { questionId: 'q2', deadlineAt: T0 + 120_000, isExcused: true },
          { questionId: 'q3', deadlineAt: T0 + 180_000 },
        ],
      }),
      T0,
    );
    // An excused question is not on the paper to be answered. Leaving it OPEN would send the student to a question
    // that cannot be submitted.
    expect(verdict.nextQuestionId).toBe('q3');
    expect(verdict.questions.find((q) => q.questionId === 'q2')?.state).toBe('LOCKED');
  });

  it('reports `null` remaining for an UNTIMED attempt rather than 0', () => {
    // `0` would read as "no time left" on an exam with no time limit.
    const verdict = evaluateAttempt(policy, attempt({ deadlineAt: null }), T0);
    expect(verdict.remainingMs).toBeNull();
    expect(verdict.isOpen).toBe(true);
  });

  it('respects a grace window on both the attempt and the question', () => {
    const withoutGrace = evaluateAttempt(policy, attempt(), T0 + 3_600_500);
    expect(withoutGrace.isClosed).toBe(true);
    // The 30 s default from the attempt's own row is not applied here; grace is the caller's, because the attempt
    // stores it and the engine must not have its own opinion.
    const withGrace = evaluateAttempt(policy, attempt(), T0 + 3_600_500, 30_000);
    expect(withGrace.isClosed).toBe(false);
  });
});

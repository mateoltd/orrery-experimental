/**
 * Property tests for the engine.  (P8-T2)
 *
 * The unit tests in `engine.test.ts` pin specific decisions. These pin the things that must hold for EVERY input, which
 * is where a hand-written table stops: a table only covers the cases someone imagined, and the interesting failures in
 * deadline and escalation code are the combinations nobody imagined.
 *
 * `fast-check` is already a devDependency of `@orrery/contracts` for the P7-T13 grader properties, so these use the same
 * generator and the same style rather than introducing a second property-testing approach.
 */

import { profileFor } from '@orrery/contracts/policy';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { type AttemptFacts, evaluateAttempt } from './deadlines.js';
import {
  classifyBreaches,
  type EscalationInput,
  evaluateEscalation,
  LADDER,
  type Rung,
  rungIndex,
  THRESHOLD_KEYS_FOR_KINDS,
} from './escalation.js';

const T0 = 1_800_000_000_000;

const KIND_KEYS = [
  'fullscreenExits',
  'focusLosses',
  'tabHides',
  'pointerLockLosses',
  'copyAttempts',
] as const;

/** A threshold is a small non-negative integer or `null`, which is the whole domain the policy schema allows. */
const thresholdArb = fc.oneof(fc.integer({ min: 0, max: 5 }), fc.constant(null));

const thresholdsArb = fc.record({
  fullscreenExits: thresholdArb,
  focusLosses: thresholdArb,
  tabHides: thresholdArb,
  pointerLockLosses: thresholdArb,
  copyAttempts: thresholdArb,
});

const escalationInputArb: fc.Arbitrary<EscalationInput> = fc.record({
  counts: fc.record({
    fullscreenExit: fc.nat({ max: 50 }),
    focusLoss: fc.nat({ max: 50 }),
    tabHide: fc.nat({ max: 50 }),
    pointerLockLoss: fc.nat({ max: 50 }),
    copyAttempt: fc.nat({ max: 50 }),
  }),
  thresholds: thresholdsArb,
  // Any non-empty prefix of the ladder, because a policy chooses how far it is willing to go.
  ladder: fc
    .array(fc.constantFrom<Rung>(...LADDER), { minLength: 0, maxLength: LADDER.length })
    .map((rungs) => LADDER.slice(0, rungs.length)),
});

describe('PROPERTY: a null threshold is never policed, for any counts', () => {
  it('never breaches a kind whose threshold is null, however many violations are recorded', () => {
    /**
     * The bug this exists to catch is `count > threshold` with no null guard: `1 > null` is `true` in JavaScript, so
     * every kind with a null threshold would be reported as breached and a quiz would become a proctored exam. No
     * hand-written case would find it, because every case someone would write uses a small count.
     */
    fc.assert(
      fc.property(fc.nat({ max: 1_000_000 }), fc.nat({ max: 1_000_000 }), (a, b) => {
        const report = classifyBreaches({
          counts: { focusLoss: a, tabHide: b },
          thresholds: {
            fullscreenExits: 3,
            focusLosses: null,
            tabHides: null,
            pointerLockLosses: null,
            copyAttempts: null,
          },
          ladder: LADDER,
        });
        return report.breached.length === 0;
      }),
      { numRuns: 300 },
    );
  });
});

describe('PROPERTY: breaching is monotone in the count', () => {
  it('a higher count is never LESS breached than a lower one', () => {
    fc.assert(
      fc.property(fc.nat({ max: 100 }), fc.nat({ max: 100 }), (lower, extra) => {
        const threshold = 4;
        const lowerReport = classifyBreaches({
          counts: { fullscreenExit: lower },
          thresholds: {
            fullscreenExits: threshold,
            focusLosses: null,
            tabHides: null,
            pointerLockLosses: null,
            copyAttempts: null,
          },
          ladder: LADDER,
        });
        const higherReport = classifyBreaches({
          counts: { fullscreenExit: lower + extra },
          thresholds: {
            fullscreenExits: threshold,
            focusLosses: null,
            tabHides: null,
            pointerLockLosses: null,
            copyAttempts: null,
          },
          ladder: LADDER,
        });
        return (
          lowerReport.breached.length <= higherReport.breached.length &&
          lowerReport.worstOvershoot <= higherReport.worstOvershoot
        );
      }),
      { numRuns: 300 },
    );
  });
});

describe('PROPERTY: the rung is always one the policy actually offers', () => {
  it('never returns a rung absent from the ladder, and reserves `NONE` for no-breach OR an empty ladder', () => {
    /**
     * `ladder[depth - 1]` on an empty or short ladder is the classic source of a sanction nobody configured -- an
     * `undefined` rung, or a `TERMINATE` a policy deliberately left out. Termination ends an attempt, so a policy
     * must never reach it by accident.
     */
    fc.assert(
      fc.property(escalationInputArb, (input) => {
        const verdict = evaluateEscalation(input);
        if (verdict.rung === 'NONE') {
          // `NONE` is correct when nothing is breached, AND when the policy's ladder is empty even though something
          // was. Those are different facts and both are legitimate: "we decided not to escalate" is not "nothing
          // happened", and the breach is still reported so a teacher's timeline can show it.
          return verdict.report.breached.length === 0 || input.ladder.length === 0;
        }
        return input.ladder.includes(verdict.rung);
      }),
      { numRuns: 400 },
    );
  });

  it('terminates ONLY when the ladder includes `TERMINATE`', () => {
    fc.assert(
      fc.property(escalationInputArb, (input) => {
        const verdict = evaluateEscalation(input);
        return (
          verdict.isTerminal ===
          (verdict.rung === 'TERMINATE' && input.ladder.includes('TERMINATE'))
        );
      }),
      { numRuns: 300 },
    );
  });

  it('escalates only as far as the ladder allows, however many kinds are breached', () => {
    fc.assert(
      fc.property(escalationInputArb, (input) => {
        const verdict = evaluateEscalation(input);
        if (verdict.rung === 'NONE') return true;
        // The rung's position in the FULL ladder cannot exceed the deepest rung the policy offers.
        const deepestOffered =
          input.ladder.length === 0 ? -1 : rungIndex(input.ladder[input.ladder.length - 1] as Rung);
        return rungIndex(verdict.rung) <= deepestOffered;
      }),
      { numRuns: 300 },
    );
  });
});

describe('PROPERTY: evaluateAttempt never invents time', () => {
  const policy = profileFor('EXAM');

  const attemptArb: fc.Arbitrary<AttemptFacts> = fc.record({
    attemptId: fc.constant('a1'),
    status: fc.constantFrom('IN_PROGRESS', 'SUBMITTED', 'GRADED'),
    deadlineAt: fc.option(fc.integer({ min: T0, max: T0 + 1_000_000 }), { nil: null }),
    // The id is POSITIONAL, not sampled: a sampled id collides, two questions then share a name, and
    // `find(q => q.questionId === nextQuestionId)` locates a different question than the verdict actually chose --
    // which looks exactly like a real bug in `nextQuestionId` and is not one.
    questions: fc
      .array(
        fc.record({
          questionId: fc.constant(''),
          deadlineAt: fc.option(fc.integer({ min: T0, max: T0 + 1_000_000 }), { nil: null }),
          answeredAt: fc.option(fc.integer({ min: T0, max: T0 + 1_000_000 }), { nil: undefined }),
          isExcused: fc.boolean(),
        }),
        { minLength: 1, maxLength: 6 },
      )
      .map((questions, _depth) =>
        questions.map((question, index) => ({ ...question, questionId: `q${String(index)}` })),
      ),
  });

  it('never reports NEGATIVE remaining time, whatever the instant', () => {
    /**
     * A countdown rendering `-0:01` is worse than one reading `0:00`, and an off-by-one in the clamp is invisible in
     * every hand-written case because they all use an instant comfortably inside or outside the deadline.
     */
    fc.assert(
      fc.property(
        attemptArb,
        fc.integer({ min: T0 - 10_000_000, max: T0 + 10_000_000 }),
        (attempt, now) => {
          const verdict = evaluateAttempt(policy, attempt, now);
          for (const question of verdict.questions) {
            if (question.remainingMs < 0) return false;
          }
          return verdict.remainingMs === null || verdict.remainingMs >= 0;
        },
      ),
      { numRuns: 300 },
    );
  });

  it('never offers an EXCUSED question, and never one on a closed attempt', () => {
    fc.assert(
      fc.property(
        attemptArb,
        fc.integer({ min: T0 - 10_000_000, max: T0 + 10_000_000 }),
        (attempt, now) => {
          const verdict = evaluateAttempt(policy, attempt, now);
          const next = verdict.questions.find(
            (question) => question.questionId === verdict.nextQuestionId,
          );
          if (next === undefined) return verdict.nextQuestionId === null;
          return !next.isExcused && next.state === 'OPEN';
        },
      ),
      { numRuns: 300 },
    );
  });

  it('is closed whenever the attempt status is not `IN_PROGRESS`', () => {
    fc.assert(
      fc.property(
        attemptArb,
        fc.integer({ min: T0 - 10_000_000, max: T0 + 10_000_000 }),
        (attempt, now) => {
          const verdict = evaluateAttempt(policy, attempt, now);
          return attempt.status === 'IN_PROGRESS' || verdict.isClosed;
        },
      ),
      { numRuns: 200 },
    );
  });

  it('reports `null` remaining time for an untimed attempt and never zero for it', () => {
    fc.assert(
      fc.property(attemptArb, fc.integer({ min: T0, max: T0 + 1_000_000 }), (attempt, now) => {
        const untimed = { ...attempt, deadlineAt: null };
        return evaluateAttempt(policy, untimed, now).remainingMs === null;
      }),
      { numRuns: 200 },
    );
  });

  it('returns a verdict for EVERY question it was given, in the order given', () => {
    fc.assert(
      fc.property(attemptArb, fc.integer({ min: T0, max: T0 + 1_000_000 }), (attempt, now) => {
        const verdict = evaluateAttempt(policy, attempt, now);
        return (
          verdict.questions.length === attempt.questions.length &&
          verdict.questions.every(
            (question, index) => question.questionId === attempt.questions[index]?.questionId,
          )
        );
      }),
      { numRuns: 200 },
    );
  });
});

describe('PROPERTY: every policy threshold is policed by exactly one kind', () => {
  it('maps each violation kind onto a threshold the policy actually declares', () => {
    /**
     * A threshold added to the schema and forgotten in the engine's key map is SILENTLY unpoliced: the lookup yields
     * `undefined`, and `undefined` reads as "not policed" here, so the omission produces no error at all. The map is
     * asserted directly rather than derived by string surgery, which is what made the first version of this test
     * meaningless.
     */
    // The map's VALUES are the policy's threshold key names -- the first version compared its KEYS (which are the
    // violation kinds) against those, which is comparing two different vocabularies and asserts nothing.
    expect(Object.values(THRESHOLD_KEYS_FOR_KINDS).sort()).toEqual([...KIND_KEYS].sort());
    // And its KEYS are exactly the five kinds, so a new kind cannot be added without a threshold to consult.
    expect(Object.keys(THRESHOLD_KEYS_FOR_KINDS).sort()).toEqual(
      ['copyAttempt', 'focusLoss', 'fullscreenExit', 'pointerLockLoss', 'tabHide'].sort(),
    );
  });
});

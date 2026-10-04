/**
 * Property tests over the shuffler and the deadline math.  (P7-T13, the half deferred until P7-T8)
 *
 * ## WHY THESE TWO AND NOT THE GRADER
 *
 * The grader's properties went in `grading/properties.test.ts`. These are the other two subjects P7-T13 names,
 * and they were deferred because **the subjects did not exist**: `policy/shuffle.ts` and `policy/deadline.ts`
 * arrived with P7-T8. A property test written before the code it constrains is a guess about a function
 * signature, and this phase has twice found that the guess and the code disagree.
 *
 * ## AND THE PROPERTIES HERE ARE ABOUT COUNTEREXAMPLES, NOT COVERAGE
 *
 * The deadline arithmetic has one property a student actually experiences, and it is not in the plan:
 *
 * > **Once a write is refused for a deadline, it stays refused for that deadline.**
 *
 * That is what a countdown promises. If acceptance could go false and then true again as the clock advanced, a
 * student watching "0:00" would see the paper reopen, and every cache, every retry and every reconnect would be
 * a chance to land in the window. It cannot happen with a `<=` against a fixed deadline, but that is an argument,
 * not a proof, and the argument is exactly the kind that survives a refactor that turns `>` into a window check.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  attemptDeadlineAt,
  evaluateWrite,
  expiryInstruction,
  mayStart,
  questionDeadlineAt,
  remainingMs,
  type WriteRequest,
  writeDeadlineAt,
} from './deadline.js';
import type { ExamPolicy } from './index.js';
import { resolvePolicy } from './index.js';
import { shuffleOptions, shuffleQuestionOrder, shuffleSeedFor } from './shuffle.js';

const AT = Date.parse('2026-03-01T09:00:00Z');
const RUNS = 250;

const timedPolicy = (limit: number, grace: number): ExamPolicy =>
  resolvePolicy({
    mode: 'ASSIGNMENT',
    versionPolicy: { totalTimeLimitSec: limit, gracePeriodSec: grace },
  });

/** An arbitrary attempt deadline in the past or future, so both sides of every comparison are generated. */
const arbNow = fc.integer({ min: -1_000_000, max: 5_000_000 });
const arbStatus = fc.constantFrom(
  'NOT_STARTED',
  'IN_PROGRESS',
  'SUBMITTED',
  'GRADED',
  'EXPIRED' as const,
);

/** A request that is ACCEPTABLE on its own terms, so a deadline property is not masked by a status check. */
const acceptable = (
  deadlineAt: number | null,
  questionDeadlineAt: number | null,
): WriteRequest => ({
  attemptStatus: 'IN_PROGRESS',
  deadlineAt,
  questionDeadlineAt,
  expectedRevision: 1,
  serverRevision: 1,
  idempotencyKeySeen: false,
});

describe('DEADLINE — acceptance is monotone in time, which is what a countdown promises', () => {
  it('never reopens: once refused for a deadline, refused for every later instant', () => {
    fc.assert(
      fc.property(
        arbNow,
        fc.integer({ min: 1, max: 3600 }),
        fc.integer({ min: 0, max: 300 }),
        (start, limit, grace) => {
          const policy = timedPolicy(limit, grace);
          const deadline = AT + start + limit * 1000;
          const request = acceptable(deadline, null);
          const firstRefusal = evaluateWrite(policy, request, AT + start).accept;
          // Walk forward and check the answer never improves once it has turned false.
          let sawRefusal = false;
          for (let step = 0; step <= 40; step += 1) {
            const now = AT + start + step * 1000;
            const accepted = evaluateWrite(policy, request, now).accept;
            if (!accepted) sawRefusal = true;
            // The property: false is absorbing.
            if (sawRefusal) expect(accepted).toBe(false);
          }
          expect(firstRefusal).toBeTypeOf('boolean');
          return true;
        },
      ),
      { numRuns: RUNS },
    );
  });

  it("is EXACTLY the conjunction of the plan's four clauses, with no fifth condition hiding", () => {
    /**
     * `plans/01` §9.1 states acceptance as a four-clause conjunction. Characterising it means: for ANY request and
     * ANY instant, `evaluateWrite` agrees with the clauses evaluated by hand. A fifth clause added for
     * convenience -- a "too fast" guard, a rate limit, a flag nobody wrote down -- would fail here.
     */
    fc.assert(
      fc.property(
        arbStatus,
        fc.option(arbNow, { nil: null }),
        fc.option(arbNow, { nil: null }),
        fc.boolean(),
        fc.nat(),
        arbNow,
        (status, deadlineAt, questionDeadlineAt, keySeen, revision, now) => {
          const policy = timedPolicy(60, 30);
          const request: WriteRequest = {
            attemptStatus: status,
            deadlineAt: deadlineAt === null ? null : AT + deadlineAt,
            questionDeadlineAt: questionDeadlineAt === null ? null : AT + questionDeadlineAt,
            expectedRevision: revision,
            serverRevision: revision,
            idempotencyKeySeen: keySeen,
          };
          const graceMs = 30_000;
          const byHand =
            keySeen ||
            (status === 'IN_PROGRESS' &&
              (request.deadlineAt === null || now <= request.deadlineAt + graceMs) &&
              (request.questionDeadlineAt === null || now <= request.questionDeadlineAt + graceMs));
          return evaluateWrite(policy, request, now).accept === byHand;
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('gives the SAME reason for the same inputs, because a reason that varied would be unusable in a log', () => {
    fc.assert(
      fc.property(
        arbStatus,
        fc.option(arbNow, { nil: null }),
        arbNow,
        (status, deadlineAt, now) => {
          const policy = timedPolicy(60, 30);
          const request = acceptable(deadlineAt === null ? null : AT + deadlineAt, null);
          const withStatus = evaluateWrite(policy, { ...request, attemptStatus: status }, now);
          const again = evaluateWrite(policy, { ...request, attemptStatus: status }, now);
          return JSON.stringify(withStatus) === JSON.stringify(again);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('accepts a duplicate key for EVERY combination of status, revision and time', () => {
    /**
     * The idempotency clause is checked FIRST, so it dominates everything. If any other clause were evaluated
     * first, a client that submits and then retries its last save would be refused for work the server holds --
     * which is the normal shape of a submit, not an edge case.
     */
    fc.assert(
      fc.property(
        arbStatus,
        fc.option(arbNow, { nil: null }),
        fc.option(arbNow, { nil: null }),
        fc.nat(),
        arbNow,
        (status, deadlineAt, questionDeadlineAt, revision, now) => {
          const policy = timedPolicy(60, 30);
          const decision = evaluateWrite(
            policy,
            {
              attemptStatus: status,
              deadlineAt: deadlineAt === null ? null : AT + deadlineAt,
              questionDeadlineAt: questionDeadlineAt === null ? null : AT + questionDeadlineAt,
              expectedRevision: revision,
              serverRevision: revision + 1,
              idempotencyKeySeen: true,
            },
            now,
          );
          return decision.accept === true && decision.idempotent === true;
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('never throws for ANY field value a JSON body can carry', () => {
    /**
     * THE REQUEST IS WELL-FORMED AND THE FIELDS ARE NOT, and that is the right shape for this property.
     *
     * `evaluateWrite` is not the public boundary -- it is called after a route has already established that the
     * body is an object -- so asserting totality over a `null` REQUEST is testing a promise the contract does not
     * make. What it does promise is that no field VALUE can make it throw, and every field here is arbitrary
     * JSON, because `JSON.parse` has no Symbol to give and a Symbol breaks arithmetic rather than a policy.
     */
    fc.assert(
      fc.property(
        fc.record({
          attemptStatus: fc.jsonValue(),
          deadlineAt: fc.jsonValue(),
          questionDeadlineAt: fc.jsonValue(),
          expectedRevision: fc.jsonValue(),
          serverRevision: fc.jsonValue(),
          idempotencyKeySeen: fc.jsonValue(),
        }),
        // `now` and the deadline are NUMBERS, not JSON: they come from `@orrery/clock`, not from a body.
        // Generating them as JSON made this property FLAKY -- `JSON.parse` can yield a string or an array, and
        // `'5' + 30000` is a concatenation rather than an addition, so the arithmetic quietly changes meaning
        // depending on the value. It only showed under coverage instrumentation, which is its own warning: a
        // property that fails once in twenty runs is not a property.
        fc.integer({ min: -1_000_000, max: 5_000_000 }),
        fc.integer({ min: -1_000_000, max: 5_000_000 }),
        (request, deadline, now) => {
          expect(() =>
            evaluateWrite(timedPolicy(60, 30), request as WriteRequest, now as number),
          ).not.toThrow();
          expect(() => remainingMs(deadline as number | null, now as number)).not.toThrow();
          expect(() => mayStart(timedPolicy(60, 30), now as number)).not.toThrow();
          expect(() => attemptDeadlineAt(timedPolicy(60, 30), now as number)).not.toThrow();
          return true;
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('reports the ATTEMPT deadline whenever both have passed, because the attempt is what ended the paper', () => {
    fc.assert(
      fc.property(fc.integer({ min: -100_000, max: 0 }), (drift) => {
        const now = AT + 200_000;
        const decision = evaluateWrite(
          timedPolicy(60, 30),
          acceptable(AT + 60_000, AT + 60_000),
          now + drift,
        );
        return (
          decision.accept === false &&
          'reason' in decision &&
          decision.reason === 'ATTEMPT_DEADLINE_PASSED'
        );
      }),
      { numRuns: RUNS },
    );
  });
});

describe('DEADLINE — the arithmetic is monotone and self-consistent', () => {
  it('puts the attempt deadline later for a later start, never earlier', () => {
    fc.assert(
      fc.property(arbNow, arbNow, fc.integer({ min: 1, max: 7200 }), (a, b, limit) => {
        const policy = timedPolicy(limit, 0);
        const first = attemptDeadlineAt(policy, AT + a);
        const second = attemptDeadlineAt(policy, AT + b);
        if (first === null || second === null) return true;
        return a <= b ? first <= second : first >= second;
      }),
      { numRuns: RUNS },
    );
  });

  it('puts the write deadline exactly gracePeriodSec after the deadline', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 7200 }),
        fc.integer({ min: 0, max: 600 }),
        (limit, grace) => {
          const policy = timedPolicy(limit, grace);
          const deadline = attemptDeadlineAt(policy, AT);
          const write = writeDeadlineAt(policy, AT);
          return deadline !== null && write !== null && write - deadline === grace * 1000;
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('gives a question opened later a deadline later or equal, and an unopened question none at all', () => {
    const policy = resolvePolicy({
      mode: 'ASSIGNMENT',
      versionPolicy: { perQuestionTimeLimitSec: 120, perQuestionExpiry: 'LOCK' },
    });
    fc.assert(
      fc.property(arbNow, arbNow, (a, b) => {
        if (questionDeadlineAt(policy, null) !== null) return false;
        const first = questionDeadlineAt(policy, AT + a);
        const second = questionDeadlineAt(policy, AT + b);
        if (first === null || second === null) return false;
        return a <= b ? first <= second : first >= second;
      }),
      { numRuns: RUNS },
    );
  });

  it('never reports a negative countdown, and never decreases it as time advances', () => {
    fc.assert(
      fc.property(arbNow, arbNow, (deadlineOffset, now) => {
        const deadline = AT + deadlineOffset;
        const value = remainingMs(deadline, AT + now);
        if (value < 0) return false;
        return remainingMs(deadline, AT + now + 1000) <= value;
      }),
      { numRuns: RUNS },
    );
  });

  it('reports an untimed attempt as never expiring, at any instant', () => {
    const untimed = resolvePolicy({ mode: 'ASSIGNMENT' });
    fc.assert(
      fc.property(arbNow, (now) => {
        if (attemptDeadlineAt(untimed, AT) !== null) return false;
        if (writeDeadlineAt(untimed, AT) !== null) return false;
        if (remainingMs(null, now) !== Number.POSITIVE_INFINITY) return false;
        return evaluateWrite(untimed, acceptable(null, null), now).accept === true;
      }),
      { numRuns: RUNS },
    );
  });

  it('maps every expiry policy to an instruction, and an untimed question to NONE', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('SOFT', 'LOCK', 'AUTO_SUBMIT' as const),
        fc.boolean(),
        (expiry, timed) => {
          const policy = resolvePolicy({
            mode: 'ASSIGNMENT',
            versionPolicy: {
              perQuestionExpiry: expiry,
              perQuestionTimeLimitSec: timed ? 60 : null,
            },
          });
          const instruction = expiryInstruction(policy);
          if (!timed) return instruction === 'NONE';
          return instruction !== 'NONE';
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('admits or refuses admission by the window alone, regardless of any deadline', () => {
    fc.assert(
      fc.property(fc.integer({ min: -100_000, max: 200_000 }), (offset) => {
        const policy = resolvePolicy({
          mode: 'ASSIGNMENT',
          versionPolicy: {
            availabilityWindow: { from: '2026-03-01T09:00:00Z', until: '2026-03-01T17:00:00Z' },
          },
        });
        const now = AT + offset;
        const expected =
          now >= Date.parse('2026-03-01T09:00:00Z') && now <= Date.parse('2026-03-01T17:00:00Z');
        return mayStart(policy, now).allowed === expected;
      }),
      { numRuns: RUNS },
    );
  });
});

describe('SHUFFLE — a permutation, deterministically, or NOT AT ALL', () => {
  const options = ['A', 'B', 'C', 'D', 'E'].map((text) => ({ text }));

  it('always returns a PERMUTATION of the input, for any seed and any list', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.string({ minLength: 1, maxLength: 6 }), { minLength: 0, maxLength: 10 }),
        fc.string(),
        fc.boolean(),
        (texts, seed, enabled) => {
          const items = texts.map((text) => ({ text }));
          const result = shuffleOptions(items, seed, { enabled });
          expect(result.items).toHaveLength(items.length);
          expect([...result.items].map((o) => o.text).sort()).toEqual([...texts].sort());
          expect(result.seed).toBe(seed);
          return true;
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('is DETERMINISTIC: the same seed gives the same permutation, always', () => {
    /**
     * The property that makes a re-grade possible. `INV-RNG-1` stores the seed, and a stored seed is only worth
     * something if it reproduces the paper — so this is asserted over generated seeds rather than a fixed pair,
     * because a single comparison proves almost nothing.
     */
    fc.assert(
      fc.property(
        fc.string(),
        fc.uniqueArray(fc.string({ minLength: 1, maxLength: 6 }), { minLength: 3, maxLength: 8 }),
        (seed, texts) => {
          const items = texts.map((text) => ({ text }));
          // Two separate CALLS, hoisted into names. Written as one expression compared with itself it is a
          // self-compare, which `noSelfCompare` flags -- correctly, because that shape is nearly always a
          // copy-paste slip where the second call was meant to differ.
          const first = shuffleOptions(items, seed, { enabled: true });
          const second = shuffleOptions(items, seed, { enabled: true });
          return JSON.stringify(first.items) === JSON.stringify(second.items);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('NEVER mutates its input, for questions or options', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.string({ minLength: 1, maxLength: 6 }), { minLength: 3, maxLength: 8 }),
        fc.string(),
        (texts, seed) => {
          const items = texts.map((text) => ({ text }));
          const before = JSON.stringify(items);
          shuffleOptions(items, seed, { enabled: true });
          const questions = items.map((text, n) => ({ n, text }));
          const questionsBefore = JSON.stringify(questions);
          shuffleQuestionOrder(questions, seed, { enabled: true });
          return JSON.stringify(items) === before && JSON.stringify(questions) === questionsBefore;
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('SHIFTS every seed and label, so `skipped` explains itself rather than being absent', () => {
    /**
     * `skipped` is the whole reason the function returns a record instead of an array. A result whose `skipped`
     * was `undefined` for "nothing to do" and `null` for "shuffled" would be indistinguishable in JSON.
     */
    fc.assert(
      fc.property(fc.boolean(), fc.nat(), fc.boolean(), (enabled, count, meaningful) => {
        const items = Array.from({ length: count % 8 }, (_, n) => ({ text: `item ${String(n)}` }));
        const option = shuffleOptions(items, 'seed', { enabled, meaningfulOrder: meaningful });
        const paper = shuffleQuestionOrder(
          items.map((_item, n) => ({ n })),
          'seed',
          { enabled },
        );
        // Whatever happened, the reason is one of the declared values, or explicitly null.
        const reasons = [
          'FEWER_THAN_THREE_OPTIONS',
          'CATCH_ALL_OPTION',
          'ORDERED_SCALE',
          'ORDER_CARRIES_MEANING',
          'SHUFFLE_DISABLED',
          'SINGLETON',
        ];
        expect(option.skipped === null || reasons.includes(option.skipped)).toBe(true);
        expect(paper.skipped === null || reasons.includes(paper.skipped)).toBe(true);
        return true;
      }),
      { numRuns: RUNS },
    );
  });

  it('REFUSES to shuffle whenever a catch-all option is present, for EVERY seed', () => {
    /**
     * Stated over every seed rather than one, because a caution that holds for one seed is not a caution. "All
     * of the above" is a claim about the option LIST, so permuting the list moves the answer's position rather
     * than its label — and a student who has learned it tends to be right has a strategy a shuffle invalidates.
     */
    for (const text of [
      'All of the above',
      'None of the above',
      'Both of the above',
      'None of these',
    ]) {
      const withCatchAll = [...options, { text }];
      fc.assert(
        fc.property(fc.string(), (seed) => {
          const result = shuffleOptions(withCatchAll, seed, { enabled: true });
          return (
            result.skipped === 'CATCH_ALL_OPTION' &&
            JSON.stringify(result.items) === JSON.stringify(withCatchAll)
          );
        }),
        { numRuns: 60 },
      );
    }
  });

  it('REFUSES to shuffle an ordered scale for EVERY seed', () => {
    const likert = ['Strongly disagree', 'Disagree', 'Neither', 'Agree', 'Strongly agree'].map(
      (text) => ({ text }),
    );
    fc.assert(
      fc.property(fc.string(), (seed) => {
        const result = shuffleOptions(likert, seed, { enabled: true });
        return (
          result.skipped === 'ORDERED_SCALE' &&
          JSON.stringify(result.items) === JSON.stringify(likert)
        );
      }),
      { numRuns: RUNS },
    );
  });

  it("lets the author's `meaningfulOrder` outrank every heuristic, for EVERY seed", () => {
    // "Solid / Liquid / Gas / Plasma" in phase order is meaning-bearing and nothing in the text says so.
    const phases = ['Solid', 'Liquid', 'Gas', 'Plasma'].map((text) => ({ text }));
    fc.assert(
      fc.property(fc.string(), (seed) => {
        const result = shuffleOptions(phases, seed, { enabled: true, meaningfulOrder: true });
        return (
          result.skipped === 'ORDER_CARRIES_MEANING' &&
          JSON.stringify(result.items) === JSON.stringify(phases)
        );
      }),
      { numRuns: RUNS },
    );
  });

  it('refuses to shuffle one or two, for EVERY seed, because a two-item question has one permutation', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 }), fc.string(), (count, seed) => {
        const items = Array.from({ length: count }, (_, n) => ({ text: `item ${String(n)}` }));
        const result = shuffleOptions(items, seed, { enabled: true });
        return result.skipped === 'FEWER_THAN_THREE_OPTIONS' || result.skipped === 'SINGLETON';
      }),
      { numRuns: RUNS },
    );
  });

  it('keeps a question ORDERED unless the paper opts in, for every seed', () => {
    // The default is the opposite of the option default, deliberately: a permuted option list is a
    // within-question nuisance, a permuted paper changes what the student is able to do.
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.nat(), { minLength: 3, maxLength: 9 }),
        fc.string(),
        (order, seed) => {
          const paper = order.map((n) => ({ n }));
          const declined = shuffleQuestionOrder(paper, seed, { enabled: false });
          return (
            declined.skipped === 'SHUFFLE_DISABLED' &&
            JSON.stringify(declined.items) === JSON.stringify(paper)
          );
        },
      ),
      { numRuns: RUNS },
    );
  });

  it("derives INDEPENDENT streams, so one lever cannot disturb another's permutation", () => {
    /**
     * If the two levers drew from one shared stream, then adding option shuffling to a paper that shuffled only
     * questions would silently change the question order for every student who had already sat it. Both fork by
     * LABEL, so this holds for every seed.
     */
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.string({ minLength: 1, maxLength: 5 }), { minLength: 3, maxLength: 8 }),
        fc.string(),
        (texts, seed) => {
          const paper = texts.map((text, n) => ({ n, text }));
          const before = shuffleQuestionOrder(paper, seed, { enabled: true }).items;
          shuffleOptions(
            texts.map((text) => ({ text })),
            seed,
            { enabled: true },
          );
          const after = shuffleQuestionOrder(paper, seed, { enabled: true }).items;
          return JSON.stringify(before) === JSON.stringify(after);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('reaches more than one permutation across seeds, so the shuffle is not a constant relabelling', () => {
    /**
     * NOT "two seeds differ" -- that is flaky by construction, and four options collide one time in 24. This
     * asserts the weaker but non-flaky fact that matters operationally: the lever actually varies the paper.
     * A `shuffle` that returned the input order, or only ever swapped the first two elements, would fail it.
     */
    const paper = Array.from({ length: 8 }, (_, n) => ({ n }));
    const seen = new Set<string>();
    for (let index = 0; index < 80; index += 1) {
      seen.add(
        JSON.stringify(
          shuffleQuestionOrder(paper, `seed-${String(index)}`, { enabled: true }).items,
        ),
      );
    }
    expect(seen.size).toBeGreaterThan(20);
  });
});

describe('SHUFFLE SEEDS — injective, and refusing the ambiguous case', () => {
  it('gives different triples different seeds', () => {
    /**
     * **THIS PROPERTY WAS FALSE AS WRITTEN, AND WAS RED ROUGHLY HALF THE TIME.**
     *
     * It generated two random strings and asserted that swapping them between `studentId` and `attemptId` changes the
     * seed. When `a === b` the two calls are the SAME triple, so the seeds are equal and the assertion is false.
     * `fc.string()` draws from a space small enough -- lengths 1 to 6 -- that collisions were frequent, and the test
     * passed or failed depending on the run's random seed. It had been intermittently red since P7-T8 and was written
     * off as flakiness.
     *
     * The guard it did have -- skipping NUL -- addressed a real case. It was the missing `a !== b` that made the
     * property untrue, and a property that is sometimes false is worse than no property: it trains everyone reading it
     * to re-run a red suite rather than believe it.
     */
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 6 }),
        fc.string({ minLength: 1, maxLength: 6 }),
        (a, b) => {
          if (a.includes('\\u0000') || b.includes('\\u0000')) return true;
          // The swap only produces a DIFFERENT triple when the two parts actually differ.
          if (a === b) return true;
          return (
            shuffleSeedFor({ assignmentId: 'as', studentId: a, attemptId: b }) !==
            shuffleSeedFor({ assignmentId: 'as', studentId: b, attemptId: a })
          );
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('joins the parts with a separator, so one part cannot be read as two', () => {
    /**
     * STATED AS THE JOIN'S SHAPE rather than as a collision hunt.
     *
     * The first version exhibited an impersonation -- `assignmentId: a, studentId: b` against
     * `assignmentId: "a b", studentId: ""` -- and asserted the seeds differ. That is true, and it is a property
     * about a hand-picked pair: a fixture wearing a property's clothes.
     *
     * What actually guarantees injectivity is the SEPARATOR, and the crisp statement is that the seed has
     * exactly three of them and its parts are recoverable. If a part may CONTAIN the separator then no separator
     * scheme is injective -- which is why `shuffleSeedFor` refuses that case outright instead of hashing around
     * it, because two identical scripts are very hard to trace back.
     */
    const clean = fc
      .string({ minLength: 0, maxLength: 4 })
      .filter((value) => !value.includes('\u0000'));
    fc.assert(
      fc.property(clean, clean, (assignmentId, studentId) => {
        const seed = shuffleSeedFor({ assignmentId, studentId, attemptId: 'at' });
        const separators = [...seed].filter((character) => character === '\u0000').length;
        if (separators !== 3) return false;
        return seed === [assignmentId, studentId, 'at', ''].join('\u0000');
      }),
      { numRuns: RUNS },
    );
  });

  it('treats an absent variant label and an empty one as the SAME statement', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 6 }), (student) => {
        if (student.includes('\\u0000')) return true;
        return (
          shuffleSeedFor({ assignmentId: 'as', studentId: student, attemptId: 'at' }) ===
          shuffleSeedFor({
            assignmentId: 'as',
            studentId: student,
            attemptId: 'at',
            variantLabel: '',
          })
        );
      }),
      { numRuns: RUNS },
    );
  });

  it('REFUSES any part containing the separator, rather than hashing around it', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('assignmentId', 'studentId', 'attemptId', 'variantLabel'),
        fc.string({ minLength: 1, maxLength: 5 }),
        (field, value) => {
          const parts = {
            assignmentId: 'as',
            studentId: 's',
            attemptId: 'at',
            ...(field === 'variantLabel' ? {} : {}),
            [field]: `${value}\u0000`,
          } as {
            assignmentId: string;
            studentId: string;
            attemptId: string;
            variantLabel?: string;
          };
          let threw = false;
          try {
            shuffleSeedFor(parts);
          } catch {
            threw = true;
          }
          return threw;
        },
      ),
      { numRuns: RUNS },
    );
  });
});

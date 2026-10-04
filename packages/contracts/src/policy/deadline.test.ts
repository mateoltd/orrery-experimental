/**
 * Tests for the deadline arithmetic and the shuffles.  (P7-T8)
 *
 * ## THE BOUNDARIES ARE THE TESTS
 *
 * A deadline function is correct everywhere except at its edges, and its edges are the millisecond a paper
 * closes, the first write after a clock is set, and the retry that arrives after submission. So the tests below
 * are concentrated on `<=` versus `<`, on `null` meaning "no bound" rather than "now", and on which of two
 * refusals wins when both apply.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  attemptDeadlineAt,
  evaluateWrite,
  expiryInstruction,
  expiryVerdict,
  mayStart,
  questionDeadlineAt,
  remainingMs,
  type WriteRequest,
  writeDeadlineAt,
} from './deadline.js';
import { QUIZ_PROFILE_DEFAULTS, resolvePolicy } from './index.js';
import {
  hasCatchAllOption,
  hasOrderedScale,
  shuffleOptions,
  shuffleQuestionOrder,
  shuffleSeedFor,
} from './shuffle.js';

const AT = Date.parse('2026-03-01T09:00:00Z');

const timed = (totalTimeLimitSec: number, gracePeriodSec = 60) =>
  resolvePolicy({ mode: 'ASSIGNMENT', versionPolicy: { totalTimeLimitSec, gracePeriodSec } });

describe('the deadline arithmetic', () => {
  it('sets the attempt deadline from the FIRST ACCEPTED START', () => {
    expect(attemptDeadlineAt(timed(3600), AT)).toBe(AT + 3_600_000);
  });

  it('has NO deadline when untimed, and `null` does not mean "now"', () => {
    // The dangerous version of this helper treats an absent limit as zero, which makes an untimed paper close
    // the instant it starts and fails every student with a refusal they cannot act on.
    const untimed = resolvePolicy({ mode: 'ASSIGNMENT' });
    expect(attemptDeadlineAt(untimed, AT)).toBeNull();
    expect(writeDeadlineAt(untimed, AT)).toBeNull();
    expect(remainingMs(null, AT)).toBe(Number.POSITIVE_INFINITY);
    expect(mayStart(untimed, AT)).toEqual({ allowed: true });
  });

  it('separates the DEADLINE from the WRITE DEADLINE', () => {
    // The UI counts down to `deadlineAt`; a write is accepted until `deadlineAt + grace`. Conflating them ends
    // the paper 60 seconds before the countdown says it does.
    const policy = timed(3600, 60);
    expect(attemptDeadlineAt(policy, AT)).toBe(AT + 3_600_000);
    expect(writeDeadlineAt(policy, AT)).toBe(AT + 3_600_000 + 60_000);
  });

  it('starts the per-question clock on the first interaction, and NOT on first view', () => {
    const policy = resolvePolicy({
      mode: 'ASSIGNMENT',
      versionPolicy: { perQuestionTimeLimitSec: 300, perQuestionExpiry: 'LOCK' },
    });
    expect(questionDeadlineAt(policy, AT)).toBe(AT + 300_000);
    // A question never touched has no deadline, so an unsubmitted question cannot expire. Deriving it from the
    // attempt start instead would expire every question the student reached but did not answer.
    expect(questionDeadlineAt(policy, null)).toBeNull();
  });

  it('clamps the countdown at zero rather than showing a student a negative time', () => {
    expect(remainingMs(AT, AT - 1000)).toBe(1000);
    expect(remainingMs(AT, AT + 5000)).toBe(0);
  });

  it('admission is the WINDOW, which is a different bound from every deadline', () => {
    const policy = resolvePolicy({
      mode: 'ASSIGNMENT',
      versionPolicy: {
        availabilityWindow: { from: '2026-03-01T09:00:00Z', until: '2026-03-01T17:00:00Z' },
      },
    });
    expect(mayStart(policy, AT - 1)).toEqual({ allowed: false, reason: 'BEFORE_WINDOW' });
    expect(mayStart(policy, AT)).toEqual({ allowed: true });
    expect(mayStart(policy, Date.parse('2026-03-01T17:00:01Z'))).toEqual({
      allowed: false,
      reason: 'AFTER_WINDOW',
    });
    // And a half-open window: the closing instant is still inside it, matching the `<=` in `evaluateWrite`.
    expect(mayStart(policy, Date.parse('2026-03-01T17:00:00Z'))).toEqual({ allowed: true });
  });
});

describe('INV-LATE-1: a late answer is REJECTED, not accepted and not zeroed', () => {
  const policy = timed(60, 60);
  const base: WriteRequest = {
    attemptStatus: 'IN_PROGRESS',
    deadlineAt: AT + 60_000,
    questionDeadlineAt: null,
    expectedRevision: 4,
    serverRevision: 4,
    idempotencyKeySeen: false,
  };

  it('accepts a write exactly ON the grace deadline, to the millisecond', () => {
    // An exclusive comparison makes the last millisecond of every attempt a refusal, which only appears under
    // load and only for the students who submit latest.
    expect(evaluateWrite(policy, base, AT + 120_000)).toEqual({ accept: true, idempotent: false });
  });

  it('refuses one millisecond later, and says WHICH deadline passed', () => {
    expect(evaluateWrite(policy, base, AT + 120_001)).toEqual({
      accept: false,
      reason: 'ATTEMPT_DEADLINE_PASSED',
    });
  });

  it('accepts a repeated idempotency key ANYWHERE, including after submission and long past the deadline', () => {
    /**
     * Checked FIRST, before status and before both deadlines. A client that submits and then retries its last
     * save would otherwise be refused for work the server already holds -- which is the normal shape of a
     * submit, not an edge case.
     */
    for (const attemptStatus of [
      'NOT_STARTED',
      'IN_PROGRESS',
      'SUBMITTED',
      'GRADED',
      'EXPIRED',
    ] as const) {
      expect(
        evaluateWrite(
          policy,
          { ...base, attemptStatus, idempotencyKeySeen: true },
          AT + 999_999_999,
        ),
      ).toEqual({ accept: true, idempotent: true });
    }
  });

  it('checks the REVISION before the deadline, because that is the less misleading message', () => {
    // "Your paper is closed" when the real problem is that another tab holds the question sends the student
    // looking for the wrong thing entirely.
    expect(
      evaluateWrite(policy, { ...base, expectedRevision: 3, serverRevision: 4 }, AT + 999_999),
    ).toEqual({
      accept: false,
      reason: 'REVISION_MISMATCH',
    });
  });

  it('distinguishes a RETRY from a SECOND TAB, which is why both fields exist', () => {
    // Both carry a stale revision and must resolve differently.
    expect(
      evaluateWrite(policy, { ...base, expectedRevision: 3, idempotencyKeySeen: true }, AT),
    ).toEqual({
      accept: true,
      idempotent: true,
    });
    expect(
      evaluateWrite(policy, { ...base, expectedRevision: 3, idempotencyKeySeen: false }, AT),
    ).toEqual({
      accept: false,
      reason: 'REVISION_MISMATCH',
    });
  });

  it('refuses any write to an attempt that is not IN_PROGRESS', () => {
    for (const attemptStatus of ['NOT_STARTED', 'SUBMITTED', 'GRADED', 'EXPIRED'] as const) {
      expect(evaluateWrite(policy, { ...base, attemptStatus }, AT)).toEqual({
        accept: false,
        reason: 'ATTEMPT_NOT_IN_PROGRESS',
      });
    }
  });

  it('refuses a per-question write after the QUESTION deadline, naming it separately from the attempt', () => {
    const perQuestion = resolvePolicy({
      mode: 'ASSIGNMENT',
      versionPolicy: { perQuestionTimeLimitSec: 60, perQuestionExpiry: 'LOCK' },
    });
    const request: WriteRequest = { ...base, deadlineAt: null, questionDeadlineAt: AT + 60_000 };
    expect(evaluateWrite(perQuestion, request, AT + 120_001)).toEqual({
      accept: false,
      reason: 'QUESTION_DEADLINE_PASSED',
    });
    // An untimed ATTEMPT does not make an untimed QUESTION.
    expect(evaluateWrite(perQuestion, request, AT).accept).toBe(true);
  });

  it('refuses the ATTEMPT deadline in preference to the QUESTION one, so the message names the binding bound', () => {
    // Both have passed. The attempt deadline is the one that ends the paper, so it is the one worth reporting;
    // reporting the question would send a student to fix a question when their whole attempt is closed.
    const request: WriteRequest = { ...base, questionDeadlineAt: AT, deadlineAt: AT + 60_000 };
    expect(evaluateWrite(policy, request, AT + 999_999)).toEqual({
      accept: false,
      reason: 'ATTEMPT_DEADLINE_PASSED',
    });
  });

  it('maps the three expiry policies to three instructions, and to NONE when untimed', () => {
    const build = (perQuestionExpiry: 'SOFT' | 'LOCK' | 'AUTO_SUBMIT') =>
      resolvePolicy({
        mode: 'ASSIGNMENT',
        versionPolicy: { perQuestionTimeLimitSec: 60, perQuestionExpiry },
      });
    expect(expiryInstruction(build('SOFT'))).toBe('LOG_ONLY');
    expect(expiryInstruction(build('LOCK'))).toBe('FREEZE');
    expect(expiryInstruction(build('AUTO_SUBMIT'))).toBe('FREEZE_AND_FINALISE');
    expect(expiryInstruction(resolvePolicy({ mode: 'ASSIGNMENT' }))).toBe('NONE');
  });
});

describe('option shuffling, and the cases plans/06 says must NOT shuffle', () => {
  const four = ['Alpha', 'Bravo', 'Charlie', 'Delta'].map((text) => ({ text }));

  it('permutes deterministically from the seed, and stores it', () => {
    const first = shuffleOptions(four, 'seed-1', { enabled: true });
    const again = shuffleOptions(four, 'seed-1', { enabled: true });
    expect(first.items).toEqual(again.items);
    // A re-grade months later has only the stored seed, so this is the property that makes one possible.
    expect(first.seed).toBe('seed-1');
  });

  it('reaches EVERY permutation across seeds, rather than a favoured few', () => {
    /**
     * THE FIRST VERSION OF THIS TEST COMPARED TWO SEEDS AND EXPECTED THEM TO DIFFER, which is flaky BY
     * CONSTRUCTION: four options have 24 permutations, so two arbitrary seeds collide one time in 24. A test
     * that fails four percent of the time for no reason is a test that gets deleted, and deleting it loses the
     * property it was reaching for.
     *
     * The property is distributional and is worth more than the one it replaced: across 600 seeds every one of
     * the 24 permutations must appear, and no single permutation may dominate. A `shuffle` that returned the
     * input order for some seeds, or that only ever swapped the first two elements, would pass a two-seed
     * comparison often enough to be believed.
     */
    const counts = new Map<string, number>();
    for (let index = 0; index < 600; index += 1) {
      const items = shuffleOptions(four, `seed-${String(index)}`, { enabled: true }).items;
      const key = items.map((option) => option.text).join('');
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    expect(counts.size).toBe(24);
    const highest = Math.max(...counts.values());
    // 600 / 24 = 25 expected per permutation. A ceiling of 60 catches a stuck or near-stuck shuffle while
    // leaving room for ordinary sampling variation, which at n=600 has a standard deviation near 4.8.
    expect(highest).toBeLessThan(60);
  });

  it('does not mutate its input', () => {
    const input = [...four];
    shuffleOptions(input, 'seed-1', { enabled: true });
    expect(input).toEqual(four);
  });

  it('NEVER shuffles a question with a catch-all option', () => {
    /**
     * "All of the above" and "none of the above" are not options, they are claims about the option LIST. Moving
     * one changes the answer's position rather than its label, and a student who has learned that "all of the
     * above" tends to be right has been given a real strategy that a shuffle would invalidate.
     */
    for (const text of [
      'All of the above',
      'None of the above',
      'Both of the above',
      'None of these',
    ]) {
      const options = [...four, { text }];
      expect(hasCatchAllOption(options)).toBe(true);
      const result = shuffleOptions(options, 'seed-1', { enabled: true });
      expect(result.skipped).toBe('CATCH_ALL_OPTION');
      expect(result.items).toEqual(options);
    }
  });

  it('does not mistake an option merely CONTAINING the word for a catch-all', () => {
    // A false positive costs one unshuffled question. A false negative costs a student their mark, so the
    // patterns are anchored rather than loose.
    expect(hasCatchAllOption([...four, { text: 'Call the titration' }])).toBe(false);
    expect(hasCatchAllOption([...four, { text: 'None of the reagents are inert' }])).toBe(false);
    expect(hasCatchAllOption(four)).toBe(false);
  });

  it('NEVER shuffles an ordered scale, because permuting an axis INVERTS it', () => {
    // "Strongly disagree … Strongly agree" shuffled is the same scale backwards. A student answering honestly
    // is then marked wrong, and nothing in the interface explains why.
    const likert = ['Strongly disagree', 'Disagree', 'Neutral', 'Agree', 'Strongly agree'].map(
      (text) => ({ text }),
    );
    expect(hasOrderedScale(likert)).toBe(true);
    expect(shuffleOptions(likert, 'seed-1', { enabled: true }).skipped).toBe('ORDERED_SCALE');

    const numeric = ['1 to 5', '6 to 10', '11 to 15'].map((text) => ({ text }));
    expect(hasOrderedScale(numeric)).toBe(true);
    expect(hasOrderedScale(four)).toBe(false);
  });

  it("lets an author's explicit `meaningfulOrder` outrank every heuristic", () => {
    // "solid / liquid / gas" in phase order is meaning-bearing and nothing in the text says so.
    const phases = ['Solid', 'Liquid', 'Gas', 'Plasma'].map((text) => ({ text }));
    expect(shuffleOptions(phases, 'seed-1', { enabled: true }).skipped).toBeNull();
    expect(shuffleOptions(phases, 'seed-1', { enabled: true, meaningfulOrder: true }).skipped).toBe(
      'ORDER_CARRIES_MEANING',
    );
  });

  it('leaves one and two option questions alone', () => {
    // A two-option question has exactly one non-identity permutation, so shuffling either does nothing or
    // flips it -- and a binary question is the one most likely to be answered by position.
    expect(
      shuffleOptions([{ text: 'True' }, { text: 'False' }], 's', { enabled: true }).skipped,
    ).toBe('FEWER_THAN_THREE_OPTIONS');
    expect(shuffleOptions([{ text: 'Only' }], 's', { enabled: true }).skipped).toBe('SINGLETON');
    expect(shuffleOptions([], 's', { enabled: true }).skipped).toBe('SINGLETON');
  });

  it('respects `enabled: false` above everything', () => {
    expect(shuffleOptions(four, 's', { enabled: false }).skipped).toBe('SHUFFLE_DISABLED');
  });

  it('always returns a PERMUTATION, never a copy with something lost or duplicated', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.string({ minLength: 1, maxLength: 8 }), { minLength: 3, maxLength: 12 }),
        fc.string(),
        (texts, seed) => {
          const options = texts.map((text) => ({ text }));
          const result = shuffleOptions(options, seed, { enabled: true });
          expect(result.items).toHaveLength(options.length);
          expect([...result.items].map((o) => o.text).sort()).toEqual([...texts].sort());
          return true;
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('question order, whose default is the OPPOSITE of option shuffling', () => {
  it('does not shuffle a paper unless the paper opts in', () => {
    /**
     * A permuted option list is a within-question nuisance. A permuted paper changes what the student is able to
     * do: a scaffolded worksheet builds each question on the last, and an instruction may say "using your answer
     * to part (a)". So the default is to keep the order and shuffling is the deliberate exception.
     */
    const paper = [1, 2, 3, 4, 5].map((n) => ({ n }));
    expect(shuffleQuestionOrder(paper, 'seed-1', { enabled: false }).skipped).toBe(
      'SHUFFLE_DISABLED',
    );
    const shuffled = shuffleQuestionOrder(paper, 'seed-1', { enabled: true });
    expect(shuffled.skipped).toBeNull();
    expect(shuffled.items.map((q) => q.n).sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it('leaves a two-question paper alone, because flipping it decides which half comes first', () => {
    expect(shuffleQuestionOrder([{ n: 1 }, { n: 2 }], 's', { enabled: true }).skipped).toBe(
      'FEWER_THAN_THREE_OPTIONS',
    );
  });

  it("derives INDEPENDENT streams, so adding a lever does not change every existing student's paper", () => {
    // Both levers fork from the same seed by LABEL. If they drew from one shared stream, adding option shuffling
    // to a paper that only shuffled questions would silently change the question order for every student.
    const paper = [1, 2, 3, 4, 5, 6].map((n) => ({ n }));
    const options = ['A', 'B', 'C', 'D'].map((text) => ({ text }));
    const questionsOnly = shuffleQuestionOrder(paper, 'seed-1', { enabled: true }).items.map(
      (q) => q.n,
    );
    shuffleOptions(options, 'seed-1', { enabled: true });
    expect(shuffleQuestionOrder(paper, 'seed-1', { enabled: true }).items.map((q) => q.n)).toEqual(
      questionsOnly,
    );
  });
});

describe('shuffleSeedFor', () => {
  it('gives different students different permutations of the same paper', () => {
    const paper = [1, 2, 3, 4, 5, 6].map((n) => ({ n }));
    const a = shuffleSeedFor({ assignmentId: 'as', studentId: 's1', attemptId: 'at' });
    const b = shuffleSeedFor({ assignmentId: 'as', studentId: 's2', attemptId: 'at' });
    expect(a).not.toBe(b);
    expect(JSON.stringify(shuffleQuestionOrder(paper, a, { enabled: true }).items)).not.toBe(
      JSON.stringify(shuffleQuestionOrder(paper, b, { enabled: true }).items),
    );
  });

  it('gives the SAME student a different paper on a re-sit, because the attempt is in the seed', () => {
    const one = shuffleSeedFor({ assignmentId: 'as', studentId: 's1', attemptId: 'at1' });
    const two = shuffleSeedFor({ assignmentId: 'as', studentId: 's1', attemptId: 'at2' });
    expect(one).not.toBe(two);
  });

  it('refuses an ambiguous seed rather than letting two students share a paper', () => {
    // `("a-b", "c")` and `("a", "b-c")` would join to the same string, which shows up as two identical papers
    // and is very hard to trace back.
    // The separator is NUL, which cannot appear in a UUID or an assignment slug, so an ordinary space is fine.
    expect(() =>
      shuffleSeedFor({ assignmentId: 'a', studentId: 'x y', attemptId: 'at' }),
    ).not.toThrow();
    // A part containing a NUL would make the join ambiguous, and two different students would silently share
    // a paper -- which surfaces as two identical scripts and is very hard to trace back.
    expect(() =>
      shuffleSeedFor({ assignmentId: 'a\u0000b', studentId: 'c', attemptId: 'at' }),
    ).toThrow(/separator/);
  });

  it('includes the variant label when there is one, so two variants are not the same paper', () => {
    expect(
      shuffleSeedFor({ assignmentId: 'a', studentId: 's', attemptId: 'at', variantLabel: 'v1' }),
    ).not.toBe(
      shuffleSeedFor({ assignmentId: 'a', studentId: 's', attemptId: 'at', variantLabel: 'v2' }),
    );
    // An ABSENT variant label and an EMPTY one are the same statement -- "there is no variant" -- and must
    // produce the same seed, or a paper would shuffle differently depending on which the caller passed.
    expect(shuffleSeedFor({ assignmentId: 'a', studentId: 's', attemptId: 'at' })).toBe(
      shuffleSeedFor({ assignmentId: 'a', studentId: 's', attemptId: 'at', variantLabel: '' }),
    );
  });

  it('does not mutate the profile defaults it is compared against', () => {
    const before = JSON.stringify(QUIZ_PROFILE_DEFAULTS);
    shuffleQuestionOrder(
      [1, 2, 3].map((n) => ({ n })),
      'seed',
      { enabled: true },
    );
    expect(JSON.stringify(QUIZ_PROFILE_DEFAULTS)).toBe(before);
  });
});

describe('properties over the deadline arithmetic', () => {
  it('puts the write deadline exactly gracePeriodSec after the deadline, for any limit and grace', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 7200 }),
        fc.integer({ min: 0, max: 600 }),
        (limit, grace) => {
          const policy = timed(limit, grace);
          const deadline = attemptDeadlineAt(policy, AT);
          const write = writeDeadlineAt(policy, AT);
          if (deadline === null || write === null) return true;
          return write - deadline === grace * 1000;
        },
      ),
      { numRuns: 200 },
    );
  });

  it('refuses one millisecond past the grace and accepts exactly on it, for any limit and grace', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 3600 }),
        fc.integer({ min: 0, max: 300 }),
        (limit, grace) => {
          const deadline = AT + limit * 1000;
          const request: WriteRequest = {
            attemptStatus: 'IN_PROGRESS',
            deadlineAt: deadline,
            questionDeadlineAt: null,
            expectedRevision: 1,
            serverRevision: 1,
            idempotencyKeySeen: false,
          };
          return (
            evaluateWrite(timed(limit, grace), request, deadline + grace * 1000).accept === true &&
            evaluateWrite(timed(limit, grace), request, deadline + grace * 1000 + 1).accept ===
              false
          );
        },
      ),
      { numRuns: 200 },
    );
  });

  it('never returns a negative countdown, for any deadline and any now', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.integer({ min: 0, max: 10_000_000 }),
        (d, n) => remainingMs(d, n) >= 0,
      ),
      { numRuns: 200 },
    );
  });

  it('accepts every untimed attempt at any time, because no bound means no refusal', () => {
    fc.assert(
      fc.property(fc.integer({ min: -1_000_000, max: 100_000_000 }), (now) => {
        const untimed = resolvePolicy({ mode: 'ASSIGNMENT' });
        const decision = evaluateWrite(
          untimed,
          {
            attemptStatus: 'IN_PROGRESS',
            deadlineAt: null,
            questionDeadlineAt: null,
            expectedRevision: 1,
            serverRevision: 1,
            idempotencyKeySeen: false,
          },
          now,
        );
        return decision.accept === true;
      }),
      { numRuns: 200 },
    );
  });
});

describe('the two defensive arms that typed input cannot reach', () => {
  it('treats an EMPTY paper as a refused singleton, not as an empty shuffle', () => {
    /**
     * `[].shuffle()` returns `[]`, which is indistinguishable from "the shuffle declined" -- so a blueprint slot
     * that matched no questions would produce a silently shorter paper instead of a visible failure.
     */
    const result = shuffleQuestionOrder([], 'seed-1', { enabled: true });
    expect(result.skipped).toBe('SINGLETON');
    expect(result.items).toEqual([]);
    expect(shuffleOptions([], 'seed-1', { enabled: true }).skipped).toBe('SINGLETON');
  });

  it('falls back to NONE for an expiry policy this version does not know', () => {
    /**
     * The same reasoning as `readTypedKey` in the grader: the three expiry values are a closed union in the type,
     * so this arm is unreachable from typed code — but `expiryInstruction` reads a policy that came out of a JSON
     * column, and a value from a LATER version of the schema has to produce an answer rather than fall off the
     * end of a switch and return `undefined`.
     *
     * Returning `undefined` here would be the worst outcome: a caller switching on the result would take no
     * branch, so the question would neither be frozen nor logged and would simply stay editable. `NONE` says
     * "this version cannot act on it", which is visible.
     */
    const future = {
      perQuestionExpiry: 'SOMETHING_NEW',
      perQuestionTimeLimitSec: 60,
    } as unknown as Parameters<typeof expiryInstruction>[0];
    expect(expiryInstruction(future)).toBe('NONE');
    // And the typed value is unaffected by the presence of the arm.
    expect(
      expiryInstruction({
        perQuestionExpiry: 'AUTO_SUBMIT',
        perQuestionTimeLimitSec: 60,
      }),
    ).toBe('FREEZE_AND_FINALISE');
  });
});

/* ─────────────────────────────────────────── expiryVerdict: the one answer ── */

describe('expiryVerdict — the single answer to "may this student still write to this question?"', () => {
  const T0 = 1_700_000_000_000;
  const Q = T0 + 60_000;
  const D = T0 + 3_600_000;
  const GRACE = 60_000;

  const soft = { perQuestionExpiry: 'SOFT', perQuestionTimeLimitSec: 60 } as const;
  const lock = { perQuestionExpiry: 'LOCK', perQuestionTimeLimitSec: 60 } as const;
  const auto = { perQuestionExpiry: 'AUTO_SUBMIT', perQuestionTimeLimitSec: 60 } as const;

  it('a `SOFT` question stays writable past its own window, flagged late', () => {
    // THE CELL THAT WAS IMPOSSIBLE BEFORE. `expiredInstruction` said `LOG_ONLY` and nothing asked it, so every
    // write path refused here -- which made `SOFT` and `LOCK` the same configuration.
    expect(expiryVerdict(soft, { questionDeadlineAt: Q, deadlineAt: D, now: Q + GRACE + 1, graceMs: GRACE }))
      .toEqual({ writable: true, isLate: true, refusedBecause: null });
  });

  it('`LOCK` refuses the same instant, and the refusal NAMES the question', () => {
    expect(expiryVerdict(lock, { questionDeadlineAt: Q, deadlineAt: D, now: Q + GRACE + 1, graceMs: GRACE }))
      .toEqual({ writable: false, isLate: false, refusedBecause: 'QUESTION_LOCKED' });
  });

  it('`AUTO_SUBMIT` refuses it too -- the verdict is about WRITABILITY, and all three freeze', () => {
    expect(expiryVerdict(auto, { questionDeadlineAt: Q, deadlineAt: D, now: Q + GRACE + 1, graceMs: GRACE }).writable)
      .toBe(false);
  });

  it('and the three terms are therefore not interchangeable', () => {
    const at = Q + GRACE + 1;
    const verdicts = [soft, lock, auto].map((policy) =>
      expiryVerdict(policy, { questionDeadlineAt: Q, deadlineAt: D, now: at, graceMs: GRACE }).writable,
    );
    // `SOFT` differs from the other two. If this ever reads `[false, false, false]` the term has stopped meaning
    // anything and the agreement tests elsewhere would still be green, because they only compare modules to each
    // other -- they cannot tell that all three moved together.
    expect(verdicts).toEqual([true, false, false]);
  });

  it('`SOFT` is NOT unbounded: the paper still governs it (INV-LATE-1)', () => {
    const afterEverything = D + GRACE + 1;
    expect(expiryVerdict(soft, { questionDeadlineAt: Q, deadlineAt: D, now: afterEverything, graceMs: GRACE }))
      .toEqual({ writable: false, isLate: false, refusedBecause: 'ATTEMPT_DEADLINE_PASSED' });
  });

  it('THE PAPER IS NAMED FIRST when both windows have passed, because that is the fixable fact', () => {
    const verdict = expiryVerdict(lock, { questionDeadlineAt: Q, deadlineAt: D, now: D + GRACE + 1, graceMs: GRACE });
    expect(verdict.refusedBecause).toBe('ATTEMPT_DEADLINE_PASSED');
  });

  it('the closing millisecond is still inside the window, `<=` and not `<`', () => {
    // An exclusive comparison makes the last millisecond of every paper a refusal, visible only under load and only
    // for the students who submit latest.
    expect(expiryVerdict(soft, { questionDeadlineAt: Q, deadlineAt: D, now: D, graceMs: GRACE }).writable).toBe(true);
    expect(expiryVerdict(soft, { questionDeadlineAt: Q, deadlineAt: D, now: D + GRACE, graceMs: GRACE }).writable).toBe(true);
    expect(expiryVerdict(soft, { questionDeadlineAt: Q, deadlineAt: D, now: D + GRACE + 1, graceMs: GRACE }).writable).toBe(false);
  });

  it('a question with no window of its own is governed by the paper alone', () => {
    /**
     * `isLate: true` here, and my first version of this case asserted `false`. The write is 1 ms past the paper's
     * deadline with 60 s of grace, so it is accepted AND late -- which is the whole purpose of the flag. Asserting
     * `false` would have been asserting that a write arriving after the deadline looks perfectly on time, and the
     * implementation was right to disagree.
     */
    expect(expiryVerdict(lock, { questionDeadlineAt: null, deadlineAt: D, now: D + 1, graceMs: GRACE }))
      .toEqual({ writable: true, isLate: true, refusedBecause: null });
    // `expiryInstruction` reads `NONE` with no per-question limit, so the term cannot bite where there is no window.
    expect(expiryVerdict({ perQuestionExpiry: 'SOFT', perQuestionTimeLimitSec: null }, {
      questionDeadlineAt: null, deadlineAt: D, now: D - 1, graceMs: GRACE,
    })).toEqual({ writable: true, isLate: false, refusedBecause: null });
  });

  it('a write INSIDE the grace window is accepted AND flagged late -- the flag is the point', () => {
    // 40 s past the deadline with 60 s of grace: the answer stands and the lateness is recorded for the receipt and
    // the late-save audit. Asking only "past the deadline plus grace" would report this as perfectly on time.
    expect(expiryVerdict(lock, { questionDeadlineAt: null, deadlineAt: D, now: D + 40_000, graceMs: GRACE }))
      .toEqual({ writable: true, isLate: true, refusedBecause: null });
    expect(expiryVerdict(lock, { questionDeadlineAt: null, deadlineAt: D, now: D - 1, graceMs: GRACE }).isLate)
      .toBe(false);
  });

  it('AN UNTIMED PAPER IS NOT AN UNTIMED QUESTION, and my first version of this test got that wrong', () => {
    // I asserted that an untimed paper accepts every write whatever the term, at an instant chosen to be well past
    // the QUESTION's window. That is false, and the implementation was right: `deadlineAt: null` removes the paper's
    // bound and does nothing to the question's own. Asserting it would have been asserting a hole -- an untimed
    // paper where `LOCK` silently admitted writes to an expired question.
    expect(expiryVerdict(lock, { questionDeadlineAt: Q, deadlineAt: null, now: Q + 10 * GRACE, graceMs: GRACE }).writable)
      .toBe(false);
    // What IS true, and is the useful half: with no paper deadline there is nothing left for `SOFT` to buy, so the
    // term stops mattering for a question that is still open.
    for (const policy of [soft, lock, auto]) {
      expect(expiryVerdict(policy, { questionDeadlineAt: Q, deadlineAt: null, now: Q - 1, graceMs: GRACE }))
        .toEqual({ writable: true, isLate: false, refusedBecause: null });
    }
  });

  it('ZERO grace is a hard deadline on both windows', () => {
    expect(expiryVerdict(lock, { questionDeadlineAt: Q, deadlineAt: D, now: Q, graceMs: 0 }).writable).toBe(true);
    expect(expiryVerdict(lock, { questionDeadlineAt: Q, deadlineAt: D, now: Q + 1, graceMs: 0 }).writable).toBe(false);
  });
});

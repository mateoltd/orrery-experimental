import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Tests for the receipt chain.  (P7-T9)
 *
 * ## A REAL SHA-256, INJECTED, SO THE FORMULA IS ACTUALLY TESTED
 *
 * The tests pass Node's `createHash('sha256')` rather than a stub. A stub would let the formula be wrong in a
 * hundred ways -- a wrong separator, a missing field, a mis-ordered concatenation -- and still pass, because a
 * stub cannot tell a correct hash from a self-consistent one. What is being tested is that the chain matches the
 * formula in `plans/01` §9.4, and only real SHA-256 can check that.
 */

import { createHash } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../editor/canonical.js';
import {
  finalRevisionsInQuestionOrder,
  foldBytes,
  foldRevision,
  keysHash,
  type Mac,
  type Revision,
  receiptHash,
  SEPARATOR,
  seedHash,
  signReceipt,
  verifyReceipt,
  verifyReceiptSignature,
} from './receipt.js';

const sha256 = (bytes: string): string => createHash('sha256').update(bytes, 'utf8').digest('hex');

/**
 * `keysHash` IS PART OF THE SEED.  (P8-T10)
 *
 * It was absent while `plans/02` §2 and the schema both described it, and adding it CHANGED `H₀` -- so this file's
 * hand-computed reference digest moved, and it is worth being explicit that the move is the point rather than a
 * regression: a receipt computed before this commit no longer reproduces against a chain it does not describe, which is
 * the behaviour you want. A receipt that kept verifying after the key set stopped being part of it was verifying
 * something weaker than it claimed to.
 */
const SEED = {
  attemptId: '0195f2c0-0000-7000-8000-000000000001',
  assignmentId: 'as-1',
  policySnapshot: { version: 1, maxAttempts: 1, gracePeriodSec: 60 },
  keysHash: 'keys-1',
};

const ORDER = ['q1', 'q2', 'q3'];

const revision = (
  questionId: string,
  n: number,
  answer: unknown,
  serverTs = '2026-03-01T09:00:00.000Z',
): Revision => ({
  questionId,
  revision: n,
  answer,
  serverTs,
  source: 'STUDENT',
});

/** The chain with `previousHash` links filled in, which is what the database stores. */
const linked = (revisions: readonly Revision[]): Revision[] => {
  let previous = seedHash(SEED, sha256);
  return revisions.map((entry) => {
    // BOTH links, as `AnswerRevision` stores both: `previousHash` and `answerHash`.
    const withLinks: Revision = {
      ...entry,
      previousHash: previous,
      answerHash: sha256(canonicalJson(entry.answer)),
    };
    previous = foldRevision(previous, entry, sha256);
    return withLinks;
  });
};

describe('H0 binds the attempt, the assignment AND the policy snapshot', () => {
  it('matches the formula, hashed with real SHA-256', () => {
    const expected = createHash('sha256')
      .update(
        // `foldBytes` RATHER THAN `[...].join(' ')`. The test used to SPELL the separator out, and it spelled it
        // as a space while the implementation used NUL -- so the two disagreed for a reason no diff could show,
        // because the file containing the NUL was binary to grep and to review.
        //
        // Deriving the reference from the implementation's own fold is right here: the thing under test is the
        // FORMULA, not the choice of separator byte.
        //
        // `canonicalJson`, NOT `JSON.stringify`: it SORTS KEYS, so the two produce different strings for the same
        // object, and a reference that does not reproduce the implementation's normalisation is not a reference.
        foldBytes(
          SEED.attemptId,
          SEED.assignmentId,
          createHash('sha256').update(canonicalJson(SEED.policySnapshot), 'utf8').digest('hex'),
          // The fourth component, and the reason this digest moved in P8-T10.
          SEED.keysHash,
        ),
        'utf8',
      )
      .digest('hex');
    expect(seedHash(SEED, sha256)).toBe(expected);
  });

  it('changes when the POLICY SNAPSHOT changes, because INV-POLICY-1 freezes it for exactly this reason', () => {
    const before = seedHash(SEED, sha256);
    const after = seedHash(
      { ...SEED, policySnapshot: { ...SEED.policySnapshot, maxAttempts: 3 } },
      sha256,
    );
    expect(after).not.toBe(before);
    // Without the snapshot in H0, a teacher extending a deadline would break every receipt already issued.
  });

  it('folds with a separator that cannot appear in an id', () => {
    // NUL cannot appear in a UUID or a slug, so `("ab","c")` and `("a","bc")` cannot collide.
    expect(SEPARATOR).toBe('\u0000');
    expect(foldBytes('ab', 'c')).not.toBe(foldBytes('a', 'bc'));
  });

  it('does not confuse two different (attempt, assignment) pairs', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 8 }),
        fc.string({ minLength: 1, maxLength: 8 }),
        (a, b) => {
          const left = seedHash({ ...SEED, attemptId: a, assignmentId: b }, sha256);
          const right = seedHash({ ...SEED, attemptId: b, assignmentId: a }, sha256);
          return left !== right || a === b;
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('the chain folds in QUESTION ORDER, not arrival order', () => {
  const a = revision('q1', 1, 'one');
  const b = revision('q2', 1, 'two');
  const c = revision('q3', 1, 'three');

  it('produces the same receipt for the same paper reached in different orders', () => {
    /**
     * THE PROPERTY THAT DECIDES WHETHER THE RECEIPT IS ABOUT THE PAPER OR ABOUT THE JOURNEY.
     *
     * Folding by arrival would make the hash depend on network timing, so two students who reached the same final
     * answers by different routes would get different receipts -- and a teacher comparing them could not tell
     * whether anything had actually changed. `plans/01` §9.4 says the receipt "folds them in QUESTION ORDER".
     */
    const forwards = receiptHash(SEED, [a, b, c], ORDER, sha256);
    const backwards = receiptHash(SEED, [c, b, a], ORDER, sha256);
    expect(backwards).toBe(forwards);
  });

  it('takes the HIGHEST revision per question, not the last one seen', () => {
    // Two devices, revisions arriving out of order. "Last seen" would make the receipt depend on which device the
    // teacher happened to read.
    const stale = revision('q1', 1, 'first');
    const fresh = revision('q1', 3, 'third');
    const middle = revision('q1', 2, 'second');
    const taken = finalRevisionsInQuestionOrder([fresh, stale, middle], ORDER);
    expect(taken).toHaveLength(1);
    expect(taken[0]?.answer).toBe('third');
  });

  it('OMITS an unanswered question rather than folding it as null', () => {
    /**
     * A blank answer and an unanswered question are DIFFERENT FACTS -- the grader reports one as `BLANK` and the
     * other is not a response at all -- so hashing them to the same value would make the receipt unable to tell
     * them apart, which is the one thing it exists to do.
     */
    const withBlank = finalRevisionsInQuestionOrder([revision('q1', 1, null)], ['q1', 'q2']);
    expect(withBlank).toHaveLength(1);
    expect(finalRevisionsInQuestionOrder([], ['q1', 'q2'])).toHaveLength(0);
  });

  it('changes when any answer changes, which is the whole point', () => {
    const base = receiptHash(SEED, linked([a, b]), ['q1', 'q2'], sha256);
    const tampered = receiptHash(SEED, linked([a, revision('q2', 1, 'TWO')]), ['q1', 'q2'], sha256);
    expect(tampered).not.toBe(base);
  });

  it('is deterministic across calls, so a retry produces the same receipt', () => {
    const chain = linked([a, b, c]);
    expect(receiptHash(SEED, chain, ORDER, sha256)).toBe(receiptHash(SEED, chain, ORDER, sha256));
  });
});

describe('verify-receipt reports the FIRST divergence, and names the question', () => {
  const chain = linked([
    revision('q1', 1, 'one'),
    revision('q2', 1, 'two'),
    revision('q3', 1, 'three'),
  ]);

  it('passes silently on an untouched chain', () => {
    expect(
      verifyReceipt(SEED, chain, ORDER, receiptHash(SEED, chain, ORDER, sha256), sha256),
    ).toBeNull();
  });

  it('names the question whose stored link no longer follows', () => {
    /**
     * `q2`'s ANSWER has been altered, so the hash `q3` was appended onto no longer matches the recomputation.
     * A teacher is told `q2` -- not "the receipt is wrong", which sends them through the whole paper.
     */
    const tampered: Revision[] = chain.map((entry) =>
      entry.questionId === 'q2' ? { ...entry, answer: 'TWO' } : entry,
    );
    const divergence = verifyReceipt(
      SEED,
      tampered,
      ORDER,
      receiptHash(SEED, chain, ORDER, sha256),
      sha256,
    );
    expect(divergence).not.toBeNull();
    expect(divergence?.questionId).toBe('q2');
    expect(divergence?.because).toContain('q2');
  });

  it('reports the SEED when the attempt or policy does not match, with no question to blame', () => {
    const other = { ...SEED, policySnapshot: { version: 1, maxAttempts: 9 } };
    const divergence = verifyReceipt(
      other,
      chain,
      ORDER,
      receiptHash(SEED, chain, ORDER, sha256),
      sha256,
    );
    expect(divergence?.questionId).toBeNull();
    expect(divergence?.because).toContain('H0');
  });

  it('distinguishes "an answer changed" from "the final fold differs"', () => {
    // Every stored link agrees but the receipt does not: the disagreement is not in any answer, and saying
    // "q3" would send a marker to inspect the wrong question.
    const stored = receiptHash(SEED, chain, ORDER, sha256);
    const divergence = verifyReceipt(
      SEED,
      chain,
      ORDER,
      `${stored.slice(0, -1)}${stored.endsWith('a') ? 'b' : 'a'}`,
      sha256,
    );
    expect(divergence?.because).toContain('final fold');
  });

  it('still detects a mismatch when the chain stores NO links, without blaming a question', () => {
    // A chain with no `previousHash` cannot be localised. The honest answer is "it does not match, and I cannot
    // tell you where" rather than naming the first question arbitrarily.
    const unlinked: Revision[] = [revision('q1', 1, 'one'), revision('q2', 1, 'two')];
    // No `previousHash` and no `answerHash`, as a chain stored without its links would be.
    const stored = receiptHash(SEED, unlinked, ['q1', 'q2'], sha256);
    const divergence = verifyReceipt(
      SEED,
      unlinked,
      ['q1', 'q2'],
      `${stored.slice(0, -1)}0`,
      sha256,
    );
    expect(divergence).not.toBeNull();
    expect(divergence?.because).toContain('final fold');
  });

  it('is a FUNCTION of its inputs, so a re-verification says the same thing', () => {
    const stored = receiptHash(SEED, chain, ORDER, sha256);
    const tampered = chain.map((e) => (e.questionId === 'q1' ? { ...e, answer: 'ONE' } : e));
    const first = verifyReceipt(SEED, tampered, ORDER, stored, sha256);
    const second = verifyReceipt(SEED, tampered, ORDER, stored, sha256);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});

describe('properties over the chain', () => {
  const arbAnswers = fc.array(fc.jsonValue(), { minLength: 1, maxLength: 3 });

  it('is injective in the answer set, for arbitrary JSON answers', () => {
    fc.assert(
      fc.property(arbAnswers, arbAnswers, (left, right) => {
        const a = receiptHash(SEED, linked([revision('q1', 1, left)]), ['q1'], sha256);
        const b = receiptHash(SEED, linked([revision('q1', 1, right)]), ['q1'], sha256);
        // Different canonical JSON must give a different receipt. If both sides canonicalise to the same string
        // then they are the same answer as far as the paper is concerned, and equality is correct.
        return a !== b || JSON.stringify(left) === JSON.stringify(right);
      }),
      { numRuns: 200 },
    );
  });

  it('never produces the same receipt for two different attempts', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 10 }), (attemptId) => {
        const chain = linked([revision('q1', 1, 'one')]);
        const mine = receiptHash({ ...SEED, attemptId }, chain, ['q1'], sha256);
        const theirs = receiptHash({ ...SEED, attemptId: `${attemptId}x` }, chain, ['q1'], sha256);
        return mine !== theirs;
      }),
      { numRuns: 200 },
    );
  });

  it('verifies every chain it produces, over arbitrary question counts', () => {
    fc.assert(
      fc.property(fc.array(fc.jsonValue(), { minLength: 0, maxLength: 6 }), (answers) => {
        const revisions = answers.map((answer, index) =>
          revision(`q${String(index + 1)}`, 1, answer),
        );
        const order = revisions.map((entry) => entry.questionId);
        const linkedChain = linked(revisions);
        const stored = receiptHash(SEED, linkedChain, order, sha256);
        return verifyReceipt(SEED, linkedChain, order, stored, sha256) === null;
      }),
      { numRuns: 200 },
    );
  });

  it('reports a divergence whenever any single answer is altered, for arbitrary chains', () => {
    fc.assert(
      fc.property(
        fc.array(fc.jsonValue(), { minLength: 1, maxLength: 5 }),
        fc.nat(),
        (answers, at) => {
          const revisions = answers.map((answer, index) =>
            revision(`q${String(index + 1)}`, 1, answer),
          );
          const order = revisions.map((entry) => entry.questionId);
          const chain = linked(revisions);
          const stored = receiptHash(SEED, chain, order, sha256);
          const index = at % answers.length;
          const tampered = chain.map((entry, position) =>
            position === index ? { ...entry, answer: { tampered: true } } : entry,
          );
          const divergence = verifyReceipt(SEED, tampered, order, stored, sha256);
          // Either an answer genuinely changed (and the chain must not verify), or it did not (and it must).
          const changed =
            JSON.stringify(revisions[index]?.answer) !== JSON.stringify({ tampered: true });
          return changed ? divergence !== null : divergence === null;
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('the cases a support ticket actually arrives with', () => {
  it('blames the ANCHOR for a paper with no revisions, not the final fold', () => {
    /**
     * The first version fell through to "every stored link agrees, so the difference is in the final fold" for a
     * chain with nothing in it. That is technically true and practically useless -- and an empty paper is the
     * EASIEST thing to export from a support ticket, so it is the first thing anybody checks.
     */
    const divergence = verifyReceipt(SEED, [], ORDER, 'deadbeef', sha256);
    expect(divergence?.questionId).toBeNull();
    expect(divergence?.because).toContain('no accepted revisions');
  });

  it('passes for a paper with no revisions when the anchor is right', () => {
    const empty: Revision[] = [];
    expect(
      verifyReceipt(SEED, empty, ORDER, receiptHash(SEED, empty, ORDER, sha256), sha256),
    ).toBeNull();
  });

  it('names the QUESTION for a chain whose stored answer hash does not match its answer', () => {
    /**
     * THE CASE `answerHash` EXISTS FOR, and the reason the link check alone is not enough.
     *
     * Changing `q2`'s answer leaves `q2`'s own `previousHash` intact, so a link-only check does not notice until
     * `q3` -- the first stored predecessor that no longer follows -- and reports `q3`. That is traceable and
     * useless: it sends whoever is investigating to a question nobody altered. `AnswerRevision.answerHash`
     * localises it to `q2`.
     */
    const chain = linked([
      revision('q1', 1, 'one'),
      revision('q2', 1, 'two'),
      revision('q3', 1, 'three'),
    ]);
    const stored = receiptHash(SEED, chain, ORDER, sha256);
    const tampered = chain.map((entry) =>
      entry.questionId === 'q2' ? { ...entry, answer: 'TWO' } : entry,
    );
    const divergence = verifyReceipt(SEED, tampered, ORDER, stored, sha256);
    expect(divergence?.questionId).toBe('q2');
    expect(divergence?.because).toContain('does not hash to the value recorded with it');
  });

  it('blames the ANCHOR when the attempt does not match, naming no question', () => {
    const chain = linked([revision('q1', 1, 'one')]);
    const stored = receiptHash(SEED, chain, ['q1'], sha256);
    const divergence = verifyReceipt(
      { ...SEED, attemptId: 'someone-elses-attempt' },
      chain,
      ['q1'],
      stored,
      sha256,
    );
    expect(divergence?.questionId).toBeNull();
    expect(divergence?.because).toContain('H0');
  });
});

/**
 * `keysHash` in the seed, and the keyed MAC on the stored receipt.  (P8-T10)
 *
 * Both were missing while `plans/02` §2 and the schema both described them, so the tests are as much about the gap as
 * about the behaviour.
 */
describe('the receipt BINDS TO THE KEYS, which it did not until P8-T10', () => {
  const seed = (keysHashValue: string): ReceiptSeed => ({
    attemptId: 'a1',
    assignmentId: 'as1',
    policySnapshot: { totalTimeLimitSec: null },
    keysHash: keysHashValue,
  });
  const revisions: Revision[] = [
    {
      questionId: 'q1',
      revision: 1,
      answer: { selectedChoiceIndex: 0 },
      serverTs: 'T0',
      source: 'CLIENT',
    },
  ];

  it('produces a DIFFERENT receipt for the same chain under a different key set', () => {
    /**
     * The whole point. Before `keysHash` entered `H₀`, changing the answer key left every receipt reproducible and
     * `verify-receipt` reported no divergence -- so a student whose mark moved because a key was edited had no way to
     * show it, which is the situation the receipt exists for.
     */
    const before = receiptHash(seed('keys-A'), revisions, ['q1'], sha256);
    const after = receiptHash(seed('keys-B'), revisions, ['q1'], sha256);
    expect(before).not.toBe(after);
  });

  it('verifies cleanly when the key set is UNCHANGED', () => {
    const stored = receiptHash(seed('keys-A'), revisions, ['q1'], sha256);
    expect(verifyReceipt(seed('keys-A'), revisions, ['q1'], stored, sha256)).toBeNull();
    // ...and reports a divergence once the keys move, which `verify-receipt` will then name as the SEED.
    expect(verifyReceipt(seed('keys-B'), revisions, ['q1'], stored, sha256)?.questionId).toBeNull();
  });

  it('orders the key set, so two servers computing keysHash AGREE', () => {
    // Two application servers grading the same cohort must produce byte-identical digests, or every receipt becomes
    // unreproducible and `verify-receipt` becomes useless.
    const a = [
      { questionId: 'q2', correct: 'x', points: 2 },
      { questionId: 'q1', correct: 'y', points: 1 },
    ];
    const b = [...a].reverse();
    expect(keysHash(a, sha256)).toBe(keysHash(b, sha256));
  });

  it('changes keysHash when a single POINT VALUE moves', () => {
    // Written as two literals rather than a spread with a non-null assertion: the assertion was noise for an element
    // that is provably present, and it is the kind of token that teaches a reader to add `!` where it is not needed.
    const onePoint = [{ questionId: 'q1', correct: 'y', points: 1 }];
    const twoPoints = [{ questionId: 'q1', correct: 'y', points: 2 }];
    expect(keysHash(onePoint, sha256)).not.toBe(keysHash(twoPoints, sha256));
  });
});

describe('a receipt is only as trustworthy as its SIGNATURE', () => {
  const folded = 'a'.repeat(64);
  const key = 'k'.repeat(32);
  const hmac: Mac = (message) => createHmac('sha256', key).update(message, 'utf8').digest('hex');
  const otherHmac: Mac = (message) =>
    createHmac('sha256', 'z'.repeat(32)).update(message, 'utf8').digest('hex');
  const signed = signReceipt(folded, hmac);

  it('signs, and a verifier with the same key accepts', () => {
    expect(signed).not.toBe(folded);
    expect(verifyReceiptSignature(signed, folded, hmac)).toEqual({ ok: true });
  });

  it('REFUSES UNDER A DIFFERENT KEY, which is the property a bare hash fold cannot have', () => {
    /**
     * Anyone can construct a chain that folds to whatever they like, because the fold is public and needs no secret. So
     * an UNSIGNED receipt proves internal consistency and nothing more -- "it reproduces" is not "we issued it".
     */
    expect(verifyReceiptSignature(signed, folded, otherHmac)).toEqual({
      ok: false,
      reason: 'SIGNATURE_MISMATCH',
    });
  });

  it('REFUSES WHEN THE FOLDER MOVED, so a consistent chain over different answers still fails', () => {
    expect(verifyReceiptSignature(signed, 'b'.repeat(64), hmac).ok).toBe(false);
  });

  it('reports NO_KEY as a REFUSAL rather than a pass', () => {
    /**
     * A verifier that cannot check the signature has not verified the receipt. Returning "fine" here is how a deployment
     * comes to believe in an authenticity check it never performed -- and it would do so silently, in production,
     * because nothing threw.
     */
    expect(verifyReceiptSignature(signed, folded, null)).toEqual({ ok: false, reason: 'NO_KEY' });
  });

  it('reports an absent receipt as NOT_SIGNED, distinct from a wrong one', () => {
    expect(verifyReceiptSignature('', folded, hmac)).toEqual({ ok: false, reason: 'NOT_SIGNED' });
  });

  it('does NOT use `===` on the signature', () => {
    // A short-circuit comparison leaks the matching prefix length and improves a forgery a byte at a time. Asserted
    // against the source because the property is about the code that ships, not about the current behaviour.
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'receipt.ts'),
      'utf8',
    );
    const body = source.slice(source.indexOf('export const verifyReceiptSignature'));
    expect(body).toContain('charCodeAt');
    expect(body).not.toMatch(/storedReceipt === expected|expected === storedReceipt/);
  });
});

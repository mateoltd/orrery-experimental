/**
 * The submission receipt: the hash chain that makes "I didn't change my answer" checkable.  (P7-T9)
 *
 * ## WHAT THIS IS FOR
 *
 * `plans/01` §9.4, exactly:
 *
 * ```
 * H₀ = sha256(attemptId ‖ assignmentId ‖ sha256(canonicalJson(policySnapshot)))
 * Hᵢ = sha256(Hᵢ₋₁ ‖ questionId ‖ sha256(canonicalJson(answer)) ‖ serverTs)
 * ```
 *
 * "The student sees `Hₙ`. A teacher can recompute it from the revision chain ... which reports the first
 * divergence. **That is what makes "I didn't change my answer" checkable rather than deniable.**"
 *
 * ## AND THE ORDER IS QUESTION ORDER, WHICH IS NOT REVISION ORDER
 *
 * The obvious implementation folds revisions as they arrive, newest last. That is wrong, and it is wrong in a way
 * that makes the hash depend on network timing: two students who made the same edits in a different order would
 * get different receipts for the same final paper. The plan says the receipt "folds them in QUESTION ORDER", so
 * the chain walks questions in the paper's order and takes each question's FINAL accepted revision.
 *
 * That is also what makes the receipt a statement about the paper rather than about the journey. A teacher
 * recomputing it months later has the paper, not the edit history.
 *
 * ## AND THE DIGEST IS INJECTED, BECAUSE `contracts` MUST NOT DEPEND ON `node:crypto`
 *
 * `canonicalJson` already lives in this package and is used by the editor, which runs in a browser. Importing
 * `node:crypto` here would put a Node builtin in a browser bundle. So the digest is a parameter: the server passes
 * `createHash('sha256')`, the tests pass a stub, and the FORMULA -- which is the part with a spec -- is testable
 * without either.
 *
 * ## AND IT IS NOT `contentChecksum`
 *
 * `editor/canonical.ts` exports `contentChecksum`, and its own comment says "**a change detector, not a security
 * primitive** ... If you need to prove integrity against an adversary, this is the wrong function". FNV-1a is 32
 * bits and is trivially collidable. A receipt is shown to a student and used to settle a dispute, so it is SHA-256
 * and the caller supplies it.
 */

import { canonicalJson } from '../editor/canonical.js';

/** A digest over bytes, as `node:crypto`'s `createHash` produces. */
export type Digest = (bytes: string) => string;

/** One accepted write, as stored by `AnswerRevision`. */
export interface Revision {
  readonly questionId: string;
  /** The revision number. The chain takes the HIGHEST per question, not the last seen. */
  readonly revision: number;
  readonly answer: unknown;
  readonly serverTs: string;
  readonly source: string;
  /**
   * THE HASH THIS REVISION WAS APPENDED ONTO, as stored.
   *
   * This is what makes "the first divergence" findable at all. `Hₙ` alone cannot localise a mismatch -- SHA-256
   * hashes do not nest, `H₁` does not begin with `H₀` -- so the chain is stored link by link
   * (`AnswerRevision.previousHash`) and each link is recomputed against its stored predecessor. A teacher is then
   * told WHICH question first parted from the receipt, rather than being handed a boolean.
   */
  readonly previousHash?: string | null;
  /**
   * `sha256(canonicalJson(answer))` as stored. `C5` in `plans/02`: "hash the exact bytes accepted, not a re-read
   * of jsonb".
   *
   * This is what localises a TAMPERED ANSWER rather than a tampered chain. Without it, changing `q2`'s answer is
   * only detected at `q3`, because `q3` is the first link whose stored predecessor no longer matches -- so the
   * report would name `q3` and send a marker to inspect the wrong question. `C5` is the reason this field exists.
   */
  readonly answerHash?: string | null;
}

/** What the chain needs to reproduce `H₀`. */
export interface ReceiptSeed {
  readonly attemptId: string;
  readonly assignmentId: string;
  /** The FROZEN policy snapshot. `INV-POLICY-1`: stored once at first start, never re-read from the assignment. */
  readonly policySnapshot: unknown;
}

/**
 * `‖` MEANS CONCATENATION OF THE HASH **STRINGS**, with a separator.
 *
 * The formula writes `sha256(a ‖ b ‖ sha256(c))`, and the separators are not in it. Without one, `("ab","c")` and
 * `("a","bc")` fold to the same bytes -- and those are a real shape here, because `attemptId` is a UUID and a
 * teacher-supplied `assignmentId` is not. A separator that cannot appear in a UUID makes the fold injective.
 */
/**
 * THE FOLD, as a function, because the separator is part of the HASH and must not be duplicated.
 *
 * `plans/01` §9.4 writes `sha256(a ‖ b ‖ sha256(c))` and does not say what `‖` is. Without a separator, `("ab","c")`
 * and `("a","bc")` fold to the same bytes -- and that is a real shape here, because `attemptId` is a UUID and a
 * teacher-supplied `assignmentId` is not.
 *
 * The separator is NUL, written as an ESCAPE and not as a raw byte: a literal NUL in a source file makes the file
 * binary to grep, to diff and to some editors, and the first version of this file had exactly that -- so `grep`
 * reported "binary file matches" and a test that hardcoded `' '` disagreed with it for a reason nobody could see.
 *
 * It is EXPORTED so a test cannot spell it differently. A test that retypes the separator is a second copy of a
 * value the hash depends on, which is the duplication this function exists to remove.
 */
export const SEPARATOR = '\u0000';

/** `‖` -- concatenate with the separator between parts. */
export const foldBytes = (...parts: readonly string[]): string => parts.join(SEPARATOR);

/**
 * `H₀` -- the anchor. Binds the receipt to the attempt, the assignment, AND the policy it ran under.
 *
 * The policy snapshot is in the seed on purpose: `INV-POLICY-1` freezes it at first start precisely so that
 * changing an assignment afterwards cannot change what `verify-receipt` computes for an attempt already graded.
 * Without the snapshot in `H₀`, a teacher who extended a deadline would break the receipt on every attempt.
 */
export const seedHash = (seed: ReceiptSeed, digest: Digest): string =>
  digest(foldBytes(seed.attemptId, seed.assignmentId, digest(canonicalJson(seed.policySnapshot))));

/** `Hᵢ` -- one question folded onto the chain. */
export const foldRevision = (previous: string, revision: Revision, digest: Digest): string =>
  digest(
    foldBytes(
      previous,
      revision.questionId,
      digest(canonicalJson(revision.answer)),
      revision.serverTs,
    ),
  );

/**
 * THE FINAL ACCEPTED REVISION PER QUESTION, in QUESTION ORDER.
 *
 * Two rules, and the second is the one that is easy to get wrong:
 *
 * - **The highest `revision` wins**, not the last one seen. Revisions can arrive out of order across two devices,
 *   and "last seen" would make the receipt depend on which device the teacher happened to read.
 * - **The chain walks the PAPER's question order**, not the order questions were answered. The plan says "folds
 *   them in question order", and folding by arrival would make the receipt a statement about network timing: two
 *   students who reached the same paper by different routes would get different receipts for it.
 *
 * A question with no revision is OMITTED rather than folded as `null`. A blank answer and an unanswered question are
 * different facts -- the grader reports one as `BLANK` and the other is not a response at all -- so hashing them
 * to the same value would make the receipt unable to tell them apart.
 */
export const finalRevisionsInQuestionOrder = (
  revisions: readonly Revision[],
  questionOrder: readonly string[],
): readonly Revision[] => {
  const best = new Map<string, Revision>();
  for (const revision of revisions) {
    const held = best.get(revision.questionId);
    if (held === undefined || revision.revision > held.revision)
      best.set(revision.questionId, revision);
  }
  return questionOrder
    .map((questionId) => best.get(questionId))
    .filter((revision): revision is Revision => revision !== undefined);
};

/** `Hₙ`, which is what the student sees. */
export const receiptHash = (
  seed: ReceiptSeed,
  revisions: readonly Revision[],
  questionOrder: readonly string[],
  digest: Digest,
): string =>
  finalRevisionsInQuestionOrder(revisions, questionOrder).reduce(
    (previous, revision) => foldRevision(previous, revision, digest),
    seedHash(seed, digest),
  );

export interface Divergence {
  /** Which question the chain first disagrees at, or `null` when it is the seed. */
  readonly questionId: string | null;
  /** The hash recomputed at that point. */
  readonly got: string;
  /** The link the stored chain says should have come before it. */
  readonly expected: string | null;
  readonly because: string;
}

/**
 * RECOMPUTE THE RECEIPT AND REPORT THE **FIRST** DIVERGENCE.
 *
 * First, not last, and not a boolean. A teacher holding a receipt that does not match needs to know WHICH question
 * changed: "it does not match" sends them through the whole paper, and the first divergence is the earliest point
 * at which the two histories part -- everything after it is downstream of the same edit.
 *
 * Returns `null` when the receipt reproduces, which is the passing case and the only silent one.
 */
export const verifyReceipt = (
  seed: ReceiptSeed,
  revisions: readonly Revision[],
  questionOrder: readonly string[],
  storedReceipt: string,
  digest: Digest,
): Divergence | null => {
  const ordered = finalRevisionsInQuestionOrder(revisions, questionOrder);
  let computed = seedHash(seed, digest);
  const first = ordered[0];

  /**
   * A CHAIN WITH NO REVISIONS IS AN ANCHOR PROBLEM, NOT A FOLD PROBLEM.
   *
   * With nothing folded, the receipt must equal `H0`, so a mismatch is the attempt, the assignment or the policy
   * snapshot. The first version fell through to the "final fold" message here, which is technically true and
   * practically useless -- and it is the FIRST thing anybody checks, because an empty paper is the easy case to
   * export from a support ticket.
   */
  if (first === undefined) {
    return computed === storedReceipt
      ? null
      : {
          questionId: null,
          got: computed,
          expected: storedReceipt,
          because:
            'the paper has no accepted revisions, so the receipt is H0 and the attempt, assignment or policy snapshot does not match',
        };
  }

  /**
   * THE FIRST LINK IS `H₀`, SO A MISMATCH THERE IS A SEED DIVERGENCE AND NOT A QUESTION'S FAULT.
   *
   * Reporting it against `q1` would be technically traceable and practically misleading: nothing about the first
   * answer is wrong, the attempt or the policy snapshot is. So `questionId` is `null`, which means "the anchor",
   * and the caller can say the receipt belongs to a different attempt or a different policy.
   */
  if (first !== undefined && first.previousHash != null && first.previousHash !== computed) {
    return {
      questionId: null,
      got: computed,
      expected: first.previousHash,
      because: 'the attempt, assignment or policy snapshot does not match the receipt anchor H0',
    };
  }

  for (const revision of ordered) {
    /**
     * THE ANSWER IS CHECKED BEFORE THE LINK, because `answerHash` names the question that changed.
     *
     * The link check alone detects a changed `q2` at `q3` -- `q3` is the first stored predecessor that no longer
     * follows -- which is traceable and useless, because it sends whoever is investigating to the wrong question.
     */
    if (
      revision.answerHash != null &&
      revision.answerHash !== digest(canonicalJson(revision.answer))
    ) {
      return {
        questionId: revision.questionId,
        got: digest(canonicalJson(revision.answer)),
        expected: revision.answerHash,
        because: `the answer stored for "${revision.questionId}" (revision ${String(revision.revision)}, source ${revision.source}) does not hash to the value recorded with it`,
      };
    }

    if (revision.previousHash != null && revision.previousHash !== computed) {
      return {
        questionId: revision.questionId,
        got: computed,
        expected: revision.previousHash,
        because: `the stored chain for "${revision.questionId}" (revision ${String(revision.revision)}, source ${revision.source}) was appended to a different hash`,
      };
    }

    computed = foldRevision(computed, revision, digest);
  }

  if (computed === storedReceipt) return null;

  /**
   * EVERY LINK AGREED, so the difference is in the final fold rather than in any answer -- which happens when the
   * stored `Hₙ` itself is wrong, or when the chain stores no links at all and so cannot be walked.
   *
   * Naming the LAST question would be a guess, and the message says so rather than implying the answer is at
   * fault.
   */
  return {
    questionId: null,
    got: computed,
    expected: storedReceipt,
    because:
      'every stored link agrees, so the difference is in the final fold rather than in any answer',
  };
};

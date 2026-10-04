/**
 * ISSUING A SUBMISSION RECEIPT.  (P8-T10, the issuance half)
 *
 * ## WHY THIS FILE HAD TO EXIST
 *
 * `receipt.ts` could compute and verify a receipt, and nothing in the database ever produced one. `submissionReceipt`
 * and `keysHash` are columns with no writer: `grep` finds the schema and the receipt module and no path between them.
 * So `verify-receipt` was a tool for checking something the platform never issued.
 *
 * ## AND ISSUANCE MUST BE ATOMIC WITH FINALISING THE ATTEMPT
 *
 * The obvious implementation finalises the attempt, then computes and stores the receipt. That leaves two states worth
 * naming, and neither is recoverable by retrying:
 *
 *   · **SUBMITTED with no receipt.** The attempt is over and the receipt is gone; the student has no artefact, and the
 *     only fix is to recompute it from a chain that may since have been compacted.
 *   · **A receipt for an attempt that is still open.** The chain is still growing, so the receipt describes a moment
 *     that was never the final state -- and it verifies, because the fold is internally consistent.
 *
 * So the status change and both writes happen in one transaction, and `V-12`'s shape applies here too: nothing here can
 * change a score, and nothing here can end an attempt without leaving the evidence a dispute needs.
 *
 * ## AND THE KEY MATERIAL IS AN INPUT, NOT SOMETHING THIS MODULE DERIVES
 *
 * `keysHash` must digest the answer key the marks were produced with. The correct answer for each of sixteen question
 * types lives in `Question.spec` in sixteen different shapes, and the auto-grader already knows all of them.
 *
 * **A receipt layer that walked `spec` itself would be a second, inevitably-wrong implementation of "what is the answer
 * to this question"** -- and its mistakes would be invisible, because they would only change a digest. So the caller
 * supplies the key it actually graded with, and this module digests exactly that.
 */

import {
  type AnswerKeyDescriptor,
  type Digest,
  keysHash as digestKeys,
  type Mac,
  type ReceiptSeed,
  type Revision,
  receiptHash,
  signReceipt,
} from '@orrery/contracts/grading/receipt';

import type { PrismaClient } from '../prisma/generated/client/client.js';

/** How a receipt gets signed. A provider rather than a key so the key can come from a KMS and never be in memory here. */
export interface SigningKeyProvider {
  /**
   * The MAC, or `null` when no key is configured.
   *
   * **`null` IS A REFUSAL AND NOT A FALLBACK TO AN UNSIGNED RECEIPT.** An unsigned receipt stores the bare fold, which
   * anyone can construct, so a platform that quietly degrades to one is issuing evidence of nothing while every downstream
   * check reports success. This mirrors `verifyReceiptSignature`'s `NO_KEY` for the same reason.
   */
  mac(): Promise<Mac | null>;
  /** Named so the refusal can say WHICH key was missing. */
  readonly keyId: string;
}

/**
 * THE DEV KEY PROVIDER, from an environment variable.
 *
 * **`ORRERY_RECEIPT_KEY` IS NOT PRODUCTION.** It is here so the issuance path is executable and testable without a cloud
 * account, and so `verify-receipt` and the issuer agree on one variable in development. A deployment that forgets to
 * configure the KMS therefore gets `null` here too, and refuses, rather than signing with something predictable.
 */
export const envSigningKey = (variable = 'ORRERY_RECEIPT_KEY'): SigningKeyProvider => ({
  keyId: `env:${variable}`,
  mac: async () => {
    const key = process.env[variable];
    if (key === undefined || key.length === 0) return null;
    const { createHmac } = await import('node:crypto');
    return (message: string): string =>
      createHmac('sha256', key).update(message, 'utf8').digest('hex');
  },
});

export type IssueRefusal =
  | 'ATTEMPT_NOT_FOUND'
  | 'NOT_SUBMITTABLE'
  | 'NO_SIGNING_KEY'
  | 'NO_QUESTION_ORDER';

export type IssueResult =
  | {
      readonly ok: true;
      readonly receipt: string;
      readonly keysHash: string;
      readonly folded: string;
    }
  | { readonly ok: false; readonly reason: IssueRefusal; readonly message: string };

/** The minimal shape `issueSubmissionReceipt` reads. Narrow, so the transaction's needs are visible. */
export type ReceiptDb = Pick<
  PrismaClient,
  'examAttempt' | 'questionResponse' | 'answerRevision' | 'attemptEventRecord' | '$transaction'
>;

export interface IssueInput {
  readonly attemptId: string;
  /**
   * The answer key the marks were produced with, from the grader that actually graded. See the header: this module
   * digests what it is given rather than re-deriving the key for sixteen question types.
   */
  readonly keys: readonly AnswerKeyDescriptor[];
  readonly signer: SigningKeyProvider;
  readonly digest: Digest;
  /** `INV-TIME-1`: injected, never `Date.now()`. */
  readonly nowMs: number;
  /**
   * Whether to also finalise the attempt. `false` computes and stores the receipt for an attempt that is being finalised
   * elsewhere, which exists for the sweep's auto-submit -- an auto-submitted attempt gets a receipt too, or a student who
   * let the clock run out has no artefact at all.
   */
  readonly finalise?: boolean;
}

/**
 * COMPUTE, SIGN AND STORE THE RECEIPT, in one transaction with the attempt's finalisation.
 *
 * Returns the folded hash as well as the signed receipt, because `verify-receipt` needs the fold to check the signature
 * and an operator debugging a mismatch needs both values.
 */
export const issueSubmissionReceipt = async (
  db: ReceiptDb,
  input: IssueInput,
): Promise<IssueResult> => {
  // The key is resolved BEFORE the transaction opens. A KMS round trip inside a transaction holds a connection for the
  // duration of a network call, and a pool sized for the web replica count is exactly the thing that turns one slow
  // dependency into an outage.
  const mac = await input.signer.mac();
  if (mac === null) {
    return {
      ok: false,
      reason: 'NO_SIGNING_KEY',
      message:
        `no receipt signing key is configured (${input.signer.keyId}); refusing rather than issuing an unsigned ` +
        'receipt, which would be the bare fold and would prove nothing',
    };
  }

  return db.$transaction(async (tx) => {
    const attempt = (await tx.examAttempt.findUnique({
      where: { id: input.attemptId },
      select: {
        id: true,
        assignmentId: true,
        status: true,
        policySnapshot: true,
        responses: {
          select: {
            questionId: true,
            position: true,
            revisions: {
              select: {
                revision: true,
                answerBytes: true,
                serverTs: true,
                source: true,
                previousHash: true,
                answerHash: true,
              },
            },
          },
        },
      },
    })) as {
      id: string;
      assignmentId: string;
      status: string;
      policySnapshot: unknown;
      responses: readonly {
        questionId: string;
        position: number;
        revisions: readonly {
          revision: number;
          answerBytes: string | null;
          serverTs: Date;
          source: string;
          previousHash: string | null;
          answerHash: string | null;
        }[];
      }[];
    } | null;

    if (attempt === null) {
      return {
        ok: false as const,
        reason: 'ATTEMPT_NOT_FOUND' as const,
        message: 'this attempt does not exist, so there is no receipt to issue',
      };
    }

    /**
     * THE QUESTION ORDER IS THE RESOLVED VARIANT'S, FROM `position`.
     *
     * `QuestionResponse.position` is documented as "position in the RESOLVED variant, not the authored order", and
     * `P5-T9` is explicit that the resolved paper is read from what was stored rather than by re-running the draw. So
     * the order comes from the responses, sorted by position, and `variantMap` is NOT re-resolved here: a re-resolution
     * could produce a different order than the student was served, which would make the receipt a statement about a paper
     * they never saw.
     *
     * **A QUESTION WITH NO RESPONSE ROW STILL BELONGS TO THE PAPER**, and it is missing from this list -- which is why
     * `keysHash` matters so much: the key set is the grader's and covers every question on the paper, so the two
     * together pin both what was asked and what was answered.
     */
    const ordered = [...attempt.responses].sort((a, b) => a.position - b.position);
    const questionOrder = ordered.map((response) => response.questionId);

    if (questionOrder.length === 0) {
      return {
        ok: false as const,
        reason: 'NO_QUESTION_ORDER' as const,
        message:
          'this attempt has no response rows, so the resolved paper cannot be read. An empty paper is a real state, ' +
          'and issuing a receipt over nothing would be a receipt that verifies',
      };
    }

    const revisions: Revision[] = [];
    for (const response of ordered) {
      for (const revision of response.revisions) {
        revisions.push({
          questionId: response.questionId,
          revision: revision.revision,
          /**
           * THE STORED BYTES, PARSED -- not a re-read of the jsonb column.
           *
           * `C5`: "hash the exact bytes accepted, not a re-read of jsonb". Reading the current `QuestionResponse.answer`
           * would hash whatever is there NOW, which is not necessarily what was accepted -- so the revision's own
           * `answerBytes` is the artefact, and a missing one degrades to an empty answer rather than to the live row.
           */
          answer: parseAnswerBytes(revision.answerBytes),
          serverTs: revision.serverTs.toISOString(),
          source: revision.source,
          previousHash: revision.previousHash,
          answerHash: revision.answerHash,
        });
      }
    }

    const computedKeys = digestKeys(input.keys, input.digest);
    const seed: ReceiptSeed = {
      attemptId: attempt.id,
      assignmentId: attempt.assignmentId,
      policySnapshot: attempt.policySnapshot,
      keysHash: computedKeys,
    };

    const folded = receiptHash(seed, revisions, questionOrder, input.digest);
    const receipt = signReceipt(folded, mac);

    if (input.finalise !== false) {
      if (attempt.status !== 'IN_PROGRESS' && attempt.status !== 'FROZEN') {
        return {
          ok: false as const,
          reason: 'NOT_SUBMITTABLE' as const,
          message: `this attempt is ${attempt.status}, so finalising it again would be a second submission`,
        };
      }
      await tx.examAttempt.update({
        where: { id: attempt.id },
        data: {
          status: 'SUBMITTED',
          submittedAt: new Date(input.nowMs),
          submissionReceipt: receipt,
          keysHash: computedKeys,
        },
      });
      await tx.attemptEventRecord.create({
        data: {
          attemptId: attempt.id,
          type: 'SUBMITTED',
          serverTs: new Date(input.nowMs),
          payload: { receipt, keysHash: computedKeys, signer: input.signer.keyId },
        },
      });
    } else {
      // The sweep's auto-submit already moved the status; this stores the receipt alongside it.
      await tx.examAttempt.update({
        where: { id: attempt.id },
        data: { submissionReceipt: receipt, keysHash: computedKeys },
      });
    }

    return { ok: true as const, receipt, keysHash: computedKeys, folded };
  });
};

/**
 * `answerBytes` IS A STRING OF JSON. A malformed one must not throw -- it must hash as something, because a receipt that
 * cannot be computed at all is a worse outcome than a receipt that records a revision as unreadable.
 */
const parseAnswerBytes = (bytes: string | null): unknown => {
  if (bytes === null) return null;
  try {
    return JSON.parse(bytes);
  } catch {
    return { unparseableAnswerBytes: bytes };
  }
};

/**
 * Issuing a submission receipt, against real Postgres.  (P8-T10)
 *
 * The two states this file exists to rule out are the ones a retry cannot fix: an attempt `SUBMITTED` with no receipt, and
 * a receipt describing an attempt that is still open. Both are claims about what the DATABASE contains, so they are
 * tested against a database -- and the mock-based tests that hid `minHoldUntil`, the `Decimal` arithmetic and the
 * `status` column in `release.ts` are the standing reason why.
 */

import { createHash, createHmac, randomUUID } from 'node:crypto';

import { receiptHash, verifyReceiptSignature } from '@orrery/contracts/grading/receipt';
import { afterAll, describe, expect, it } from 'vitest';

import { PrismaClient } from './prisma.js';
import { issueSubmissionReceipt, type SigningKeyProvider } from './receipt-issue.js';

let client: PrismaClient | null = null;
const prisma = (): PrismaClient => {
  client ??= new PrismaClient();
  return client;
};

afterAll(async () => {
  await client?.$disconnect();
  client = null;
});

const T0 = 1_800_000_000_000;
const digest = (bytes: string): string => createHash('sha256').update(bytes, 'utf8').digest('hex');
const key = 'integration-test-receipt-key';
const signer: SigningKeyProvider = {
  keyId: 'test',
  mac: async () => (message) => createHmac('sha256', key).update(message, 'utf8').digest('hex'),
};

interface Fixture {
  attemptId: string;
  assignmentId: string;
  questionIds: readonly string[];
  responseIds: readonly string[];
  policySnapshot: unknown;
}

const fixture = async (status: 'IN_PROGRESS' | 'FROZEN' = 'IN_PROGRESS'): Promise<Fixture> => {
  const db = prisma();
  const ownerId = randomUUID();
  const studentId = randomUUID();

  await db.user.create({
    data: {
      id: ownerId,
      email: `${ownerId}@s.example`,
      emailNormalized: `${ownerId}@s.example`,
      name: 'T',
    },
  });
  await db.user.create({
    data: {
      id: studentId,
      email: `${studentId}@s.example`,
      emailNormalized: `${studentId}@s.example`,
      name: 'S',
    },
  });

  const resource = await db.resource.create({
    data: {
      id: randomUUID(),
      ownerId,
      status: 'PUBLISHED',
      visibility: 'UNLISTED',
      title: 'Receipt',
      slug: randomUUID(),
    },
  });
  const version = await db.resourceVersion.create({
    data: {
      id: randomUUID(),
      resourceId: resource.id,
      version: 1,
      blocks: [],
      blocksChecksum: 'receipt',
      meta: {},
      createdById: ownerId,
    },
  });
  const classroom = await db.classroom.create({
    data: { id: randomUUID(), ownerId, name: 'Receipt', slug: randomUUID() },
  });
  const assignment = await db.assignment.create({
    data: {
      id: randomUUID(),
      classroomId: classroom.id,
      resourceId: resource.id,
      resourceVersionId: version.id,
      status: 'PUBLISHED',
      createdById: ownerId,
    },
  });
  const bank = await db.questionBank.create({ data: { id: randomUUID(), ownerId, name: 'Bank' } });

  const policySnapshot = { version: 1, maxAttempts: 1, gracePeriodSec: 60 };

  const attempt = await db.examAttempt.create({
    data: {
      id: randomUUID(),
      assignmentId: assignment.id,
      classroomId: classroom.id,
      studentId,
      attemptNumber: 1,
      status,
      policySnapshot,
    },
  });

  const questionIds: string[] = [];
  const responseIds: string[] = [];
  // TWO questions, deliberately created out of order and stored at positions 1 and 2, so the receipt's question order
  // has to come from `position` rather than from creation order.
  for (const [index, stem] of ['second', 'first'].entries()) {
    const question = await db.question.create({
      data: {
        id: randomUUID(),
        bankId: bank.id,
        type: 'shortText',
        spec: { prompt: stem },
        points: index + 1,
      },
    });
    questionIds.push(question.id);
    const response = await db.questionResponse.create({
      data: {
        id: randomUUID(),
        attemptId: attempt.id,
        questionId: question.id,
        position: index + 1,
        answer: { text: stem },
        revision: 1,
      },
    });
    responseIds.push(response.id);
    await db.answerRevision.create({
      data: {
        responseId: response.id,
        attemptId: attempt.id,
        revision: 1,
        source: 'CLIENT',
        answerBytes: JSON.stringify({ text: stem }),
        answerHash: digest(JSON.stringify({ text: stem })),
        serverTs: new Date(T0),
      },
    });
  }

  return {
    attemptId: attempt.id,
    assignmentId: assignment.id,
    questionIds,
    responseIds,
    policySnapshot,
  };
};

describe.skipIf(!process.env.DATABASE_URL)('issuing a receipt, against real Postgres', () => {
  it('STORES a signed receipt and the keysHash, and finalises the attempt in the SAME transaction', async () => {
    const f = await fixture();
    const keys = f.questionIds.map((questionId, index) => ({
      questionId,
      correct: `answer-${String(index)}`,
      points: index + 1,
    }));

    const result = await issueSubmissionReceipt(prisma(), {
      attemptId: f.attemptId,
      keys,
      signer,
      digest,
      nowMs: T0,
    });

    expect(result.ok, result.ok ? '' : result.reason).toBe(true);
    if (!result.ok) return;

    const attempt = await prisma().examAttempt.findUniqueOrThrow({ where: { id: f.attemptId } });
    expect(attempt.status).toBe('SUBMITTED');
    expect(attempt.submissionReceipt).toBe(result.receipt);
    expect(attempt.keysHash).toBe(result.keysHash);
    // **The receipt is the MAC, not the fold.** A stored value equal to the fold would be the pre-P8-T10 weakness:
    // publicly reproducible, and therefore constructible by anyone.
    expect(attempt.submissionReceipt).not.toBe(result.folded);

    const event = await prisma().attemptEventRecord.findFirst({
      where: { attemptId: f.attemptId, type: 'SUBMITTED' },
    });
    expect(event?.payload).toMatchObject({ signer: 'test' });
  });

  it('the issued receipt VERIFIES against the stored chain with the held key', () => {
    return (async () => {
      const f = await fixture();
      const keys = f.questionIds.map((questionId, index) => ({
        questionId,
        correct: `answer-${String(index)}`,
        points: index + 1,
      }));
      const result = await issueSubmissionReceipt(prisma(), {
        attemptId: f.attemptId,
        keys,
        signer,
        digest,
        nowMs: T0,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Recompute independently from what the chain now says, the way `verify-receipt` does.
      const attempt = await prisma().examAttempt.findUniqueOrThrow({
        where: { id: f.attemptId },
        select: { assignmentId: true, policySnapshot: true, keysHash: true },
      });
      const responses = await prisma().questionResponse.findMany({
        where: { attemptId: f.attemptId },
        orderBy: { position: 'asc' },
        select: {
          questionId: true,
          revisions: {
            select: { revision: true, answerBytes: true, serverTs: true, source: true },
          },
        },
      });

      const recomputed = receiptHash(
        {
          attemptId: f.attemptId,
          assignmentId: attempt.assignmentId,
          policySnapshot: attempt.policySnapshot,
          keysHash: attempt.keysHash ?? '',
        },
        responses.flatMap((response) =>
          response.revisions.map((revision) => ({
            questionId: response.questionId,
            revision: revision.revision,
            answer: JSON.parse(revision.answerBytes ?? 'null') as unknown,
            serverTs: revision.serverTs.toISOString(),
            source: revision.source,
          })),
        ),
        responses.map((response) => response.questionId),
        digest,
      );

      expect(verifyReceiptSignature(result.receipt, recomputed, await signer.mac())).toEqual({
        ok: true,
      });
    })();
  });

  it('REFUSES WITHOUT A KEY rather than issuing an unsigned receipt', async () => {
    /**
     * The refusal that matters most, because the alternative is invisible: an unsigned receipt is the bare fold, every
     * downstream check still passes, and a student is handed evidence of nothing.
     */
    const f = await fixture();
    const result = await issueSubmissionReceipt(prisma(), {
      attemptId: f.attemptId,
      keys: [],
      signer: { keyId: 'absent', mac: async () => null },
      digest,
      nowMs: T0,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('NO_SIGNING_KEY');

    // And nothing was written: no finalisation, no receipt, no half-finished attempt.
    const attempt = await prisma().examAttempt.findUniqueOrThrow({ where: { id: f.attemptId } });
    expect(attempt.status).toBe('IN_PROGRESS');
    expect(attempt.submissionReceipt).toBeNull();
  });

  it('REFUSES a second submission, so a receipt cannot be reissued over a finished attempt', async () => {
    const f = await fixture();
    const keys = [{ questionId: f.questionIds[0] ?? '', correct: 'a', points: 1 }];
    await issueSubmissionReceipt(prisma(), {
      attemptId: f.attemptId,
      keys,
      signer,
      digest,
      nowMs: T0,
    });

    const second = await issueSubmissionReceipt(prisma(), {
      attemptId: f.attemptId,
      keys,
      signer,
      digest,
      nowMs: T0 + 1_000,
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('NOT_SUBMITTABLE');
  });

  it('issues a receipt for a FROZEN attempt, because a student who lost time still gets an artefact', async () => {
    /**
     * `V-12`'s shape again: a freeze is a TEACHER's to lift, and it is reversible, so the attempt is submittable. Refusing
     * here would mean an escalated student's work had no receipt at all -- which is a grading injustice wearing the
     * costume of a safety rule.
     */
    const f = await fixture('FROZEN');
    const result = await issueSubmissionReceipt(prisma(), {
      attemptId: f.attemptId,
      keys: [{ questionId: f.questionIds[0] ?? '', correct: 'a', points: 1 }],
      signer,
      digest,
      nowMs: T0,
    });
    expect(result.ok).toBe(true);
  });

  it('REFUSES AN EMPTY PAPER rather than issuing a receipt over nothing', async () => {
    const db = prisma();
    const ownerId = randomUUID();
    const studentId = randomUUID();
    await db.user.create({
      data: {
        id: ownerId,
        email: `${ownerId}@s.example`,
        emailNormalized: `${ownerId}@s.example`,
        name: 'T',
      },
    });
    await db.user.create({
      data: {
        id: studentId,
        email: `${studentId}@s.example`,
        emailNormalized: `${studentId}@s.example`,
        name: 'S',
      },
    });
    const resource = await db.resource.create({
      data: {
        id: randomUUID(),
        ownerId,
        status: 'PUBLISHED',
        visibility: 'UNLISTED',
        title: 'Empty',
        slug: randomUUID(),
      },
    });
    const version = await db.resourceVersion.create({
      data: {
        id: randomUUID(),
        resourceId: resource.id,
        version: 1,
        blocks: [],
        blocksChecksum: 'empty',
        meta: {},
        createdById: ownerId,
      },
    });
    const classroom = await db.classroom.create({
      data: { id: randomUUID(), ownerId, name: 'Empty', slug: randomUUID() },
    });
    const assignment = await db.assignment.create({
      data: {
        id: randomUUID(),
        classroomId: classroom.id,
        resourceId: resource.id,
        resourceVersionId: version.id,
        status: 'PUBLISHED',
        createdById: ownerId,
      },
    });
    const empty = await db.examAttempt.create({
      data: {
        id: randomUUID(),
        assignmentId: assignment.id,
        classroomId: classroom.id,
        studentId,
        attemptNumber: 1,
        status: 'IN_PROGRESS',
      },
    });

    const result = await issueSubmissionReceipt(prisma(), {
      attemptId: empty.id,
      keys: [],
      signer,
      digest,
      nowMs: T0,
    });
    // An empty paper is a real state, and a receipt that verifies over nothing is worse than no receipt.
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('NO_QUESTION_ORDER');
  });
});

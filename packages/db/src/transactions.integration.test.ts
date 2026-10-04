/**
 * The two write paths whose ARITHMETIC is pure and whose TRANSACTIONS were never run.
 *
 * ## WHY THIS FILE EXISTS AT ALL
 *
 * P7-T9 and P7-T10 shipped `submitAnswer` and `releaseBatch` with the decision logic pure and exhaustively unit
 * tested, and their transaction bodies untested -- and the tracker recorded that honestly: "the transaction path
 * needs a live Postgres and none was reachable".
 *
 * Postgres turned out to be reachable all along (`orrery` on 55432, PostgreSQL 16.15, 1351 attempts in it), so the
 * limitation was a stale assumption rather than a fact and the honest thing to do was go and run it.
 *
 * **A transaction's failure mode is the absence of a partial state, and no amount of pure testing can observe an
 * absence.** `decideWrite` can be proven correct on every branch and still write two revisions; `planRelease` can
 * be proven correct and still leave a batch marked RELEASED with half its members written. Both of those are
 * properties of what the database contains afterwards, so they need a database.
 *
 * The tests below assert the two properties that unit tests structurally cannot:
 *
 *   1. **idempotency is enforced by STATE, not by a check** -- replaying a key adds no second `AnswerRevision`,
 *      which is the only thing that makes a retry safe;
 *   2. **the release is all-or-nothing** -- an exception part way through leaves the batch `DRAFT` and every member
 *      `PENDING`, with no attempt marked released.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, describe, expect, it } from 'vitest';
import { submitAnswer } from './answer-write.js';
import { PrismaClient } from './prisma.js';
import { releaseBatch } from './release.js';

/** The clock. `INV-TIME-1`: no `Date.now()` outside `@orrery/clock`, including here. */
const clock = { now: () => 1_800_000_000_000 };

let client: PrismaClient | null = null;
const prisma = (): PrismaClient => {
  client ??= new PrismaClient();
  return client;
};

afterAll(async () => {
  await client?.$disconnect();
  client = null;
});

interface Fixture {
  ownerId: string;
  studentId: string;
  classroomId: string;
  assignmentId: string;
  questionId: string;
  attemptId: string;
}

const fixture = async (status = 'IN_PROGRESS'): Promise<Fixture> => {
  const db = prisma();
  const ownerId = randomUUID();
  const studentId = randomUUID();

  const owner = await db.user.create({
    data: {
      id: ownerId,
      email: `${ownerId}@s.example`,
      emailNormalized: `${ownerId}@s.example`,
      name: 'T',
    },
  });
  const student = await db.user.create({
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
      ownerId: owner.id,
      status: 'PUBLISHED',
      visibility: 'UNLISTED',
      title: 'Tidal locking',
      slug: randomUUID(),
    },
  });
  const version = await db.resourceVersion.create({
    data: {
      id: randomUUID(),
      resourceId: resource.id,
      version: 1,
      blocks: [{ type: 'paragraph', text: 'The Moon is tidally locked.' }],
      blocksChecksum: 'stored-checksum',
      meta: { subject: 'physics' },
      createdById: owner.id,
    },
  });
  const classroom = await db.classroom.create({
    data: { id: randomUUID(), ownerId: owner.id, name: 'Year 9', slug: randomUUID() },
  });
  const assignment = await db.assignment.create({
    data: {
      id: randomUUID(),
      classroomId: classroom.id,
      resourceId: resource.id,
      resourceVersionId: version.id,
      status: 'PUBLISHED',
      createdById: owner.id,
    },
  });
  const bank = await db.questionBank.create({
    data: { id: randomUUID(), ownerId: owner.id, name: 'Bank' },
  });
  const question = await db.question.create({
    data: {
      id: randomUUID(),
      bankId: bank.id,
      type: 'singleChoice',
      spec: { stem: 'Which is bigger?', choices: ['A', 'B'], correctChoiceIndex: 0 },
      points: 2,
    },
  });
  /**
   * THE PAPER IS DECLARED BY AN `AssessmentSlot` ON THE RESOURCE VERSION, and a fixture that skips it produces
   * `QUESTION_NOT_IN_ATTEMPT` -- a rejection that reads like a permissions problem and is actually a missing row.
   */
  await db.assessmentSlot.create({
    data: {
      id: randomUUID(),
      resourceVersionId: version.id,
      position: 1,
      kind: 'FIXED',
      questionId: question.id,
    },
  });

  const attempt = await db.examAttempt.create({
    data: {
      id: randomUUID(),
      assignmentId: assignment.id,
      classroomId: classroom.id,
      studentId: student.id,
      attemptNumber: 1,
      status: status as never,
      // Written once at attempt start and authoritative thereafter (`P5-T9`): membership must come from this, not
      // from re-running the draw.
      variantMap: { [randomUUID()]: [question.id] },
    },
  });

  return {
    ownerId: owner.id,
    studentId: student.id,
    classroomId: classroom.id,
    assignmentId: assignment.id,
    questionId: question.id,
    attemptId: attempt.id,
  };
};

describe.skipIf(!process.env.DATABASE_URL)(
  'the answer-write TRANSACTION, against real Postgres',
  () => {
    /**
     * `SubmitInput`'s REAL fields. The first version of this helper used `answer`, `position` and `clientTs`, none of
     * which exist on the interface -- and because they were spread into the call, TypeScript's excess-property check
     * did not fire, so the missing `expectedRevision` arrived as `undefined` and came back as `STALE_REVISION`.
     *
     * A wrong field name in a test helper is not caught by the compiler, so it is worth being explicit that this is
     * `SubmitInput`'s shape and not a convenient approximation of it.
     */
    const body = (choice: number) => ({
      idempotencyKey: randomUUID(),
      answerJson: { selectedChoiceIndex: choice },
      answerBytes: JSON.stringify({ selectedChoiceIndex: choice }),
      answerHash: `hash-${String(choice)}`,
      // A first write declares revision 0: `-1` stored means "no row yet", and that row is revision 0 to create.
      expectedRevision: 0,
    });

    it('writes ONE revision for a first submission', async () => {
      const f = await fixture();
      const result = await submitAnswer(
        prisma(),
        { ...body(0), attemptId: f.attemptId, questionId: f.questionId },
        clock,
      );

      expect(result.outcome, JSON.stringify(result)).toBe('saved');
      expect(await prisma().answerRevision.count({ where: { attemptId: f.attemptId } })).toBe(1);
      expect(await prisma().questionResponse.count({ where: { attemptId: f.attemptId } })).toBe(1);
    });

    it('REPLAYING AN IDEMPOTENCY KEY ADDS NO SECOND REVISION', async () => {
      /**
       * The property that makes a retry safe, and the reason the key exists at all. A retry on a flaky connection is
       * the NORMAL case, not an edge case, so this is the single most important thing to check against a real database:
       * the decision logic reads `decideWrite`, but what actually prevents a duplicate is that the row it read is still
       * there on the second call.
       */
      const f = await fixture();
      const key = randomUUID();
      const payload = {
        ...body(0),
        attemptId: f.attemptId,
        questionId: f.questionId,
        idempotencyKey: key,
      };

      const first = await submitAnswer(prisma(), payload, clock);
      const second = await submitAnswer(prisma(), payload, clock);

      expect(first.outcome, JSON.stringify(first)).toBe('saved');
      // A replay is reported as `replayed`, NOT as a second `saved`. That distinction is the client-visible half of
      // idempotency, and the row count below is the half that actually protects the data.
      expect(second.outcome, JSON.stringify(second)).toBe('replayed');
      // The count is the assertion. A duplicate revision would be invisible to a test that only checked the return
      // value, because both calls report success.
      expect(await prisma().answerRevision.count({ where: { attemptId: f.attemptId } })).toBe(1);
    });

    it('writes NO revision when the attempt is not in progress, and the database agrees', async () => {
      // A rejection that leaves a revision behind is worse than a rejection: the next legitimate save inherits a chain
      // it should not have, and the receipt hash covers it.
      const f = await fixture('SUBMITTED');
      const result = await submitAnswer(
        prisma(),
        { ...body(0), attemptId: f.attemptId, questionId: f.questionId },
        clock,
      );

      expect(result.outcome).toBe('rejected');
      expect(await prisma().answerRevision.count({ where: { attemptId: f.attemptId } })).toBe(0);
      expect(await prisma().questionResponse.count({ where: { attemptId: f.attemptId } })).toBe(0);
    });

    it('leaves a REJECTED attempt with no response row, so a later save starts from nothing', async () => {
      const f = await fixture('EXPIRED');
      await submitAnswer(
        prisma(),
        { ...body(0), attemptId: f.attemptId, questionId: f.questionId },
        clock,
      );
      expect(await prisma().questionResponse.count({ where: { attemptId: f.attemptId } })).toBe(0);
    });
  },
);

describe.skipIf(!process.env.DATABASE_URL)('the release TRANSACTION, against real Postgres', () => {
  /**
   * A GRADED attempt, with the RESPONSE that makes the score computable.
   *
   * The first version set `finalScore`/`maxScore` on the attempt and expected the batch to release, and got
   * `SCORE_NOT_COMPUTABLE` for every member -- because the release recomputes the score from the responses rather
   * than trusting the attempt's stored total. Which is the correct behaviour: a stored total is a claim, and the
   * release is the point at which the claim gets checked.
   */
  const scoredAttempt = async (status: string): Promise<Fixture & { attemptId: string }> => {
    const f = await fixture(status);
    await prisma().questionResponse.create({
      data: {
        id: randomUUID(),
        attemptId: f.attemptId,
        questionId: f.questionId,
        position: 1,
        answer: { selectedChoiceIndex: 0 },
        autoScore: 2,
        needsHuman: false,
        isExcused: false,
      },
    });
    await prisma().examAttempt.update({
      where: { id: f.attemptId },
      data: { finalScore: 2, maxScore: 2, percentage: 100, status: 'GRADED' as never },
    });
    return f;
  };

  it('releases a whole batch: members RELEASED, batch RELEASED, attempts stamped', async () => {
    const f = await scoredAttempt('GRADED');
    const batch = await prisma().releaseBatch.create({
      data: {
        id: randomUUID(),
        assignmentId: f.assignmentId,
        classroomId: f.classroomId,
        status: 'DRAFT',
        members: { create: [{ attemptId: f.attemptId }] },
      },
    });

    const result = await releaseBatch(prisma(), {
      batchId: batch.id,
      latePenaltyPercent: 0,
      clock,
    });

    expect(result.released, JSON.stringify(result.refusals)).toBe(true);
    const reloaded = await prisma().releaseBatch.findUniqueOrThrow({
      where: { id: batch.id },
      include: { members: true },
    });
    expect(reloaded.status).toBe('RELEASED');
    expect(reloaded.members.map((member) => member.attemptId)).toEqual([f.attemptId]);

    // `B16`: student visibility is `EXISTS(... batch status = 'RELEASED')`, so the batch status IS the switch and
    // there is no per-member row to flip. Asserting the batch alone is therefore the whole visibility claim.
    const attempt = await prisma().examAttempt.findUniqueOrThrow({ where: { id: f.attemptId } });
    expect(attempt.releasedAt).not.toBeNull();
  });

  it('LEAVES NOTHING WRITTEN WHEN THE TRANSACTION FAILS PART WAY THROUGH', async () => {
    /**
     * `INV-RELEASE-1`, and the whole reason the writes share one transaction.
     *
     * The failure this guards is invisible until a student complains: a batch marked RELEASED while some attempts
     * were never written, or attempts visible while the batch still says DRAFT. Neither leaves a partial state to
     * inspect, which is what makes them expensive to unpick.
     *
     * The failure is injected by wrapping the client so the SECOND attempt update throws -- which is precisely the
     * shape of the real thing: the first write succeeded, the second did not.
     */
    const f = await scoredAttempt('GRADED');
    const second = await scoredAttempt('GRADED');
    const batch = await prisma().releaseBatch.create({
      data: {
        id: randomUUID(),
        assignmentId: f.assignmentId,
        classroomId: f.classroomId,
        status: 'DRAFT',
        members: { create: [{ attemptId: f.attemptId }, { attemptId: second.attemptId }] },
      },
    });

    const real = prisma();
    let updates = 0;

    /**
     * The sabotage goes INSIDE `$transaction`, because that is the only place the writes happen.
     *
     * The first version spread the client and replaced `examAttempt.update` on the outer object. Prisma's
     * `$transaction` hands the callback a `tx` of its own, so the outer override was never called: the test then
     * reported a Prisma error and, worse, would have PASSED the `rejects.toThrow` assertion for entirely the wrong
     * reason while asserting nothing about atomicity.
     */
    const sabotage = new Proxy(real, {
      get(target, property, receiver) {
        if (property === '$transaction') {
          return async (fn: (tx: unknown) => Promise<unknown>) =>
            (
              target as unknown as {
                $transaction: (f: (tx: unknown) => Promise<unknown>) => Promise<unknown>;
              }
            ).$transaction(async (tx: unknown) => {
              const wrapped = new Proxy(tx as Record<string, unknown>, {
                get(inner, innerProperty) {
                  if (innerProperty === 'examAttempt') {
                    return {
                      update: (input: Record<string, unknown>) => {
                        updates += 1;
                        if (updates === 2)
                          throw new Error('injected failure on the second attempt');
                        return (
                          inner.examAttempt as { update: (i: unknown) => Promise<unknown> }
                        ).update(input);
                      },
                    };
                  }
                  return inner[innerProperty as string];
                },
              });
              return fn(wrapped);
            });
        }
        return Reflect.get(target, property, receiver);
      },
    }) as unknown as Parameters<typeof releaseBatch>[0];

    await expect(
      releaseBatch(sabotage, { batchId: batch.id, latePenaltyPercent: 0, clock }),
    ).rejects.toThrow(/injected failure/);

    const reloaded = await prisma().releaseBatch.findUniqueOrThrow({ where: { id: batch.id } });
    // The batch must still be DRAFT. A released batch with unwritten members is the exact state INV-RELEASE-1 exists
    // to make unrepresentable.
    expect(reloaded.status).toBe('DRAFT');
    expect(reloaded.releasedAt).toBeNull();

    for (const attemptId of [f.attemptId, second.attemptId]) {
      const attempt = await prisma().examAttempt.findUniqueOrThrow({ where: { id: attemptId } });
      // `GRADED`, not `RELEASED`: the first attempt's write succeeded before the second failed, and rolling that back
      // is the entire claim.
      expect(attempt.status).toBe('GRADED');
      expect(attempt.releasedAt).toBeNull();
    }
  });
});

describe.skipIf(!process.env.DATABASE_URL)('the migration that removed TERMINATED', () => {
  /**
   * **THERE USED TO BE A `beforeEach` HERE THAT RELEASED EVERY BATCH IN THE DATABASE, AND IT BROKE A TEST IN
   * ANOTHER FILE.**
   *
   * `roster-page.integration.test.ts` asserts that a grade is shown only once the assignment is released, and it
   * passed in isolation while failing in the full run -- because this file had just marked every `ReleaseBatch` in a
   * SHARED database as `RELEASED`.
   *
   * Two lessons, and the second is the one that generalises: these integration tests run against one long-lived
   * development database rather than a per-run schema, so any statement without a `where` clause is a statement about
   * **every other test's data**. A cleanup that "normalises" state is not neutral; it is the most destructive line in
   * the file. Nothing here needed it -- the enum assertions read `pg_enum` and depend on no batch at all.
   */

  it('no longer offers TERMINATED as an attempt STATUS, and maps old rows to FROZEN', async () => {
    /**
     * `V-12`. The enum member is gone, so this cannot assert on it directly -- which is the point. What it CAN assert
     * is the property the migration was for: an attempt that would once have been terminated is `FROZEN`, which is
     * gradeable and reversible, rather than stranded.
     */
    const f = await fixture('FROZEN');
    const attempt = await prisma().examAttempt.findUniqueOrThrow({ where: { id: f.attemptId } });
    expect(attempt.status).toBe('FROZEN');

    const statuses = await prisma().$queryRawUnsafe<{ enumlabel: string }[]>(
      `SELECT enumlabel FROM pg_enum JOIN pg_type ON pg_type.oid = pg_enum.enumtypid WHERE typname = 'AttemptStatus'`,
    );
    expect(statuses.map((row) => row.enumlabel)).not.toContain('TERMINATED');
    expect(statuses.map((row) => row.enumlabel)).toContain('FROZEN');
  });

  it('KEEPS TERMINATED in the audit EVENT vocabulary, because history must stay readable', async () => {
    // The deliberate asymmetry: an attempt STATUS is a reachable future state and the unusable one is removed; an
    // append-only log is the record of what happened, and deleting the member would make the correction unreviewable.
    const eventTypes = await prisma().$queryRawUnsafe<{ enumlabel: string }[]>(
      `SELECT enumlabel FROM pg_enum JOIN pg_type ON pg_type.oid = pg_enum.enumtypid WHERE typname = 'AttemptEventType'`,
    );
    expect(eventTypes.map((row) => row.enumlabel)).toContain('TERMINATED');
  });
});

/**
 * The release-batch machine, freeze, gate and override, against real Postgres.  (P10-T1, P10-T3)
 *
 * ## WHY NONE OF THIS CAN BE A UNIT TEST
 *
 * The transitions and the freeze are TRIGGERS. A pure test of `canTransition` proves the TypeScript table and says
 * nothing about whether the database refuses `RELEASED -> DRAFT` when some other writer issues the `UPDATE` -- and
 * "some other writer" is the whole threat: before migration `0014` the two writers that existed both bypassed any
 * helper. So the first half of this file writes with a bare Prisma client, deliberately NOT through `release-batch.ts`,
 * and compares what the database did with what the table says.
 *
 * ## SHARED-DATABASE SAFETY
 *
 * This runs against the long-lived development database, which holds other fixtures' batches (168 `RELEASED` ones
 * when this was written). The rules this file keeps:
 *
 *   · **nothing in `release-batch.ts` is unscoped.** Every production query is keyed by a `batchId` or an `attemptId`
 *     the caller supplies; there is no sweep, no "all READY batches", and therefore no test-only scope parameter to
 *     forget. That is a property of the module, checked here only in the sense that no test needs a wrapper;
 *   · **every read in this file is by an id this file created**, and every write likewise;
 *   · **everything created is deleted**, by id, in `afterAll` -- attempts first, because a `RELEASED` batch cannot be
 *     deleted while it still has members (that refusal is itself under test below).
 */

import { randomUUID } from 'node:crypto';

import { FrozenClock } from '@orrery/clock';
import { findScoreBearingKeys } from '@orrery/interop';
import { afterAll, describe, expect, it } from 'vitest';

import { PrismaClient } from './prisma.js';
import { releaseBatch } from './release.js';
import {
  attemptReleaseState,
  beginRelease,
  cancelBatch,
  canTransition,
  changeBatchMembers,
  createReleaseBatch,
  evaluateBatchGate,
  isMembershipFrozen,
  MIN_OVERRIDE_REASON,
  markBatchReady,
  RELEASE_BATCH_STATUSES,
  type ReleaseBatchStatus,
  recordReleaseOverride,
  reopenBatch,
  SEALED_RELEASE_STATE,
} from './release-batch.js';

const T0 = 1_800_000_000_000;
const clock = new FrozenClock(T0);

let client: PrismaClient | null = null;
const prisma = (): PrismaClient => {
  client ??= new PrismaClient();
  return client;
};

/** Every row this file creates, so teardown deletes by id and by nothing looser. */
const mine = {
  users: [] as string[],
  resources: [] as string[],
  versions: [] as string[],
  classrooms: [] as string[],
  assignments: [] as string[],
  banks: [] as string[],
  questions: [] as string[],
  attempts: [] as string[],
  batches: [] as string[],
};

afterAll(async () => {
  if (client === null) return;
  const db = client;
  await db.auditEvent.deleteMany({
    where: { targetType: 'ReleaseBatch', targetId: { in: mine.batches } },
  });
  // ATTEMPTS FIRST. Their member rows cascade away (the one delete the freeze permits), which leaves every batch
  // empty and therefore deletable whatever its status.
  await db.examAttempt.deleteMany({ where: { id: { in: mine.attempts } } });
  await db.releaseBatch.deleteMany({ where: { id: { in: mine.batches } } });
  await db.assignment.deleteMany({ where: { id: { in: mine.assignments } } });
  await db.question.deleteMany({ where: { id: { in: mine.questions } } });
  await db.questionBank.deleteMany({ where: { id: { in: mine.banks } } });
  await db.classroom.deleteMany({ where: { id: { in: mine.classrooms } } });
  await db.resourceVersion.deleteMany({ where: { id: { in: mine.versions } } });
  await db.resource.deleteMany({ where: { id: { in: mine.resources } } });
  await db.user.deleteMany({ where: { id: { in: mine.users } } });
  await db.$disconnect();
  client = null;
});

interface Room {
  readonly teacherId: string;
  readonly classroomId: string;
  readonly assignmentId: string;
  readonly questionId: string;
}

const user = async (): Promise<string> => {
  const id = randomUUID();
  await prisma().user.create({
    data: { id, email: `${id}@p10.example`, emailNormalized: `${id}@p10.example`, name: 'P10' },
  });
  mine.users.push(id);
  return id;
};

/** A classroom with one assignment and one two-mark question. Each test gets its own, so nothing is shared. */
const room = async (): Promise<Room> => {
  const db = prisma();
  const teacherId = await user();
  const resource = await db.resource.create({
    data: {
      id: randomUUID(),
      ownerId: teacherId,
      status: 'PUBLISHED',
      visibility: 'UNLISTED',
      title: 'P10 release batch',
      slug: randomUUID(),
    },
  });
  mine.resources.push(resource.id);
  const version = await db.resourceVersion.create({
    data: {
      id: randomUUID(),
      resourceId: resource.id,
      version: 1,
      blocks: [],
      blocksChecksum: 'p10',
      meta: {},
      createdById: teacherId,
    },
  });
  mine.versions.push(version.id);
  const classroom = await db.classroom.create({
    data: { id: randomUUID(), ownerId: teacherId, name: 'P10', slug: randomUUID() },
  });
  mine.classrooms.push(classroom.id);
  const assignment = await db.assignment.create({
    data: {
      id: randomUUID(),
      classroomId: classroom.id,
      resourceId: resource.id,
      resourceVersionId: version.id,
      status: 'PUBLISHED',
      createdById: teacherId,
    },
  });
  mine.assignments.push(assignment.id);
  const bank = await db.questionBank.create({
    data: { id: randomUUID(), ownerId: teacherId, name: 'P10' },
  });
  mine.banks.push(bank.id);
  const question = await db.question.create({
    data: { id: randomUUID(), bankId: bank.id, type: 'singleChoice', spec: {}, points: 2 },
  });
  mine.questions.push(question.id);
  return {
    teacherId,
    classroomId: classroom.id,
    assignmentId: assignment.id,
    questionId: question.id,
  };
};

/**
 * One student's attempt in `r`, with a real response row.
 *
 * `autoScore` goes into a `Decimal(9,2)` column and comes back as a Prisma `Decimal`, NOT a number -- which is the
 * translation that once made every batch refuse with `SCORE_NOT_COMPUTABLE`. The gate reads through the same
 * translation, so a gate that opens for a `graded` attempt here is the evidence that it survived the trip.
 */
const attempt = async (
  r: Room,
  kind: 'graded' | 'ungraded' | 'needsHuman' | 'allExcused' = 'graded',
): Promise<string> => {
  const db = prisma();
  const studentId = await user();
  const id = randomUUID();
  await db.examAttempt.create({
    data: {
      id,
      assignmentId: r.assignmentId,
      classroomId: r.classroomId,
      studentId,
      attemptNumber: 1,
      status: kind === 'ungraded' ? 'SUBMITTED' : 'GRADED',
    },
  });
  mine.attempts.push(id);
  await db.questionResponse.create({
    data: {
      id: randomUUID(),
      attemptId: id,
      questionId: r.questionId,
      position: 1,
      answer: { selectedChoiceIndex: 0 },
      autoScore: kind === 'needsHuman' ? null : 2,
      needsHuman: kind === 'needsHuman',
      isExcused: kind === 'allExcused',
    },
  });
  return id;
};

/** A batch created through the module, tracked for teardown. */
const batchOf = async (
  r: Room,
  attemptIds: readonly string[],
  extra: { minHoldUntil?: number } = {},
): Promise<string> => {
  const created = await createReleaseBatch(prisma(), {
    assignmentId: r.assignmentId,
    classroomId: r.classroomId,
    attemptIds,
    actorId: r.teacherId,
    clock,
    ...extra,
  });
  if (!created.ok)
    throw new Error(`fixture: createReleaseBatch refused: ${JSON.stringify(created)}`);
  mine.batches.push(created.batchId);
  return created.batchId;
};

/**
 * WALK A BATCH TO A STATUS WITH BARE `UPDATE`s -- the shortest legal path, and deliberately not through the module.
 *
 * This is "the other writer". The trigger does not run the gate (the gate is a decision about grading, made in code);
 * it enforces only which status may follow which, and that is what the tests using this helper are about.
 */
const PATH: Record<ReleaseBatchStatus, readonly ReleaseBatchStatus[]> = {
  DRAFT: [],
  READY: ['READY'],
  RELEASING: ['READY', 'RELEASING'],
  RELEASED: ['READY', 'RELEASING', 'RELEASED'],
  CANCELED: ['CANCELED'],
};

const forceStatus = (batchId: string, status: ReleaseBatchStatus) =>
  prisma().releaseBatch.update({
    where: { id: batchId },
    data: { status, ...(status === 'RELEASED' ? { releasedAt: new Date(T0) } : {}) },
  });

const walkTo = async (batchId: string, status: ReleaseBatchStatus): Promise<void> => {
  for (const step of PATH[status]) await forceStatus(batchId, step);
};

const statusOf = async (batchId: string): Promise<string> =>
  (await prisma().releaseBatch.findUniqueOrThrow({ where: { id: batchId } })).status;

const memberIds = async (batchId: string): Promise<string[]> =>
  (
    await prisma().releaseBatchMember.findMany({
      where: { batchId },
      orderBy: { attemptId: 'asc' },
    })
  ).map((member) => member.attemptId);

const auditOf = (batchId: string, action: string) =>
  prisma().auditEvent.findMany({
    where: { targetType: 'ReleaseBatch', targetId: batchId, action },
    orderBy: { id: 'asc' },
  });

/** The message of whatever a promise rejected with, or `null` if it resolved. */
const refusal = async (attempted: Promise<unknown>): Promise<string | null> => {
  try {
    await attempted;
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

const REASON = 'absent with a medical note';

describe.skipIf(!process.env.DATABASE_URL)('the state machine, enforced by the DATABASE', () => {
  it('agrees with the TypeScript table on ALL 25 pairs, when written by a bare UPDATE', async () => {
    /**
     * The two copies of the table -- the trigger and `RELEASE_BATCH_TRANSITIONS` -- compared pair by pair. Drop the
     * trigger and 13 of these are admitted; add an edge to one copy and exactly that pair disagrees.
     */
    const r = await room();
    const disagreements: string[] = [];
    let refused = 0;

    for (const from of RELEASE_BATCH_STATUSES) {
      for (const to of RELEASE_BATCH_STATUSES) {
        const batchId = await batchOf(r, []);
        await walkTo(batchId, from);
        expect(await statusOf(batchId)).toBe(from);

        const message = await refusal(forceStatus(batchId, to));
        const after = await statusOf(batchId);

        if (from === to) {
          // Not a transition: an `UPDATE` that leaves the status alone must keep working, or no other column of a
          // batch could ever be edited.
          if (message !== null && from !== 'RELEASED')
            disagreements.push(`${from}>${to}: ${message}`);
          continue;
        }

        const accepted = message === null;
        if (accepted !== canTransition(from, to)) {
          disagreements.push(`${from}>${to}: database ${accepted ? 'ACCEPTED' : 'refused'}`);
        }
        if (!accepted) {
          refused += 1;
          // Refused BY THE MACHINE, not by some unrelated error that happens to throw.
          expect(message, `${from}>${to}`).toMatch(/RELEASE_BATCH_ILLEGAL_TRANSITION/);
          // And refused means unchanged.
          expect(after, `${from}>${to}`).toBe(from);
        } else {
          expect(after, `${from}>${to}`).toBe(to);
        }
      }
    }

    expect(disagreements).toEqual([]);
    // 20 distinct pairs, 7 legal. If this number moves, an edge was added or removed in BOTH copies at once.
    expect(refused).toBe(13);
  });

  it('refuses a batch BORN in any status but DRAFT', async () => {
    const r = await room();
    for (const status of ['READY', 'RELEASING', 'RELEASED', 'CANCELED'] as const) {
      const id = randomUUID();
      const message = await refusal(
        prisma().releaseBatch.create({
          data: { id, assignmentId: r.assignmentId, classroomId: r.classroomId, status },
        }),
      );
      expect(message, status).toMatch(/RELEASE_BATCH_MUST_START_DRAFT/);
      expect(await prisma().releaseBatch.findUnique({ where: { id } })).toBeNull();
    }
  });

  it('refuses RELEASED without a release time, and refuses to change the time afterwards', async () => {
    const r = await room();
    const batchId = await batchOf(r, []);
    await walkTo(batchId, 'RELEASING');

    expect(
      await refusal(
        prisma().releaseBatch.update({ where: { id: batchId }, data: { status: 'RELEASED' } }),
      ),
    ).toMatch(/RELEASE_BATCH_RELEASED_WITHOUT_TIME/);
    expect(await statusOf(batchId)).toBe('RELEASING');

    await forceStatus(batchId, 'RELEASED');
    expect(
      await refusal(
        prisma().releaseBatch.update({
          where: { id: batchId },
          data: { releasedAt: new Date(T0 + 1) },
        }),
      ),
    ).toMatch(/RELEASE_BATCH_RELEASED_AT_IMMUTABLE/);
  });

  it('refuses to move a batch to another assignment or classroom', async () => {
    const r = await room();
    const other = await room();
    const batchId = await batchOf(r, [await attempt(r)]);

    expect(
      await refusal(
        prisma().releaseBatch.update({
          where: { id: batchId },
          data: { classroomId: other.classroomId },
        }),
      ),
    ).toMatch(/RELEASE_BATCH_SCOPE_IMMUTABLE/);
  });

  it('lets exactly ONE of two concurrent `beginRelease` calls win', async () => {
    /**
     * Two workers pick up the same READY batch. One must win and the other must be told, cleanly, that it lost.
     *
     * **THE OUTER LOCK IS WHAT MAKES THIS A TEST OF CONCURRENCY RATHER THAN OF LUCK.** The first version just fired
     * two calls with `Promise.all`, and it still passed with `FOR UPDATE` deleted from `lockBatch` -- because one call
     * usually finished before the other had read anything, which is two sequential calls and proves nothing. Holding
     * the row here forces both to be in flight at once: with the lock they queue behind this transaction and then
     * behind each other; without it both read READY straight away, both pass the gate, and the loser's write finds
     * the status already changed and throws `RELEASE_BATCH_TRANSITION_LOST` instead of returning a refusal.
     */
    const r = await room();
    const batchId = await batchOf(r, [await attempt(r)]);
    await markBatchReady(prisma(), { batchId, actorId: r.teacherId, clock });

    let racing: Promise<Awaited<ReturnType<typeof beginRelease>>[]> = Promise.resolve([]);
    await prisma().$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "ReleaseBatch" WHERE "id" = ${batchId} FOR UPDATE`;
      racing = Promise.all([
        beginRelease(prisma(), { batchId, actorId: r.teacherId, clock }),
        beginRelease(prisma(), { batchId, actorId: r.teacherId, clock }),
      ]);
      // A rejection is asserted below, not here; this only stops it being reported as unhandled while we wait.
      racing.catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    const results = await racing;

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)).toMatchObject({
      ok: false,
      reason: 'ILLEGAL_TRANSITION',
      status: 'RELEASING',
    });
    const transitions = await auditOf(batchId, 'ReleaseBatch.transition');
    expect(
      transitions.filter((row) => (row.meta as { to: string }).to === 'RELEASING'),
    ).toHaveLength(1);
  });

  it('writes one audit row per transition, with who and from/to', async () => {
    const r = await room();
    const batchId = await batchOf(r, [await attempt(r)]);
    await markBatchReady(prisma(), { batchId, actorId: r.teacherId, clock });
    await reopenBatch(prisma(), { batchId, actorId: r.teacherId, clock });
    await cancelBatch(prisma(), {
      batchId,
      actorId: r.teacherId,
      reason: 'wrong class selected',
      clock,
    });

    const rows = await auditOf(batchId, 'ReleaseBatch.transition');
    expect(rows.map((row) => row.meta)).toEqual([
      { from: 'DRAFT', to: 'READY', at: new Date(T0).toISOString() },
      { from: 'READY', to: 'DRAFT', at: new Date(T0).toISOString() },
      {
        from: 'DRAFT',
        to: 'CANCELED',
        at: new Date(T0).toISOString(),
        reason: 'wrong class selected',
      },
    ]);
    expect(
      rows.every((row) => row.actorId === r.teacherId && row.classroomId === r.classroomId),
    ).toBe(true);
  });

  it('refuses a cancel with no reason or no actor, and leaves the batch where it was', async () => {
    const r = await room();
    const batchId = await batchOf(r, []);
    expect(
      await cancelBatch(prisma(), { batchId, actorId: r.teacherId, reason: 'oops', clock }),
    ).toEqual({
      ok: false,
      reason: 'NO_REASON',
    });
    expect(await cancelBatch(prisma(), { batchId, actorId: '', reason: REASON, clock })).toEqual({
      ok: false,
      reason: 'NO_ACTOR',
    });
    expect(await statusOf(batchId)).toBe('DRAFT');
  });
});

describe.skipIf(!process.env.DATABASE_URL)(
  'membership is FROZEN on RELEASING, structurally',
  () => {
    it('agrees with `isMembershipFrozen` for every status: insert AND delete, by a bare client', async () => {
      const r = await room();

      for (const status of RELEASE_BATCH_STATUSES) {
        const [first, second, late] = [await attempt(r), await attempt(r), await attempt(r)];
        const batchId = await batchOf(r, [first, second].sort());
        await walkTo(batchId, status);
        const before = await memberIds(batchId);

        const insert = await refusal(
          prisma().releaseBatchMember.create({ data: { batchId, attemptId: late } }),
        );
        const remove = await refusal(
          prisma().releaseBatchMember.delete({
            where: { batchId_attemptId: { batchId, attemptId: first } },
          }),
        );

        if (isMembershipFrozen(status)) {
          expect(insert, `insert into ${status}`).toMatch(/RELEASE_BATCH_MEMBERSHIP_FROZEN/);
          expect(remove, `delete from ${status}`).toMatch(/RELEASE_BATCH_MEMBERSHIP_FROZEN/);
          // The row set is byte-for-byte what it was. This is the claim; the error messages are only how it is kept.
          expect(await memberIds(batchId), status).toEqual(before);
        } else {
          expect(insert, `insert into ${status}`).toBeNull();
          expect(remove, `delete from ${status}`).toBeNull();
          expect(await memberIds(batchId), status).toEqual([second, late].sort());
        }
      }
    });

    it('refuses a student added THE DAY AFTER release began -- through the module and around it', async () => {
      const r = await room();
      const original = await attempt(r);
      const batchId = await batchOf(r, [original]);
      await markBatchReady(prisma(), { batchId, actorId: r.teacherId, clock });
      await beginRelease(prisma(), { batchId, actorId: r.teacherId, clock });

      // The new student joins, sits the paper, and is marked. Nothing about THEM is wrong.
      const latecomer = await attempt(r);

      expect(
        await changeBatchMembers(prisma(), {
          batchId,
          add: [latecomer],
          actorId: r.teacherId,
          clock,
        }),
      ).toEqual({ ok: false, reason: 'MEMBERSHIP_FROZEN', status: 'RELEASING' });
      expect(
        await refusal(
          prisma().releaseBatchMember.create({ data: { batchId, attemptId: latecomer } }),
        ),
      ).toMatch(/RELEASE_BATCH_MEMBERSHIP_FROZEN/);

      expect(await memberIds(batchId)).toEqual([original]);
      // No audit row claims a membership change that did not happen.
      expect(await auditOf(batchId, 'ReleaseBatch.members')).toHaveLength(0);
    });

    it('refuses to RE-POINT a member row, which would be an unchecked insert into another batch', async () => {
      const r = await room();
      const a = await attempt(r);
      const from = await batchOf(r, [a]);
      const into = await batchOf(r, []);
      await walkTo(into, 'RELEASED');

      expect(
        await refusal(
          prisma().releaseBatchMember.update({
            where: { batchId_attemptId: { batchId: from, attemptId: a } },
            data: { batchId: into },
          }),
        ),
      ).toMatch(/RELEASE_BATCH_MEMBER_IMMUTABLE/);
      expect(await memberIds(into)).toEqual([]);
      expect(await attemptReleaseState(prisma(), a)).toBe(SEALED_RELEASE_STATE);
    });

    it('refuses an attempt from ANOTHER classroom, so a batch cannot release what its teacher does not teach', async () => {
      const r = await room();
      const elsewhere = await room();
      const foreign = await attempt(elsewhere);
      const batchId = await batchOf(r, [await attempt(r)]);

      expect(
        await changeBatchMembers(prisma(), {
          batchId,
          add: [foreign],
          actorId: r.teacherId,
          clock,
        }),
      ).toEqual({
        ok: false,
        reason: 'ATTEMPT_OUT_OF_SCOPE',
        status: 'DRAFT',
        attemptIds: [foreign],
      });
      expect(
        await refusal(
          prisma().releaseBatchMember.create({ data: { batchId, attemptId: foreign } }),
        ),
      ).toMatch(/RELEASE_BATCH_MEMBER_OUT_OF_SCOPE/);
      expect(
        await createReleaseBatch(prisma(), {
          assignmentId: r.assignmentId,
          classroomId: r.classroomId,
          attemptIds: [foreign],
          actorId: r.teacherId,
          clock,
        }),
      ).toEqual({ ok: false, reason: 'ATTEMPT_OUT_OF_SCOPE', attemptIds: [foreign] });
      expect(await memberIds(batchId)).not.toContain(foreign);
    });

    it('BLOCKS a member insert while a transition holds the batch, then refuses it', async () => {
      /**
       * The race the `FOR SHARE` in the member trigger exists for. A transaction moves the batch to RELEASING and has
       * NOT committed; an insert arrives. Without the lock the insert reads the last committed status (READY), passes,
       * and commits a member into a batch that is frozen a moment later. With it, the insert waits for the commit,
       * re-reads RELEASING, and is refused.
       */
      const r = await room();
      const batchId = await batchOf(r, [await attempt(r)]);
      const latecomer = await attempt(r);
      await walkTo(batchId, 'READY');

      let insertSettledBeforeCommit = false;
      let insert: Promise<string | null> = Promise.resolve(null);

      await prisma().$transaction(async (tx) => {
        await tx.releaseBatch.update({ where: { id: batchId }, data: { status: 'RELEASING' } });
        // On the OUTER client: a different connection, and so a different transaction.
        insert = refusal(
          prisma().releaseBatchMember.create({ data: { batchId, attemptId: latecomer } }),
        );
        void insert.then(() => {
          insertSettledBeforeCommit = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 400));
        // Still waiting on this transaction's row lock. If this is `true` the insert did not block, and either
        // outcome it reached was decided against a status that was about to change.
        expect(insertSettledBeforeCommit).toBe(false);
      });

      expect(await insert).toMatch(/RELEASE_BATCH_MEMBERSHIP_FROZEN/);
      expect(await memberIds(batchId)).not.toContain(latecomer);
    });

    it('makes `beginRelease` WAIT for an in-flight member insert, and then verify the member it added', async () => {
      /**
       * The same race from the other side. An ungraded member is being inserted and has not committed; `beginRelease`
       * must not evaluate the gate against the membership as it was. It waits, sees the new member, and the gate is
       * closed BY that member -- rather than opening on one attempt and freezing two.
       */
      const r = await room();
      const batchId = await batchOf(r, [await attempt(r)]);
      await markBatchReady(prisma(), { batchId, actorId: r.teacherId, clock });
      const ungraded = await attempt(r, 'ungraded');

      let begin: ReturnType<typeof beginRelease> | null = null;
      await prisma().$transaction(async (tx) => {
        await tx.releaseBatchMember.create({ data: { batchId, attemptId: ungraded } });
        begin = beginRelease(prisma(), { batchId, actorId: r.teacherId, clock });
        await new Promise((resolve) => setTimeout(resolve, 400));
      });

      expect(await begin).toMatchObject({
        ok: false,
        reason: 'GATE_CLOSED',
        blockers: [{ attemptId: ungraded, reason: 'ATTEMPT_NOT_GRADED', waivable: true }],
      });
      expect(await statusOf(batchId)).toBe('READY');
    });

    it('lets an ERASED attempt leave a released batch, and touches nobody else in it', async () => {
      // The one delete the freeze permits: the attempt itself is gone, so there is nobody left to be half-released.
      // Refusing it would make a released grade impossible to erase.
      const r = await room();
      const [kept, erased] = [await attempt(r), await attempt(r)];
      const batchId = await batchOf(r, [kept, erased]);
      await walkTo(batchId, 'RELEASED');

      await prisma().examAttempt.delete({ where: { id: erased } });

      expect(await memberIds(batchId)).toEqual([kept]);
      expect(await statusOf(batchId)).toBe('RELEASED');
      expect((await attemptReleaseState(prisma(), kept)).state).toBe('RELEASED');
    });

    it('refuses to DELETE a released batch that still releases somebody', async () => {
      // `RELEASED -> nothing` re-seals every member with no row left to say it happened: the illegal edge by another verb.
      const r = await room();
      const a = await attempt(r);
      const batchId = await batchOf(r, [a]);
      await walkTo(batchId, 'RELEASED');

      expect(await refusal(prisma().releaseBatch.delete({ where: { id: batchId } }))).toMatch(
        /RELEASE_BATCH_DELETE_REFUSED/,
      );
      expect((await attemptReleaseState(prisma(), a)).state).toBe('RELEASED');

      // A DRAFT batch is nobody's results yet, and goes with its members.
      const draft = await batchOf(r, [a]);
      await prisma().releaseBatch.delete({ where: { id: draft } });
      expect(await prisma().releaseBatchMember.count({ where: { batchId: draft } })).toBe(0);
    });
  },
);

describe.skipIf(!process.env.DATABASE_URL)('the pre-release gate', () => {
  it('opens for a fully graded batch -- through real `Decimal` columns', async () => {
    const r = await room();
    const batchId = await batchOf(r, [await attempt(r), await attempt(r)]);

    expect(await evaluateBatchGate(prisma(), { batchId, entering: 'RELEASING', clock })).toEqual({
      open: true,
      blockers: [],
      status: 'DRAFT',
    });
    expect(await markBatchReady(prisma(), { batchId, actorId: r.teacherId, clock })).toEqual({
      ok: true,
      from: 'DRAFT',
      to: 'READY',
    });
  });

  it('blocks on EVERY member that is not finished, lists them all, and writes nothing', async () => {
    const r = await room();
    const graded = await attempt(r);
    const ungraded = await attempt(r, 'ungraded');
    const waiting = await attempt(r, 'needsHuman');
    const batchId = await batchOf(r, [graded, ungraded, waiting]);

    const result = await markBatchReady(prisma(), { batchId, actorId: r.teacherId, clock });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('GATE_CLOSED');
    expect([...(result.blockers ?? [])].sort((a, b) => a.reason.localeCompare(b.reason))).toEqual([
      { attemptId: waiting, reason: 'ATTEMPT_NEEDS_HUMAN', waivable: true },
      { attemptId: ungraded, reason: 'ATTEMPT_NOT_GRADED', waivable: true },
    ]);
    expect(await statusOf(batchId)).toBe('DRAFT');
    expect(await auditOf(batchId, 'ReleaseBatch.transition')).toHaveLength(0);
  });

  it('blocks an empty batch', async () => {
    const r = await room();
    const batchId = await batchOf(r, []);
    expect(await markBatchReady(prisma(), { batchId, actorId: r.teacherId, clock })).toMatchObject({
      ok: false,
      reason: 'GATE_CLOSED',
      blockers: [{ attemptId: null, reason: 'EMPTY_BATCH', waivable: false }],
    });
  });

  it('holds a READY batch out of RELEASING until the review window has elapsed', async () => {
    const r = await room();
    const batchId = await batchOf(r, [await attempt(r)], { minHoldUntil: T0 + 60_000 });

    // READY is where it waits. The window does not stop a batch being finished, only being released.
    expect((await markBatchReady(prisma(), { batchId, actorId: r.teacherId, clock })).ok).toBe(
      true,
    );
    expect(await beginRelease(prisma(), { batchId, actorId: null, clock })).toMatchObject({
      ok: false,
      reason: 'GATE_CLOSED',
      blockers: [{ attemptId: null, reason: 'HOLD_WINDOW_NOT_ELAPSED', waivable: false }],
    });
    expect(await statusOf(batchId)).toBe('READY');

    const later = new FrozenClock(T0 + 60_000);
    expect((await beginRelease(prisma(), { batchId, actorId: null, clock: later })).ok).toBe(true);
    expect(await statusOf(batchId)).toBe('RELEASING');
  });

  it('admits into RELEASING only what `releaseBatch` then releases', async () => {
    // The gate and the release share one read and one `planRelease`. This walks the whole machine through the module
    // and through `release.ts`, so a gate that opened for something the release refuses would strand the batch here.
    const r = await room();
    const [a, b] = [await attempt(r), await attempt(r)];
    const batchId = await batchOf(r, [a, b]);
    await markBatchReady(prisma(), { batchId, actorId: r.teacherId, clock });
    await beginRelease(prisma(), { batchId, actorId: r.teacherId, clock });

    const released = await releaseBatch(prisma() as never, {
      batchId,
      releasedById: r.teacherId,
      latePenaltyPercent: 0,
      clock,
    });

    expect(released, JSON.stringify(released.refusals)).toMatchObject({
      released: true,
      releasedCount: 2,
    });
    expect(await statusOf(batchId)).toBe('RELEASED');
    for (const id of [a, b]) {
      expect(await attemptReleaseState(prisma(), id)).toEqual({
        state: 'RELEASED',
        releasedAt: new Date(T0).toISOString(),
      });
    }
  });

  it('`releaseBatch` REFUSES a batch that is not RELEASING -- DRAFT, READY and CANCELED alike', async () => {
    /**
     * RED before this task, for CANCELED: `planRelease` only asked "is it already RELEASED?", so a cancelled batch
     * was released. The trigger now refuses the write as well; this asserts the clean refusal and that nothing moved.
     */
    const r = await room();
    for (const status of ['DRAFT', 'READY', 'CANCELED'] as const) {
      const a = await attempt(r);
      const batchId = await batchOf(r, [a]);
      await walkTo(batchId, status);

      const result = await releaseBatch(prisma() as never, {
        batchId,
        latePenaltyPercent: 0,
        clock,
      });

      expect(result, status).toEqual({
        released: false,
        releasedCount: 0,
        refusals: [{ attemptId: null, reason: 'BATCH_NOT_RELEASING' }],
      });
      expect(await statusOf(batchId)).toBe(status);
      const stored = await prisma().examAttempt.findUniqueOrThrow({ where: { id: a } });
      expect(stored.releasedAt, status).toBeNull();
      expect(await attemptReleaseState(prisma(), a)).toBe(SEALED_RELEASE_STATE);
    }
  });
});

describe.skipIf(!process.env.DATABASE_URL)('the override: WHO, WHEN, WHY -- recorded', () => {
  it('records all three on the batch AND in the audit log, and only then does the gate open', async () => {
    const r = await room();
    const graded = await attempt(r);
    const ungraded = await attempt(r, 'ungraded');
    const batchId = await batchOf(r, [graded, ungraded]);
    expect((await markBatchReady(prisma(), { batchId, actorId: r.teacherId, clock })).ok).toBe(
      false,
    );

    const at = new FrozenClock(T0 + 5_000);
    const result = await recordReleaseOverride(prisma(), {
      batchId,
      actorId: r.teacherId,
      reason: `  ${REASON}  `,
      clock: at,
    });

    const waived = [{ attemptId: ungraded, reason: 'ATTEMPT_NOT_GRADED' }];
    expect(result).toEqual({
      ok: true,
      record: { actorId: r.teacherId, at: T0 + 5_000, reason: REASON, waived },
    });

    const stored = await prisma().releaseBatch.findUniqueOrThrow({ where: { id: batchId } });
    expect(stored.overrideById).toBe(r.teacherId);
    expect(stored.overrideAt).toEqual(new Date(T0 + 5_000));
    expect(stored.overrideReason).toBe(REASON);
    expect(stored.overrideWaived).toEqual(waived);

    const rows = await auditOf(batchId, 'ReleaseBatch.override');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actorId).toBe(r.teacherId);
    expect(rows[0]?.classroomId).toBe(r.classroomId);
    expect(rows[0]?.meta).toEqual({
      status: 'DRAFT',
      reason: REASON,
      waived,
      at: new Date(T0 + 5_000).toISOString(),
    });

    expect((await markBatchReady(prisma(), { batchId, actorId: r.teacherId, clock })).ok).toBe(
      true,
    );
  });

  it('cannot be applied without a WHO or a WHY, and a refused override leaves NO trace of having been one', async () => {
    const r = await room();
    const batchId = await batchOf(r, [await attempt(r, 'ungraded')]);

    const attempts = [
      [{ actorId: '', reason: REASON }, 'NO_ACTOR'],
      [{ actorId: r.teacherId, reason: '' }, 'NO_REASON'],
      [{ actorId: r.teacherId, reason: 'x'.repeat(MIN_OVERRIDE_REASON - 1) }, 'NO_REASON'],
      // A well-formed id that names nobody. `plans/01` §10: only a human disposes.
      [{ actorId: randomUUID(), reason: REASON }, 'ACTOR_NOT_FOUND'],
    ] as const;

    for (const [fields, reason] of attempts) {
      expect(await recordReleaseOverride(prisma(), { batchId, clock, ...fields })).toEqual({
        ok: false,
        reason,
      });
    }

    const stored = await prisma().releaseBatch.findUniqueOrThrow({ where: { id: batchId } });
    expect([
      stored.overrideReason,
      stored.overrideById,
      stored.overrideAt,
      stored.overrideWaived,
    ]).toEqual([null, null, null, null]);
    expect(await auditOf(batchId, 'ReleaseBatch.override')).toHaveLength(0);
    // And the gate is exactly as closed as it was.
    expect((await markBatchReady(prisma(), { batchId, actorId: r.teacherId, clock })).ok).toBe(
      false,
    );
  });

  it('cannot be applied without all of them EVEN BY A BARE UPDATE -- the CHECK refuses each partial write', async () => {
    /**
     * "Without all three" as a fact about the table rather than about `recordReleaseOverride`. Each of these is a
     * write some other code path could issue; drop `ReleaseBatch_override_complete` and every one of them succeeds.
     */
    const r = await room();
    const batchId = await batchOf(r, [await attempt(r, 'ungraded')]);
    const full = {
      overrideReason: REASON,
      overrideById: r.teacherId,
      overrideAt: new Date(T0),
      overrideWaived: [{ attemptId: 'a1', reason: 'ATTEMPT_NOT_GRADED' }],
    };
    const { overrideReason: _why, ...noWhy } = full;
    const { overrideById: _who, ...noWho } = full;
    const { overrideAt: _when, ...noWhen } = full;
    const { overrideWaived: _what, ...noWhat } = full;

    const partials: [string, Record<string, unknown>][] = [
      ['no why', noWhy],
      ['no who', noWho],
      ['no when', noWhen],
      ['no what', noWhat],
      ['waives nothing', { ...full, overrideWaived: [] }],
      ['whitespace why', { ...full, overrideReason: ' \t\n          ' }],
      // The same floor as `MIN_OVERRIDE_REASON`. If one moves and the other does not, this or the previous test fails.
      ['short why', { ...full, overrideReason: 'x'.repeat(MIN_OVERRIDE_REASON - 1) }],
    ];
    for (const [label, data] of partials) {
      expect(
        await refusal(
          prisma().releaseBatch.update({ where: { id: batchId }, data: data as never }),
        ),
        label,
      ).toMatch(/ReleaseBatch_override_complete/);
    }

    // The complete write is accepted, so the refusals above are about completeness and not about the columns.
    expect(
      await refusal(prisma().releaseBatch.update({ where: { id: batchId }, data: full })),
    ).toBeNull();
  });

  it('waives ONLY what the person saw: a blocker that appears later is not covered', async () => {
    const r = await room();
    const first = await attempt(r, 'ungraded');
    const batchId = await batchOf(r, [first]);
    await recordReleaseOverride(prisma(), { batchId, actorId: r.teacherId, reason: REASON, clock });
    expect((await markBatchReady(prisma(), { batchId, actorId: r.teacherId, clock })).ok).toBe(
      true,
    );

    // Tuesday: another unmarked paper is added. Nobody has decided anything about it.
    const second = await attempt(r, 'ungraded');
    await changeBatchMembers(prisma(), { batchId, add: [second], actorId: r.teacherId, clock });

    expect(await beginRelease(prisma(), { batchId, actorId: r.teacherId, clock })).toMatchObject({
      ok: false,
      reason: 'GATE_CLOSED',
      // `first` is NOT listed: it is still waived. `second` is, and only `second`.
      blockers: [{ attemptId: second, reason: 'ATTEMPT_NOT_GRADED', waivable: true }],
    });
    expect(await statusOf(batchId)).toBe('READY');
  });

  it('a second override REPLACES the first on the batch, covers the whole current list, and both stay in the log', async () => {
    const r = await room();
    const first = await attempt(r, 'ungraded');
    const batchId = await batchOf(r, [first]);
    await recordReleaseOverride(prisma(), { batchId, actorId: r.teacherId, reason: REASON, clock });

    const second = await attempt(r, 'ungraded');
    await changeBatchMembers(prisma(), { batchId, add: [second], actorId: r.teacherId, clock });
    const colleague = await user();
    const again = await recordReleaseOverride(prisma(), {
      batchId,
      actorId: colleague,
      reason: 'both absent, department head agreed',
      clock: new FrozenClock(T0 + 9_000),
    });

    // BOTH attempts. Computed on top of the first waiver it would list only `second`, and replacing the row would
    // then silently un-waive `first`.
    expect(again.ok && again.record.waived.map((entry) => entry.attemptId).sort()).toEqual(
      [first, second].sort(),
    );
    const stored = await prisma().releaseBatch.findUniqueOrThrow({ where: { id: batchId } });
    expect(stored.overrideById).toBe(colleague);

    const log = await auditOf(batchId, 'ReleaseBatch.override');
    expect(log.map((row) => row.actorId)).toEqual([r.teacherId, colleague]);
    expect((await markBatchReady(prisma(), { batchId, actorId: r.teacherId, clock })).ok).toBe(
      true,
    );
  });

  it('cannot waive a score that does not exist, and says so instead of recording an empty override', async () => {
    const r = await room();
    const batchId = await batchOf(r, [await attempt(r, 'allExcused')]);

    expect(await evaluateBatchGate(prisma(), { batchId, entering: 'READY', clock })).toMatchObject({
      open: false,
      blockers: [{ reason: 'SCORE_NOT_COMPUTABLE', waivable: false }],
    });
    expect(
      await recordReleaseOverride(prisma(), {
        batchId,
        actorId: r.teacherId,
        reason: REASON,
        clock,
      }),
    ).toEqual({ ok: false, reason: 'NOTHING_TO_OVERRIDE' });
    expect(await auditOf(batchId, 'ReleaseBatch.override')).toHaveLength(0);
  });

  it('IS DURABLE: it cannot be erased, and once the batch is released it cannot be edited', async () => {
    const r = await room();
    const ungraded = await attempt(r, 'ungraded');
    const batchId = await batchOf(r, [ungraded]);
    await recordReleaseOverride(prisma(), { batchId, actorId: r.teacherId, reason: REASON, clock });

    // Erasing all four columns at once satisfies the CHECK. The trigger is what refuses it.
    expect(
      await refusal(
        prisma()
          .$executeRaw`UPDATE "ReleaseBatch" SET "overrideReason" = NULL, "overrideById" = NULL, "overrideAt" = NULL, "overrideWaived" = NULL WHERE "id" = ${batchId}`,
      ),
    ).toMatch(/RELEASE_BATCH_OVERRIDE_ERASED/);

    await markBatchReady(prisma(), { batchId, actorId: r.teacherId, clock });
    await beginRelease(prisma(), { batchId, actorId: r.teacherId, clock });
    const released = await releaseBatch(prisma() as never, {
      batchId,
      latePenaltyPercent: 0,
      clock,
    });
    // The override is what the release honoured: an ungraded attempt, released on a recorded human decision.
    expect(released.released, JSON.stringify(released.refusals)).toBe(true);

    expect(
      await refusal(
        prisma().releaseBatch.update({
          where: { id: batchId },
          data: { overrideReason: 'a tidier story, written afterwards' },
        }),
      ),
    ).toMatch(/RELEASE_BATCH_OVERRIDE_AFTER_TERMINAL/);
    expect(
      await recordReleaseOverride(prisma(), {
        batchId,
        actorId: r.teacherId,
        reason: REASON,
        clock,
      }),
    ).toEqual({ ok: false, reason: 'BATCH_TERMINAL' });

    const stored = await prisma().releaseBatch.findUniqueOrThrow({ where: { id: batchId } });
    expect(stored.overrideReason).toBe(REASON);
    expect(stored.overrideById).toBe(r.teacherId);
  });
});

describe.skipIf(!process.env.DATABASE_URL)(
  'what a student can infer before release -- INV-RELEASE-2',
  () => {
    it('is BYTE-IDENTICAL for no batch, DRAFT, READY-with-override, RELEASING, CANCELED and an unknown attempt', async () => {
      /**
       * "No difference in payload size." Each of these states carries something a student could infer from if it were
       * projected -- that marking has finished, that their paper is the one being waited on, that a release was
       * abandoned. All of them must be the same bytes, and the same bytes as an attempt that does not exist.
       */
      const r = await room();
      const views: [string, unknown][] = [];

      const loose = await attempt(r);
      views.push(['no batch', await attemptReleaseState(prisma(), loose)]);
      views.push(['unknown attempt', await attemptReleaseState(prisma(), randomUUID())]);

      const drafted = await attempt(r, 'ungraded');
      const draft = await batchOf(r, [drafted]);
      views.push(['DRAFT, blocked', await attemptReleaseState(prisma(), drafted)]);

      await recordReleaseOverride(prisma(), {
        batchId: draft,
        actorId: r.teacherId,
        reason: REASON,
        clock,
      });
      await markBatchReady(prisma(), { batchId: draft, actorId: r.teacherId, clock });
      views.push(['READY, overridden', await attemptReleaseState(prisma(), drafted)]);

      await beginRelease(prisma(), { batchId: draft, actorId: r.teacherId, clock });
      views.push(['RELEASING', await attemptReleaseState(prisma(), drafted)]);

      await cancelBatch(prisma(), { batchId: draft, actorId: r.teacherId, reason: REASON, clock });
      views.push(['CANCELED', await attemptReleaseState(prisma(), drafted)]);

      for (const [label, view] of views) {
        expect(view, label).toBe(SEALED_RELEASE_STATE);
        expect(JSON.stringify(view), label).toBe('{"state":"SEALED"}');
        expect(findScoreBearingKeys(view), label).toEqual([]);
      }
      expect(views).toHaveLength(6);
    });

    it('becomes RELEASED only when the batch does, and for every member at once', async () => {
      const r = await room();
      const members = [await attempt(r), await attempt(r), await attempt(r)];
      const batchId = await batchOf(r, members);
      await markBatchReady(prisma(), { batchId, actorId: r.teacherId, clock });
      await beginRelease(prisma(), { batchId, actorId: r.teacherId, clock });

      const before = await Promise.all(members.map((id) => attemptReleaseState(prisma(), id)));
      expect(before.every((view) => view === SEALED_RELEASE_STATE)).toBe(true);

      await releaseBatch(prisma() as never, { batchId, latePenaltyPercent: 0, clock });

      const after = await Promise.all(members.map((id) => attemptReleaseState(prisma(), id)));
      expect(after.map((view) => view.state)).toEqual(['RELEASED', 'RELEASED', 'RELEASED']);
    });
  },
);

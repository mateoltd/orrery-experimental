// @vitest-environment node

/**
 * ADVERSARIAL: the server answer write, against real Postgres.  (P8-T15: replayed saves, second device, clock skew)
 *
 * ## WHY THIS IS A DATABASE TEST, AND WHY IT IS IN THIS DIRECTORY
 *
 * Three of the eight adversarial axes end at one function, `submitAnswer`, and what they claim about it is a claim
 * about what a TABLE contains afterwards: a replay appends nothing, a second device's write is refused and leaves no
 * trace in the answer, a late write is rejected and the last value stands. `decideWrite` is pure and has 21 unit
 * tests, and none of them can see any of that -- "the transaction's failure mode is the absence of a partial state,
 * and no amount of pure testing can observe an absence" (`transactions.integration.test.ts`).
 *
 * ## IT NOW LIVES IN `packages/db/src/`, AND THE MOVE CHANGED WHAT IT IS WORTH
 *
 * It was written under `apps/web/src/features/exam/watchdogs/` because the lane that wrote it could only touch that
 * directory and `exam-engine/src/adversarial/`, and `exam-engine` cannot import `@orrery/db`. **There it was SKIPPED by
 * a plain `pnpm test`** -- `describe.skipIf(!DATABASE_URL)` is this repository's convention, and a skipped test has
 * verified nothing while appearing in a test count.
 *
 * Moved here, it runs under `pnpm test:integration` on every integration run. The count in the commit that moved it
 * went from "8 skipped" to "part of 409", and that difference is the whole point: **these tests were found by
 * running this file, and while it sat outside the integration suite nothing was executing them.**
 *
 * ## HOW TO RUN IT
 *
 * ```
 * pnpm --filter @orrery/db test:integration
 * ```
 *
 * ## BOTH DEFECTS IT FOUND ARE NOW FIXED, AND THE `.fails` ARE OFF
 *
 * `ADV-DB1` (the attempt deadline was never enforced -- `Date + number` is string concatenation) and `ADV-DB2` (no
 * transaction, so a concurrent writer got an unhandled exception instead of a 409) were both real. Both are fixed in
 * `answer-write.ts`; these tests are now plain `it`, and they pass on every run rather than being green because their
 * assertion fails.
 *
 * **They are the reason this file moved.** Two `it.fails` sitting in a directory that a plain `pnpm test` SKIPS is a
 * claim with nothing behind it -- the same failure as `audit-seals` once printing "0 payloads audited" and exiting 0.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, describe, expect, it } from 'vitest';
import { type SubmitDb, type SubmitInput, submitAnswer } from './answer-write.js';
import { PrismaClient } from './prisma.js';

const T0 = 1_800_000_000_000;
const HOUR = 3_600_000;

const clockAt = (instant: number) => ({ now: () => instant, monotonic: () => 0 });

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
  readonly attemptId: string;
  readonly questionId: string;
}

/** One attempt on a one-question paper. `attempt` overrides the columns a test is about. */
const fixture = async (attempt: Record<string, unknown> = {}): Promise<Fixture> => {
  const db = prisma();
  const ownerId = randomUUID();
  const studentId = randomUUID();
  await db.user.create({
    data: {
      id: ownerId,
      email: `${ownerId}@adv.example`,
      emailNormalized: `${ownerId}@adv.example`,
      name: 'T',
    },
  });
  await db.user.create({
    data: {
      id: studentId,
      email: `${studentId}@adv.example`,
      emailNormalized: `${studentId}@adv.example`,
      name: 'S',
    },
  });
  const resource = await db.resource.create({
    data: {
      id: randomUUID(),
      ownerId,
      status: 'PUBLISHED',
      visibility: 'UNLISTED',
      title: 'Adversarial',
      slug: randomUUID(),
    },
  });
  const version = await db.resourceVersion.create({
    data: {
      id: randomUUID(),
      resourceId: resource.id,
      version: 1,
      blocks: [],
      blocksChecksum: 'adversarial',
      meta: {},
      createdById: ownerId,
    },
  });
  const classroom = await db.classroom.create({
    data: { id: randomUUID(), ownerId, name: 'Year 9', slug: randomUUID() },
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
  const bank = await db.questionBank.create({
    data: { id: randomUUID(), ownerId, name: 'Bank' },
  });
  const question = await db.question.create({
    data: { id: randomUUID(), bankId: bank.id, type: 'singleChoice', spec: {}, points: 2 },
  });
  const row = await db.examAttempt.create({
    data: {
      id: randomUUID(),
      assignmentId: assignment.id,
      classroomId: classroom.id,
      studentId,
      attemptNumber: 1,
      status: 'IN_PROGRESS',
      variantMap: { [randomUUID()]: [question.id] },
      ...attempt,
    } as never,
  });
  return { attemptId: row.id, questionId: question.id };
};

/** A save of `choice`, as the route builds it. The key is fresh unless the test is ABOUT the key. */
const save = (f: Fixture, choice: string, over: Partial<SubmitInput> = {}): SubmitInput => ({
  attemptId: f.attemptId,
  questionId: f.questionId,
  idempotencyKey: randomUUID(),
  expectedRevision: 0,
  answerJson: { choiceId: choice },
  answerBytes: JSON.stringify({ choiceId: choice }),
  answerHash: `hash-${choice}`,
  ...over,
});

const stored = async (f: Fixture) => {
  const response = await prisma().questionResponse.findUnique({
    where: { attemptId_questionId: { attemptId: f.attemptId, questionId: f.questionId } },
    select: { answer: true, revision: true },
  });
  const revisions = await prisma().answerRevision.findMany({
    where: { attemptId: f.attemptId },
    select: { revision: true, answerHash: true, idemKey: true },
    orderBy: { revision: 'asc' },
  });
  return { response, revisions };
};

describe.skipIf(!process.env.DATABASE_URL)('replayed saves, against real Postgres', () => {
  it('answers a replayed key with the ORIGINAL body and appends nothing, even when the payload has changed', async () => {
    /**
     * The attack is the changed payload. An honest retry resends the same bytes, and
     * `transactions.integration.test.ts` covers that. A dishonest one resends the KEY with a different answer: the
     * key is known to be honoured whatever the clock says, so if the body were taken from the request it would be a
     * way to rewrite an accepted answer at any time, including after the paper closed.
     */
    const f = await fixture();
    const key = randomUUID();
    const first = await submitAnswer(prisma(), save(f, 'a', { idempotencyKey: key }), clockAt(T0));
    const replay = await submitAnswer(
      prisma(),
      save(f, 'b', { idempotencyKey: key, expectedRevision: 1 }),
      clockAt(T0 + 1),
    );

    expect(first.outcome, JSON.stringify(first)).toBe('saved');
    expect(replay.outcome).toBe('replayed');
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(first.body);

    const after = await stored(f);
    expect(after.response?.answer).toEqual({ choiceId: 'a' });
    expect(after.response?.revision).toBe(1);
    expect(after.revisions).toEqual([{ revision: 1, answerHash: 'hash-a', idemKey: key }]);
  });

  it('still replays after the attempt has been SUBMITTED, because that is when a lost acknowledgement is retried', async () => {
    const f = await fixture();
    const key = randomUUID();
    const first = await submitAnswer(prisma(), save(f, 'a', { idempotencyKey: key }), clockAt(T0));
    await prisma().examAttempt.update({
      where: { id: f.attemptId },
      data: { status: 'SUBMITTED' },
    });

    const replay = await submitAnswer(
      prisma(),
      save(f, 'a', { idempotencyKey: key }),
      clockAt(T0 + HOUR),
    );
    expect(replay.outcome).toBe('replayed');
    expect(replay.body).toEqual(first.body);
    expect((await stored(f)).revisions).toHaveLength(1);
  });

  it('replays a stored REFUSAL as a refusal, never as a 200', async () => {
    /**
     * `B8`: the ledger once held rejected writes, and a retry of one came back 2xx -- a green tick over an answer
     * that was never stored. Rejections no longer enter the ledger, so the only way to have such a row is to have one
     * from before. This writes one, and what is pinned is that the replay path reports the status it FINDS: a
     * `?? 200` applied one step too early would turn every pre-`B8` refusal into a success.
     */
    const f = await fixture();
    const key = randomUUID();
    await submitAnswer(prisma(), save(f, 'a', { idempotencyKey: key }), clockAt(T0));
    const refusal = { ok: false, reason: 'STALE_REVISION', isConflict: true };
    await prisma().answerRevision.updateMany({
      where: { attemptId: f.attemptId, idemKey: key },
      data: { responseStatus: 409, responseBody: refusal },
    });

    const replay = await submitAnswer(prisma(), save(f, 'a', { idempotencyKey: key }), clockAt(T0));
    expect(replay.outcome).toBe('replayed');
    expect(replay.status).toBe(409);
    expect(replay.body).toEqual(refusal);
  });

  it('does not let a REJECTED key become a replay: the same stale write, resent, is refused again', async () => {
    // The other half of `B8`. A refusal leaves no ledger row, so resending it is a fresh decision -- and a fresh
    // decision about the same stale revision is the same 409, not an idempotent success.
    const f = await fixture();
    await submitAnswer(prisma(), save(f, 'a'), clockAt(T0));

    const key = randomUUID();
    const stale = save(f, 'b', { idempotencyKey: key, expectedRevision: 0 });
    const first = await submitAnswer(prisma(), stale, clockAt(T0 + 1));
    const again = await submitAnswer(prisma(), stale, clockAt(T0 + 2));

    expect(first.outcome).toBe('rejected');
    expect(first.status).toBe(409);
    expect(again.outcome).toBe('rejected');
    expect(again.status).toBe(409);

    const after = await stored(f);
    expect(after.response?.answer).toEqual({ choiceId: 'a' });
    expect(after.revisions).toHaveLength(1);
  });
});

describe.skipIf(!process.env.DATABASE_URL)('a second device, against real Postgres', () => {
  it('refuses the device that is behind, hands it the server copy, and leaves the answer alone', async () => {
    // A follower is REFUSED, not warned: a 409 with the other device's answer, nothing written, and a record that it
    // happened. This is the guarantee `BroadcastChannel` cannot give, because it does not cross devices.
    const f = await fixture();
    await submitAnswer(prisma(), save(f, 'laptop'), clockAt(T0));
    const phone = await submitAnswer(prisma(), save(f, 'phone'), clockAt(T0 + 5_000));

    expect(phone.outcome).toBe('rejected');
    expect(phone.status).toBe(409);
    expect(phone.body).toMatchObject({
      reason: 'STALE_REVISION',
      isConflict: true,
      serverAnswer: { choiceId: 'laptop' },
      serverRevision: 1,
    });

    const after = await stored(f);
    expect(after.response?.answer).toEqual({ choiceId: 'laptop' });
    expect(after.revisions.map((row) => row.answerHash)).toEqual(['hash-laptop']);
    expect(
      await prisma().attemptEventRecord.count({ where: { attemptId: f.attemptId } }),
    ).toBeGreaterThanOrEqual(1);
  });

  /**
   * `ADV-DB2` -- KNOWN DEFECT in `answer-write.ts`, outside this lane.
   *
   * `submitAnswer`'s doc comment says "The transaction does four things in order". There is no transaction: the route
   * passes the bare client, and the function reads the revision, decides, and writes in separate statements with no
   * lock. Two devices that read before either writes BOTH decide "accept, revision 1".
   *
   * Both then upsert the response and both append revision 1, and the `(responseId, revision)` unique constraint
   * throws for the second. OBSERVED, three runs of three, when this was written: one caller is told `saved` and the
   * other gets an unhandled `PrismaClientKnownRequestError` (a 500, not a 409 with the server copy) -- and the stored
   * ANSWER is the one from the caller that threw, while the only REVISION row, which is what the receipt is folded
   * from, is from the caller that was told `saved`. So the device that saw a green tick does not hold the answer on
   * record, and the answer and its own audit trail disagree.
   *
   * ## HOW THE INTERLEAVING IS MADE DETERMINISTIC
   *
   * `racing()` wraps the one read that matters and holds each caller there until both have arrived. That is the whole
   * race, forced, against the real database. The wait is bounded by a real timer (`RELEASE_AFTER_MS`), which the
   * testing doctrine otherwise forbids; it is there so that a FIX which serialises the two callers -- the second never
   * reaches the read while the first holds a lock -- releases and passes instead of deadlocking into a timeout that
   * `it.fails` would then read as "still broken".
   */
  it('ADV-DB2: lets exactly one of two simultaneous writers win, and tells the other 409', async () => {
    const f = await fixture();
    const db = racing(prisma());

    const settled = await Promise.allSettled([
      submitAnswer(db, save(f, 'laptop'), clockAt(T0)),
      submitAnswer(db, save(f, 'phone'), clockAt(T0)),
    ]);

    // Neither caller may be answered with an exception.
    expect(settled.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
    const results = settled.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : [],
    );
    expect(results.map((result) => result.outcome).sort()).toEqual(['rejected', 'saved']);
    expect(results.find((result) => result.outcome === 'rejected')?.status).toBe(409);

    // And the answer that is stored is the one the ledger says was accepted.
    const after = await stored(f);
    expect(after.revisions).toHaveLength(1);
    const winner = after.revisions[0]?.answerHash === 'hash-laptop' ? 'laptop' : 'phone';
    expect(after.response?.answer).toEqual({ choiceId: winner });
  });
});

describe.skipIf(!process.env.DATABASE_URL)('INV-LATE-1, against real Postgres', () => {
  it('accepts a write before the attempt deadline, so the refusal below is about time and not the fixture', async () => {
    const f = await fixture({ deadlineAt: new Date(T0 + HOUR), gracePeriodSec: 0 });
    const result = await submitAnswer(prisma(), save(f, 'a'), clockAt(T0), 0);
    expect(result.outcome, JSON.stringify(result)).toBe('saved');
  });

  /**
   * `ADV-DB1` -- KNOWN DEFECT in `answer-write.ts`, outside this lane. **`INV-LATE-1` is not enforced for the attempt
   * deadline on the real write path.**
   *
   * `effectiveDeadline` computes `attempt.deadlineAt + added * 1000 + ...`. The row type says `deadlineAt: Millis`,
   * and the value Prisma returns for a `DateTime` column is a `Date`. `Date + number` is STRING CONCATENATION, so the
   * "deadline" is `'Sun Jan 15 2027 ...0'`, every comparison against it is against `NaN`, and `now > NaN` is false.
   * No write is ever past the attempt deadline. The same line adds `pausedAccumSec` -- seconds -- as milliseconds.
   *
   * A write ONE HOUR late with ZERO grace is saved, 200, `isLate: false`. A client with a slow clock, or one that
   * simply keeps sending, has no deadline at all.
   *
   * It survived because every existing test either calls `decideWrite` with a number, or drives `submitAnswer` with
   * an attempt that has no `deadlineAt`. The per-question deadline two lines below is read with `.getTime()` and is
   * unaffected.
   */
  it('ADV-DB1: rejects a write an hour past the attempt deadline, and keeps the last accepted value', async () => {
    const f = await fixture({ deadlineAt: new Date(T0), gracePeriodSec: 0 });
    // The value that must stand, written on time.
    await submitAnswer(prisma(), save(f, 'on-time'), clockAt(T0 - 1), 0);

    const late = await submitAnswer(
      prisma(),
      save(f, 'late', { expectedRevision: 1 }),
      clockAt(T0 + HOUR),
      0,
    );

    expect(late.outcome).toBe('rejected');
    expect(late.body).toMatchObject({ reason: 'ATTEMPT_DEADLINE_PASSED' });
    // Rejected, not zeroed and not overwritten.
    const after = await stored(f);
    expect(after.response?.answer).toEqual({ choiceId: 'on-time' });
    expect(after.revisions).toHaveLength(1);
  });
});

/** How long `racing()` waits for the second reader before letting the first go. See `ADV-DB2`. */
const RELEASE_AFTER_MS = 1_000;

/**
 * The real client, with ONE read held until two callers have made it.
 *
 * Everything else is passed straight through to Postgres. Built as a plain object and not a `Proxy` over the client,
 * because Prisma's delegates are themselves proxies and wrapping one in another changes what `this` they see.
 */
const racing = (db: PrismaClient): SubmitDb => {
  let arrived = 0;
  let release: () => void = () => undefined;
  const both = new Promise<void>((resolve) => {
    release = resolve;
  });
  const patience = new Promise<void>((resolve) => {
    setTimeout(resolve, RELEASE_AFTER_MS);
  });

  /**
   * A REAL TRANSACTION, AND THE FIRST VERSION OF THIS SHIM MADE THE FIX LOOK LIKE IT HAD MADE THINGS WORSE.
   *
   * `$transaction: (fn) => fn(shim)` -- passing the shim straight through, no real transaction -- is what I wrote
   * first. It produced `['rejected', 'fulfilled']`: `Unique constraint failed on (responseId, revision)`, because
   * **`SELECT ... FOR UPDATE` only holds for the life of its transaction**, and with no transaction each statement ran
   * on its own pooled connection, taking and releasing the lock immediately. The lock was a no-op and the constraint
   * did the work, which is exactly the race ADV-DB2 is about.
   *
   * Two things worth keeping from that:
   *
   * - **The `(responseId, revision)` unique constraint IS the real guard against a duplicate revision.** It was never
   *   mentioned in this file's header, and it is the reason the original defect surfaced as an *exception* rather than
   *   as silent corruption. The constraint was doing its job; the defect was that the loser got an exception instead
   *   of a decision.
   * - **A fixture that stubs the mechanism under test cannot test it.** The barrier below is still there to force an
   *   interleave if the lock is ever removed, but the serialisation is now the database's.
   */
  const decorate = (tx: SubmitDb): SubmitDb => {
    const questionResponse = {
      findUnique: async (args: Parameters<PrismaClient['questionResponse']['findUnique']>[0]) => {
        const row = await tx.questionResponse.findUnique(args);
        arrived += 1;
        if (arrived >= 2) release();
        await Promise.race([both, patience]);
        return row;
      },
      upsert: (args: Parameters<PrismaClient['questionResponse']['upsert']>[0]) =>
        tx.questionResponse.upsert(args),
    };
    return { ...tx, questionResponse } as unknown as SubmitDb;
  };

  return {
    assessmentSlot: db.assessmentSlot,
    examAttempt: db.examAttempt,
    answerRevision: db.answerRevision,
    attemptEventRecord: db.attemptEventRecord,
    questionResponse: db.questionResponse,
    $queryRawUnsafe: (query: string, ...values: unknown[]) =>
      (db.$queryRawUnsafe as (...args: unknown[]) => Promise<unknown>)(query, ...values),
    // The REAL one. `tx` is Prisma's transaction handle, so `FOR UPDATE` is held until the callback returns.
    $transaction: <T>(fn: (tx: SubmitDb) => Promise<T>): Promise<T> =>
      db.$transaction((tx) => fn(decorate(tx as unknown as SubmitDb))) as Promise<T>,
  } as unknown as SubmitDb;
};

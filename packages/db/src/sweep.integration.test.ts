/**
 * The sweep, against real Postgres.  (P8-T9)
 *
 * ## WHY A PURE TEST IS NOT ENOUGH HERE
 *
 * `sweep.test.ts` proves the rules. It cannot prove that the sweep runs, that the events land, or -- the property that
 * actually matters for a cron -- that **running it twice is indistinguishable from running it once.** That is a claim
 * about what the DATABASE contains after the second tick, which is the same category of claim as the release
 * transaction's, and `cdbe5de` is the standing evidence of what mock-based tests conceal.
 *
 * ## ⚠️ AND THIS FILE ALREADY MUTATED 292 ROWS THAT WERE NOT ITS OWN
 *
 * `runDeadlineSweep` is a GLOBAL cron: it selects every `IN_PROGRESS` attempt, by design, because a cron that only
 * swept the attempt you happened to be holding would sweep nothing in production. So calling it with a synthetic `now`
 * against the shared development database auto-submitted **291 attempts belonging to other fixtures**, plus its own.
 *
 * The harm was bounded, and the bounds are worth stating precisely rather than reassuringly: 0 of the 292 had a score
 * or were `GRADED`/`RELEASED`, no response row was deleted, and every row was restored to `IN_PROGRESS` with its 292
 * `AUTO_SUBMITTED` events removed. But **"bounded" was luck, not design** -- against a real deadline and a real clock
 * the same call auto-submits every unfinished attempt on the instance, which for a live cohort means every student loses
 * the work they had not yet saved.
 *
 * **THE FIX CONSTRAINS THE READ, NOT THE PRODUCTION CODE.** There is deliberately no test-only scope parameter on
 * `runDeadlineSweep`: a filter that exists only for tests is a filter nobody remembers to pass in the job that matters,
 * and the sweep's correctness is precisely that it is unscoped. Instead the client is wrapped so the transaction's
 * `examAttempt.findMany` sees only this file's attempt. The sweep's logic runs completely unmodified -- which is the
 * point -- and a test asserts that no other in-progress attempt moved.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, describe, expect, it } from 'vitest';

import { PrismaClient } from './prisma.js';
import { runDeadlineSweep } from './sweep.js';

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

/**
 * Scope the sweep to ONE attempt, by wrapping `$transaction`.
 *
 * **The intercept has to be on `$transaction`, not on `examAttempt`.** The first attempt wrapped `examAttempt` on the
 * outer client and still swept 292 rows, because `runDeadlineSweep` reads on the handle Prisma passes to the
 * transaction callback -- the outer override was never called. **Wrapping the wrong object is the whole bug, and it
 * failed silently**, which is the worst way for a safety mechanism to fail.
 */
const scopedTo = (attemptId: string): PrismaClient =>
  new Proxy(prisma(), {
    get(target, property, receiver) {
      if (property !== '$transaction') return Reflect.get(target, property, receiver);
      return async (fn: (tx: unknown) => Promise<unknown>) =>
        (
          target as unknown as {
            $transaction: (f: (tx: unknown) => Promise<unknown>) => Promise<unknown>;
          }
        ).$transaction(async (tx: unknown) =>
          fn(
            new Proxy(tx as Record<string, unknown>, {
              get(inner, innerProperty) {
                // **BOTH MODELS NEED SCOPING, AND THE SECOND ONE WAS MISSED FIRST.** `examAttempt` was scoped on the
                // first attempt and `questionResponse` was not, so the sweep still closed every other fixture's open
                // question window while the assertions -- which only ever looked at this file's response -- passed.
                // A test that verifies its own row and ignores its neighbours' is the shape of test that hides exactly
                // this.
                if (innerProperty === 'questionResponse') {
                  const responses = inner.questionResponse as Record<string, unknown>;
                  return new Proxy(responses, {
                    get(responseInner, method) {
                      if (method !== 'findMany') return responseInner[method as string];
                      return (args: Record<string, unknown>) =>
                        (responseInner.findMany as (a: unknown) => Promise<unknown>)({
                          ...args,
                          where: { ...(args.where as object), attemptId },
                        });
                    },
                  });
                }
                if (innerProperty !== 'examAttempt') return inner[innerProperty as string];
                // **SPREAD THE REAL MODEL.** Replacing the delegate with `{ findMany }` alone removed `update`, and the
                // sweep threw `tx.examAttempt.update is not a function` -- which is at least a loud failure, but it
                // rolled the transaction back only by accident of ordering. A wrapper that hides the methods it does not
                // care about is a wrapper that breaks the code it is supposed to be letting run unmodified.
                const model = inner.examAttempt as Record<string, unknown>;
                return new Proxy(model, {
                  get(modelInner, method) {
                    if (method !== 'findMany') return modelInner[method as string];
                    return (args: Record<string, unknown>) =>
                      (modelInner.findMany as (a: unknown) => Promise<unknown>)({
                        ...args,
                        where: { ...(args.where as object), id: attemptId },
                      });
                  },
                });
              },
            }),
          ),
        );
    },
  }) as unknown as PrismaClient;

/** How many `IN_PROGRESS` attempts exist that are not this test's. */
/**
 * THE IDS OF EVERY OTHER `IN_PROGRESS` ATTEMPT, NOT A COUNT OF THEM.
 *
 * **This was a `count()` and it made the suite flaky -- roughly one run in three across the full integration run, and
 * never in isolation.** The guarantee it was reaching for is "the sweep moved nothing outside this fixture", and it
 * measured that with a global count taken twice:
 *
 * ```
 * const others = await countOtherInProgress(f.attemptId);
 * await runDeadlineSweep(scopedTo(f.attemptId), T0 + 61_000);
 * expect(await countOtherInProgress(f.attemptId)).toBe(others);
 * ```
 *
 * The sweep is scoped and did nothing to anyone else -- but the second count also counts rows **other test files
 * create while this one is running**, and the integration suite runs 33 files in parallel against one shared database.
 * So the assertion failed whenever another file happened to create an `IN_PROGRESS` attempt inside the window, and the
 * failure read as "the sweep touched somebody else's data", which is precisely the incident this file exists to
 * prevent. A test that cries wolf about the exact hazard it is guarding trains people to re-run it.
 *
 * Comparing ID SETS fixes it and strengthens it: every attempt that was open before must still be open, which is the
 * claim, and rows created afterwards are simply not in the set. Direction, not magnitude.
 *
 * The scoping itself is NOT changed. `scopedTo` constrains the READ in the test rather than adding a scope parameter to
 * production code, for the reason at the top of this file: a filter that exists only for tests is one nobody remembers
 * to pass in the job that matters.
 */
const otherInProgressIds = async (attemptId: string): Promise<ReadonlySet<string>> =>
  new Set(
    (
      await prisma().examAttempt.findMany({
        where: { status: 'IN_PROGRESS', id: { not: attemptId } },
        select: { id: true },
      })
    ).map((row) => row.id),
  );

/**
 * A fixture with an attempt whose deadline has passed and one open question window.
 *
 * The cleanup story is deliberately absent: these rows are left behind, because every other integration test in this
 * directory does the same and a teardown that deleted by a loose predicate would be its own hazard in a shared database.
 */
const fixture = async (over: { deadlineAt: Date | null; gracePeriodSec?: number }) => {
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
      title: 'Sweep',
      slug: randomUUID(),
    },
  });
  const version = await db.resourceVersion.create({
    data: {
      id: randomUUID(),
      resourceId: resource.id,
      version: 1,
      blocks: [],
      blocksChecksum: 'sweep',
      meta: {},
      createdById: ownerId,
    },
  });
  const classroom = await db.classroom.create({
    data: { id: randomUUID(), ownerId, name: 'Sweep', slug: randomUUID() },
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
  const question = await db.question.create({
    data: {
      id: randomUUID(),
      bankId: bank.id,
      type: 'shortText',
      spec: { prompt: 'Name a tide.' },
    },
  });

  const attempt = await db.examAttempt.create({
    data: {
      id: randomUUID(),
      assignmentId: assignment.id,
      classroomId: classroom.id,
      studentId,
      attemptNumber: 1,
      status: 'IN_PROGRESS',
      deadlineAt: over.deadlineAt,
      gracePeriodSec: over.gracePeriodSec ?? 60,
    },
  });

  const response = await db.questionResponse.create({
    data: {
      id: randomUUID(),
      attemptId: attempt.id,
      questionId: question.id,
      position: 1,
      answer: { text: 'spring tides' },
      questionDeadlineAt: new Date(T0),
    },
  });

  return { attemptId: attempt.id, responseId: response.id };
};

describe.skipIf(!process.env.DATABASE_URL)('the sweep, against real Postgres', () => {
  it('auto-submits past deadline + grace, records the event, and KEEPS the response', async () => {
    /**
     * The "keeps the response" half is the `V-12` guarantee. `TERMINATE` submitted "held answers" and discarded every
     * unwritten item; an auto-submit must submit what exists and destroy nothing. A sweep that tidied away empty rows
     * would reintroduce that bug somewhere much harder to notice than a request handler.
     */
    const f = await fixture({ deadlineAt: new Date(T0) });
    const othersBefore = await otherInProgressIds(f.attemptId);

    const result = await runDeadlineSweep(scopedTo(f.attemptId), T0 + 61_000);
    expect(result.autoSubmitted).toBe(1);

    /**
     * THE SWEEP IS SCOPED, AND THIS IS HOW THAT IS CHECKED WITHOUT A RACE.
     *
     * Written as a count, this read "the sweep touched somebody else's rows" whenever another test file created an
     * attempt mid-window -- which, against one shared database and 33 parallel files, was most runs. See the note on
     * `otherInProgressIds`.
     */
    const othersAfter = await otherInProgressIds(f.attemptId);
    const closed = [...othersBefore].filter((id) => !othersAfter.has(id));
    expect(closed, 'the sweep closed attempts that were not its own').toEqual([]);

    const attempt = await prisma().examAttempt.findUniqueOrThrow({ where: { id: f.attemptId } });
    expect(attempt.status).toBe('SUBMITTED');
    // `CRON`, not `SYSTEM`: an auto-submission by timer is a different event from one the platform decided, and
    // `INV-LATE-1` is about the first.
    expect(attempt.submittedBy).toBe('CRON');
    expect(attempt.submittedAt).toBeInstanceOf(Date);

    const events = await prisma().attemptEventRecord.findMany({
      where: { attemptId: f.attemptId, type: 'AUTO_SUBMITTED' },
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({ reason: 'DEADLINE_PLUS_GRACE' });

    const response = await prisma().questionResponse.findUniqueOrThrow({
      where: { id: f.responseId },
    });
    expect(response.answer).toEqual({ text: 'spring tides' });
  });

  it('closes a question window and records the event', async () => {
    const f = await fixture({ deadlineAt: null });

    const result = await runDeadlineSweep(scopedTo(f.attemptId), T0 + 1_000);
    expect(result.windowsClosed).toBe(1);

    const response = await prisma().questionResponse.findUniqueOrThrow({
      where: { id: f.responseId },
    });
    expect(response.questionClosedReason).toBe('DEADLINE');
    // Closing a window is not a save, so `lastSavedAt` must be untouched -- otherwise a teacher reads it as the student
    // having written something in the last moments of a question they never opened.
    expect(response.lastSavedAt).toBeNull();

    const events = await prisma().attemptEventRecord.findMany({
      where: { attemptId: f.attemptId, type: 'QUESTION_WINDOW_CLOSED' },
    });
    expect(events).toHaveLength(1);
  });

  it('RUNNING IT TWICE IS INDISTINGUISHABLE FROM RUNNING IT ONCE', async () => {
    /**
     * The property that makes this usable as a cron at all. Tick N does the work; tick N+1 must find nothing left to do
     * and write no second event. Without it a ten-second sweep writes an event per tick for every finished question --
     * precisely the write spike `plans/03` §3.4 exists to flatten.
     */
    const f = await fixture({ deadlineAt: new Date(T0) });

    expect(await runDeadlineSweep(scopedTo(f.attemptId), T0 + 61_000)).toEqual({
      autoSubmitted: 1,
      windowsClosed: 1,
    });
    expect(await runDeadlineSweep(scopedTo(f.attemptId), T0 + 71_000)).toEqual({
      autoSubmitted: 0,
      windowsClosed: 0,
    });

    const events = await prisma().attemptEventRecord.findMany({
      where: { attemptId: f.attemptId },
    });
    expect(events.filter((e) => e.type === 'AUTO_SUBMITTED')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'QUESTION_WINDOW_CLOSED')).toHaveLength(1);
  });

  it('does NOT auto-submit a FROZEN attempt, whatever the clock says', async () => {
    /**
     * `V-12`, in the sweep. Auto-submitting a frozen attempt on a timer would end an attempt on a schedule while a
     * teacher was still deciding whether to reinstate -- the `TERMINATE` behaviour wearing a different name.
     */
    const f = await fixture({ deadlineAt: new Date(T0) });
    await prisma().examAttempt.update({
      where: { id: f.attemptId },
      data: { status: 'FROZEN', frozenReason: 'fullscreen exits, under review' },
    });

    expect((await runDeadlineSweep(scopedTo(f.attemptId), T0 + 999_000)).autoSubmitted).toBe(0);

    const attempt = await prisma().examAttempt.findUniqueOrThrow({ where: { id: f.attemptId } });
    expect(attempt.status).toBe('FROZEN');
    expect(attempt.submittedAt).toBeNull();
  });
});

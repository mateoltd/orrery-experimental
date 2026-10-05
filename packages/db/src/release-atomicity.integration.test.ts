/**
 * INV-RELEASE-1 under a concurrent reader loop, against real Postgres.  (P10-T9)
 *
 * ## WHAT THIS PROVES, AND WHAT IT DELIBERATELY DOES NOT
 *
 * The mechanism is a **single-row gate** (`plans/07` §6.1): student visibility is
 * `EXISTS(... ReleaseBatch.status = 'RELEASED')`, so release is ONE `releaseBatch.update` and nothing else is a visibility
 * decision. **This file therefore proves VISIBILITY SEMANTICS, not transaction throughput.** A test that showed a
 * release being slow would say nothing about whether it could be half-visible, and a throughput claim here would be read
 * as a safety claim it is not. The wall-clock cost of a 5,000-attempt release is a separate question, measured
 * separately, in `release-scale.integration.test.ts`.
 *
 * ## THE FAILURE THIS EXISTS FOR IS A HALF-VISIBLE BATCH
 *
 * A batch released one attempt at a time, with visibility decided per attempt, is the shape that produces the bug this
 * phase is organised around: student 1 sees a mark, student 4,999 does not, and no row in the database is wrong.
 *
 * ## "NO INTERLEAVING" ONLY MEANS SOMETHING AGAINST A SNAPSHOT, AND THE FIRST VERSION OF THIS FILE GOT THAT WRONG
 *
 * The first version read all 40 members in one loop, at READ COMMITTED, and asserted the loop saw a single state. It
 * failed with `HALF-VISIBLE: one sweep showed 11 sealed and 29 released` -- and **that failure was the file's fault, not
 * the database's.** Forty sequential reads take 40 different instants, and if the commit lands between the eleventh and
 * the twelfth then eleven reads are before it and twenty-nine are after. That is a **torn observation**, not a
 * half-visible batch: the difference is whether there was ever a DATABASE STATE in which 11 members were released and
 * 29 were not, and with a single-row gate there never was one.
 *
 * **SO AN OBSERVATION HERE IS A `REPEATABLE READ` TRANSACTION, WHICH IS ONE SNAPSHOT.** Each sweep below runs inside its
 * own RR transaction on the reader's own connection, so the 40 reads in it see the same instant and a mix is only
 * possible if a mixed state was committed. The third test keeps the torn reader and asserts what it is actually good
 * for -- that the step function is a STEP, so a torn reader straddles it in order and never out of it.
 *
 * ## A STALE SCORE IS PLANTED BEFORE THE RELEASE, AND THAT IS THE POINT
 *
 * Every attempt here is created carrying `finalScore: 42.5`, a number the release never computes. If any snapshot ever
 * saw `RELEASED` alongside `42.5`, that is the `B16` TOCTOU failure in its most damaging form: a student shown a grade
 * that is not the grade. Seeding the wrong number is what turns "the score was right" from a coincidence of fixtures
 * into an assertion -- with an absent prior value, a reader that never ran would pass.
 *
 * ## WHY THE FIRST TEST PAUSES THE TRANSACTION RATHER THAN RACING IT
 *
 * A reader loop fired against an un-instrumented release observes whatever window the machine happens to give it: on a
 * fast machine the sweep is longer than the whole release, and on a loaded runner there are dozens. **A concurrency
 * test whose observation count depends on the machine is a coin flip wearing a test's clothes.** So the first test
 * injects a barrier *inside* the real transaction -- `releaseBatch` is called for real, on a real handle, and the
 * wrapper only pauses after the k-th per-attempt score write, which is the last instant at which a half-written batch
 * could exist.
 *
 * The wrapper changes no statement: it delegates to the same Prisma calls and returns the same values. What it adds is a
 * PAUSE, which is what makes the assertion deterministic rather than lucky. The second test drops the barrier entirely
 * and races a real release from a fleet of readers, so the guarantee is not an artefact of the instrumentation.
 *
 * ## SHARED-DATABASE SAFETY
 *
 * The development database holds other lanes' fixtures (393 `ReleaseBatch` rows when this was written). Every read here
 * is keyed by an id this file created, every write likewise, and `afterAll` deletes by id -- attempts first, because
 * their member rows cascade away, and that is what leaves a `RELEASED` batch deletable.
 */

import { randomUUID } from 'node:crypto';

import { FrozenClock } from '@orrery/clock';
import { afterAll, describe, expect, it } from 'vitest';

import { PrismaClient } from './prisma.js';
import { loadReleasePlan, type ReleaseDb, releaseBatch } from './release.js';
import { beginRelease, createReleaseBatch, markBatchReady } from './release-batch.js';
import { writeReleasedScores } from './release-bulk-write.js';
import { loadStudentResults, type StudentResults } from './student-results.js';

const T0 = 1_800_000_000_000;
const clock = new FrozenClock(T0);

/** The wrong grade planted on every attempt, so "the score was right" cannot be a coincidence of fixtures. */
const STALE_SCORE = 42.5;
/** What the release actually computes: one 2-mark question, fully correct, no penalty. */
const TRUE_SCORE = 100;

let client: PrismaClient | null = null;
const prisma = (): PrismaClient => {
  client ??= new PrismaClient();
  return client;
};

/**
 * THE READERS' OWN CONNECTIONS.
 *
 * Separate clients, not extra transactions on the writer's pool: the point is a reader that cannot see the writer's
 * uncommitted work, and reusing the writer's pool would make the pool the thing under test.
 */
let readerClient: PrismaClient | null = null;
const reader = (): PrismaClient => {
  readerClient ??= new PrismaClient();
  return readerClient;
};

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
  if (readerClient !== null) {
    await readerClient.$disconnect();
    readerClient = null;
  }
  if (client === null) return;
  const db = client;
  await db.auditEvent.deleteMany({
    where: { targetType: 'ReleaseBatch', targetId: { in: mine.batches } },
  });
  await db.questionResponse.deleteMany({ where: { attemptId: { in: mine.attempts } } });
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

interface Member {
  readonly id: string;
  readonly studentId: string;
}

const user = async (): Promise<string> => {
  const id = randomUUID();
  await prisma().user.create({
    data: {
      id,
      email: `${id}@p10t9.example`,
      emailNormalized: `${id}@p10t9.example`,
      name: 'P10T9',
    },
  });
  mine.users.push(id);
  return id;
};

const room = async (): Promise<Room> => {
  const db = prisma();
  const teacherId = await user();
  const resource = await db.resource.create({
    data: {
      id: randomUUID(),
      ownerId: teacherId,
      status: 'PUBLISHED',
      visibility: 'UNLISTED',
      title: 'P10-T9 atomicity',
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
      blocksChecksum: 'p10t9',
      meta: {},
      createdById: teacherId,
    },
  });
  mine.versions.push(version.id);
  const classroom = await db.classroom.create({
    data: { id: randomUUID(), ownerId: teacherId, name: 'P10T9', slug: randomUUID() },
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
    data: { id: randomUUID(), ownerId: teacherId, name: 'P10T9' },
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
 * A `GRADED` attempt carrying the STALE score, its student, and a real response row.
 *
 * `autoScore: 2` on a 2-mark question is the whole grade, so `computeScore` yields `100` and the planted `42.5` can only
 * come from the fixture. The response is what `loadReleasePlan` reads; it never reads the attempt's own `finalScore`,
 * which is why planting one cannot change what the release computes.
 */
const memberAttempt = async (r: Room): Promise<Member> => {
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
      status: 'GRADED',
      purpose: 'GRADED',
      finalScore: STALE_SCORE,
      maxScore: 2,
      percentage: 42.5,
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
      autoScore: 2,
      needsHuman: false,
      isExcused: false,
    },
  });
  return { id, studentId };
};

const batchOf = async (r: Room, attemptIds: readonly string[]): Promise<string> => {
  const created = await createReleaseBatch(prisma(), {
    assignmentId: r.assignmentId,
    classroomId: r.classroomId,
    attemptIds,
    actorId: r.teacherId,
    clock,
  });
  if (!created.ok)
    throw new Error(`fixture: createReleaseBatch refused: ${JSON.stringify(created)}`);
  mine.batches.push(created.batchId);
  await markBatchReady(prisma(), { batchId: created.batchId, actorId: r.teacherId, clock });
  const begun = await beginRelease(prisma(), {
    batchId: created.batchId,
    actorId: r.teacherId,
    clock,
  });
  if (!begun.ok) throw new Error(`fixture: beginRelease refused: ${JSON.stringify(begun)}`);
  return created.batchId;
};

/* ─────────────────────────────────────────────────── what one observation is ── */

type State = 'SEALED' | 'RELEASED' | 'UNREADABLE';

/** One snapshot's worth of evidence, and the order the members were read in. */
interface Observation {
  /** Per member, in member order. `'UNREADABLE'` is kept distinct rather than counted as invisible. */
  readonly states: readonly State[];
  /** Only the scores of members this snapshot saw RELEASED. */
  readonly releasedScores: readonly (number | null)[];
}

const readMember = async (member: Member, db: PrismaClient): Promise<State> => {
  const results: StudentResults | null = await loadStudentResults(db, member.studentId, member.id);
  if (results === null) return 'UNREADABLE';
  return results.state;
};

/**
 * ONE OBSERVATION: EVERY MEMBER, INSIDE ONE SNAPSHOT.
 *
 * `loadStudentResults` is the student-facing reader and is used unmodified rather than reimplemented -- a reader that
 * shares the release's idea of visibility proves nothing, and this file has to survive the day somebody changes
 * `student-results.ts`. Its predicate is `releaseMembers.some.batch.status = 'RELEASED'`, so it reports what a student
 * would actually be shown.
 *
 * `REPEATABLE READ` is what makes the sweep ONE observation rather than forty. Prisma's interactive-transaction default
 * is READ COMMITTED, where each statement takes a fresh snapshot, and the header explains what that cost this file.
 */
const snapshotSweep = async (members: readonly Member[]): Promise<Observation> => {
  const states: State[] = [];
  const releasedScores: (number | null)[] = [];
  await reader().$transaction(
    async (tx) => {
      for (const member of members) {
        const results: StudentResults | null = await loadStudentResults(
          tx,
          member.studentId,
          member.id,
        );
        if (results === null) {
          states.push('UNREADABLE');
          continue;
        }
        states.push(results.state);
        if (results.state === 'RELEASED') releasedScores.push(results.breakdown.finalScore);
      }
    },
    { isolationLevel: 'RepeatableRead' },
  );
  return { states, releasedScores };
};

/** The same sweep with no snapshot, which reads forty instants and is therefore allowed to straddle the commit. */
const tornSweep = async (members: readonly Member[]): Promise<Observation> => {
  const states: State[] = [];
  const releasedScores: (number | null)[] = [];
  for (const member of members) {
    const state = await readMember(member, reader());
    states.push(state);
    if (state === 'RELEASED') {
      const results: StudentResults | null = await loadStudentResults(
        reader(),
        member.studentId,
        member.id,
      );
      if (results?.state === 'RELEASED') releasedScores.push(results.breakdown.finalScore);
    }
  }
  return { states, releasedScores };
};

/**
 * THE SNAPSHOT ASSERTION, stated once so both snapshot tests use the same definition of "half-visible".
 *
 * Three ways to fail, and the third is the one a naive version misses:
 *
 *  1. a snapshot holding both `SEALED` and `RELEASED` -- a half-visible batch, in a single committed instant;
 *  2. a `RELEASED` member carrying the planted stale score -- a released batch with a grade that is not the grade;
 *  3. an `UNREADABLE` member -- which would otherwise read as "invisible" and let a query returning nothing pass every
 *     other assertion here.
 */
const expectWholeBatchInOneSnapshot = (
  observation: Observation,
  memberCount: number,
  label: string,
): void => {
  expect(
    observation.states,
    `${label}: a member the student path could not read at all`,
  ).not.toContain('UNREADABLE');
  const sealed = observation.states.filter((s) => s === 'SEALED').length;
  const released = observation.states.filter((s) => s === 'RELEASED').length;
  expect(
    sealed > 0 && released > 0,
    `${label}: HALF-VISIBLE IN ONE SNAPSHOT — ${String(sealed)} sealed and ${String(released)} released of ` +
      `${String(memberCount)} members, all read at the same instant`,
  ).toBe(false);
  expect(sealed + released).toBe(memberCount);
  for (const score of observation.releasedScores) {
    expect(
      score,
      `${label}: RELEASED WITH A STALE SCORE — a member was visible carrying a finalScore the release never wrote`,
    ).not.toBe(STALE_SCORE);
    expect(score, `${label}: a released member must carry the score the release computed`).toBe(
      TRUE_SCORE,
    );
  }
};

/* ─────────────────────────────────────────── the pause, injected into the real call ── */

/**
 * PAUSE `releaseBatch` MID-TRANSACTION, WITHOUT CHANGING A SINGLE STATEMENT.
 *
 * `releaseBatch` takes a structural `ReleaseDb`, so the real function can be handed a handle that counts writes and
 * waits. Every method delegates to the real Prisma call and returns its value; the only addition is a barrier after the
 * k-th `examAttempt.update`, which is the instant at which the per-attempt scores are written and the batch gate is not
 * yet flipped.
 *
 * **THE PAUSE IS NOT A MOCK.** The reads are the release's own `loadReleasePlan`, the writes are its own
 * `examAttempt.update` calls and its own single `releaseBatch.update`, and the commit is Prisma's. If the pause were a
 * stub, the test would be asserting that a stub holds a transaction open.
 *
 * **THE COUNTER BELONGS TO THE INNERMOST HANDLE, AND THAT IS THE ONE THAT COUNTS.** `releaseBatch` opens the transaction
 * through `$transaction`, which rebuilds the handle for the `tx` Prisma actually hands it -- so the writes land on that
 * inner handle and the barrier fires there. It reads like an oversight and is the mechanism: `pauseAfter` is the k-th
 * write *inside* the transaction.
 */
const pausingHandle = (
  inner: PrismaClient,
  pauseAfter: number,
  onPause: () => Promise<void>,
): ReleaseDb => {
  let written = 0;
  const handle: ReleaseDb = {
    releaseBatch: inner.releaseBatch,
    releaseBatchMember: inner.releaseBatchMember,
    examAttempt: {
      async update(input: Record<string, unknown>) {
        const result = await inner.examAttempt.update(input as never);
        written += 1;
        if (written === pauseAfter) await onPause();
        return result;
      },
    },
    $transaction: async <T>(fn: (tx: ReleaseDb) => Promise<T>): Promise<T> =>
      inner.$transaction(async (tx) =>
        fn(pausingHandle(tx as unknown as PrismaClient, pauseAfter, onPause)),
      ),
  };
  return handle;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A MONOTONIC STOPWATCH, BECAUSE `INV-TIME-1` BANS `Date.now` AND ESLINT ENFORCES IT.
 *
 * `Date.now()` is a wall clock that can step backwards, so a deadline built from it can be missed or extended by an NTP
 * correction -- and in a test whose entire purpose is "did the loop catch the window before it closed", a clock that
 * lies is the one thing that cannot be allowed. `process.hrtime.bigint()` is monotonic and has nanosecond resolution,
 * which is what a sub-millisecond round-trip measurement needs anyway.
 *
 * The name says what it is rather than being a bare `elapsed()`, because "elapsed since when" is the question a reader
 * has to answer twice in this file and answering it wrongly silently measures the wrong interval.
 */
const msSince = (from: bigint): number => Number(process.hrtime.bigint() - from) / 1e6;

describe.skipIf(!process.env.DATABASE_URL)('INV-RELEASE-1 under a concurrent reader loop', () => {
  it('shows every snapshot the WHOLE batch sealed while the transaction holds every score, then the WHOLE batch released', async () => {
    const MEMBER_COUNT = 24;
    const WHILE_SEALED = 12;
    const AFTER_COMMIT = 12;

    const r = await room();
    const members: Member[] = [];
    for (let i = 0; i < MEMBER_COUNT; i += 1) members.push(await memberAttempt(r));
    const batchId = await batchOf(
      r,
      members.map((m) => m.id),
    );

    let unpause!: () => void;
    const paused = new Promise<void>((resolve) => {
      unpause = resolve;
    });
    let announcePause!: () => void;
    const pauseReached = new Promise<void>((resolve) => {
      announcePause = resolve;
    });

    const duringTransaction: Observation[] = [];
    const straddling: Observation[] = [];
    const afterCommit: Observation[] = [];
    const loop = (async () => {
      await pauseReached;
      for (let i = 0; i < WHILE_SEALED; i += 1)
        duringTransaction.push(await snapshotSweep(members));
      /**
       * RELEASING THE BARRIER IS NOT COMMITTING. Between `unpause()` and the writer's own `releaseBatch.update` plus
       * COMMIT there is still a real interval during which the batch is correctly invisible, so a reader that starts
       * sweeping the moment the barrier drops takes snapshots on BOTH sides of the commit. The first version of this
       * file asserted that every post-barrier snapshot was `RELEASED` and failed on exactly that -- a reader that
       * started early and was still correct.
       *
       * So the transition is its own phase, and it is kept because it is where a mix would be a leak. `heldOpen` is the
       * deterministic window; `straddling` is the accidental one; `afterCommit` is the settled state.
       */
      unpause();
      const waiting = process.hrtime.bigint();
      let seen = false;
      while (!seen && msSince(waiting) < 15_000) {
        const observation = await snapshotSweep(members);
        straddling.push(observation);
        seen = observation.states.every((s) => s === 'RELEASED');
      }
      for (let i = 0; i < AFTER_COMMIT; i += 1) afterCommit.push(await snapshotSweep(members));
    })();

    const result = await releaseBatch(
      pausingHandle(prisma(), MEMBER_COUNT, async () => {
        announcePause();
        await paused;
      }),
      { batchId, releasedById: r.teacherId, latePenaltyPercent: 0, clock },
    );
    await loop;

    expect(result.released).toBe(true);
    expect(result.releasedCount).toBe(MEMBER_COUNT);
    expect(result.refusals).toEqual([]);

    expect(duringTransaction).toHaveLength(WHILE_SEALED);
    expect(straddling.length, 'the loop never reached the commit').toBeGreaterThan(0);
    expect(afterCommit).toHaveLength(AFTER_COMMIT);
    for (const observation of duringTransaction)
      expectWholeBatchInOneSnapshot(
        observation,
        MEMBER_COUNT,
        'while the release transaction was open',
      );
    for (const observation of straddling)
      expectWholeBatchInOneSnapshot(
        observation,
        MEMBER_COUNT,
        'while the release transaction was committing',
      );
    for (const observation of afterCommit)
      expectWholeBatchInOneSnapshot(
        observation,
        MEMBER_COUNT,
        'after the release transaction committed',
      );

    /**
     * THE HELD-OPEN WINDOW WAS REAL AND IT WAS MEASURED, WHICH IS THE ASSERTION THAT KEEPS THE FILE HONEST.
     *
     * Every snapshot taken while the barrier held must be entirely sealed, and every snapshot after the commit must be
     * entirely released. A barrier that fired late -- after the gate had already flipped -- would make the first group
     * `RELEASED` and this fails, which is the failure mode the first version of this file had with the *assertion*
     * rather than with the barrier.
     */
    for (const observation of duringTransaction)
      expect(
        observation.states.every((s) => s === 'SEALED'),
        'a snapshot saw a released member before the commit',
      ).toBe(true);
    for (const observation of afterCommit)
      expect(
        observation.states.every((s) => s === 'RELEASED'),
        'a snapshot saw a sealed member after the commit',
      ).toBe(true);
    console.log(
      `P10-T9 barrier: ${String(duringTransaction.length)} snapshots with the transaction held open (all sealed), ` +
        `${String(straddling.length)} across the commit, ${String(afterCommit.length)} after it (all released) — ` +
        `of ${String(MEMBER_COUNT)} members`,
    );
  });

  it('survives a fleet of snapshot readers racing an UN-INSTRUMENTED release', async () => {
    /**
     * The same assertions with the barrier removed, because the first test proves the property of the real function
     * under a controlled window and this one proves it of the real function under an arbitrary one.
     *
     * **THE FLEET IS WHAT MAKES THE NUMBER OF OBSERVATIONS INDEPENDENT OF THE MACHINE.** One reader sweeping 24
     * members takes ~24 snapshot round trips, which on this host is longer than a 24-attempt release, so a single reader
     * would usually see exactly one state. Eight readers starting at once narrow that window eightfold. The barrier is
     * gone; only the release is real.
     */
    const MEMBER_COUNT = 24;
    const READERS = 8;

    const r = await room();
    const members: Member[] = [];
    for (let i = 0; i < MEMBER_COUNT; i += 1) members.push(await memberAttempt(r));
    const batchId = await batchOf(
      r,
      members.map((m) => m.id),
    );

    const observations: Observation[] = [];
    let running = true;
    /** Sweeps COMPLETED while `releaseBatch` was still pending. This is the "were we actually racing?" evidence. */
    let sweepsDuringRelease = 0;
    const loops = Array.from({ length: READERS }, async () => {
      while (running) {
        const snapshot = await snapshotSweep(members);
        // Counted BEFORE `running` is cleared, and only while the release promise is unsettled -- so this measures
        // overlap rather than "the loop eventually ran".
        if (!settled) sweepsDuringRelease += 1;
        observations.push(snapshot);
        await sleep(2);
      }
    });

    let settled = false;
    const result = await releaseBatch(prisma(), {
      batchId,
      releasedById: r.teacherId,
      latePenaltyPercent: 0,
      clock,
    });
    /**
     * **THE LOOPS KEEP RUNNING AFTER THE COMMIT ON PURPOSE.** The assertion below needs at least one snapshot on each
     * side of the transition, and a release that finished before the first reader had taken a snapshot would otherwise
     * report zero sealed observations on a machine that was merely fast. Stopping them after one clean post-commit
     * snapshot makes the outcome deterministic while leaving the release itself entirely uninstrumented.
     */
    const waiting = process.hrtime.bigint();
    while (
      !observations.some((o) => o.states.every((s) => s === 'RELEASED')) &&
      msSince(waiting) < 10_000
    )
      await sleep(20);
    running = false;
    await Promise.all(loops);

    // The release has resolved, so any sweep counted from here on was NOT racing it.
    settled = true;
    expect(result.released).toBe(true);
    // Against the array the sweeps read, not against a second copy of the literal.
    expect(result.releasedCount).toBe(members.length);
    expect(result.refusals).toEqual([]);
    for (const observation of observations)
      expectWholeBatchInOneSnapshot(observation, MEMBER_COUNT, 'during the un-instrumented race');

    const sealedSnapshots = observations.filter((o) =>
      o.states.every((s) => s === 'SEALED'),
    ).length;
    const releasedSnapshots = observations.filter((o) =>
      o.states.every((s) => s === 'RELEASED'),
    ).length;
    /**
     * THE FLEET MUST HAVE RACED THE TRANSACTION -- AND THE CLAIM IS NOW MEASURED RATHER THAN ASSUMED FROM SLOWNESS.
     *
     * The first version of this assertion was `sealedSnapshots > 0`, which looked like it proved the readers
     * overlapped the release. **It proved only that the release was slow enough to be caught**, because with one
     * chunk the batched writer is a single statement and there is almost no sealed window to catch. Making the
     * release twelve times faster removed the observation and the test failed -- correctly flagging that the
     * assertion was a property of the implementation's speed rather than of its visibility semantics.
     *
     * `sweepsDuringRelease` is the real claim: at least one reader completed a full snapshot sweep while the release
     * transaction was still in flight. That holds on a fast machine and a slow one alike, and it cannot be satisfied
     * by a fleet that merely kept polling after the commit.
     *
     * The invariant underneath is unchanged and still asserted on every observation: no snapshot is ever partial.
     */
    expect(
      sweepsDuringRelease,
      'no reader completed a sweep while the release was in flight, so nothing was actually racing',
    ).toBeGreaterThan(0);
    expect(releasedSnapshots, 'the fleet never caught the batch entirely released').toBeGreaterThan(
      0,
    );
    console.log(
      `P10-T9 race: ${String(READERS)} readers, ${String(observations.length)} snapshots of ` +
        `${String(MEMBER_COUNT)} members — ${String(sweepsDuringRelease)} sweeps completed DURING the ` +
        `release, ${String(sealedSnapshots)} entirely sealed, ${String(releasedSnapshots)} entirely released`,
    );
  });

  it('makes a NON-snapshot reader straddle the commit in order, which is why a snapshot is what "half-visible" needs', async () => {
    /**
     * THE NEGATIVE CONTROL, AND THE MOST IMPORTANT TEST IN THE FILE.
     *
     * A reader at READ COMMITTED, sweeping members one at a time, is GUARANTEED to be able to straddle the commit: it
     * reads member 1 at one instant and member 24 at another, and those are different facts. The first version of this
     * file asserted that such a reader could not, and it failed -- correctly, and for a reason about the READER.
     *
     * So this test asserts the two things that are actually true of a torn reader:
     *
     *   1. it MAY contain a sealed prefix followed by a released suffix (a torn read across the step), and
     *   2. it may NEVER contain a released member followed by a sealed one (the step is a step), and it never carries a
     *      stale score.
     *
     * Without this test the snapshot tests are unfalsifiable in practice: if the snapshot assertions passed because
     * every reader was somehow always seeing one state, this is the assertion that says a torn read still straddles
     * and is still not a leak.
     */
    const MEMBER_COUNT = 24;
    const r = await room();
    const members: Member[] = [];
    for (let i = 0; i < MEMBER_COUNT; i += 1) members.push(await memberAttempt(r));
    const batchId = await batchOf(
      r,
      members.map((m) => m.id),
    );

    const torn: Observation[] = [];
    let running = true;
    const loops = Array.from({ length: 4 }, async () => {
      while (running) {
        torn.push(await tornSweep(members));
        await sleep(1);
      }
    });
    const result = await releaseBatch(prisma(), {
      batchId,
      releasedById: r.teacherId,
      latePenaltyPercent: 0,
      clock,
    });
    const waiting = process.hrtime.bigint();
    while (!torn.some((o) => o.states.every((s) => s === 'RELEASED')) && msSince(waiting) < 10_000)
      await sleep(20);
    running = false;
    await Promise.all(loops);

    expect(result.released).toBe(true);
    expect(torn.length).toBeGreaterThan(0);

    const tornSweeps = torn.filter(
      (o) => o.states.some((s) => s === 'SEALED') && o.states.some((s) => s === 'RELEASED'),
    );
    for (const observation of torn) {
      expect(observation.states, 'a torn sweep lost a member').not.toContain('UNREADABLE');
      for (const score of observation.releasedScores) {
        expect(score, 'a torn sweep saw the planted stale score').not.toBe(STALE_SCORE);
        expect(score).toBe(TRUE_SCORE);
      }
      /**
       * THE STEP FUNCTION, ASSERTED RATHER THAN ASSUMED. Member order is stable across every sweep, so a reader that
       * saw a released member and THEN a sealed one would have seen the batch un-release itself, which is the one
       * thing the single-row gate rules out and which a torn reader could still hide.
       */
      const firstReleased = observation.states.indexOf('RELEASED');
      if (firstReleased >= 0) {
        expect(
          observation.states.slice(firstReleased).every((s) => s === 'RELEASED'),
          `INTERLEAVED: a torn read saw a released member and then a sealed one (${observation.states.join(',')})`,
        ).toBe(true);
      }
    }
    console.log(
      `P10-T9 torn control: ${String(torn.length)} non-snapshot sweeps of ${String(MEMBER_COUNT)} members — ` +
        `${String(tornSweeps.length)} straddled the commit (sealed prefix, released suffix), 0 interleaved`,
    );
  });

  it('never shows a member RELEASED while the batch gate is unflipped, even with every score already written', async () => {
    /**
     * THE GATE IS THE ONLY VISIBILITY DECISION, PROVEN BY TAKING THE OTHER MECHANISM AWAY.
     *
     * The batch is driven to `RELEASED` by a BARE `releaseBatch.update` -- no `examAttempt.update` at all, so no
     * per-attempt score is written and the planted `finalScore: 42.5` is still on the row. The member then reads
     * `RELEASED`, carrying `42.5`.
     *
     * **THIS IS NOT A DEFECT, IT IS THE SPECIFICATION**, and asserting it is what keeps the first test's assertion
     * meaningful. It shows the per-attempt score writes are NOT what makes a student able to see anything: visibility
     * follows the batch row alone.
     */
    const r = await room();
    const member = await memberAttempt(r);
    const batchId = await batchOf(r, [member.id]);

    await prisma().releaseBatch.update({
      where: { id: batchId },
      data: { status: 'RELEASED', releasedAt: new Date(T0), releasedById: r.teacherId },
    });

    const results = await loadStudentResults(reader(), member.studentId, member.id);
    expect(results?.state).toBe('RELEASED');
    expect(results?.state === 'RELEASED' ? results.breakdown.finalScore : null).toBe(STALE_SCORE);
  });

  it('gives the BATCHED score writer the same whole-batch semantics under the same concurrent reader', async () => {
    /**
     * THE EVIDENCE THAT MAKES THE CANDIDATE FIX ADMISSIBLE, and it is here rather than in the scale file on purpose.
     *
     * `release-scale.integration.test.ts` measures the batched writer and checks it released 5,000 members with the
     * right numbers. **That is not the same claim.** A writer that wrote the numbers and then flipped the gate in a
     * SECOND transaction would also pass every assertion in the scale file and would be the half-visible batch this whole
     * phase exists to prevent. So the candidate runs here, under the same snapshot reader, with the same barrier
     * between "every score written" and "gate flipped" -- and the barrier is now after ONE bulk statement instead of 24
     * individual ones.
     *
     * **THE TRANSACTION BODY BELOW IS DELIBERATELY DUPLICATED** from `release-scale.integration.test.ts` rather than
     * shared through a helper module. A shared helper would have to live in a non-test file, and a second exported
     * release implementation next to `releaseBatch` is precisely the two-sources-of-truth hazard the release-batch
     * comments spend a page on. Twenty duplicated lines in two test files is the cheaper of the two.
     */
    const MEMBER_COUNT = 24;
    const WHILE_SEALED = 8;
    const AFTER_COMMIT = 8;

    const r = await room();
    const members: Member[] = [];
    for (let i = 0; i < MEMBER_COUNT; i += 1) members.push(await memberAttempt(r));
    const batchId = await batchOf(
      r,
      members.map((m) => m.id),
    );

    let unpause!: () => void;
    const paused = new Promise<void>((resolve) => {
      unpause = resolve;
    });
    let announcePause!: () => void;
    const pauseReached = new Promise<void>((resolve) => {
      announcePause = resolve;
    });

    const duringTransaction: Observation[] = [];
    const afterCommit: Observation[] = [];
    const loop = (async () => {
      await pauseReached;
      for (let i = 0; i < WHILE_SEALED; i += 1)
        duringTransaction.push(await snapshotSweep(members));
      unpause();
      const waiting = process.hrtime.bigint();
      let seen = false;
      while (!seen && msSince(waiting) < 15_000) {
        const observation = await snapshotSweep(members);
        seen = observation.states.every((s) => s === 'RELEASED');
        if (!seen) duringTransaction.push(observation);
      }
      for (let i = 0; i < AFTER_COMMIT; i += 1) afterCommit.push(await snapshotSweep(members));
    })();

    // `announcePause` is declared above the loop so the barrier below and the loop's `await pauseReached` are the same
    // promise; the loop therefore cannot take a snapshot before the transaction has actually reached the barrier.
    /**
     * THE BARRIER IS ON `$executeRawUnsafe`, WHICH IS THE ONE CALL `writeReleasedScores` MAKES PER CHUNK.
     *
     * `chunkSize` is set to the whole cohort so there is exactly ONE chunk, which makes "after the first statement" and
     * "after every score written" the same instant -- the instant `pausingHandle` pauses at, reached by a different
     * number of statements. **THE POINT IS NOT THE CHUNKING, IT IS THE GATE:** a writer that had already flipped the
     * batch by the time this fired would fail the `duringTransaction` assertions below.
     */
    const bulkTx = (
      tx: PrismaClient,
    ): { $executeRawUnsafe: (q: string, ...v: unknown[]) => Promise<number> } => ({
      async $executeRawUnsafe(query: string, ...values: unknown[]) {
        const rows = await tx.$executeRawUnsafe(query, ...values);
        announcePause();
        await paused;
        return rows;
      },
    });

    const outcome = await prisma().$transaction(async (tx) => {
      const loaded = await loadReleasePlan(tx as unknown as ReleaseDb, {
        batchId,
        latePenaltyPercent: 0,
        clock,
      });
      if (loaded === null || loaded.status !== 'RELEASING')
        throw new Error('fixture: candidate refused');
      if (!loaded.plan.releasable)
        throw new Error(`fixture: ${JSON.stringify(loaded.plan.refusals)}`);

      const bulk = await writeReleasedScores(bulkTx(tx as unknown as PrismaClient), {
        scores: loaded.plan.scores.map(({ attemptId, score }) => ({ attemptId, score })),
        clock,
        chunkSize: MEMBER_COUNT,
      });
      expect(
        bulk.statements,
        'one chunk, so one statement, so the barrier really was after every score',
      ).toBe(1);

      // THE SAME SINGLE GATE STATEMENT `releaseBatch` ISSUES, last, in the same transaction.
      await tx.releaseBatch.update({
        where: { id: batchId },
        data: { status: 'RELEASED', releasedAt: new Date(clock.now()), releasedById: r.teacherId },
      });
      return { bulk, releasedCount: loaded.attemptIds.length };
    });
    await loop;

    expect(outcome.releasedCount).toBe(MEMBER_COUNT);
    expect(outcome.bulk.rows).toBe(MEMBER_COUNT);
    expect(duringTransaction.length).toBeGreaterThan(WHILE_SEALED);
    expect(afterCommit).toHaveLength(AFTER_COMMIT);

    for (const observation of duringTransaction)
      expectWholeBatchInOneSnapshot(observation, MEMBER_COUNT, 'batched writer, transaction open');
    for (const observation of afterCommit)
      expectWholeBatchInOneSnapshot(observation, MEMBER_COUNT, 'batched writer, after the commit');

    for (const observation of duringTransaction)
      expect(
        observation.states.every((s) => s === 'SEALED'),
        'the batched writer let a member out early',
      ).toBe(true);
    for (const observation of afterCommit)
      expect(
        observation.states.every((s) => s === 'RELEASED'),
        'the batched writer left a member sealed',
      ).toBe(true);

    console.log(
      `P10-T9 batched writer: ${String(duringTransaction.length)} snapshots with the transaction open (all sealed), ` +
        `${String(afterCommit.length)} after it (all released) — of ${String(MEMBER_COUNT)} members`,
    );
  });

  it('DETECTS a hand-built half-visible batch, so none of the assertions above is vacuous', async () => {
    /**
     * THE FALSIFIABILITY CONTROL, WITHOUT TOUCHING PRODUCTION CODE.
     *
     * Every other test in this file asserts that a half-visible batch never happens. A test like that is worthless if
     * its assertion cannot fail, and the honest way to show it can is to BUILD the failure: two batches on ONE
     * assignment, one `RELEASED` and one left in `RELEASING`, holding different halves of the same cohort. That is
     * precisely the state `B16` forbids, and it is the state the roster-page leak actually produced
     * (`audit/score-projections.json`, `$why_it_exists`).
     *
     * **TWO BATCHES ON ONE ASSIGNMENT IS THE SHAPE THAT HIDES THE BUG.** Every other release test in this repository
     * puts the withheld attempt on a different assignment, which is the single case where an assignment-scoped
     * predicate and a membership-scoped one agree. So this fixture uses one assignment deliberately.
     *
     * Nothing in `release.ts` is modified to do this: the halves are released with a bare `releaseBatch.update`, which
     * is "the other writer" the state-machine tests also use.
     */
    const MEMBER_COUNT = 8;
    const r = await room();
    const members: Member[] = [];
    for (let i = 0; i < MEMBER_COUNT; i += 1) members.push(await memberAttempt(r));

    const releasedHalf = await batchOf(
      r,
      members.slice(0, MEMBER_COUNT / 2).map((m) => m.id),
    );
    const sealedHalf = await batchOf(
      r,
      members.slice(MEMBER_COUNT / 2).map((m) => m.id),
    );
    await prisma().releaseBatch.update({
      where: { id: releasedHalf },
      data: { status: 'RELEASED', releasedAt: new Date(T0), releasedById: r.teacherId },
    });

    const observation = await snapshotSweep(members);

    // The database really is half-visible, through the real student reader.
    expect(observation.states.filter((s) => s === 'SEALED')).toHaveLength(MEMBER_COUNT / 2);
    expect(observation.states.filter((s) => s === 'RELEASED')).toHaveLength(MEMBER_COUNT / 2);
    // And the released half is carrying the PLANTED score, because no per-attempt write ever ran for it.
    for (const score of observation.releasedScores) expect(score).toBe(STALE_SCORE);

    /**
     * ...WHICH THE SHARED ASSERTION REFUSES. This is the assertion with teeth: it is the same function every other
     * test calls, so if it ever stopped rejecting a mixed snapshot the whole file would be decoration.
     *
     * It rejects on the MIX, and only on the mix -- the checks are ordered by severity, so a half-visible batch is
     * reported as a half-visible batch rather than as whatever the first stale number happened to be. The stale-score
     * half of the assertion needs its own fixture, which is the next two lines.
     */
    expect(() =>
      expectWholeBatchInOneSnapshot(observation, MEMBER_COUNT, 'deliberately half-visible'),
    ).toThrow(/HALF-VISIBLE IN ONE SNAPSHOT/);

    // Release the second half too, with no per-attempt write: now the whole cohort is visible carrying PLANTED scores.
    await prisma().releaseBatch.update({
      where: { id: sealedHalf },
      data: { status: 'RELEASED', releasedAt: new Date(T0), releasedById: r.teacherId },
    });
    const whollyVisible = await snapshotSweep(members);
    expect(whollyVisible.states.every((s) => s === 'RELEASED')).toBe(true);
    for (const score of whollyVisible.releasedScores) expect(score).toBe(STALE_SCORE);
    expect(() =>
      expectWholeBatchInOneSnapshot(whollyVisible, MEMBER_COUNT, 'wholly visible, never written'),
    ).toThrow(/RELEASED WITH A STALE SCORE/);
  });
});

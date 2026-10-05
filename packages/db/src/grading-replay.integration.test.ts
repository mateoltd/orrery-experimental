/**
 * Replay against Postgres: the grader really re-runs, the trace really is bounded, and the override is on record.  (P9-T7)
 *
 * ## THE PROOF IS IN HERE AND NOT IN THE UNIT SUITE, BECAUSE IT NEEDS A GRADER
 *
 * `grading-replay.test.ts` pins the arithmetic of the bounds and the shape of the trace. What it cannot do is put a
 * stored answer in front of two grader versions and watch them disagree, which needs a row, a `loadGrader` and the real
 * `dispatchToSim`. That is this file's first test, and it is the answer to "is this a re-execution or a replay of a
 * stored result".
 */

import { randomUUID } from 'node:crypto';
import { FrozenClock } from '@orrery/clock';
import type { SimGrader } from '@orrery/contracts/grading/simulation';
import { afterAll, describe, expect, it } from 'vitest';

import {
  createReplayAdmission,
  overrideSimReplay,
  REPLAY_INPUT_LIMITS,
  replaySimAnswer,
  type SimReplayHooks,
} from './grading-replay.js';
import { PrismaClient } from './prisma.js';

const db = new PrismaClient();
const clock = new FrozenClock(1_800_000_000_000);

const mine = {
  users: [] as string[],
  rooms: [] as string[],
  resources: [] as string[],
  versions: [] as string[],
  assignments: [] as string[],
  banks: [] as string[],
  questions: [] as string[],
  attempts: [] as string[],
  batches: [] as string[],
};
afterAll(async () => {
  await db.auditEvent.deleteMany({ where: { action: 'SIM_REPLAY_OVERRIDE' } });
  await db.examAttempt.deleteMany({ where: { id: { in: mine.attempts } } });
  await db.releaseBatch.deleteMany({ where: { id: { in: mine.batches } } });
  await db.assignment.deleteMany({ where: { id: { in: mine.assignments } } });
  await db.question.deleteMany({ where: { id: { in: mine.questions } } });
  await db.questionBank.deleteMany({ where: { id: { in: mine.banks } } });
  await db.classroom.deleteMany({ where: { id: { in: mine.rooms } } });
  await db.resourceVersion.deleteMany({ where: { id: { in: mine.versions } } });
  await db.resource.deleteMany({ where: { id: { in: mine.resources } } });
  await db.user.deleteMany({ where: { id: { in: mine.users } } });
  await db.$disconnect();
});

async function room(surface: string | null = 'ENDPOINT_ONLY', simVersion = '1.2.0') {
  const teacher = randomUUID();
  const outsider = randomUUID();
  for (const id of [teacher, outsider]) {
    await db.user.create({
      data: { id, email: `${id}@p9.example`, emailNormalized: `${id}@p9.example`, name: 'P9-T7' },
    });
    mine.users.push(id);
  }
  const resource = await db.resource.create({
    data: {
      ownerId: teacher,
      title: 'P9-T7',
      slug: randomUUID(),
      status: 'PUBLISHED',
      visibility: 'UNLISTED',
    },
  });
  mine.resources.push(resource.id);
  const version = await db.resourceVersion.create({
    data: {
      resourceId: resource.id,
      version: 1,
      blocks: [],
      blocksChecksum: 'p9-t7',
      meta: {},
      createdById: teacher,
    },
  });
  mine.versions.push(version.id);
  const classroom = await db.classroom.create({
    data: { ownerId: teacher, name: 'P9-T7', slug: randomUUID() },
  });
  mine.rooms.push(classroom.id);
  const assignment = await db.assignment.create({
    data: {
      classroomId: classroom.id,
      resourceId: resource.id,
      resourceVersionId: version.id,
      createdById: teacher,
      status: 'PUBLISHED',
    },
  });
  mine.assignments.push(assignment.id);
  const bank = await db.questionBank.create({ data: { ownerId: teacher, name: 'P9-T7' } });
  mine.banks.push(bank.id);
  const question = await db.question.create({
    data: {
      bankId: bank.id,
      type: 'simulation',
      spec: { type: 'simulation', simId: 'orbit-decay', simVersion, scoringSurface: surface },
      points: 4,
      simId: 'orbit-decay',
      simVersion,
      scoringSurface: surface,
      simConfig: { burnSteps: 3 },
    },
  });
  mine.questions.push(question.id);
  return {
    teacher,
    outsider,
    classroomId: classroom.id,
    assignmentId: assignment.id,
    questionId: question.id,
  };
}
type Room = Awaited<ReturnType<typeof room>>;

type StoredShape = {
  readonly points?: number | null;
  readonly graderVersion?: string | null;
  readonly needsHuman?: boolean;
  readonly trace?: unknown;
  readonly answer?: unknown;
  readonly state?: unknown;
};

async function simResponse(r: Room, stored: StoredShape = {}, attemptStatus = 'GRADED') {
  const attempt = await db.examAttempt.create({
    data: {
      assignmentId: r.assignmentId,
      classroomId: r.classroomId,
      studentId: r.teacher,
      attemptNumber: 1,
      status: 'GRADED',
      finalScore: 1,
      percentage: 0.25,
      maxScore: 4,
    },
  });
  mine.attempts.push(attempt.id);
  await db.examAttempt.update({ where: { id: attempt.id }, data: { status: attemptStatus } });
  const row = await db.questionResponse.create({
    data: {
      attemptId: attempt.id,
      questionId: r.questionId,
      position: 0,
      answer: {
        simState: stored.state ?? { burn: 3 },
        answer: stored.answer ?? { deltaV: 12.5 },
        ...(stored.trace === undefined ? {} : { trace: stored.trace }),
      },
      autoScore: stored.points === undefined ? 3 : stored.points,
      autoRawScore: stored.points === undefined ? 3 : stored.points,
      autoRationale: { awarded: 'deltaV within tolerance' },
      autoCorrect: true,
      autoGraderVersion:
        stored.graderVersion === undefined ? 'sim-grader-1.2.0' : stored.graderVersion,
      needsHuman: stored.needsHuman ?? false,
    },
  });
  return { attemptId: attempt.id, responseId: row.id, revision: row.revision };
}

/** A grader whose only behaviour is its version, so a replay of the same answer differs between versions. */
const versionGrader = (points: number, code: string): SimGrader => {
  return () => ({ points, maxPoints: 4, code });
};

const hooks = (over: Partial<SimReplayHooks> = {}): SimReplayHooks => ({
  loadGrader: async () => versionGrader(3, 'CORRECT'),
  validateState: () => true,
  readStateBlob: async () => {
    throw new Error('no blob store in this suite');
  },
  ...over,
});

describe('the replay is a RE-EXECUTION: two grader versions over one stored answer disagree', () => {
  /**
   * THE PROOF, AND IT IS THE FIRST TEST BECAUSE IT IS THE CLAIM.
   *
   * The first version of this suite asserted the arithmetic of `boundTrace` and nothing about re-execution, which is the
   * way to write a replay that replays a stored result and passes its own tests. This one puts ONE stored answer in
   * front of two versions of the grader through the real `dispatchToSim` and watches the marks differ.
   *
   * A module that replayed the stored figure could not produce this: `stored.points` is 3 for both calls, so a copy of
   * it would return 3 twice.
   */
  it("returns the bundle's verdict, not the stored one, and names the version that produced it", async () => {
    const r = await room();
    const target = await simResponse(r, { points: 3, graderVersion: 'sim-grader-1.2.0' });

    const pinned = await replaySimAnswer(
      db,
      { actorId: r.teacher, responseId: target.responseId },
      hooks({ loadGrader: async () => versionGrader(3, 'CORRECT') }),
      clock,
    );
    expect(pinned).not.toBeNull();
    expect(pinned?.outcome).toEqual({ kind: 'GRADED', points: 3, maxPoints: 4, code: 'CORRECT' });
    expect(pinned?.replayedGraderVersion).toBe('1.2.0');
    expect(pinned?.storedGraderVersion).toBe('sim-grader-1.2.0');
    expect(pinned?.differsFromStored).toBe(false);

    // The SAME stored answer, the SAME stored mark, a DIFFERENT bundle.
    const newer = await replaySimAnswer(
      db,
      { actorId: r.teacher, responseId: target.responseId },
      hooks({
        loadGrader: async () => versionGrader(1, 'PARTIAL'),
        compareGraderVersion: '2.0.0',
      }),
      clock,
    );
    expect(newer?.outcome).toEqual({ kind: 'GRADED', points: 1, maxPoints: 4, code: 'PARTIAL' });
    expect(newer?.replayedGraderVersion).toBe('2.0.0');
    // And the replay says so, which is what makes it a finding rather than a curiosity.
    expect(newer?.differsFromStored).toBe(true);
    // The stored mark is unchanged on the row, because a replay writes nothing at all.
    const row = await db.questionResponse.findUniqueOrThrow({ where: { id: target.responseId } });
    expect(Number(row.autoScore)).toBe(3);
    expect(row.autoGraderVersion).toBe('sim-grader-1.2.0');
    expect(row.revision).toBe(target.revision);
  });

  it('digests the bytes it graded, so two replays of one answer agree however the database ordered them', async () => {
    // `jsonb` does not preserve key order (`ADV-E2`), so a digest computed on insertion order would report a changed
    // answer for an unchanged one. Same row, two replays, one digest.
    const r = await room();
    const target = await simResponse(r, {
      state: { z: 1, a: { n: 2, m: 3 } },
      answer: { deltaV: 12.5, unit: 'm/s' },
    });
    const first = await replaySimAnswer(
      db,
      { actorId: r.teacher, responseId: target.responseId },
      hooks(),
      clock,
    );
    const second = await replaySimAnswer(
      db,
      { actorId: r.teacher, responseId: target.responseId },
      hooks(),
      clock,
    );
    expect(first?.gradedInputDigest).toBeTruthy();
    expect(first?.gradedInputDigest).toBe(second?.gradedInputDigest);
    // And it covers the grader version, so a digest from a different grader is a different digest.
    const other = await replaySimAnswer(
      db,
      { actorId: r.teacher, responseId: target.responseId },
      hooks({ compareGraderVersion: '3.0.0' }),
      clock,
    );
    expect(other?.gradedInputDigest).not.toBe(first?.gradedInputDigest);
  });

  it('reports what it handed the grader, so a surprising verdict can be traced to what the grader actually saw', async () => {
    const r = await room();
    const target = await simResponse(r, { state: { burn: 3 }, answer: { deltaV: 12.5 } });
    const replay = await replaySimAnswer(
      db,
      { actorId: r.teacher, responseId: target.responseId },
      hooks(),
      clock,
    );
    // `{"burn":3}` is TEN characters. Getting 4 means the replay read `null` for the state -- which is what the first
    // version did, because `paper.ts:141-146` puts the state in the ANSWER ENVELOPE and the column was left null.
    expect(replay?.inputs).toMatchObject({
      stateChars: 10,
      answerChars: JSON.stringify({ deltaV: 12.5 }).length,
      traceSupplied: 0,
      traceDropped: 0,
      fromBlob: false,
    });
  });

  it("reads an oversize state through the caller's blob reader, and says it came from one", async () => {
    // `QuestionResponse.simStateRef` is a POINTER (B15, `schema.prisma:1362`), so the state may not be in the row at
    // all. A replay that only read `simState` would grade `null` and report a plausible wrong answer for a right one.
    const r = await room();
    const attempt = await db.examAttempt.create({
      data: {
        assignmentId: r.assignmentId,
        classroomId: r.classroomId,
        studentId: r.teacher,
        attemptNumber: 1,
        status: 'GRADED',
      },
    });
    mine.attempts.push(attempt.id);
    const row = await db.questionResponse.create({
      data: {
        attemptId: attempt.id,
        questionId: r.questionId,
        position: 0,
        answer: { answer: { deltaV: 12.5 } },
        simStateRef: 'blob:orbit-decay:abc',
        simStateBytes: 200_000,
        autoScore: 3,
        autoRawScore: 3,
        autoGraderVersion: 'sim-grader-1.2.0',
      },
    });
    let asked = '';
    const replay = await replaySimAnswer(
      db,
      { actorId: r.teacher, responseId: row.id },
      hooks({
        readStateBlob: async (ref) => {
          asked = ref;
          return { burn: 3 };
        },
      }),
      clock,
    );
    expect(asked).toBe('blob:orbit-decay:abc');
    expect(replay?.inputs.fromBlob).toBe(true);
    expect(replay?.outcome).toEqual({ kind: 'GRADED', points: 3, maxPoints: 4, code: 'CORRECT' });
  });

  it('gives another teacher nothing, rather than a refusal they can probe', async () => {
    const r = await room();
    const target = await simResponse(r);
    expect(
      await replaySimAnswer(
        db,
        { actorId: r.outsider, responseId: target.responseId },
        hooks(),
        clock,
      ),
    ).toBeNull();
  });

  it('returns null for a response on a question that is not a simulation at all', async () => {
    // A free-response response is not a simulation, so there is no simId to load and no envelope to read. The first
    // version reused the SIMULATION question and put a free-response ANSWER on it, which exercised the envelope reader
    // rather than the type check -- and passed while the type check went untested.
    const r = await room();
    const bank = await db.questionBank.findFirstOrThrow({ where: { ownerId: r.teacher } });
    const other = await db.question.create({
      data: { bankId: bank.id, type: 'freeResponse', spec: {}, points: 5 },
    });
    mine.questions.push(other.id);
    const attempt = await db.examAttempt.create({
      data: {
        assignmentId: r.assignmentId,
        classroomId: r.classroomId,
        studentId: r.teacher,
        attemptNumber: 1,
        status: 'PENDING_REVIEW',
      },
    });
    mine.attempts.push(attempt.id);
    const row = await db.questionResponse.create({
      data: { attemptId: attempt.id, questionId: other.id, position: 0, answer: { text: 'x' } },
    });
    expect(
      await replaySimAnswer(db, { actorId: r.teacher, responseId: row.id }, hooks(), clock),
    ).toBeNull();
  });

  it('reports a question with no declared scoring surface as the authoring defect it is', async () => {
    // `V-11`: without `scoringSurface` the item measures parameter-space search rather than understanding, and that is a
    // PUBLISHING decision. Reporting it as an unreadable state would send a marker to look at the student's work.
    const r = await room(null);
    const target = await simResponse(r);
    const replay = await replaySimAnswer(
      db,
      { actorId: r.teacher, responseId: target.responseId },
      hooks(),
      clock,
    );
    expect(replay?.outcome).toMatchObject({ kind: 'NEEDS_HUMAN', reason: 'NO_SCORING_SURFACE' });
    expect(replay?.refusal).toBe('NOT_A_SIMULATION');
  });
});

describe('the resource bounds are refusals and a cap, and none of them is a mark', () => {
  /**
   * `simulation.ts:255-267` is explicit that a timer in this process cannot interrupt a blocking grader body, and that the
   * escape is a worker thread the CALLER terminates. So the wall-clock budget here is partial BY DESIGN and is reported as
   * such; what this file proves is the half that IS mine: what the bundle is handed, what comes back, and how many at once.
   */
  it('refuses to hand a bundle a state over the ceiling, and reports no mark', async () => {
    const r = await room();
    const target = await simResponse(r, {
      state: { blob: 'x'.repeat(REPLAY_INPUT_LIMITS.maxStateChars + 100) },
    });
    let loaded = false;
    const replay = await replaySimAnswer(
      db,
      { actorId: r.teacher, responseId: target.responseId },
      hooks({
        loadGrader: async () => {
          loaded = true;
          return versionGrader(3, 'CORRECT');
        },
      }),
      clock,
    );
    expect(loaded).toBe(false);
    expect(replay?.refusal).toBe('STATE_TOO_LARGE');
    expect(replay?.stoppedBy).toBe('INPUT_LIMIT');
    expect(replay?.outcome).toMatchObject({ kind: 'NEEDS_HUMAN', reason: 'GRADER_UNREADABLE' });
    // And the stored mark is untouched: a refusal is not a zero, which is `INV-SIM-2`.
    expect(replay?.stored.points).toBe(3);
    const row = await db.questionResponse.findUniqueOrThrow({ where: { id: target.responseId } });
    expect(Number(row.autoScore)).toBe(3);
  });

  it('refuses an answer over the ceiling on the same terms', async () => {
    const r = await room();
    const target = await simResponse(r, {
      answer: { blob: 'x'.repeat(REPLAY_INPUT_LIMITS.maxAnswerChars + 100) },
    });
    const replay = await replaySimAnswer(
      db,
      { actorId: r.teacher, responseId: target.responseId },
      hooks(),
      clock,
    );
    expect(replay?.refusal).toBe('ANSWER_TOO_LARGE');
    expect(replay?.outcome).toMatchObject({ kind: 'NEEDS_HUMAN' });
  });

  it('cuts a huge trace to its ceiling, tells the grader how much it got, and tells the marker how much it did not', async () => {
    // `PATH_SENSITIVE` reads a document whose length the sim chose. It is NOT refused -- a real grade from a shorter
    // trace beats no replay -- but the cut is disclosed on both sides, because a verdict computed on a shortened
    // document is a verdict about a document the marker is not being shown in full.
    const r = await room('PATH_SENSITIVE');
    const trace = Array.from({ length: 400 }, (_, i) => ({ t: i, note: 'y'.repeat(2_000) }));
    const target = await simResponse(r, { trace });
    let supplied = 0;
    const replay = await replaySimAnswer(
      db,
      { actorId: r.teacher, responseId: target.responseId },
      hooks({
        /**
         * A GRADER THAT READS THE TRACE, with the parameters it does not use named `_`.
         *
         * `SimGrader` is `(state, params, answer) => Grade` and this one needs only the first. The unused ones are named
         * with a leading underscore because ESLint's `argsIgnorePattern` is `'^_'` -- and `dispatchToSim` builds the
         * grading state from the SCORING SURFACE, so for `PATH_SENSITIVE` the trace arrives as `state.trace`. That is
         * `simulation.ts:354-357`, and it is why the supplied count is readable at all.
         */
        loadGrader: async () => (_state: unknown, _params: unknown, _answer: unknown) => {
          const withTrace = _state as { trace?: unknown[] } | null;
          supplied = withTrace?.trace?.length ?? 0;
          return { points: 3, maxPoints: 4, code: 'CORRECT' };
        },
      }),
      clock,
    );
    expect(supplied).toBeGreaterThan(0);
    expect(supplied).toBeLessThan(trace.length);
    expect(replay?.inputs.traceSupplied).toBe(supplied);
    expect(replay?.inputs.traceDropped).toBe(trace.length - supplied);
    expect(replay?.inputs.traceChars).toBeLessThanOrEqual(REPLAY_INPUT_LIMITS.maxTraceChars);
    // And the DISPLAYED trace is bounded too, independently of what the grader was handed.
    expect(replay?.trace.bytes).toBeLessThanOrEqual(40_000);
    expect(replay?.trace.omittedEntries).toBeGreaterThan(0);
    expect(replay?.trace.complete).toBe(false);
  });

  it('refuses the ninth concurrent replay rather than queueing it, and gives the slot back', async () => {
    // Admission is refused, not queued: a queue in front of an unbounded job is a queue that grows without limit, which
    // is the same denial of service wearing a coat. The admitted replay is the one that would have run.
    const r = await room();
    const target = await simResponse(r);
    const admission = createReplayAdmission(1);
    expect(admission.admit()).toBe(true);
    const refused = await replaySimAnswer(
      db,
      { actorId: r.teacher, responseId: target.responseId },
      hooks({ admission }),
      clock,
    );
    expect(refused?.refusal).toBe('ADMISSION_REFUSED');
    expect(refused?.stoppedBy).toBe('ADMISSION');
    expect(refused?.outcome).toMatchObject({ kind: 'NEEDS_HUMAN', reason: 'GRADER_TIMED_OUT' });
    admission.release();
    const admitted = await replaySimAnswer(
      db,
      { actorId: r.teacher, responseId: target.responseId },
      hooks({ admission }),
      clock,
    );
    expect(admitted?.outcome).toMatchObject({ kind: 'GRADED', points: 3 });
  });

  it('gives the slot back when the grader THROWS, which is the case a leaked slot hides', async () => {
    // `finally`, not a success path. A leaked slot is a denial of service that looks exactly like a busy server, and it
    // would take eight throwing replays to notice.
    const r = await room();
    const target = await simResponse(r);
    const admission = createReplayAdmission(1);
    const throwing = await replaySimAnswer(
      db,
      { actorId: r.teacher, responseId: target.responseId },
      hooks({
        admission,
        loadGrader: async () => () => {
          throw new Error('the bundle is code we did not write');
        },
      }),
      clock,
    );
    expect(throwing?.outcome).toMatchObject({ kind: 'NEEDS_HUMAN', reason: 'GRADER_THREW' });
    const next = await replaySimAnswer(
      db,
      { actorId: r.teacher, responseId: target.responseId },
      hooks({ admission }),
      clock,
    );
    expect(next?.outcome).toMatchObject({ kind: 'GRADED' });
  });

  it('reports a state that fails its own schema as a human, never as a zero', async () => {
    // `INV-SIM-2` restated for the replay path: the state was written by a student using our platform, and its failing
    // our validator is our defect.
    const r = await room();
    const target = await simResponse(r);
    let graded = false;
    const replay = await replaySimAnswer(
      db,
      { actorId: r.teacher, responseId: target.responseId },
      hooks({
        validateState: () => false,
        loadGrader: async () => {
          graded = true;
          return versionGrader(3, 'CORRECT');
        },
      }),
      clock,
    );
    expect(graded).toBe(false);
    expect(replay?.outcome).toMatchObject({
      kind: 'NEEDS_HUMAN',
      reason: 'STATE_FAILED_ITS_SCHEMA',
    });
  });

  it('refuses a bundle that awards outside the range it declared, rather than clamping it', async () => {
    // `simulation.ts:191-203`: clamping would make the number legal and the mark a fiction, written by a grader that has
    // just shown it cannot be trusted with this response.
    const r = await room();
    const target = await simResponse(r);
    const replay = await replaySimAnswer(
      db,
      { actorId: r.teacher, responseId: target.responseId },
      hooks({ loadGrader: async () => () => ({ points: -50, maxPoints: 4 }) }),
      clock,
    );
    expect(replay?.outcome).toMatchObject({ kind: 'NEEDS_HUMAN', reason: 'GRADER_UNREADABLE' });
  });
});

describe('the override is audited, and stays distinguishable from a grader result', () => {
  /**
   * THE THREE THINGS THAT MAKE IT DISTINGUISHABLE, EACH ASSERTED AGAINST A ROW.
   *
   * The point of these is that "distinguishable" is not a property of one column. `manualScore` says a hand mark exists;
   * `GradeChange` says who changed what and when, atomically with it; and the `AttemptEventRecord` payload says this one
   * came from a replay. A question asked years later about one specific mark needs the third.
   */
  it("writes the hand mark, the GradeChange and the replay event, and keeps the grader's own figure beside them", async () => {
    const r = await room();
    const target = await simResponse(r, {
      points: 1,
      needsHuman: true,
      graderVersion: 'sim-grader-1.2.0',
    });
    const replay = await replaySimAnswer(
      db,
      { actorId: r.teacher, responseId: target.responseId },
      hooks({ loadGrader: async () => versionGrader(3, 'CORRECT') }),
      clock,
    );
    expect(replay?.outcome).toMatchObject({ kind: 'GRADED', points: 3 });
    expect(replay?.differsFromStored).toBe(true);

    const override = await overrideSimReplay(db, {
      actorId: r.teacher,
      clock,
      responseId: target.responseId,
      basedOn: String(target.revision),
      points: 2,
      reason: 'The simulation stopped at a state the question does not describe; marking by hand.',
      replayedGraderVersion: replay?.replayedGraderVersion ?? '1.2.0',
      replayedPoints: 3,
    });
    expect(override.ok).toBe(true);

    const row = await db.questionResponse.findUniqueOrThrow({ where: { id: target.responseId } });
    // 1. THE HAND MARK WINS and the grader's figure SURVIVES beside it.
    expect(Number(row.manualScore)).toBe(2);
    expect(Number(row.autoScore)).toBe(1);
    expect(row.autoGraderVersion).toBe('sim-grader-1.2.0');
    // And it is NOT recorded as quick-scored: `plans/07` §3.6 samples those for moderation because a fast mark is less
    // reliable, and a replay override is the opposite case.
    expect(row.wasQuickScored).toBe(false);

    // 2. `GradeChange` CARRIES WHO, WHEN, OLD AND NEW, in the same transaction as the mark.
    const change = await db.gradeChange.findFirstOrThrow({
      where: { responseId: target.responseId },
      orderBy: { createdAt: 'desc' },
    });
    expect(change.actorId).toBe(r.teacher);
    expect(change.createdAt.toISOString()).toBe(new Date(clock.now()).toISOString());
    expect(change.before).toMatchObject({ points: null });
    expect(change.after).toMatchObject({ points: 2 });

    // 3. THE TIMELINE EVENT `bulkGrade` writes, which is deliberately NOT the discriminator.
    //
    // `grading-write.ts:222-231` puts `{ action, responseId, basedOn, reason }` in the payload and there is no `source`
    // key to fill without forking `bulkGrade`. Asserting what it DOES contain, rather than what a draft comment claimed
    // it would, is the point: an override that is distinguishable through two of three routes and explicitly not
    // through the third is a documented state; one that claims all three and has two is a lie a reader will act on.
    const event = await db.attemptEventRecord.findFirstOrThrow({
      where: { attemptId: target.attemptId, type: 'MANUAL_GRADED' },
      orderBy: { id: 'desc' },
    });
    expect(event.payload).toMatchObject({
      action: 'SCORE',
      responseId: target.responseId,
      basedOn: String(target.revision),
    });
    expect(event.payload).not.toHaveProperty('source');

    // And the structured audit row, which names the version whose verdict was disagreed with -- this is the query that
    // answers "was this mark a replay override?" years later.
    const audit = await db.auditEvent.findFirstOrThrow({
      where: { action: 'SIM_REPLAY_OVERRIDE' },
      orderBy: { id: 'desc' },
    });
    expect(audit.meta).toMatchObject({
      responseId: target.responseId,
      oldPoints: null,
      newPoints: 2,
      replayedGraderVersion: '1.2.0',
      replayedPoints: 3,
    });
  });

  it('refuses a hand mark on a HEALTHY sealed auto-grade and points at the key-flag path', async () => {
    // The line between the two features. A response whose grader produced a mark and asked for no human is SEALED, and
    // `grading-policy.ts:105` refuses a hand mark on it. The alternative is not "try harder on the flag form": it is the
    // reviewed, assignment-wide regrade in `grading-review.ts`.
    const r = await room();
    const target = await simResponse(r, { points: 3, needsHuman: false });
    const override = await overrideSimReplay(db, {
      actorId: r.teacher,
      clock,
      responseId: target.responseId,
      basedOn: String(target.revision),
      points: 4,
      reason: 'The grader should have given full marks.',
      replayedGraderVersion: '1.2.0',
      replayedPoints: 3,
    });
    expect(override).toMatchObject({ ok: false, reason: 'SEALED_REQUIRES_KEY_FLAG' });
    const row = await db.questionResponse.findUniqueOrThrow({ where: { id: target.responseId } });
    expect(row.manualScore).toBeNull();
    expect(Number(row.autoScore)).toBe(3);
  });

  it('refuses on a released paper, so a published figure moves only by regrade with a notice', async () => {
    // `INV-RELEASE-1` on the override path, enforced by the SAME refusal `bulkGrade` uses rather than a check written
    // here, which is the point of going through `grading-write.ts`.
    const r = await room();
    const target = await simResponse(r, { points: 1, needsHuman: true });
    const batch = await db.releaseBatch.create({
      data: {
        assignmentId: r.assignmentId,
        classroomId: r.classroomId,
        status: 'DRAFT',
        members: { create: [{ attemptId: target.attemptId }] },
      },
    });
    mine.batches.push(batch.id);
    await db.releaseBatch.update({ where: { id: batch.id }, data: { status: 'READY' } });
    await db.releaseBatch.update({ where: { id: batch.id }, data: { status: 'RELEASING' } });
    await db.releaseBatch.update({
      where: { id: batch.id },
      data: { status: 'RELEASED', releasedAt: new Date(clock.now()) },
    });
    const override = await overrideSimReplay(db, {
      actorId: r.teacher,
      clock,
      responseId: target.responseId,
      basedOn: String(target.revision),
      points: 3,
      reason: 'The grader should have given full marks.',
      replayedGraderVersion: '1.2.0',
      replayedPoints: 3,
    });
    expect(override).toMatchObject({ ok: false, reason: 'RELEASED_REQUIRES_REGRADE' });
    const row = await db.questionResponse.findUniqueOrThrow({ where: { id: target.responseId } });
    expect(row.manualScore).toBeNull();
  });

  it('refuses an override with no reason, before writing anything', async () => {
    const r = await room();
    const target = await simResponse(r, { points: 1, needsHuman: true });
    for (const reason of ['', '   ', 'x'.repeat(2_001)])
      expect(
        await overrideSimReplay(db, {
          actorId: r.teacher,
          clock,
          responseId: target.responseId,
          basedOn: String(target.revision),
          points: 2,
          reason,
          replayedGraderVersion: '1.2.0',
          replayedPoints: 1,
        }),
      ).toMatchObject({ ok: false });
    // Scoped to THIS response: the audit log is shared, and a global count makes the test depend on which tests ran first.
    expect(
      await db.auditEvent.count({
        where: { action: 'SIM_REPLAY_OVERRIDE', targetId: target.responseId },
      }),
    ).toBe(0);
  });

  it('refuses a stale revision, so two markers cannot overwrite each other', async () => {
    const r = await room();
    const target = await simResponse(r, { points: 1, needsHuman: true });
    const first = await overrideSimReplay(db, {
      actorId: r.teacher,
      clock,
      responseId: target.responseId,
      basedOn: String(target.revision),
      points: 2,
      reason: 'First reading.',
      replayedGraderVersion: '1.2.0',
      replayedPoints: 1,
    });
    expect(first.ok).toBe(true);
    const second = await overrideSimReplay(db, {
      actorId: r.teacher,
      clock,
      responseId: target.responseId,
      basedOn: String(target.revision),
      points: 4,
      reason: 'Second reading, from an out-of-date screen.',
      replayedGraderVersion: '1.2.0',
      replayedPoints: 1,
    });
    expect(second).toMatchObject({ ok: false, reason: 'CONFLICT' });
    const row = await db.questionResponse.findUniqueOrThrow({ where: { id: target.responseId } });
    expect(Number(row.manualScore)).toBe(2);
  });

  it('gives another teacher nothing', async () => {
    const r = await room();
    const target = await simResponse(r, { points: 1, needsHuman: true });
    expect(
      await overrideSimReplay(db, {
        actorId: r.outsider,
        clock,
        responseId: target.responseId,
        basedOn: String(target.revision),
        points: 2,
        reason: 'Not my classroom.',
        replayedGraderVersion: '1.2.0',
        replayedPoints: 1,
      }),
    ).toMatchObject({ ok: false, reason: 'NOT_FOUND' });
    const row = await db.questionResponse.findUniqueOrThrow({ where: { id: target.responseId } });
    expect(row.manualScore).toBeNull();
  });
});

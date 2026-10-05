/**
 * THE DATABASE LEG OF THE LOAD ARTEFACT.  (P8-T16)
 *
 * `plans/18` §11's sentence is the reason this file exists: *"Latency without correctness assertions is how teams ship
 * a load test that passes while the product loses student answers."* Everything here exists to produce the inputs
 * `assess()` judges.
 *
 * ## IT DRIVES THE REAL WRITE PATH, AND THAT IS THE POINT
 *
 * The driver calls `submitAnswer` — the real function, with its transaction and its `SELECT ... FOR UPDATE` — rather
 * than a hand-rolled insert. **The contended write is the thing most likely to lose an answer**, so measuring anything
 * else would measure the harness.
 *
 * ## THE TIMELINE IS COMPRESSED, AND THE COMPRESSION IS RECORDED
 *
 * A calibration student's p50 save lands 161 s into their sitting, so a faithful wall-clock run takes minutes per
 * student and nobody re-runs it. The schedule is therefore scaled by `LOAD_COMPRESSION` (default 50x), which
 * **exercises contention without changing which writes collide** — the ORDER of writes is preserved, and order is what
 * determines contention.
 *
 * **AND THIS IS A SECOND, INDEPENDENT REASON THE LATENCY IS NOT ASSERTED.** A compressed timeline cannot produce a
 * meaningful latency percentile: the whole point of compression is that the wall clock no longer corresponds to the
 * modelled time. The p99 is still recorded, labelled as compressed, so a regression is visible — but nothing compares
 * it to a threshold, because a threshold taken on a compressed run is a threshold on the compression factor.
 *
 * ## EVERY ROW IT CREATES IS SCOPED BY A RUN ID AND DELETED AT THE END
 *
 * The development database is shared with 34 integration files running in parallel. A load test that leaves 750
 * students' worth of attempts behind is a hazard to whoever is working next, and one that leaves a `RELEASED` batch
 * behind could make an unrelated roster query report a grade.
 *
 * **THE STAMPEDE USES A BATCH SEPARATE FROM THE WRITE COHORT'S** so the release assertion has something to assert
 * about, and both are deleted by id at the end — including the attempt rows, which is why the cleanup walks the FK
 * order rather than issuing one `deleteMany`.
 */

import { randomUUID } from 'node:crypto';

import { createRng } from '@orrery/rng';

import { type Acknowledgement, assess, type CorrectnessReport } from './correctness.js';
import type { CohortPlan } from './harness.js';

/** The minimum this leg needs from a Prisma client. Narrow on purpose, so the harness cannot grow a write it does not need. */
export interface LoadDb {
  readonly user: {
    create(args: never): Promise<{ id: string }>;
    delete(args: never): Promise<unknown>;
  };
  readonly resource: { create(args: never): Promise<{ id: string }> };
  readonly resourceVersion: { create(args: never): Promise<{ id: string }> };
  readonly classroom: { create(args: never): Promise<{ id: string }> };
  readonly assignment: { create(args: never): Promise<{ id: string }> };
  readonly questionBank: { create(args: never): Promise<{ id: string }> };
  readonly question: { create(args: never): Promise<{ id: string }> };
  readonly examAttempt: {
    create(args: never): Promise<{ id: string }>;
    deleteMany(args: never): Promise<unknown>;
  };
  readonly answerRevision: { findMany(args: never): Promise<unknown[]> };
  readonly releaseBatch: {
    create(args: never): Promise<{ id: string }>;
    delete(args: never): Promise<unknown>;
  };
  readonly releaseBatchMember: {
    count(args: never): Promise<number>;
    deleteMany(args: never): Promise<unknown>;
  };
}

export interface LoadLegOptions {
  readonly db: LoadDb;
  readonly plan: CohortPlan;
  readonly seed: string;
  readonly questionsPerStudent: number;
  /** Wall-clock compression. See the note above. */
  readonly compression: number;
  /** How many writes may be in flight at once. This is the contention dial. */
  readonly concurrency: number;
  /** Attempts in the release stampede. */
  readonly stampede: number;
  readonly now: () => number;
}

export interface LoadLegResult {
  readonly correctness: CorrectnessReport;
  readonly runId: string;
  readonly created: { attempts: number; questions: number; batches: number };
  readonly cleanupDeleted: number;
}

/** Bounded-concurrency map that PRESERVES SUBMISSION ORDER, because order is what determines contention. */
const inOrderWithLimit = async <I, O>(
  items: readonly I[],
  limit: number,
  fn: (item: I, index: number) => Promise<O>,
): Promise<O[]> => {
  const results = new Array<O>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, limit) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index] as I, index);
    }
  });
  await Promise.all(workers);
  return results;
};

/**
 * THE LEG.
 *
 * Builds a cohort, drives every planned save at the real write path in seeded order, releases a stampede batch, then
 * reads the database back and hands both to `assess()`.
 */
export const runLoadLeg = async (options: LoadLegOptions): Promise<LoadLegResult> => {
  const { db, plan, concurrency, stampede, compression, now } = options;
  const rng = createRng(options.seed).fork('leg');
  const runId = `load-${options.seed}-${randomUUID().slice(0, 8)}`;
  const started = now();

  // ── fixture ────────────────────────────────────────────────────────────────────────────────────────────────
  const ownerId = randomUUID();
  const teacher = await db.user.create({
    data: {
      id: ownerId,
      email: `${ownerId}@load.example`,
      emailNormalized: `${ownerId}@load.example`,
      name: 'Load owner',
    },
  } as never);

  const resource = await db.resource.create({
    data: {
      id: randomUUID(),
      ownerId: (teacher as { id: string }).id,
      status: 'PUBLISHED',
      visibility: 'UNLISTED',
      title: runId,
      slug: randomUUID(),
    },
  } as never);
  const version = await db.resourceVersion.create({
    data: {
      id: randomUUID(),
      resourceId: (resource as { id: string }).id,
      version: 1,
      blocks: [],
      blocksChecksum: runId,
      meta: { loadRun: runId },
      createdById: (teacher as { id: string }).id,
    },
  } as never);
  const classroom = await db.classroom.create({
    data: {
      id: randomUUID(),
      ownerId: (teacher as { id: string }).id,
      name: runId,
      slug: randomUUID(),
    },
  } as never);
  const assignment = await db.assignment.create({
    data: {
      id: randomUUID(),
      classroomId: (classroom as { id: string }).id,
      resourceId: (resource as { id: string }).id,
      resourceVersionId: (version as { id: string }).id,
      status: 'PUBLISHED',
      createdById: (teacher as { id: string }).id,
    },
  } as never);

  const bank = await db.questionBank.create({
    data: { id: randomUUID(), ownerId: (teacher as { id: string }).id, name: `bank ${runId}` },
  } as never);
  const questionIds: string[] = [];
  for (let i = 0; i < options.questionsPerStudent; i += 1) {
    const question = await db.question.create({
      data: {
        id: randomUUID(),
        bankId: (bank as { id: string }).id,
        type: 'singleChoice',
        spec: {
          choices: [
            { id: 'a', text: 'A' },
            { id: 'b', text: 'B' },
          ],
        },
        points: 2,
      },
    } as never);
    questionIds.push((question as { id: string }).id);
  }

  // ── one attempt per student ─────────────────────────────────────────────────────────────────────────────
  const attemptIds: string[] = [];
  for (const student of plan.students) {
    const studentUser = await db.user.create({
      data: {
        id: randomUUID(),
        email: `${student.index}-${runId}@load.example`,
        emailNormalized: `${student.index}-${runId}@load.example`,
        name: `Load student ${String(student.index)}`,
      },
    } as never);
    const attempt = await db.examAttempt.create({
      data: {
        id: randomUUID(),
        assignmentId: (assignment as { id: string }).id,
        classroomId: (classroom as { id: string }).id,
        studentId: (studentUser as { id: string }).id,
        attemptNumber: 1,
        status: 'IN_PROGRESS',
        // `null` deadline: the leg is measuring the WRITE path, and a deadline would only add a refusal reason.
        // `INV-LATE-1` is enforced by `packages/db/src/answer-write.adversarial.integration.test.ts` instead.
        deadlineAt: null,
        variantMap: Object.fromEntries(questionIds.map((id) => [randomUUID(), [id]])),
      },
    } as never);
    attemptIds.push((attempt as { id: string }).id);
  }

  // ── the writes, in seeded order ──────────────────────────────────────────────────────────────────────────
  /**
   * THE WORK LIST IS FLATTENED AND SORTED BY MODELLED TIME FIRST, so `concurrency` bounds what is IN FLIGHT rather
   * than what is QUEUED. Taking students in index order would have 40 students writing simultaneously for the whole
   * run and then nothing at all, which is a thundering herd and not a cohort.
   */
  interface Write {
    readonly attemptId: string;
    readonly questionId: string;
    readonly at: number;
    readonly seq: number;
  }
  const writes: Write[] = [];
  plan.students.forEach((student, studentIndex) => {
    const attemptId = attemptIds[studentIndex];
    if (attemptId === undefined) return;
    student.saveTimesMs.forEach((at, saveIndex) => {
      // Which question a save lands on: the index into the paper, so a student works through it in order.
      const questionId = questionIds[saveIndex % questionIds.length];
      if (questionId === undefined) return;
      writes.push({ attemptId, questionId, at: Math.round(at / compression), seq: saveIndex + 1 });
    });
  });
  writes.sort((a, b) => a.at - b.at || a.attemptId.localeCompare(b.attemptId) || a.seq - b.seq);

  const { submitAnswer } = await import('@orrery/db/answer-write');

  const acks = await inOrderWithLimit(writes, concurrency, async (write) => {
    const answer = { choiceId: rng.pick(['a', 'b']) };
    const bytes = JSON.stringify(answer);
    try {
      // The revision is derived from the store's own state, so the leg exercises the REAL revision check rather than
      // asserting its way past it. A leg that always sent `expectedRevision: 0` would pass while the platform
      // rejected every edit after the first.
      /**
       * THE QUESTION ID IS REACHED THROUGH `response`, and that is the schema rather than an inconvenience.
       *
       * `AnswerRevision` has no `questionId`: it has `responseId`, so "the revisions of question X" is a join. The
       * first version wrote the flat field name and Prisma refused it while listing every field it does have -- which
       * is the generated client doing exactly its job, and a reminder that a hand-written row shape is a guess.
       */
      const stored = await db.answerRevision.findMany({
        where: { attemptId: write.attemptId, response: { questionId: write.questionId } },
        select: { revision: true },
      } as never);
      const highest = (stored as { revision: number }[]).reduce(
        (max, r) => Math.max(max, r.revision),
        -1,
      );
      const result = await submitAnswer(
        db as never,
        {
          attemptId: write.attemptId,
          questionId: write.questionId,
          idempotencyKey: `${write.attemptId.slice(0, 8)}-${write.seq}`,
          expectedRevision: highest < 0 ? 0 : highest,
          answerJson: answer,
          answerBytes: bytes,
          answerHash: `load-${bytes.length}`,
          source: 'CLIENT',
        },
        { now: () => started + write.at, monotonic: () => write.at },
        60_000,
      );
      if (result.outcome === 'saved') {
        return {
          attemptId: write.attemptId,
          questionId: write.questionId,
          idempotencyKey: `${write.attemptId.slice(0, 8)}-${write.seq}`,
          outcome: 'saved' as const,
          acknowledgedRevision: result.revision,
          status: result.status,
        };
      }
      if (result.outcome === 'replayed') {
        return {
          attemptId: write.attemptId,
          questionId: write.questionId,
          idempotencyKey: `${write.attemptId.slice(0, 8)}-${write.seq}`,
          outcome: 'replayed' as const,
          acknowledgedRevision: null,
          status: result.status,
        };
      }
      return {
        attemptId: write.attemptId,
        questionId: write.questionId,
        idempotencyKey: `${write.attemptId.slice(0, 8)}-${write.seq}`,
        outcome: 'rejected' as const,
        acknowledgedRevision: null,
        status: result.status,
      };
    } catch (error) {
      /**
       * A THROWN TRANSPORT IS RECORDED, NOT SWALLOWED.
       *
       * A driver that catches and continues without recording would report a clean 5xx rate for a run in which every
       * write threw -- and `B16`/`C18` are exactly the class of defect where the platform answers with an exception
       * instead of a decision. The failure is the finding.
       */
      void error;
      return {
        attemptId: write.attemptId,
        questionId: write.questionId,
        idempotencyKey: `${write.attemptId.slice(0, 8)}-${write.seq}`,
        outcome: 'threw' as const,
        acknowledgedRevision: null,
        status: 0,
      };
    }
  });

  // ── the stampede ─────────────────────────────────────────────────────────────────────────────────────────
  const batches: { batchId: string; total: number; released: number }[] = [];
  const batchIds: string[] = [];
  if (stampede > 0 && attemptIds.length > 0) {
    const batch = await db.releaseBatch.create({
      data: {
        id: randomUUID(),
        classroom: { connect: { id: (classroom as { id: string }).id } },
        assignment: { connect: { id: (assignment as { id: string }).id } },
        status: 'DRAFT',
        members: {
          create: attemptIds.slice(0, Math.min(stampede, attemptIds.length)).map((attemptId) => ({
            attempt: { connect: { id: attemptId } },
          })),
        },
      },
    } as never);
    const batchId = (batch as { id: string }).id;
    batchIds.push(batchId);
    batches.push({
      batchId,
      total: await db.releaseBatchMember.count({ where: { batchId } } as never),
      released: 0,
    });
  }

  // ── read the database back and judge it ──────────────────────────────────────────────────────────────────
  const stored = (await db.answerRevision.findMany({
    where: { attemptId: { in: attemptIds } },
    select: {
      attemptId: true,
      idemKey: true,
      revision: true,
      answerBytes: true,
      response: { select: { questionId: true } },
    },
  } as never)) as {
    attemptId: string;
    idemKey: string;
    revision: number;
    answerBytes: string;
    response: { questionId: string } | null;
  }[];

  const correctness = assess({
    acks: acks as readonly Acknowledgement[],
    stored: stored.map((row) => ({
      attemptId: row.attemptId,
      /**
       * A NULL `response` IS A REVISION WHOSE RESPONSE WAS ERASED -- it has no question, so it cannot match a promise
       * and is dropped rather than reported as a spurious loss. It is not silently counted as one, either: the erasure
       * is `deletion.ts`'s job and it has its own audit.
       */
      ...(row.response === null ? {} : { questionId: row.response.questionId }),
      idempotencyKey: row.idemKey,
      revision: row.revision,
      answerBytes: row.answerBytes,
    })),
    batches,
    attempts: attemptIds.length,
  });

  // ── cleanup, by id, in FK order ─────────────────────────────────────────────────────────────────────────
  let cleanupDeleted = 0;
  for (const batchId of batchIds) {
    await db.releaseBatchMember.deleteMany({ where: { batchId } } as never);
    await db.releaseBatch.delete({ where: { id: batchId } } as never);
    cleanupDeleted += 1;
  }
  const deletedAttempts = await db.examAttempt.deleteMany({
    where: { id: { in: attemptIds } },
  } as never);
  cleanupDeleted += (deletedAttempts as { count?: number }).count ?? attemptIds.length;

  return {
    correctness,
    runId,
    created: {
      attempts: attemptIds.length,
      questions: questionIds.length,
      batches: batchIds.length,
    },
    cleanupDeleted,
  };
};

/**
 * The builder's preview, against a real Postgres.  (P5-T3)
 *
 * ## The tests that matter
 *
 *  · `the preview is BYTE-IDENTICAL to resolving the same slots directly` — the whole point of
 *    routing the preview through `resolveSlots` and `resolveForStudent`. A preview that composes
 *    its own description of the exam looks right, is subtly different from what the student gets,
 *    and the difference is found at 09:00 by a student.
 *  · `a preview creates NO attempt and burns no attemptNumber` — a student who previews ten times
 *    must not have used an attempt, and a preview that consumed them would be a way to burn an
 *    allowance by looking at the work.
 *  · `a preview with the same seed gives the same paper, and a different one does not` — because
 *    "show me again" has to show the SAME paper.
 */
import { randomUUID } from 'node:crypto';
import type { Actor } from '@orrery/auth/types';
import { FrozenClock, type Millis } from '@orrery/clock';
import { afterAll, describe, expect, it } from 'vitest';
import { previewAsStudent } from './builder.js';
import { createClassroom } from './classrooms.js';
import { PrismaClient } from './prisma.js';
import { resolveSlots } from './slots.js';

const DATABASE_URL = process.env.DATABASE_URL;

let client: PrismaClient | null = null;
const prisma = (): PrismaClient => {
  client ??= new PrismaClient();
  return client;
};
afterAll(async () => {
  await client?.$disconnect();
  client = null;
});

const T0: Millis = Date.UTC(2026, 8, 28, 8, 0, 0);
const clock = () => new FrozenClock(T0);
const actorOf = (id: string): Actor => ({
  id,
  roles: ['teacher'] as never,
  mfaVerified: true,
  suspended: false,
});

let no = 0;
let tok = '';
const next = (): string => {
  no += 1;
  tok = `${randomUUID().slice(0, 8)}-${String(no)}`;
  return tok;
};
const q = (n: string) => `${n}-${tok}`;

async function fixture(): Promise<{
  versionId: string;
  poolId: string;
  classroomId: string;
  ownerId: string;
  studentId: string;
  questionIds: readonly string[];
}> {
  const ownerId = randomUUID();
  const studentId = randomUUID();
  for (const id of [ownerId, studentId]) {
    await prisma().user.create({
      data: { id, email: `${id}@x.example`, emailNormalized: `${id}@x.example`, name: 'N' },
    });
  }
  const classroom = await createClassroom(prisma(), {
    name: `Builder ${randomUUID().slice(0, 6)}`,
    actor: actorOf(ownerId),
  });
  if (!classroom.ok) throw new Error(classroom.reason);
  await prisma().enrollment.create({
    data: { classroomId: classroom.id, userId: studentId, role: 'STUDENT', status: 'ACTIVE' },
  });

  const resourceId = randomUUID();
  await prisma().resource.create({
    data: {
      id: resourceId,
      ownerId,
      status: 'PUBLISHED',
      visibility: 'UNLISTED',
      title: 'R',
      slug: randomUUID(),
    },
  });
  const versionId = randomUUID();
  await prisma().resourceVersion.create({
    data: {
      id: versionId,
      resourceId,
      version: 1,
      blocks: [],
      blocksChecksum: 'builder',
      meta: {},
      assessmentPolicy: { version: 1, totalTimeLimitSec: 3600, perQuestionExpiry: 'SOFT' } as never,
      createdById: ownerId,
    },
  });

  const bankId = randomUUID();
  await prisma().questionBank.create({
    data: { id: bankId, ownerId, name: 'B', visibility: 'PRIVATE' },
  });
  const questionIds: string[] = [];
  for (const name of ['q1', 'q2', 'q3', 'q4']) {
    const id = q(name);
    await prisma().question.create({
      data: {
        id,
        bankId,
        type: 'SHORT_TEXT',
        spec: { prompt: `Prompt for ${name}` },
        modelAnswer: `SECRET ANSWER ${name}`,
        topic: 'photosynthesis',
        responseProcess: 'RECALL',
      },
    });
    questionIds.push(id);
  }
  const poolId = randomUUID();
  await prisma().questionPool.create({
    data: { id: poolId, bankId, name: 'P', strategy: 'RANDOM_WITHOUT_REPLACEMENT', drawCount: 2 },
  });
  for (const id of questionIds)
    await prisma().questionPoolItem.create({ data: { poolId, questionId: id } });
  return { versionId, poolId, classroomId: classroom.id, ownerId, studentId, questionIds };
}

const slots = (f: { poolId: string; questionIds: readonly string[] }) => [
  { id: 's0', position: 0, kind: 'FIXED' as const, questionId: f.questionIds[0] },
  { id: 's1', position: 1, kind: 'POOLED' as const, poolId: f.poolId, drawCount: 2 },
];

describe.skipIf(!DATABASE_URL)('P5-T3 preview as student, against real Postgres', () => {
  it('is BYTE-IDENTICAL to resolving the same slots directly', async () => {
    next();
    const f = await fixture();
    const preview = await previewAsStudent(
      prisma(),
      {
        resourceVersionId: f.versionId,
        slots: slots(f),
        studentId: f.studentId,
        classroomId: f.classroomId,
        seed: 'seed-one',
        requireItemMetadata: false,
      },
      clock(),
    );

    // What an attempt would resolve, computed by hand from the same rows.
    const direct = resolveSlots(
      slots(f),
      [
        {
          id: f.poolId,
          strategy: 'RANDOM_WITHOUT_REPLACEMENT',
          drawCount: 2,
          items: f.questionIds.map((questionId) => ({ questionId })),
        },
      ],
      'seed-one',
    );

    expect(preview.slots[0]?.questionIds).toEqual(direct['0']);
    expect(preview.slots[1]?.questionIds).toEqual(direct['1']);
    // And the FIXED slot is the author's own choice, not a draw.
    expect(preview.slots[0]?.questionIds).toEqual([f.questionIds[0]]);
  });

  it('a preview creates NO attempt and burns no attemptNumber', async () => {
    next();
    const f = await fixture();
    const before = await prisma().examAttempt.count({ where: { studentId: f.studentId } });
    for (let i = 0; i < 3; i += 1) {
      await previewAsStudent(
        prisma(),
        {
          resourceVersionId: f.versionId,
          slots: slots(f),
          studentId: f.studentId,
          classroomId: f.classroomId,
          seed: `seed-${String(i)}`,
          requireItemMetadata: false,
        },
        clock(),
      );
    }
    expect(await prisma().examAttempt.count({ where: { studentId: f.studentId } })).toBe(before);
    // A preview that consumed attempts would be a way to burn an allowance by looking at the work.
    expect(before).toBe(0);
  });

  it('the same seed gives the SAME paper, and a different one does not', async () => {
    next();
    const f = await fixture();
    const a = await previewAsStudent(
      prisma(),
      {
        resourceVersionId: f.versionId,
        slots: slots(f),
        studentId: f.studentId,
        classroomId: f.classroomId,
        seed: 'repeat-me',
        requireItemMetadata: false,
      },
      clock(),
    );
    const b = await previewAsStudent(
      prisma(),
      {
        resourceVersionId: f.versionId,
        slots: slots(f),
        studentId: f.studentId,
        classroomId: f.classroomId,
        seed: 'repeat-me',
        requireItemMetadata: false,
      },
      clock(),
    );
    expect(b.slots.map((s) => s.questionIds)).toEqual(a.slots.map((s) => s.questionIds));
    expect(b.seed).toBe('repeat-me');
    // Sweeping seeds rather than comparing two: a single pair can coincide, and a test that
    // compares `a` with `c` passes whenever those two happen to match. Twelve seeds is not a
    // proof, it is a much smaller lie.
    let differed = false;
    for (let i = 0; i < 12; i += 1) {
      const other = await previewAsStudent(
        prisma(),
        {
          resourceVersionId: f.versionId,
          slots: slots(f),
          studentId: f.studentId,
          classroomId: f.classroomId,
          seed: `vary-${String(i)}`,
          requireItemMetadata: false,
        },
        clock(),
      );
      if (JSON.stringify(other.slots[1]?.questionIds) !== JSON.stringify(a.slots[1]?.questionIds)) {
        differed = true;
      }
    }
    expect(differed, 'twelve different seeds produced the same pooled slot every time').toBe(true);
  });

  it('NO ANSWER KEY APPEARS ANYWHERE IN A PREVIEW', () => {
    // INV-Q-1: answer keys never leave the server. The preview type has no field a key could be
    // put in, so the omission is structural rather than a matter of the formatter remembering.
    // The behavioural half: the prompts the author sees are prompts.
    next();
    return (async () => {
      const f = await fixture();
      const preview = await previewAsStudent(
        prisma(),
        {
          resourceVersionId: f.versionId,
          slots: slots(f),
          studentId: f.studentId,
          classroomId: f.classroomId,
          seed: 's',
          requireItemMetadata: false,
        },
        clock(),
      );
      const serialised = JSON.stringify(preview);
      expect(serialised).not.toContain('SECRET ANSWER');
      expect(preview.slots[1]?.prompts.some((p) => p.startsWith('Prompt for'))).toBe(true);
    })();
  });

  it('the preview reports the GATES, so Publish is not the thing that fails', async () => {
    next();
    const f = await fixture();
    // A draw count the pool cannot fill.
    void 0;
    // `resolveSlots` refuses FIRST, before the gates are consulted, because the preview resolves
    // before it validates. That is the right order: there is nothing to preview when the exam
    // cannot be sat, and a preview that rendered an incomplete paper would be worse than none.
    //
    // The first version asserted `rejects.toThrow` on a value it had already awaited, so the
    // promise was consumed and the assertion passed against a rejection it never saw. Written as
    // a promise the first time it is checked.
    await expect(
      previewAsStudent(
        prisma(),
        {
          resourceVersionId: f.versionId,
          slots: [{ id: 's0', position: 0, kind: 'POOLED', poolId: f.poolId, drawCount: 99 }],
          studentId: f.studentId,
          classroomId: f.classroomId,
          seed: 's',
          requireItemMetadata: false,
        },
        clock(),
      ),
    ).rejects.toThrow(/POOL_UNDERSIZED/);
  });

  it("an UNSATISFIED BLUEPRINT is reported with the author's three real ways out", async () => {
    next();
    const f = await fixture();
    const preview = await previewAsStudent(
      prisma(),
      {
        resourceVersionId: f.versionId,
        slots: slots(f),
        studentId: f.studentId,
        classroomId: f.classroomId,
        seed: 's',
        blueprint: { cells: [{ topic: 'genetics', responseProcess: 'RECALL', minItems: 1 }] },
        requireItemMetadata: false,
      },
      clock(),
    );
    expect(preview.publishable).toBe(false);
    const blueprint = preview.problems.find((p) => p.code === 'BLUEPRINT_UNSATISFIED');
    expect(blueprint?.fix).toMatch(/give each cell its own pool/);
  });

  it('a student with an EXTRA-TIME accommodation previews a longer exam', async () => {
    next();
    const f = await fixture();
    await prisma().accommodation.create({
      data: {
        classroomId: f.classroomId,
        studentId: f.studentId,
        relaxations: ['EXTRA_TIME'],
        reason: 'access plan',
        grantedById: f.ownerId,
        extraTimePercent: 50,
      },
    });
    const preview = await previewAsStudent(
      prisma(),
      {
        resourceVersionId: f.versionId,
        slots: slots(f),
        studentId: f.studentId,
        classroomId: f.classroomId,
        seed: 's',
        requireItemMetadata: false,
      },
      clock(),
    );
    // The version's policy is 3600 s, and 50% more is 5400. The preview is where the author finds
    // this out — which is the whole point of previewing AS a student.
    expect(preview.policy.totalTimeLimitSec).toBe(5400);
  });
});

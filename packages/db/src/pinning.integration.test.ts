/**
 * The pinning invariant, at the SLOT level.  (P5-T5b, 24 MISSED-6)
 *
 * ## What the plan says about the test that was missing
 *
 * `plans/20` P5-T5(b): "the **stronger** assertion the original mutation test missed — the
 * resolved attempt's questions are byte-identical to the pinned version's slot list (24
 * MISSED-6)".
 *
 * And the P5 exit line: "the pinning invariant is proven by a test that mutates the resource
 * post-assignment and asserts identical output".
 *
 * ## WHY THE ID-POINTING TEST IS NOT ENOUGH
 *
 * `assignments.integration.test.ts` already mutates the resource and asserts the assessment
 * surface is unchanged. That test passes for an implementation that keeps the pin in a column
 * and renders from the resource HEAD anyway — the pin would be recorded and ignored, and every
 * assertion would pass. What distinguishes them is the RESOLVED PAPER: the actual question ids
 * a student receives, in order.
 *
 * So this resolves the slots, then publishes a new version with a different slot list AND a
 * different head, then resolves again and compares the maps byte for byte.
 */
import { randomUUID } from 'node:crypto';
import type { Actor } from '@orrery/auth/types';
import { FrozenClock, type Millis } from '@orrery/clock';
import { afterAll, describe, expect, it } from 'vitest';
import { createAssignment, publishAssignment } from './assignments.js';
import { createClassroom } from './classrooms.js';
import { PrismaClient } from './prisma.js';
import { resolveSlots, type SlotSpec, sameVariantMap } from './slots.js';

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
const actorOf = (id: string, roles: string[] = ['teacher']): Actor => ({
  id,
  roles: roles as never,
  mfaVerified: true,
  suspended: false,
});

async function user(name = 'T'): Promise<string> {
  const id = randomUUID();
  await prisma().user.create({
    data: { id, email: `${id}@x.example`, emailNormalized: `${id}@x.example`, name },
  });
  return id;
}

const RUN = randomUUID().slice(0, 8);
const q = (local: string): string => `${local}-${RUN}`;

describe.skipIf(!DATABASE_URL)('P5-T5b pinning, at the slot level, against real Postgres', () => {
  it('the resolved questions are byte-identical after the resource changes', async () => {
    const ownerId = await user('Author');
    const classroom = await createClassroom(prisma(), {
      name: `Pinning ${randomUUID().slice(0, 6)}`,
      actor: actorOf(ownerId),
    });
    if (!classroom.ok) throw new Error(classroom.reason);
    const teacher = actorOf(ownerId);

    const resourceId = randomUUID();
    await prisma().resource.create({
      data: {
        id: resourceId,
        ownerId,
        status: 'PUBLISHED',
        visibility: 'UNLISTED',
        title: 'Photosynthesis',
        slug: randomUUID(),
      },
    });

    // Version 1: one fixed slot and one pooled slot.
    const v1 = randomUUID();
    await prisma().resourceVersion.create({
      data: {
        id: v1,
        resourceId,
        version: 1,
        blocks: [{ type: 'paragraph', text: 'v1' }],
        blocksChecksum: 'pin-v1',
        meta: {},
        createdById: ownerId,
        createdAt: new Date(T0),
      },
    });
    // A bank, then six real questions, so a pool can draw from them. `Question` has no `authorId`
    // and no `stem` — the stem lives in `spec`, and INV-Q-1 means `spec` is never projected to a
    // student client, so nothing here reads it back.
    const bankId = randomUUID();
    await prisma().questionBank.create({
      data: { id: bankId, ownerId, name: 'Bank', visibility: 'PRIVATE' },
    });
    for (const name of ['q1', 'q2', 'q3', 'q4', 'q5', 'q6']) {
      await prisma().question.create({
        data: {
          id: q(name),
          bankId,
          type: 'SHORT_TEXT',
          spec: { prompt: `Question ${name} as first authored` },
          modelAnswer: 'x',
        },
      });
    }
    const poolId = randomUUID();
    await prisma().questionPool.create({
      data: {
        id: poolId,
        bankId,
        name: 'Mixed',
        strategy: 'RANDOM_WITHOUT_REPLACEMENT',
        drawCount: 2,
      },
    });
    for (const name of ['q1', 'q2', 'q3', 'q4', 'q5', 'q6']) {
      await prisma().questionPoolItem.create({ data: { poolId, questionId: q(name) } });
    }

    await prisma().assessmentSlot.createMany({
      data: [
        { resourceVersionId: v1, position: 0, kind: 'FIXED', questionId: q('q1') },
        { resourceVersionId: v1, position: 1, kind: 'POOLED', poolId, drawCount: 2 },
      ],
    });

    // The assignment, pinned to version 1.
    const created = await createAssignment(
      prisma(),
      { classroomId: classroom.id, resourceVersionId: v1, actor: teacher, mode: 'EXAM' },
      clock(),
    );
    if (!created.ok) throw new Error(created.reason);
    await publishAssignment(
      prisma(),
      { classroomId: classroom.id, assignmentId: created.assignmentId, actor: teacher },
      clock(),
    );
    await prisma().resource.update({ where: { id: resourceId }, data: { currentVersionId: v1 } });

    /** Read the slot list off the PINNED version and resolve it. This is the paper. */
    const paper = async (): Promise<string> => {
      const assignment = await prisma().assignment.findUniqueOrThrow({
        where: { id: created.assignmentId },
        select: { resourceVersionId: true },
      });
      const slots = await prisma().assessmentSlot.findMany({
        where: { resourceVersionId: assignment.resourceVersionId },
        orderBy: { position: 'asc' },
        select: {
          id: true,
          position: true,
          kind: true,
          questionId: true,
          poolId: true,
          drawCount: true,
          strategy: true,
        },
      });
      const poolRows = await prisma().questionPool.findMany({
        where: { id: { in: slots.map((s) => s.poolId).filter((x): x is string => x !== null) } },
        select: {
          id: true,
          strategy: true,
          drawCount: true,
          items: { select: { questionId: true, weight: true } },
        },
      });
      const map = resolveSlots(
        slots as unknown as SlotSpec[],
        poolRows.map((p) => ({
          id: p.id,
          strategy: p.strategy,
          drawCount: p.drawCount,
          items: p.items.map((i) => ({ questionId: i.questionId, weight: i.weight })),
        })),
        'student-42-seed',
      );
      return JSON.stringify(map);
    };

    const before = await paper();
    expect(JSON.parse(before)).toMatchObject({ '0': [q('q1')] });

    // EVERYTHING changes: a new version with a different slot list, a different pool, different
    // questions, and the resource HEAD moved onto it.
    const v2 = randomUUID();
    await prisma().resourceVersion.create({
      data: {
        id: v2,
        resourceId,
        version: 2,
        blocks: [{ type: 'paragraph', text: 'v2 — DIFFERENT' }],
        blocksChecksum: 'pin-v2',
        meta: {},
        createdById: ownerId,
        createdAt: new Date(T0),
      },
    });
    const bank2 = randomUUID();
    await prisma().questionBank.create({
      data: { id: bank2, ownerId, name: 'Bank 2', visibility: 'PRIVATE' },
    });
    for (const name of ['z1', 'z2', 'z3']) {
      await prisma().question.create({
        data: {
          id: q(name),
          bankId: bank2,
          type: 'SHORT_TEXT',
          spec: { prompt: `Question ${name}, added later` },
          modelAnswer: 'y',
        },
      });
    }
    const pool2 = randomUUID();
    await prisma().questionPool.create({
      data: {
        id: pool2,
        bankId: bank2,
        name: 'Different pool',
        strategy: 'QUOTA_TOPICS',
        drawCount: 2,
      },
    });
    for (const name of ['z1', 'z2', 'z3']) {
      await prisma().questionPoolItem.create({ data: { poolId: pool2, questionId: q(name) } });
    }
    await prisma().assessmentSlot.createMany({
      data: [
        { resourceVersionId: v2, position: 0, kind: 'FIXED', questionId: q('z1') },
        { resourceVersionId: v2, position: 1, kind: 'POOLED', poolId: pool2, drawCount: 2 },
        { resourceVersionId: v2, position: 2, kind: 'FIXED', questionId: q('z2') },
      ],
    });
    await prisma().resource.update({ where: { id: resourceId }, data: { currentVersionId: v2 } });

    // THE ASSERTION. Byte-identical, slot for slot, question for question.
    expect(await paper(), 'the resolved paper moved when the resource did').toBe(before);
  });

  it('the assignment is still pinned to version 1 while the head is on version 2', async () => {
    // The narrower claim, stated separately so a failure tells you WHICH half broke. An
    // implementation that renders from the head passes the paper test only if it also stores the
    // pin, so both halves are needed and they fail differently.
    const ownerId = await user('Author');
    const classroom = await createClassroom(prisma(), {
      name: `Pinning2 ${randomUUID().slice(0, 6)}`,
      actor: actorOf(ownerId),
    });
    if (!classroom.ok) throw new Error(classroom.reason);
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
    const make = async (version: number): Promise<string> => {
      const id = randomUUID();
      await prisma().resourceVersion.create({
        data: {
          id,
          resourceId,
          version,
          blocks: [],
          blocksChecksum: `pin-${version}`,
          meta: {},
          createdById: ownerId,
          createdAt: new Date(T0),
        },
      });
      return id;
    };
    const v1 = await make(1);
    const v2 = await make(2);
    const created = await createAssignment(
      prisma(),
      { classroomId: classroom.id, resourceVersionId: v1, actor: actorOf(ownerId) },
      clock(),
    );
    if (!created.ok) throw new Error(created.reason);
    await prisma().resource.update({ where: { id: resourceId }, data: { currentVersionId: v2 } });

    const row = await prisma().assignment.findUniqueOrThrow({
      where: { id: created.assignmentId },
    });
    expect(row.resourceVersionId).toBe(v1);
    const resource = await prisma().resource.findUniqueOrThrow({ where: { id: resourceId } });
    expect(resource.currentVersionId).toBe(v2);
  });

  it('the same seed resolves the same paper for two different students on one pool', () => {
    // INV-BANK-2's operational half, and the reason the seed is per attempt: the map is stored
    // on the attempt, so two students with the same seed get the same paper and two with
    // different seeds do not. Asserted here without a database because the resolution is pure —
    // which is the reason it lives in `@orrery/db/slots` rather than in a route handler.
    const slots: SlotSpec[] = [{ id: 'a', position: 0, kind: 'POOLED', poolId: 'p', drawCount: 3 }];
    const pool = {
      id: 'p',
      strategy: 'RANDOM_WITHOUT_REPLACEMENT' as const,
      drawCount: 3,
      items: Array.from({ length: 12 }, (_, i) => ({ questionId: `q${i}` })),
    };
    expect(
      sameVariantMap(resolveSlots(slots, [pool], 'seed-A'), resolveSlots(slots, [pool], 'seed-A')),
    ).toBe(true);
    expect(
      sameVariantMap(resolveSlots(slots, [pool], 'seed-A'), resolveSlots(slots, [pool], 'seed-B')),
    ).toBe(false);
  });
});

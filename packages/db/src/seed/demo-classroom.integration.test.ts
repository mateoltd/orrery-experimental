/**
 * The demo-classroom half of P17-T2: a room that actually works, through the real kernel paths.
 */

import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@orrery/db/prisma';
import { afterAll, describe, expect, it } from 'vitest';
import {
  DEMO_CLASSROOM_SLUG,
  DEMO_STUDENT_EMAIL,
  DEMO_TEACHER_EMAIL,
  seedDemoClassroom,
} from './demo-classroom.js';
import { readResourceSeed, seedResources } from './resources.js';

let client: PrismaClient | null = null;
const prisma = (): PrismaClient => {
  if (process.env.DATABASE_URL === undefined || process.env.DATABASE_URL.length === 0) {
    throw new Error('DATABASE_URL is required: this test plants rows, not mocks of rows');
  }
  client ??= new PrismaClient();
  return client;
};
afterAll(async () => {
  await client?.$disconnect();
  client = null;
});

describe('seedDemoClassroom', () => {
  it('builds a working demo: teacher, student, room, three assignments -- twice without duplicating', async () => {
    const db = prisma();
    const ownerId = randomUUID();
    await db.user.create({
      data: {
        id: ownerId,
        email: `${ownerId}@seed.example`,
        emailNormalized: `${ownerId}@seed.example`,
        name: 'Seed',
      },
    });
    // Cleanup in dependency order: assignments reference the classroom, the classroom references
    // its owner (Restrict), so users go last. Deleting users first violates Classroom_ownerId_fkey.
    await db.assignment.deleteMany({ where: { classroom: { slug: DEMO_CLASSROOM_SLUG } } });
    await db.classroom.deleteMany({ where: { slug: DEMO_CLASSROOM_SLUG } });
    await db.user.deleteMany({
      where: { emailNormalized: { in: [DEMO_TEACHER_EMAIL, DEMO_STUDENT_EMAIL] } },
    });
    await db.resource.deleteMany({ where: { slug: DEMO_CLASSROOM_SLUG } });
    // Its OWN three resources under demo slugs, not the shared seed set: the resources suite plants
    // the same 30 slugs and vitest runs files in parallel against one database, so sharing the slug
    // namespace makes both suites count each other's rows. Isolation by namespace, not by hope.
    const seed = {
      resources: readResourceSeed()
        .resources.slice(0, 3)
        .map((r, i) => ({
          ...r,
          slug: `demo-resource-${i}`,
        })),
    };
    await db.resource.deleteMany({ where: { slug: { in: seed.resources.map((r) => r.slug) } } });
    await seedResources(db, ownerId, seed);

    const first = await seedDemoClassroom(
      db,
      seed.resources.map((r) => r.slug),
    );
    expect(first.created).toBe(true);
    expect(first.assignmentIds).toHaveLength(3);

    const room = await db.classroom.findFirst({
      where: { slug: DEMO_CLASSROOM_SLUG },
      select: { id: true, enrollments: { select: { userId: true } } },
    });
    expect(room?.enrollments.map((e) => e.userId).sort()).toEqual(
      [first.studentId, first.teacherId].sort(),
    );

    // Idempotent: the second run finds everything and fills nothing.
    const second = await seedDemoClassroom(
      db,
      seed.resources.map((r) => r.slug),
    );
    expect(second.created).toBe(false);
    expect(second.classroomId).toBe(first.classroomId);
    expect(second.assignmentIds).toHaveLength(3);
  });
});

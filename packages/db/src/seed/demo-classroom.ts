/**
 * DEMO CLASSROOM: a teacher, a student, a room, and three assignments.  (P17-T2)
 *
 * Goes through the REAL paths -- `createClassroom`, `addMember`, `createAssignment` -- and not around
 * them, because demo data planted with raw inserts would exercise none of the authorization the demo is
 * supposed to show working. If the kernel refuses any step, the seed fails LOUDLY rather than producing
 * a half-built classroom: a demo that exists but does not work is worse than no demo.
 *
 * Idempotent by fixed demo identity: `demo-teacher@demo.example` / `demo-student@demo.example` and the
 * `demo-` slug prefix. Re-running finds the users and the classroom and only fills what is missing.
 * Demo addresses live under `@demo.example`, which receives no mail -- a demo teacher who starts getting
 * real notifications is a privacy incident wearing a seed script.
 *
 * The three assignments are the first three seed resources alphabetically, each at its current version:
 * deterministic, documented, and enough to show an assignment list with content behind it. Thirty would
 * be a catalogue, not a demo.
 */

import { randomUUID } from 'node:crypto';
import type { Actor } from '@orrery/auth/types';
import { createAssignment } from '../assignments.js';
import { addMember, createClassroom } from '../classrooms.js';
import type { PrismaClient } from '../index.js';

export const DEMO_TEACHER_EMAIL = 'demo-teacher@demo.example';
export const DEMO_STUDENT_EMAIL = 'demo-student@demo.example';
export const DEMO_CLASSROOM_SLUG = 'demo-classroom';

export interface DemoSeedResult {
  readonly teacherId: string;
  readonly studentId: string;
  readonly classroomId: string;
  readonly assignmentIds: readonly string[];
  readonly created: boolean;
}

async function ensureUser(db: PrismaClient, email: string, name: string): Promise<string> {
  const existing = await db.user.findFirst({
    where: { emailNormalized: email },
    select: { id: true },
  });
  if (existing !== null) return existing.id;
  const created = await db.user.create({
    data: { id: randomUUID(), email, emailNormalized: email, name },
    select: { id: true },
  });
  return created.id;
}

export async function seedDemoClassroom(
  db: PrismaClient,
  resourceSlugs?: readonly string[],
): Promise<DemoSeedResult> {
  const teacherId = await ensureUser(db, DEMO_TEACHER_EMAIL, 'Demo Teacher');
  const studentId = await ensureUser(db, DEMO_STUDENT_EMAIL, 'Demo Student');
  const teacher: Actor = { id: teacherId, roles: ['teacher'], mfaVerified: true, suspended: false };

  const existing = await db.classroom.findFirst({
    where: { slug: DEMO_CLASSROOM_SLUG },
    select: { id: true },
  });
  let classroomId: string;
  let created = false;
  if (existing === null) {
    const outcome = await createClassroom(db, {
      name: 'Demo Classroom',
      description: 'Seeded demo: one teacher, one student, three assignments.',
      actor: teacher,
    });
    if (!outcome.ok) {
      // The kernel refused, and that refusal IS the finding: a demo that bypassed authorization
      // would prove nothing about the product it demonstrates.
      throw new Error(`demo classroom refused by the kernel: ${outcome.reason}`);
    }
    classroomId = outcome.id;
    created = true;
  } else {
    classroomId = existing.id;
  }

  const membership = await addMember(db, {
    classroomId,
    userId: studentId,
    role: 'STUDENT',
    actor: teacher,
  });
  // `addMember` is idempotent (`alreadyMember`), so re-running neither duplicates nor fails.
  if (!membership.ok) {
    throw new Error(`demo enrollment refused by the kernel: ${membership.reason}`);
  }

  // Deterministic by slug order. When the caller passes slugs (tests do, for isolation), only
  // those resources are assigned; otherwise the first three published alphabetically. The default is
  // documented as NON-ISOLATED: against a shared database it can pick up other suites' rows, which is
  // exactly the failure this parameter exists to prevent.
  // Existing assignments are kept: the seed fills what is missing rather than duplicating.
  const resources = await db.resource.findMany({
    where: {
      status: 'PUBLISHED',
      ...(resourceSlugs !== undefined ? { slug: { in: [...resourceSlugs] } } : {}),
    },
    select: { id: true, currentVersionId: true, slug: true },
    orderBy: { slug: 'asc' },
    take: 3,
  });
  const assignmentIds: string[] = [];
  for (const resource of resources) {
    if (resource.currentVersionId === null) continue;
    const existingAssignment = await db.assignment.findFirst({
      where: { classroomId, resourceId: resource.id },
      select: { id: true },
    });
    if (existingAssignment !== null) {
      assignmentIds.push(existingAssignment.id);
      continue;
    }
    const outcome = await createAssignment(db, {
      classroomId,
      resourceVersionId: resource.currentVersionId,
      actor: teacher,
    });
    if (!outcome.ok) {
      throw new Error(`demo assignment refused by the kernel: ${outcome.reason}`);
    }
    assignmentIds.push(outcome.assignmentId);
  }

  return { teacherId, studentId, classroomId, assignmentIds, created };
}

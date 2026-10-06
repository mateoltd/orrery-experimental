/**
 * The accommodations actions' teacher gate: the service trusts grantedById, so these must not.
 */

import { randomUUID } from 'node:crypto';
import { createClassroom } from '@orrery/db/classrooms';
import { PrismaClient } from '@orrery/db/prisma';
import { afterAll, describe, expect, it } from 'vitest';
import {
  grantAccommodationAction,
  listAccommodations,
  revokeAccommodationAction,
} from './accommodations.js';

let client: PrismaClient | null = null;
const prisma = (): PrismaClient => {
  if (process.env.DATABASE_URL === undefined || process.env.DATABASE_URL.length === 0) {
    throw new Error('DATABASE_URL is required');
  }
  client ??= new PrismaClient();
  return client;
};
afterAll(async () => {
  await client?.$disconnect();
  client = null;
});

async function person(): Promise<string> {
  const id = randomUUID();
  await prisma().user.create({
    data: { id, email: `${id}@r.example`, emailNormalized: `${id}@r.example`, name: 'P' },
  });
  return id;
}

async function roomWith(teacherId: string, studentId: string): Promise<string> {
  const db = prisma();
  const teacher = {
    id: teacherId,
    roles: ['teacher'],
    mfaVerified: true,
    suspended: false,
  } as const;
  const created = await createClassroom(db, { name: 'Acc', actor: teacher });
  if (!created.ok) throw new Error(`room refused: ${created.reason}`);
  const { addMember } = await import('@orrery/db/classrooms');
  const enrolled = await addMember(db, {
    classroomId: created.id,
    userId: studentId,
    role: 'STUDENT',
    actor: teacher,
  });
  if (!enrolled.ok) throw new Error(`enroll refused: ${enrolled.reason}`);
  return created.id;
}

describe('accommodation actions', () => {
  it('a teacher grants, the register shows it, revocation clears ACTIVE', async () => {
    const teacherId = await person();
    const studentId = await person();
    const classroomId = await roomWith(teacherId, studentId);
    const granted = await grantAccommodationAction({
      callerUserId: teacherId,
      classroomId,
      studentId,
      relaxations: ['DISABLE_FULLSCREEN'],
      reason: 'fluorescent lights trigger migraines, documented',
    });
    expect(granted.ok, granted.reason).toBe(true);
    const rows = await listAccommodations({ callerUserId: teacherId, classroomId });
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toBeDefined();
    expect(row?.studentEmail).toContain('@r.example');
    const revoked = await revokeAccommodationAction({
      callerUserId: teacherId,
      classroomId,
      accommodationId: row?.id ?? '',
    });
    expect(revoked.ok, revoked.reason).toBe(true);
    const after = await listAccommodations({ callerUserId: teacherId, classroomId });
    expect(after[0]?.status).not.toBe('ACTIVE');
  });

  it('a student gets nothing: no grant, no list, no revoke -- the service would trust them', async () => {
    const teacherId = await person();
    const studentId = await person();
    const classroomId = await roomWith(teacherId, studentId);
    // The critical assertion: grantAccommodation itself trusts grantedById, so if these actions
    // passed the caller through, a student could grant themselves extra time -- the most valuable
    // thing in the building to steal.
    const granted = await grantAccommodationAction({
      callerUserId: studentId,
      classroomId,
      studentId,
      relaxations: ['DISABLE_FULLSCREEN'],
      reason: 'self-granted extra anything, documented nowhere',
    });
    expect(granted.ok).toBe(false);
    expect(await listAccommodations({ callerUserId: studentId, classroomId })).toEqual([]);
    expect(
      (
        await revokeAccommodationAction({
          callerUserId: studentId,
          classroomId,
          accommodationId: randomUUID(),
        })
      ).ok,
    ).toBe(false);
  });
});

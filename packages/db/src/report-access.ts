import type { Actor } from '@orrery/auth/types';
import { permit } from './classrooms.js';
import type { PrismaClient, TxClient } from './index.js';

export class ReportDenied extends Error {
  constructor(readonly httpStatus: 403 | 404) {
    super('Teacher report access refused');
    this.name = 'ReportDenied';
  }
}

/** A global teacher role never authorises downloading a classroom where it is a student. */
export async function requireReportTeacher(
  db: PrismaClient | TxClient,
  actor: Actor,
  classroomId: string,
): Promise<void> {
  const decision = await permit(db, { actor, classroomId, action: 'read' });
  if (!decision.ok) throw new ReportDenied(decision.httpStatus);
  const membership = await db.enrollment.findFirst({
    where: { classroomId, userId: actor.id, status: 'ACTIVE', role: { in: ['OWNER', 'TEACHER'] } },
    select: { id: true },
  });
  if (membership === null) throw new ReportDenied(403);
}

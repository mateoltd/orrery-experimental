/**
 * ACCOMMODATIONS SERVER ACTIONS: grant during a live exam, register, audit export.  (P13-T6)
 *
 * The service layer (`packages/db/src/accommodations.ts`) grants, revokes, extends live deadlines and
 * records everything; what it does NOT do is check WHO is asking -- `grantedById` is taken on trust.
 * So these actions resolve the caller through `resolveActorForRequest` and require OWNER or TEACHER of
 * the classroom, because a grant endpoint that trusted its caller would let any authenticated student
 * grant themselves extra time, which is the single most valuable thing in the building to steal.
 *
 * The register this serves is ALSO the compliance record `P13-T6`'s row demands: granted-at, granted-by,
 * reason, and status are all read from rows, never reconstructed -- a register rebuilt from memory is a
 * decoration, and the row says why a late-built one cannot distinguish late-granted from never-granted.
 */

import { getPrisma } from '@orrery/db';
import { grantAccommodation, revokeAccommodation } from '@orrery/db/accommodations';
import { resolveActorForRequest } from '@orrery/db/classrooms';

export interface AccommodationActionResult {
  readonly ok: boolean;
  readonly reason: string;
}

async function callerCanGrant(input: {
  classroomId: string;
  callerUserId: string;
}): Promise<boolean> {
  const db = getPrisma();
  const actor = await resolveActorForRequest(db, input.callerUserId);
  if (actor === null) return false;
  const role = actor.classroomRoles[input.classroomId];
  return role === 'OWNER' || role === 'TEACHER';
}

const RELAXATIONS = [
  'DISABLE_FULLSCREEN',
  'DISABLE_POINTER_LOCK',
  'DISABLE_TAB_WATCHDOG',
  'EXTRA_TIME_PERCENT',
] as const;

('use server');

export async function grantAccommodationAction(input: {
  callerUserId: string;
  classroomId: string;
  studentId: string;
  relaxations: readonly string[];
  extraTimePercent?: number;
  reason: string;
}): Promise<AccommodationActionResult> {
  if (
    !(await callerCanGrant({ classroomId: input.classroomId, callerUserId: input.callerUserId }))
  ) {
    return {
      ok: false,
      reason: 'Only a teacher or owner of this classroom can grant accommodations.',
    };
  }
  const relaxations = input.relaxations.filter((r): r is (typeof RELAXATIONS)[number] =>
    (RELAXATIONS as readonly string[]).includes(r),
  );
  const db = getPrisma();
  const result = await grantAccommodation(db, {
    classroomId: input.classroomId,
    studentId: input.studentId,
    relaxations,
    extraTimePercent: input.extraTimePercent ?? null,
    reason: input.reason,
    grantedById: input.callerUserId,
    nowMs: Date.now(),
  });
  return result.ok ? { ok: true, reason: '' } : { ok: false, reason: result.message };
}

('use server');

export async function revokeAccommodationAction(input: {
  callerUserId: string;
  classroomId: string;
  accommodationId: string;
}): Promise<AccommodationActionResult> {
  if (
    !(await callerCanGrant({ classroomId: input.classroomId, callerUserId: input.callerUserId }))
  ) {
    return {
      ok: false,
      reason: 'Only a teacher or owner of this classroom can revoke accommodations.',
    };
  }
  const db = getPrisma();
  const result = await revokeAccommodation(db, {
    accommodationId: input.accommodationId,
    revokedById: input.callerUserId,
    nowMs: Date.now(),
  });
  return result.ok ? { ok: true, reason: '' } : { ok: false, reason: result.message };
}

export interface AccommodationRow {
  readonly id: string;
  readonly studentEmail: string;
  readonly relaxations: readonly string[];
  readonly extraTimePercent: string | null;
  readonly reason: string;
  readonly status: string;
  readonly grantedAt: string;
  readonly grantedBy: string;
}

/** The register: every grant in the room with who, what, when and whether it still stands. */
export async function listAccommodations(input: {
  callerUserId: string;
  classroomId: string;
}): Promise<readonly AccommodationRow[]> {
  'use server';
  if (!(await callerCanGrant({ classroomId: input.classroomId, callerUserId: input.callerUserId })))
    return [];
  const db = getPrisma();
  const rows = await db.accommodation.findMany({
    where: { classroomId: input.classroomId },
    include: {
      student: { select: { email: true } },
      grantedBy: { select: { email: true } },
    },
    orderBy: { grantedAt: 'desc' },
  });
  return rows.map((row) => ({
    id: row.id,
    studentEmail: row.student.email,
    relaxations: row.relaxations,
    extraTimePercent: row.extraTimePercent?.toString() ?? null,
    reason: row.reason,
    status: row.status,
    grantedAt: row.grantedAt.toISOString(),
    grantedBy: row.grantedBy.email,
  }));
}

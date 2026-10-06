/**
 * ADMIN SERVER ACTIONS: suspension through the session, never around it.  (P17-T5, admin half)
 *
 * Every action resolves the CALLER through `resolveActorForRequest` first and fails closed on null --
 * the same shape as the roster actions. The target's roles are resolved the same way, because
 * `suspendUser` takes `targetRoles` explicitly and inventing them here would be the fiction its header
 * refuses.
 */

import { getPrisma } from '@orrery/db';
import { suspendUser, unsuspendUser } from '@orrery/db/admin';
import { resolveActorForRequest } from '@orrery/db/classrooms';

export interface AdminActionResult {
  readonly ok: boolean;
  readonly reason: string;
}

export async function suspendUserAction(input: {
  callerUserId: string;
  targetUserId: string;
  reason: string;
}): Promise<AdminActionResult> {
  const db = getPrisma();
  const actor = await resolveActorForRequest(db, input.callerUserId);
  if (actor === null) return { ok: false, reason: 'Your session is not valid any more.' };
  const target = await resolveActorForRequest(db, input.targetUserId);
  const result = await suspendUser(
    db,
    { id: actor.id, roles: actor.roles },
    {
      userId: input.targetUserId,
      targetRoles: target === null ? [] : target.roles,
      reason: input.reason,
    },
  );
  return result.ok ? { ok: true, reason: '' } : { ok: false, reason: result.reason };
}

export async function unsuspendUserAction(input: {
  callerUserId: string;
  targetUserId: string;
}): Promise<AdminActionResult> {
  const db = getPrisma();
  const actor = await resolveActorForRequest(db, input.callerUserId);
  if (actor === null) return { ok: false, reason: 'Your session is not valid any more.' };
  const result = await unsuspendUser(db, { id: actor.id, roles: actor.roles }, input.targetUserId);
  return result.ok ? { ok: true, reason: '' } : { ok: false, reason: result.reason };
}

export interface AdminUserRow {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly suspendedAt: string | null;
  readonly suspendedReason: string | null;
}

/** Users for the admin list, newest first. The caller must already be an admin; this lists, not gates. */
export async function listUsersForAdmin(input: {
  callerUserId: string;
  query: string;
}): Promise<readonly AdminUserRow[]> {
  const db = getPrisma();
  const actor = await resolveActorForRequest(db, input.callerUserId);
  if (actor === null || !actor.roles.includes('platformAdmin')) return [];
  const q = input.query.trim();
  return db.user
    .findMany({
      where: q.length === 0 ? {} : { OR: [{ email: { contains: q } }, { name: { contains: q } }] },
      select: { id: true, email: true, name: true, suspendedAt: true, suspendedReason: true },
      orderBy: { createdAt: 'desc' },
      take: 50,
    })
    .then((rows) =>
      rows.map((row) => ({
        ...row,
        suspendedAt: row.suspendedAt?.toISOString() ?? null,
      })),
    );
}

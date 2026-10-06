/**
 * ADMIN SERVER ACTIONS: suspension through the session, never around it.  (P17-T5, admin half)
 *
 * Every action resolves the CALLER through `resolveActorForRequest` first and fails closed on null --
 * the same shape as the roster actions. The target's roles are resolved the same way, because
 * `suspendUser` takes `targetRoles` explicitly and inventing them here would be the fiction its header
 * refuses.
 */

import {
  IMPERSONATION_COOKIE,
  impersonationAuditEntry,
  impersonationCookieOptions,
  signImpersonationCookie,
  startImpersonation,
} from '@orrery/auth/impersonation';
import type { Millis } from '@orrery/clock';
import { getPrisma } from '@orrery/db';
import { suspendUser, unsuspendUser } from '@orrery/db/admin';
import { resolveActorForRequest } from '@orrery/db/classrooms';
import { cookies } from 'next/headers';

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

/**
 * START/STOP IMPERSONATION. The surface the signed cookie was waiting for.  (P17-T5, second half)
 *
 * Start resolves BOTH actors through the kernel, runs the pure `startImpersonation` verdict (admin-only,
 * no self, target active, one concurrent), signs with `AUTH_SECRET` -- reused deliberately per the
 * impersonation module's documented decision -- sets the cookie, and writes the audit entry. Every one
 * of those steps can refuse, and every refusal returns a reason rather than throwing, because an admin
 * action that throws is an admin action that leaves no trace of the attempt.
 */
export async function startImpersonationAction(input: {
  callerUserId: string;
  targetUserId: string;
  reason: string;
}): Promise<AdminActionResult> {
  const db = getPrisma();
  const actor = await resolveActorForRequest(db, input.callerUserId);
  if (actor === null) return { ok: false, reason: 'Your session is not valid any more.' };
  const target = await resolveActorForRequest(db, input.targetUserId);
  if (target === null) return { ok: false, reason: 'No such active user.' };
  if (input.reason.trim().length < 3) {
    return { ok: false, reason: 'Impersonation needs a reason a reviewer can act on.' };
  }
  const verdict = startImpersonation({
    actorId: actor.id,
    actorRoles: actor.roles,
    targetUserId: input.targetUserId,
    targetIsActive: true,
    alreadyActive: 0,
    now: Date.now(),
  });
  if (!verdict.ok) return { ok: false, reason: verdict.reason };
  const secret = process.env.AUTH_SECRET;
  if (typeof secret !== 'string' || secret.length < 32) {
    return { ok: false, reason: 'Impersonation is not configured on this deployment.' };
  }
  const now = Date.now() as Millis;
  const state = {
    byUserId: actor.id,
    byDisplayName: '',
    targetUserId: input.targetUserId,
    targetDisplayName: '',
    startedAt: now,
    expiresAt: verdict.until,
    reason: input.reason,
  };
  const signed = await signImpersonationCookie(state, secret);
  const jar = await cookies();
  const options = impersonationCookieOptions(state, now);
  jar.set(IMPERSONATION_COOKIE.name, signed, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: Math.floor(options.maxAge / 1000),
  });
  const entry = impersonationAuditEntry(state, Date.now());
  // Via JSON round-trip, not a cast: the audit row must hold data, and `as InputJsonValue` would
  // assert that without checking it. A round-trip throws on undefined/functions instead of storing them.
  const meta = JSON.parse(JSON.stringify(entry.meta)) as Record<string, unknown>;
  await db.auditEvent.create({
    data: {
      actorId: entry.actorId,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      meta: meta as never,
    },
  });
  return { ok: true, reason: '' };
}

export async function stopImpersonationAction(): Promise<AdminActionResult> {
  const jar = await cookies();
  jar.delete(IMPERSONATION_COOKIE.name);
  return { ok: true, reason: '' };
}

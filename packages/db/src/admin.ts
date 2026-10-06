/**
 * PLATFORM ADMIN: suspend / unsuspend users, with an audit trail.  (P17-T5, admin half)
 *
 * The schema carried `suspendedAt` + `suspendedReason` and sign-in honoured them, but NO WRITER EXISTED:
 * suspension was a field nothing could set, so the only suspended accounts were ones somebody edited in
 * the database by hand. An admin surface without a service function is a button wired to nothing; a
 * service function without an admin surface is this file's predecessor. This is the function half.
 *
 * ## RULES, EACH WITH ITS REASON
 *
 * - **platformAdmin only.** Checked against the ACTOR's roles, not a request flag, because a role in the
 *   session is a fact and a flag in the request is a claim.
 * - **No self-suspension.** An admin who suspends themselves locks the only key that can unsuspend them;
 *   the refusal names the reason rather than failing silently.
 * - **No suspending another platformAdmin.** Peer admins are removed by a process outside this function
 *   (there isn't one yet, and inventing demotion here would be inventing governance). Stated, not solved.
 * - **Every grant and revocation writes an `AuditEvent`.** A suspension without an audit row is an action
 *   nobody can review, and the support agent answering "is this the same suspension from March" needs the
 *   row, not the field.
 * - **Unsuspend clears BOTH `suspendedAt` and `suspendedReason`.** Clearing the date but keeping the reason
 *   leaves a user who reads as suspended in every query that checks the reason first.
 */

import type { Role } from '@orrery/auth/types';
import type { PrismaClient } from './index.js';

export interface AdminActor {
  readonly id: string;
  readonly roles: readonly Role[];
}

export type SuspendOutcome =
  | { readonly ok: true; readonly userId: string }
  | { readonly ok: false; readonly httpStatus: 403 | 404; readonly reason: string };

function isPlatformAdmin(actor: AdminActor): boolean {
  return actor.roles.includes('platformAdmin');
}

export interface SuspendInput {
  readonly userId: string;
  /**
   * The target's kernel roles, resolved by the CALLER the same way the actor's were -- there is no
   * `roles` column on `User`, and pretending this function can see global roles from the row would be
   * a check against a fiction. `platformAdmin` peer accounts are removed by process, not by suspension.
   */
  readonly targetRoles: readonly Role[];
  readonly reason: string;
}

export async function suspendUser(
  db: PrismaClient,
  actor: AdminActor,
  input: SuspendInput,
  now: Date = new Date(),
): Promise<SuspendOutcome> {
  if (!isPlatformAdmin(actor)) {
    return { ok: false, httpStatus: 403, reason: 'platformAdmin role required' };
  }
  if (actor.id === input.userId) {
    return { ok: false, httpStatus: 403, reason: 'an admin cannot suspend themselves' };
  }
  if (input.reason.trim().length === 0) {
    return {
      ok: false,
      httpStatus: 403,
      reason: 'a suspension without a reason cannot be reviewed',
    };
  }
  const target = await db.user.findUnique({
    select: { id: true },
    where: { id: input.userId },
  });
  if (target === null) return { ok: false, httpStatus: 404, reason: 'no such user' };
  if (input.targetRoles.includes('platformAdmin')) {
    return {
      ok: false,
      httpStatus: 403,
      reason: 'platformAdmin accounts are removed by process, not by suspension',
    };
  }
  await db.user.update({
    where: { id: input.userId },
    data: { suspendedAt: now, suspendedReason: input.reason },
  });
  await db.auditEvent.create({
    data: {
      actorId: actor.id,
      action: 'USER_SUSPENDED',
      targetType: 'User',
      targetId: input.userId,
      meta: { reason: input.reason },
    },
  });
  return { ok: true, userId: input.userId };
}

export async function unsuspendUser(
  db: PrismaClient,
  actor: AdminActor,
  userId: string,
): Promise<SuspendOutcome> {
  if (!isPlatformAdmin(actor)) {
    return { ok: false, httpStatus: 403, reason: 'platformAdmin role required' };
  }
  const target = await db.user.findUnique({
    select: { id: true, suspendedAt: true },
    where: { id: userId },
  });
  if (target === null) return { ok: false, httpStatus: 404, reason: 'no such user' };
  await db.user.update({
    where: { id: userId },
    data: { suspendedAt: null, suspendedReason: null },
  });
  await db.auditEvent.create({
    data: {
      actorId: actor.id,
      action: 'USER_UNSUSPENDED',
      targetType: 'User',
      targetId: userId,
      meta: {},
    },
  });
  return { ok: true, userId };
}

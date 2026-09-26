/**
 * Session persistence.  (P1-T4, INV-AUTH-1, C25)
 *
 * ## Why this is in `packages/db` and not `packages/auth`
 *
 * The ESLint rule bans `@prisma/client` outside this package, and that rule is right: a
 * package that can open a transaction can decide anything. So the kernel and the cache stay
 * pure and take an injected store, and this module is the one implementation of it.
 *
 * ## The two writes that must never be separated
 *
 * `revokeAllSessions` and `bumpEpoch` are BOTH in the transaction, and the reason is the whole
 * point of the design. A revoke that commits without the epoch bump leaves every cache in
 * every replica serving a dead session for up to its TTL — which is precisely the C25 defect,
 * re-introduced through the back door by writing correct code in the wrong order.
 *
 * That is why there is no `revokeWithoutInvalidatingCache` exported, and why the transaction
 * spans both statements rather than relying on a caller to remember.
 */

import type { RevokeReason, SessionState } from '@orrery/auth/session';
import type { Millis } from '@orrery/clock';
import type { PrismaClient, TxClient } from './index.js';

export interface SessionRow {
  readonly id: string;
  readonly userId: string;
  readonly tokenHash: string;
  readonly familyId: string;
  /**
   * Maps to `SessionState.issuedAt`.
   *
   * The policy anchors the ABSOLUTE expiry cap to `issuedAt`, and the column is called
   * `createdAt`. They are the same instant: a session row is created exactly when it is
   * issued, and `createdAt` is immutable in Prisma. Adding an `issuedAt` column would
   * duplicate a value that already exists and give the two a chance to disagree — so the
   * rename happens here, in the one function that converts a row into policy language, and
   * nowhere else.
   *
   * This mismatch was invisible to 207 unit tests and surfaced the moment the integration
   * suite ran a real `select` against the real model.
   */
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
  readonly revokedReason: string | null;
}

/** Database row -> the pure `SessionState` the policy speaks. */
export function toSessionState(row: SessionRow): SessionState {
  return {
    userId: row.userId,
    sessionId: row.id,
    familyId: row.familyId,
    issuedAt: row.createdAt.getTime() as Millis,
    expiresAt: row.expiresAt.getTime() as Millis,
    revokedAt: row.revokedAt === null ? null : (row.revokedAt.getTime() as Millis),
    revokedReason: (row.revokedReason as RevokeReason | null) ?? null,
    slidCount: 0,
  };
}

/**
 * Revoke every live session for a user AND bump their epoch, in ONE transaction.
 *
 * Returns how many sessions were revoked, so the caller can assert the number rather than
 * trust it — a revoke that silently affected zero rows is a failure that looks like success.
 */
export async function revokeAllSessionsAndBumpEpoch(
  tx: TxClient,
  input: { userId: string; reason: RevokeReason; now: Date },
): Promise<number> {
  const { count } = await tx.session.updateMany({
    where: { userId: input.userId, revokedAt: null },
    data: { revokedAt: input.now, revokedReason: input.reason },
  });
  // The epoch moves REGARDLESS of whether any sessions matched. A user with zero live
  // sessions can still have rows in somebody else's cache, and a conditional bump would skip
  // exactly the case where the caller most needs to be sure.
  await tx.user.update({
    where: { id: input.userId },
    data: { sessionsEpoch: { increment: 1 } },
  });
  return count;
}

/** Revoke one session and bump the epoch. Used by the "revoke this device" button. */
export async function revokeSessionAndBumpEpoch(
  tx: TxClient,
  input: { sessionId: string; userId: string; reason: RevokeReason; now: Date },
): Promise<boolean> {
  const { count } = await tx.session.updateMany({
    where: { id: input.sessionId, userId: input.userId, revokedAt: null },
    data: { revokedAt: input.now, revokedReason: input.reason },
  });
  if (count > 0) {
    await tx.user.update({
      where: { id: input.userId },
      data: { sessionsEpoch: { increment: 1 } },
    });
  }
  return count > 0;
}

/**
 * The epoch, read from the PRIMARY.
 *
 * Not `$primary` by default in every deployment, so the connection string decides, and this
 * function's contract is simply "whatever the primary says". Reading it from a replica that
 * has not replicated the revoke is the one way this design can be defeated, and it is a
 * deployment property rather than a code property.
 */
export async function readSessionsEpoch(tx: TxClient, userId: string): Promise<number> {
  const row = await tx.user.findUnique({
    where: { id: userId },
    select: { sessionsEpoch: true },
  });
  return row?.sessionsEpoch ?? 0;
}

/** Build the `SessionStore` the cache expects, over a client. */
export function prismaSessionStore(prisma: PrismaClient) {
  return {
    loadSession: async (tokenHash: string): Promise<SessionState | null> => {
      const row = await prisma.session.findUnique({
        where: { tokenHash },
        select: {
          id: true,
          userId: true,
          tokenHash: true,
          familyId: true,
          createdAt: true,
          expiresAt: true,
          revokedAt: true,
          revokedReason: true,
        },
      });
      return row === null ? null : toSessionState(row);
    },
    readEpoch: (userId: string): Promise<number> => readSessionsEpoch(prisma, userId),
  };
}

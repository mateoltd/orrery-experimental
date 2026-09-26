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

/**
 * A session as the DEVICE LIST needs it.
 *
 * Deliberately carries NO raw user agent. `Session.userAgent` is stored because it is evidence
 * in an investigation, but sending the raw string to the browser puts a fingerprintable value
 * on the wire, into a log, and into a screenshot a student might take of their own account. The
 * client gets a coarse human label instead — "Chrome on Windows" — which is what somebody
 * recognising their own laptop actually needs.
 *
 * This is the same reasoning as `ipPseudonym`: store the evidence, expose the summary.
 */
export interface SessionSummary {
  readonly id: string;
  readonly lastSeenAt: Date;
  readonly createdAt: Date;
  readonly device: string;
  readonly current: boolean;
}

/** Coarse, non-fingerprintable device label. UNRECOGNISED values become "Unknown device". */
export function describeDevice(userAgent: string | null | undefined): string {
  if (!userAgent) return 'Unknown device';
  const ua = userAgent.toLowerCase();
  const os = ua.includes('windows')
    ? 'Windows'
    : ua.includes('mac os') || ua.includes('macintosh')
      ? 'macOS'
      : ua.includes('android')
        ? 'Android'
        : ua.includes('iphone') || ua.includes('ipad')
          ? 'iOS'
          : ua.includes('linux')
            ? 'Linux'
            : null;
  // An unrecognised user agent yields "Unknown device" rather than a guess. Guessing wrong is
  // worse than not knowing: a student told "Chrome on Windows" when they are on a Chromebook
  // will revoke the wrong session.
  if (os === null) return 'Unknown device';
  const browser = ua.includes('edg/')
    ? 'Edge'
    : ua.includes('opr/') || ua.includes('opera')
      ? 'Opera'
      : ua.includes('firefox')
        ? 'Firefox'
        : ua.includes('chrome')
          ? 'Chrome'
          : ua.includes('safari')
            ? 'Safari'
            : 'a browser';
  return `${browser} on ${os}`;
}

/**
 * Every live session for a user, newest first.
 *
 * `currentSessionId` marks the row the reader is using, so the UI can say "this device" rather
 * than making them work out which row is theirs.
 */
export async function listSessions(
  tx: TxClient,
  input: { userId: string; currentSessionId?: string },
): Promise<SessionSummary[]> {
  const rows = await tx.session.findMany({
    where: { userId: input.userId, revokedAt: null },
    orderBy: { createdAt: 'desc' },
    select: { id: true, createdAt: true, userAgent: true, lastSeenAt: true },
  });
  return rows.map((r) => ({
    id: r.id,
    createdAt: r.createdAt,
    lastSeenAt: r.lastSeenAt ?? r.createdAt,
    device: describeDevice(r.userAgent),
    current: r.id === input.currentSessionId,
  }));
}

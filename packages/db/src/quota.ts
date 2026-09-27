/**
 * Storage quota, enforced where the bytes are stored.  (P2-T6, INV-QUOTA-1)
 *
 * ## Why this is not a presign check
 *
 * The obvious place to enforce a quota is when the upload is authorised: look at the user's
 * usage, compare it to their limit, refuse if it is over. That check is **advisory**, and the
 * packet says so directly — "enforced in the transaction that stores the bytes, not at presign
 * time, which is advisory".
 *
 * The reason is a race, and it is not a subtle one. Between the presign check and the store, the
 * same user can complete three other uploads. Three presign checks each saw room for one more.
 * The user is now over quota, and every one of those checks passed. Quotas checked at the door
 * are quotas that a user with four parallel tabs walks straight through.
 *
 * So the definitive check is a single conditional UPDATE inside the storing transaction:
 *
 * ```sql
 * UPDATE "User" SET "storageUsedBytes" = "storageUsedBytes" + $size
 * WHERE id = $user AND "storageUsedBytes" + $size <= "storageQuotaBytes"
 * RETURNING id
 * ```
 *
 * One statement, so there is no window between the read and the write for another transaction to
 * slip through, and zero rows returned IS the refusal. There is no second code path that could
 * forget to check.
 */

import { DEFAULT_QUOTA_BYTES } from '@orrery/contracts/media';
import type { PrismaClient, TxClient } from './index.js';

type Db = PrismaClient | TxClient;

export class QuotaError extends Error {
  constructor(
    message: string,
    readonly code: 'overQuota' | 'noSuchUser',
    readonly used: bigint,
    readonly limit: bigint,
    readonly requested: bigint,
  ) {
    super(message);
    this.name = 'QuotaError';
  }
}

export interface QuotaState {
  readonly usedBytes: bigint;
  readonly quotaBytes: bigint;
  readonly remainingBytes: bigint;
}

/**
 * Read the current usage. For display only.
 *
 * Named `peek` rather than `check`/`assert` on purpose: this is the function a UI is tempted to
 * call before an upload, and calling it *is* the bug INV-QUOTA-1 exists to prevent. The name says
 * it does not decide.
 */
export async function peekQuota(db: Db, userId: string): Promise<QuotaState> {
  const row = await db.user.findUnique({
    where: { id: userId },
    select: { storageUsedBytes: true, storageQuotaBytes: true },
  });
  if (row === null) throw new QuotaError('no such user', 'noSuchUser', 0n, 0n, 0n);
  return {
    usedBytes: row.storageUsedBytes,
    quotaBytes: row.storageQuotaBytes,
    remainingBytes:
      row.storageQuotaBytes > row.storageUsedBytes
        ? row.storageQuotaBytes - row.storageUsedBytes
        : 0n,
  };
}

/**
 * Reserve `bytes` against the user's quota, atomically, or throw.
 *
 * Must be called with the SAME transaction that writes the asset. That is not a convention: if
 * the reservation and the insert are in different transactions then a failed insert leaves the
 * user permanently charged for bytes they never stored, and a quota that leaks is a quota
 * everybody stops trusting.
 */
export async function reserveQuota(
  tx: TxClient,
  userId: string,
  bytes: bigint,
): Promise<QuotaState> {
  if (bytes < 0n) throw new TypeError('a reservation cannot be negative');

  // ONE statement: compare-and-increment, with the limit in the WHERE clause. Raw and
  // parameterised, because Prisma cannot express a conditional update whose predicate is on the
  // value it is also updating -- and `plans/14` allows raw SQL in `packages/db/src` precisely for
  // this, provided it is parameterised. There are no interpolated values here.
  const reserved = await tx.$queryRaw<{ id: string }[]>`
    UPDATE "User"
       SET "storageUsedBytes" = "storageUsedBytes" + ${bytes}
     WHERE id = ${userId}
       AND "storageUsedBytes" + ${bytes} <= "storageQuotaBytes"
    RETURNING id
  `;

  if (reserved.length === 0) {
    // Refused. Read the numbers back only to REPORT them, never to decide — re-deciding here
    // would reintroduce exactly the read-then-write window this design exists to close.
    const state = await peekQuota(tx, userId).catch(() => ({
      usedBytes: 0n,
      quotaBytes: 0n,
      remainingBytes: 0n,
    }));
    throw new QuotaError(
      `That upload needs ${formatBytes(bytes)} and you have ${formatBytes(state.remainingBytes)} of ` +
        `${formatBytes(state.quotaBytes)} left. Delete something you no longer need, or ask an ` +
        `administrator to raise your limit.`,
      'overQuota',
      state.usedBytes,
      state.quotaBytes,
      bytes,
    );
  }

  const state = await peekQuota(tx, userId);
  return state;
}

/**
 * Release a reservation when the bytes go away.
 *
 * `GREATEST(0, ...)` so a double release cannot push the counter negative and hand the user free
 * space they never had. Idempotency is the caller's problem, but arithmetic underflow is not.
 */
export async function releaseQuota(tx: TxClient, userId: string, bytes: bigint): Promise<void> {
  await tx.$queryRaw`
    UPDATE "User"
       SET "storageUsedBytes" = GREATEST(0, "storageUsedBytes" - ${bytes})
     WHERE id = ${userId}
  `;
}

/** Set a user's limit. Admin-only in the route; here it is just the write. */
export async function setQuota(db: Db, userId: string, quotaBytes: bigint): Promise<QuotaState> {
  await db.user.update({ where: { id: userId }, data: { storageQuotaBytes: quotaBytes } });
  return peekQuota(db, userId);
}

export function formatBytes(bytes: bigint | number): string {
  const n = typeof bytes === 'bigint' ? Number(bytes) : bytes;
  if (n < 1000) return `${n} B`;
  if (n < 1000 * 1000) return `${(n / 1000).toFixed(0)} KB`;
  if (n < 1000 * 1000 * 1000) return `${(n / 1000 / 1000).toFixed(1)} MB`;
  return `${(n / 1000 / 1000 / 1000).toFixed(2)} GB`;
}

export { DEFAULT_QUOTA_BYTES };

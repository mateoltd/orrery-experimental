/**
 * The advisory lock a cron runs behind.  (P8-T9)
 *
 * ## WHY IT LIVES HERE AND NOT IN `apps/worker`
 *
 * Because the argument for using Postgres for this lock is "the lock and the data it protects are in the same database,
 * so they cannot disagree" -- and that argument only holds if the code expressing it sits with the data. A lock helper
 * in the worker is a lock helper that will drift toward a different database the moment a second writer appears.
 *
 * It also makes the thing testable: a test in this package can import the REAL function, rather than a copy of it. The
 * first version of `run-exclusive.integration.test.ts` re-implemented the lock inside the test -- while its own comment
 * explained why testing a copy is how a lock ends up correct in tests and absent in production.
 *
 * ## WHY A LOCK AND NOT A SCHEDULE THAT ASSUMES ONE WORKER
 *
 * A cron that runs on every replica needs one of two things: a guarantee there is exactly one replica, or a lock. The
 * guarantee does not exist -- a rolling deploy has two for a while, and a crash-looping pod overlaps its replacement --
 * so the lock is the mechanism. `pg_try_advisory_lock` rather than the blocking form, because a worker that waits is a
 * worker not consuming the queue.
 */

import type { PrismaClient } from '../prisma/generated/client/client.js';

/** The minimum this needs: two raw-query round trips on one connection. */
export type LockDb = Pick<PrismaClient, '$queryRawUnsafe'>;

export interface RunExclusiveOptions {
  /**
   * Prisma's `$queryRawUnsafe` takes its bind values positionally after the query, and the lock call needs one.
   * Typed narrowly so the call site is checked.
   */
  readonly query: string;
  readonly values?: readonly unknown[];
}

/**
 * RUN `fn` AT MOST ONCE ACROSS THE WHOLE CLUSTER.
 *
 * `null` means another worker holds the lock and declined the work -- which is **not a failure and is the entire point**,
 * so the return type distinguishes "declined" from "ran and returned nothing" (`T` may legitimately be `null`).
 */
export async function runExclusive<T>(
  db: LockDb,
  key: string,
  fn: () => Promise<T>,
  onDeclined?: (key: string) => void,
): Promise<T | null> {
  const locked = await db.$queryRawUnsafe<{ locked: boolean }[]>(
    'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
    key,
  );

  if (locked[0]?.locked !== true) {
    onDeclined?.(key);
    return null;
  }

  try {
    return await fn();
  } finally {
    /**
     * THE `FINALLY` IS THE LOAD-BEARING PART.
     *
     * A lock leaked by a throw would silently stop the sweep forever, and "a missed sweep is an alert" would be false
     * because nothing would ever report a miss. The advisory unlock is idempotent, so this is also safe after an
     * implicit release by a failed transaction.
     *
     * It is deliberately NOT inside the transaction `fn` opens. `pg_advisory_lock` is session-scoped, so a lock taken
     * inside a transaction is released by that transaction's rollback -- which would let the next tick in while this
     * one is still unwinding.
     */
    await db.$queryRawUnsafe('SELECT pg_advisory_unlock(hashtext($1))', key);
  }
}

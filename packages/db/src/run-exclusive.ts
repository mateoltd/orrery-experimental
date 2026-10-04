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

/**
 * The minimum this needs: `$transaction`, because the lock and its unlock must run on ONE session.
 *
 * `$queryRawUnsafe` alone is no longer enough, and that is the defect this type now encodes: with only the raw-query
 * method there is no way to pin a connection, and two raw queries on a pool are two connections whenever the pool
 * decides otherwise. See the note on `runExclusive`.
 */
export type LockDb = Pick<PrismaClient, '$queryRawUnsafe' | '$transaction'>;

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
  /**
   * ⚠️ **THE LOCK AND THE UNLOCK MUST SHARE ONE CONNECTION, AND FOR A WHILE THEY DID NOT.**
   *
   * This used to issue two independent `$queryRawUnsafe` calls on a pooled client. `pg_try_advisory_lock` is a
   * **SESSION**-scoped lock, so it belongs to the connection that took it -- and `pg_advisory_unlock` from a
   * *different* pooled connection does not release it. Two round trips on a pool are two connections whenever the
   * pool decides otherwise, so the unlock silently became a no-op some fraction of the time and **the lock leaked**.
   *
   * WHAT A LEAKED SWEEP LOCK COSTS, since this is the whole argument for fixing it rather than documenting it. The
   * lock is held by a session that stays in the pool, so every later `runExclusive` for that key is declined. The
   * sweep then stops: expired attempts are never auto-submitted and per-question windows are never closed by cron.
   * Nothing crashes. Nothing throws. `onDeclined` fires, which is exactly what it is for, and every tick after the
   * first leak is a *correct* decline of a lock *nobody is using*. `INV-LATE-1`'s enforcement quietly stops being
   * enforced, and the only symptom is a teacher's timeline that stops completing itself weeks later.
   *
   * The note this replaces claimed the opposite hazard -- that a lock taken inside a transaction "is released by
   * that transaction's rollback". **That is wrong, and it is wrong in the reassuring direction.** It confuses
   * `pg_advisory_lock` (session-scoped, survives rollback) with `pg_advisory_xact_lock` (transaction-scoped, released
   * by rollback). So there was never a reason to keep the two statements apart, and a comment that named a false
   * hazard is worse than none: it reads as a decision and stops anyone re-examining the code beneath it.
   *
   * `$transaction` is what pins the connection. It is not being used to make the work atomic -- `fn` opens its own
   * transactions and those are unchanged -- only to hold ONE session for the length of the critical section, which is
   * what an exclusive lock means anyway. A nested `$transaction` inside `fn` becomes a savepoint, so the sweep's own
   * transaction still works.
   *
   * AND THE LEAK IS NOW SELF-HEALING, which is the second half of the fix: if a worker is SIGKILLed mid-sweep, the
   * connection dies with it and Postgres drops the session lock with the session. The lock's lifetime is the
   * connection's lifetime, so "a crashed pod holds the lock for ever" cannot happen -- while a leaked *statement* on
   * a pooled connection could, which is the bug that was there.
   */
  return db.$transaction(async (tx) => {
    const locked = await tx.$queryRawUnsafe<{ locked: boolean }[]>(
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
       * THE `FINALLY` IS STILL LOAD-BEARING, and it now runs on the SAME session that took the lock.
       *
       * A throw between the two is the ordinary way a lock leaks, and "a missed sweep is an alert" would be false
       * because nothing would ever report a miss. `pg_advisory_unlock` is idempotent, so this is also safe after the
       * implicit release of a failed transaction.
       */
      await tx.$queryRawUnsafe('SELECT pg_advisory_unlock(hashtext($1))', key);
    }
  });
}

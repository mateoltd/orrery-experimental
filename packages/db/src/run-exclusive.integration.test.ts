/**
 * `runExclusive`, against real Postgres.  (P8-T9)
 *
 * The advisory lock is the only thing standing between one sweep and two, so the property worth testing is not "the lock
 * is acquired" -- it is "a second caller is excluded while the first is inside", which is a claim about concurrency and
 * therefore only observable against a real lock manager.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { PrismaClient } from './prisma.js';
import { runExclusive as runExclusiveReal } from './run-exclusive.js';

/** The REAL implementation, with the client's lifetime under the test's control. */
const runExclusiveWith = (db: PrismaClient, key: string, fn: () => Promise<unknown>) =>
  runExclusiveReal(db, key, fn);

/** No module-level client: every test opens its own two, deliberately -- see the first test. */

describe.skipIf(!process.env.DATABASE_URL)('runExclusive', () => {
  it('excludes a SECOND caller while the first is inside, and lets it in afterwards', async () => {
    const key = `orrery-test-sweep-${randomUUID()}`;
    let inside = false;
    let secondRan = false;

    // Two SEPARATE clients, because that is the situation: two worker replicas, two pools, two sessions. A single client
    // would reuse one connection and the exclusion would be an artefact of the test rather than the lock.
    const a = new PrismaClient();
    const b = new PrismaClient();

    try {
      const first = await runExclusiveWith(a, key, async () => {
        inside = true;
        // The other replica ticks while the first is still working.
        secondRan =
          (await runExclusiveWith(b, key, async () => 'SHOULD NOT RUN')) === 'SHOULD NOT RUN';
        return 'FIRST';
      });

      expect(first).toBe('FIRST');
      expect(inside).toBe(true);
      // **The whole point.** `pg_try_advisory_lock` returns false rather than waiting, so a second sweep does not queue
      // behind the first -- it declines, and the next tick picks the work up.
      expect(secondRan).toBe(false);

      // Released in the `finally`, so the key is free for the next tick.
      expect(await runExclusiveWith(b, key, async () => 'SECOND')).toBe('SECOND');
    } finally {
      await a.$disconnect();
      await b.$disconnect();
    }
  });

  it('RELEASES THE LOCK WHEN `fn` THROWS, so a failing sweep cannot wedge the next one shut', async () => {
    /**
     * A lock leaked by a crash is the failure this design exists to prevent: the sweep would stop silently, and "a missed
     * sweep is an alert" would be false because nothing would report a miss.
     */
    const key = `orrery-test-sweep-throw-${randomUUID()}`;
    const a = new PrismaClient();
    const b = new PrismaClient();
    try {
      await expect(
        runExclusiveWith(a, key, async () => {
          throw new Error('injected sweep failure');
        }),
      ).rejects.toThrow(/injected sweep failure/);

      expect(await runExclusiveWith(b, key, async () => 'STILL RUNNING')).toBe('STILL RUNNING');
    } finally {
      await a.$disconnect();
      await b.$disconnect();
    }
  });

  it('scopes the lock by KEY, so an unrelated job is unaffected', async () => {
    const a = new PrismaClient();
    const b = new PrismaClient();
    try {
      const held = await runExclusiveWith(a, 'orrery-test-lock-a', async () => {
        expect(await runExclusiveWith(b, 'orrery-test-lock-b', async () => 'B')).toBe('B');
        return 'A';
      });
      expect(held).toBe('A');
    } finally {
      await a.$disconnect();
      await b.$disconnect();
    }
  });

  it('does not leave a lock behind after a run', async () => {
    const key = `orrery-test-sweep-clean-${randomUUID()}`;
    const a = new PrismaClient();
    try {
      await runExclusiveWith(a, key, async () => 'done');
      // Held by nobody, so the try-lock succeeds again.
      expect(await runExclusiveWith(a, key, async () => 'again')).toBe('again');
    } finally {
      await a.$disconnect();
    }
  });
});

/**
 * THE LOCK MUST NOT LEAK, AND "IT DID NOT LEAK" IS NOT PROVABLE BY CALLING IT TWICE.
 *
 * The pre-existing case ("does not leave a lock behind after a run") takes the lock, releases it, takes it again. On a
 * pooled client that passed most of the time while the implementation was genuinely broken: `pg_try_advisory_lock` and
 * `pg_advisory_unlock` are two independent `$queryRawUnsafe` calls, session-scoped locks belong to the connection that
 * took them, and two round trips on a pool are two connections whenever the pool decides otherwise. It failed roughly
 * one run in three across the full integration suite and never failed in isolation -- which is the worst signature a
 * lock bug can have, because the isolated run is the one people trust.
 *
 * So the guarantee is pinned structurally instead of by repetition.
 */
describe('the lock cannot outlive its connection', () => {
  it('TAKES AND RELEASES ON ONE SESSION -- and this is asserted STRUCTURALLY, because it cannot be asserted any other way', async () => {
    /**
     * I WROTE THIS TEST BEHAVIOURALLY FIRST AND IT PASSED AGAINST THE BROKEN IMPLEMENTATION.
     *
     * The version that held the lock on one client and checked from a second went green with the lock and the unlock
     * on separate pooled connections, because under low concurrency the pool hands the same connection back both
     * times. That is the whole difficulty: **the defect is a race between the pool and the test, so a test that does
     * not control the pool cannot see it.** Saturating the pool would work and would be a fragile, machine-dependent
     * contraption whose failure would be indistinguishable from a real one.
     *
     * So the guarantee is pinned as the SHAPE it requires: both statements must execute inside one `$transaction`,
     * which is what pins a session in Prisma. The recorder below answers "were both statements issued on the same
     * pinned session?" -- a question with one answer rather than a probability.
     *
     * This is a source-level guarantee wearing a behavioural test's clothes, and it is the honest form available:
     * the property is "these two calls share a session", and a session is not something a unit test can observe from
     * the outside.
     */
    const statements: string[] = [];
    let sessions = 0;
    const recorder = {
      $queryRawUnsafe: async (query: string) => {
        statements.push(query);
        return [{ locked: true }];
      },
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        sessions += 1;
        return fn(recorder);
      },
    } as unknown as Parameters<typeof runExclusiveReal>[0];

    await runExclusiveReal(recorder, 'orrery-structural-key', async () => 'ran');

    expect(sessions, 'the lock must be taken inside a pinned session').toBe(1);
    expect(statements[0]).toContain('pg_try_advisory_lock');
    expect(statements.at(-1)).toContain('pg_advisory_unlock');
    expect(statements).toHaveLength(2);
  });

  it('and it really is exclusive across two CLIENTS against real Postgres', async () => {
    // The behavioural half, kept because it is worth having even though it cannot catch the pool case: while one
    // client holds the key, a second client is declined. On a session-scoped lock that is what `declined` means, and
    // it is the property the sweep actually depends on.
    const key = `orrery-test-one-session-${randomUUID()}`;
    const a = new PrismaClient();
    try {
      const held = await runExclusiveWith(a, key, async () => {
        const b = new PrismaClient();
        try {
          return await runExclusiveWith(b, key, async () => 'SHOULD NOT RUN');
        } finally {
          await b.$disconnect();
        }
      });
      expect(held).toBeNull();
      expect(await runExclusiveWith(a, key, async () => 'free')).toBe('free');
    } finally {
      await a.$disconnect();
    }
  });

  it('and a THROW inside the critical section still releases it', async () => {
    // The `finally` is the other half. A lock leaked by a throw stops the sweep for ever, and `onDeclined` would then
    // report a correct decline of a lock nobody is using -- which is indistinguishable from healthy contention.
    const key = `orrery-test-throw-release-${randomUUID()}`;
    const a = new PrismaClient();
    try {
      await expect(
        runExclusiveWith(a, key, async () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      expect(await runExclusiveWith(a, key, async () => 'free')).toBe('free');
    } finally {
      await a.$disconnect();
    }
  });
});

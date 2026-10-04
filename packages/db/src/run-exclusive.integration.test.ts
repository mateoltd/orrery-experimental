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

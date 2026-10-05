/**
 * THE ROLLUP STORE, AND ESPECIALLY THE THINGS THE PURE LAYER CANNOT SEE.  (P11-T6, `P11-T10`, `P11-T11`)
 *
 * `packages/analytics/src/rollups.test.ts` covers the freshness and invalidation *rules*. This covers the three properties
 * that only exist because there is a table: that a miss is an empty rollup rather than an error, that a malformed `JSONB`
 * row cannot make a stale figure look current, and that a concurrent writer is refused rather than overwriting.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { invalidateRollup, ROLLUP_KINDS, readRollup, writeRollup } from './analytics-rollup.js';
import { type PrismaClient as GeneratedClient, PrismaClient } from './prisma.js';

let client: PrismaClient | null = null;
const prisma = (): PrismaClient => {
  client ??= new PrismaClient();
  return client;
};

afterAll(async () => {
  await client?.$disconnect();
  client = null;
});

type Db = GeneratedClient;

/** The full graph again — users, classroom, resource, version, assignment. Same shape as every other fixture here. */
const assignment = async (): Promise<string> => {
  const db = prisma();
  const teacherId = randomUUID();
  const classroomId = randomUUID();
  await db.user.create({
    data: {
      id: teacherId,
      email: `${teacherId}@r.example`,
      emailNormalized: `${teacherId}@r.example`,
      name: 'T',
    },
  });
  await db.classroom.create({
    data: { id: classroomId, ownerId: teacherId, name: 'rollup room', slug: randomUUID() },
  });
  const resource = await db.resource.create({
    data: { id: randomUUID(), ownerId: teacherId, title: 'Rollups', slug: randomUUID() },
  });
  const version = await db.resourceVersion.create({
    data: {
      id: randomUUID(),
      resourceId: resource.id,
      version: 1,
      blocks: [],
      blocksChecksum: 'rollup',
      meta: {},
      createdById: teacherId,
    },
  });
  const made = await db.assignment.create({
    data: {
      id: randomUUID(),
      classroomId,
      resourceId: resource.id,
      resourceVersionId: version.id,
      status: 'PUBLISHED',
      createdById: teacherId,
    },
  });
  return made.id;
};

describe('the store reads and writes', () => {
  it('a MISSING ROW IS AN EMPTY ROLLUP, not an error and not a null', async () => {
    const id = await assignment();
    const rollup = await readRollup(prisma() as unknown as Db, id, 'FORM_STATS');
    /** Never computed, not "computed with no value" -- `value: null` would be ambiguous between the two. */
    expect(rollup.computedAt).toBe(0);
    expect(rollup.value).toBeNull();
    expect(rollup.invalidatedBy).toEqual([]);
    expect(rollup.isRecomputing).toBe(false);
  });

  it('round-trips a computed figure with its timestamp', async () => {
    const db = prisma();
    const id = await assignment();
    await db.analyticsRollup.create({
      data: {
        assignmentId: id,
        kind: 'FORM_STATS',
        value: { mean: 0.62, sd: 0.21 } as never,
        computedAt: new Date(1_700_000_000_000),
        revision: 1,
      },
    });
    const rollup = await readRollup<{ mean: number; sd: number }>(
      db as unknown as Db,
      id,
      'FORM_STATS',
    );
    expect(rollup.value).toEqual({ mean: 0.62, sd: 0.21 });
    expect(rollup.computedAt).toBe(1_700_000_000_000);
  });

  it('THE INVALURATION LIST IS THE WHOLE LIST, OLDEST FIRST', async () => {
    /**
     * A rollup invalidated by a regrade and then by new responses is a different situation from one invalidated only by
     * a regrade. **A column holding only the latest reason would make the two identical**, which is what `rollups.ts`
     * appends specifically to prevent -- so the round trip has to prove it.
     */
    const db = prisma();
    const id = await assignment();
    await db.analyticsRollup.create({
      data: {
        assignmentId: id,
        kind: 'FORM_STATS',
        computedAt: new Date(1_700_000_000_000),
        invalidatedBy: [
          { reason: 'REGRADE', at: 1_000, actor: 'teacher-1' },
          { reason: 'NEW_RESPONSES', at: 2_000, actor: null },
        ] as never,
        revision: 2,
      },
    });
    const rollup = await readRollup(db as unknown as Db, id, 'FORM_STATS');
    expect(rollup.invalidatedBy.map((i) => i.reason)).toEqual(['REGRADE', 'NEW_RESPONSES']);
    expect(rollup.invalidatedBy.map((i) => i.at)).toEqual([1_000, 2_000]);
  });
});

describe('A MALFORMED ROW CANNOT MAKE A STALE FIGURE LOOK CURRENT', () => {
  it('DROPS invalidation entries it cannot read, and says so through the other fields', async () => {
    /**
     * `invalidatedBy` is `JSONB`, so a cast would compile against anything the column holds. **A row whose `reason` is a
     * number and whose `at` is a string** would compare `at` against `undefined` in `freshness()` and report itself as
     * current -- the exact wrong state the whole module exists to prevent, arriving through the database rather than
     * through the code.
     */
    const db = prisma();
    const id = await assignment();
    await db.analyticsRollup.create({
      data: {
        assignmentId: id,
        kind: 'FORM_STATS',
        computedAt: new Date(1_700_000_000_000),
        invalidatedBy: [
          { reason: 'REGRADE', at: 1_000, actor: null }, // readable
          { reason: 42, at: 'later', actor: null }, // not
          'nonsense', // not an object
          null, // not an object
        ] as never,
        isRecomputing: true,
        revision: 3,
      },
    });
    const rollup = await readRollup(db as unknown as Db, id, 'FORM_STATS');
    /** One entry survives; the rest are dropped rather than coerced into something that compares wrong. */
    expect(rollup.invalidatedBy).toHaveLength(1);
    expect(rollup.invalidatedBy[0]?.reason).toBe('REGRADE');
    /** AND the surviving `isRecomputing: true` is still there for a caller to reason from. */
    expect(rollup.isRecomputing).toBe(true);
  });

  it('DROPS EVERYTHING when the column is not an array at all', async () => {
    const db = prisma();
    const id = await assignment();
    await db.analyticsRollup.create({
      data: {
        assignmentId: id,
        kind: 'SIMILARITY',
        computedAt: new Date(1_700_000_000_000),
        invalidatedBy: { not: 'an array' } as never,
        revision: 1,
      },
    });
    const rollup = await readRollup(db as unknown as Db, id, 'SIMILARITY');
    expect(rollup.invalidatedBy).toEqual([]);
  });
});

describe('AN INVALIDATION APPENDS, AND A CONCURRENT WRITE IS REFUSED', () => {
  it('appends to the list rather than replacing it', async () => {
    const db = prisma();
    const id = await assignment();
    await db.analyticsRollup.create({
      data: {
        assignmentId: id,
        kind: 'FORM_STATS',
        computedAt: new Date(1_700_000_000_000),
        revision: 0,
      },
    });
    const first = await invalidateRollup(
      db as unknown as Db,
      id,
      'FORM_STATS',
      'REGRADE',
      5_000,
      'teacher-1',
      0,
    );
    expect(first.ok).toBe(true);
    const second = await invalidateRollup(
      db as unknown as Db,
      id,
      'FORM_STATS',
      'NEW_RESPONSES',
      6_000,
      null,
      1,
    );
    expect(second.ok).toBe(true);
    const rollup = await readRollup(db as unknown as Db, id, 'FORM_STATS');
    expect(rollup.invalidatedBy.map((i) => i.reason)).toEqual(['REGRADE', 'NEW_RESPONSES']);
  });

  it('REFUSES when the revision moved, rather than overwriting a newer invalidation', async () => {
    /**
     * **The read-modify-write of the invalidation list is not atomic**, so two simultaneous invalidations could lose one
     * another. The `revision` in the `where` is what settles it, and a count of zero is a REFUSAL rather than a silent
     * success -- the same reasoning as `writeReleasedScores`' row-count check, for the same reason.
     */
    const db = prisma();
    const id = await assignment();
    await db.analyticsRollup.create({
      data: {
        assignmentId: id,
        kind: 'FORM_STATS',
        computedAt: new Date(1_700_000_000_000),
        revision: 0,
      },
    });
    const winner = await invalidateRollup(
      db as unknown as Db,
      id,
      'FORM_STATS',
      'REGRADE',
      5_000,
      'a',
      0,
    );
    expect(winner.ok).toBe(true);
    /** A second writer holding the STALE revision 0 must be told, not obeyed. */
    const loser = await invalidateRollup(
      db as unknown as Db,
      id,
      'FORM_STATS',
      'RELEASE',
      6_000,
      'b',
      0,
    );
    expect(loser.ok).toBe(false);
    expect(loser.ok === false && loser.reason).toBe('MOVED');
    const rollup = await readRollup(db as unknown as Db, id, 'FORM_STATS');
    expect(rollup.invalidatedBy.map((i) => i.reason)).toEqual(['REGRADE']);
  });
});

describe('writeRollup IS A COMPARE-AND-SET, WHICH IT WAS NOT AT FIRST', () => {
  it('a FIRST computation creates the row', async () => {
    const db = prisma();
    const id = await assignment();
    const empty = await readRollup<{ n: number }>(db as unknown as Db, id, 'FORM_STATS');
    const result = await writeRollup(
      db as unknown as Db,
      id,
      'FORM_STATS',
      { ...empty, value: { n: 1 } } as never,
      0,
      1_700_000_000_000,
    );
    expect(result.ok).toBe(true);
    const rollup = await readRollup<{ n: number }>(db as unknown as Db, id, 'FORM_STATS');
    expect(rollup.value).toEqual({ n: 1 });
  });

  it('REFUSES a stale writer rather than overwriting a newer figure', async () => {
    /**
     * **The failure the `revision` column exists to prevent.** A computation that started before an invalidation and
     * finished after it would otherwise overwrite the newer figure with a stale one carrying a FRESH timestamp -- the one
     * wrong state `serve()` cannot detect, because every field it inspects says "current".
     *
     * The first version of `writeRollup` took `expectedRevision` and ignored it, going through `upsert`. Only
     * `pnpm lint` noticed, as an unused-parameter warning in someone else's report.
     */
    const db = prisma();
    const id = await assignment();
    const empty = await readRollup<{ n: number }>(db as unknown as Db, id, 'FORM_STATS');
    await writeRollup(
      db as unknown as Db,
      id,
      'FORM_STATS',
      { ...empty, value: { n: 1 } } as never,
      0,
      1_700_000_000_000,
    );

    /** Somebody else moves first: the row is now at revision 1. */
    const stale = await writeRollup(
      db as unknown as Db,
      id,
      'FORM_STATS',
      { ...empty, value: { n: 99 } } as never,
      0,
      1_700_000_000_000,
    );
    expect(stale.ok).toBe(false);
    expect(stale.ok === false && stale.reason).toBe('MOVED');

    const rollup = await readRollup<{ n: number }>(db as unknown as Db, id, 'FORM_STATS');
    /** The newer figure survives; the stale one is nowhere. */
    expect(rollup.value).toEqual({ n: 1 });
  });

  it('REFUSES the epoch as a computation time, because the epoch means NEVER COMPUTED', async () => {
    /**
     * **A sentinel must never be a value.** The first writer called `recompute(rollup, rollup.value, rollup.computedAt)`,
     * and an empty rollup's `computedAt` is `0` -- so a first computation was stamped with the epoch, which the reader
     * then read as "never computed" and **discarded**. The write reported success and the figure was gone: the worst
     * pair of outcomes available, and nothing failed loudly.
     */
    const db = prisma();
    const id = await assignment();
    const empty = await readRollup<{ n: number }>(db as unknown as Db, id, 'FORM_STATS');
    const result = await writeRollup(
      db as unknown as Db,
      id,
      'FORM_STATS',
      { ...empty, value: { n: 1 } } as never,
      0,
      0,
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('BAD_INSTANT');
    expect(await db.analyticsRollup.count({ where: { assignmentId: id } })).toBe(0);
  });

  it('an UP-TO-DATE writer is accepted', async () => {
    const db = prisma();
    const id = await assignment();
    const empty = await readRollup<{ n: number }>(db as unknown as Db, id, 'FORM_STATS');
    await writeRollup(
      db as unknown as Db,
      id,
      'FORM_STATS',
      { ...empty, value: { n: 1 } } as never,
      0,
      1_700_000_000_000,
    );
    const current = await readRollup<{ n: number }>(db as unknown as Db, id, 'FORM_STATS');
    const next = await writeRollup(
      db as unknown as Db,
      id,
      'FORM_STATS',
      { ...current, value: { n: 2 } } as never,
      1,
      1_700_000_100_000,
    );
    expect(next.ok).toBe(true);
    expect((await readRollup<{ n: number }>(db as unknown as Db, id, 'FORM_STATS')).value).toEqual({
      n: 2,
    });
  });
});

describe('the database, not the code, enforces one row per kind', () => {
  it('a second FORM_STATS row for the same assignment is refused by the UNIQUE constraint', async () => {
    const db = prisma();
    const id = await assignment();
    await db.analyticsRollup.create({
      data: { assignmentId: id, kind: 'FORM_STATS', revision: 1 },
    });
    await expect(
      db.analyticsRollup.create({ data: { assignmentId: id, kind: 'FORM_STATS', revision: 1 } }),
    ).rejects.toThrow();
    /** And a DIFFERENT kind coexists, which is what makes the composite key the right shape. */
    await expect(
      db.analyticsRollup.create({ data: { assignmentId: id, kind: 'SIMILARITY', revision: 1 } }),
    ).resolves.toBeDefined();
  });

  it('every kind the module exports is one the schema knows', () => {
    /** A kind in `ROLLUP_KINDS` but not in the Prisma enum would be a runtime failure at write time. */
    expect([...ROLLUP_KINDS].sort()).toEqual(['FORM_STATS', 'SIMILARITY']);
  });
});

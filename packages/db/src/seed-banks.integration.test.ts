/**
 * The seed banks, installed into real Postgres and put through the real gates.  (P5-T15)
 *
 * ## WHY THE GATES GET THE AUTHORED CONTENT RATHER THAN A SYNTHETIC POOL
 *
 * Every other test in this package builds its pool inline: six items, two drawn, no metadata
 * problems. That proves the gates work. It does not prove the SEED CONTENT works, and the seed
 * content is the part a teacher actually sits. So this file installs the authored banks and runs
 * `validateForPublish` over them — if an item is missing a topic, a pool cannot fill its draw, or a
 * key names an option that does not exist, it fails here.
 *
 * ## `INV-Q-1` IS CHECKED ON A REAL ROW
 *
 * `studentFacingQuestion` is fed an actual `Question` row read from the database, including its
 * `modelAnswer` and `rubric`, and the projection is serialised and asserted clean. A comment
 * promising that the key is not projected is worth nothing; this is worth a test.
 */

import { randomUUID } from 'node:crypto';
import { SEED_BANKS, seedBankReport } from '@orrery/contracts/seed-banks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from './prisma.js';
import { publishable, validateForPublish } from './publish-gates.js';
import { installSeedBanks, studentFacingQuestion } from './seed-banks.js';
import { resolveSlots } from './slots.js';

const DATABASE_URL = process.env.DATABASE_URL;

let client: PrismaClient | null = null;
const prisma = (): PrismaClient => {
  client ??= new PrismaClient();
  return client;
};
afterAll(async () => {
  await client?.$disconnect();
  client = null;
});

/**
 * The seed ids are fixed strings, so two runs share rows. That is the point of the installer and it
 * means a `beforeAll` install can collide with another suite, so the owner differs per RUN and the
 * assertion counts rows by bank rather than expecting a global total.
 */
let runOwner: string;
beforeAll(async () => {
  if (!DATABASE_URL) return;
  runOwner = randomUUID();
  await prisma().user.create({
    data: {
      id: runOwner,
      email: `${runOwner}@seed.example`,
      emailNormalized: `${runOwner}@seed.example`,
      name: 'Seed owner',
    },
  });
});

describe.skipIf(!DATABASE_URL)('P5-T15 the seed banks, in real Postgres', () => {
  it('installs every bank, question, pool and pool item', async () => {
    const result = await installSeedBanks(prisma(), { ownerId: runOwner });
    expect(result.banks).toBe(SEED_BANKS.length);
    expect(result.pools).toBe(SEED_BANKS.reduce((n, b) => n + b.pools.length, 0));
    // One row per authored item, not a hand-written total, so the assertion fails when an item is
    // dropped from the content and the count silently follows it down.
    expect(result.questions).toBe(SEED_BANKS.reduce((n, b) => n + b.questions.length, 0));

    for (const bank of SEED_BANKS) {
      const stored = await prisma().question.count({ where: { bankId: bank.id } });
      expect(
        stored,
        `${bank.id} has ${String(stored)} rows for ${String(bank.questions.length)} items`,
      ).toBe(bank.questions.length);
      for (const pool of bank.pools) {
        const items = await prisma().questionPoolItem.count({ where: { poolId: pool.id } });
        expect(
          items,
          `${pool.id} holds ${String(items)} of ${String(pool.questionIds.length)}`,
        ).toBe(pool.questionIds.length);
      }
    }
  });

  it('is IDEMPOTENT: a second install duplicates nothing and bumps no revision', async () => {
    const before = await prisma().question.findMany({
      where: { bankId: { in: SEED_BANKS.map((b) => b.id) } },
      select: { id: true, revision: true },
    });
    const second = await installSeedBanks(prisma(), { ownerId: runOwner });
    // `createMany` with `skipDuplicates` returns 0 new rows the second time.
    expect(second.poolItems).toBe(0);

    const after = await prisma().question.findMany({
      where: { bankId: { in: SEED_BANKS.map((b) => b.id) } },
      select: { id: true, revision: true },
    });
    expect(after.length).toBe(before.length);
    // `revision` is what an already-sitted attempt is pinned to. A no-op installer that increments
    // it invalidates thirty students' papers, which is the failure this assertion exists for.
    for (const row of after) {
      expect(row.revision, `${row.id} was marked revised by a no-op install`).toBe(
        before.find((b) => b.id === row.id)?.revision ?? 0,
      );
    }
  });

  it('the AUTHORED content passes the REAL publish gates, pool by pool', async () => {
    for (const bank of SEED_BANKS) {
      for (const pool of bank.pools) {
        const rows = await prisma().questionPool.findUnique({
          where: { id: pool.id },
          include: {
            items: {
              select: {
                weight: true,
                question: { select: { id: true, topic: true, responseProcess: true } },
              },
            },
          },
        });
        expect(rows, `${pool.id} is not in the database`).not.toBeNull();

        const items = (rows?.items ?? []).map((i) => ({
          questionId: i.question.id,
          topic: i.question.topic,
          responseProcess: i.question.responseProcess as string | null,
          weight: i.weight,
        }));
        const problems = validateForPublish({
          versionId: randomUUID(),
          slots: [
            {
              id: `slot-${pool.id}`,
              position: 0,
              kind: 'POOLED',
              poolId: pool.id,
              drawCount: pool.drawCount,
            },
          ],
          pools: [
            {
              id: pool.id,
              strategy: pool.strategy as never,
              drawCount: pool.drawCount,
              items,
            },
          ],
          items,
          requireItemMetadata: true,
        });
        expect(
          problems.map((p) => `${p.code}: ${p.detail}`),
          `${pool.id} cannot be published`,
        ).toEqual([]);
        expect(publishable(problems)).toBe(true);
      }
    }
  });

  it('every authored item CARRIES a key, and the key is never projected', async () => {
    const rows = await prisma().question.findMany({
      where: { bankId: { in: SEED_BANKS.map((b) => b.id) } },
      select: {
        id: true,
        type: true,
        spec: true,
        points: true,
        timeLimitSec: true,
        estimatedSeconds: true,
        shuffleOptions: true,
        language: true,
        topic: true,
        modelAnswer: true,
        rubric: true,
      },
    });
    expect(rows.length).toBeGreaterThan(60);

    for (const row of rows) {
      // An auto-graded item with an empty key awards zero to a student who answered correctly.
      expect(row.modelAnswer, `${row.id} has no key`).not.toBeNull();
      expect((row.modelAnswer ?? '').trim(), `${row.id} has a blank key`).not.toBe('');

      const projected = studentFacingQuestion(row);
      // The SUBSTRING check only means something for a key long enough to be distinctive. A
      // single-choice key is an OPTION ID — often one character — and asserting that a 40-field JSON
      // projection does not contain the letter "b" fails on every multiple-choice item in the bank.
      // The first version did exactly that, and it is worth being explicit that the failure was in
      // the test, not in the projection.
      //
      // For a word or numeric key the substring check is a genuine second line of defence. For a
      // choice item the structural assertions are the guarantee.
      // Two conditions, both necessary. The key must be long enough to be distinctive (a choice key
      // is an option id, often one character), AND it must not already appear in the prompt — a NUMERIC
      // key like "12 units" legitimately does, because 12 is data the question supplied.
      const prompt = (row.spec as { prompt?: string } | null)?.prompt ?? '';
      const key = row.modelAnswer ?? '';
      if (key.length >= 4 && !prompt.toLowerCase().includes(key.toLowerCase())) {
        expect(
          JSON.stringify(projected),
          `${row.id} leaked its key into the projection`,
        ).not.toContain(key);
      }
      // The structural guarantee, which holds for every item including the one-letter keys.
      expect(projected, `${row.id} has no field a key could hide in`).not.toHaveProperty(
        'modelAnswer',
      );
      expect(projected).not.toHaveProperty('rubric');
      expect(Object.keys(projected).sort()).toEqual([
        'estimatedSeconds',
        'id',
        'language',
        'points',
        'shuffleOptions',
        'spec',
        'timeLimitSec',
        'topic',
        'type',
      ]);
    }
  });

  it('a REAL draw from a seeded pool returns exactly drawCount distinct items', async () => {
    // The authored pools are the ones a teacher will actually use, so the drawer is exercised on
    // real content rather than on six inline fixtures.
    for (const bank of SEED_BANKS) {
      for (const pool of bank.pools) {
        if (pool.strategy !== 'RANDOM_WITHOUT_REPLACEMENT') continue;
        const rows = await prisma().questionPool.findUnique({
          where: { id: pool.id },
          include: {
            items: {
              select: {
                weight: true,
                question: { select: { id: true, topic: true, responseProcess: true } },
              },
            },
          },
        });
        const items = (rows?.items ?? []).map((i) => ({
          questionId: i.question.id,
          topic: i.question.topic,
          responseProcess: i.question.responseProcess as string | null,
          weight: i.weight,
        }));
        const variantMap = resolveSlots(
          [
            {
              id: `slot-${pool.id}`,
              position: 0,
              kind: 'POOLED' as const,
              poolId: pool.id,
              drawCount: pool.drawCount,
            },
          ],
          [
            {
              id: pool.id,
              strategy: 'RANDOM_WITHOUT_REPLACEMENT',
              drawCount: pool.drawCount,
              items,
            },
          ],
          `seed-${pool.id}`,
        );
        const drawn = variantMap['0'] ?? [];
        expect(drawn.length, `${pool.id} drew ${String(drawn.length)}`).toBe(pool.drawCount);
        expect(new Set(drawn).size, `${pool.id} drew a duplicate item`).toBe(pool.drawCount);
        // And every drawn item is one the bank actually holds.
        for (const id of drawn) expect(items.some((i) => i.questionId === id)).toBe(true);
      }
    }
  });

  it('the shipped content still reports its own shortfall, after installing', async () => {
    // The report is computed from the CONTENT, not from the database, so installing cannot make the
    // warning go away. That is deliberate: a bank that is short is short whether or not a row exists.
    const physics = seedBankReport('seed-physics-core');
    expect(physics.totalItemsShortOfTarget).toBeGreaterThan(0);
    expect(physics.authoringTask).toMatch(/needs \d+ more item/);
  });
});

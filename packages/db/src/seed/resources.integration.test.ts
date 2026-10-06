/**
 * The planter half of P17-T1: 30 resources actually land, each with an embed resolving to a real sim.
 */

import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@orrery/db/prisma';
import { afterAll, describe, expect, it } from 'vitest';
import { readResourceSeed, seedResources } from './resources.js';

let client: PrismaClient | null = null;
const prisma = (): PrismaClient => {
  if (process.env.DATABASE_URL === undefined || process.env.DATABASE_URL.length === 0) {
    throw new Error('DATABASE_URL is required: this test plants rows, not mocks of rows');
  }
  client ??= new PrismaClient();
  return client;
};
afterAll(async () => {
  await client?.$disconnect();
  client = null;
});

describe('seedResources plants', () => {
  it('inserts 30 published resources, each embedding a registry sim at the pinned version', async () => {
    const db = prisma();
    const ownerId = randomUUID();
    await db.user.create({
      data: {
        id: ownerId,
        email: `${ownerId}@seed.example`,
        emailNormalized: `${ownerId}@seed.example`,
        name: 'Seed',
      },
    });
    // Start clean: a previous partial run leaves resources without versions, which would flip this
    // run's counts from inserted to updated. Deleting by slug is safe -- slugs are seed-namespaced.
    const seed = readResourceSeed();
    await db.resource.deleteMany({ where: { slug: { in: seed.resources.map((r) => r.slug) } } });
    const first = await seedResources(db, ownerId, seed);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.inserted).toBe(30);

    const rows = await db.resource.findMany({
      where: { slug: { in: seed.resources.map((r) => r.slug) } },
      select: { slug: true, status: true },
    });
    expect(rows).toHaveLength(30);
    expect(rows.every((row) => row.status === 'PUBLISHED')).toBe(true);

    // Re-running updates rather than duplicating: seed reports are counted before-and-after, never guessed.
    const second = await seedResources(db, ownerId, seed);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(30);
  });
});

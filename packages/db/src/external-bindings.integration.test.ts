/**
 * The `ExternalBinding` table and the interop type must not drift apart.  (P5-T13)
 *
 * ## WHY THIS TEST IS IN `@orrery/db` AND NOT `@orrery/interop`
 *
 * `packages/interop` has no dependencies by design — it is the shared vocabulary, and a package
 * both P10 and P16 depend on cannot be allowed to grow a Prisma client. So the check that the
 * TypeScript type still describes the real table has to happen where the table is, which is here.
 *
 * Without it the skeleton rots in the quietest way available: the model gains a column, nobody
 * updates the interface, and the first QTI export writes a binding whose `lastHash` is always
 * `undefined` because the row never had it.
 *
 * There is no write path here on purpose. An `ExternalBinding` row is written by a codec under a
 * tenant's authority, and which actor may create one is a P16 question with an authz surface of its
 * own. Inventing that answer here to make a test convenient would put an unaudited write path into
 * a table whose comment says every write is an audited event (`B13`).
 */

import { randomUUID } from 'node:crypto';
import type { ExternalBinding } from '@orrery/interop';
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from './prisma.js';

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

describe.skipIf(!DATABASE_URL)('P5-T13 ExternalBinding conforms to the interop type', () => {
  it('the type covers EVERY interop-relevant column, and omits only row bookkeeping', async () => {
    const id = randomUUID();
    const created = await prisma().externalBinding.create({
      data: {
        id,
        kind: 'QTI_ASSESSMENT',
        externalId: `qti-${id.slice(0, 8)}`,
        localType: 'ResourceVersion',
        localId: randomUUID(),
        direction: 'EXPORT',
        lastSyncedAt: new Date('2026-09-28T08:00:00.000Z'),
        lastHash: 'a'.repeat(64),
        meta: { mappingVersion: '1' },
      },
    });

    // Structural assignment: the whole point. If a column the type needs disappears, or changes
    // shape, this stops compiling.
    const binding: ExternalBinding = {
      id: created.id,
      tenantId: created.tenantId,
      kind: 'QTI_ASSESSMENT',
      externalId: created.externalId,
      localType: created.localType,
      localId: created.localId,
      direction: 'EXPORT',
      lastSyncedAt: created.lastSyncedAt?.toISOString() ?? null,
      lastHash: created.lastHash,
      meta: created.meta as Record<string, unknown>,
    };
    expect(binding.lastHash).toHaveLength(64);

    // And the other direction, which a type alone cannot check: the LIVE table's column list,
    // minus the two bookkeeping columns. A drifted or dropped column shows up as a set difference
    // here even though the assignment above would still compile with extra columns present.
    //
    // `information_schema` rather than `Prisma.dmmf`: the generated client no longer ships the
    // DMMF, and a check that has to import an internal package to see its own schema is a check
    // that gets deleted. This asks the database what is actually there, which is the question that
    // matters — a migration that did not apply is exactly the drift worth catching.
    const rows = await prisma().$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'ExternalBinding'
    `;
    const schemaFields = rows.map((r) => r.column_name).sort();
    const typeFields = Object.keys(binding).sort();
    const bookkeeping = ['createdAt', 'updatedAt'];
    expect(schemaFields.filter((f) => !bookkeeping.includes(f))).toEqual(typeFields);
    // `createdAt`/`updatedAt` are deliberately absent from the interop type: they describe the row,
    // not the binding, and a codec must not be able to read them.
    expect(schemaFields).toEqual([...typeFields, ...bookkeeping].sort());
  });

  it('the unique key is (kind, externalId, localType, localId) and the row enforces it', async () => {
    const id = randomUUID();
    const data = {
      kind: 'ONEROSTER_USER' as const,
      externalId: `user-${id.slice(0, 8)}`,
      localType: 'User',
      localId: randomUUID(),
      direction: 'IMPORT' as const,
      meta: {},
    };
    await prisma().externalBinding.create({ data });
    // A second binding for the same external user is an UPDATE, not a duplicate row. Import sync
    // runs repeatedly, so a unique key that rejects the re-run turns a working import into a
    // nightly failure.
    const again = await prisma()
      .externalBinding.create({ data })
      .catch(() => null);
    if (again === null) {
      await prisma().externalBinding.update({
        where: {
          id: (await prisma().externalBinding.findFirst({ where: data, select: { id: true } }))?.id,
        },
        data: { lastSyncedAt: new Date('2026-09-28T09:00:00.000Z') },
      });
    }
    expect(await prisma().externalBinding.count({ where: data })).toBe(1);
  });
});

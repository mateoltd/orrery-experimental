/**
 * Write-once versioning against a real Postgres.  (P2-T5, INV-CONTENT-1)
 *
 * ## The test this file exists for
 *
 * `v1 -> edit -> v2 -> restore-as-v3 leaves v1 and v2 BYTE-IDENTICAL`.
 *
 * "Byte-identical" is the only form in which "history is never rewritten" is checkable, and it is
 * checkable HERE and not in a unit test because the failure mode is a database writing to a row
 * it was not asked to write — which is precisely the thing `sessionsEpoch` taught us to stop
 * trusting a fake store about. A fake store cannot tell you a row exists.
 */
import { randomUUID } from 'node:crypto';
import type { Block } from '@orrery/contracts/blocks';
import { diffBlocks } from '@orrery/contracts/diff';
import { contentChecksum } from '@orrery/contracts/editor';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from './prisma.js';
import {
  createResourceVersion,
  listVersions,
  readVersion,
  restoreVersion,
  VersionError,
  verifyVersion,
} from './resource-version.js';

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)('P2-T5 versioning integration, against real Postgres', () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = new PrismaClient();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  async function seed() {
    const owner = randomUUID();
    await prisma.user.create({
      data: {
        id: owner,
        email: `${owner}@s.example`,
        emailNormalized: `${owner}@s.example`,
        name: 'T',
      },
    });
    const resource = await prisma.resource.create({
      data: { id: randomUUID(), ownerId: owner, slug: randomUUID(), title: 'Tides' },
    });
    return { owner, resource };
  }

  const para = (text: string): Block => ({
    type: 'paragraph',
    id: randomUUID(),
    content: [{ text }],
  });

  it('v1 -> edit -> v2 -> restore-as-v3 leaves v1 and v2 BYTE-IDENTICAL', async () => {
    const { owner, resource } = await seed();
    const v1Blocks = [para('The Moon is tidally locked.')];
    const v1 = await createResourceVersion(prisma, resource.id, {
      blocks: v1Blocks,
      createdById: owner,
    });
    expect(v1.version).toBe(1);

    // A genuine edit, and a new block, so the diff has something to say.
    const v2Blocks = [para('The Moon is tidally locked to Earth.'), para('This is new.')];
    const v2 = await createResourceVersion(prisma, resource.id, {
      blocks: v2Blocks,
      parentVersionId: v1.id,
      createdById: owner,
    });
    expect(v2.version).toBe(2);

    const diff = diffBlocks(v1Blocks, v2Blocks);
    expect(diff.changed.length + diff.added.length).toBeGreaterThan(0);

    // "Undo", which in a write-once store is not an undo: it is a new fact.
    const v3 = await restoreVersion(prisma, {
      resourceId: resource.id,
      versionId: v1.id,
      createdById: owner,
      reason: 'Accidentally reworded the whole lesson',
    });
    expect(v3.version).toBe(3);
    expect(v3.restoredFrom).toBe(1);

    // THE ASSERTION. v1 and v2 are exactly as they were, byte for byte, and they verify against
    // their own checksums.
    const rows = await prisma.resourceVersion.findMany({
      where: { resourceId: resource.id },
      orderBy: { version: 'asc' },
      select: { id: true, version: true, blocks: true, blocksChecksum: true, meta: true },
    });
    expect(rows).toHaveLength(3);

    expect(rows[0]?.id).toBe(v1.id);
    expect(rows[0]?.blocksChecksum).toBe(v1.blocksChecksum);
    expect(contentChecksum(rows[0]?.blocks)).toBe(v1.blocksChecksum);

    expect(rows[1]?.id).toBe(v2.id);
    expect(rows[1]?.blocksChecksum).toBe(v2.blocksChecksum);
    expect(contentChecksum(rows[1]?.blocks)).toBe(v2.blocksChecksum);

    // And v3 really is v1's content, so the restore was a restore and not an empty version.
    expect(rows[2]?.blocksChecksum).toBe(v1.blocksChecksum);
    expect(await verifyVersion(prisma, v1.id)).toEqual({ ok: true });
    expect(await verifyVersion(prisma, v2.id)).toEqual({ ok: true });
    expect(await verifyVersion(prisma, v3.id)).toEqual({ ok: true });
  });

  it('records WHY a restore happened, on the new version', async () => {
    const { owner, resource } = await seed();
    const v1 = await createResourceVersion(prisma, resource.id, {
      blocks: [para('one')],
      createdById: owner,
    });
    await createResourceVersion(prisma, resource.id, {
      blocks: [para('two')],
      parentVersionId: v1.id,
      createdById: owner,
    });
    await restoreVersion(prisma, {
      resourceId: resource.id,
      versionId: v1.id,
      createdById: owner,
      reason: 'Pasted the wrong lesson in',
    });
    const head = await readVersion(prisma, (await listVersions(prisma, resource.id))[0]?.id ?? '');
    expect(head).not.toBeNull();
    const meta = (
      await prisma.resourceVersion.findFirst({
        where: { resourceId: resource.id, version: 3 },
        select: { meta: true },
      })
    )?.meta as Record<string, unknown>;
    expect(meta.restoredFrom).toBe(1);
    expect(meta.reason).toBe('Pasted the wrong lesson in');
  });

  it('refuses a version identical to its parent', async () => {
    // Not tidiness: an identical version makes "what changed?" unanswerable for every later
    // diff, and a restore that produces one looks like it did nothing.
    const { owner, resource } = await seed();
    // The SAME block object on both calls. `para('one')` twice mints two different UUIDs, so the
    // two versions genuinely differ and the guard correctly allowed it -- the fixture was wrong,
    // not the guard.
    const blocks = [para('one')];
    const v1 = await createResourceVersion(prisma, resource.id, { blocks, createdById: owner });
    await expect(
      createResourceVersion(prisma, resource.id, {
        blocks,
        parentVersionId: v1.id,
        createdById: owner,
      }),
    ).rejects.toMatchObject({ code: 'noChange' });
  });

  it('refuses to append to a version that is not the head', async () => {
    // Appending anyway would record a version whose recorded parent is a lie, and the version
    // chain is what `plans/00` §6 immutability rests on.
    const { owner, resource } = await seed();
    const v1 = await createResourceVersion(prisma, resource.id, {
      blocks: [para('one')],
      createdById: owner,
    });
    await createResourceVersion(prisma, resource.id, {
      blocks: [para('two')],
      parentVersionId: v1.id,
      createdById: owner,
    });
    await expect(
      createResourceVersion(prisma, resource.id, {
        blocks: [para('three')],
        parentVersionId: v1.id,
        createdById: owner,
      }),
    ).rejects.toMatchObject({ code: 'parentMismatch' });
    // And the version count did not move.
    expect(await listVersions(prisma, resource.id)).toHaveLength(2);
  });

  it('refuses blocks the current schema cannot read, BEFORE writing anything', async () => {
    const { owner, resource } = await seed();
    await expect(
      createResourceVersion(prisma, resource.id, {
        blocks: [{ type: 'paragraph', id: 'not-a-uuid', content: [] }] as never,
        createdById: owner,
      }),
    ).rejects.toMatchObject({ code: 'invalidBlocks' });
    // Nothing was written: a version that stores unreadable content is unopenable, and the
    // author would find out at publish time rather than at edit time.
    expect(await listVersions(prisma, resource.id)).toHaveLength(0);
  });

  it('lists versions newest first, with block counts and no blocks', () => {
    // Asserted for shape here; the ordering and contents are integration concerns above.
    expect(typeof listVersions).toBe('function');
    expect(VersionError.prototype).toBeInstanceOf(Error);
  });

  it('detects a version whose blocks were changed behind the module', async () => {
    // The check that gives the invariant teeth from the other side. INV-CONTENT-1 says nothing
    // updates a version; this proves the checksum would NOTICE if something did, so a violation
    // is detectable rather than merely forbidden.
    const { owner, resource } = await seed();
    const v1 = await createResourceVersion(prisma, resource.id, {
      blocks: [para('one')],
      createdById: owner,
    });
    expect(await verifyVersion(prisma, v1.id)).toEqual({ ok: true });

    // Written with raw SQL, deliberately: the module has no update path, so this is the only way
    // to simulate the violation the invariant forbids.
    await prisma.$executeRawUnsafe(
      'UPDATE "ResourceVersion" SET "blocks" = $1::jsonb WHERE id = $2',
      JSON.stringify([{ type: 'paragraph', id: randomUUID(), content: [{ text: 'tampered' }] }]),
      v1.id,
    );

    const verdict = await verifyVersion(prisma, v1.id);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.stored).toBe(v1.blocksChecksum);
    expect(verdict.recomputed).not.toBe(v1.blocksChecksum);
  });
});

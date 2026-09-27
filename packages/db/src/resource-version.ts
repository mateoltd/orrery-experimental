/**
 * Write-once `ResourceVersion`.  (P2-T5, INV-CONTENT-1)
 *
 * ## The absence is the feature
 *
 * INV-CONTENT-1: "A `ResourceVersion` is **write-once**. `blocks`, `blocksChecksum`, `meta`,
 * `assessmentPolicy` and the `Question` rows keyed to it are never updated. Corrections are new
 * versions."
 *
 * A module that merely *declines* to update is not write-once; it is write-once by convention,
 * and conventions are what D-31 and D-35 found to be theatre. So this module exposes **no
 * content update function at all** — not a deprecated one, not a private one, not one guarded by
 * a flag. There is nothing to call, and `NO_UPDATE_PATH.test.ts` asserts the ABSENCE by
 * enumerating this module's exports and failing on any name that could mutate stored content.
 *
 * A test asserting an absence is normally weak, because it only checks the names someone thought
 * of. This one checks the whole export list against an allowlist, so a future
 * `updateResourceVersionContent` fails the suite the moment it is written rather than the first
 * time somebody calls it.
 *
 * ## Why the checksum is canonical
 *
 * `contentChecksum` sorts keys recursively. Without that, re-saving a document could reorder an
 * object's keys and produce a different hash for identical content, which would make "did this
 * change?" unanswerable and make a faithful restore look like an edit. That bug existed in this
 * codebase and is the reason `canonical.ts` exists.
 *
 * ## Restore is a NEW version, and the old ones are left alone
 *
 * `restoreVersion` reads the target version's blocks and writes them as a NEW version with the
 * next number. It never touches the row it read. The integration test asserts the earlier
 * versions are byte-identical afterwards, which is the only form in which "history is never
 * rewritten" is checkable.
 */

import type { Block, ContentDocument } from '@orrery/contracts/blocks';
import { blockSchema, documentSchema } from '@orrery/contracts/blocks';
import { contentChecksum } from '@orrery/contracts/editor';
import type { PrismaClient, TxClient } from './index.js';

type Db = PrismaClient | TxClient;

export interface NewVersion {
  readonly blocks: readonly Block[];
  readonly meta?: Record<string, unknown>;
  readonly assessmentPolicy?: unknown;
  /** The version this one continues from. Null only for the first version. */
  readonly parentVersionId?: string | null;
  readonly createdById: string;
}

export class VersionError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'noChange'
      | 'notFound'
      | 'invalidBlocks'
      | 'checksumMismatch'
      | 'parentMismatch',
  ) {
    super(message);
    this.name = 'VersionError';
  }
}

/**
 * Create the next version. Appends, never replaces.
 *
 * The next version number is computed inside the transaction from a `MAX`, so two concurrent
 * saves cannot both claim version 3 — the `@@unique([resourceId, version])` index would reject
 * the second, and a rejected insert is a far better outcome than two rows claiming to be the
 * same version.
 */
export async function createResourceVersion(
  // `PrismaClient`, not `Db`: the next version number is read and the insert written inside one
  // transaction, because two concurrent saves both computing `MAX + 1` is how two rows end up
  // claiming to be the same version.
  db: PrismaClient,
  resourceId: string,
  input: NewVersion,
): Promise<{ id: string; version: number; blocksChecksum: string }> {
  // Validated BEFORE the transaction. A version that stores content the current schema rejects
  // is unopenable, and the author finds out at publish time rather than at edit time.
  const document = documentSchema.safeParse({
    schemaVersion: 1,
    title: 'draft',
    authorId: '00000000-0000-4000-8000-000000000000',
    blocks: input.blocks,
  });
  if (!document.success) {
    throw new VersionError(
      `blocks do not satisfy the current schema: ${document.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ')}`,
      'invalidBlocks',
    );
  }

  const checksum = contentChecksum(input.blocks);

  return db.$transaction(async (tx) => {
    const last = await tx.resourceVersion.findFirst({
      where: { resourceId },
      orderBy: { version: 'desc' },
      select: { version: true, id: true },
    });
    if (input.parentVersionId != null && input.parentVersionId !== last?.id) {
      // The caller believed it was editing a particular version, and it is not the head. That is
      // a 409 condition, not a silent append: appending here would record a version whose parent
      // is a lie, and the version chain is what `plans/00` §6 immutability rests on.
      throw new VersionError(
        'this is not the latest version, so it cannot be appended to',
        'parentMismatch',
      );
    }

    // A version identical to its parent is refused. Not for tidiness: an identical version makes
    // "what changed?" unanswerable for every later diff, and a restore that produces one is a
    // restore that appears to have done nothing.
    if (last !== null) {
      const parent = await tx.resourceVersion.findUnique({
        where: { id: last.id },
        select: { blocks: true },
      });
      if (parent !== null && contentChecksum(parent.blocks) === checksum) {
        throw new VersionError('this version is identical to the one before it', 'noChange');
      }
    }

    const created = await tx.resourceVersion.create({
      data: {
        resourceId,
        version: (last?.version ?? 0) + 1,
        blocks: input.blocks as never,
        blocksChecksum: checksum,
        meta: (input.meta ?? {}) as never,
        ...(input.assessmentPolicy === undefined
          ? {}
          : { assessmentPolicy: input.assessmentPolicy as never }),
        createdById: input.createdById,
      },
      select: { id: true, version: true, blocksChecksum: true },
    });
    return created;
  });
}

/** The version list, newest first. Metadata only — no blocks. */
export async function listVersions(
  db: Db,
  resourceId: string,
): Promise<
  readonly {
    id: string;
    version: number;
    blocksChecksum: string;
    createdAt: Date;
    createdById: string;
    blockCount: number;
  }[]
> {
  const rows = await db.resourceVersion.findMany({
    where: { resourceId },
    orderBy: { version: 'desc' },
    select: {
      id: true,
      version: true,
      blocksChecksum: true,
      createdAt: true,
      createdById: true,
      blocks: true,
    },
  });
  return rows.map((r) => ({
    id: r.id,
    version: r.version,
    blocksChecksum: r.blocksChecksum,
    createdAt: r.createdAt,
    createdById: r.createdById,
    blockCount: Array.isArray(r.blocks) ? r.blocks.length : 0,
  }));
}

export async function readVersion(
  db: Db,
  versionId: string,
): Promise<{ id: string; version: number; blocks: Block[]; blocksChecksum: string } | null> {
  const row = await db.resourceVersion.findUnique({
    where: { id: versionId },
    select: { id: true, version: true, blocks: true, blocksChecksum: true },
  });
  if (row === null) return null;
  const parsed = documentSchema.shape.blocks.safeParse(row.blocks);
  if (!parsed.success) {
    // A stored version the CURRENT schema cannot read. This is not a bug to swallow: it is
    // exactly the state P2-T10's migration gate refuses to publish, and it needs to be loud here
    // rather than returning an empty document and letting an author "fix" content that is fine.
    throw new VersionError(
      `version ${row.version} cannot be read by the current schema; it needs a migration`,
      'invalidBlocks',
    );
  }
  return {
    id: row.id,
    version: row.version,
    blocks: parsed.data,
    blocksChecksum: row.blocksChecksum,
  };
}

/**
 * Restore a version AS A NEW VERSION.
 *
 * There is no other shape. The target row is read and left untouched, and its blocks are written
 * forward as the next version. "Undo" in a write-once store is not an undo — it is a new fact
 * about what the document now says, and the audit trail is the point.
 */
export async function restoreVersion(
  db: PrismaClient,
  input: { resourceId: string; versionId: string; createdById: string; reason: string },
): Promise<{ id: string; version: number; restoredFrom: number }> {
  if (input.reason.trim().length < 5) {
    // A restore with no reason is a silent content change, which is the one thing INV-CONTENT-1
    // exists to prevent.
    throw new VersionError('a restore must say why', 'noChange');
  }
  const target = await readVersion(db, input.versionId);
  if (target === null) throw new VersionError('no such version', 'notFound');

  const head = await db.resourceVersion.findFirst({
    where: { resourceId: input.resourceId },
    orderBy: { version: 'desc' },
    select: { id: true },
  });

  // `reasonRequired` is satisfied here by the caller, and the audit row is written by
  // `withAudit` in the route; this module's job is only to append the version.
  const created = await createResourceVersion(db, input.resourceId, {
    blocks: target.blocks,
    parentVersionId: head?.id ?? null,
    createdById: input.createdById,
    meta: { restoredFrom: target.version, restoredFromId: target.id, reason: input.reason.trim() },
  });
  return { id: created.id, version: created.version, restoredFrom: target.version };
}

/**
 * Verify a stored version against its own checksum.
 *
 * A change detector, not a security primitive — see `contentChecksum`. It answers "has this row
 * been touched since it was written?", which is the question INV-CONTENT-1 is actually about.
 */
export async function verifyVersion(
  db: Db,
  versionId: string,
): Promise<{ ok: true } | { ok: false; stored: string; recomputed: string }> {
  const row = await db.resourceVersion.findUnique({
    where: { id: versionId },
    select: { blocks: true, blocksChecksum: true },
  });
  if (row === null) throw new VersionError('no such version', 'notFound');
  const recomputed = contentChecksum(row.blocks);
  if (recomputed === row.blocksChecksum) return { ok: true };
  return { ok: false, stored: row.blocksChecksum, recomputed };
}

export type { Block, ContentDocument };
export { blockSchema };

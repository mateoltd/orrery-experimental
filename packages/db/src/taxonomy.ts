/**
 * Moving subjects and merging tags.  (P3-T1)
 *
 * ## Cycle safety needs a LOCK, not just a check
 *
 * `wouldCreateCycle` is a correct predicate. It is not sufficient on its own, because two
 * concurrent moves can each pass it and together make a cycle:
 *
 *   · the tree is  A → B → C
 *   · move 1 wants to put A under C
 *   · move 2 wants to put C under A
 *   · each check runs before the other write commits, each sees a legal tree, and both commit
 *
 * The result is a cycle that passed a cycle check, which is worse than no check at all — because
 * the check is now known to be unreliable. So every move takes a **PostgreSQL advisory lock** on
 * the tree first, which serialises moves without blocking reads. Reads are unaffected: a tree walk
 * takes no lock, so browsing a subject is never waiting behind a reorganisation.
 *
 * ## Merging a tag has THREE traps, and the third is the one that bites
 *
 *  1. `@@id([resourceId, tagId])` means a naive insert collides for every resource that already
 *     carries BOTH tags. For a teacher who has been tagging with "tides" and "seas", that is
 *     hundreds of resources — so the duplicate case is the NORMAL case, not an edge case.
 *  2. `QuestionTag` also references tags. A merge that moves only `ResourceTag` leaves every
 *     question tag pointing at a row that is about to be deleted, and the delete fails on a
 *     foreign key with an error nobody can act on.
 *  3. The delete must be in the same transaction, or a failure between the moves and the delete
 *     leaves both tags present and every resource carrying both.
 */

import {
  type CycleVerdict,
  type MergeReport,
  type TreeEdge,
  wouldCreateCycle,
} from '@orrery/contracts/taxonomy';
import type { PrismaClient, TxClient } from './index.js';

/**
 * The advisory lock key for the subject tree.
 *
 * A fixed constant, not a per-subject key: the invariant is about the WHOLE tree (a cycle is a
 * property of the graph, not of a row), so a per-subject lock would not serialise two moves in
 * different subtrees that still interact. One constant, one lock, all moves.
 */
const SUBJECT_TREE_LOCK = 0x5_5f_42; // Arbitrary but fixed. Changing it is a migration.

/**
 * Renumber a parent's children from zero.
 *
 * A gap in `position` after a move is how a subject tree ends up in an order nobody chose and
 * nobody can reproduce. The rows are read position-ordered first so the renumbering is stable, and
 * only the rows that actually differ are written — a move in a big subject should not touch two
 * hundred siblings.
 */
async function renumberSiblings(tx: TxClient, parentId: string | null): Promise<number> {
  const siblings = await tx.subject.findMany({
    where: { parentId },
    select: { id: true, position: true },
    orderBy: [{ position: 'asc' }, { id: 'asc' }],
  });
  let renumbered = 0;
  for (const [index, sibling] of siblings.entries()) {
    if (sibling.position === index) continue;
    await tx.subject.update({ where: { id: sibling.id }, data: { position: index } });
    renumbered += 1;
  }
  return renumbered;
}

async function loadEdges(tx: TxClient): Promise<TreeEdge> {
  const rows = await tx.subject.findMany({ select: { id: true, parentId: true } });
  return Object.fromEntries(rows.map((r) => [r.id, r.parentId]));
}

export type MoveFailure =
  | {
      readonly ok: false;
      readonly code: 'notFound' | 'cycle' | 'depthExceeded';
      readonly message: string;
    }
  | { readonly ok: true; readonly moved: number };

/**
 * Move a subject under a new parent, or to the root with `null`.
 *
 * Returns the number of subjects whose `position` was renumbered — the sibling ordering is
 * rewritten inside the transaction because a gap in `position` after a move is how the subject
 * tree ends up in an order nobody chose.
 */
export async function moveSubject(
  db: PrismaClient,
  input: { subjectId: string; newParentId: string | null; position?: number },
): Promise<MoveFailure> {
  return db.$transaction(async (tx) => {
    // The lock is taken BEFORE the edges are read. Taking it after is the bug: two moves could
    // both read, both judge, and both write.
    // `$executeRaw`, not `$queryRaw`. `pg_advisory_xact_lock` returns `void`, and Prisma cannot
    // deserialise a void column — so the first version failed on every move with a raw-query
    // error rather than doing anything. `$executeRaw` uses the affected-rows protocol, which is
    // the right one for a statement whose only job is to block.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SUBJECT_TREE_LOCK})`;

    const subject = await tx.subject.findUnique({
      where: { id: input.subjectId },
      select: { id: true, parentId: true },
    });
    if (subject === null) {
      return { ok: false, code: 'notFound', message: 'There is no such subject.' };
    }
    if (input.newParentId !== null) {
      const parent = await tx.subject.findUnique({
        where: { id: input.newParentId },
        select: { id: true },
      });
      if (parent === null) {
        return { ok: false, code: 'notFound', message: 'There is no such parent subject.' };
      }
    }

    const edges = await loadEdges(tx);
    const verdict: CycleVerdict = wouldCreateCycle(edges, input.subjectId, input.newParentId);
    if ('cycle' in verdict && verdict.cycle) {
      const chosen = await tx.subject.findUnique({
        where: { id: verdict.via },
        select: { name: true },
      });
      return {
        ok: false,
        code: 'cycle',
        message:
          `"${chosen?.name ?? verdict.via}" is inside this subject's own branch, so putting it ` +
          `above would make the tree loop back on itself. Move it somewhere else, or move the ` +
          `subjects between them first.`,
      };
    }
    if ('depthExceeded' in verdict) {
      return {
        ok: false,
        code: 'depthExceeded',
        message:
          `This branch is more than ${64} subjects deep — far enough that it may already contain a ` +
          `loop. Refusing the move rather than guessing.`,
      };
    }

    await tx.subject.update({
      where: { id: input.subjectId },
      data: {
        parentId: input.newParentId,
        ...(input.position === undefined ? {} : { position: input.position }),
      },
    });

    // Renumber BOTH the old parent and the new one. The first version renumbered only the new
    // parent, so moving a subject out of a branch left a permanent GAP in the old one's
    // ordering — and a gap is how a subject tree ends up in an order nobody chose and nobody can
    // reproduce. The integration test set both branches to position 10 and caught it.
    const parents = new Set<string | null>([input.newParentId]);
    if (subject.parentId !== input.newParentId) parents.add(subject.parentId);
    let renumbered = 0;
    for (const parent of parents) {
      renumbered += await renumberSiblings(tx, parent);
    }
    return { ok: true, moved: renumbered };
  });
}

/**
 * Merge `sourceTagId` into `targetTagId`, and delete the source.
 *
 * The surviving tag KEEPS its id, so every `ResourceTag` and `QuestionTag` that already pointed at
 * the target needs no rewrite — which is what makes the merge cheap as well as safe.
 */
export async function mergeTags(
  db: PrismaClient,
  input: { sourceTagId: string; targetTagId: string },
): Promise<{ ok: false; message: string } | ({ ok: true } & MergeReport)> {
  if (input.sourceTagId === input.targetTagId) {
    return { ok: false, message: 'A tag cannot be merged into itself — that would delete it.' };
  }
  return db.$transaction(async (tx) => {
    const [source, target] = await Promise.all([
      tx.tag.findUnique({ where: { id: input.sourceTagId }, select: { id: true, name: true } }),
      tx.tag.findUnique({ where: { id: input.targetTagId }, select: { id: true, name: true } }),
    ]);
    if (source === null) return { ok: false, message: 'There is no such source tag.' };
    if (target === null) return { ok: false, message: 'There is no such target tag.' };

    // Delete the source's rows FIRST, then insert. The composite primary key means insert-then-
    // delete collides for every resource carrying both tags, and for a teacher who has been
    // tagging with "tides" and "seas" that is most of their library.
    //
    // `deleteMany` then `createMany` with `skipDuplicates` — the second guard, because a
    // concurrent tagger can add a row between the delete and the insert, and the transaction
    // would then fail on a race it did not cause.
    const resourceRows = await tx.resourceTag.findMany({
      where: { tagId: source.id },
      select: { resourceId: true },
    });
    const alreadyTagged = await tx.resourceTag.findMany({
      where: { tagId: target.id, resourceId: { in: resourceRows.map((r) => r.resourceId) } },
      select: { resourceId: true },
    });
    const already = new Set(alreadyTagged.map((r) => r.resourceId));
    const toMove = resourceRows.filter((r) => !already.has(r.resourceId)).map((r) => r.resourceId);

    await tx.resourceTag.deleteMany({ where: { tagId: source.id } });
    if (toMove.length > 0) {
      await tx.resourceTag.createMany({
        data: toMove.map((resourceId) => ({ resourceId, tagId: target.id })),
        skipDuplicates: true,
      });
    }

    // QuestionTag too. A merge that moves only ResourceTag leaves every question tag pointing
    // at a row about to be deleted, and the delete fails on a foreign key with an error nobody
    // can act on.
    const questionRows = await tx.questionTag.findMany({
      where: { tagId: source.id },
      select: { questionId: true },
    });
    const questionAlready = await tx.questionTag.findMany({
      where: { tagId: target.id, questionId: { in: questionRows.map((q) => q.questionId) } },
      select: { questionId: true },
    });
    const questionAlreadySet = new Set(questionAlready.map((q) => q.questionId));
    const questionsToMove = questionRows
      .map((q) => q.questionId)
      .filter((q) => !questionAlreadySet.has(q));

    await tx.questionTag.deleteMany({ where: { tagId: source.id } });
    if (questionsToMove.length > 0) {
      await tx.questionTag.createMany({
        data: questionsToMove.map((questionId) => ({ questionId, tagId: target.id })),
        skipDuplicates: true,
      });
    }

    await tx.tag.delete({ where: { id: source.id } });

    return {
      ok: true,
      movedResources: toMove.length,
      deduplicatedResources: resourceRows.length - toMove.length,
      movedQuestions: questionsToMove.length,
      deduplicatedQuestions: questionRows.length - questionsToMove.length,
      deletedTagId: source.id,
    };
  });
}

/**
 * Rename a tag, keeping its id.
 *
 * The id is kept because every `ResourceTag` and `QuestionTag` points at it, and rewriting those
 * rows to follow a rename is a large transaction for no benefit. The SLUG moves, because the slug
 * is what appears in a URL.
 */
export async function renameTag(
  db: PrismaClient,
  input: { tagId: string; name: string; slug: string },
): Promise<{ ok: false; message: string } | { ok: true; id: string; slug: string }> {
  const clash = await db.tag.findUnique({ where: { slug: input.slug }, select: { id: true } });
  if (clash !== null && clash.id !== input.tagId) {
    // The unique index would catch this, but the message would be a Prisma constraint error and
    // the author would not know which tag already owns the slug.
    return { ok: false, message: `Another tag already uses "${input.slug}".` };
  }
  const updated = await db.tag.update({
    where: { id: input.tagId },
    data: { name: input.name, slug: input.slug },
    select: { id: true, slug: true },
  });
  return { ok: true, ...updated };
}

/**
 * Classify a resource: set its subject and tags in one transaction.
 *
 * The subject must exist and the tags must all exist, and the check happens here rather than
 * being left to two foreign keys, because the error from a partially-applied classification —
 * subject set, one tag rejected — is a resource in a subject with no tags and no way back.
 */
export async function classifyResource(
  db: PrismaClient,
  input: { resourceId: string; subjectId: string | null; tagIds: readonly string[] },
): Promise<{ ok: false; message: string } | { ok: true; tagCount: number }> {
  return db.$transaction(async (tx) => {
    if (input.subjectId !== null) {
      const subject = await tx.subject.findUnique({
        where: { id: input.subjectId },
        select: { id: true },
      });
      if (subject === null) return { ok: false, message: 'There is no such subject.' };
    }
    if (input.tagIds.length > 0) {
      const found = await tx.tag.findMany({
        where: { id: { in: [...input.tagIds] } },
        select: { id: true },
      });
      if (found.length !== input.tagIds.length) {
        const missing = input.tagIds.length - found.length;
        return { ok: false, message: `${missing} of those tags do not exist.` };
      }
    }
    if (input.tagIds.length > 0) {
      await tx.resourceTag.deleteMany({ where: { resourceId: input.resourceId } });
      await tx.resourceTag.createMany({
        data: input.tagIds.map((tagId) => ({ resourceId: input.resourceId, tagId })),
        skipDuplicates: true,
      });
    }
    if (input.subjectId !== null) {
      await tx.resource.update({
        where: { id: input.resourceId },
        data: { subjectId: input.subjectId },
      });
    }
    return { ok: true, tagCount: input.tagIds.length };
  });
}

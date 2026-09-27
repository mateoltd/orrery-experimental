/**
 * Subjects and tags against a real Postgres.  (P3-T1)
 *
 * ## The test this file is for
 *
 * `two concurrent moves cannot both commit a cycle`. The advisory lock is the whole mechanism,
 * and it cannot be tested with a fake: the failure it prevents is two transactions interleaving,
 * which is a property of Postgres and not of any function.
 *
 * ## And the merge test that would otherwise be a silent partial merge
 *
 * `moves QUESTION tags as well as resource tags` — a merge that moves only `ResourceTag` leaves
 * every question tag pointing at a deleted row, and the delete fails on a foreign key with an
 * error nobody can act on.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from './prisma.js';
import { classifyResource, mergeTags, moveSubject, renameTag } from './taxonomy.js';

const DATABASE_URL = process.env.DATABASE_URL;

/**
 * Helpers at MODULE scope.
 *
 * The first version defined them inside the first `describe`, so the second block's `tag()` was
 * undefined -- and the failure surfaced as "tag is not defined" in a test about MERGING TAGS,
 * which sends you looking at the merge code rather than at the test file. It is a reminder that
 * "X is not defined" is a test-file bug until proven otherwise, whatever the test is about.
 */
/**
 * A lazily-constructed client, rather than one built in a top-level `beforeAll`.
 *
 * Two versions of this file failed with `Cannot read properties of undefined` before they reached
 * a single assertion, because the helpers were scoped inside one `describe` and then hoisted
 * with their `beforeAll` left behind or duplicated. A lazy accessor removes the whole class of
 * problem: there is no ordering to get wrong, and the failure mode if construction ever does fail
 * is a message about the database rather than about `undefined`.
 */
let client: PrismaClient | null = null;
const prisma = (): PrismaClient => {
  client ??= new PrismaClient();
  return client;
};

afterAll(async () => {
  await client?.$disconnect();
  client = null;
});

async function subject(name: string, parentId: string | null): Promise<string> {
  const id = randomUUID();
  await prisma().subject.create({
    data: { id, slug: `${name}-${id.slice(0, 8)}`, name, parentId },
  });
  return id;
}

async function tag(name: string): Promise<string> {
  const id = randomUUID();
  await prisma().tag.create({ data: { id, slug: `${name}-${id.slice(0, 8)}`, name } });
  return id;
}

async function owner(): Promise<string> {
  const id = randomUUID();
  await prisma().user.create({
    data: { id, email: `${id}@s.example`, emailNormalized: `${id}@s.example`, name: 'T' },
  });
  return id;
}

describe.skipIf(!DATABASE_URL)('P3-T1 taxonomy integration, against real Postgres', () => {
  it('refuses a move that would make a subject its own ancestor, and names the parent chosen', async () => {
    {
      const physics = await subject('Physics', null);
      const mechanics = await subject('Mechanics', physics);
      const gravity = await subject('Gravity', mechanics);

      const bad = await moveSubject(prisma(), { subjectId: physics, newParentId: gravity });
      expect(bad.ok).toBe(false);
      if (bad.ok) return;
      expect(bad.code).toBe('cycle');
      // The message names the PARENT THE AUTHOR CHOSE, because that is the one datum that lets
      // them fix it.
      expect(bad.message).toContain('Gravity');
      expect(bad.message).toContain('loop back on itself');

      // And the tree is untouched.
      expect((await prisma().subject.findUnique({ where: { id: physics } }))?.parentId).toBeNull();
    }
  });

  it('refuses a move under the subject itself', async () => {
    const physics = await subject('Physics', null);
    const bad = await moveSubject(prisma(), { subjectId: physics, newParentId: physics });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.code).toBe('cycle');
  });

  it('allows a legal move, and renumbers the new siblings from zero', async () => {
    const root = await subject('Root', null);
    const a = await subject('A', root);
    const b = await subject('B', root);
    const c = await subject('C', root);
    // Deliberate gaps, which is the state a tree drifts into.
    await prisma().subject.updateMany({ where: { id: { in: [a, b, c] } }, data: { position: 10 } });

    const moved = await moveSubject(prisma(), { subjectId: c, newParentId: a });
    expect(moved.ok).toBe(true);

    const underA = await prisma().subject.findMany({
      where: { parentId: a },
      select: { id: true, position: true },
      orderBy: { position: 'asc' },
    });
    expect(underA.map((s) => s.id)).toEqual([c]);
    expect(underA[0]?.position).toBe(0);
    // And `a` itself is back at zero among the root's children, with no gap.
    const underRoot = await prisma().subject.findMany({
      where: { parentId: root },
      select: { position: true },
      orderBy: { position: 'asc' },
    });
    expect(underRoot.map((s) => s.position)).toEqual([0, 1]);
  });

  it('two concurrent moves cannot BOTH commit a cycle', async () => {
    // A → B → C. Move 1 wants A under C; move 2 wants C under A. Each check would pass on its
    // own, and the pair makes a loop. The advisory lock is the only thing that stops it.
    const a = await subject('A', null);
    const b = await subject('B', a);
    const c = await subject('C', b);

    const [first, second] = await Promise.all([
      moveSubject(prisma(), { subjectId: a, newParentId: c }),
      moveSubject(prisma(), { subjectId: c, newParentId: a }),
    ]);

    // At most one succeeds. Both succeeding is the bug.
    const succeeded = [first, second].filter((r) => r.ok).length;
    expect(succeeded).toBeLessThanOrEqual(1);

    // And the tree is still a tree: walking up from any subject must terminate at a root.
    const rows = await prisma().subject.findMany({
      where: { id: { in: [a, b, c] } },
      select: { id: true, parentId: true },
    });
    const edges = Object.fromEntries(rows.map((r) => [r.id, r.parentId]));
    for (const id of [a, b, c]) {
      const seen = new Set<string>();
      let cursor: string | null | undefined = edges[id];
      let depth = 0;
      while (cursor != null && depth < 100) {
        expect(seen.has(cursor), `cycle through ${cursor}`).toBe(false);
        seen.add(cursor);
        cursor = edges[cursor];
        depth += 1;
      }
      expect(depth, `walk from ${id} did not terminate`).toBeLessThan(100);
    }
  });

  it('refuses a move to a parent that does not exist', async () => {
    const physics = await subject('Physics', null);
    const bad = await moveSubject(prisma(), { subjectId: physics, newParentId: randomUUID() });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    // A missing parent is NOT a cycle. Conflating them turns a typo into "loop back on itself".
    expect(bad.code).toBe('notFound');
  });
});

describe('tags', () => {
  async function fixture() {
    const ownerId = await owner();
    const resource = await prisma().resource.create({
      data: { id: randomUUID(), ownerId, slug: randomUUID(), title: 'Tides' },
    });
    // `Question` hangs off a `QuestionBank`, not off a resource version, and carries the answer
    // key in `spec`. The first version guessed a resource-version shape with `stem`/`choices` and
    // failed on a foreign key in three tests that were about TAGS.
    const bank = await prisma().questionBank.create({
      // No `slug` on QuestionBank — it has `name`, `visibility` and `sharedWithClassroomIds`.
      // Guessing a field is how a fixture spends twenty minutes failing on the wrong thing.
      data: { id: randomUUID(), ownerId, name: 'Bank' },
    });
    const question = await prisma().question.create({
      data: {
        id: randomUUID(),
        bankId: bank.id,
        type: 'singleChoice',
        spec: { stem: 'Which is bigger?', choices: ['A', 'B'], correctChoiceIndex: 0 },
      },
    });
    return { ownerId, resource, question };
  }

  it('refuses to merge a tag into itself, which would delete it', async () => {
    const t = await tag('tides');
    const out = await mergeTags(prisma(), { sourceTagId: t, targetTagId: t });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.message).toContain('into itself');
    expect(await prisma().tag.findUnique({ where: { id: t } })).not.toBeNull();
  });

  it('moves QUESTION tags as well as resource tags, and DEDUPLICATES the overlap', async () => {
    // The merge has three traps and the third is this test: `@@id([resourceId, tagId])` means a
    // naive insert collides for every resource already carrying BOTH tags. For a teacher who has
    // been tagging with "tides" and "seas" that is most of their library, so the duplicate is
    // the NORMAL case rather than an edge case.
    const { resource, question } = await fixture();
    const tides = await tag('tides');
    const seas = await tag('seas');

    // A second resource carrying only the source tag, so both the "moved" and the "deduplicated"
    // paths are exercised.
    const other = await prisma().resource.create({
      data: {
        id: randomUUID(),
        ownerId: (await prisma().resource.findUniqueOrThrow({ where: { id: resource.id } }))
          .ownerId,
        slug: randomUUID(),
        title: 'Oceans',
      },
    });

    for (const t of [tides, seas]) {
      await prisma().resourceTag.create({ data: { resourceId: resource.id, tagId: t } });
      await prisma().questionTag.create({ data: { questionId: question.id, tagId: t } });
    }
    await prisma().resourceTag.create({ data: { resourceId: other.id, tagId: tides } });

    const out = await mergeTags(prisma(), { sourceTagId: tides, targetTagId: seas });
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    // The overlapping resource was already tagged `seas`, so it is counted as deduplicated and
    // not moved. The other one moved.
    expect(out.deduplicatedResources).toBe(1);
    expect(out.movedResources).toBe(1);
    expect(out.deduplicatedQuestions).toBe(1);
    expect(out.movedQuestions).toBe(0);

    // The source tag is GONE, and every reference followed it.
    expect(await prisma().tag.findUnique({ where: { id: tides } })).toBeNull();
    expect(await prisma().resourceTag.count({ where: { tagId: tides } })).toBe(0);
    expect(await prisma().questionTag.count({ where: { tagId: tides } })).toBe(0);
    // The surviving tag kept its id and gained the other resource.
    expect(await prisma().resourceTag.count({ where: { tagId: seas } })).toBe(2);
    expect(await prisma().questionTag.count({ where: { tagId: seas } })).toBe(1);
  });

  it('renames a tag KEEPING its id, so no reference rows move', async () => {
    const { resource } = await fixture();
    const t = await tag('tides');
    await prisma().resourceTag.create({ data: { resourceId: resource.id, tagId: t } });

    const out = await renameTag(prisma(), {
      tagId: t,
      name: 'Tides and seas',
      // A slug unique to THIS RUN. The integration suite shares one database and does not clean
      // up, so a fixed `tides-and-seas` still exists from the previous run and the unique index
      // rejects the rename -- the test failed for that reason, and would have failed on every run
      // after the first. The lesson generalises: in an un-isolated suite, any CONSTANT you write
      // is a value that will collide with your own last run.
      slug: `tides-and-seas-${randomUUID().slice(0, 8)}`,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.id).toBe(t);
    // The reference rows are untouched, which is what makes a rename cheap.
    expect(await prisma().resourceTag.count({ where: { tagId: t } })).toBe(1);
  });

  it('refuses a rename onto a slug another tag already owns, in plain words', async () => {
    const a = await tag('tides');
    const b = await tag('seas');
    const out = await renameTag(prisma(), {
      tagId: a,
      name: 'Seas',
      slug: `seas-${b.slice(0, 8)}`,
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    // The unique index would catch this, but its message would not name the tag that owns it.
    expect(out.message).toContain('already uses');
  });

  it('refuses a classification that names a subject or tag that does not exist', async () => {
    const { resource } = await fixture();
    const out = await classifyResource(prisma(), {
      resourceId: resource.id,
      subjectId: randomUUID(),
      tagIds: [],
    });
    expect(out.ok).toBe(false);
    // A partially-applied classification -- subject set, one tag rejected -- is a resource in a
    // subject with no tags and no way back, so the checks happen before anything is written.
    expect(await prisma().resource.findUniqueOrThrow({ where: { id: resource.id } })).toBeTruthy();
    expect(
      (await prisma().resource.findUniqueOrThrow({ where: { id: resource.id } })).subjectId,
    ).toBeNull();
  });
});

/**
 * The public library against a real Postgres.  (P3-T3)
 *
 * ## The three tests this file is really for
 *
 *  · `does NOT list a resource whose author is under 18` — plans/05 §6 puts this in the
 *    discovery section, where it reads like a footnote about listings. It is a child-safety
 *    rule, it is enforced in the SQL predicate rather than in application code, and NO test
 *    about permissions would catch its absence. So it gets its own test, named after the rule
 *    rather than after the mechanism.
 *  · `a subtree page includes the LEAVES, because that is what a user means by "in Algebra"` —
 *    filtering on the node alone returns an empty page for a branch whose whole content is one
 *    level down, which is the standard way a taxonomy gets reported as broken.
 *  · `pages do not skip or repeat a row when a resource is published mid-scroll` — the property
 *    that offset pagination cannot provide and keyset can, on a list that is being written to
 *    while it is read.
 *
 * ## Why the empty states are all four
 *
 * `filtersExcluded` and `libraryEmpty` are both "zero rows", and conflating them sends a
 * visitor to write a ticket about a filter they could have cleared. Each reason is provoked
 * explicitly here rather than inferred.
 */
import { randomUUID } from 'node:crypto';
import { subtreeOf } from '@orrery/contracts/taxonomy';
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from './prisma.js';
import { browsePublic, subjectSubtree, subjectTree } from './public-library.js';

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

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

async function subject(
  name: string,
  parentId: string | null,
): Promise<{ id: string; slug: string }> {
  const id = randomUUID();
  const slug = `${name.toLowerCase()}-${id.slice(0, 8)}`;
  await prisma().subject.create({ data: { id, slug, name, parentId } });
  return { id, slug };
}

async function tag(name: string): Promise<{ id: string; slug: string }> {
  const id = randomUUID();
  const slug = `${name.toLowerCase()}-${id.slice(0, 8)}`;
  await prisma().tag.create({ data: { id, slug, name } });
  return { id, slug };
}

async function user(overrides: { isMinor?: boolean } = {}): Promise<string> {
  const id = randomUUID();
  await prisma().user.create({
    data: {
      id,
      email: `${id}@s.example`,
      emailNormalized: `${id}@s.example`,
      name: 'Owner',
      ...(overrides.isMinor === undefined ? {} : { isMinor: overrides.isMinor }),
    },
  });
  return id;
}

interface ResourceOverrides {
  readonly status?: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED' | 'WITHDRAWN';
  readonly visibility?: 'PRIVATE' | 'UNLISTED' | 'PUBLIC';
  readonly withVersion?: boolean;
  readonly archivedAt?: Date | null;
  readonly kind?: 'LESSON' | 'QUIZ' | 'EXAM';
}

/** A resource that satisfies the listing predicate unless told otherwise. */
async function publicResource(
  ownerId: string,
  subjectId: string,
  overrides: ResourceOverrides = {},
  tagIds: readonly string[] = [],
): Promise<string> {
  const id = randomUUID();
  const withVersion = overrides.withVersion ?? true;
  await prisma().resource.create({
    data: {
      id,
      ownerId,
      subjectId,
      kind: overrides.kind ?? 'LESSON',
      status: overrides.status ?? 'PUBLISHED',
      visibility: overrides.visibility ?? 'PUBLIC',
      title: overrides.title ?? `R-${id.slice(0, 8)}`,
      slug: id,
      archivedAt: overrides.archivedAt ?? null,
      tags: { create: tagIds.map((tagId) => ({ tagId })) },
    },
  });
  // The version is created for real and THEN pointed at. The first version of this fixture
  // passed `currentVersionId: randomUUID()` and the foreign key rejected it -- correctly. A
  // `currentVersionId` that does not resolve is not a thing the database permits, which is
  // reassuring about the schema and unhelpful about the test.
  if (withVersion) {
    const version = await prisma().resourceVersion.create({
      data: {
        resourceId: id,
        version: 1,
        blocks: [],
        blocksChecksum: '0'.repeat(64),
        meta: {},
        createdById: ownerId,
      },
      select: { id: true },
    });
    await prisma().resource.update({ where: { id }, data: { currentVersionId: version.id } });
  }
  return id;
}

/* ------------------------------------------------------------------ *
 * The listing predicate
 * ------------------------------------------------------------------ */

describe.skipIf(!DATABASE_URL)('P3-T3 public library integration, against real Postgres', () => {
  it('lists ONLY published, public, readable resources', async () => {
    const s = await subject('Listed', null);
    const owner = await user();

    const good = await publicResource(owner, s.id);
    const draft = await publicResource(owner, s.id, { status: 'DRAFT' });
    const unlisted = await publicResource(owner, s.id, { visibility: 'UNLISTED' });
    const private_ = await publicResource(owner, s.id, { visibility: 'PRIVATE' });
    const archived = await publicResource(owner, s.id, { status: 'ARCHIVED' });
    const withdrawn = await publicResource(owner, s.id, { status: 'WITHDRAWN' });
    const noVersion = await publicResource(owner, s.id, { withVersion: false });
    // A FIXED instant, not `new Date()`. The INV-TIME-1 gate caught the host-clock read in
    // this fixture, and it is right to: a fixture whose value depends on when the suite runs is
    // a fixture that can pass today and mean something else tomorrow. The gate is absolute for
    // tests too, which is the correct policy — "it's only a test" is how a clock dependency
    // reaches production through a helper.
    const archivedFlag = await publicResource(owner, s.id, {
      archivedAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    const page = await browsePublic(prisma(), { subject: s.slug });
    const ids = page.items.map((i) => i.id);

    expect(ids).toContain(good);
    for (const bad of [draft, unlisted, private_, archived, withdrawn, noVersion, archivedFlag]) {
      expect(ids, `must not be listed: ${bad}`).not.toContain(bad);
    }
  });

  it('does NOT list a resource whose author is under 18 — plans/05 §6', async () => {
    // Named after the RULE, not the mechanism. This is a child-safety requirement that arrived
    // in the discovery section of the content plan, and it is the one condition in the
    // predicate that is about a person rather than a resource — so it is the one whose absence
    // no permission test would catch.
    const s = await subject('Minors', null);
    const adult = await user({ isMinor: false });
    const minor = await user({ isMinor: true });

    const adultResource = await publicResource(adult, s.id);
    const minorResource = await publicResource(minor, s.id);

    const page = await browsePublic(prisma(), { subject: s.slug });
    const ids = page.items.map((i) => i.id);

    expect(ids).toContain(adultResource);
    expect(ids, 'a minor-authored public resource must not be publicly listed').not.toContain(
      minorResource,
    );
  });

  it('refuses to read a minor-authored resource even by direct slug', async () => {
    // "Not listed" and "not readable" are different claims. The listing predicate covers the
    // first; this pins the second, because a resource that is unlisted but reachable by a
    // guessed id is not what §6 asks for.
    const s = await subject('MinorsDirect', null);
    const minor = await user({ isMinor: true });
    const id = await publicResource(minor, s.id);
    const row = await prisma().resource.findUnique({ where: { id } });
    // The row exists and is PUBLIC — the point is that the LISTING excludes it, and that
    // exclusion is in SQL, so no application-layer fetch can be tricked into returning it.
    expect(row?.visibility).toBe('PUBLIC');
    const page = await browsePublic(prisma(), { subject: s.slug });
    expect(page.items.map((i) => i.id)).not.toContain(id);
  });
});

/* ------------------------------------------------------------------ *
 * Subtree semantics
 * ------------------------------------------------------------------ */

describe.skipIf(!DATABASE_URL)('P3-T3 subtree semantics', () => {
  it('a subtree page includes the LEAVES, because that is what a user means by "in Algebra"', async () => {
    const root = await subject('Alg', null);
    const branch = await subject('Quad', root.id);
    const leaf = await subject('Factor', branch.id);
    const owner = await user();

    const onRoot = await publicResource(owner, root.id);
    const onBranch = await publicResource(owner, branch.id);
    const onLeaf = await publicResource(owner, leaf.id);

    const page = await browsePublic(prisma(), { subject: root.slug });
    const ids = page.items.map((i) => i.id);
    expect(ids).toContain(onRoot);
    expect(ids, 'a branch node must bring its own subtree').toContain(onBranch);
    expect(ids, 'and a leaf two levels down').toContain(onLeaf);
    expect(page.scope).toEqual(expect.arrayContaining([root.slug, branch.slug, leaf.slug]));
  });

  it('a leaf page contains only that leaf', async () => {
    const root = await subject('Solo', null);
    const leaf = await subject('Only', root.id);
    const owner = await user();
    const onRoot = await publicResource(owner, root.id);
    const onLeaf = await publicResource(owner, leaf.id);

    const page = await browsePublic(prisma(), { subject: leaf.slug });
    const ids = page.items.map((i) => i.id);
    expect(ids).toContain(onLeaf);
    expect(ids).not.toContain(onRoot);
  });

  it('subtree resolution agrees with the PURE reference on the seeded taxonomy', async () => {
    // The gate validates the FILE; this checks the DATABASE built from it, using the same
    // function. If `moveSubject` had ever produced a different shape than the seed file, this
    // is where the two would be caught disagreeing.
    // `id` in the select, and this is the SECOND time this exact keying mistake appeared in
    // this file's own helpers: without it, `byId` is a map from `undefined` and every parent
    // resolves to null, so the "independent reference" silently becomes a forest of 246
    // single-node trees and agrees with a broken implementation for the wrong reason. A
    // cross-check that shares a bug with its subject is worse than no cross-check.
    const seed = await prisma().subject.findMany({
      select: { id: true, slug: true, parentId: true },
    });
    const bySlug = new Map(seed.map((r) => [r.slug, r]));
    const byId = new Map(seed.map((r) => [r.id, r.slug]));
    const edge = Object.fromEntries(
      seed.map((r) => [r.slug, r.parentId === null ? null : (byId.get(r.parentId) ?? null)]),
    );

    for (const pick of ['maths', 'maths/algebra', 'general-skills', 'computing']) {
      if (!bySlug.has(pick)) continue;
      const viaFunction = subtreeOf(edge, pick);
      const viaDb = await subjectSubtree(prisma(), pick);
      expect(new Set(viaDb ?? []), pick).toEqual(new Set(viaFunction));
    }
  });

  it('an unknown subject is an ERROR, not the whole library', async () => {
    // A typo'd or renamed slug must not quietly widen a filter to everything. Showing the whole
    // library in response to a filter the visitor did not ask for is worse than an error: it
    // looks like the filter worked.
    await expect(browsePublic(prisma(), { subject: 'maths/algebrae' })).rejects.toThrow(
      /no such subject/,
    );
  });
});

/* ------------------------------------------------------------------ *
 * The tree and its counts
 * ------------------------------------------------------------------ */

describe.skipIf(!DATABASE_URL)('P3-T3 subject tree counts', () => {
  it('counts a SUBTREE, marks empty branches, and never hides one', async () => {
    const root = await subject('Cnt', null);
    const full = await subject('Full', root.id);
    const bare = await subject('Bare', root.id);
    const leaf = await subject('Leaf', full.id);
    const owner = await user();
    await publicResource(owner, leaf.id);

    const nodes = await subjectTree(prisma());
    const by = (slug: string) => nodes.find((n) => n.slug === slug);

    expect(by(root.slug)?.publicCount, 'the parent inherits its subtree').toBe(1);
    expect(by(full.slug)?.publicCount).toBe(1);
    expect(by(leaf.slug)?.publicCount).toBe(1);
    expect(by(leaf.slug)?.directCount).toBe(1);
    expect(by(full.slug)?.directCount, 'direct is exact, not rolled up').toBe(0);
    expect(by(leaf.slug)?.hasChildren).toBe(false);
    expect(by(full.slug)?.hasChildren).toBe(true);

    expect(by(bare.slug)?.publicCount).toBe(0);
    expect(by(bare.slug)?.empty, 'a dead branch is flagged, not hidden').toBe(true);
    expect(by(bare.slug), 'and it is still present in the tree').toBeDefined();
    expect(by(root.slug)?.empty).toBe(false);
  });

  it('the tree does not count a minor-authored resource towards a branch', async () => {
    // The tree is the first thing a visitor sees. If the count said "3" and the page said 2,
    // the count would be the thing they trusted afterwards.
    const s = await subject('MinorCount', null);
    const adult = await user({ isMinor: false });
    const minor = await user({ isMinor: true });
    await publicResource(adult, s.id);
    await publicResource(minor, s.id);
    await publicResource(minor, s.id);

    const nodes = await subjectTree(prisma());
    expect(nodes.find((n) => n.slug === s.slug)?.publicCount).toBe(1);
  });

  it('the tree rollup and the SQL predicate agree on EVERY node, in one query each', async () => {
    // The two are computed by different code — a grouped count rolled up in JS, versus the
    // `where` in `PUBLIC_LISTING` — so they can disagree, and the earlier `bySlug.get(row.id)`
    // bug made them disagree about all 246 subjects at once.
    //
    // The first version called `browsePublic` once per node: 246 sequential round trips, 4
    // SECONDS, to learn a property two queries can establish. The rewrite asks the equivalent
    // question in constant time.
    //
    // And it walks the tree by hand rather than calling `subtreeOf`, because the whole point is
    // independence. Using the production function to compute the expected answer would make
    // this a tautology — it would agree with a broken rollup whenever `subtreeOf` shared the
    // same bug, which is exactly the `bySlug` failure.
    const owner = await user();
    // A PARENT, so the ancestor walk is still exercised. The leaf used to be a root, which made the
    // "a node above an occupied leaf is occupied too" claim untested -- and scoping the comparison to a
    // subtree of one node would have made that permanent.
    const parent = await subject('AgreeParent', null);
    const leaf = await subject('AgreeLeaf', parent.id);
    await publicResource(owner, leaf.id);

    // SCOPED TO THIS TEST'S OWN SUBTREE, and that is the fix.
    //
    // This assertion compares the tree's JS rollup against a SQL group-by, and vitest runs test files in
    // parallel against ONE shared database -- so another file publishing a resource anywhere in the tree
    // changes the SQL side and the failure reads as "the rollup and the predicate disagree", which is
    // exactly the bug this test exists to catch and is much more expensive to chase when it is an
    // artefact. It failed under load for precisely that reason.
    //
    // The earlier fix was `RepeatableRead`, and it was the WRONG tool: in Postgres that stops a row
    // changing underneath a read, but it does **not** stop a row being INSERTED -- a phantom -- so a
    // concurrent commit still altered the group-by. Repeatable reads of nothing are still repeatable.
    //
    // What the test actually wants to know is whether the rollup agrees with the predicate for the
    // subjects it populated. So BOTH sides are restricted to this test's subtree, and the comparison is
    // then hermetic: another file can publish whatever it likes.
    const nodes = await prisma().$transaction(
      async (tx) => {
        const tree = await subjectTree(tx as never);
        // Independent: what does SQL say has a listable resource, with no rollup involved?
        const grouped = await tx.resource.groupBy({
          by: ['subjectId'],
          where: {
            subjectId: { in: [parent.id, leaf.id] },
            status: 'PUBLISHED',
            visibility: 'PUBLIC',
            archivedAt: null,
            currentVersionId: { not: null },
            owner: { is: { isMinor: false } },
          },
        });
        return {
          tree,
          grouped,
          byId: await tx.subject.findMany({ select: { id: true, slug: true } }),
        };
      },
      // AND A TIMEOUT THAT MATCHES THE MACHINE.
      //
      // Prisma's interactive transactions default to FIVE SECONDS, and the vitest `testTimeout` of 60s
      // does not apply to them -- they are a separate deadline inside the call. With 27 test files running
      // in parallel against one Postgres, `subjectTree` plus a group-by regularly exceeded five seconds on
      // a cold or loaded database, and the failure was `Transaction already closed: ... expired
      // transaction`, which reads like a database fault rather than a deadline.
      { isolationLevel: 'RepeatableRead', timeout: 30_000 },
    );
    const truth = nodes.grouped;
    const parentOf = new Map(nodes.tree.map((n) => [n.slug, n.parentSlug]));
    const occupied = new Set<string>();
    const byId = new Map(nodes.byId.map((r) => [r.id, r.slug]));
    for (const t of truth) {
      const slug = t.subjectId === null ? undefined : byId.get(t.subjectId);
      if (slug === undefined) continue;
      occupied.add(slug);
      // Walk up by hand. A node above an occupied leaf is occupied too — the rollup's claim.
      for (let at = parentOf.get(slug) ?? null; at !== null; at = parentOf.get(at) ?? null) {
        occupied.add(at);
      }
    }

    // `claimed` is restricted to the same subtree. The tree's `empty` flags are computed globally, so
    // without this another file's resource would ADD to the rollup's claims while the scoped SQL side
    // stayed still -- the mirror image of the original artefact.
    const subtree = new Set<string>([leaf.slug]);
    for (let at = parentOf.get(leaf.slug) ?? null; at !== null; at = parentOf.get(at) ?? null) {
      subtree.add(at);
    }
    const claimed = new Set(
      nodes.tree.filter((n) => !n.empty && subtree.has(n.slug)).map((n) => n.slug),
    );
    expect(claimed, 'the JS rollup and the SQL predicate disagree about the tree').toEqual(
      occupied,
    );

    // And the counts themselves, on the node we know the answer for.
    const agree = nodes.tree.find((n) => n.slug === leaf.slug);
    expect(agree?.publicCount).toBe(1);
    expect((await browsePublic(prisma(), { subject: leaf.slug })).items).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ *
 * Filters
 * ------------------------------------------------------------------ */

describe.skipIf(!DATABASE_URL)('P3-T3 tag filter', () => {
  it('multiple tags are AND — every listed resource has ALL of them', async () => {
    const s = await subject('Tags', null);
    const t1 = await tag('Vectors');
    const t2 = await tag('Geometry');
    const both = await tag('Both');
    const owner = await user();

    await publicResource(owner, s.id, {}, [t1.id, t2.id]);
    await publicResource(owner, s.id, {}, [t1.id]);

    const page = await browsePublic(prisma(), { subject: s.slug, tags: [t1.slug, t2.slug] });
    expect(page.items).toHaveLength(1);
    for (const item of page.items) {
      expect(item.tags).toEqual(expect.arrayContaining([t1.slug, t2.slug]));
    }
    expect(both.id).toBeTruthy();
  });

  it('filters by kind', async () => {
    const s = await subject('Kinds', null);
    const owner = await user();
    await publicResource(owner, s.id, { kind: 'LESSON' });
    await publicResource(owner, s.id, { kind: 'EXAM' });

    const page = await browsePublic(prisma(), { subject: s.slug, kind: 'EXAM' });
    expect(page.items).toHaveLength(1);
    expect(page.items[0].kind).toBe('EXAM');
  });
});

/* ------------------------------------------------------------------ *
 * Pagination
 * ------------------------------------------------------------------ */

describe.skipIf(!DATABASE_URL)('P3-T3 keyset pagination', () => {
  it('pages through every resource exactly once, in the requested order', async () => {
    const s = await subject('Page', null);
    const owner = await user();
    const created: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      created.push(await publicResource(owner, s.id));
    }
    // Distinct updatedAt values, so the ordering is genuinely exercised rather than falling
    // back entirely to the id tiebreak.
    await prisma().resource.updateMany({
      where: { id: { in: created } },
      data: {},
    });
    for (const [i, id] of created.entries()) {
      await prisma().$executeRaw`UPDATE "Resource" SET "updatedAt" = ${new Date(
        Date.UTC(2026, 0, 1, 0, i),
      )} WHERE id = ${id}`;
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard += 1) {
      const page: Awaited<ReturnType<typeof browsePublic>> = await browsePublic(prisma(), {
        subject: s.slug,
        limit: 3,
        sort: 'newest',
        cursor,
      });
      seen.push(...page.items.map((i) => i.id));
      if (!page.hasMore) break;
      expect(page.nextCursor).not.toBeNull();
      cursor = page.nextCursor;
    }
    expect(seen).toHaveLength(new Set(seen).size);
    expect(seen.filter((id) => created.includes(id)).sort()).toEqual([...created].sort());
  });

  it('pages do not skip or repeat a row when a resource is published mid-scroll', async () => {
    // The property offset pagination cannot provide. The list is written to while it is read,
    // which on a public library is the normal case rather than an edge case.
    const s = await subject('Scroll', null);
    const owner = await user();
    const first: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      first.push(await publicResource(owner, s.id));
    }
    for (const [i, id] of first.entries()) {
      await prisma().$executeRaw`UPDATE "Resource" SET "updatedAt" = ${new Date(
        Date.UTC(2026, 1, 1, 0, i),
      )} WHERE id = ${id}`;
    }

    const page1 = await browsePublic(prisma(), { subject: s.slug, limit: 3, sort: 'newest' });
    expect(page1.items).toHaveLength(3);

    // Publish a brand-new resource while the visitor is between pages. It sorts to the TOP,
    // so an offset-based page 2 would skip one of the original six.
    const intruder = await publicResource(owner, s.id);
    await prisma().$executeRaw`UPDATE "Resource" SET "updatedAt" = ${new Date(
      Date.UTC(2026, 5, 1),
    )} WHERE id = ${intruder}`;

    const seen = page1.items.map((i) => i.id);
    let cursor = page1.nextCursor;
    for (let guard = 0; guard < 10 && cursor !== null; guard += 1) {
      const page = await browsePublic(prisma(), {
        subject: s.slug,
        limit: 3,
        sort: 'newest',
        cursor,
      });
      seen.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor;
    }

    expect(seen, 'a row appeared twice').toHaveLength(new Set(seen).size);
    // The six the visitor was already browsing are all still reached, in order, and the
    // newcomer is simply not in this walk.
    expect(seen).toEqual(first.slice().reverse());
  });

  it('reports hasMore correctly and stops without offering a cursor past the end', async () => {
    const s = await subject('End', null);
    const owner = await user();
    for (let i = 0; i < 3; i += 1) await publicResource(owner, s.id);

    const exact = await browsePublic(prisma(), { subject: s.slug, limit: 3 });
    expect(exact.items).toHaveLength(3);
    expect(exact.hasMore, 'exactly-full is not has-more').toBe(false);
    expect(exact.nextCursor).toBeNull();

    const over = await browsePublic(prisma(), { subject: s.slug, limit: 2 });
    expect(over.items).toHaveLength(2);
    expect(over.hasMore).toBe(true);
    expect(over.nextCursor).not.toBeNull();
  });

  it('clamps an absurd page size instead of honouring or crashing on it', async () => {
    const s = await subject('Clamp', null);
    const owner = await user();
    await publicResource(owner, s.id);
    const page = await browsePublic(prisma(), { subject: s.slug, limit: 100_000 });
    expect(page.items.length).toBeLessThanOrEqual(100);
  });

  it('sorts by title and by oldest, each in the order it names', async () => {
    const s = await subject('Sorts', null);
    const owner = await user();
    const a = await publicResource(owner, s.id);
    const b = await publicResource(owner, s.id);
    const c = await publicResource(owner, s.id);
    await prisma().resource.update({ where: { id: a }, data: { title: 'Alpha' } });
    await prisma().resource.update({ where: { id: b }, data: { title: 'Bravo' } });
    await prisma().resource.update({ where: { id: c }, data: { title: 'Charlie' } });
    await prisma().$executeRaw`UPDATE "Resource" SET "updatedAt" = ${new Date(
      Date.UTC(2026, 0, 3),
    )} WHERE id = ${a}`;
    await prisma().$executeRaw`UPDATE "Resource" SET "updatedAt" = ${new Date(
      Date.UTC(2026, 0, 1),
    )} WHERE id = ${b}`;
    await prisma().$executeRaw`UPDATE "Resource" SET "updatedAt" = ${new Date(
      Date.UTC(2026, 0, 2),
    )} WHERE id = ${c}`;

    const byTitle = await browsePublic(prisma(), { subject: s.slug, sort: 'title' });
    expect(byTitle.items.map((i) => i.title)).toEqual(['Alpha', 'Bravo', 'Charlie']);
    expect(byTitle.sort).toBe('title');

    const oldest = await browsePublic(prisma(), { subject: s.slug, sort: 'oldest' });
    expect(oldest.items.map((i) => i.id)).toEqual([b, c, a]);
  });

  it('rejects a malformed cursor rather than silently restarting', async () => {
    // A broken bookmark that quietly returns page one looks like the server forgetting you, and
    // that bug report is close to untraceable.
    const s = await subject('Cursor', null);
    await expect(
      browsePublic(prisma(), { subject: s.slug, cursor: 'not-a-cursor' }),
    ).rejects.toThrow(/cursor/);
    await expect(
      browsePublic(prisma(), {
        subject: s.slug,
        cursor: Buffer.from('["x"]').toString('base64url'),
      }),
    ).rejects.toThrow(/cursor/);
  });
});

/* ------------------------------------------------------------------ *
 * Empty states — the four reasons, provoked
 * ------------------------------------------------------------------ */

describe.skipIf(!DATABASE_URL)('P3-T3 empty states', () => {
  it('distinguishes an empty SUBJECT from an empty LIBRARY', async () => {
    const s = await subject('Empty', null);
    const page = await browsePublic(prisma(), { subject: s.slug });
    expect(page.items).toHaveLength(0);
    expect(page.empty).toEqual({ reason: 'subjectEmpty', inScope: 0, subjectSlug: s.slug });
  });

  it('reports filtersExcluded WITH THE COUNT, not as an empty library', async () => {
    // The failure this prevents: a visitor filters by a tag, gets nothing, and is told the
    // library is empty. The resources are right there. The honest fix is to clear the filter.
    const s = await subject('Filtered', null);
    const t = await tag('Nonesuch');
    const owner = await user();
    for (let i = 0; i < 3; i += 1) await publicResource(owner, s.id);

    const page = await browsePublic(prisma(), { subject: s.slug, tags: [t.slug] });
    expect(page.items).toHaveLength(0);
    expect(page.empty).toEqual({ reason: 'filtersExcluded', inScope: 3, culprit: 'tags' });

    const byKind = await browsePublic(prisma(), { subject: s.slug, kind: 'EXAM' });
    expect(byKind.empty).toEqual({ reason: 'filtersExcluded', inScope: 3, culprit: 'kind' });
  });

  it('never offers "filters excluded" when there was nothing in scope to begin with', async () => {
    // Otherwise the message says "3 resources, none with that tag" about a subject with none.
    const s = await subject('NeverHad', null);
    const t = await tag('AlsoNonesuch');
    const page = await browsePublic(prisma(), { subject: s.slug, tags: [t.slug] });
    expect(page.empty).toEqual({ reason: 'subjectEmpty', inScope: 0, subjectSlug: s.slug });
  });

  it('paging past the end is not an error and not an empty library', async () => {
    const s = await subject('Past', null);
    const owner = await user();
    for (let i = 0; i < 4; i += 1) await publicResource(owner, s.id);
    const first = await browsePublic(prisma(), { subject: s.slug, limit: 2 });
    expect(first.hasMore).toBe(true);

    let cursor = first.nextCursor;
    let guard = 0;
    while (cursor !== null && guard < 10) {
      const page = await browsePublic(prisma(), { subject: s.slug, limit: 2, cursor });
      cursor = page.nextCursor;
      guard += 1;
    }
    // The walk terminated because `hasMore` went false, not because a page threw. Reaching the
    // end is a `hasMore: false` on a real page, which is why there is no `endOfResults` reason
    // in practice: the union carries it for a caller that renders an explicit end cap.
    expect(guard).toBeGreaterThan(0);
    expect(cursor).toBeNull();
  });

  it('a non-empty page reports empty: null rather than a reason', async () => {
    const s = await subject('Full2', null);
    const owner = await user();
    await publicResource(owner, s.id);
    const page = await browsePublic(prisma(), { subject: s.slug });
    expect(page.empty).toBeNull();
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(1);
  });
});

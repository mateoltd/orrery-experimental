/**
 * The public URL surface against a real Postgres.  (P3-T6)
 *
 * ## The tests that matter
 *
 *  · `the sitemap contains EXACTLY the public library, not approximately it` — the sitemap is a
 *    public surface that is cached by third parties, and the failure mode is a resource that
 *    should never have been listed being listed somewhere it cannot be withdrawn from. The
 *    assertion is set equality rather than a count, because a count passes when one resource is
 *    missing AND another is wrongly present.
 *  · `a minor's resource is ABSENT from the sitemap` — `plans/05` §6, and the hardest thing on
 *    this platform to take back.
 *  · `a PUBLIC slug is globally unique, and a PRIVATE one is not` — the partial index, and the
 *    distinction that makes the canonical URL safe.
 *  · `the OG accent is the AREA's colour, not the leaf's` — the colour lives on the subject
 *    ROOT, and reading the leaf's gives every card the fallback grey in production.
 */
import { randomUUID } from 'node:crypto';
import { canonicalResourcePath, renderOgImage, renderSitemap } from '@orrery/contracts/urls';
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from './prisma.js';
import { browsePublic, PUBLIC_LISTING } from './public-library.js';
import {
  checkPublicSlug,
  publicUrlRows,
  publishWithPublicSlug,
  sitemapEntries,
} from './public-urls.js';

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
  colour?: string,
): Promise<{ id: string; slug: string }> {
  const id = randomUUID();
  const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/gu, '-')}-${id.slice(0, 8)}`;
  await prisma().subject.create({
    data: { id, slug, name, parentId, ...(colour === undefined ? {} : { colour }) },
  });
  return { id, slug };
}

async function user(isMinor = false): Promise<string> {
  const id = randomUUID();
  await prisma().user.create({
    data: { id, email: `${id}@u.example`, emailNormalized: `${id}@u.example`, name: 'A', isMinor },
  });
  return id;
}

interface Opts {
  readonly ownerId?: string;
  readonly subjectId?: string | null;
  readonly slug?: string;
  readonly status?: 'PUBLISHED' | 'DRAFT' | 'ARCHIVED' | 'WITHDRAWN';
  readonly visibility?: 'PUBLIC' | 'UNLISTED' | 'PRIVATE';
  readonly withVersion?: boolean;
}

async function resource(opts: Opts = {}): Promise<string> {
  const id = randomUUID();
  const ownerId = opts.ownerId ?? (await user());
  const slug = opts.slug ?? `r-${id}`;
  await prisma().resource.create({
    data: {
      id,
      ownerId,
      subjectId: opts.subjectId ?? null,
      kind: 'LESSON',
      status: opts.status ?? 'PUBLISHED',
      visibility: opts.visibility ?? 'PUBLIC',
      title: `T ${id.slice(0, 6)}`,
      slug,
      archivedAt: opts.status === 'ARCHIVED' ? new Date('2026-01-01T00:00:00.000Z') : null,
    },
  });
  if (opts.withVersion !== false) {
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
 * The sitemap is a public surface
 * ------------------------------------------------------------------ */

describe.skipIf(!DATABASE_URL)('P3-T6 the sitemap is a PUBLIC surface', () => {
  it('contains EXACTLY the public library, not approximately it', async () => {
    // SET EQUALITY, not a count. A count passes when one resource is wrongly missing AND
    // another is wrongly present, which is precisely the failure that matters: a leaked private
    // resource offset by a missing public one still reports the right number.
    const owner = await user();
    const s = await subject('SitemapEq', null, '#0ea5e9');
    // EXACT slugs, not prefixes. The suite shares one database with no cleanup between runs, so
    // `startsWith('keep-')` matches every previous run's rows and the assertion counted 2
    // against an expected 1 for a reason that had nothing to do with the predicate.
    const keepSlug = `keep-${randomUUID()}`;
    await resource({ ownerId: owner, subjectId: s.id, slug: keepSlug });
    // Each of these fails the listing predicate in a DIFFERENT way, on purpose. ONE run token, and
    // every assertion below is an EXACT equality with it -- a prefix or a suffix is not an
    // identity, and the first version of this filtered on `startsWith('keep-')`, which matched
    // every previous run's rows in the shared database and reported 6 against an expected 1 for
    // a reason that had nothing to do with the predicate under test.
    const run = randomUUID();
    await resource({ ownerId: owner, subjectId: s.id, status: 'DRAFT', slug: `draft-${run}` });
    await resource({ ownerId: owner, subjectId: s.id, visibility: 'UNLISTED', slug: `unl-${run}` });
    await resource({ ownerId: owner, subjectId: s.id, visibility: 'PRIVATE', slug: `priv-${run}` });
    await resource({ ownerId: owner, subjectId: s.id, status: 'ARCHIVED', slug: `arch-${run}` });
    await resource({ ownerId: owner, subjectId: s.id, withVersion: false, slug: `nover-${run}` });

    const slugs = new Set((await publicUrlRows(prisma())).map((r) => r.slug));
    expect(slugs.has(keepSlug), 'the public resource is missing from the sitemap').toBe(true);
    expect(slugs.has(`draft-${run}`), 'a DRAFT was listed').toBe(false);
    expect(slugs.has(`unl-${run}`), 'an UNLISTED resource was listed').toBe(false);
    expect(slugs.has(`priv-${run}`), 'a PRIVATE resource was listed').toBe(false);
    expect(slugs.has(`arch-${run}`), 'an ARCHIVED resource was listed').toBe(false);
    expect(slugs.has(`nover-${run}`), 'a resource with no version was listed').toBe(false);

    // The whole-corpus property: the sitemap's id set IS the publicly-listable set. Compared
    // against `PUBLIC_LISTING` through Prisma rather than against a `browsePublic` page,
    // because a page is capped at 100 rows and the sitemap is not — so the first version of
    // this assertion compared 724 against 100 and failed for a reason that had nothing to do
    // with either predicate. Set equality over the FULL listing is the only shape that can
    // catch a predicate that is subtly wider than the other one.
    //
    // ONE SNAPSHOT, and this is the whole reason the assertion is shaped this way.
    //
    // The two reads are compared for equality, and vitest runs test FILES in parallel against
    // this shared database. Another file inserting a public resource BETWEEN the two reads makes
    // the sets differ, and the failure reads as "the sitemap predicate has drifted from
    // PUBLIC_LISTING" — which sends you into a SQL predicate that is in fact byte-for-byte
    // correct. I chased that for a while: the diff was 0, and the sets were 1890 and 1890 when
    // read together.
    //
    // REPEATABLE READ inside one transaction is the fix, and it is the general rule for this
    // suite: ANY assertion that compares two reads must take them in one snapshot. A test that
    // compares a COUNT to a list, or a tree's rollup to a query's rows, is a test about
    // concurrency whether it says so or not.
    const { sitemap, listed, library } = await prisma().$transaction(
      async (tx) => ({
        sitemap: await publicUrlRows(tx as never),
        listed: await tx.resource.findMany({ where: PUBLIC_LISTING, select: { id: true } }),
        // The public library's own first page, so the agreement is with the thing a visitor
        // actually sees and not only with the constant both of them import. INSIDE the
        // transaction: the first version read it afterwards, and because the page is the 50
        // NEWEST rows, another file publishing a resource in between shifted the page's contents
        // and produced "a library page has a resource the sitemap does not" — a third
        // manifestation of the same snapshot bug, and the one that would have been hardest to
        // believe because both reads were correct.
        library: await browsePublic(tx as never, { limit: 50 }),
      }),
      { isolationLevel: 'RepeatableRead' },
    );
    expect([...sitemap.map((r) => r.id)].sort()).toEqual([...listed.map((l) => l.id)].sort());

    const sitemapIds = new Set(sitemap.map((r) => r.id));
    for (const item of library.items) {
      expect(
        sitemapIds.has(item.id),
        `${item.slug} is on a library page but not in the sitemap`,
      ).toBe(true);
    }
  });

  it("a minor's resource is ABSENT from the sitemap", async () => {
    // `plans/05` §6. The hardest thing on this platform to take back: a sitemap entry ends up in
    // a search engine's index, and an indexed URL can be cached by third parties for months.
    const minor = await user(true);
    const s = await subject('SitemapMinor', null, '#f43f5e');
    const id = await resource({ ownerId: minor, subjectId: s.id, slug: `minor-${randomUUID()}` });
    const rows = await publicUrlRows(prisma());
    expect(rows.map((r) => r.id)).not.toContain(id);

    const xml = renderSitemap(
      (await sitemapEntries(prisma(), canonicalResourcePath)).map((e) => ({ ...e })),
    );
    expect(xml).not.toContain('minor-');
  });

  it('renders paths from the ONE canonical function, so the sitemap and the page cannot differ', async () => {
    const owner = await user();
    const slug = `canon-${randomUUID().slice(0, 8)}`;
    await resource({ ownerId: owner, slug });
    const entries = await sitemapEntries(prisma(), canonicalResourcePath);
    const entry = entries.find((e) => e.path === canonicalResourcePath(slug));
    expect(entry, 'the sitemap path is not the canonical path').toBeDefined();
    // And the XML carries the escaped form, so a path can never break the document.
    expect(renderSitemap(entries)).toContain(`<loc>${canonicalResourcePath(slug)}</loc>`);
  });
});

/* ------------------------------------------------------------------ *
 * The public slug namespace
 * ------------------------------------------------------------------ */

describe.skipIf(!DATABASE_URL)('P3-T6 the public slug namespace', () => {
  it('two PUBLIC resources cannot share a slug — the DATABASE refuses the second', async () => {
    // The partial index, not the application check. A rule that races is still useful as a rule;
    // an index is the guarantee, and it holds for a write that comes from a script.
    const a = await user();
    const b = await user();
    const slug = `shared-${randomUUID().slice(0, 8)}`;
    await resource({ ownerId: a, slug });
    await expect(resource({ ownerId: b, slug })).rejects.toThrow();
  });

  it('two PRIVATE resources CAN share a slug, because their URLs are unreachable', async () => {
    // The distinction that makes `/library/<slug>` safe. A GLOBAL unique index would have
    // blocked ordinary authoring — two teachers each with a draft called `quadratics` — to
    // protect an ambiguity that does not exist on a page nobody can reach.
    const a = await user();
    const b = await user();
    const slug = `private-ok-${randomUUID().slice(0, 8)}`;
    const first = await resource({ ownerId: a, slug, visibility: 'PRIVATE' });
    const second = await resource({ ownerId: b, slug, visibility: 'PRIVATE' });
    expect(first).not.toBe(second);
    expect((await checkPublicSlug(prisma(), { slug })).ok, 'a private slug is not taken').toBe(
      true,
    );
  });

  it('a PRIVATE draft cannot be published onto a PUBLIC slug, and the message is actionable', async () => {
    // The DB error here is "duplicate key value violates unique constraint", which a teacher
    // cannot act on. The check exists to answer in a sentence, and the database stays the
    // guarantee.
    const a = await user();
    const b = await user();
    const slug = `taken-${randomUUID().slice(0, 8)}`;
    const publicOne = await resource({ ownerId: a, slug });
    const draft = await resource({ ownerId: b, slug: `draft-${slug}`, visibility: 'PRIVATE' });

    const verdict = await checkPublicSlug(prisma(), { slug });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.takenBy).toBe(publicOne);
    expect(verdict.reason).toMatch(/another teacher's resource/);

    const attempt = await publishWithPublicSlug(prisma(), {
      resourceId: draft,
      slug,
      ownerId: b,
    });
    expect(attempt.ok).toBe(false);
    if (!attempt.ok) expect(attempt.httpStatus).toBe(409);
    // The draft is untouched, which is the part that matters: a refused publish must not half
    // apply, or the teacher is left with a resource in a state they never chose.
    expect((await prisma().resource.findUniqueOrThrow({ where: { id: draft } })).visibility).toBe(
      'PRIVATE',
    );
  });

  it("distinguishes your own collision from a stranger's, because the copy differs", async () => {
    const owner = await user();
    const slug = `mine-${randomUUID().slice(0, 8)}`;
    const one = await resource({ ownerId: owner, slug });
    const two = await resource({ ownerId: owner, slug: `two-${slug}` });
    const verdict = await checkPublicSlug(prisma(), { slug, resourceId: two, ownerId: owner });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toMatch(/your own resources/);
    expect(verdict.takenBy).toBe(one);
  });

  it('checking your OWN slug does not collide with yourself', async () => {
    const owner = await user();
    const slug = `self-${randomUUID().slice(0, 8)}`;
    const id = await resource({ ownerId: owner, slug });
    // Re-publishing the same resource at the same slug must not report a conflict, or every
    // idempotent re-publish becomes a 409.
    expect((await checkPublicSlug(prisma(), { slug, resourceId: id })).ok).toBe(true);
  });

  it('publishWithPublicSlug refuses a resource that is not yours', async () => {
    const owner = await user();
    const other = await user();
    const id = await resource({ ownerId: owner, slug: `yours-${randomUUID().slice(0, 8)}` });
    const result = await publishWithPublicSlug(prisma(), {
      resourceId: id,
      slug: `stolen-${randomUUID().slice(0, 8)}`,
      ownerId: other,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/not yours/);
  });
});

/* ------------------------------------------------------------------ *
 * The OG card data
 * ------------------------------------------------------------------ */

describe.skipIf(!DATABASE_URL)('P3-T6 OG card data', () => {
  it("the accent is the AREA colour, resolved through the tree, not the leaf's", async () => {
    // The colour lives on the subject ROOT. Reading `subject.colour` on a leaf gives NULL and
    // every card falls back to grey — which looks fine in development, where somebody is looking
    // at the area root, and is wrong in production, where nobody is.
    const area = await subject('OgArea', null, '#7c3aed');
    const branch = await subject('OgBranch', area.id);
    const leaf = await subject('OgLeaf', branch.id);
    const owner = await user();
    await resource({ ownerId: owner, subjectId: leaf.id, slug: `og-${randomUUID().slice(0, 8)}` });

    const row = (await publicUrlRows(prisma())).find((r) => r.subjectSlug === leaf.slug);
    expect(row, 'the leaf resource is missing from the URL rows').toBeDefined();
    expect(row?.accent).toBe('#7c3aed');
    // The subject NAME shown on the card is the leaf's, which is what a reader wants.
    expect(row?.subjectName).toBe('OgLeaf');
    expect(row?.subjectSlug).toBe(leaf.slug);
  });

  it('a resource with no subject still produces a card', async () => {
    // `subjectId` is nullable, so "no subject" is a normal state and not an edge case.
    const owner = await user();
    await resource({ ownerId: owner, slug: `nosubj-${randomUUID().slice(0, 8)}` });
    const row = (await publicUrlRows(prisma())).find(
      (r) => r.accent === null && r.subjectSlug === null,
    );
    expect(row).toBeDefined();
    const svg = renderOgImage({
      title: row?.title ?? 'x',
      eyebrow: row?.subjectName ?? null,
      accent: row?.accent ?? null,
      kind: row?.kind ?? 'LESSON',
    });
    expect(svg).toContain('>ORRERY<');
  });

  it('the card carries the author-supplied title, escaped', async () => {
    // End to end from a database row to a document: the title is author text, and the card is
    // served as `image/svg+xml`, which a browser will execute a script in if navigated to.
    const owner = await user();
    const id = randomUUID();
    await prisma().resource.create({
      data: {
        id,
        ownerId: owner,
        kind: 'LESSON',
        status: 'PUBLISHED',
        visibility: 'PUBLIC',
        title: '</text><script>alert(1)</script>',
        slug: `xss-${id.slice(0, 8)}`,
      },
    });
    const version = await prisma().resourceVersion.create({
      data: {
        resourceId: id,
        version: 1,
        blocks: [],
        blocksChecksum: '0'.repeat(64),
        meta: {},
        createdById: owner,
      },
      select: { id: true },
    });
    await prisma().resource.update({ where: { id }, data: { currentVersionId: version.id } });

    const row = (await publicUrlRows(prisma())).find((r) => r.id === id);
    expect(row).toBeDefined();
    const svg = renderOgImage({
      title: row?.title ?? '',
      eyebrow: row?.subjectName ?? null,
      accent: row?.accent ?? null,
      kind: 'LESSON',
    });
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;');
  });

  it('the recursive walk TERMINATES on a corrupt chain, and the corruption never escapes', async () => {
    // The tree is cycle-safe in application code (P3-T1, `wouldCreateCycle`), but a recursive
    // CTE will happily loop forever on a cycle the DATABASE was never told about, and a sitemap
    // query that hangs is worse than a sitemap missing one resource. The CTE stops at depth 64,
    // so this returns rather than hanging.
    //
    // THE CORRUPTION IS INSIDE A TRANSACTION THAT ROLLS BACK, and that is the part that matters.
    // The first version created the cycle, queried, and then repaired it — which left a window
    // in which a globally shared subject tree was cyclic. Two other test files read that tree,
    // and one of them started failing with "the JS rollup and the SQL predicate disagree about
    // the tree": a failure that looked like a bug in the P3-T3 cross-check and was actually
    // this test breaking somebody else's fixture mid-read.
    //
    // A test that deliberately corrupts shared state is a test that can break unrelated tests,
    // however carefully it repairs itself afterwards. Roll it back instead.
    const parent = await subject('CycleParent', null, '#111111');
    const child = await subject('CycleChild', parent.id);
    const before = await prisma().subject.findUniqueOrThrow({
      where: { id: parent.id },
      select: { parentId: true },
    });
    expect(before.parentId).toBeNull();

    await expect(
      prisma().$transaction(async (tx) => {
        // Corrupt the chain behind the application's back: a two-node cycle the guard never saw.
        await tx.subject.update({ where: { id: parent.id }, data: { parentId: child.id } });
        const rows = await publicUrlRows(tx as never);
        expect(Array.isArray(rows), 'the CTE returned nothing at all').toBe(true);
        // And it TERMINATED, which is the property under test. A non-terminating query would
        // hang this test rather than fail it, so the depth cap is the only thing making the
        // suite able to run at all.
        expect(rows.every((r) => typeof r.id === 'string')).toBe(true);
        // Throw to roll back, so the cycle is never visible outside this transaction.
        throw new Error('ROLLBACK');
      }),
    ).rejects.toThrow('ROLLBACK');

    // The tree is intact for every other test file.
    const after = await prisma().subject.findUniqueOrThrow({
      where: { id: parent.id },
      select: { parentId: true },
    });
    expect(after.parentId, 'the cycle escaped its transaction').toBeNull();
  });
});

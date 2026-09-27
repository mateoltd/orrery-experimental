/**
 * The subject seed against a real Postgres.  (P3-T2)
 *
 * ## The two tests that matter
 *
 *  · `the seeded tree has NO CYCLES in the database` — the gate checks the FILE, this checks what
 *    the loader actually wrote. A loader that resolves parents wrongly turns a validated file
 *    into a broken tree, and only the second check can see that.
 *  · `running the seed twice inserts nothing the second time` — a seed that only works once is a
 *    script, not a seed, and this is the property that makes it safe in a migration.
 */
import { type TreeEdge, wouldCreateCycle } from '@orrery/contracts/taxonomy';
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../prisma.js';
import { readSubjectSeed, seedIndex, seedSubjects } from './subjects.js';

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

describe.skipIf(!DATABASE_URL)('P3-T2 subject seed integration, against real Postgres', () => {
  it('seeds every subject, with parents resolved', async () => {
    const seed = readSubjectSeed();
    const result = await seedSubjects(prisma(), seed);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const rows = await prisma().subject.findMany({
      where: { slug: { in: seed.subjects.map((s) => s.slug) } },
      select: { slug: true, parent: { select: { slug: true } } },
    });
    expect(rows).toHaveLength(seed.subjects.length);
    // Every non-root subject's parent is the one the FILE said, resolved by slug.
    const byFileSlug = new Map(rows.map((r) => [r.slug, r.parent?.slug ?? null]));
    for (const subject of seed.subjects) {
      expect(byFileSlug.get(subject.slug), subject.slug).toBe(subject.parent);
    }
  });

  it('the seeded tree has NO CYCLES in the database', async () => {
    // The gate checks the FILE. This checks what the loader WROTE, using the same runtime
    // predicate. A loader that resolved parents wrongly would turn a validated file into a
    // broken tree, and only this can see it.
    const rows = await prisma().subject.findMany({
      where: { slug: { in: readSubjectSeed().subjects.map((s) => s.slug) } },
      select: { id: true, slug: true, parentId: true },
    });
    const byId = new Map(rows.map((r) => [r.id, r.slug]));
    const edges: TreeEdge = Object.fromEntries(
      rows.map((r) => [r.slug, r.parentId === null ? null : (byId.get(r.parentId) ?? null)]),
    );
    for (const subject of rows) {
      expect(
        wouldCreateCycle(edges, subject.slug, edges[subject.slug] ?? null),
        subject.slug,
      ).toEqual({
        cycle: false,
      });
    }
  });

  it('running the seed TWICE inserts nothing the second time', async () => {
    // A seed that only works once is a script. Idempotence is what makes a seed safe to run in
    // a migration, in a test, and on a database that already has real data in it.
    const seed = readSubjectSeed();
    await seedSubjects(prisma(), seed);
    const second = await seedSubjects(prisma(), seed);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(seed.subjects.length);

    const count = await prisma().subject.count({
      where: { slug: { in: seed.subjects.map((s) => s.slug) } },
    });
    expect(count).toBe(seed.subjects.length);
  });

  it('REPAIRS a subject whose parent was changed, rather than only inserting', async () => {
    // A seed that only ever inserts cannot fix anything, and a corrected tree file that leaves
    // the database alone is worse than no seed at all.
    // A real slug from the seed. The first version used `maths/probability`, which does not
    // exist -- "Probability" is a leaf under "Statistics" -- and the failure was a
    // findUniqueOrThrow in a test about repair, which sends you looking at the repair code.
    const slug = 'maths/statistics/probability';
    const original = await prisma().subject.findUniqueOrThrow({
      where: { slug },
      select: { parentId: true },
    });
    const target = await prisma().subject.findUniqueOrThrow({
      where: { slug: 'maths/algebra' },
      select: { id: true },
    });
    try {
      await prisma().subject.update({ where: { slug }, data: { parentId: target.id } });
      const fixed = await seedSubjects(prisma(), readSubjectSeed());
      expect(fixed.ok).toBe(true);
      const after = await prisma().subject.findUniqueOrThrow({
        where: { slug },
        select: { parent: { select: { slug: true } } },
      });
      expect(after.parent?.slug).not.toBe(original.parentId === null ? null : 'maths/algebra');
    } finally {
      await prisma().subject.update({ where: { slug }, data: { parentId: original.parentId } });
    }
  });

  it('reports slugs it could not place, rather than seeding a partial tree silently', async () => {
    // A child whose parent is absent from the file cannot be inserted, and a seed that reports
    // success while dropping rows is the failure mode this whole file was built to prevent.
    const dangling = {
      subjects: [
        {
          slug: 'test/root',
          name: 'Root',
          area: 'test',
          depth: 0,
          parent: null,
          position: 0,
          colour: '#111111',
        },
        {
          slug: 'test/child',
          name: 'Child',
          area: 'test',
          depth: 1,
          parent: 'test/absent',
          position: 0,
          colour: '#111111',
        },
      ],
      areas: ['test'],
    };
    const result = await seedSubjects(prisma(), dangling);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.unplaceable).toEqual(['test/child']);
    await prisma().subject.deleteMany({ where: { slug: { startsWith: 'test/' } } });
  });

  it('exposes the seed as a slug lookup', () => {
    const index = seedIndex();
    expect(index.size).toBe(readSubjectSeed().subjects.length);
    expect(index.get('maths/algebra/inequalities')?.name).toBe('Inequalities');
  });
});

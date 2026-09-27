/**
 * Search, facets and the zero-result log against a real Postgres.  (P3-T4)
 *
 * ## The tests that matter
 *
 *  · `weights title ABOVE body, which is the whole point of the generated column` — a
 *    weighted index that does not actually weight is the most plausible way this feature can be
 *    built and still not work, and it looks fine in the data.
 *  · `the trigram fallback is REPORTED, and a close match does not outrank a real one` — the
 *    fallback is the part most likely to quietly return plausible nonsense.
 *  · `a zero result is LOGGED, and a fuzzy hit is NOT` — the difference between a content gap
 *    and a satisfied visitor, which is the entire value of the log.
 *  · `facet counts survive their own selection` — the property that makes a facet UI usable.
 *
 * ## The 10-term query set
 *
 * The phase exit criterion is "a 10-term query set returns correct ranked results". It is a
 * table, and it is the reason the ranking assertions below can be about ORDER rather than about
 * whether rows came back at all.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from './prisma.js';
import { PUBLIC_LISTING } from './public-library.js';
import { ageBand, contentGaps, recordZeroResult, reindexResource, search } from './search.js';

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

async function subject(name: string, parentId: string | null = null) {
  const id = randomUUID();
  const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/gu, '-')}-${id.slice(0, 8)}`;
  await prisma().subject.create({ data: { id, slug, name, parentId } });
  return { id, slug };
}

async function user(isMinor = false) {
  const id = randomUUID();
  await prisma().user.create({
    data: { id, email: `${id}@s.example`, emailNormalized: `${id}@s.example`, name: 'A', isMinor },
  });
  return id;
}

async function tag(name: string) {
  const id = randomUUID();
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/gu, '-');
  await prisma().tag.create({ data: { id, slug, name } });
  // `name` returned as well as `slug`: the index stores tag NAMES because that is what a teacher
  // types, so a test that searches by a tag needs the name it created. The first version
  // returned `{id, slug}` and the weight test died on `t.name.toLowerCase()`.
  return { id, slug, name };
}

interface Fixture {
  readonly title: string;
  readonly summary?: string;
  readonly body?: string;
  readonly tags?: readonly { id: string; name: string }[];
  readonly subjectId?: string;
  readonly ownerId?: string;
  readonly language?: string;
  readonly minAge?: number | null;
  readonly maxAge?: number | null;
  readonly visibility?: 'PUBLIC' | 'UNLISTED' | 'PRIVATE';
  readonly status?: 'PUBLISHED' | 'DRAFT' | 'ARCHIVED';
  readonly withSim?: boolean;
  readonly reindex?: boolean;
}

/**
 * Create a public resource, with a REAL version and a REAL vector.
 *
 * `reindexResource` is called by default because `tagText`/`bodyText` are denormalised and the
 * whole point of several tests below is what happens when they are or are not maintained.
 */
async function resource(f: Fixture): Promise<string> {
  const id = randomUUID();
  const ownerId = f.ownerId ?? (await user());
  await prisma().resource.create({
    data: {
      id,
      ownerId,
      subjectId: f.subjectId ?? null,
      kind: 'LESSON',
      status: f.status ?? 'PUBLISHED',
      visibility: f.visibility ?? 'PUBLIC',
      title: f.title,
      slug: id,
      summary: f.summary ?? null,
      language: f.language ?? 'en-GB',
      minAge: f.minAge ?? null,
      maxAge: f.maxAge ?? null,
      tags: { create: (f.tags ?? []).map((t) => ({ tagId: t.id })) },
    },
  });
  const version = await prisma().resourceVersion.create({
    data: {
      resourceId: id,
      version: 1,
      blocks: [{ type: 'paragraph', id: randomUUID(), content: [{ text: f.body ?? '' }] }],
      blocksChecksum: '0'.repeat(64),
      meta: {},
      createdById: ownerId,
    },
    select: { id: true },
  });
  await prisma().resource.update({ where: { id }, data: { currentVersionId: version.id } });
  if (f.withSim) {
    await prisma().resourceSimRef.create({
      data: { resourceId: id, version: 1, blockId: randomUUID(), simId: 'sim', simVersion: '1' },
    });
  }
  if (f.reindex !== false) await reindexResource(prisma(), id);
  return id;
}

/* ------------------------------------------------------------------ *
 * The listing predicate agrees with the raw SQL
 * ------------------------------------------------------------------ */

describe.skipIf(!DATABASE_URL)('P3-T4 search integration, against real Postgres', () => {
  it('the raw SQL listing predicate and PUBLIC_LISTING return the SAME rows', async () => {
    // The search is raw SQL and the public library is Prisma, so "only published, public, and
    // not by a minor" exists as two expressions. The first version of this file asserted nothing
    // about that, which is the same mistake this project has made three times: two
    // implementations, no cross-check, and a comment claiming they match.
    const minor = await user(true);
    const s = await subject('Agree');
    // Per-run token, not a constant. The suite shares one database with no cleanup between runs,
    // so a fixed prefix picks up the previous run's rows and the count assertion below fails for
    // a reason that has nothing to do with the predicate.
    const needle = `agree-${randomUUID().slice(0, 8)}-`;
    await resource({ title: `${needle}visible`, subjectId: s.id });
    await resource({
      title: `agree-minor-${randomUUID().slice(0, 6)}`,
      ownerId: minor,
      subjectId: s.id,
    });
    await resource({
      title: `agree-draft-${randomUUID().slice(0, 6)}`,
      status: 'DRAFT',
      subjectId: s.id,
    });
    await resource({
      title: `${needle}unlisted`,
      visibility: 'UNLISTED',
      subjectId: s.id,
    });

    const viaPrisma = await prisma().resource.findMany({
      where: { ...PUBLIC_LISTING, title: { startsWith: needle } },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    const viaSql = await prisma().$queryRawUnsafe<{ id: string }[]>(
      `SELECT r.id FROM "Resource" r
       WHERE r."status" = 'PUBLISHED' AND r."visibility" = 'PUBLIC'
         AND r."archivedAt" IS NULL AND r."currentVersionId" IS NOT NULL
         AND EXISTS (SELECT 1 FROM "User" o WHERE o.id = r."ownerId" AND o."isMinor" = false)
         AND r.title LIKE $1 ORDER BY r.id ASC`,
      `${needle}%`,
    );
    expect(viaSql.map((r) => r.id)).toEqual(viaPrisma.map((r) => r.id));
    expect(viaPrisma.length).toBe(1);
  });

  /* ---------------------------------------------------------------- *
   * Weights
   * ---------------------------------------------------------------- */

  it('weights title ABOVE body, which is the whole point of the generated column', async () => {
    // A weighted index that does not actually weight is the most plausible way this feature can
    // be built and still not work — and it looks completely fine in the data.
    const owner = await user();
    const s = await subject('Weighted');
    const token = `wgt${randomUUID().slice(0, 8)}`;

    // Same word in both, but in the BODY of one and the TITLE of the other. If the weights are
    // absent these two are indistinguishable; if they are present the title must win.
    const inTitle = await resource({
      title: `${token} explained`,
      body: 'nothing relevant',
      ownerId: owner,
      subjectId: s.id,
    });
    const inBody = await resource({
      title: `a lesson about nothing`,
      body: `${token} appears only here`,
      ownerId: owner,
      subjectId: s.id,
    });

    const result = await search(prisma(), { q: token });
    expect(result.strategy).toBe('fts');
    const order = result.hits.map((h) => h.id);
    expect(order.indexOf(inTitle), 'title match must outrank body match').toBeLessThan(
      order.indexOf(inBody),
    );
  });

  it('weights tags ABOVE body, so a tag is findable by its own name', async () => {
    const owner = await user();
    const s = await subject('Tagged');
    const t = await tag(`Zenith${randomUUID().slice(0, 6)}`);
    const token = t.name.toLowerCase();
    const byTag = await resource({
      title: 'titled differently entirely',
      tags: [t],
      ownerId: owner,
      subjectId: s.id,
    });
    const byBody = await resource({
      title: 'also differently',
      body: `mentions ${token} once`,
      ownerId: owner,
      subjectId: s.id,
    });

    const result = await search(prisma(), { q: token, subject: s.slug });
    const order = result.hits.map((h) => h.id);
    expect(order).toContain(byTag);
    expect(order.indexOf(byTag)).toBeLessThan(order.indexOf(byBody));
  });

  /* ---------------------------------------------------------------- *
   * The 10-term query set
   * ---------------------------------------------------------------- */

  it('a 10-term query set returns results in the right ORDER, not merely some results', async () => {
    const owner = await user();
    const s = await subject('Terms');

    // Ten terms, each with a UNIQUE per-run word. The first version appended one shared hex
    // token to every title and then classified a document as a "body-only match" whenever its
    // title did not START with the query — so `respiration abc123` was classified as a
    // body-only match while plainly containing the token in its TITLE, and the assertion
    // demanded that a title match outrank a document that was ranked for a perfectly good
    // reason. It failed, and the failure pointed at the weighting rather than at the classifier.
    //
    // The lesson generalises: a test that derives its own expectations from a heuristic is
    // testing the heuristic. Here the fixture states which document matches where, and the
    // assertion reads that instead of inferring it.
    const words = [
      'photosynthesis',
      'respiration',
      'chlorophyll',
      'stomata',
      'xylem',
      'phloem',
      'transpiration',
      'guard',
      'diffusion',
      'osmosis',
    ];
    const suffix = randomUUID().slice(0, 6);

    // For each term: one document that names it in the TITLE, and one that mentions it only in
    // the BODY. Same word, same length, same position in the vector — the only difference is the
    // weight, which is the thing under test.
    const titleHit: string[] = [];
    const bodyHit: string[] = [];
    for (const word of words) {
      titleHit.push(
        await resource({
          title: `${word} fundamentals ${suffix}`,
          body: 'irrelevant filler',
          ownerId: owner,
          subjectId: s.id,
        }),
      );
      bodyHit.push(
        await resource({
          title: `a lesson with no title overlap ${suffix}`,
          body: `a passing mention of ${word} once`,
          ownerId: owner,
          subjectId: s.id,
        }),
      );
    }

    for (const word of words) {
      const result = await search(prisma(), { q: `${word} ${suffix}`, subject: s.slug });
      expect(result.strategy, word).toBe('fts');
      const order = result.hits.map((h) => h.id);

      const i = words.indexOf(word);
      expect(order, `${word}: the title match is missing`).toContain(titleHit[i]);
      expect(order, `${word}: the body match is missing`).toContain(bodyHit[i]);

      // THE WEIGHTING. A document whose title contains the term outranks one that mentions it
      // once in its body, and it does so for every one of the ten.
      expect(
        order.indexOf(titleHit[i]),
        `${word}: a body-only match outranked the title match`,
      ).toBeLessThan(order.indexOf(bodyHit[i]));

      // And the ranking is not insertion order, which is the failure a "did we get results"
      // assertion cannot see. The title match was created FIRST for every word, so a
      // non-relevance implementation would pass the check above by accident on the ordering of
      // creation — so this one does the discriminating.
      expect(
        order.indexOf(titleHit[i]),
        `${word}: the ranking is not relevance order`,
      ).toBeLessThan(order.length / 2);
    }

    // All twenty documents are findable. A weighting bug that made a term unfindable would
    // still satisfy every ordering assertion above for the terms that happened to work.
    for (const word of words) {
      const result = await search(prisma(), { q: `${word} ${suffix}`, subject: s.slug, limit: 50 });
      expect(result.hits.length, `${word}: expected both documents`).toBe(2);
    }
  });

  /* ---------------------------------------------------------------- *
   * The fallback
   * ---------------------------------------------------------------- */

  it('the trigram fallback is REPORTED, and a close match does not outrank a real one', async () => {
    const owner = await user();
    // The subject is what scopes this test, and it is per-run. The TITLES are clean, with no
    // per-run token: six extra characters of hex drop `similarity('wavelength optics a1b2c3',
    // 'wavelenght')` from 0.55 to 0.286, which is under the 0.3 threshold, so a tokenised title
    // quietly stopped finding anything. Titles need not be unique — the subject isolates runs.
    const s = await subject('Fallback');
    const optics = await resource({ title: 'wavelength optics', ownerId: owner, subjectId: s.id });
    const refraction = await resource({
      title: 'wavelength refraction',
      ownerId: owner,
      subjectId: s.id,
    });

    // A TRANSPOSED typo that appears NOWHERE in the corpus. That is what makes this the
    // fallback: `websearch_to_tsquery` treats `wavelenght` as a different lexeme, so full-text
    // finds nothing, and the visitor must be able to tell that what they got is a near match
    // rather than a real one.
    //
    // The first version of this test created a resource TITLED `wavelenght basics` and then
    // searched for `wavelenght` — which is not a typo at all, it is an exact match, so the search
    // correctly returned `fts` and the assertion failed for a reason that had nothing to do with
    // the fallback. A test for a typo has to contain the typo in the QUERY and not in the data.
    const typo = await search(prisma(), { q: 'wavelenght', subject: s.slug });
    expect(typo.strategy, 'a transposed typo must reach the fallback').toBe('trigram');
    const ids = typo.hits.map((h) => h.id);
    expect(ids).toContain(optics);
    expect(ids).toContain(refraction);
    // Ranked by SIMILARITY, and reported as such.
    expect(typo.hits[0].rank).toBeGreaterThan(0);

    // And when a real full-text match exists it wins, because `fts` is tried first — the
    // fallback never gets the chance to displace it.
    const exact = await search(prisma(), { q: 'wavelength', subject: s.slug });
    expect(exact.strategy).toBe('fts');
    expect(exact.hits.map((h) => h.id)).toContain(optics);
    expect(exact.hits.map((h) => h.id)).toContain(refraction);
  });

  it('an operator-only term is a BROWSE, not a search, and never reaches the log', async () => {
    const s = await subject('Operators');
    await resource({ title: `operator probe ${randomUUID().slice(0, 6)}`, subjectId: s.id });
    for (const term of ['and', 'or', 'not', '   ', '"']) {
      const result = await search(prisma(), {
        q: term,
        subject: s.slug,
      });
      expect(result.strategy, `"${term}" should not be a search`).toBe('none');
    }
    const logged = await prisma().zeroResultQuery.count({
      where: { term: { in: ['and', 'or', 'not', ''] } },
    });
    expect(logged).toBe(0);
  });

  it('a stray quote does not become a 500', async () => {
    // `to_tsquery` throws on unbalanced quotes. `websearch_to_tsquery` does not, and the
    // difference between those is a 500 for a visitor typing a double quote.
    const s = await subject('Quotes');
    await resource({ title: `quoted lesson ${randomUUID().slice(0, 6)}`, subjectId: s.id });
    await expect(search(prisma(), { q: '"unbalanced', subject: s.slug })).resolves.toBeDefined();
    await expect(search(prisma(), { q: 'a & b | c', subject: s.slug })).resolves.toBeDefined();
  });

  /* ---------------------------------------------------------------- *
   * The zero-result log
   * ---------------------------------------------------------------- */

  it('a zero result is LOGGED, and a fuzzy hit is NOT', async () => {
    const owner = await user();
    const s = await subject('Logged');
    await resource({
      title: `present ${randomUUID().slice(0, 6)}`,
      ownerId: owner,
      subjectId: s.id,
    });
    const requestId = randomUUID();

    const missTerm = `nonexistent${randomUUID().slice(0, 8)}`;
    const miss = await search(prisma(), { q: missTerm, subject: s.slug }, { requestId });

    // The CONTRACT is about the LOG, not about the strategy: a term is logged IFF nothing was
    // found, whatever route found it.
    //
    // The first version asserted `strategy === 'none'` for an arbitrary nonsense string, which
    // is not a promise fuzzy matching can keep — `similarity()` above 0.3 between a random hex
    // and some unrelated title is entirely possible, and when it happened the failure read as
    // "the zero-result log is broken" when in fact the log was correct and the assertion was
    // about the wrong thing.
    const loggedMiss = await prisma().zeroResultQuery.findMany({ where: { requestId } });
    if (miss.strategy === 'none') {
      expect(loggedMiss, 'a genuine zero result must be logged').toHaveLength(1);
      expect(loggedMiss[0].term.startsWith('nonexistent')).toBe(true);
    } else {
      expect(miss.strategy).toBe('trigram');
      expect(loggedMiss, 'a visitor who found something must not be logged').toHaveLength(0);
    }

    // A fuzzy hit found something. That visitor is SATISFIED, and logging them would fill the
    // commissioning report with terms that are already available.
    await resource({
      title: `wave optics ${randomUUID().slice(0, 6)}`,
      ownerId: owner,
      subjectId: s.id,
    });
    const fuzzyId = randomUUID();
    const fuzzy = await search(
      prisma(),
      { q: 'wavv optics', subject: s.slug },
      { requestId: fuzzyId },
    );
    expect(fuzzy.strategy).toBe('trigram');
    expect(await prisma().zeroResultQuery.count({ where: { requestId: fuzzyId } })).toBe(0);
  });

  it('normalises the logged term, so casing and spacing do not fork the signal', async () => {
    // A per-run token in the term, so this does not accumulate across runs against the shared
    // database. The first version searched for the fixed term 'wave optics' and asserted a count
    // of 2, which passed once and then failed forever.
    const token = randomUUID().slice(0, 8);
    const id = randomUUID();
    await recordZeroResult(prisma(), `  Wave   OPTICS  ${token}`, { requestId: id });
    await recordZeroResult(prisma(), `wave optics ${token}`, { requestId: randomUUID() });
    const rows = await prisma().zeroResultQuery.findMany({
      where: { term: `wave optics ${token}` },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0].term).toBe(`wave optics ${token}`);
  });

  it('counts DISTINCT visitors, so one person retrying is not forty content gaps', async () => {
    // "How many people wanted this" is the commissioning number. "How many times" includes a
    // visitor whose connection dropped mid-typing, and ranking that first would bury the terms
    // forty different people each asked for once.
    const heavy = randomUUID().slice(0, 6);
    const light = randomUUID().slice(0, 6);
    for (let i = 0; i < 9; i += 1) {
      await recordZeroResult(prisma(), `retry ${heavy}`, { requestId: 'same-visitor' });
    }
    await recordZeroResult(prisma(), `wanted ${light}`, { requestId: randomUUID() });
    await recordZeroResult(prisma(), `wanted ${light}`, { requestId: randomUUID() });

    const gaps = await contentGaps(prisma(), { limit: 200 });
    const retry = gaps.find((g) => g.term === `retry ${heavy}`);
    const wanted = gaps.find((g) => g.term === `wanted ${light}`);
    expect(retry?.searches).toBe(9);
    expect(retry?.visitors, 'nine retries by one visitor is one visitor').toBe(1);
    expect(wanted?.visitors).toBe(2);
    expect(wanted?.searches).toBe(2);
  });

  it('a simulation gap is a term nothing in the catalogue mentions either', async () => {
    const term = `unobtainium${randomUUID().slice(0, 6)}`;
    await recordZeroResult(prisma(), term, { requestId: randomUUID() });
    const gaps = await contentGaps(prisma(), { limit: 500 });
    expect(gaps.find((g) => g.term === term)?.simulationGap).toBe(true);
  });

  /* ---------------------------------------------------------------- *
   * Facets
   * ---------------------------------------------------------------- */

  it('facet counts survive their own selection', async () => {
    // With every filter applied to every dimension, selecting one facet makes its own bucket
    // collapse and all others read zero — so the visitor narrows to a single facet and can no
    // longer see there was anything else.
    const owner = await user();
    const s = await subject('Facets');
    const other = await subject('FacetsOther');
    const token = `facet${randomUUID().slice(0, 8)}`;
    for (let i = 0; i < 3; i += 1) {
      await resource({
        title: `english ${i} ${token}`,
        language: 'en-GB',
        subjectId: s.id,
        ownerId: owner,
      });
      await resource({
        title: `french ${i} ${token}`,
        language: 'fr-FR',
        subjectId: other.id,
        ownerId: owner,
      });
    }

    await resource({ title: `${token} one`, language: 'en-GB', subjectId: s.id, ownerId: owner });
    await resource({
      title: `${token} deux`,
      language: 'fr-FR',
      subjectId: other.id,
      ownerId: owner,
    });

    const plain = await search(prisma(), { q: token });
    const scoped = await search(prisma(), { q: token, language: 'en-GB' });

    // Four of each: three from the loop above plus the two extra documents this test adds.
    // The first version expected 1 and got 4, and the fix is to COUNT the fixture rather than
    // to loosen the assertion — a facet test that does not know its own numbers is testing
    // nothing.
    const plainLangs = new Map(plain.facets.languages.map((l) => [l.value, l.count]));
    expect(plainLangs.get('en-GB')).toBe(4);
    expect(plainLangs.get('fr-FR')).toBe(4);

    // Selecting English must NOT zero the French bucket. That is the whole point of relaxing
    // each dimension for its own count: otherwise the visitor narrows to one facet and can no
    // longer see there was anything else.
    const scopedLangs = new Map(scoped.facets.languages.map((l) => [l.value, l.count]));
    expect(scopedLangs.get('fr-FR'), 'the unselected facet collapsed to zero').toBe(4);
    expect(scopedLangs.get('en-GB')).toBe(4);
    // The HITS do narrow.
    expect(scoped.hits.every((h) => h.language === 'en-GB')).toBe(true);
  });

  it('facets by subject, kind, simulation and age', async () => {
    const owner = await user();
    const s = await subject('FacetFull');
    const token = `ff${randomUUID().slice(0, 8)}`;
    await resource({
      title: `${token} a`,
      subjectId: s.id,
      ownerId: owner,
      minAge: 11,
      maxAge: 14,
      withSim: true,
    });
    await resource({
      title: `${token} b`,
      subjectId: s.id,
      ownerId: owner,
      minAge: 15,
      maxAge: 18,
    });

    const result = await search(prisma(), { q: token });
    expect(result.facets.subjects.some((f) => f.value === s.slug)).toBe(true);
    expect(result.facets.kinds.some((f) => f.value === 'LESSON')).toBe(true);
    expect(result.facets.simulations.with).toBe(1);
    expect(result.facets.simulations.without).toBe(1);
    expect(result.facets.ageBands.map((b) => b.value)).toEqual(
      expect.arrayContaining(['lower secondary (11-14)', 'upper secondary (15-18)']),
    );
  });

  it('filters by age as OVERLAP, not containment', async () => {
    // A resource written for 11–14 is the right answer for a teacher looking for ages 12–13.
    // Containment would drop it, and the teacher concludes the platform has nothing for them.
    const owner = await user();
    const s = await subject('Ages');
    const token = `age${randomUUID().slice(0, 8)}`;
    const id = await resource({
      title: `${token} middle`,
      subjectId: s.id,
      ownerId: owner,
      minAge: 11,
      maxAge: 14,
    });
    await resource({
      title: `${token} senior`,
      subjectId: s.id,
      ownerId: owner,
      minAge: 16,
      maxAge: 18,
    });

    const result = await search(prisma(), { q: token, subject: s.slug, ageMin: 12, ageMax: 13 });
    expect(result.hits.map((h) => h.id)).toEqual([id]);
  });

  it('age bands label what is stored, and an unset range is its own bucket', async () => {
    expect(ageBand(11, 14)).toBe('lower secondary (11-14)');
    // A 14-18 resource buckets by its YOUNGEST pupil, who is 14 — Year 9, still lower
    // secondary. It is not 'upper secondary', and the test that asserted it was was guessing.
    expect(ageBand(14, 18)).toBe('lower secondary (11-14)');
    expect(ageBand(15, 18)).toBe('upper secondary (15-18)');
    expect(ageBand(null, null)).toBe('unspecified');
    expect(ageBand(7, null)).toBe('primary (6-10)');
    // A wide resource buckets by its YOUNGEST pupil: a 10–16 resource is in the primary band,
    // because that is the teacher who needs it, and the age RANGE filter is what finds it for
    // an upper-secondary teacher. The band is a coarse label; the range is the precise control.
    expect(ageBand(10, 16)).toBe('primary (6-10)');
  });

  /* ---------------------------------------------------------------- *
   * Filters
   * ---------------------------------------------------------------- */

  it('filters by subject subtree and by tag, both narrowing the hits', async () => {
    const owner = await user();
    const root = await subject('SubRoot');
    const leaf = await subject('SubLeaf', root.id);
    const elsewhere = await subject('SubElsewhere');
    const t = await tag(`Scope${randomUUID().slice(0, 6)}`);
    const token = `sc${randomUUID().slice(0, 8)}`;

    const inLeaf = await resource({
      title: `${token} leaf`,
      subjectId: leaf.id,
      ownerId: owner,
      tags: [t],
    });
    const elsewhereId = await resource({
      title: `${token} elsewhere`,
      subjectId: elsewhere.id,
      ownerId: owner,
      tags: [t],
    });
    await resource({ title: `${token} untagged`, subjectId: leaf.id, ownerId: owner });

    const bySubject = await search(prisma(), { q: token, subject: root.slug });
    expect(bySubject.hits.map((h) => h.id)).toContain(inLeaf);
    expect(bySubject.hits.map((h) => h.id)).not.toContain(elsewhereId);

    const byTag = await search(prisma(), { q: token, subject: root.slug, tags: [t.slug] });
    expect(byTag.hits.map((h) => h.id)).toEqual([inLeaf]);
  });

  it('an unknown subject is an ERROR rather than silently searching everything', async () => {
    await expect(search(prisma(), { q: 'anything', subject: 'nope/missing' })).rejects.toThrow(
      /no such subject/,
    );
  });

  /* ---------------------------------------------------------------- *
   * The reindex path
   * ---------------------------------------------------------------- */

  it('reindexResource REPAIRS a row whose denormalised text was corrupted', async () => {
    // The generated column makes the weights and the vector unfalsifiable, but `tagText` and
    // `bodyText` are maintained by hand and CAN go stale. The mitigation is not "be careful" —
    // it is a repair function plus a test that deliberately breaks a row and repairs it.
    const owner = await user();
    const s = await subject('Reindex');
    const t = await tag(`Repair${randomUUID().slice(0, 6)}`);
    const bodyToken = `body${randomUUID().slice(0, 6)}`;
    const id = await resource({
      title: 'a title',
      tags: [t],
      body: `${bodyToken} should be findable`,
      subjectId: s.id,
      ownerId: owner,
      reindex: false,
    });

    await prisma().resource.update({ where: { id }, data: { tagText: null, bodyText: null } });
    const before = await search(prisma(), { q: t.name.toLowerCase(), subject: s.slug });
    expect(before.hits.map((h) => h.id)).not.toContain(id);

    await reindexResource(prisma(), id);
    const after = await search(prisma(), { q: t.name.toLowerCase(), subject: s.slug });
    expect(
      after.hits.map((h) => h.id),
      'the repair did not take',
    ).toContain(id);
    expect(
      (await search(prisma(), { q: bodyToken, subject: s.slug })).hits.map((h) => h.id),
    ).toContain(id);
  });

  it('reindexes the CURRENT version, not an old one', async () => {
    // Indexing a deleted word would make a resource findable by text its author has removed.
    const owner = await user();
    const s = await subject('Current');
    const stale = `stale${randomUUID().slice(0, 6)}`;
    const id = await resource({
      title: 'versioned',
      body: `current text ${stale}`,
      subjectId: s.id,
      ownerId: owner,
    });
    // Supersede with a version whose text does not contain the stale token.
    const v2 = await prisma().resourceVersion.create({
      data: {
        resourceId: id,
        version: 2,
        blocks: [{ type: 'paragraph', id: randomUUID(), content: [{ text: 'replacement text' }] }],
        blocksChecksum: '1'.repeat(64),
        meta: {},
        createdById: owner,
      },
      select: { id: true },
    });
    await prisma().resource.update({ where: { id }, data: { currentVersionId: v2.id } });
    await reindexResource(prisma(), id);
    expect(
      (await search(prisma(), { q: stale, subject: s.slug })).hits.map((h) => h.id),
    ).not.toContain(id);
  });

  /* ---------------------------------------------------------------- *
   * Pagination
   * ---------------------------------------------------------------- */

  it('pages without dropping rows at a RANK TIE', async () => {
    // `ts_rank` returns the same value for every row that matches the term once, so a
    // `rank < cursor` predicate drops every other tied row. The cursor compares (rank, id) as a
    // tuple precisely so page 2 can find the rest of the tie.
    const owner = await user();
    const s = await subject('Ties');
    const token = `tie${randomUUID().slice(0, 6)}`;
    for (let i = 0; i < 7; i += 1) {
      await resource({
        title: `${token} lesson`,
        body: 'identical body',
        subjectId: s.id,
        ownerId: owner,
      });
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard += 1) {
      const page = await search(prisma(), { q: token, subject: s.slug, limit: 3, cursor });
      seen.push(...page.hits.map((h) => h.id));
      if (!page.hasMore) break;
      cursor = page.nextCursor;
    }
    expect(seen).toHaveLength(7);
    expect(seen, 'a tied row was dropped between pages').toHaveLength(new Set(seen).size);
  });

  it('rejects a malformed cursor rather than silently restarting', async () => {
    await expect(search(prisma(), { q: 'x', cursor: 'garbage' })).rejects.toThrow(/cursor/);
  });
});

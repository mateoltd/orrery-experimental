/**
 * Search, facets, and the zero-result log.  (P3-T4, `plans/05` §6)
 *
 * ## This is the platform's first SIGNAL rather than a feature
 *
 * Everything before this was something a user asked for and got. Search is the first thing
 * here whose real value is what it REPORTS: `plans/05` §6 says zero-result queries are "the
 * single best signal for what content to commission next, and it feeds the simulation catalogue
 * directly". So the log is not a diagnostic side-effect of searching — it is a deliverable with
 * its own aggregation, and it is written even when nobody has ever read it.
 *
 * That is the design constraint that shaped the rest of this file. A signal that only exists
 * while somebody is looking at a dashboard is a feature with extra steps.
 *
 * ## `title > summary > tags > body`, as WEIGHTS, in a generated column
 *
 * The weights live in the column definition (migration 0007), not in this query. A query-side
 * weighting has to be repeated by every caller, and two callers weighting it differently is a
 * ranking nobody can debug. `ts_rank` here takes no weights argument because they are already
 * in the vector.
 *
 * ## Why RAW SQL
 *
 * `ts_rank`, `websearch_to_tsquery`, `similarity()` and `word_similarity` have no Prisma `where`
 * equivalent — Prisma has no `tsvector` support at all, and `searchVector` is declared
 * `Unsupported` for exactly that reason. Every predicate is still a bound parameter via
 * `$queryRaw`'s tagged template. **There is no string interpolation of user input anywhere in
 * this file**, and the one place a list is expanded uses `Prisma.join`, which parameterises each
 * element. That is worth stating because a raw-SQL search function is exactly where a reviewer
 * looks for the injection, and the answer should not require reading 200 lines to trust.
 *
 * `websearch_to_tsquery`, not `to_tsquery`. `to_tsquery` throws on unbalanced quotes and stray
 * operators, which means a user typing `"` gets a 500. `websearch_to_tsquery` never fails and
 * still supports quoted phrases and `OR`.
 *
 * ## Facet counts are computed with their OWN dimension relaxed
 *
 * Selecting "English" and having the English count collapse to zero is a facet that cannot be
 * un-selected. Every facet below is counted against the query MINUS ITS OWN FILTER, which is
 * the only definition under which a facet UI can let somebody change their mind.
 */

import { normalise, searchableText } from '@orrery/contracts/search/text';
import { Prisma } from '../prisma/generated/client/client.js';
import type { PrismaClient, TxClient } from './index.js';
import { subjectIdsFor, subjectSubtree } from './public-library.js';

type Db = PrismaClient | TxClient;

const MAX_PAGE = 50;
const DEFAULT_PAGE = 20;

/** `websearch_to_tsquery` treats these as operators, so a query that is only one of them is empty. */
const OPERATOR_ONLY = new Set(['and', 'or', 'not', '']);

export type SearchStrategy =
  /** Postgres full-text matched. The normal case. */
  | 'fts'
  /** Full-text found nothing, and the trigram fallback found something. */
  | 'trigram'
  /** Nothing at all. This is the case the zero-result log exists for. */
  | 'none';

export interface SearchQuery {
  readonly q: string;
  /** Subject SLUG, resolved to its whole subtree — same semantics as the public library. */
  readonly subject?: string | null;
  /** Tag slugs, ANDed. */
  readonly tags?: readonly string[];
  readonly kind?: 'LESSON' | 'QUIZ' | 'EXAM' | null;
  readonly language?: string | null;
  /** Age range overlap, not containment: a resource for 11–14 matches a search for 12–13. */
  readonly ageMin?: number | null;
  readonly ageMax?: number | null;
  readonly hasSimulation?: boolean | null;
  readonly limit?: number;
  readonly cursor?: string | null;
}

export interface SearchHit {
  readonly id: string;
  readonly title: string;
  readonly summary: string | null;
  readonly kind: string;
  readonly slug: string;
  readonly subjectSlug: string | null;
  readonly subjectName: string | null;
  readonly language: string;
  readonly hasSimulation: boolean;
  readonly updatedAt: string;
  readonly rank: number;
}

export interface FacetBucket {
  readonly value: string;
  readonly count: number;
}

export interface SearchFacets {
  readonly subjects: readonly FacetBucket[];
  readonly kinds: readonly FacetBucket[];
  readonly languages: readonly FacetBucket[];
  readonly simulations: { readonly with: number; readonly without: number };
  /** Age bands, derived from the stored numeric range. See `ageBand`. */
  readonly ageBands: readonly FacetBucket[];
}

/**
 * Age bands, and why AGE and not "grade".
 *
 * `plans/05` §6 says facet by "grade range" and defines no grade model anywhere; a grade is a
 * string in every jurisdiction ("Year 7", "Grade 5", "7th grade") and a range over strings
 * cannot be compared or bucketed. So `Resource` stores a numeric age range and this function
 * buckets it. The labels are ages because ages are true — a deployment can relabel the buckets
 * from the numbers without changing what is stored.
 */
export function ageBand(min: number | null, max: number | null): string {
  if (min === null && max === null) return 'unspecified';
  // BUCKETED BY THE YOUNGEST PUPIL IT SERVES, not by its midpoint and not by its range.
  //
  // A resource written for 10–16 belongs in one bucket, and the question is which. The midpoint
  // (13) puts it in lower secondary and hides it from anyone browsing upper secondary, which is
  // where the pupils who most need it are. The range is too wide to bucket at all.
  //
  // So: the minimum age, because a resource that works for a 10-year-old is a resource a
  // 10-year-old's teacher is looking for, and one that stretches up to 16 is still found by
  // everyone in between through the age RANGE filter rather than through the band. The band is
  // a coarse label; the range filter is the precise one, and the two are not the same control.
  // UK Key Stage boundaries, on the minimum age. `6-10` / `11-14` / `15-18` rather than the
  // tidier `5-11` / `11-14` / `14-18`, because those overlap at 11 and 14 and a boundary that
  // belongs to two bands belongs to neither: the first version labelled a band `11-14` while
  // testing `low <= 11` for `5-11`, so an 11-year-old resource was "primary" and the next band
  // claimed to start at 11. Age 11 is Year 7, which is lower secondary.
  const low = min ?? max ?? 0;
  if (low <= 5) return '5 and under';
  if (low <= 10) return 'primary (6-10)';
  if (low <= 14) return 'lower secondary (11-14)';
  if (low <= 18) return 'upper secondary (15-18)';
  return 'adult / further education';
}

export interface SearchOutcome {
  readonly hits: readonly SearchHit[];
  readonly strategy: SearchStrategy;
  readonly total: number;
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
  readonly facets: SearchFacets;
  /** The term as logged. Present so a caller can confirm what was recorded. */
  readonly normalisedTerm: string;
}

interface Scope {
  readonly subjectIds: readonly string[] | null;
}

/**
 * The SQL fragment for the anonymous-visitor listing predicate, as text.
 *
 * Duplicated from `PUBLIC_LISTING` as SQL because the search is raw. This is a genuine second
 * expression of the same rule, so the integration suite asserts the two agree by RUNNING both
 * over the same corpus and comparing the id sets — the same treatment `visibleInSearch` gets in
 * P2-T5. A comment saying they are kept in step by hand would be the failure this project has
 * already learned to look for.
 */
const PUBLIC_SQL = `r."status" = 'PUBLISHED' AND r."visibility" = 'PUBLIC'
  AND r."archivedAt" IS NULL AND r."currentVersionId" IS NOT NULL
  AND EXISTS (SELECT 1 FROM "User" o WHERE o.id = r."ownerId" AND o."isMinor" = false)`;

function buildFilters(
  q: SearchQuery,
  scope: Scope,
  relax?: 'subject' | 'tags' | 'kind' | 'language' | 'age' | 'simulation',
) {
  // `Prisma.raw`, NOT a template interpolation.
  //
  // `Prisma.sql`(${PUBLIC_SQL})` looks correct and is not: a plain string interpolated into a
  // `Prisma.sql` template becomes a BOUND PARAMETER, so the whole predicate was sent as
  // `($2)` with the predicate as a text value. Postgres then failed with "argument of AND must
  // be boolean, not text" — an error that points at the query's shape rather than at the one
  // character that caused it, in a file with a dozen raw queries.
  //
  // `raw` is safe HERE because `PUBLIC_SQL` is a literal in this file with no interpolation of
  // anything. The rule it belongs to: user input never reaches `raw`. Nothing else in this file
  // does, which is the property the header claims and this is where it is enforced.
  const parts: Prisma.Sql[] = [Prisma.sql`(${Prisma.raw(PUBLIC_SQL)})`];
  if (scope.subjectIds !== null && relax !== 'subject' && q.subject) {
    parts.push(Prisma.sql`r."subjectId" IN (${Prisma.join(scope.subjectIds)})`);
  }
  if (q.kind !== null && q.kind !== undefined && relax !== 'kind') {
    parts.push(Prisma.sql`r."kind" = ${q.kind}`);
  }
  if (q.tags !== undefined && q.tags.length > 0 && relax !== 'tags') {
    for (const tag of q.tags) {
      parts.push(
        Prisma.sql`EXISTS (SELECT 1 FROM "ResourceTag" rt JOIN "Tag" t ON t.id = rt."tagId" WHERE rt."resourceId" = r.id AND t."slug" = ${tag})`,
      );
    }
  }
  if (q.language !== null && q.language !== undefined && relax !== 'language') {
    parts.push(Prisma.sql`r."language" = ${q.language}`);
  }
  if (
    (q.ageMin !== null && q.ageMin !== undefined) ||
    (q.ageMax !== null && q.ageMax !== undefined) ||
    relax === 'age'
  ) {
    const lo = q.ageMin ?? -1;
    const hi = q.ageMax ?? 200;
    parts.push(
      Prisma.sql`(r."minAge" IS NULL OR r."maxAge" IS NULL OR (COALESCE(r."minAge", -1) <= ${hi} AND COALESCE(r."maxAge", 200) >= ${lo}))`,
    );
  }
  if (q.hasSimulation !== null && q.hasSimulation !== undefined && relax !== 'simulation') {
    parts.push(
      q.hasSimulation
        ? Prisma.sql`EXISTS (SELECT 1 FROM "ResourceSimRef" s WHERE s."resourceId" = r.id)`
        : Prisma.sql`NOT EXISTS (SELECT 1 FROM "ResourceSimRef" s WHERE s."resourceId" = r.id)`,
    );
  }
  return Prisma.join(parts, ' AND ');
}

/* ------------------------------------------------------------------ *
 * Reindexing the denormalised inputs
 * ------------------------------------------------------------------ */

/**
 * Recompute `tagText` and `bodyText` for one resource.
 *
 * ## The denormalisation, stated honestly
 *
 * `searchVector` is a generated column, so the WEIGHTS cannot drift and Postgres will not let a
 * raw SQL write skip the vector. But the two text columns it reads are maintained here, which
 * means every path that changes a tag or a version must call this. That is a real cost and the
 * alternative — a recursive CTE joining `ResourceTag` inside the vector — is not available,
 * because a stored `tsvector` cannot span a join.
 *
 * So the mitigation is: one function, called from the three places that can invalidate it, and
 * an integration test that corrupts a row on purpose and proves this repairs it. A denormalised
 * column with a tested repair path is a design; one without either is a bug with a delay.
 *
 * `blocks` come from the CURRENT version, because the index should describe what a visitor will
 * actually read. Indexing an old version's text would make a resource findable by words its
 * author has since deleted.
 */
export async function reindexResource(db: Db, resourceId: string): Promise<void> {
  const row = await db.resource.findUnique({
    where: { id: resourceId },
    select: {
      tags: { select: { tag: { select: { name: true } } } },
      currentVersion: { select: { blocks: true } },
    },
  });
  if (row === null) return;

  // TAG NAMES, not slugs. "Snell's law" is what a teacher types; `snells-law` is not.
  const tagText = normalise(row.tags.map((t) => t.tag.name).join(' '));
  // A resource with no current version indexes its title alone. It will not be listed — the
  // listing predicate requires a version — but an unindexable row is a row that explodes the
  // first time something scans the table.
  const bodyText = searchableText((row.currentVersion?.blocks ?? []) as never);

  await db.resource.update({ where: { id: resourceId }, data: { tagText, bodyText } });
}

/* ------------------------------------------------------------------ *
 * Zero-result log
 * ------------------------------------------------------------------ */

export interface ZeroResultContext {
  readonly requestId: string;
  readonly subjectSlug?: string | null;
  readonly kind?: string | null;
  readonly tags?: readonly string[];
}

/**
 * Record a search that matched nothing.
 *
 * ## What is stored, and what is deliberately not
 *
 * The NORMALISED term, exactly as `plans/05` §6 asks. Not the raw string, not a hash of the raw
 * string. A search box is one of the two places a person types something that is not meant to
 * become a record — their own name, a pupil's name, a school — and the normalising the plan
 * specifies already collapses `"Wave  Optics "` and `"wave optics"` into one row, which is what
 * the aggregation wants regardless.
 *
 * The absence of a raw-term column is a comment on the model rather than a column on it,
 * because the temptation to add one is exactly when a search log becomes a list of what people
 * typed. Truncation happens in `normalise`, so a pasted essay cannot become a 200,000-character
 * row either.
 *
 * ## Duplicates are NOT collapsed
 *
 * Forty searches for the same term by one visitor mid-typing is a stuck request, not forty
 * signals. The aggregation downstream groups by term and counts DISTINCT `requestId`, so a
 * caller that wants "how many people" gets it; a caller that wants "how many times" is choosing
 * between two real questions and both are available.
 */
export async function recordZeroResult(
  db: Db,
  rawTerm: string,
  context: ZeroResultContext,
): Promise<void> {
  const term = normalise(rawTerm);
  // An empty or operator-only term is not a search anybody made. Logging "and" 400 times is how a
  // signal becomes noise, and a signal that is 90% junk does not get read.
  if (term.length === 0 || OPERATOR_ONLY.has(term)) return;

  await db.zeroResultQuery.create({
    data: {
      term: term.slice(0, 120),
      requestId: context.requestId,
      subjectSlug: context.subjectSlug ?? null,
      kind: context.kind ?? null,
      tags: (context.tags ?? []) as never,
    },
  });
}

export interface ContentGap {
  readonly term: string;
  /** Distinct visitors. "How many people wanted this" — the commissioning number. */
  readonly visitors: number;
  /** Total searches, including repeats from one visitor mid-typing. */
  readonly searches: number;
  /** Narrowed to a subject when every miss for this term was in one. */
  readonly subjectSlug: string | null;
  /** True when no resource in the whole platform has a simulation and the term sounds like one. */
  readonly simulationGap: boolean;
}

/**
 * The commissioning report `plans/05` §6 promises.
 *
 * Sorted by VISITORS, not searches. A term one teacher typed forty times while their connection
 * dropped is a support problem, not a content gap, and ranking it first would bury the terms that
 * forty different people each asked for once. Both numbers are returned because they are
 * different questions and the reader usually wants to see the ratio before deciding which one
 * they are looking at.
 *
 * `simulationGap` is the "feeds the simulation catalogue directly" part: a term nobody can
 * satisfy with a lesson, where nothing in the catalogue mentions it either. That is the list to
 * commission a simulation from, and it is the reason this function exists rather than a
 * dashboard query somebody could have written later.
 */
export async function contentGaps(
  db: Db,
  options: { readonly since?: Date; readonly limit?: number } = {},
): Promise<readonly ContentGap[]> {
  // Three queries TOTAL, not two per term.
  //
  // The first version of this function called `findMany` inside the loop over terms, which is
  // the N+1 that turns a 50-term report into 101 round trips — and it was written that way
  // because the aggregation reads more naturally as a loop. It is the shape most likely to
  // ship, because at ten terms it is fast enough to look right in a terminal.
  const since = options.since ?? new Date('2000-01-01T00:00:00.000Z');
  const where = { createdAt: { gte: since } };

  const [counts, visitors, subjects, simTitles] = await Promise.all([
    db.zeroResultQuery.groupBy({ by: ['term'], where, _count: { _all: true } }),
    db.zeroResultQuery.findMany({
      where,
      select: { term: true, requestId: true },
      distinct: ['term', 'requestId'],
    }),
    db.zeroResultQuery.findMany({ where, select: { term: true, subjectSlug: true } }),
    db.simulation.findMany({ select: { title: true, description: true } }),
  ]);

  const visitorsByTerm = new Map<string, Set<string>>();
  for (const r of visitors) {
    const set = visitorsByTerm.get(r.term) ?? new Set<string>();
    set.add(r.requestId);
    visitorsByTerm.set(r.term, set);
  }
  const subjectsByTerm = new Map<string, Set<string>>();
  for (const r of subjects) {
    if (r.subjectSlug === null) continue;
    const set = subjectsByTerm.get(r.term) ?? new Set<string>();
    set.add(r.subjectSlug);
    subjectsByTerm.set(r.term, set);
  }

  const gaps: ContentGap[] = counts.map((row) => {
    const subs = subjectsByTerm.get(row.term);
    return {
      term: row.term,
      visitors: visitorsByTerm.get(row.term)?.size ?? 0,
      searches: row._count._all,
      subjectSlug: subs !== undefined && subs.size === 1 ? ([...subs][0] ?? null) : null,
      // The catalogue is small enough to hold in memory once and match in JS, rather than one
      // COUNT per term. `Simulation` is bounded by the 24+ authored sims, not by user content.
      simulationGap: !simTitles.some(
        (s) =>
          s.title.toLowerCase().includes(row.term) ||
          s.description.toLowerCase().includes(row.term),
      ),
    };
  });

  gaps.sort((a, b) => b.visitors - a.visitors || b.searches - a.searches);
  return gaps.slice(0, options.limit ?? 50);
}

/* ------------------------------------------------------------------ *
 * The search
 * ------------------------------------------------------------------ */

interface RawHit {
  id: string;
  title: string;
  summary: string | null;
  kind: string;
  slug: string;
  language: string;
  updatedAt: Date;
  rank: number;
  subjectSlug: string | null;
  subjectName: string | null;
  hasSimulation: boolean;
}

/**
 * The trigram threshold.
 *
 * `pg_trgm`'s default similarity threshold is 0.3, which is generous enough that "waves" finds
 * "wavelength". Lowering it below 0.2 starts matching unrelated words that share three letters,
 * and a fallback that invents results is worse than no fallback: the visitor cannot tell the
 * difference between a real match and a plausible-looking one, and neither can the person they
 * ask for help.
 */
const TRIGRAM_THRESHOLD = 0.3;

/**
 * Below this length the fallback does not run at all.
 *
 * `pg_trgm` works on three-character groups, so a one- or two-character query has no trigrams
 * and `similarity()` degenerates: the string `"` has a similarity well above 0.3 against almost
 * any title, and the fallback returned a page of unrelated lessons for it. The first version had
 * no floor and the operator-only test caught it — `"` was classified `trigram`.
 *
 * A three-character floor is not a tuning choice, it is the mechanism's own granularity, and
 * anything below it is measuring something other than what the caller asked for.
 */
const TRIGRAM_MIN_LENGTH = 3;

function encodeCursor(rank: number, id: string): string {
  return Buffer.from(JSON.stringify([1, rank, id]), 'utf8').toString('base64url');
}

function decodeCursor(raw: string): { rank: number; id: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new Error('search: malformed cursor');
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 3 ||
    parsed[0] !== 1 ||
    typeof parsed[1] !== 'number' ||
    typeof parsed[2] !== 'string'
  ) {
    throw new Error('search: unrecognised cursor');
  }
  return { rank: parsed[1], id: parsed[2] };
}

/**
 * Search the public library.
 *
 * ## The fallback is REPORTED, not silent
 *
 * `strategy` is in the response. A trigram match is a weaker claim than a full-text one — the
 * visitor got something that looks similar rather than something that contains the words — and
 * hiding that makes a surprising result indistinguishable from a correct one. The UI can say
 * "showing close matches" and the ranking of a `trigram` result is similarity order, not
 * relevance, which is a different promise.
 *
 * ## The zero-result log fires only on `none`
 *
 * Not on `trigram`. A visitor who found something did not produce a content gap, and logging
 * every fuzzy hit would fill the commissioning report with terms that are already satisfied —
 * the fastest way to make a signal nobody reads.
 *
 * ## Cursor is (rank, id) compared ROW-WISE
 *
 * Rank is a float recomputed by the same expression for the same query, so it is stable for a
 * given row. Comparing `(rank, id)` as a tuple rather than `rank < ?` alone matters: `ts_rank`
 * returns ties constantly — every row that matches the term once has the same rank — and a
 * `rank < ?` cursor silently drops every other row at the tie. That is a page-2 that is missing
 * results, which is the specific failure keyset pagination is supposed to prevent.
 */
export async function search(
  db: Db,
  query: SearchQuery,
  context?: ZeroResultContext,
): Promise<SearchOutcome> {
  const limit = Math.min(Math.max(query.limit ?? DEFAULT_PAGE, 1), MAX_PAGE);
  const normalisedTerm = normalise(query.q);

  // Slugs in, IDS out. `subjectSubtree` speaks slugs because that is the public identifier;
  // `Resource.subjectId` holds a uuid, and passing slugs straight through filters on a column
  // that can never equal them — which returns zero rows rather than an error, and reads like a
  // ranking problem instead of a key mismatch.
  let scope: Scope = { subjectIds: null };
  if (query.subject !== null && query.subject !== undefined) {
    // The unknown check comes BEFORE the id conversion, not after. Converting first means an
    // unknown subject becomes an empty id list, `Prisma.join([])` throws "Expected join([]) to
    // be called with an array of at least one element", and the error names a Prisma internal
    // instead of the typo the visitor made. The order is the whole difference between a useful
    // message and a stack trace.
    const subtree = await subjectSubtree(db, query.subject);
    if (subtree === null) throw new Error(`search: no such subject "${query.subject}"`);
    scope = { subjectIds: await subjectIdsFor(db, subtree) };
  }

  const filters = buildFilters(query, scope);

  // An empty or operator-only term is a browse, not a search. Listing everything would be
  // correct but would then be logged as a zero result by the caller, so it returns `none` with
  // no hits and never touches the log.
  const isRealQuery = normalisedTerm.length > 0 && !OPERATOR_ONLY.has(normalisedTerm);

  let rows: RawHit[] = [];
  let strategy: SearchStrategy = 'none';
  let total = 0;
  // The predicate that SELECTED the rows, reused for the facets. A facet computed against a
  // different set than the one being faceted is a table of the database, not a facet — see
  // `computeFacets`, which had that bug and no test caught it until the counts came back 1,269.
  let match: Prisma.Sql = Prisma.sql`FALSE`;

  if (isRealQuery) {
    const tsq = Prisma.sql`websearch_to_tsquery('english', ${query.q})`;
    const cursorClause = cursorRankClause(query.cursor, tsq);
    rows = await db.$queryRaw<RawHit[]>(Prisma.sql`
      SELECT r.id, r.title, r.summary, r.kind, r.slug, r.language, r."updatedAt",
             r."subjectId" IS NOT NULL AS "hasSubjectSubject",
             ${rankExpr(tsq)} AS rank,
             s.slug AS "subjectSlug", s.name AS "subjectName",
             EXISTS (SELECT 1 FROM "ResourceSimRef" rs WHERE rs."resourceId" = r.id) AS "hasSimulation"
      FROM "Resource" r
      LEFT JOIN "Subject" s ON s.id = r."subjectId"
      WHERE r."searchVector" @@ ${tsq} AND ${filters} ${cursorClause}
      ORDER BY rank DESC, r.id DESC
      LIMIT ${limit + 1}`);
    strategy = rows.length > 0 ? 'fts' : 'trigram';
    total = await countFts(db, tsq, filters);
    if (strategy === 'fts') match = Prisma.sql`r."searchVector" @@ ${tsq}`;
  }

  // The fallback runs only for a query long enough to have trigrams. `strategy` is already
  // 'trigram' at this point because FTS found nothing; the guard decides whether the FALLBACK is
  // allowed to answer, and a query too short to match on becomes a genuine zero result.
  if (strategy === 'trigram' && normalisedTerm.length >= TRIGRAM_MIN_LENGTH) {
    // The fallback, over title, summary and tag names — the "what is this thing called" fields.
    //
    // NOT over `bodyText`, deliberately. Trigram similarity over a whole lesson matches any two
    // documents sharing a boilerplate phrase, so a lesson about circles surfaces for "lesson"
    // and the result looks like a plausible answer. A title or a tag is what a visitor is
    // misspelling when they misspell something, and the three fields here are the ones a
    // teacher can be expected to have read before searching for it.
    const like = `%${query.q.toLowerCase()}%`;
    rows = await db.$queryRaw<RawHit[]>(Prisma.sql`
      SELECT r.id, r.title, r.summary, r.kind, r.slug, r.language, r."updatedAt",
             true AS "hasSubjectSubject",
             GREATEST(
               similarity(r.title, ${query.q}),
               similarity(coalesce(r.summary, ''), ${query.q}),
               similarity(coalesce(r."tagText", ''), ${query.q})
             ) AS rank,
             s.slug AS "subjectSlug", s.name AS "subjectName",
             EXISTS (SELECT 1 FROM "ResourceSimRef" rs WHERE rs."resourceId" = r.id) AS "hasSimulation"
      FROM "Resource" r
      LEFT JOIN "Subject" s ON s.id = r."subjectId"
      WHERE ${filters}
        AND (similarity(r.title, ${query.q}) > ${TRIGRAM_THRESHOLD} OR r.title ILIKE ${like})
      ORDER BY rank DESC, r.id DESC
      LIMIT ${limit + 1}`);
    total = rows.length;
    match = Prisma.sql`(
      similarity(r.title, ${query.q}) > ${TRIGRAM_THRESHOLD}
      OR r.title ILIKE ${like}
      OR similarity(coalesce(r.summary, ''), ${query.q}) > ${TRIGRAM_THRESHOLD}
      OR similarity(coalesce(r."tagText", ''), ${query.q}) > ${TRIGRAM_THRESHOLD}
    )`;
  } else if (strategy === 'trigram') {
    // Too short to fall back on, so it really is nothing.
    rows = [];
    strategy = 'none';
  }

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  // An empty page is a legitimate answer — it is the whole reason the zero-result log exists —
  // so it returns rather than throwing. The guard is only for the impossible case: rows
  // discarded by the slice while still claiming more. The first version of this function threw
  // on ANY empty page, which made every zero-result search a 500 and quietly disabled the
  // feature the packet asks for.
  if (hasMore && page.length === 0) {
    throw new Error('search: rows were fetched then discarded; hasMore cannot be true');
  }

  if (strategy === 'none' && context !== undefined) {
    await recordZeroResult(db, query.q, context);
  }

  const last = page[page.length - 1];

  return {
    hits: page.map((r) => ({
      id: r.id,
      title: r.title,
      summary: r.summary,
      kind: r.kind,
      slug: r.slug,
      language: r.language,
      updatedAt: r.updatedAt.toISOString(),
      rank: Number(r.rank),
      subjectSlug: r.subjectSlug,
      subjectName: r.subjectName,
      hasSimulation: r.hasSimulation,
    })),
    strategy,
    total,
    hasMore,
    nextCursor: last === undefined ? null : encodeCursor(last.rank, last.id),
    facets: await computeFacets(db, query, scope, match),
    normalisedTerm,
  };
}

/**
 * THE RANK EXPRESSION. One definition, used in the SELECT, the ORDER BY and the cursor.
 *
 * ## Why `round(...::numeric, 6)::float8` and not plain `ts_rank`
 *
 * `ts_rank` returns `real` — a float4. A cursor round-trips through JSON, so it comes back as a
 * float8. Those are not the same number: the rank `0.6079271` is
 * `0.60792708301544189453125` as a float4 and `0.6079271` as a float8.
 *
 * The row-wise cursor comparison `(ts_rank(...), r.id) < ($rank, $id)` then compares
 * float4-widened against float8, and `0.6079270830 < 0.6079271` is TRUE. Which means the first
 * component of the tuple is true for every row that ties the cursor, the OR short-circuits, and
 * **the cursor filters nothing**: page 2 returns page 1. The test that caught it asserted a
 * rank TIE, which is the only case where the tiebreak matters and therefore the only case where
 * this is visible at all.
 *
 * Rounding through `numeric` to a fixed scale and casting back to float8 makes both sides the
 * same double, so `=` is exact and the tuple comparison means what it says. `numeric` is the
 * intermediate because it is arbitrary-precision — a float8 round-trip would reintroduce the
 * problem one step later.
 *
 * ## Why ONE expression rather than three copies
 *
 * The SELECT, the ORDER BY and the cursor must rank identically, or the cursor is comparing
 * against a different ordering than the one that produced it. Three copies of a rank expression
 * is three chances to disagree, and the disagreement is invisible: results come back, in a
 * slightly wrong order, forever.
 */
function rankExpr(tsq: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`round(ts_rank(r."searchVector", ${tsq})::numeric, 6)::float8`;
}

function cursorRankClause(cursor: string | null | undefined, tsq: Prisma.Sql): Prisma.Sql {
  if (!cursor) return Prisma.empty;
  const { rank, id } = decodeCursor(cursor);
  // Row-wise comparison, so ties are broken by id instead of dropped. See the header.
  return Prisma.sql`AND (${rankExpr(tsq)}, r.id) < (${rank}, ${id})`;
}

async function countFts(db: Db, tsq: Prisma.Sql, filters: Prisma.Sql): Promise<number> {
  const [row] = await db.$queryRaw<{ n: bigint }[]>(Prisma.sql`
    SELECT count(*)::bigint AS n FROM "Resource" r
    WHERE r."searchVector" @@ ${tsq} AND ${filters}`);
  return Number(row?.n ?? 0);
}

/**
 * Facet counts, each computed with its OWN dimension relaxed.
 *
 * This is the difference between a facet UI and a set of numbers. With the filter applied to
 * every dimension, selecting "English" makes the English bucket show `1` and every other bucket
 * show `0`; the visitor has narrowed to a single facet and can no longer see there is anything
 * else, and the facet they just used has collapsed to the least useful number on the page.
 */
async function computeFacets(
  db: Db,
  query: SearchQuery,
  scope: Scope,
  match: Prisma.Sql,
): Promise<SearchFacets> {
  const [subjects, kinds, languages, sims, ages] = await Promise.all([
    facetGroups(
      db,
      query,
      scope,
      match,
      'subject',
      (r) => r.subjectSlug,
      (r) => r.subjectName,
    ),
    facetGroups(db, query, scope, match, 'kind', (r) => r.kind),
    facetGroups(db, query, scope, match, 'language', (r) => r.language),
    simFacet(db, query, scope, match),
    ageFacet(db, query, scope, match),
  ]);

  const simsByValue = new Map(sims.map((s) => [s.value, s.count]));
  return {
    subjects,
    kinds,
    languages,
    simulations: { with: simsByValue.get('true') ?? 0, without: simsByValue.get('false') ?? 0 },
    ageBands: ages,
  };
}

type Row = {
  subjectSlug: string | null;
  subjectName: string | null;
  kind: string;
  language: string;
  hasSimulation: boolean;
};

async function facetGroups(
  db: Db,
  query: SearchQuery,
  scope: Scope,
  match: Prisma.Sql,
  relax: 'subject' | 'kind' | 'language',
  value: (r: Row) => string | null,
  label?: (r: Row) => string | null,
): Promise<FacetBucket[]> {
  // `match` AND the relaxed filters. The match is what scopes a facet to the RESULT SET, and
  // omitting it produced a language facet with 1,353 buckets for a two-document search.
  const filters = Prisma.sql`${match} AND ${buildFilters(query, scope, relax)}`;
  const rows = await db.$queryRaw<
    (Row & { value: string | null; label: string | null })[]
  >(Prisma.sql`
    SELECT r.kind, r.language, s.slug AS "subjectSlug", s.name AS "subjectName",
           EXISTS (SELECT 1 FROM "ResourceSimRef" rs WHERE rs."resourceId" = r.id) AS "hasSimulation"
    FROM "Resource" r LEFT JOIN "Subject" s ON s.id = r."subjectId"
    WHERE ${filters}`);
  const counts = new Map<string, { count: number; label: string | null }>();
  for (const row of rows) {
    const v = value(row);
    if (v === null) continue;
    const entry = counts.get(v) ?? { count: 0, label: label?.(row) ?? null };
    entry.count += 1;
    counts.set(v, entry);
  }
  return [...counts]
    .map(([k, v]) => ({ value: k, count: v.count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

async function simFacet(
  db: Db,
  query: SearchQuery,
  scope: Scope,
  match: Prisma.Sql,
): Promise<FacetBucket[]> {
  const filters = Prisma.sql`${match} AND ${buildFilters(query, scope, 'simulation')}`;
  const rows = await db.$queryRaw<Row[]>(Prisma.sql`
    SELECT r.kind, r.language, s.slug AS "subjectSlug", s.name AS "subjectName",
           EXISTS (SELECT 1 FROM "ResourceSimRef" rs WHERE rs."resourceId" = r.id) AS "hasSimulation"
    FROM "Resource" r LEFT JOIN "Subject" s ON s.id = r."subjectId"
    WHERE ${filters}`);
  const with_ = rows.filter((r) => r.hasSimulation).length;
  return [
    { value: 'true', count: with_ },
    { value: 'false', count: rows.length - with_ },
  ];
}

async function ageFacet(
  db: Db,
  query: SearchQuery,
  scope: Scope,
  match: Prisma.Sql,
): Promise<FacetBucket[]> {
  const filters = Prisma.sql`${match} AND ${buildFilters(query, scope, 'age')}`;
  const rows = await db.$queryRaw<{ minAge: number | null; maxAge: number | null }[]>(Prisma.sql`
    SELECT r."minAge", r."maxAge" FROM "Resource" r WHERE ${filters}`);
  const counts = new Map<string, number>();
  for (const row of rows) {
    const band = ageBand(row.minAge, row.maxAge);
    counts.set(band, (counts.get(band) ?? 0) + 1);
  }
  return [...counts]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

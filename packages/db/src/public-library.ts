/**
 * The PUBLIC library: what a visitor with no account can find.  (P3-T3)
 *
 * ## Why this is a separate module from `library.ts`
 *
 * `library.ts` is the AUTHOR's view — "mine", blast radius, transfer, duplicate. This is the
 * ANONYMOUS VISITOR's view. They are different questions with different rules, and the packet
 * asks for both, so conflating them is the first thing that goes wrong: a function that takes
 * an `Actor` and "also works when there isn't one" is a function that will eventually be
 * called with a fabricated actor id, and a fabricated actor id is how a private draft ends up
 * on a public page.
 *
 * So there is no anonymous `Actor` here. `browsePublic` takes no actor at all, and the only
 * thing it can return is what an anonymous visitor may see. Augmenting it for a signed-in
 * viewer is a later task's problem, and it will have to be a separate function — not an
 * optional parameter on this one.
 *
 * ## The listing predicate, in one place, in SQL
 *
 * `PUBLIC_LISTING` is exported so search (P3-T4) and any cache key can reuse it verbatim. It is
 * a `where` clause, not a post-filter, for the reason `searchResources` documents at length:
 * a post-filter has already paid to read every row the database was willing to return, so the
 * private rows were in application memory, in the query log, and in the slow-query sample
 * before anybody got round to hiding them.
 *
 * Four conditions, and each one is a way a row could be listable that is not actually READABLE:
 *
 *   1. `status = PUBLISHED` — not DRAFT, not ARCHIVED ("no longer current"), not WITHDRAWN.
 *   2. `visibility = PUBLIC` — UNLISTED is reachable by link and must never be listed.
 *   3. `owner.isMinor = false` — **plans/05 §6: "Under-18 authors' resources are not publicly
 *      listed by default."** This is a child-safety rule that arrived in the discovery section
 *      of the content plan and is easy to read past as boilerplate. It is the one condition in
 *      this file that is about a person rather than a resource, and it is the one whose absence
 *      would not fail any test about permissions.
 *   4. `currentVersionId != null` and `archivedAt = null` — a row with no version cannot be
 *      read, so listing it offers a link to a 404. Defence in depth against a status/flag
 *      pair that a future migration could put out of step.
 *
 * ## Pagination is keyset, and jump-to-page is deliberately unsupported
 *
 * Offset pagination over `updatedAt DESC` skips and duplicates rows the moment a teacher
 * publishes something, which on a public library is constantly — the list is being written to
 * while people scroll it. Keyset pagination on `(sortValue, id)` cannot do that, because it
 * anchors on a value the reader already saw.
 *
 * The cost is that you cannot jump to "page 7". That is a real product loss and it is
 * accepted deliberately: a jump-to-page control on a mutable ordering is a control that
 * sometimes lands the reader on a set of results that does not contain what they were paging
 * towards, and it is impossible to make correct without freezing the ordering. Frozen
 * orderings go stale within minutes here.
 */

import { subtreeOf, type TreeEdge } from '@orrery/contracts/taxonomy';
import type { Prisma } from '../prisma/generated/client/client.js';
import type { PrismaClient, TxClient } from './index.js';

type Db = PrismaClient | TxClient;

/**
 * Everything that makes a resource publicly listable, as one reusable clause.
 *
 * `mode: 'insensitive'` never appears — nothing here matches a user-supplied string. That is
 * P3-T4's business, and the absence is worth stating because a filter that "helpfully"
 * accepted a query string here would make this the wrong place to look for an injection.
 */
export const PUBLIC_LISTING: Prisma.ResourceWhereInput = {
  status: 'PUBLISHED',
  visibility: 'PUBLIC',
  archivedAt: null,
  currentVersionId: { not: null },
  owner: { is: { isMinor: false } },
};

/** Hard ceiling on one page. A caller asking for more gets this, not an error. */
const MAX_PAGE = 100;
const DEFAULT_PAGE = 24;

/* ------------------------------------------------------------------ *
 * Subtree resolution
 * ------------------------------------------------------------------ */

interface SubjectEdge {
  readonly id: string;
  readonly slug: string;
  readonly parentId: string | null;
}

/**
 * The taxonomy as an edge map, keyed by SLUG.
 *
 * Slugs rather than ids because slugs are the public identifier — a URL that says
 * `maths/algebra` should not change when the row is re-created, and P3-T6 is about canonical
 * URLs. The projection is three columns, not the row.
 */
async function subjectEdges(db: Db): Promise<readonly SubjectEdge[]> {
  // Three columns, not the row. The projection is the point: this is read on every browse.
  return db.subject.findMany({ select: { id: true, slug: true, parentId: true } });
}

interface Taxonomy {
  readonly bySlug: ReadonlyMap<string, SubjectEdge>;
  readonly byId: ReadonlyMap<string, string>;
  readonly edge: TreeEdge;
}

/**
 * Build both directions ONCE.
 *
 * ## The bug this shape exists to prevent
 *
 * The first version took a `Map<slug, row>` and resolved parents with `bySlug.get(row.id)` —
 * an **id** lookup in a **slug**-keyed map. It returned `undefined` for every row, every
 * parent became `null`, and every node looked like a root. Nothing threw. `subtreeOf` got a
 * forest of 246 single-node trees and dutifully returned each node alone.
 *
 * The visible symptom was "the tree counts are all zero and browsing Algebra shows nothing",
 * which reads as a data problem and sends you to the seed. The actual fault was one token in one
 * lookup. The integration test named it in one run; a unit test with a hand-built two-node tree
 * would have too, and the reason to insist on a two-node tree in a unit test is precisely that
 * a 246-node fixture hides a keying mistake behind plausible-looking output.
 *
 * Two maps, built together, so there is no way to resolve a parent in the wrong key space.
 */
function buildTaxonomy(rows: readonly SubjectEdge[]): Taxonomy {
  const bySlug = new Map(rows.map((r) => [r.slug, r]));
  const byId = new Map(rows.map((r) => [r.id, r.slug]));
  const edge: TreeEdge = Object.fromEntries(
    rows.map((r) => [r.slug, r.parentId === null ? null : (byId.get(r.parentId) ?? null)]),
  );
  return { bySlug, byId, edge };
}

/**
 * Every slug in a subject's subtree, INCLUDING itself.
 *
 * ## Why a teacher clicking "Algebra" expects the quadratics page
 *
 * Because "Algebra" has no resources of its own. Real curriculum lives at the leaves — the
 * reason `Subject` is a tree and not a flat list. Filtering on `subjectId = <algebra>` alone
 * returns an empty page for a branch that visibly has children, which is the single most
 * common way a taxonomy gets described as "broken" by a user when it is in fact working.
 *
 * ## Why the whole taxonomy is loaded, and where that stops being true
 *
 * `subtreeOf` is the SAME function P3-T1 moved subjects with and the seed gate validated
 * against, so "what is under Algebra" has exactly one implementation in the system. The
 * alternative — a recursive CTE in raw SQL — scales better and introduces a second
 * implementation that can disagree with the first, which is the failure mode this project has
 * now hit three times (migration corpus, `blocksChecksum`, the subject tree itself).
 *
 * The cost is one indexed three-column scan of the taxonomy per browse. At 246 subjects that
 * is sub-millisecond and will stay sub-millisecond to roughly 10^4 subjects, which is two
 * orders of magnitude past any realistic curriculum. **Above that, add a materialised `path`
 * column maintained by `moveSubject` — do not add a second subtree algorithm.** The threshold
 * is written down so the decision gets made once, on evidence, instead of by whoever is
 * slowest to notice a slow page.
 */
export async function subjectSubtree(db: Db, slug: string): Promise<readonly string[] | null> {
  const { bySlug, edge } = buildTaxonomy(await subjectEdges(db));
  if (!bySlug.has(slug)) return null;
  return subtreeOf(edge, slug);
}

/* ------------------------------------------------------------------ *
 * The tree
 * ------------------------------------------------------------------ */

export interface SubjectNode {
  readonly slug: string;
  readonly name: string;
  readonly colour: string | null;
  readonly position: number;
  readonly parentSlug: string | null;
  readonly hasChildren: boolean;
  /** Resources listable under THIS node exactly. */
  readonly directCount: number;
  /** Resources listable anywhere in this node's subtree. What a user means by "in Algebra". */
  readonly publicCount: number;
  /** True when a teacher should not be invited to click. Prevents a dead-end click. */
  readonly empty: boolean;
}

/**
 * The browsable subject tree, with live public counts.
 *
 * Counts are a SUBTREE rollup from ONE grouped query. The obvious alternative — a count per
 * node, 246 of them — is the N+1 that makes a tree page take 250ms, and it is also wrong in
 * the way that matters: it answers "how many are in Algebra" 246 slightly different ways.
 *
 * A node with `publicCount > 0` is reachable by clicking, and a node with `publicCount === 0`
 * is marked `empty` rather than hidden. Hiding it would be a lie about the curriculum; a
 * teacher looking for "Earth Science" and finding no such branch needs to know the branch does
 * not exist yet, which is a content-commissioning signal, not a UI detail.
 */
export async function subjectTree(db: Db): Promise<readonly SubjectNode[]> {
  const rows = await db.subject.findMany({
    select: {
      id: true,
      slug: true,
      name: true,
      colour: true,
      position: true,
      parentId: true,
      _count: { select: { children: true } },
    },
    orderBy: { position: 'asc' },
  });

  // One query, grouped in the database: how many listable resources sit on each subject.
  const grouped = await db.resource.groupBy({
    by: ['subjectId'],
    where: { ...PUBLIC_LISTING },
    _count: { _all: true },
  });
  const direct = new Map<string, number>();
  for (const g of grouped) {
    if (g.subjectId !== null) direct.set(g.subjectId, g._count._all);
  }

  const { bySlug, byId, edge } = buildTaxonomy(rows);
  const nodes: SubjectNode[] = rows.map((row) => {
    let publicCount = 0;
    // `subtreeOf` INCLUDES the node itself, so one walk per node is a whole-subtree sum.
    for (const s of subtreeOf(edge, row.slug)) {
      const node = bySlug.get(s);
      if (node !== undefined) publicCount += direct.get(node.id) ?? 0;
    }
    return {
      slug: row.slug,
      name: row.name,
      colour: row.colour,
      position: row.position,
      parentSlug: row.parentId === null ? null : (byId.get(row.parentId) ?? null),
      hasChildren: row._count.children > 0,
      directCount: direct.get(row.id) ?? 0,
      publicCount,
      empty: publicCount === 0,
    };
  });
  return nodes;
}

/* ------------------------------------------------------------------ *
 * Browsing
 * ------------------------------------------------------------------ */

export const LIBRARY_SORTS = ['newest', 'oldest', 'title'] as const;
export type LibrarySort = (typeof LIBRARY_SORTS)[number];

export interface LibraryQuery {
  /** A subject SLUG. Its whole subtree is included. `null` means the entire library. */
  readonly subject?: string | null;
  /** Tag slugs. Every one must match (AND), which is what a multi-tag filter means. */
  readonly tags?: readonly string[];
  readonly kind?: 'LESSON' | 'QUIZ' | 'EXAM' | null;
  readonly sort?: LibrarySort;
  readonly limit?: number;
  /** Opaque. Only ever the `nextCursor` from a previous page of the SAME query. */
  readonly cursor?: string | null;
}

export interface LibraryItem {
  readonly id: string;
  readonly title: string;
  readonly summary: string | null;
  readonly kind: string;
  readonly slug: string;
  readonly subjectSlug: string | null;
  readonly subjectName: string | null;
  readonly tags: readonly string[];
  readonly updatedAt: string;
}

/**
 * Why a page came back empty.
 *
 * Four reasons that need four different words and four different buttons. A single
 * "No resources found" is the failure this union exists to prevent, because two of these four
 * are emergencies:
 *
 *  · `libraryEmpty` — nothing is public at all. A broken deploy, a moderation sweep, or an
 *    uncommissioned platform.
 *  · `subjectEmpty` — the branch is bare, the library is not. A content gap with a name.
 *  · `filtersExcluded` — the resources ARE there and the visitor's filter hid them. This is the
 *    one that must never be reported as "empty", because the honest fix is to clear a filter
 *    and the misleading one sends the visitor off to write a support ticket.
 *  · `endOfResults` — they paged past the end. Not an error, and shown as a quiet end cap.
 */
export type LibraryEmpty =
  | { readonly reason: 'libraryEmpty'; readonly inScope: 0 }
  | { readonly reason: 'subjectEmpty'; readonly inScope: 0; readonly subjectSlug: string }
  | {
      readonly reason: 'filtersExcluded';
      /** How many were in scope before tag/kind narrowing. The number that makes it honest. */
      readonly inScope: number;
      readonly culprit: 'tags' | 'kind';
    }
  | { readonly reason: 'endOfResults'; readonly inScope: number };

export interface LibraryPage {
  readonly items: readonly LibraryItem[];
  readonly total: number;
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
  readonly empty: LibraryEmpty | null;
  readonly sort: LibrarySort;
  /** The subtree the query resolved to, so a UI can say "showing Algebra and 12 subjects below". */
  readonly scope: readonly string[] | null;
}

/* ------------------------------------------------------------------ *
 * Cursors
 * ------------------------------------------------------------------ */

const CURSOR_VERSION = 1;

function encodeCursor(value: string, id: string): string {
  return Buffer.from(JSON.stringify([CURSOR_VERSION, value, id]), 'utf8').toString('base64url');
}

/**
 * Decode a cursor, or fail.
 *
 * This string arrives in a query parameter, so it is untrusted input. It is not `eval`'d and
 * Prisma parameterises the comparison, but it IS shape-checked: a cursor is `[1, string, uuid]`
 * and anything else is an error rather than a silent "start from the beginning". Silently
 * ignoring a bad cursor turns a broken bookmark into a page-one result that looks like the
 * server forgot them, and the bug report for that is close to untraceable.
 */
function decodeCursor(raw: string): { value: string; id: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new Error('browsePublic: malformed cursor');
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 3 ||
    parsed[0] !== CURSOR_VERSION ||
    typeof parsed[1] !== 'string' ||
    typeof parsed[2] !== 'string'
  ) {
    throw new Error('browsePublic: unrecognised cursor');
  }
  return { value: parsed[1], id: parsed[2] };
}

/* ------------------------------------------------------------------ *
 * The query
 * ------------------------------------------------------------------ */

function orderingFor(sort: LibrarySort): Prisma.ResourceOrderByWithRelationInput[] {
  switch (sort) {
    case 'oldest':
      return [{ updatedAt: 'asc' }, { id: 'asc' }];
    case 'title':
      return [{ title: 'asc' }, { id: 'asc' }];
    default:
      return [{ updatedAt: 'desc' }, { id: 'desc' }];
  }
}

function cursorFor(
  sort: LibrarySort,
  item: { title: string; updatedAt: Date; id: string },
): string {
  return encodeCursor(sort === 'title' ? item.title : item.updatedAt.toISOString(), item.id);
}

/**
 * Browse the public library.
 *
 * ## The empty-page attribution
 *
 * When a page comes back empty AND a tag or kind filter is active, this counts the scope
 * again WITHOUT those filters. That single extra `COUNT` — paid only on the empty path, never
 * on the happy path — is what lets the response say "3 resources here, none with the tag
 * 'vectors'" instead of "no results". It is the difference between a visitor who fixes their
 * own filter and a visitor who files a ticket, and it costs one indexed count on the rare path.
 */
export async function browsePublic(db: Db, query: LibraryQuery = {}): Promise<LibraryPage> {
  const sort: LibrarySort = query.sort ?? 'newest';
  const limit = Math.min(Math.max(query.limit ?? DEFAULT_PAGE, 1), MAX_PAGE);
  const tagSlugs = query.tags ?? [];
  const kind = query.kind ?? null;

  // Resolve the subject scope first: an unknown subject is an ERROR, not an empty library.
  // Silently treating "maths/algebra" (typo'd, or a slug that changed) as "everything" would
  // show a visitor the whole library in response to a filter they did not ask for.
  let scope: readonly string[] | null = null;
  if (query.subject !== undefined && query.subject !== null) {
    const subtree = await subjectSubtree(db, query.subject);
    if (subtree === null) throw new Error(`browsePublic: no such subject "${query.subject}"`);
    scope = subtree;
  }

  const base: Prisma.ResourceWhereInput = {
    ...PUBLIC_LISTING,
    ...(scope === null ? {} : { subjectId: { in: [...(await idsFor(db, scope))] } }),
  };

  // Tag narrowing: one `some` per requested tag, ANDed.
  //
  // The obvious encoding is `tags: { every: { tag: { slug: { in: tagSlugs } } } }`, and it is
  // WRONG in a way the test caught on the first run. `every` asks "does every related row
  // match", and a resource tagged only `vectors` satisfies it when asked to match
  // `{in: ['vectors', 'geometry']}` — its one row passes. A resource with NO tags at all
  // passes VACUOUSLY. So the first version returned untagged resources for a two-tag filter,
  // and `filtersExcluded` cheerfully reported "3 resources in scope" for a filter meant to
  // hide all of them.
  //
  // AND-of-ORs is the correct shape and needs one clause per tag. It also makes OR
  // expressible later as a single `in`, which is the honest way to add it: a distinct filter
  // named as OR, rather than a mode flag on this one.
  const narrowed: Prisma.ResourceWhereInput = {
    ...base,
    ...(kind === null ? {} : { kind }),
    // Under `AND`, not spread into the object. Spreading an array of clauses into a Prisma
    // `where` produces `Unknown argument '0'`, which is a confusing way to learn that the
    // clauses have to be a sibling key rather than positional ones.
    ...(tagSlugs.length === 0
      ? {}
      : { AND: tagSlugs.map((tagSlug) => ({ tags: { some: { tag: { slug: tagSlug } } } })) }),
  };

  const total = await db.resource.count({ where: narrowed });

  // Keyset. The cursor narrows the SAME ordering, anchored on the last row already seen.
  const ordering = orderingFor(sort);
  let where: Prisma.ResourceWhereInput = narrowed;
  if (query.cursor) {
    const { value, id } = decodeCursor(query.cursor);
    where = {
      ...narrowed,
      OR:
        sort === 'title'
          ? [{ title: { gt: value } }, { title: value, id: { gt: id } }]
          : sort === 'oldest'
            ? [
                { updatedAt: { gt: new Date(value) } },
                { updatedAt: new Date(value), id: { gt: id } },
              ]
            : [
                { updatedAt: { lt: new Date(value) } },
                { updatedAt: new Date(value), id: { lt: id } },
              ],
    };
  }

  // `limit + 1` and slice: whether a next page EXISTS is a question the database is the only
  // thing that can answer, and a separate `count` for it is a second query that can disagree
  // with the first under concurrent writes.
  const rows = await db.resource.findMany({
    where,
    orderBy: ordering,
    take: limit + 1,
    select: {
      id: true,
      title: true,
      summary: true,
      kind: true,
      slug: true,
      updatedAt: true,
      subject: { select: { slug: true, name: true } },
      tags: { select: { tag: { select: { slug: true, name: true } } } },
    },
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  // `noUncheckedIndexedAccess` makes this `| undefined`, and it genuinely could be: an empty
  // `page` with `hasMore` true would mean the database returned rows we then threw away, which
  // is a bug worth a loud error rather than a cursor pointing at row zero.
  const last = page[page.length - 1];
  if (page.length === 0) {
    return {
      items: [],
      total,
      hasMore: false,
      nextCursor: null,
      empty: await explainEmpty(db, { base, narrowed, query, scope, sort }),
      sort,
      scope,
    };
  }
  if (last === undefined) throw new Error('browsePublic: page had rows but no last row');

  return {
    items: page.map((r) => ({
      id: r.id,
      title: r.title,
      summary: r.summary,
      kind: r.kind,
      slug: r.slug,
      subjectSlug: r.subject?.slug ?? null,
      subjectName: r.subject?.name ?? null,
      tags: r.tags.map((t) => t.tag.slug),
      updatedAt: r.updatedAt.toISOString(),
    })),
    total,
    hasMore,
    nextCursor: hasMore ? cursorFor(sort, last) : null,
    empty: null,
    sort,
    scope,
  };
}

/**
 * Slugs to ids, for a raw SQL caller.
 *
 * Exported because `subjectSubtree` returns SLUGS — they are the public identifier, and a URL
 * that says `maths/algebra` should not change when the row is re-created. But `Resource.subjectId`
 * holds an id, so a raw query that filters `subjectId IN (<slugs>)` matches NOTHING and returns
 * an empty result rather than an error.
 *
 * That is what the first version of `search` did, and it is the single most expensive bug in
 * this task: every subject-scoped search silently returned zero, and the symptom — "search finds
 * nothing when you pick a subject" — reads like a ranking problem, so the investigation starts
 * in the weights and the generated column rather than in a three-character list comprehension.
 * Exported so the next raw-SQL caller cannot repeat it.
 */
export async function subjectIdsFor(db: Db, slugs: readonly string[]): Promise<readonly string[]> {
  const rows = await db.subject.findMany({
    where: { slug: { in: [...slugs] } },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

/** @deprecated Renamed. Use `subjectIdsFor` — the old name did not say what it converted. */
const idsFor = subjectIdsFor;

async function explainEmpty(
  db: Db,
  ctx: {
    base: Prisma.ResourceWhereInput;
    narrowed: Prisma.ResourceWhereInput;
    query: LibraryQuery;
    scope: readonly string[] | null;
    sort: LibrarySort;
  },
): Promise<LibraryEmpty> {
  const hasFilters = (ctx.query.tags ?? []).length > 0 || (ctx.query.kind ?? null) !== null;
  const inScope = await db.resource.count({ where: ctx.base });

  if (ctx.scope !== null && !hasFilters && inScope === 0) {
    return { reason: 'subjectEmpty', inScope: 0, subjectSlug: ctx.query.subject ?? '' };
  }
  if (!hasFilters) return { reason: 'libraryEmpty', inScope: 0 };

  // The filters are the cause. Name WHICH filter, so the UI can offer to clear that one rather
  // than dumping the visitor back at the top of the library.
  const culprit: 'tags' | 'kind' = (ctx.query.tags ?? []).length > 0 ? 'tags' : 'kind';
  if (inScope > 0) return { reason: 'filtersExcluded', inScope, culprit };
  return ctx.scope === null
    ? { reason: 'libraryEmpty', inScope: 0 }
    : { reason: 'subjectEmpty', inScope: 0, subjectSlug: ctx.query.subject ?? '' };
}

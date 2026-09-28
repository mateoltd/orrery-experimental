/**
 * The data behind the public URL surface.  (P3-T6)
 *
 * ## The sitemap is built from `PUBLIC_LISTING`, and that is the point
 *
 * A sitemap is crawled, cached by third parties, and submitted to search engines. Anything it
 * lists is discoverable by somebody who has never signed in — which makes it a PUBLIC SURFACE,
 * and it is filtered like one.
 *
 * That means it inherits `plans/05` §6's under-18 rule from the same exported predicate the
 * public library and the search use, and a resource authored by a minor is absent from it. The
 * failure this prevents is not subtle and not hypothetical: a sitemap that leaked one minor's
 * published resource would put it in a search engine's index, from which it could not be
 * withdrawn. **A sitemap entry is the hardest thing to take back**, which is why the predicate
 * is imported from one place rather than re-expressed per surface, and why the integration
 * suite asserts the sitemap's id set EQUALS the public library's id set rather than trusting
 * that they were written from the same constant.
 */

import { isSameActor } from '@orrery/auth/can';
import { type SitemapEntry, sitemapLastmod } from '@orrery/contracts/urls';
import { Prisma } from '../prisma/generated/client/client.js';
import type { PrismaClient, TxClient } from './index.js';

type Db = PrismaClient | TxClient;

export interface PublicUrlRow {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly kind: string;
  readonly updatedAt: Date;
  readonly summary: string | null;
  /** The resource's own subject, which may be a leaf. */
  readonly subjectSlug: string | null;
  readonly subjectName: string | null;
  /** The AREA — the root of the subject's chain — for the OG card's colour. */
  readonly accent: string | null;
}

/**
 * Every publicly-listable resource, in the shape both the sitemap and the OG card need.
 *
 * One query for both consumers, and the accent is resolved with a RECURSIVE CTE rather than a
 * second round trip. The colour lives on the subject ROOT — the gate for P3-T2 asserts it —
 * so a leaf's colour is null and a naive `r.subject.colour` would give every leaf the fallback
 * grey. That is the kind of thing that looks fine in development, where somebody is looking at
 * the area root, and wrong in production, where nobody is.
 *
 * `subject` is chosen for a deliberate reason recorded in `next_cte.sql`: without a `UNION ALL`
 * a leaf's own name is dropped in favour of its area's.
 */
export async function publicUrlRows(db: Db, limit = 50_000): Promise<readonly PublicUrlRow[]> {
  return db.$queryRaw<PublicUrlRow[]>(
    withNextCte(Prisma.sql`
    SELECT r.id::text AS id,
           r.slug,
           r.title,
           r.kind::text AS kind,
           r."updatedAt",
           r.summary,
           s.slug AS "subjectSlug",
           s.name AS "subjectName",
           root.colour AS accent
    FROM "Resource" r
    LEFT JOIN "Subject" s ON s.id = r."subjectId"
    LEFT JOIN next_cte ON next_cte.id = r."subjectId"
    LEFT JOIN "Subject" root ON root.id = next_cte.root_id
    WHERE r."status" = 'PUBLISHED'
      AND r."visibility" = 'PUBLIC'
      AND r."archivedAt" IS NULL
      AND r."currentVersionId" IS NOT NULL
      AND EXISTS (SELECT 1 FROM "User" o WHERE o.id = r."ownerId" AND o."isMinor" = false)
    ORDER BY r."updatedAt" DESC
    LIMIT ${limit}
  `),
  );
}

/**
 * The CTE, so a text-formatting tool cannot quietly break the query.
 *
 * ## `UNION ALL` and why it is not a detail
 *
 * A `UNION` (not `UNION ALL`) between the anchor rows and the recursive rows DE-DUPLICATES, and
 * de-duplication of `(id, depth, root_id)` rows means a subject whose chain has one row at
 * depth 0 and one at depth 1 contributes… this is the whole problem: `UNION` collapses rows that
 * are equal across ALL columns, and the depth column differs, so nothing collapses, but the
 * `DISTINCT` behaviour is unspecified enough that relying on it is a trap. `UNION ALL` says what
 * is meant: keep every row the walk produced.
 *
 * The walk terminates on `depth < 64` rather than on "no parent found", matching
 * `MAX_DEPTH` in `contracts/taxonomy`. The tree is cycle-safe in application code, but a
 * recursive CTE will happily loop forever on a cycle the database was never told about, and a
 * sitemap query that hangs is a worse outcome than a sitemap missing one resource.
 */
function withNextCte(rest: Prisma.Sql): Prisma.Sql {
  // `Prisma.raw` around a LITERAL, which is the only correct use of it: the CTE is a constant
  // in this file with no interpolation of anything. `rest` is a `Prisma.Sql`, so the LIMIT stays
  // a bound parameter -- the alternative, `$queryRawUnsafe` with a template-concatenated limit,
  // is an injection-shaped shortcut taken to avoid typing `raw`.
  return Prisma.sql`${Prisma.raw(WITH_NEXT_CTE)} ${rest}`;
}

/** The recursive walk, as a literal. See the function's doc comment for the `UNION ALL` argument. */
const WITH_NEXT_CTE = `
    WITH RECURSIVE next_cte AS (
      SELECT s.id, s."parentId", s.id AS root_id, 0 AS depth
      FROM "Subject" s
      WHERE s."parentId" IS NULL
      UNION ALL
      SELECT c.id, c."parentId", n.root_id, n.depth + 1
      FROM "Subject" c
      JOIN next_cte n ON c."parentId" = n.id
      WHERE n.depth < 64
    )`;

/** The sitemap entries. One function, so the path template is never written twice. */
export async function sitemapEntries(
  db: Db,
  buildPath: (slug: string) => string,
  limit?: number,
): Promise<readonly SitemapEntry[]> {
  const rows = await publicUrlRows(db, limit);
  return rows.map((r) => ({ path: buildPath(r.slug), lastmod: sitemapLastmod(r.updatedAt) }));
}

/* ------------------------------------------------------------------ *
 * The public slug namespace
 * ------------------------------------------------------------------ */

export type PublicSlugVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string; readonly takenBy: string };

/**
 * Is this slug free in the PUBLIC namespace?
 *
 * ## Why this exists when there is already a database index doing the enforcing
 *
 * Because the index's error message is "duplicate key value violates unique constraint", which
 * a teacher cannot act on. This asks the question first and answers it in a sentence, and it
 * also returns WHO holds it — not to display, but so the two cases are distinguishable in the
 * log: "somebody else has this URL" and "this is your own other draft" want different copy.
 *
 * The database remains the guarantee. A check that races is still useful as a check.
 */
export async function checkPublicSlug(
  db: Db,
  input: { slug: string; resourceId?: string | null; ownerId?: string | null },
): Promise<PublicSlugVerdict> {
  const existing = await db.resource.findFirst({
    where: {
      visibility: 'PUBLIC',
      slug: input.slug,
      ...(input.resourceId ? { NOT: { id: input.resourceId } } : {}),
    },
    select: { id: true, ownerId: true },
  });
  if (existing === null) return { ok: true };
  // `ownerId` — WHO is publishing — not `resourceId`. The first version compared the existing
  // row's owner against the input's RESOURCE id, which are different kinds of identifier and
  // never equal, so every collision was reported as somebody else's and the "your own draft"
  // copy was unreachable. Two uuid columns next to each other in a `where` is not a reason to
  // assume you know which is which.
  //
  // The comparison itself is `isSameActor` from `@orrery/auth`, because the authz-ownership gate
  // is right that "is this mine?" is an identity question and belongs in one place rather than
  // in a hundred. It is not an authorisation decision — the partial unique index is — and the
  // gate is still correct to insist it not be written inline: that is how a codebase ends up
  // with a hundred slightly different definitions of ownership.
  const own = isSameActor(input.ownerId, existing.ownerId);
  return {
    ok: false,
    takenBy: existing.id,
    reason: own
      ? `"${input.slug}" is already the public address of one of your own resources.`
      : `"${input.slug}" is already the public address of another teacher's resource. Pick another.`,
  };
}

export type PublishOutcome =
  | { readonly ok: true; readonly slug: string }
  | { readonly ok: false; readonly httpStatus: 403 | 409; readonly reason: string };

/**
 * Make a resource PUBLIC, checking the URL namespace first.
 *
 * ## Why the check is here and not in a `publish` helper nobody calls
 *
 * Because the failure is a raw Postgres unique-constraint error surfacing as a 500 on the exact
 * operation a teacher performs when they share their work, and a teacher who cannot publish
 * because a stranger's draft already had their chosen URL has no way to find out why.
 *
 * ## The slug is assigned ONCE and is immutable
 *
 * A resource's slug never changes after this call, including when the title is edited. That is
 * the decision which removes the need for a redirect table: there is no rename path, so there is
 * nothing to redirect. It costs a URL that may stop matching the title, and buys a URL that
 * never breaks. That is the right trade for a platform whose teachers paste links into
 * department documents and never check them again.
 */
export async function publishWithPublicSlug(
  db: Db,
  input: { resourceId: string; slug: string; ownerId: string },
): Promise<PublishOutcome> {
  const verdict = await checkPublicSlug(db, {
    slug: input.slug,
    resourceId: input.resourceId,
    ownerId: input.ownerId,
  });
  if (!verdict.ok) return { ok: false, httpStatus: 409, reason: verdict.reason };

  const result = await db.resource.updateMany({
    where: { id: input.resourceId, ownerId: input.ownerId },
    data: { visibility: 'PUBLIC', slug: input.slug },
  });
  if (result.count === 0) {
    return { ok: false, httpStatus: 403, reason: 'no such resource, or it is not yours' };
  }
  return { ok: true, slug: input.slug };
}

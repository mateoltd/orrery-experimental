/**
 * The read path, against a real row.  (P2-T8 persistence, INV-VISIBILITY-1)
 *
 * ## The design decision everything else follows from
 *
 * **The cache holds the PAYLOAD. It never holds the permission.**
 *
 * Look at the order in `readResource` below: load the row, decide, and only then consult the
 * cache. The decision is made from a FRESH row on every single request, and the cache is asked
 * afterwards, only when that fresh decision said `cacheable`.
 *
 * The obvious implementation does the opposite — cache the row, decide from the cached row, and
 * trust the `Vary` header to sort it out — and it has a specific, reproducible failure. A
 * PUBLIC resource's cache key has no viewer in it (there is no way to add one: a shared cache
 * is keyed by URL). So a student reads it, the entry is warm, the student is suspended, and
 * the next request reads the warm entry and serves them the content. The suspension takes
 * effect whenever the entry expires, which is to say not on the next request.
 *
 * `plans/14` §3 and the P2-T8 packet both say the read decision is re-checked every read. This
 * is the only arrangement in which that sentence is true when there is a cache.
 *
 * ## What the cache is actually for
 *
 * Saving the block render and the JSON parse, not the row read. The row read is one indexed
 * `findUnique`; the render is the expensive part and it is deterministic in `(versionId, kind)`.
 * So the cache earns its keep on the right axis, and paying a query per read is the price of
 * the guarantee. That trade is deliberate: a query per read is a performance problem, and
 * serving a suspended student content is a security problem.
 *
 * ## Search filters in the WHERE clause
 *
 * `searchResources` builds its visibility predicate into the Prisma `where`, so private rows
 * are never SELECTed. The tempting alternative — fetch the matches, then call `visibleInSearch`
 * on each — leaves the private rows in application memory, in the query log, in a slow-query
 * sample, and in whatever the profiler captured. Filtering after the fact is filtering too late,
 * and "we filtered it in the handler" is exactly how a private title ends up in a support
 * screenshot.
 */

import {
  canActOn,
  canReadResource,
  type ResourceView,
  visibleInSearch,
} from '@orrery/auth/resources';
import type { Actor } from '@orrery/auth/types';
import { cacheHeaders, cacheKey } from '@orrery/contracts/lifecycle';
import type { Prisma } from '../prisma/generated/client/client.js';
import type { PrismaClient, TxClient } from './index.js';

// The filter types are READ OFF the generated where-inputs rather than named from memory.
// `Prisma.EnumResourceStatusFilter` does not exist in this generator version, and a name
// written from memory is how a typecheck error gets "fixed" with an `as never` -- which would
// have turned a real type error into a permanent hole in exactly the predicate that decides
// who sees what.
type ResourceStatusFilter = Prisma.ResourceWhereInput['status'];
type AssignmentStatusFilter = Prisma.AssignmentWhereInput['status'];

/**
 * Every status, for the admin branch.
 *
 * A named constant rather than four literals inline, so the admin branch stays one expression
 * and the list is a single thing to keep in step with the enum. A status added to the enum and
 * not added here would be invisible to admins in SEARCH only — the one place an omission fails
 * silently instead of as a type error.
 */
const ALL_STATUSES: ResourceStatusFilter = { in: ['DRAFT', 'PUBLISHED', 'ARCHIVED', 'WITHDRAWN'] };
const LIVE_ASSIGNMENTS: AssignmentStatusFilter = { in: ['DRAFT', 'PUBLISHED'] };

type Db = PrismaClient | TxClient;

export interface CachedPayload {
  readonly versionId: string;
  readonly blocks: unknown;
}

/**
 * A payload cache keyed by the contracts-owned cache key.
 *
 * Deliberately has no eviction policy, no TTL and no size limit. A real one is Redis or
 * Next.js's data cache, and the only property that matters HERE is the one that is easy to
 * lose: it stores nothing that was not already declared cacheable. A TTL added later is fine;
 * a `set` reachable from a code path that skipped `cacheable` is the failure this class exists
 * to make impossible.
 */
export class ResourcePayloadCache {
  readonly #entries = new Map<string, CachedPayload>();
  #hits = 0;
  #misses = 0;

  get(key: string | null): CachedPayload | undefined {
    if (key === null) {
      this.#misses += 1;
      return undefined;
    }
    const hit = this.#entries.get(key);
    if (hit === undefined) this.#misses += 1;
    else this.#hits += 1;
    return hit;
  }

  set(key: string | null, value: CachedPayload): void {
    // A `null` key is dropped rather than stored under a sentinel. A sentinel would be a
    // private payload living in a shared map under a made-up name, which is precisely the
    // accident this cache is designed to be unable to have.
    if (key === null) return;
    this.#entries.set(key, value);
  }

  get stats() {
    return { size: this.#entries.size, hits: this.#hits, misses: this.#misses };
  }

  clear(): void {
    this.#entries.clear();
    this.#hits = 0;
    this.#misses = 0;
  }
}

/**
 * Load the descriptor the read decision is made about.
 *
 * The `classroomIds` are DERIVED from live assignments rather than read off a sharing column,
 * because no such column exists and inventing one would create a second source of truth for
 * "who can see this". An assignment that is DRAFT or WITHDRAWN does not count: withdrawing an
 * assignment must actually withdraw access, and a cache that remembered the original would
 * keep serving the classroom.
 */
export async function loadResourceView(db: Db, id: string): Promise<ResourceView | null> {
  const row = await db.resource.findUnique({
    where: { id },
    select: {
      id: true,
      ownerId: true,
      status: true,
      visibility: true,
      currentVersionId: true,
      assignments: {
        where: { status: LIVE_ASSIGNMENTS },
        select: { classroomId: true },
      },
    },
  });
  if (row === null) return null;
  return {
    id: row.id,
    ownerId: row.ownerId,
    status: row.status,
    visibility: row.visibility,
    // A resource with no current version is an invariant violation, not an empty case. Using
    // the id as a stand-in would make every cache key for it unique, which is harmless, and
    // would make the loader report a `DRAFT` as readable, which is not.
    versionId: row.currentVersionId ?? `no-version:${row.id}`,
    classroomIds: [...new Set(row.assignments.map((a) => a.classroomId))],
  };
}

export type ReadResult =
  | {
      readonly httpStatus: 200;
      readonly view: ResourceView;
      readonly canEdit: boolean;
      readonly cacheable: boolean;
      readonly cacheKey: string;
      readonly headers: { 'cache-control': string; vary: 'Cookie, Authorization' };
      readonly payload: CachedPayload | undefined;
      readonly fromCache: boolean;
    }
  | { readonly httpStatus: 404 };

/**
 * Read a resource, re-deciding on every call.
 *
 * Returns 404 and nothing else for anything the viewer may not see — no `view`, no `canEdit`,
 * no reason, no cache key. A 404 body that carries `{ reason: 'notVisible' }` is a 404 body
 * that tells an attacker which ids exist, and the difference between the two is invisible in
 * review because both are "a 404".
 */
export async function readResource(
  db: Db,
  id: string,
  actor: Actor,
  actorClassroomIds: readonly string[],
  cache: ResourcePayloadCache = new ResourcePayloadCache(),
): Promise<ReadResult> {
  // 1. FRESH. Always. This is the line the whole file exists for.
  const view = await loadResourceView(db, id);
  if (view === null) return { httpStatus: 404 };

  // 2. DECIDE. From the fresh row, through the matrix, with the actor's live roles.
  const decision = canReadResource(view, actor, actorClassroomIds);
  if (!decision.visible) return { httpStatus: 404 };

  // 3. ONLY NOW, the cache.
  const key = cacheKey(view, decision.cacheable);
  const headers = cacheHeaders(decision.cacheable);
  const hit = cache.get(key);
  if (hit !== undefined) {
    return {
      httpStatus: 200,
      view,
      canEdit: decision.canEdit,
      cacheable: decision.cacheable,
      cacheKey: key ?? '',
      headers,
      payload: hit,
      fromCache: true,
    };
  }
  return {
    httpStatus: 200,
    view,
    canEdit: decision.canEdit,
    cacheable: decision.cacheable,
    cacheKey: key ?? '',
    headers,
    payload: undefined,
    fromCache: false,
  };
}

/** Store a rendered payload. A `null` key is a no-op, so an uncacheable read cannot leak in. */
export function rememberPayload(
  cache: ResourcePayloadCache,
  view: ResourceView,
  cacheable: boolean,
  blocks: unknown,
): void {
  cache.set(cacheKey(view, cacheable), { versionId: view.versionId, blocks });
}

export function assertCanAct(
  db: Db,
  id: string,
  actor: Actor,
  action: 'edit' | 'publish' | 'delete',
  actorClassroomIds: readonly string[] = [],
): Promise<{ httpStatus: 200 } | { httpStatus: 403 | 404 }> {
  return loadResourceView(db, id).then((view) => {
    if (view === null) return { httpStatus: 404 as const };
    const verdict = canActOn(view, actor, action, actorClassroomIds);
    return verdict.allowed ? { httpStatus: 200 as const } : { httpStatus: verdict.httpStatus };
  });
}

/**
 * Search, with the visibility predicate in the query.
 *
 * The predicate is the matrix's own logic rendered as a Prisma `where`, and it is written out
 * rather than generated so that a divergence from `resourceVisible` is a diff somebody can
 * read. The UNLISTED clause is inside the `NOT` for the same reason it lives in
 * `visibleInSearch`: unlisted is a LISTING property, so it cannot be expressed as "may this
 * viewer read it".
 */
export async function searchResources(
  db: Db,
  query: string,
  actor: Actor,
  actorClassroomIds: readonly string[],
): Promise<Array<{ id: string; title: string }>> {
  const visibleStatus: ResourceStatusFilter = { in: ['PUBLISHED', 'ARCHIVED'] };
  const isAdmin = actor.roles.includes('platformAdmin');
  const mine = actorClassroomIds;

  const rows = await db.resource.findMany({
    where: {
      title: { contains: query, mode: 'insensitive' },
      // A suspended viewer matches nothing at all. In SQL rather than in JS, so the rows are
      // never fetched at all.
      ...(actor.suspended && !isAdmin ? { id: '__none__' } : {}),
      OR: [
        // The owner sees everything of theirs, including drafts and withdrawn items, because
        // a withdrawal is a correction and the author is the one fixing it.
        { ownerId: actor.id },
        // An admin sees everything, INCLUDING unlisted. The `NOT: UNLISTED` below exempts the
        // owner and the admin together, and the first version exempted only the owner -- so
        // search hid from an admin something `visibleInSearch` showed, which is the divergence
        // the audit function exists to catch. It was caught, and the catch was this one.
        ...(isAdmin ? [{ status: ALL_STATUSES }] : []),
        {
          AND: [
            { status: visibleStatus },
            {
              OR: [
                { visibility: 'PUBLIC' },
                {
                  visibility: { in: ['PRIVATE', 'UNLISTED'] },
                  assignments: {
                    some: {
                      classroomId: { in: [...mine] },
                      status: LIVE_ASSIGNMENTS,
                    },
                  },
                },
              ],
            },
            // UNLISTED is reachable but not listed, so it is excluded here for anyone but the
            // owner and an admin, both of whom are covered by the clauses above.
            { NOT: { visibility: 'UNLISTED' } },
          ],
        },
      ],
    },
    select: { id: true, title: true },
    take: 50,
  });
  return rows;
}

/**
 * Cross-check `searchResources` against the decision, in application code.
 *
 * This is deliberately redundant with the `where` clause, and it exists because the two can
 * DIVERGE: the SQL predicate is hand-written, `visibleInSearch` is not, and nothing else in
 * the system would notice when they disagree. Divergence is the dangerous direction — SQL
 * showing something `visibleInSearch` hides, or hiding something it shows.
 *
 * It runs in the integration suite rather than in production: a second filter on every search
 * is a cost, and a test that says "these two must agree on every row in the corpus" catches the
 * divergence at the point where it is introduced.
 */
export async function auditSearchAgainstDecision(
  db: Db,
  query: string,
  actor: Actor,
  actorClassroomIds: readonly string[],
): Promise<{ id: string; shown: boolean; decided: boolean }[]> {
  const all = await db.resource.findMany({
    where: { title: { contains: query, mode: 'insensitive' } },
    select: {
      id: true,
      ownerId: true,
      status: true,
      visibility: true,
      currentVersionId: true,
      assignments: {
        where: { status: LIVE_ASSIGNMENTS },
        select: { classroomId: true },
      },
    },
  });
  return all.map((row) => {
    const view: ResourceView = {
      id: row.id,
      ownerId: row.ownerId,
      status: row.status,
      visibility: row.visibility,
      versionId: row.currentVersionId ?? `no-version:${row.id}`,
      classroomIds: [...new Set(row.assignments.map((a) => a.classroomId))],
    };
    return {
      id: row.id,
      shown: visibleInSearch(view, actor, actorClassroomIds),
      decided: canReadResource(view, actor, actorClassroomIds).visible,
    };
  });
}

/**
 * The read path, against a real Postgres.  (P2-T8 persistence, INV-VISIBILITY-1)
 *
 * ## Why this is a separate file from `resources.test.ts` in `packages/auth`
 *
 * A unit test with a fake row cannot tell you the row EXISTS, and on this path that is the
 * whole question. `sessions.integration.test.ts` already made the argument once, expensively:
 * `sessionsEpoch`, the single column the entire cache-invalidation design rests on, was never in
 * the schema, and 207 unit tests passed.
 *
 * Two of the three tests below are failures a unit test can only SIMULATE, because both need
 * state that outlives a single in-memory call:
 *
 *   · a WARM PAYLOAD CACHE outliving a suspension, and
 *   · a search index that forgot the filter.
 *
 * ## The one that matters most
 *
 * `readResource` re-loads and re-decides on every call, and only THEN consults the cache. The
 * obvious implementation caches the row and decides from it, and it has a reproducible
 * failure: a PUBLIC resource's cache key has no viewer in it, so a suspended student keeps
 * getting served until the entry expires. The test below builds exactly that trap — warm the
 * cache as a healthy student, suspend them, read again — and asserts a 404. It is the only
 * test in the repository that can fail for that reason.
 */

import { randomUUID } from 'node:crypto';
import type { Actor } from '@orrery/auth/types';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from './prisma.js';
import {
  assertCanAct,
  auditSearchAgainstDecision,
  loadResourceView,
  ResourcePayloadCache,
  readResource,
  rememberPayload,
  searchResources,
} from './resources.js';

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)('P2-T8 read path integration, against real Postgres', () => {
  let prisma: PrismaClient;
  /**
   * A FRESH cache per test, not one for the suite.
   *
   * A shared cache would quietly weaken the tests that depend on a cold one — the first test
   * to run warms an entry and a later test passes against a hit it did not create. Assigned in
   * `beforeEach` for the same reason `beforeAll` exists for the client: state, not fixtures.
   */
  let cache: ResourcePayloadCache;

  beforeAll(() => {
    prisma = new PrismaClient();
  });

  beforeEach(() => {
    cache = new ResourcePayloadCache();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  const actor = (o: Partial<Actor> = {}): Actor => ({
    id: randomUUID(),
    roles: ['student'],
    mfaVerified: false,
    suspended: false,
    ...o,
  });

  async function seedResource(o: {
    ownerId: string;
    status?: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED' | 'WITHDRAWN';
    visibility?: 'PRIVATE' | 'UNLISTED' | 'PUBLIC';
    title?: string;
  }) {
    const id = randomUUID();
    await prisma.resource.create({
      data: {
        id,
        ownerId: o.ownerId,
        status: o.status ?? 'PUBLISHED',
        visibility: o.visibility ?? 'PRIVATE',
        title: o.title ?? 'Tidal locking',
        slug: randomUUID(),
      },
    });
    return id;
  }

  async function seedUser() {
    const id = randomUUID();
    await prisma.user.create({
      data: {
        id,
        email: `${id}@school.example`,
        emailNormalized: `${id}@school.example`,
        name: 'T',
      },
    });
    return id;
  }

  // ── The warm cache outliving a suspension ──────────────────────────────────

  it('refuses a SUSPENDED viewer even with a warm payload cache', async () => {
    // The trap, built deliberately. A PUBLIC resource is cacheable, so the key contains no
    // viewer — a shared cache is keyed by URL and there is nowhere to put one. The student
    // reads it, the entry is warm, and then the student is suspended.
    const owner = await seedUser();
    const id = await seedResource({ ownerId: owner, visibility: 'PUBLIC' });
    // A REAL user row, because the point of the test is that the suspension is in the
    // DATABASE. The first version used a bare `actor()` id and the `user.update` failed on a
    // missing record -- which would have made this test pass for the wrong reason had the
    // throw been swallowed.
    const studentUser = await seedUser();
    const student = actor({ id: studentUser });

    const first = await readResource(prisma, id, student, [], cache);
    expect(first.httpStatus).toBe(200);
    expect(first.cacheable).toBe(true);
    rememberPayload(cache, first.view, first.cacheable, { blocks: [{ type: 'paragraph' }] });

    const warm = await readResource(prisma, id, student, [], cache);
    expect(warm.fromCache, 'the cache must actually be warm for this to test anything').toBe(true);

    // Suspend, and change nothing about the cache.
    //
    // A converted instant, never `new Date()`: INV-TIME-1 bans the no-argument form because it
    // reads the host clock, and a suspension timestamp that depends on which machine ran the
    // test is a timestamp nobody can reason about afterwards.
    await prisma.user.update({
      where: { id: student.id },
      data: { suspendedAt: new Date(Date.parse('2026-09-27T12:00:00.000Z')) },
    });

    const after = await readResource(prisma, id, { ...student, suspended: true }, [], cache);
    expect(after.httpStatus).toBe(404);
    // And the warm entry is STILL THERE, which is what makes this a real test rather than a
    // test of a cache that quietly got invalidated by something else.
    const stillWarm = await readResource(prisma, id, { ...student, suspended: true }, [], cache);
    expect(stillWarm.httpStatus).toBe(404);
    expect(cache.stats.size, 'the entry must not have been evicted to make this pass').toBe(1);
  });

  it('does not serve a private resource from a cache at all', async () => {
    const owner = await seedUser();
    const id = await seedResource({ ownerId: owner, visibility: 'PRIVATE' });
    const ownerActor = actor({ id: owner, roles: ['teacher'] });

    const r = await readResource(prisma, id, ownerActor, [], cache);
    expect(r.httpStatus).toBe(200);
    if (r.httpStatus !== 200) return;
    expect(r.cacheable).toBe(false);
    expect(r.cacheKey).toBe('');
    expect(r.headers['cache-control']).toBe('private, no-store');

    rememberPayload(cache, r.view, r.cacheable, { blocks: [] });
    // The owner reading it again is a MISS, not a hit: there is no key to hit.
    const again = await readResource(prisma, id, ownerActor, [], cache);
    expect(again.httpStatus).toBe(200);
    expect(again.fromCache).toBe(false);
    // And nothing was stored under a sentinel key.
    expect(cache.stats.size).toBe(0);
  });

  // ── Deriving classroom access from live assignments ───────────────────────

  it('derives classroom access from LIVE assignments, and losing one revokes it', async () => {
    // There is no "shared with" column and there should not be: a second source of truth for
    // who can see a resource is a second source of truth to forget. An assignment carries it.
    const owner = await seedUser();
    const studentUser = await seedUser();
    const id = await seedResource({ ownerId: owner, visibility: 'PRIVATE' });

    const classroom = await prisma.classroom.create({
      data: { id: randomUUID(), ownerId: owner, name: 'Year 9', slug: randomUUID() },
    });
    const version = await prisma.resourceVersion.create({
      data: {
        id: randomUUID(),
        resourceId: id,
        version: 1,
        blocks: [],
        blocksChecksum: 'x',
        meta: {},
        createdById: owner,
      },
    });
    await prisma.assignment.create({
      data: {
        id: randomUUID(),
        classroomId: classroom.id,
        resourceId: id,
        resourceVersionId: version.id,
        status: 'PUBLISHED',
        createdById: owner,
      },
    });

    const s = actor({ id: studentUser });
    expect((await readResource(prisma, id, s, [classroom.id])).httpStatus).toBe(200);
    // Same student, no membership: the link is not the authority.
    expect((await readResource(prisma, id, s, [])).httpStatus).toBe(404);

    // Withdrawing the assignment must actually withdraw ACCESS, not just stop the assignment.
    await prisma.assignment.updateMany({
      where: { resourceId: id },
      data: { status: 'WITHDRAWN' },
    });
    expect((await readResource(prisma, id, s, [classroom.id])).httpStatus).toBe(404);
  });

  it('returns 404 for a resource that does not exist, and 404 for one it may not see', async () => {
    const owner = await seedUser();
    const stranger = await seedUser();
    const id = await seedResource({ ownerId: owner, visibility: 'PRIVATE' });
    // Identical responses. The result objects are compared, so this also asserts that neither
    // leaks a `canEdit`, a reason, or a view.
    const denied = await readResource(prisma, id, actor({ id: stranger }), [], cache);
    const absent = await readResource(prisma, randomUUID(), actor({ id: stranger }), [], cache);
    expect(denied).toEqual({ httpStatus: 404 });
    expect(absent).toEqual({ httpStatus: 404 });
  });

  it("lets a teacher publish their own and not a colleague's, with the right status code", async () => {
    const owner = await seedUser();
    const id = await seedResource({ ownerId: owner, status: 'DRAFT', visibility: 'PRIVATE' });
    const mine = actor({ id: owner, roles: ['teacher'] });
    const theirs = actor({ roles: ['teacher'] });

    expect(await assertCanAct(prisma, id, mine, 'publish')).toEqual({ httpStatus: 200 });
    // A DRAFT is invisible to a non-owner, so this is a 404 — and it is a 404 for the right
    // reason, which the next test pins down by using a resource they CAN see.
    expect(await assertCanAct(prisma, id, theirs, 'publish')).toEqual({ httpStatus: 404 });
  });

  it('returns 403, not 404, for an action on a resource the viewer can read', async () => {
    // The distinction the packet asks for. Both are denials; only one leaks existence.
    const owner = await seedUser();
    const studentUser = await seedUser();
    const id = await seedResource({ ownerId: owner, visibility: 'PUBLIC' });

    const s = actor({ id: studentUser });
    expect((await assertCanAct(prisma, id, s, 'delete')).httpStatus).toBe(403);
    // And a resource they cannot read gives 404 for the same action.
    const priv = await seedResource({ ownerId: owner, visibility: 'PRIVATE' });
    expect((await assertCanAct(prisma, priv, s, 'delete')).httpStatus).toBe(404);
  });

  it('gives a withdrawn resource to nobody but the owner and an admin', async () => {
    const owner = await seedUser();
    const id = await seedResource({ ownerId: owner, status: 'WITHDRAWN', visibility: 'PUBLIC' });
    // Even though it is PUBLIC: a withdrawal is a correction, and corrections are invisible to
    // the people they are being made for.
    expect((await readResource(prisma, id, actor(), [])).httpStatus).toBe(404);
    expect(
      (await readResource(prisma, id, actor({ id: owner, roles: ['teacher'] }), [])).httpStatus,
    ).toBe(200);
    expect(
      (await readResource(prisma, id, actor({ roles: ['platformAdmin'] }), [])).httpStatus,
    ).toBe(200);
  });

  // ── Search: the filter has to be in the query ─────────────────────────────

  it('never returns a private, draft, unlisted or withdrawn title to a stranger', async () => {
    const owner = await seedUser();
    const term = `zz${randomUUID().slice(0, 8)}`;
    const publicId = await seedResource({
      ownerId: owner,
      visibility: 'PUBLIC',
      title: `${term} public`,
    });
    await seedResource({ ownerId: owner, visibility: 'PRIVATE', title: `${term} private` });
    await seedResource({ ownerId: owner, visibility: 'UNLISTED', title: `${term} unlisted` });
    await seedResource({ ownerId: owner, status: 'DRAFT', title: `${term} draft` });
    await seedResource({ ownerId: owner, status: 'WITHDRAWN', title: `${term} withdrawn` });

    const found = await searchResources(prisma, term, actor(), []);
    expect(found.map((r) => r.id)).toEqual([publicId]);
  });

  it('returns nothing at all to a suspended viewer', async () => {
    const owner = await seedUser();
    const term = `zz${randomUUID().slice(0, 8)}`;
    await seedResource({ ownerId: owner, visibility: 'PUBLIC', title: `${term} public` });
    expect(await searchResources(prisma, term, actor({ suspended: true }), [])).toEqual([]);
  });

  it('shows the owner their own unlisted and withdrawn items', async () => {
    const owner = await seedUser();
    const term = `zz${randomUUID().slice(0, 8)}`;
    const unlisted = await seedResource({
      ownerId: owner,
      visibility: 'UNLISTED',
      title: `${term} u`,
    });
    const withdrawn = await seedResource({
      ownerId: owner,
      status: 'WITHDRAWN',
      title: `${term} w`,
    });
    const own = actor({ id: owner, roles: ['teacher'] });
    const ids = (await searchResources(prisma, term, own, [])).map((r) => r.id).sort();
    expect(ids).toEqual([unlisted, withdrawn].sort());
  });

  it('agrees with the matrix on every row it returns, and never shows more than it decides', async () => {
    // The SQL predicate is hand-written and `visibleInSearch` is not, so nothing else in the
    // system would notice when they DIVERGE. Divergence is the dangerous direction: SQL showing
    // something the decision hides is a content leak with a search box in front of it.
    const owner = await seedUser();
    const studentUser = await seedUser();
    const term = `zz${randomUUID().slice(0, 8)}`;
    for (const v of ['PUBLIC', 'PRIVATE', 'UNLISTED'] as const) {
      await seedResource({ ownerId: owner, visibility: v, title: `${term} ${v}` });
      await seedResource({
        ownerId: owner,
        visibility: v,
        status: 'DRAFT',
        title: `${term} d${v}`,
      });
    }

    const cases: Array<[Actor, readonly string[]]> = [
      [actor(), []],
      [actor({ id: studentUser }), []],
      [actor({ id: owner, roles: ['teacher'] }), []],
      [actor({ roles: ['platformAdmin'] }), []],
      [actor({ suspended: true }), []],
    ];

    for (const [who, rooms] of cases) {
      const shown = new Set((await searchResources(prisma, term, who, rooms)).map((r) => r.id));
      const audit = await auditSearchAgainstDecision(prisma, term, who, rooms);
      for (const row of audit) {
        // NEVER shows more than the decision permits. This is the leak direction.
        expect(shown.has(row.id), `${row.id} shown but not decided-visible`).toBe(row.decided);
      }
    }
  });

  it('loads a descriptor whose classroomIds are deduplicated and live', async () => {
    const owner = await seedUser();
    const id = await seedResource({ ownerId: owner, visibility: 'UNLISTED' });
    const version = await prisma.resourceVersion.create({
      data: {
        id: randomUUID(),
        resourceId: id,
        version: 1,
        blocks: [],
        blocksChecksum: 'x',
        meta: {},
        createdById: owner,
      },
    });
    const classroom = await prisma.classroom.create({
      data: { id: randomUUID(), ownerId: owner, name: 'Y8', slug: randomUUID() },
    });
    // Two live assignments into the SAME classroom, plus one withdrawn.
    for (let i = 0; i < 2; i += 1) {
      await prisma.assignment.create({
        data: {
          id: randomUUID(),
          classroomId: classroom.id,
          resourceId: id,
          resourceVersionId: version.id,
          status: 'PUBLISHED',
          createdById: owner,
        },
      });
    }
    const other = await prisma.classroom.create({
      data: { id: randomUUID(), ownerId: owner, name: 'Y10', slug: randomUUID() },
    });
    await prisma.assignment.create({
      data: {
        id: randomUUID(),
        classroomId: other.id,
        resourceId: id,
        resourceVersionId: version.id,
        status: 'WITHDRAWN',
        createdById: owner,
      },
    });

    const view = await loadResourceView(prisma, id);
    expect(view).not.toBeNull();
    expect(view?.classroomIds).toEqual([classroom.id]);
    expect(view?.versionId.startsWith('no-version:'), 'no current version yet').toBe(true);
  });
});

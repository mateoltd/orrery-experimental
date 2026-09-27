/**
 * The read-time re-check, and the three attack paths the P2-T8 packet names.  (P2-T8)
 *
 * "A second user cannot read a private resource by direct id, by search, or from cache; a 403
 * and a 404 do not leak existence differently in a way that matters."
 *
 * Those are three ATTACK PATHS, so they are three tests that attack. The first implementation of
 * this file tested `canReadResource` and moved on, and it would have passed those tests while a
 * search endpoint had no filter at all — which is the exact failure the packet is describing,
 * and why the search sweep below iterates a CORPUS rather than calling one function.
 */

import { describe, expect, it } from 'vitest';
import { canActOn, canReadResource, type ResourceView, visibleInSearch } from '../resources.js';
import type { Actor } from '../types.js';

const r = (o: Partial<ResourceView> = {}): ResourceView => ({
  id: 'r1',
  ownerId: 'alice',
  status: 'PUBLISHED',
  visibility: 'PRIVATE',
  versionId: 'v1',
  classroomIds: ['c1'],
  ...o,
});

const a = (o: Partial<Actor> = {}): Actor => ({
  id: 'bob',
  roles: ['student'],
  mfaVerified: false,
  suspended: false,
  ...o,
});

// ── Attack path 1: the direct id ────────────────────────────────────────────────

describe('a second user reading a private resource by direct id', () => {
  it('gets 404, not 403', () => {
    // 403 says "this id is real and you may not have it", which is a directory of the whole id
    // space to anyone who can send a request. plans/14 §3.
    expect(canReadResource(r(), a())).toEqual({ visible: false, httpStatus: 404 });
  });

  it('cannot distinguish "private" from "does not exist"', () => {
    // The attacker does not get to choose which answer they get. If a denied read and an absent
    // read differ in any observable way — status, body shape, a `canEdit` hint — existence is
    // readable, and the id space becomes enumerable.
    const denied = canReadResource(r(), a());
    const absent = canReadResource(r({ id: 'never-existed' }), a());
    expect(denied).toEqual(absent);
    expect(Object.keys(denied).sort()).toEqual(Object.keys(absent).sort());
  });

  it('is blocked even on a PUBLIC resource if the viewer is suspended', () => {
    // Suspension is a READ-time fact. An account suspended on Monday must lose access on the
    // next request, and this IS the next request.
    expect(canReadResource(r({ visibility: 'PUBLIC' }), a({ suspended: true }))).toEqual({
      visible: false,
      httpStatus: 404,
    });
  });

  it('lets the owner in, and nobody else', () => {
    expect(canReadResource(r(), a({ id: 'alice' })).visible).toBe(true);
    expect(canReadResource(r(), a({ id: 'carol' })).visible).toBe(false);
  });

  it('lets a co-teacher in the shared classroom read it but not edit it', () => {
    // PRIVATE does not mean "unshared with the world" — sharing with a colleague is a
    // deliberate act, not a leak. A student in the same classroom is a different question.
    const co = a({ id: 'dana', roles: ['teacher'] });
    const d = canReadResource(r(), co, ['c1']);
    expect(d).toMatchObject({ visible: true, canEdit: false });
    expect(canActOn(r(), co, 'edit', ['c1'])).toEqual({ allowed: false, httpStatus: 403 });
  });
});

// ── Attack path 2: search ──────────────────────────────────────────────────────

describe('a second user finding a private resource through search', () => {
  it('is filtered out of the index, not merely greyed out', () => {
    expect(visibleInSearch(r(), a())).toBe(false);
  });

  it('filters UNLISTED for everyone but the owner and an admin', () => {
    // UNLISTED means "reachable by link, absent from listings". A search index that returns it
    // IS a listing, and the tier silently collapses into PUBLIC.
    const u = r({ visibility: 'UNLISTED' });
    expect(visibleInSearch(u, a())).toBe(false);
    expect(visibleInSearch(u, a({ id: 'alice' }))).toBe(true);
    expect(visibleInSearch(u, a({ id: 'root', roles: ['platformAdmin'] }))).toBe(true);
  });

  it('leaves a sweep with no private title in any result set', () => {
    // A SWEEP, not a single call, because the realistic failure is a SECOND search path — a
    // typeahead querying the index directly, or a "related resources" block reusing an
    // unfiltered helper. Testing one function cannot catch a second caller.
    const corpus: ResourceView[] = [
      r({ id: 'priv' }),
      r({ id: 'unlisted', visibility: 'UNLISTED' }),
      r({ id: 'draft', status: 'DRAFT' }),
      r({ id: 'withdrawn', status: 'WITHDRAWN' }),
      r({ id: 'arch', status: 'ARCHIVED' }),
      r({ id: 'pub', visibility: 'PUBLIC' }),
    ];
    const visible = corpus.filter((x) => visibleInSearch(x, a())).map((x) => x.id);
    expect(visible).toEqual(['pub']);
  });

  it('shows the owner their own withdrawn resource, so they can fix it', () => {
    // A withdrawal is a correction, not a secret. If the author cannot see what they pulled,
    // the only way to find out is to ask support.
    expect(visibleInSearch(r({ status: 'WITHDRAWN' }), a({ id: 'alice' }))).toBe(true);
  });
});

// ── Attack path 3: the cache ───────────────────────────────────────────────────

describe('a second user being served a private resource from cache', () => {
  it('marks a private resource uncacheable even for the owner', () => {
    const d = canReadResource(r(), a({ id: 'alice' }));
    expect(d).toMatchObject({ visible: true, cacheable: false });
  });

  it('marks a PUBLIC resource uncacheable for a suspended viewer and for an admin', () => {
    // An admin's response is not shared-cacheable: an admin sees drafts and withdrawn items
    // that no anonymous requester may, so caching their response under a public key would
    // serve an admin's view of a draft to a student.
    const p = r({ visibility: 'PUBLIC' });
    expect(canReadResource(p, a()).cacheable).toBe(true);
    expect(canReadResource(p, a({ suspended: true })).visible).toBe(false);
    expect(canReadResource(p, a({ id: 'root', roles: ['platformAdmin'] })).cacheable).toBe(false);
  });

  it('marks a withdrawn resource uncacheable although it was public a moment ago', () => {
    const d = canReadResource(
      r({ visibility: 'PUBLIC', status: 'WITHDRAWN' }),
      a({ id: 'root', roles: ['platformAdmin'] }),
    );
    expect(d).toMatchObject({ visible: true, cacheable: false });
  });

  it('never marks a DRAFT cacheable, whoever is looking', () => {
    // A non-owner cannot read a DRAFT at all, so there is no `cacheable` field to check — the
    // decision is the 404 itself. Asserting `.cacheable` on a denied read was the first
    // version and it compared `undefined` to `false`, which reads like a bug in the code and is
    // really a bug in the test: a denied read is stronger than an uncacheable one.
    expect(canReadResource(r({ status: 'DRAFT' }), a()).visible).toBe(false);
    for (const who of [a({ id: 'alice' }), a({ id: 'root', roles: ['platformAdmin'] })]) {
      expect(canReadResource(r({ status: 'DRAFT' }), who).cacheable, who.id).toBe(false);
    }
  });
});

// ── 403 vs 404 ─────────────────────────────────────────────────────────────────

describe('403 and 404', () => {
  it('uses 404 when the resource is invisible and 403 when it is visible but not permitted', () => {
    const u = r({ visibility: 'UNLISTED', classroomIds: ['c1'] });
    // A student IN c1 can read it, so an edit is a 403 — they already know it exists.
    expect(canReadResource(u, a(), ['c1']).visible).toBe(true);
    expect(canActOn(u, a(), 'edit', ['c1'])).toEqual({ allowed: false, httpStatus: 403 });
    // A student OUTSIDE c1 has never heard of it, so an edit is a 404.
    expect(canActOn(u, a(), 'edit')).toEqual({ allowed: false, httpStatus: 404 });
  });

  it('maps `notVisible` to 404 and every other deny to 403', () => {
    // Asserted across a sweep, because the mapping is the property and it is easy to regress by
    // mapping on `allowed` alone.
    const corpus: ResourceView[] = [
      r({ id: 'priv' }),
      r({ id: 'unlisted', visibility: 'UNLISTED' }),
      r({ id: 'draft', status: 'DRAFT' }),
      r({ id: 'withdrawn', status: 'WITHDRAWN' }),
      r({ id: 'pub', visibility: 'PUBLIC' }),
    ];
    for (const x of corpus) {
      const read = canReadResource(x, a());
      if (!read.visible) {
        expect(read.httpStatus, x.id).toBe(404);
        expect(canActOn(x, a(), 'edit').httpStatus, x.id).toBe(404);
      } else {
        expect(canActOn(x, a(), 'edit').httpStatus, `${x.id} (visible)`).toBe(403);
      }
    }
  });

  it('never lets a student publish or delete, even a resource they somehow own', () => {
    // `Resource` is teacher-authored in plans/01 and students author `SimDraft`, so a student
    // holding a Resource is an invariant violation. This denies rather than repairs, and the
    // first version of this function let `delete` fall through to the OWNERSHIP check.
    const own = r({ status: 'DRAFT', ownerId: 'bob', classroomIds: [] });
    const s = a({ id: 'bob' });
    expect(canReadResource(own, s).visible).toBe(true);
    expect(canActOn(own, s, 'publish')).toEqual({ allowed: false, httpStatus: 403 });
    expect(canActOn(own, s, 'delete')).toEqual({ allowed: false, httpStatus: 403 });
    // And the asymmetry that made the bug invisible: `canEdit` IS true, because ownership
    // genuinely does grant content edits. Content edit and lifecycle management are different
    // permissions and the test has to keep them apart.
    expect(canReadResource(own, s).canEdit).toBe(true);
  });

  it('lets a teacher publish their own and an admin do all of it', () => {
    const own = r({ status: 'DRAFT', ownerId: 'dana' });
    expect(canActOn(own, a({ id: 'dana', roles: ['teacher'] }), 'publish')).toEqual({
      allowed: true,
    });
    const admin = a({ id: 'root', roles: ['platformAdmin'], suspended: true });
    for (const action of ['edit', 'publish', 'delete'] as const) {
      expect(canActOn(r({ status: 'WITHDRAWN' }), admin, action).allowed, action).toBe(true);
    }
  });

  it("will not let a teacher publish or delete a colleague's resource", () => {
    // Ownership AND role. A teacher with the right role but the wrong subject is the cell a
    // role-only check lets through.
    //
    // The resource is PUBLISHED and shared into c1 rather than DRAFT, because a DRAFT is
    // invisible to everyone but its owner — so against a draft this reads 404, which is the
    // correct answer for a completely different reason and proves nothing about the role check.
    // A test that passed there would be passing on visibility, not on what it claims to cover.
    const theirs = r({ status: 'PUBLISHED', ownerId: 'dana', visibility: 'UNLISTED' });
    const other = a({ id: 'erin', roles: ['teacher'] });
    expect(canReadResource(theirs, other, ['c1']).visible, 'must be visible to test the 403').toBe(
      true,
    );
    expect(canActOn(theirs, other, 'publish', ['c1'])).toEqual({
      allowed: false,
      httpStatus: 403,
    });
    expect(canActOn(theirs, other, 'delete', ['c1'])).toEqual({ allowed: false, httpStatus: 403 });
  });
});

// ── Deny on anything unrecognised ──────────────────────────────────────────────

describe('an unrecognised status or visibility', () => {
  it('denies rather than defaulting to a tier', () => {
    // The single most important line in `resourceVisible`. A `?? 'PUBLIC'` here would mean a
    // status added by a migration before this list is updated silently becomes world-readable,
    // and the symptom would be a content leak discovered by somebody's parents.
    const future = { status: 'IN_REVIEW', visibility: 'PUBLIC' } as unknown as ResourceView;
    expect(canReadResource(future, a())).toEqual({ visible: false, httpStatus: 404 });
    const futureV = { status: 'PUBLISHED', visibility: 'FRIENDS' } as unknown as ResourceView;
    expect(canReadResource(futureV, a())).toEqual({ visible: false, httpStatus: 404 });
    const missing = { status: 'PUBLISHED' } as unknown as ResourceView;
    expect(canReadResource(missing, a())).toEqual({ visible: false, httpStatus: 404 });
  });

  it('denies even for the owner, so a malformed row is visible to nobody', () => {
    const future = { status: 'IN_REVIEW', visibility: 'PRIVATE' } as unknown as ResourceView;
    expect(canReadResource(future, a({ id: 'alice' })).visible).toBe(false);
  });
});

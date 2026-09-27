/**
 * The pure lifecycle, and the cache key.  (P2-T8)
 *
 * ## What is NOT tested here, and why that is the point
 *
 * The read-permission tests — a second user reading a private resource by direct id, by search,
 * or from cache — live in `packages/auth/src/__tests__/resources.test.ts`.
 *
 * They were written here first. The authz-ownership gate rejected them, and correctly: a
 * permission decision in `@orrery/contracts` would mean ownership comparisons exist in two
 * packages, and the two would drift. The gate's message is "move the decision into
 * `packages/auth` and call `can()`. Do not suppress."
 *
 * So this file now tests exactly the two things that are genuinely pure: the state machine, and
 * a cache key with no viewer in it. The most useful assertion below is structural — it checks
 * the SIGNATURE, because re-adding a `Viewer` here is precisely the regression the gate exists
 * to catch, and it would otherwise look like an innocent refactor.
 */

import { describe, expect, it } from 'vitest';
import {
  cacheHeaders,
  cacheKey,
  LIFECYCLE_EDGES,
  RESOURCE_STATUSES,
  type ResourceDescriptor,
  transition,
} from './index.js';

const res = (o: Partial<ResourceDescriptor> = {}): ResourceDescriptor => ({
  id: 'r1',
  ownerId: 'alice',
  status: 'PUBLISHED',
  visibility: 'PUBLIC',
  versionId: 'v1',
  classroomIds: ['c1'],
  ...o,
});

// ── The lifecycle ──────────────────────────────────────────────────────────────

describe('lifecycle', () => {
  it('walks DRAFT -> PUBLISHED -> ARCHIVED, and WITHDRAWN is reachable from PUBLISHED', () => {
    expect(transition('DRAFT', 'publish', {}).status).toBe('PUBLISHED');
    expect(transition('PUBLISHED', 'archive', {}).status).toBe('ARCHIVED');
    expect(transition('PUBLISHED', 'withdraw', { reason: 'the units are wrong' }).status).toBe(
      'WITHDRAWN',
    );
  });

  it('refuses every edge it does not declare, and the edge table is total over statuses', () => {
    // Totality matters: a status with no entry in LIFECYCLE_EDGES would THROW on lookup rather
    // than deny, and a thrown error in an authorisation path tends to become a 500 — which
    // leaks less than a 403, but for the wrong reason, and looks like an outage.
    for (const s of RESOURCE_STATUSES) expect(LIFECYCLE_EDGES[s], s).toBeDefined();

    const illegal: [Parameters<typeof transition>[0], Parameters<typeof transition>[1]][] = [
      ['DRAFT', 'archive'],
      ['DRAFT', 'withdraw'],
      ['ARCHIVED', 'publish'],
      ['WITHDRAWN', 'publish'],
      ['PUBLISHED', 'restore'],
    ];
    for (const [from, to] of illegal) {
      expect(transition(from, to, { reason: 'a good long reason' }), `${from}->${to}`).toEqual({
        ok: false,
        reason: 'notAllowed',
      });
    }
  });

  it('requires a real reason to withdraw', () => {
    // "changed", "oops", "fixed" and a bare " " are not reasons. A withdrawal is the one
    // transition whose consequences a student may see, so it has to be explainable to them.
    for (const reason of ['', '   ', 'changed', 'fix']) {
      expect(transition('PUBLISHED', 'withdraw', { reason })).toEqual({
        ok: false,
        reason: 'reasonRequired',
      });
    }
  });

  it('will not withdraw, archive, unpublish or delete a resource with a live attempt', () => {
    // The scenario this exists for: a teacher notices a wrong question at 10:05 and pulls the
    // quiz, invalidating twenty students' work in progress. `plans/09` is built around the
    // student in that seat.
    for (const to of ['withdraw', 'archive', 'unpublish', 'delete'] as const) {
      const r = transition('PUBLISHED', to, {
        reason: 'a good long reason',
        hasLiveAttempts: true,
      });
      expect(r.ok, to).toBe(false);
    }
    // And it is the LIVE attempts that block it, not the mere existence of attempts — a
    // finished exam must not freeze a resource forever.
    expect(
      transition('PUBLISHED', 'withdraw', { reason: 'a good long reason', hasLiveAttempts: false })
        .ok,
    ).toBe(true);
    expect(transition('PUBLISHED', 'withdraw', { reason: 'a good long reason' }).ok).toBe(true);
  });

  it('sends a withdrawn resource back through DRAFT, not straight to PUBLISHED', () => {
    // Otherwise "I fixed the typo" republishes something nobody re-read, which is how a second
    // error ships.
    expect(transition('WITHDRAWN', 'restore', {}).status).toBe('DRAFT');
  });

  it('never strands a resource: every status is reachable from DRAFT', () => {
    // No status that nothing can reach. An unreachable status is dead code that a UI will still
    // offer, because the UI reads the enum rather than the edge table.
    const seen = new Set<Parameters<typeof transition>[0]>(['DRAFT']);
    const queue = ['DRAFT'];
    while (queue.length) {
      const from = queue.pop() as Parameters<typeof transition>[0];
      for (const edge of LIFECYCLE_EDGES[from]) {
        const r = transition(from, edge, { reason: 'a good long reason' });
        if (r.ok && !seen.has(r.status)) {
          seen.add(r.status);
          queue.push(r.status);
        }
      }
    }
    expect([...seen].sort()).toEqual([...RESOURCE_STATUSES].sort());
  });
});

// ── The cache key ──────────────────────────────────────────────────────────────

describe('the cache key', () => {
  it('is null whenever the decision says the response is not cacheable', () => {
    // The FIRST line of defence. A private response is `private, no-store` and never enters a
    // shared cache at all, so there is no key that could get it wrong.
    expect(cacheKey(res(), false)).toBeNull();
    expect(cacheHeaders(false)['cache-control']).toBe('private, no-store');
  });

  it('changes when the version, the owner, the status or the visibility changes', () => {
    // The assertion that fails if someone later "simplifies" the key to `${id}`.
    const original = cacheKey(res(), true);
    expect(original).toBe('PUBLIC:PUBLISHED:alice:v1:r1');
    for (const mutated of [
      res({ versionId: 'v2' }),
      res({ ownerId: 'dan' }),
      res({ status: 'ARCHIVED' }),
      res({ visibility: 'PRIVATE' }),
    ]) {
      expect(cacheKey(mutated, true), JSON.stringify(mutated)).not.toBe(original);
    }
  });

  it('sends Vary on BOTH paths', () => {
    // On the cacheable path this is what makes an accidental shared cache harmless: the same
    // URL is PUBLIC to one viewer and 404 to another, and without Vary a shared cache serves
    // whichever response it saw first — which is the private one's whole failure mode.
    for (const cacheable of [true, false]) {
      expect(cacheHeaders(cacheable).vary).toBe('Cookie, Authorization');
    }
  });

  it('takes no viewer, so it CANNOT disagree with the permission decision', () => {
    // Asserted structurally rather than behaviourally, because this is a signature property.
    // The first version took a `Viewer` and returned null for non-public; the authz gate
    // rejected it, and re-adding a viewer here would look like an innocent refactor while
    // putting a second, competing copy of the permission rule into this package.
    expect(cacheKey.length, 'cacheKey(resource, cacheable) — no viewer').toBe(2);
    expect(cacheHeaders.length, 'cacheHeaders(cacheable) — no viewer').toBe(1);
  });
});

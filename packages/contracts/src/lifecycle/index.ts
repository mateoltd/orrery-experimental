/**
 * Resource lifecycle, visibility, and the read-time permission re-check.  (P2-T8)
 *
 * ## The property this file exists for
 *
 * **A permission checked on write is not a permission.** `plans/05` and the P2-T8 packet both
 * say it: access must be re-checked on every READ, not only when the resource was written. The
 * reason is not subtle — a resource that was PRIVATE when the author wrote it can become
 * SHARED, a student can be removed from a classroom, a teacher can be suspended, and a link
 * that was safe in January is not safe now. Every one of those is a read-time fact.
 *
 * ## Why 404 rather than 403 for "you may not see this"
 *
 * `plans/14` §3: a `403` says "this exists and you may not have it", which is a directory of
 * every resource id in the system for anyone who can send a request. So:
 *
 *   · a resource the viewer CANNOT SEE at all -> **404**, indistinguishable from absence
 *   · a resource the viewer CAN see but may not ACT on -> **403**, because they already know it
 *     exists and hiding that is theatre
 *
 * The distinction is the whole point and it is easy to get backwards. A blanket 404 makes the
 * product feel broken; a blanket 403 publishes the id space.
 *
 * ## Why the cache key carries the visibility tier
 *
 * Because a cache key that does not include it WILL serve a private resource to a public
 * requester. That is not a hypothetical bug class: it is what happens when someone adds a cache
 * in P3 and the key is `${resourceId}`, and it fails silently, under load, for the students with
 * the least power. So the key is BUILT HERE, by one function, and the done-when asserts a
 * private and a public resource never share a key.
 */

export const RESOURCE_STATUSES = ['DRAFT', 'PUBLISHED', 'ARCHIVED', 'WITHDRAWN'] as const;
export type ResourceStatus = (typeof RESOURCE_STATUSES)[number];

export const VISIBILITIES = ['PRIVATE', 'UNLISTED', 'PUBLIC'] as const;
export type Visibility = (typeof VISIBILITIES)[number];

export type Transition = 'publish' | 'archive' | 'withdraw' | 'restore' | 'unpublish' | 'delete';

export const LIFECYCLE_EDGES: Readonly<Record<ResourceStatus, readonly Transition[]>> = {
  DRAFT: ['publish', 'delete'],
  // PUBLISHED -> ARCHIVED is "no longer current"; -> WITHDRAWN is "found wrong, pull it now".
  // They are different because WITHDRAWN hides from students immediately and ARCHIVED does not.
  PUBLISHED: ['archive', 'withdraw', 'unpublish', 'delete'],
  ARCHIVED: ['restore', 'delete'],
  // WITHDRAWN is not restorable to PUBLISHED directly. A withdrawn resource must go back
  // through DRAFT, so the author has looked at it again — otherwise a "fix the typo" workflow
  // can republish a resource nobody re-read, which is how a second error ships.
  WITHDRAWN: ['restore', 'delete'],
};

export const WITHDRAW_REASON_REQUIRED =
  'a withdrawal must say what was wrong; "changed" is not a reason';

export type TransitionResult =
  | { ok: true; status: ResourceStatus; reason: string | null }
  | { ok: false; reason: 'notAllowed' | 'sameStatus' | 'reasonRequired' | 'hasLiveAttempts' };

/**
 * Apply a lifecycle transition.
 *
 * `hasLiveAttempts` is the guard on the transitions that must not strand a student mid-exam:
 * a resource with an attempt in progress cannot be withdrawn or deleted. A teacher who pulls a
 * quiz at 10:05 because the question is wrong would otherwise invalidate twenty students'
 * in-flight work, which is the exact scenario `plans/09` is built around.
 */
export function transition(
  from: ResourceStatus,
  to: Transition,
  input: { reason?: string; hasLiveAttempts?: boolean },
): TransitionResult {
  if (!LIFECYCLE_EDGES[from].includes(to)) return { ok: false, reason: 'notAllowed' };

  if (to === 'withdraw') {
    if ((input.reason ?? '').trim().length < 10) return { ok: false, reason: 'reasonRequired' };
    if (input.hasLiveAttempts === true) return { ok: false, reason: 'hasLiveAttempts' };
    return { ok: true, status: 'WITHDRAWN', reason: (input.reason ?? '').trim() };
  }

  if (to === 'archive') {
    if (input.hasLiveAttempts === true) return { ok: false, reason: 'hasLiveAttempts' };
    return { ok: true, status: 'ARCHIVED', reason: null };
  }

  if (to === 'publish' || to === 'restore') {
    if (input.hasLiveAttempts === true) return { ok: false, reason: 'hasLiveAttempts' };
    return { ok: true, status: to === 'publish' ? 'PUBLISHED' : 'DRAFT', reason: null };
  }

  if (to === 'unpublish') {
    // Back to DRAFT, and the same live-attempt guard. A teacher who unpublishes a quiz that
    // twenty students are sitting would be pulling the content out from under them.
    if (input.hasLiveAttempts === true) return { ok: false, reason: 'hasLiveAttempts' };
    return { ok: true, status: 'DRAFT', reason: null };
  }

  if (to === 'delete') {
    if (input.hasLiveAttempts === true) return { ok: false, reason: 'hasLiveAttempts' };
    return { ok: true, status: 'ARCHIVED', reason: null };
  }

  return { ok: false, reason: 'notAllowed' };
}

// ── Read-time visibility ────────────────────────────────────────────────────────

/**
 * The resource's identity and lifecycle facts, as a plain value.
 *
 * It carries NO viewer and no permission. That is the whole point: the authorisation decision
 * is made by `@orrery/auth` against `can()`, and this descriptor is only the subject it is
 * decided about. A descriptor that also knew who was asking would be a second, competing
 * implementation of the same rule.
 */
export interface ResourceDescriptor {
  readonly id: string;
  readonly ownerId: string;
  readonly status: ResourceStatus;
  readonly visibility: Visibility;
  /** The pinned version. Part of the cache key: a new version is a different document. */
  readonly versionId: string;
  /** Classroom ids the resource is shared into. Empty for a personal resource. */
  readonly classroomIds: readonly string[];
}
/**
 * The cache key, built in ONE place, with NO viewer in it.
 *
 * The key is a pure function of the resource. That is deliberate and it is the reason this file
 * was allowed to keep it: a function of the resource alone cannot be wrong about WHO is asking,
 * because it has no way to know. The authorisation decision — which is the part that must know
 * about viewers — lives in `@orrery/auth` behind `can()`, and it hands this module a boolean.
 *
 * Every component earns its place, and each one is a real failure it prevents:
 *
 *   · `visibility` — a PRIVATE and a PUBLIC resource with the same id must not share a key.
 *   · `ownerId`   — the same id under two owners is two resources.
 *   · `versionId` — a new version is a different document; serving v2 from v1's key is how a
 *                    student sees yesterday's lesson.
 *   · `status`    — a WITHDRAWN resource must never be served from a PUBLISHED entry.
 *
 * The first version of this took a `Viewer` and returned `null` for non-public. That put an
 * ownership comparison in `@orrery/contracts`, and the authz-ownership gate rejected it — which
 * is the gate earning its keep twice over, because the fix also removed the possibility of the
 * key disagreeing with the permission decision.
 */
export function cacheKey(r: ResourceDescriptor, cacheable: boolean): string | null {
  if (!cacheable) return null;
  return [r.visibility, r.status, r.ownerId, r.versionId, r.id].join(':');
}

/** Response headers for a cacheable decision. `private, no-store` is the important one. */
export function cacheHeaders(cacheable: boolean): {
  'cache-control': string;
  vary: 'Cookie, Authorization';
} {
  if (!cacheable) {
    // `no-store` as well as `private`: `private` stops a SHARED cache storing it and `no-store`
    // stops a browser or a service worker doing so either. Together they are the only
    // combination that covers every cache in the path.
    return { 'cache-control': 'private, no-store', vary: 'Cookie, Authorization' };
  }
  // `Vary` on BOTH paths. On the cacheable one it makes an accidental shared cache harmless:
  // the same URL is PUBLIC to one viewer and 404 to another, and without Vary a shared cache
  // serves whichever it saw first.
  return { 'cache-control': 'public, max-age=60', vary: 'Cookie, Authorization' };
}

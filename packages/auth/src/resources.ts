/**
 * The read-time re-check, as a thin layer over `can()`.  (P2-T8)
 *
 * ## Why this file exists and is this thin
 *
 * The rules live in `matrix.ts` as `resourceRules`, because a permission that lives at a call
 * site is a permission somebody forgets. This file only translates — `can()` decides, and this
 * turns the decision into an HTTP status and a cache directive.
 *
 * It was originally written in `packages/contracts` next to the lifecycle state machine, which
 * read as the natural home. **The authz-ownership gate rejected it** ("move the decision into
 * `packages/auth` and call `can()`. Do not suppress.") and the gate is right for two reasons:
 *
 *  1. `packages/auth` depends on `packages/contracts`, so a decision in contracts means the
 *     dependency runs the wrong way for this layer.
 *  2. More importantly, ownership comparisons would then exist in two places — here and the
 *     matrix — and the two would drift. The matrix is where the rule is stated; this file must
 *     not be able to answer a different question.
 *
 * ## 404 vs 403, one more time, because it is the whole file
 *
 * `plans/14` §3. A `403` on a resource the viewer may not see says "this id is real". So
 * `notVisible` maps to **404**, always, and every other deny maps to **403**. The distinction
 * is carried by the deny CODE rather than by a boolean, so a rule author cannot accidentally
 * produce a 403 for something invisible — they would have to write `'notVisible'`, which reads
 * as the wrong thing at the call site.
 */

import { can } from './can.js';
import type {
  Action,
  Actor,
  ResourceLifecycleStatus,
  ResourceVisibility,
  Subject,
} from './types.js';

export interface ResourceView {
  readonly id: string;
  readonly ownerId: string;
  readonly status: ResourceLifecycleStatus;
  readonly visibility: ResourceVisibility;
  readonly versionId: string;
  readonly classroomIds: readonly string[];
}

export type ReadDecision =
  | { readonly visible: true; readonly canEdit: boolean; readonly cacheable: boolean }
  | { readonly visible: false; readonly httpStatus: 404 };

/**
 * Whether the resource may enter a SHARED cache.
 *
 * Only PUBLIC, non-withdrawn, non-draft content. Private and unlisted responses are
 * `private, no-store` and never cached, so the cache key does not even have to be the thing
 * that saves them — it is the second line of defence, not the first.
 */
function cacheableFor(r: ResourceView, actor: Actor): boolean {
  return (
    r.visibility === 'PUBLIC' &&
    r.status === 'PUBLISHED' &&
    !actor.suspended &&
    !actor.roles.includes('platformAdmin')
  );
}

/**
 * Build the subject once.
 *
 * A copy-pasted `subject` literal in three places is how a rule starts disagreeing with itself
 * — and note what is NOT here: no `?? 'PUBLIC'`, no default visibility, no `ownerId` fallback.
 * A missing field is what `resourceVisible` denies on, and that is the safe direction.
 */
function subjectFor(r: ResourceView): Subject {
  return {
    type: 'Resource',
    id: r.id,
    ownerId: r.ownerId,
    lifecycleStatus: r.status,
    visibility: r.visibility,
    sharedClassroomIds: new Set(r.classroomIds),
  };
}

function ask(action: Action, r: ResourceView, actor: Actor, actorClassroomIds: readonly string[]) {
  return can({
    actor,
    action,
    subject: subjectFor(r),
    context: { actorClassroomIds: new Set(actorClassroomIds) },
  });
}

export function canReadResource(
  r: ResourceView,
  actor: Actor,
  actorClassroomIds: readonly string[] = [],
): ReadDecision {
  if (!ask('read', r, actor, actorClassroomIds).allowed) return { visible: false, httpStatus: 404 };
  return {
    visible: true,
    canEdit: ask('update', r, actor, actorClassroomIds).allowed,
    cacheable: cacheableFor(r, actor),
  };
}

export type ActionVerdict = { allowed: true } | { allowed: false; httpStatus: 403 | 404 };

export function canActOn(
  r: ResourceView,
  actor: Actor,
  action: 'edit' | 'publish' | 'delete' | 'transfer',
  actorClassroomIds: readonly string[] = [],
): ActionVerdict {
  const decision = ask(action === 'edit' ? 'update' : action, r, actor, actorClassroomIds);
  if (decision.allowed) return { allowed: true };
  return { allowed: false, httpStatus: decision.reason === 'notVisible' ? 404 : 403 };
}

/**
 * Whether a SEARCH result may include this resource.
 *
 * Separate from `canReadResource` on purpose, and this is the answer to "a second user cannot
 * read a private resource by search". The realistic failure is not that the permission check is
 * wrong — it is that the search path FORGOT to call it, because the query was written once and
 * the filter was added "later". A test that calls one function does not catch a second caller.
 *
 * The UNLISTED rule lives HERE and not in the matrix, and that is a real asymmetry rather than
 * an oversight: `unlisted` describes behaviour on a LISTING, and the matrix models actions on
 * a subject. A `read` grant cannot know it is being called from a search index. So the tier
 * collapses in exactly one place, which is the only place it can be correct.
 */
export function visibleInSearch(
  r: ResourceView,
  actor: Actor,
  actorClassroomIds: readonly string[] = [],
): boolean {
  if (
    r.visibility === 'UNLISTED' &&
    actor.id !== r.ownerId &&
    !actor.roles.includes('platformAdmin')
  ) {
    return false;
  }
  return canReadResource(r, actor, actorClassroomIds).visible;
}

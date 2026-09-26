/**
 * Effective role from enrollments.  (P1, INV-CLASSROOM-1)
 *
 * ## The invariant
 *
 * "Effective role is the max of active enrollments." The word that matters is **max**: a user
 * with any active enrollment carrying a role has that role, and it does not matter that they
 * are also enrolled elsewhere with a lesser one. Union, not intersection and not
 * most-recent — a teacher who is also a student in a class is a teacher.
 *
 * ## Why this is not simply `actor.roles`
 *
 * Because `actor.roles` is a CLAIM. It is whatever the session says the user is, which means
 * it is correct only if something derived it from enrollments. If the claim and the enrollment
 * table disagree, the claim wins — and the claim is the thing an attacker would like to
 * control. Deriving it here means the matrix consumes something derived from the database.
 *
 * The two must agree, and `assertRolesMatchEnrollments` is what makes the disagreement loud
 * rather than silent. It is exported and called by the request path, because the alternative —
 * trusting the claim and hoping — is how a demoted teacher keeps teacher powers for as long as
 * their session lives.
 *
 * ## "Active" is a real predicate, not a flag
 *
 * An enrollment is active while it is inside its window AND has not been withdrawn. A role that
 * expired yesterday is not a role today, and a session that lived for 30 days would otherwise
 * carry it for 30 days after it stopped being true.
 */

import type { Millis } from '@orrery/clock';
import type { Role } from './types.js';

/** Ordered least to most privileged, so "max" is a comparison and not a set union by luck. */
export const ROLE_ORDER: readonly Role[] = ['student', 'reviewer', 'teacher', 'platformAdmin'];

export function roleRank(role: Role): number {
  const index = ROLE_ORDER.indexOf(role);
  // An unrecognised role ranks BELOW student rather than throwing. A role added to the database
  // by a migration that has not reached this build yet should not deny a teacher their grading
  // screen at 9am on a Monday; it should be ignored, and the invariant registry gate is where
  // the mismatch is caught.
  return index === -1 ? -1 : index;
}

/** The highest-ranked role in a set, or null for an empty set. */
export function maxRole(roles: readonly Role[]): Role | null {
  let best: Role | null = null;
  let bestRank = -1;
  for (const role of roles) {
    const rank = roleRank(role);
    if (rank > bestRank) {
      bestRank = rank;
      best = role;
    }
  }
  return best;
}

export interface EnrollmentRow {
  readonly role: Role;
  /** `null` means "no end date", which is an open-ended enrollment and IS active. */
  readonly endsAt: Millis | null;
  /** Withdrawn early. Still in the table, because the history matters. */
  readonly withdrawnAt?: Millis | null;
}

/**
 * The roles a user holds right now.
 *
 * A `DELETING` account holds NO roles, even though its enrollments are still active. That is the
 * whole point of the deletion grace period: the account is still usable, but it is not a member
 * of anything, so it cannot be given a class. Handing a deleting account a role would make the
 * grace period a period of quietly continuing to teach.
 */
export function effectiveRoles(input: {
  readonly enrollments: readonly EnrollmentRow[];
  readonly now: Millis;
  readonly accountStatus: 'ACTIVE' | 'SUSPENDED' | 'DELETING' | 'DELETED';
}): Role[] {
  if (input.accountStatus === 'DELETED' || input.accountStatus === 'SUSPENDED') return [];
  if (input.accountStatus === 'DELETING') return [];
  const active = input.enrollments
    .filter((e) => e.withdrawnAt === null || e.withdrawnAt === undefined)
    .filter((e) => e.endsAt === null || e.endsAt > input.now)
    .map((e) => e.role);
  return [...new Set(active)];
}

/** The single highest role, which is what most UI and most decisions actually need. */
export function effectiveRole(input: {
  readonly enrollments: readonly EnrollmentRow[];
  readonly now: Millis;
  readonly accountStatus: 'ACTIVE' | 'SUSPENDED' | 'DELETING' | 'DELETED';
}): Role | null {
  return maxRole(effectiveRoles(input));
}

/**
 * Whether a session's claimed roles are consistent with the enrollments.
 *
 * A session may claim a role it no longer holds — the teacher was demoted, the enrollment
 * expired — and the matrix would happily honour the claim. The request path calls this and
 * REFRESHES the claim from the derived roles rather than rejecting the request, because a
 * teacher who has just been made a student should lose the grading screen, not be signed out
 * mid-lesson.
 *
 * Returns the derived roles, which is what the caller should use. Returning a boolean as well
 * would tempt a caller into logging the mismatch and continuing with the stale claim.
 */
export function assertRolesMatchEnrollments(input: {
  readonly claimed: readonly Role[];
  readonly enrollments: readonly EnrollmentRow[];
  readonly now: Millis;
  readonly accountStatus: 'ACTIVE' | 'SUSPENDED' | 'DELETING' | 'DELETED';
}): { roles: Role[]; corrected: boolean } {
  const derived = effectiveRoles(input);
  const claimedSet = new Set(input.claimed);
  const derivedSet = new Set(derived);
  const corrected =
    claimedSet.size !== derivedSet.size || [...claimedSet].some((r) => !derivedSet.has(r));
  return { roles: derived, corrected };
}

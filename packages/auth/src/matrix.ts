/**
 * The matrix, declared as DATA.  (P1-T6, plans/13 §3.2–3.3, D-14)
 *
 * ## Why data and not branching code
 *
 * A `switch` over action and type cannot be *proved* total by reading it, and cannot be
 * coverage-reported. A nested record can: `Record<ResourceType, Record<Action, Rule>>` is a
 * TypeScript type that fails to COMPILE if a cell is missing, and `matrixCoverage()` reports
 * it at runtime for the type-checked-in-CI case. Both, because each catches what the other
 * misses: the compiler catches omission at build time, the report catches it in a review.
 *
 * The alternative — one function with 22 `if` branches — is the shape that produced the
 * bugs D-31 and D-35 found, where a rule was added for the happy path and nothing proved
 * the unhappy paths existed.
 *
 * ## Extending it
 *
 * A later phase adds a type to `IMPLEMENTED_TYPES` and writes one `Record<Action, Rule>` for
 * it. Until it does, the type is absent from the matrix and `can()` denies on
 * `unknownPair` rather than guessing. Guessing is the failure mode this design exists to
 * prevent: an unlisted type reaching a default branch and being allowed is how a teacher
 * ends up reading another school's data.
 */

import { deny, grant } from './decide.js';
import {
  type Action,
  type Decision,
  type DenyCode,
  type ImplementedResourceType,
  RESOURCE_LIFECYCLE_STATUSES,
  RESOURCE_VISIBILITIES,
  type Role,
  type Rule,
  type RuleInput,
} from './types.js';

/**
 * Rules for `User`.
 *
 * The shape worth reading twice: a student may update *only themselves*, and only
 * themselves *without* a role change. `changeRole` is a separate action precisely so that
 * "edit my profile" cannot become "make myself a teacher" by virtue of including a role
 * field in the same form. That is the bug `role in the payload` invites, and separating the
 * verb is the whole fix.
 */
const userRules: Record<Action, Rule> = {
  create: (i) =>
    i.actor.roles.includes('platformAdmin') ? grant(['audit']) : deny('roleForbidden'),

  read: (i) => {
    const a = i.actor;
    if (a.roles.includes('platformAdmin')) return grant(['audit']);
    // Self-service read, no audit: a student reading their own profile is not an event.
    return a.id === i.subject.id ? grant([]) : deny('notSelf');
  },

  update: (i) => {
    const a = i.actor;
    if (a.suspended) return deny('suspended');
    if (a.id !== i.subject.id) return deny('notSelf');
    return grant(['audit']);
  },

  // Deleting a User is never a `delete` on User — it is the account-deletion workflow
  // (P1-T5), which anonymises rather than cascades. Denying here is deliberate: if a caller
  // reaches for `delete(User)`, it has skipped the dry run and the audit.
  delete: () => deny('roleForbidden'),

  publish: () => deny('roleForbidden'),
  assign: () => deny('roleForbidden'),
  start: () => deny('roleForbidden'),
  save: (i) => (i.actor.id === i.subject.id ? grant([]) : deny('notSelf')),
  submit: (i) => (i.actor.id === i.subject.id ? grant([]) : deny('notSelf')),

  grade: () => deny('roleForbidden'),
  release: () => deny('roleForbidden'),
  viewEvidence: () => deny('roleForbidden'),
  void: (i) =>
    i.actor.roles.includes('platformAdmin')
      ? grant(['audit', 'reasonRequired'])
      : deny('roleForbidden'),

  excuse: (i) =>
    i.actor.roles.includes('teacher')
      ? grant(['audit', 'reasonRequired', 'sameClassroom'])
      : deny('roleForbidden'),

  regrade: (i) =>
    i.actor.roles.includes('platformAdmin')
      ? grant(['audit', 'twoPersonRelease'])
      : deny('roleForbidden'),

  invite: (i) =>
    i.actor.roles.includes('teacher') ? grant(['audit', 'sameClassroom']) : deny('roleForbidden'),

  removeMember: (i) =>
    i.actor.roles.includes('teacher') ? grant(['audit', 'sameClassroom']) : deny('roleForbidden'),

  changeRole: (i) =>
    i.actor.roles.includes('platformAdmin')
      ? grant(['audit', 'reasonRequired', 'twoPersonRelease'])
      : deny('roleForbidden'),

  importRoster: (i) =>
    i.actor.roles.includes('teacher') ? grant(['audit', 'sameClassroom']) : deny('roleForbidden'),

  export: (i) =>
    i.actor.roles.includes('platformAdmin') ? grant(['audit']) : deny('roleForbidden'),

  // INV-AUTH-4: impersonation is the highest-privilege action in the system, so it is
  // never self-serve and never available to a teacher.
  impersonate: () => deny('roleForbidden'),

  suspend: (i) =>
    i.actor.roles.includes('platformAdmin')
      ? grant(['audit', 'reasonRequired', 'twoPersonRelease'])
      : deny('roleForbidden'),
};

/**
 * Rules for `Asset` (simulations and other binary-ish artifacts).
 *
 * Drafts are mutable by their author; published assets are immutable, because a simulation
 * whose behaviour changes mid-exam invalidates every result computed against the old one.
 * That is `plans/00` §6 immutability applied to assets rather than resource versions.
 */
const assetRules: Record<Action, Rule> = {
  create: (i) =>
    i.actor.roles.includes('teacher') || i.actor.roles.includes('platformAdmin')
      ? grant(['audit'])
      : deny('roleForbidden'),

  read: () => grant([]),

  update: (i) => {
    const a = i.actor;
    if (!a.roles.includes('teacher') && !a.roles.includes('platformAdmin'))
      return deny('roleForbidden');
    if (i.subject.immutable) return deny('immutable');
    // Authors edit their own; admins edit any. Ownership is compared HERE, inside
    // packages/auth, which is the only place the pattern is allowed (eslint rule + CI grep).
    if (a.id !== i.subject.ownerId && !a.roles.includes('platformAdmin')) return deny('notOwner');
    // Ownership is NOT membership. A teacher can own an asset in a classroom they have since
    // been unenrolled from, and ownership alone would keep granting them edit rights over
    // another teacher's materials.
    //
    // This hole was found by `adversarial.test.ts` on its first run — the hand-written
    // scenario said "a teacher cannot update an asset in a classroom they do not belong to"
    // and the matrix disagreed. The generated grid could not have found it: both subjects
    // were owned by the actor, so no cell was anomalous. That is the argument for keeping
    // the scenarios.
    return grant(['audit', ...(i.subject.owningClassroomId ? (['sameClassroom'] as const) : [])]);
  },

  delete: (i) => {
    const a = i.actor;
    if (!a.roles.includes('platformAdmin') && !a.roles.includes('teacher'))
      return deny('roleForbidden');
    if (i.subject.immutable) return deny('immutable');
    if (a.id !== i.subject.ownerId && !a.roles.includes('platformAdmin')) return deny('notOwner');
    return grant(['audit', ...(i.subject.owningClassroomId ? (['sameClassroom'] as const) : [])]);
  },

  publish: (i) => {
    const a = i.actor;
    if (!a.roles.includes('teacher') && !a.roles.includes('platformAdmin'))
      return deny('roleForbidden');
    if (i.subject.immutable) return deny('immutable');
    // Publishing is scoped too. A teacher who authored an asset in a classroom they have
    // left must not be able to release it to students there.
    return grant([
      'audit',
      'twoPersonRelease',
      ...(i.subject.owningClassroomId ? (['sameClassroom'] as const) : []),
    ]);
  },

  assign: () => deny('roleForbidden'),
  start: () => grant([]),
  save: (i) => (i.actor.id === i.subject.ownerId ? grant([]) : deny('notOwner')),
  submit: (i) => (i.actor.id === i.subject.ownerId ? grant([]) : deny('notOwner')),
  grade: () => deny('roleForbidden'),
  release: () => deny('roleForbidden'),
  viewEvidence: (i) =>
    i.actor.roles.includes('reviewer') ? grant(['retainEvidence']) : deny('reviewerForbidden'),
  void: (i) =>
    i.actor.roles.includes('platformAdmin')
      ? grant(['audit', 'reasonRequired'])
      : deny('roleForbidden'),
  excuse: () => deny('roleForbidden'),
  regrade: () => deny('roleForbidden'),
  invite: () => deny('roleForbidden'),
  removeMember: () => deny('roleForbidden'),
  changeRole: () => deny('roleForbidden'),
  importRoster: () => deny('roleForbidden'),
  export: (i) =>
    i.actor.roles.includes('platformAdmin') ? grant(['audit']) : deny('roleForbidden'),
  impersonate: () => deny('roleForbidden'),
  suspend: () => deny('roleForbidden'),
};

/**
 * The rule for every classroom-scoped action, in one place.
 *
 * ## Why this is a function and not three sets of near-identical rules
 *
 * INV-CLASS-1 says access is a property of MEMBERSHIP, not of role. Getting that right means
 * asking the same three questions on every action: is the actor in the classroom, are they the
 * owner, are they the subject. Written inline per action, that is 60-odd chances to forget
 * the membership check on one of them — and forgetting it on exactly one action is a breach
 * that no test of the others will catch.
 *
 * So `classroomScoped` is the single implementation, and Classroom/Enrollment/Invitation each
 * declare which of the three relationships grants access. A new action on a new
 * classroom-scoped type is then one line rather than a fresh opportunity to be wrong.
 */
const classroomScoped = (input: {
  /** A subject OWNED by the actor. */
  owner?: (i: RuleInput) => boolean;
  /** An Enrollment held BY the actor in the subject's classroom. */
  member?: (i: RuleInput) => boolean;
  /** The subject is ABOUT the actor, or belongs to them. */
  self?: (i: RuleInput) => boolean;
  /**
   * Roles the actor must hold, IN ADDITION to the relationship above.
   *
   * This exists because the first version of this helper had only relationships, and the
   * consequence was that MEMBERSHIP GRANTED AUTHORITY: a student enrolled in a class could
   * `grade` it, because they were a member. Being in a class is not being in charge of it.
   *
   * The relationship says "inside the boundary"; this says "allowed to do this". Both are
   * needed, and conflating them is a breach — a student marking their own work is the exact
   * scenario the whole kernel exists to prevent.
   */
  roles?: readonly Role[];
  /** Platform admins bypass the relationship, but NOT the role list. */
  admin?: boolean;
  /** What to do when neither the relationship nor the admin path holds. */
  otherwise?: DenyCode;
}) => {
  return (i: RuleInput): Decision => {
    // `const roles` rather than `input.roles!` twice. The non-null assertion was needed
    // because TypeScript cannot see that the `!== undefined` guard above holds inside the
    // callback, and an assertion there would hide a future edit that moved the check.
    const roles = input.roles;
    if (roles !== undefined && !i.actor.roles.some((r) => roles.includes(r))) {
      return deny('roleForbidden');
    }
    if (input.admin === true && i.actor.roles.includes('platformAdmin')) {
      return grant(['audit']);
    }
    if (input.owner?.(i) === true) return grant(['audit', 'sameClassroom']);
    if (input.member?.(i) === true) return grant(['sameClassroom']);
    if (input.self?.(i) === true) return grant([]);
    return deny(input.otherwise ?? 'wrongClassroom');
  };
};

/**
 * Whether the actor is a member of the classroom this action is happening in.
 *
 * Exported so it can be tested DIRECTLY against every shape of malformed context, which is
 * where a membership check goes wrong. Every one of these returns false:
 *
 *   · no context at all
 *   · `context: {}`
 *   · a membership set but no scope
 *   · a scope but no membership set
 *   · a scope the actor is not in
 *   · a scope of `''` (which is why the fallback below is `''` and the comparison is
 *     `=== true` rather than truthy: an empty-string scope must not be "found" in a set)
 *
 * The `=== true` at the end keeps the three short-circuit cases (no context, no set) explicitly
 * FALSE rather than `undefined`, so the return type is `boolean` and a caller cannot pass the
 * result somewhere truthiness would treat it as a decision. It does not change any answer — it
 * makes the answer's type honest.
 */
export function isMemberOfScope(context: RuleInput['context']): boolean {
  return context?.actorClassroomIds?.has(context.scopeClassroomId ?? '') === true;
}

/** True when the actor is enrolled in the scope this action is happening in. */
const isMember = (i: RuleInput): boolean => isMemberOfScope(i.context);

/** True when the actor owns the subject. Ownership is read from `ownerId`, inside this package. */
const isOwner = (i: RuleInput): boolean => i.actor.id === i.subject.ownerId;

/**
 * A blanket denial for the actions that make no sense on a classroom-joined record.
 *
 * `create`, `read`, `update` and `delete` are DELIBERATELY NOT HERE. Both Enrollment and
 * Invitation override all four, so entries for them were unreachable — the coverage report
 * found them. Removing them is not tidiness: with the `satisfies Record<Action, Rule>` clause
 * on each rules object, an omission is then a COMPILE error, so a new classroom-scoped type
 * cannot silently inherit a blanket deny for `delete` by forgetting to think about it.
 *
 * Aliasing is the thing being prevented. `changeRole` folded into `update` would be a way to
 * change a role through the wrong door, which is the same class of bug as `resource.ownerId ===
 * session.userId`.
 *
 * Typed `Record<Action, Rule>`, COMPLETE. Typed `Partial` instead would be tidier and
 * unsound: TypeScript cannot prove that spreading a `Partial` fills every key, so the
 * completeness check would vanish entirely. A `Record` spread is statically total.
 *
 * So the `Invitation.update` problem is not solved by types — it is solved by
 * `OVERRIDDEN_ACTIONS_ARE_EXPLICIT` in the test, which asserts that each consumer defines those
 * four actions itself rather than inheriting the blanket deny. Types prove the matrix is
 * total; a test proves the dangerous cells were actually thought about. Two mechanisms, each
 * doing what it is actually good at.
 */
export const notAvailable: Record<Action, Rule> = {
  // Restored so the spread is statically total. The test asserts they are overridden.
  create: () => deny('roleForbidden'),
  read: () => deny('roleForbidden'),
  update: () => deny('roleForbidden'),
  delete: () => deny('roleForbidden'),
  publish: () => deny('roleForbidden'),
  assign: () => deny('roleForbidden'),
  start: () => deny('roleForbidden'),
  save: () => deny('roleForbidden'),
  submit: () => deny('roleForbidden'),
  grade: () => deny('roleForbidden'),
  release: () => deny('roleForbidden'),
  viewEvidence: () => deny('roleForbidden'),
  void: () => deny('roleForbidden'),
  excuse: () => deny('roleForbidden'),
  regrade: () => deny('roleForbidden'),
  invite: () => deny('roleForbidden'),
  removeMember: () => deny('roleForbidden'),
  changeRole: () => deny('roleForbidden'),
  importRoster: () => deny('roleForbidden'),
  export: () => deny('roleForbidden'),
  impersonate: () => deny('roleForbidden'),
  suspend: () => deny('roleForbidden'),
};

const classroomRules: Record<Action, Rule> = {
  // A teacher creates a classroom. Email verification is required first (plans/13 §1), which
  // the ROUTE guard already checks for /classrooms/new — repeated here because a route guard
  // cannot know the intent of a request made some other way.
  create: (i) =>
    i.actor.roles.includes('teacher') || i.actor.roles.includes('platformAdmin')
      ? grant(['audit', 'sameClassroom'])
      : deny('roleForbidden'),

  // INV-CLASS-1. Owner, member, or nobody. Note what is NOT a grant: being a teacher is not
  // enough, and neither is being anyone at all in the same school.
  read: classroomScoped({ owner: isOwner, member: isMember, admin: true }),

  update: classroomScoped({ owner: isOwner }),

  // Deleting a classroom is OWNER-or-ADMIN, and it is the one destructive classroom action, so
  // it carries a reason: a classroom cannot be un-deleted, and "why did this disappear" needs
  // an answer.
  delete: (i) => {
    if (i.actor.roles.includes('platformAdmin'))
      return grant(['audit', 'reasonRequired', 'twoPersonRelease']);
    return isOwner(i) ? grant(['audit', 'reasonRequired']) : deny('notOwner');
  },

  publish: classroomScoped({ owner: isOwner }),
  assign: classroomScoped({ owner: isOwner }),

  // Running a classroom-scoped exam: any member. A student is the main consumer.
  start: classroomScoped({ owner: isOwner, member: isMember }),
  save: classroomScoped({ owner: isOwner, self: (i) => i.actor.id === i.subject.ownerId }),
  submit: classroomScoped({ owner: isOwner, self: (i) => i.actor.id === i.subject.ownerId }),

  // A teacher grades within their own classroom and nowhere else. This is the cell the
  // adversarial scenario "a teacher from classroom A cannot grade in classroom B" is about.
  grade: classroomScoped({
    owner: isOwner,
    member: isMember,
    roles: ['teacher'],
    otherwise: 'notMember',
  }),

  // Releasing results to students is OWNER-only, not member-only. A student member could
  // otherwise release the results of their own exam to the whole class.
  release: classroomScoped({ owner: isOwner }),

  // Integrity evidence is NOT visible to the classroom's own teacher. The reviewer role exists
  // precisely so that a teacher cannot review the evidence about their own class, and a
  // teacher-may-see rule here would quietly defeat that separation.
  viewEvidence: (i) =>
    i.actor.roles.includes('reviewer') ? grant(['retainEvidence']) : deny('reviewerForbidden'),

  void: (i) =>
    i.actor.roles.includes('platformAdmin')
      ? grant(['audit', 'reasonRequired'])
      : deny('roleForbidden'),
  excuse: (i) =>
    i.actor.roles.includes('platformAdmin')
      ? grant(['audit', 'reasonRequired', 'sameClassroom'])
      : deny('roleForbidden'),

  // Re-grading an entire exam is owner-or-admin with two-person release: it rewrites every
  // student's mark, which is the single highest-blast-radius action in a classroom.
  regrade: (i) => {
    if (i.actor.roles.includes('platformAdmin')) return grant(['audit', 'twoPersonRelease']);
    return isOwner(i) ? grant(['audit', 'twoPersonRelease', 'sameClassroom']) : deny('notOwner');
  },

  invite: classroomScoped({ owner: isOwner }),
  removeMember: classroomScoped({ owner: isOwner }),
  changeRole: () => deny('roleForbidden'),
  importRoster: classroomScoped({ owner: isOwner }),

  // Exporting a classroom roster is PII: it is every child's name and email in one document.
  // Owner only, and audited, and it is the action most likely to end up in someone's inbox.
  export: (i) => (isOwner(i) ? grant(['audit']) : deny('notOwner')),

  impersonate: () => deny('roleForbidden'),
  suspend: () => deny('roleForbidden'),
};

const enrollmentRules: Record<Action, Rule> = {
  ...notAvailable,
  create: classroomScoped({ owner: isOwner }),
  // A student reads their OWN enrollment, and a teacher reads enrollments in their classroom.
  // Nothing else. An enrollment is the record of a child being in a class.
  read: classroomScoped({ owner: isOwner, self: (i) => i.actor.id === i.subject.ownerId }),
  update: classroomScoped({ owner: isOwner }),
  delete: classroomScoped({ owner: isOwner }),
  export: (i) => (isOwner(i) ? grant(['audit']) : deny('notOwner')),
};

const invitationRules: Record<Action, Rule> = {
  ...notAvailable,
  // Inviting is OWNER-only. A student cannot invite, and a teacher cannot invite into a
  // classroom they do not own.
  create: classroomScoped({ owner: isOwner }),
  // The INVITEE reads their own invitation — otherwise they cannot accept it, and a student
  // has to be able to see an invitation addressed to them without being enrolled.
  read: classroomScoped({ owner: isOwner, self: (i) => i.actor.id === i.subject.forUserId }),
  delete: classroomScoped({ owner: isOwner, self: (i) => i.actor.id === i.subject.forUserId }),
  // An invitation is a PENDING TOKEN, not a record you edit. It is created, read, accepted or
  // declined, and then it is deleted. There is deliberately no way to "update" one.
  //
  // This rule is EXPLICIT because `Invitation.update` previously had none and silently inherited
  // a blanket deny through the `...notAvailable` spread. The behaviour was right; the
  // invisibility was not, and removing the spread entries from `notAvailable` turned the
  // omission into a compile error. That is D-14's completeness check doing exactly its job.
  update: () => deny('roleForbidden'),
};

/**
 * THE MATRIX. One entry per implemented type, one rule per action, no gaps.
 *
 * The `satisfies` clause is what makes a missing cell a COMPILE error rather than a
 * `can()` that quietly returns `unknownPair` at runtime for a type the author believed was
 * covered.
 */

/** True when the actor is in ANY classroom this resource is shared into. */
const sharesWith = (i: RuleInput): boolean => {
  const shared = i.subject.sharedClassroomIds;
  const mine = i.context?.actorClassroomIds;
  if (!shared || !mine) return false;
  for (const c of shared) if (mine.has(c)) return true;
  return false;
};

const isAdmin = (i: RuleInput): boolean => i.actor.roles.includes('platformAdmin');
const mayManage = (i: RuleInput): boolean =>
  i.actor.roles.includes('teacher') || i.actor.roles.includes('platformAdmin');

/**
 * Is this resource visible to this actor AT ALL?  (P2-T8)
 *
 * The order is the design. Status before visibility, because a resource can be both PRIVATE
 * and WITHDRAWN and "you are the owner" must not become a way to see a withdrawn resource
 * while it is being corrected — except for the owner, who is the one fixing it.
 *
 * The four `notVisible` denies at the end are the ones that matter most: an UNRECOGNISED status
 * or visibility denies rather than defaulting to a tier. A default branch here would be the
 * exact failure this matrix was built to prevent — a new status shipped in a migration and not
 * yet in this list would otherwise inherit PUBLIC.
 */
const resourceVisible = (i: RuleInput): boolean => {
  if (i.actor.suspended && !isAdmin(i)) return false;

  const status = i.subject.lifecycleStatus;
  const visibility = i.subject.visibility;
  // Deny on anything UNRECOGNISED, not merely on anything undefined.
  //
  // The first version of this checked `status === undefined` and then fell through to the
  // visibility branches — so `{ status: 'IN_REVIEW', visibility: 'PUBLIC' }` returned TRUE and
  // was world-readable. `undefined` and "a value I do not recognise" are the same danger, and
  // the second is the one a migration produces. A status added by a migration before this list
  // is updated would otherwise be silently PUBLIC, and the symptom would be a content leak
  // reported by somebody's parent.
  //
  // Membership is checked against the LISTS in `types.ts` rather than a `switch`, so adding a
  // status to the vocabulary cannot leave a stale deny here: the exhaustive switch would
  // compile, this cannot.
  if (status === undefined || !RESOURCE_LIFECYCLE_STATUSES.includes(status)) return false;
  if (visibility === undefined || !RESOURCE_VISIBILITIES.includes(visibility)) return false;

  if (status === 'WITHDRAWN') return isOwner(i) || isAdmin(i);
  if (status === 'DRAFT') return isOwner(i) || isAdmin(i);

  if (visibility === 'PUBLIC') return true;
  // UNLISTED and PRIVATE differ ONLY in search (see `visibleInSearch`), not in readability.
  return isOwner(i) || isAdmin(i) || sharesWith(i);
};

const resourceRules: Record<Action, Rule> = {
  // ALL 22 written out, not `...notAvailable`. The spread looks tidier and is a trap twice
  // over: placed last it OVERWRITES the explicit rules above it, silently reducing the whole
  // type to a blanket deny, and placed first it makes a future key in `notAvailable` apply to
  // Resource without anyone deciding that. Both happened here in the same afternoon.
  create: (i) => (mayManage(i) ? grant(['audit']) : deny('roleForbidden')),

  // A permission checked on write is not a permission. This is the re-check `plans/05` and the
  // P2-T8 packet both demand, and it is a RULE rather than a call site so it cannot be
  // forgotten at the one endpoint somebody adds in P3.
  read: (i) => (resourceVisible(i) ? grant([]) : deny('notVisible')),

  // Content edits: owner or admin, and only on something they can see.
  update: (i) => {
    if (!resourceVisible(i)) return deny('notVisible');
    return isOwner(i) || isAdmin(i) ? grant(['audit']) : deny('notOwner');
  },

  // Deleting removes a colleague's work, so it needs the role AND the ownership, and it
  // carries a reason: a resource cannot be un-deleted, so "why did this disappear" needs an
  // answer. Same reasoning as `Classroom.delete`.
  delete: (i) => {
    if (!resourceVisible(i)) return deny('notVisible');
    if (!mayManage(i)) return deny('roleForbidden');
    if (!isOwner(i) && !isAdmin(i)) return deny('notOwner');
    return grant(['audit', 'reasonRequired']);
  },

  // Lifecycle is ROLE-gated, never ownership-gated. `Resource` is teacher-authored in plans/01
  // and students author `SimDraft`, so a student holding a Resource is an invariant violation
  // and this denies rather than repairs. The first version let `delete` fall through to the
  // ownership check, which would have let a student delete a resource they somehow owned — and
  // that bug is invisible in review, because `canEdit` genuinely does grant part of it.
  publish: (i) => {
    if (!resourceVisible(i)) return deny('notVisible');
    if (!mayManage(i)) return deny('roleForbidden');
    return isOwner(i) || isAdmin(i) ? grant(['audit']) : deny('notOwner');
  },

  // ── Actions that mean nothing on a Resource, denied individually ──
  //
  // A shared `deny()` helper would be shorter and would hide the reasoning, which is the part
  // worth having. Each group below says WHY in one line, so a future reader asking "why can a
  // resource not be graded?" gets an answer rather than a shrug.

  // A Resource is content, not an assessment. The assessment surface is Assignment/ExamAttempt.
  assign: () => deny('roleForbidden'),
  start: () => deny('roleForbidden'),
  // `save` is a student-side autosave verb; a student's draft is a SimDraft, not a Resource.
  save: () => deny('roleForbidden'),
  submit: () => deny('roleForbidden'),
  grade: () => deny('roleForbidden'),
  // Releasing RESULTS is `ReleaseBatch`, keyed on an Assignment. A Resource has no results.
  release: () => deny('roleForbidden'),
  // Integrity evidence is about a student's attempt, never about a piece of content. Denying
  // this is what stops a teacher reading the telemetry about their own class.
  viewEvidence: () => deny('reviewerForbidden'),
  void: () => deny('roleForbidden'),
  excuse: () => deny('roleForbidden'),
  regrade: () => deny('roleForbidden'),
  // Roster actions are classroom-shaped. A Resource is shared into a classroom; it does not
  // hold one, so inviting somebody to a "resource" is a category error, not a missing feature.
  invite: () => deny('roleForbidden'),
  removeMember: () => deny('roleForbidden'),
  changeRole: () => deny('roleForbidden'),
  importRoster: () => deny('roleForbidden'),
  // Export is a whole-document operation, not a per-resource one, and it is handled by the
  // export/delete-queue path under `User.export`. Granting it here would hand out the
  // capability to extract one child's history from a single content row.
  export: () => deny('roleForbidden'),
  // A platform admin impersonating a teacher to check a Resource would be impersonating the
  // one role whose ownership grants visibility. Denied outright.
  impersonate: () => deny('roleForbidden'),
  suspend: () => deny('roleForbidden'),
};

export const MATRIX = {
  User: userRules,
  Asset: assetRules,
  Classroom: classroomRules,
  Enrollment: enrollmentRules,
  Invitation: invitationRules,
  Resource: resourceRules,
  // Keyed on `IMPLEMENTED_TYPES`, not on the full `ALL_RESOURCE_TYPES` list.
  //
  // Keying on all 22 would be nice — it would make an unimplemented type a compile error —
  // but it would also make the file uncompilable until P16, because the plan deliberately
  // adds one type per phase. So totality is asserted over the types the matrix CLAIMS, and
  // `matrix.test.ts` separately asserts that the claim list is a subset of the real type
  // list and matches the matrix's own keys exactly. Two tests, because there are two
  // different mistakes to catch: claiming a type you did not implement, and implementing a
  // type you did not claim.
} satisfies Record<ImplementedResourceType, Record<Action, Rule>>;

export type ImplementedType = keyof typeof MATRIX;

/**
 * The four actions every consumer of `notAvailable` must define ITSELF.
 *
 * Exported so the test can assert it. `create`/`read`/`update`/`delete` are the ones where
 * inheriting a blanket deny is plausible and where a blanket deny is a decision rather than a
 * non-decision: `Invitation.update` had no rule at all for most of this task's life, and the
 * spread hid it.
 */
export const OVERRIDDEN_ACTIONS_ARE_EXPLICIT = ['create', 'read', 'update', 'delete'] as const;

export const CONSUMERS_OF_NOT_AVAILABLE: Readonly<Record<string, Record<Action, Rule>>> = {
  Enrollment: enrollmentRules,
  Invitation: invitationRules,
  Resource: resourceRules,
};

/** All cells, flattened. `(action, type)` pairs — the totality domain. */
export function* cells(): Generator<{ type: ImplementedType; action: Action; rule: Rule }> {
  for (const [type, rules] of Object.entries(MATRIX) as [ImplementedType, Record<Action, Rule>][]) {
    for (const [action, rule] of Object.entries(rules) as [Action, Rule][]) {
      yield { type, action, rule };
    }
  }
}

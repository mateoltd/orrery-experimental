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
    if (a.id === i.subject.id) return grant([]);

    // P4-T8. §4: "View student personal details — Owner ✓, Teacher ✓, self only", and this rule
    // was SELF-OR-ADMIN, which is §4's third column and not its first two. A teacher could not
    // read a student at all — so the roster page's per-student summary had no authorisation
    // behind it, and the exhaustive test found it by transcribing a row nobody had implemented.
    //
    // The grant is "a classroom we BOTH belong to", read from the subject's `sharedClassroomIds`
    // and the context's `actorClassroomIds`. Both are needed and neither is enough: a teacher in
    // class A cannot read a student in class B, because A is not in the student's shared set, and
    // because the teacher's set does not contain B. Two schools cannot grant this to each other by
    // existing in the same tenant.
    //
    // `audit` is claimed, because reading a child's record is exactly the event an operator
    // should be able to account for. Self-service is not, and the two are different enough to
    // matter: auditing every student opening their own profile buries the real reads.
    const shared = i.subject.sharedClassroomIds;
    const mine = i.context?.actorClassroomIds;
    if (shared !== undefined && mine !== undefined) {
      for (const id of shared) {
        if (mine.has(id)) return grant(['audit']);
      }
    }
    return deny('notSelf');
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
  adjudicate: () => deny('roleForbidden'),
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

  // A person is not transferred. Giving this action a rule here would mean transferring an
  // account, which is either a rename (and so `update`) or an account takeover (and so
  // impersonation, already separately denied above). The third possibility — changing who a
  // user IS — is a deletion and a creation, not a transfer.
  transfer: () => deny('roleForbidden'),

  export: (i) =>
    i.actor.roles.includes('platformAdmin') ? grant(['audit']) : deny('roleForbidden'),

  // INV-AUTH-4: impersonation is the highest-privilege action in the system, so it is
  // never self-serve and never available to a teacher.
  impersonate: () => deny('roleForbidden'),

  suspend: (i) =>
    i.actor.roles.includes('platformAdmin')
      ? grant(['audit', 'reasonRequired', 'twoPersonRelease'])
      : deny('roleForbidden'),

  // ── P3-T5. The moderation verbs mean nothing on a User, an Asset or a Classroom. ──
  //
  // They are about a piece of content and the people speaking about it, and a rule that
  // granted `moderate(Asset)` would be a rule about hiding a photograph rather than a
  // comment, which is a different action with different rules entirely. Denied individually
  // rather than inherited, so that `satisfies Record<Action, Rule>` keeps the obligation to
  // have thought about each one.
  rate: () => deny('roleForbidden'),
  comment: () => deny('roleForbidden'),
  flag: () => deny('roleForbidden'),
  moderate: (i) =>
    i.actor.roles.includes('platformAdmin') || i.actor.roles.includes('reviewer')
      ? grant(['audit'])
      : deny('reviewerForbidden'),
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
  // P4-T8: adjudicating a verdict is reviewer-only everywhere else, and this says so by
  // refusing rather than by omission. The action is new; the reviewer's standing is not.
  adjudicate: () => deny('reviewerForbidden'),
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
  // An Asset belongs to whoever uploaded it, and `plans/13` gives assets no owner-transfer
  // story. Denied explicitly rather than left to inherit a default, so that adding one later is
  // a visible change rather than a behaviour that appears without anyone writing it.
  transfer: () => deny('roleForbidden'),

  export: (i) =>
    i.actor.roles.includes('platformAdmin') ? grant(['audit']) : deny('roleForbidden'),
  impersonate: () => deny('roleForbidden'),
  suspend: () => deny('roleForbidden'),

  // ── P3-T5. The moderation verbs mean nothing on a User, an Asset or a Classroom. ──
  //
  // They are about a piece of content and the people speaking about it, and a rule that
  // granted `moderate(Asset)` would be a rule about hiding a photograph rather than a
  // comment, which is a different action with different rules entirely. Denied individually
  // rather than inherited, so that `satisfies Record<Action, Rule>` keeps the obligation to
  // have thought about each one.
  rate: () => deny('roleForbidden'),
  comment: () => deny('roleForbidden'),
  flag: () => deny('roleForbidden'),
  moderate: (i) =>
    i.actor.roles.includes('platformAdmin') || i.actor.roles.includes('reviewer')
      ? grant(['audit'])
      : deny('reviewerForbidden'),
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
  /** An Enrollment held BY the actor in the subject's classroom, at ANY role. */
  member?: (i: RuleInput) => boolean;
  /**
   * An Enrollment held BY the actor in the subject's classroom, at one of THESE roles.  (P4-T8)
   *
   * This exists because `member` is role-blind, and §4's table is not. "Manage members and roles:
   * Teacher ✓ (not owner)" and "Grade and release: Teacher ✓" are both about being a teacher IN
   * THIS CLASSROOM, and the only other signal a rule had was `actor.roles`, which is the GLOBAL
   * role. A teacher enrolled as a STUDENT in someone else's room therefore satisfied
   * `member && actor.roles.includes('teacher')` and could grade it — the same
   * "membership grants authority" mistake, one level up.
   *
   * It takes the LIST the action needs rather than a predicate, so a rule reads like the table
   * it came from: `staff: ['TEACHER']`. The first version of this took a single role and matched
   * it against every STAFF role, which granted grading to REVIEWERs — a reviewer is staff, so
   * "is this actor staff" is true, and the action nobody wanted a reviewer to have.
   */
  staff?: readonly string[];
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
    // A role-scoped membership is checked BEFORE the role-blind one, so a rule that asks for
    // "teacher in this classroom" cannot be satisfied by "in this classroom".
    const staff = input.staff;
    if (staff !== undefined) {
      if (holdsAnyRoleInScope(i, staff)) return grant(['audit', 'sameClassroom']);
      // In the room, but not at a role this action needs.
      //
      // The deny code matters more than it looks. Falling through to `otherwise` gave a REVIEWER
      // who IS enrolled `notMember`, which is a lie an operator triages on: it says "they are not
      // in this class" about somebody who is. The honest code is `roleForbidden`.
      //
      // ONLY when the rule does not also accept plain membership. The first version fired
      // unconditionally and broke `read(ExamAttempt)` for every student, because that rule
      // accepts `member` AND `staff` — a student satisfies the second and not the first, and the
      // shortcut answered before the `member` branch was reached.
      if (input.member === undefined && isMemberOfScope(i.context)) return deny('roleForbidden');
    }
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

/**
 * True when the actor's role IN THE SCOPED CLASSROOM is one of `roles`.
 *
 * The owner is deliberately not in here even though `OWNER` is a role the database can hold: a
 * subject that is its own scope is granted by the `owner` relationship one line above, and a
 * teacher who owns a room without an enrollment row is already covered. Listing `OWNER` would be
 * harmless and would add a second way to be granted the same thing.
 */
/**
 * The one list §4's table produces, named once.  (P4-T8)
 *
 * `OWNER` is IN it, and that is the fix for a mistake worth reading. The exhaustive test's OWNER
 * column was failing on `changeRole(Enrollment)` because `classroomScoped`'s `owner` branch
 * compares `subject.ownerId` — and for an Enrollment, `ownerId` is the STUDENT. So "is the owner"
 * was being answered about the child rather than about the classroom.
 *
 * The honest answer is that §4's OWNER column means the owner OF THE CLASSROOM, everywhere except
 * the "own results" row — and the classroom owner holds the `OWNER` enrollment role, because
 * `createClassroom` writes one. So the owner's grant belongs here, on the CLASSROOM role, and the
 * `owner` branch on a `Classroom` subject is the separate question of who owns that row.
 *
 * `REVIEWER` is staff and is NOT in it. A reviewer moderates; §4 does not give them grades, and a
 * list that said "any staff" would have handed them the marking queue.
 */
const CLASSROOM_TEACHERS = ['OWNER', 'TEACHER'] as const;

/** The same, plus the reviewer, for the evidence a classroom's staff need to see. */
const CLASSROOM_EVIDENCE = ['OWNER', 'TEACHER', 'REVIEWER'] as const;

const holdsAnyRoleInScope = (i: RuleInput, roles: readonly string[]): boolean => {
  const context = i.context;
  if (context === undefined) return false;
  const scope = context.scopeClassroomId;
  if (scope === undefined) return false;
  const held = context.actorClassroomRoles?.[scope];
  return held !== undefined && roles.includes(held);
};

/** True when the actor owns the subject. Ownership is read from `ownerId`, inside this package. */
const isOwner = (i: RuleInput): boolean => i.actor.id === i.subject.ownerId;

/**
 * The author-side of the public feedback surface: may this ACTOR speak about this RESOURCE?
 *  (P3-T5)
 *
 * One helper for `rate`, `comment` and `flag`, because the three checks are the same check and
 * a rule that is easy to get subtly wrong is better written once.
 *
 * The checks, and why each is here rather than in a service:
 *
 *   1. **Not suspended.** A suspended account is not silenced, it is stopped. It can already
 *      read nothing (`resourceVisible` says so), and a person who can see nothing should not be
 *      able to leave a public rating about something they cannot see.
 *   2. **Can see it.** Same reason, and it also stops a blind flag: a report about content the
 *      reporter cannot read is either a mistake or the first step of a harassment campaign
 *      against a private resource, and both should need the same answer.
 *   3. **Not the author.** A teacher rating their own lesson five stars, or replying to their
 *      own thread, is not feedback — it is a self-assessment presented as a stranger's
 *      opinion, and it moves a public average. This is the check that is easiest to forget,
 *      because a self-rating looks like an ordinary request.
 *
 * No `audit` obligation. A rating is a number in an average and a comment is a line in a
 * thread; both are cheap to retract and neither is a decision about a child's record. The
 * moment that stops being true is the moment this needs one, and the comment says which.
 */
const strangerAct = (i: RuleInput) => {
  if (i.actor.suspended && !isAdmin(i)) return deny('suspended');
  if (!resourceVisible(i)) return deny('notVisible');
  if (isOwner(i)) return deny('notSelf');
  return grant([]);
};

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
  adjudicate: () => deny('roleForbidden'),
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
  // Blanket deny, and the reason is the hazard rather than a feature gap. `transfer` is
  // high-blast-radius: it changes who can see a subject, edit it, and answer for it. Folding it
  // into `update` would hand every "rename this" request the power to hand over somebody's
  // account or somebody's lesson. Only `Resource` and `Classroom` have real rules.
  transfer: () => deny('roleForbidden'),
  // P3-T5. The moderation verbs mean nothing on a User, an Asset or a Classroom: they are
  // about a piece of content and the people speaking about it. Denied individually rather
  // than inherited so that `satisfies Record<Action, Rule>` keeps the obligation to think
  // about each one.
  rate: () => deny('roleForbidden'),
  comment: () => deny('roleForbidden'),
  flag: () => deny('roleForbidden'),
  moderate: (i) =>
    i.actor.roles.includes('platformAdmin') || i.actor.roles.includes('reviewer')
      ? grant(['audit'])
      : deny('reviewerForbidden'),
};

const classroomRules: Record<Action, Rule> = {
  // A teacher creates a classroom. Email verification is required first (plans/13 §1), which
  // the ROUTE guard already checks for /classrooms/new — repeated here because a route guard
  // cannot know the intent of a request made some other way.
  // `audit`, and NOT `sameClassroom`.
  //
  // P4-T1 found this by calling it. `sameClassroom` means "this action happens inside a
  // classroom the actor is a member of" — it requires a `context.scopeClassroomId` and a subject
  // that HAS an `owningClassroomId`, and a classroom being CREATED has neither. The obligation
  // was unsatisfiable at exactly the moment it was claimed, so every call returned
  // `wrongClassroom` and `createClassroom` could not create anything.
  //
  // The fix is to drop the obligation rather than to fake a scope, and the reasoning is that the
  // two actions mean different things: `update`, `publish` and `grade` happen INSIDE a
  // classroom, while creation ESTABLISHES one. An obligation that cannot be satisfied by a
  // correct caller is not a check, it is a wall.
  create: (i) =>
    i.actor.roles.includes('teacher') || i.actor.roles.includes('platformAdmin')
      ? grant(['audit'])
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

  // §4: "Create / publish assignments — Owner ✓, Teacher ✓". Owner-only was WRONG and this row
  // was written that way: a co-teacher could not publish an assignment in the class they were
  // employed to teach. §4 lists the teacher grant explicitly, so the rule now asks for the
  // CLASSROOM role rather than accepting any member — otherwise a REVIEWER, who is staff and
  // must not publish, would be included by the same edit.
  publish: classroomScoped({ owner: isOwner, staff: CLASSROOM_TEACHERS }),
  assign: classroomScoped({ owner: isOwner, staff: CLASSROOM_TEACHERS }),

  // Running a classroom-scoped exam: any member. A student is the main consumer.
  start: classroomScoped({ owner: isOwner, member: isMember }),
  save: classroomScoped({ owner: isOwner, self: (i) => i.actor.id === i.subject.ownerId }),
  submit: classroomScoped({ owner: isOwner, self: (i) => i.actor.id === i.subject.ownerId }),

  // A teacher grades within their own classroom and nowhere else. This is the cell the
  // adversarial scenario "a teacher from classroom A cannot grade in classroom B" is about.
  // The cell the adversarial scenario "a teacher from classroom A cannot grade in classroom B"
  // is about — and it was ALSO wrong, in the other direction. `member && roles: ['teacher']`
  // granted grading to any member who happened to hold the GLOBAL teacher role, including a
  // teacher enrolled as a STUDENT in someone else's room. `classroomRole('TEACHER')` asks the
  // question that was actually meant: are you a teacher IN THIS CLASSROOM.
  grade: classroomScoped({
    owner: isOwner,
    staff: CLASSROOM_TEACHERS,
    otherwise: 'notMember',
  }),

  // Releasing results to students is OWNER-only, not member-only. A student member could
  // otherwise release the results of their own exam to the whole class.
  release: classroomScoped({ owner: isOwner }),

  // §4 says "View integrity evidence — Owner ✓, Teacher ✓", and the P1 version of this rule
  // said REVIEWER ONLY, which contradicts the plan.
  //
  // ## The conflict, stated rather than quietly resolved
  //
  // The reviewer-only rule was not a mistake: its comment said a teacher must not review the
  // evidence about their OWN class, because that is the conflict of interest the reviewer role
  // exists to prevent. That is a real concern. But `viewEvidence` is a READ, and the reviewer
  // role exists to control the ADJUDICATION of a verdict — a different action, and one this
  // codebase keeps separate by keeping the verdict itself out of the actor's hands.
  //
  // A school also needs its own teacher to see the proctoring record: the proctor says "this
  // student's exam had three fullscreen exits" and the teacher is the person who has to act on
  // it. Refusing them the evidence makes the proctoring record unreadable to the only person
  // with the standing to act.
  //
  // So: the plan wins, and the separation of duties is preserved by the verdict, not by the
  // evidence. This is a PLAN-VERSUS-CODE disagreement and it is recorded in the tracker rather
  // than left to be rediscovered as a "bug" in six months.
  viewEvidence: classroomScoped({
    owner: isOwner,
    // Teacher AND reviewer, because the plan grants the classroom's staff the evidence and the
    // split to `adjudicate` is what preserves the separation of duties.
    staff: CLASSROOM_EVIDENCE,
    otherwise: 'reviewerForbidden',
  }),
  // Adjudicating a verdict is still reviewer-only, and now explicitly so.
  adjudicate: (i) =>
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

  // P4-T2. §4 of `plans/12` says "Manage members and roles: OWNER ✓, TEACHER ✓ (not owner)",
  // and the P1 version of these three rules said owner-only for two of them and DENIED the
  // third outright. A deputy head of year who cannot add a student is a product decision nobody
  // made, and a teacher who cannot change a role is a missing feature the plan had already
  // specified.
  //
  // `roles: ['teacher']` is what stops a STUDENT who is a member from managing the roster: the
  // `member` relationship says "inside the boundary" and the role says "allowed to do this",
  // and both are needed. The owner passes through the `owner` branch, so a teacher-only
  // requirement does not lock them out of their own room.
  invite: classroomScoped({ owner: isOwner, member: isMember, roles: ['teacher'] }),
  removeMember: classroomScoped({ owner: isOwner, member: isMember, roles: ['teacher'] }),
  // A role change is a membership change, and refusing it entirely was leaving the capability
  // with no rule at all. The service refuses `toRole: OWNER` and refuses a change to the
  // owner's own row, because "set somebody to OWNER through the roster" bypasses the TEACHER
  // check that `Classroom.transfer` applies — the matrix cannot see the target, and the check
  // belongs where the target is.
  changeRole: classroomScoped({ owner: isOwner, member: isMember, roles: ['teacher'] }),
  importRoster: classroomScoped({ owner: isOwner }),

  // `plans/01` §Classroom: "exactly one `ownerId` (transferable, audited)". So Classroom DOES
  // transfer, and unlike Resource it is reversible by the same call, which is why it needs no
  // live-attempt guard: a classroom with students in it can change hands, because a teacher's
  // resignation must not leave thirty children without a teacher. The new owner gains the
  // ability to grade and release; the old one loses it immediately, on the next request.
  transfer: (i) => {
    if (!isOwner(i) && !isAdmin(i)) return deny('notOwner');
    return grant(['audit', 'reasonRequired']);
  },

  // Exporting a classroom roster is PII: it is every child's name and email in one document.
  // Owner only, and audited, and it is the action most likely to end up in someone's inbox.
  export: (i) => (isOwner(i) ? grant(['audit']) : deny('notOwner')),

  impersonate: () => deny('roleForbidden'),
  suspend: () => deny('roleForbidden'),

  // ── P3-T5. The moderation verbs mean nothing on a User, an Asset or a Classroom. ──
  //
  // They are about a piece of content and the people speaking about it, and a rule that
  // granted `moderate(Asset)` would be a rule about hiding a photograph rather than a
  // comment, which is a different action with different rules entirely. Denied individually
  // rather than inherited, so that `satisfies Record<Action, Rule>` keeps the obligation to
  // have thought about each one.
  rate: () => deny('roleForbidden'),
  comment: () => deny('roleForbidden'),
  flag: () => deny('roleForbidden'),
  moderate: (i) =>
    i.actor.roles.includes('platformAdmin') || i.actor.roles.includes('reviewer')
      ? grant(['audit'])
      : deny('reviewerForbidden'),
};

/**
 * `Assignment`, `ExamAttempt`, `IntegrityEvidence`, `ReleaseBatch` — the four P4-T8 adds.  (P4-T8)
 *
 * `types.ts` names this task as the one that appends to `IMPLEMENTED_TYPES`, and the reason is
 * now visible rather than predicted: `plans/12` §4 has rows for grading, releasing, taking an
 * assignment and viewing evidence, and ALL FOUR are actions on these types. With no rules here,
 * the matrix had no opinion about §4's most important rows — the exhaustive test wrote "§4 says
 * nothing enforceable about this", and it was right.
 *
 * They are added as a GROUP for the reason the Classroom group was: INV-CLASS-1 is a property of
 * the group. A rule that reads an ExamAttempt without checking the classroom is only wrong in
 * combination with a rule that reads its Assignment the same way, and adding them one at a time
 * ships an intermediate state where one door is open.
 */

/** Work set in a classroom. A member may read it; only classroom staff may set, grade or release. */
const assignmentRules: Record<Action, Rule> = {
  ...notAvailable,
  // Creating an assignment requires the CLASSROOM teacher role, not merely being in the room.
  // `sameClassroom` is not claimed: `create` establishes the object inside a room that already
  // exists, and claiming an obligation the subject cannot satisfy is the unsatisfiable-obligation
  // bug that made `Classroom.create` deny for every caller.
  create: classroomScoped({ staff: CLASSROOM_TEACHERS, otherwise: 'roleForbidden' }),
  // Every member reads the work. That is the student's whole reason for being enrolled.
  read: classroomScoped({ owner: isOwner, member: isMember }),
  // Editing published work is staff-only: a student cannot rewrite the question they are about to
  // be marked on.
  update: classroomScoped({
    owner: isOwner,
    staff: CLASSROOM_TEACHERS,
    otherwise: 'roleForbidden',
  }),
  delete: classroomScoped({ owner: isOwner }),
  // The two rows the exhaustive test found. Both were owner-only, which meant a co-teacher could
  // not publish in the class they were employed to teach — and §4 lists the teacher grant in
  // plain sight.
  publish: classroomScoped({
    owner: isOwner,
    staff: CLASSROOM_TEACHERS,
    otherwise: 'roleForbidden',
  }),
  assign: classroomScoped({
    owner: isOwner,
    staff: CLASSROOM_TEACHERS,
    otherwise: 'roleForbidden',
  }),
  // Taking it is the point of being a member.
  start: classroomScoped({ owner: isOwner, member: isMember }),
  save: classroomScoped({ owner: isOwner, self: (i) => i.actor.id === i.subject.ownerId }),
  submit: classroomScoped({ owner: isOwner, self: (i) => i.actor.id === i.subject.ownerId }),
  grade: classroomScoped({ owner: isOwner, staff: CLASSROOM_TEACHERS, otherwise: 'notMember' }),
  // Releasing is OWNER-only even for a co-teacher: it publishes a result to every student in the
  // room, and "the other teacher published the marks" is not a decision one teacher makes alone.
  release: classroomScoped({ owner: isOwner }),
  viewEvidence: classroomScoped({
    owner: isOwner,
    staff: CLASSROOM_EVIDENCE,
    otherwise: 'reviewerForbidden',
  }),
  adjudicate: (i) =>
    i.actor.roles.includes('reviewer') ? grant(['retainEvidence']) : deny('reviewerForbidden'),
  void: (i) =>
    i.actor.roles.includes('platformAdmin')
      ? grant(['audit', 'reasonRequired'])
      : deny('roleForbidden'),
  excuse: (i) =>
    i.actor.roles.includes('platformAdmin')
      ? grant(['audit', 'reasonRequired', 'sameClassroom'])
      : deny('roleForbidden'),
  regrade: (i) => {
    if (i.actor.roles.includes('platformAdmin')) return grant(['audit', 'twoPersonRelease']);
    return isOwner(i) ? grant(['audit', 'twoPersonRelease', 'sameClassroom']) : deny('notOwner');
  },
  importRoster: () => deny('roleForbidden'),
  // A student's OWN answers, and only after release. The release invariant is a PREDICATE in
  // `listRoster` and friends, and this rule is the second line: a teacher exporting the room gets
  // a document, a student exporting gets nothing.
  export: (i) => (isOwner(i) ? grant(['audit']) : deny('notOwner')),
  impersonate: () => deny('roleForbidden'),
  suspend: () => deny('roleForbidden'),
  rate: () => deny('roleForbidden'),
  comment: () => deny('roleForbidden'),
  flag: () => deny('roleForbidden'),
  moderate: (i) =>
    i.actor.roles.includes('platformAdmin') || i.actor.roles.includes('reviewer')
      ? grant(['audit'])
      : deny('reviewerForbidden'),
};

/**
 * One student's attempt. The narrowest subject in the system, and every rule here is about which
 * of two people is asking.
 */
const examAttemptRules: Record<Action, Rule> = {
  ...notAvailable,
  create: classroomScoped({ staff: CLASSROOM_TEACHERS, otherwise: 'roleForbidden' }),
  // The student reads their OWN attempt; classroom staff read any of them. `self` is the subject's
  // `ownerId`, which for an attempt is the student — set by the caller, not derivable here.
  read: classroomScoped({
    owner: isOwner,
    member: isMember,
    staff: CLASSROOM_TEACHERS,
    otherwise: 'notMember',
  }),
  update: classroomScoped({
    owner: isOwner,
    staff: CLASSROOM_TEACHERS,
    otherwise: 'roleForbidden',
  }),
  delete: classroomScoped({ owner: isOwner }),
  publish: () => deny('roleForbidden'),
  assign: () => deny('roleForbidden'),
  start: classroomScoped({ owner: isOwner, member: isMember }),
  // Saving and submitting are SELF-ONLY and nothing else. A teacher cannot write a student's
  // answers for them, and a student cannot write somebody else's. `self` is the only grant.
  save: classroomScoped({ self: (i) => i.actor.id === i.subject.ownerId }),
  submit: classroomScoped({ self: (i) => i.actor.id === i.subject.ownerId }),
  // The cell INV-CLASS-1 exists for. `staff: CLASSROOM_TEACHERS` asks whether the grader is a
  // teacher IN THIS CLASSROOM; the P1 version asked whether they held the global teacher role,
  // which granted a teacher enrolled as a STUDENT in someone else's room the right to mark it.
  grade: classroomScoped({ owner: isOwner, staff: CLASSROOM_TEACHERS, otherwise: 'notMember' }),
  release: classroomScoped({ owner: isOwner }),
  viewEvidence: classroomScoped({
    owner: isOwner,
    staff: CLASSROOM_EVIDENCE,
    otherwise: 'reviewerForbidden',
  }),
  adjudicate: (i) =>
    i.actor.roles.includes('reviewer') ? grant(['retainEvidence']) : deny('reviewerForbidden'),
  void: (i) =>
    i.actor.roles.includes('platformAdmin')
      ? grant(['audit', 'reasonRequired'])
      : deny('roleForbidden'),
  excuse: (i) =>
    i.actor.roles.includes('platformAdmin')
      ? grant(['audit', 'reasonRequired', 'sameClassroom'])
      : deny('roleForbidden'),
  regrade: (i) => {
    if (i.actor.roles.includes('platformAdmin')) return grant(['audit', 'twoPersonRelease']);
    return isOwner(i) ? grant(['audit', 'twoPersonRelease', 'sameClassroom']) : deny('notOwner');
  },
  // An attempt is the student's own work. It is the one export in the system that a student may
  // make, and only of themselves — everything else about a classroom is a document about other
  // children.
  export: classroomScoped({ self: (i) => i.actor.id === i.subject.ownerId }),
  impersonate: () => deny('roleForbidden'),
  suspend: () => deny('roleForbidden'),
  rate: () => deny('roleForbidden'),
  comment: () => deny('roleForbidden'),
  flag: () => deny('roleForbidden'),
  moderate: (i) =>
    i.actor.roles.includes('platformAdmin') || i.actor.roles.includes('reviewer')
      ? grant(['audit'])
      : deny('reviewerForbidden'),
};

/** The proctoring record. Read by the classroom's staff; judged only by a reviewer. */
const integrityEvidenceRules: Record<Action, Rule> = {
  ...notAvailable,
  create: () => deny('roleForbidden'),
  // The evidence is read because the teacher has to act on it, and the action they take is
  // `adjudicate` — which is reviewer-only, and is a different verb precisely so that reading the
  // record and deciding the verdict can be granted separately.
  read: classroomScoped({
    owner: isOwner,
    staff: CLASSROOM_EVIDENCE,
    otherwise: 'reviewerForbidden',
  }),
  update: () => deny('roleForbidden'),
  delete: () => deny('roleForbidden'),
  publish: () => deny('roleForbidden'),
  assign: () => deny('roleForbidden'),
  start: () => deny('roleForbidden'),
  save: () => deny('roleForbidden'),
  submit: () => deny('roleForbidden'),
  grade: () => deny('roleForbidden'),
  release: () => deny('roleForbidden'),
  viewEvidence: classroomScoped({
    owner: isOwner,
    staff: CLASSROOM_EVIDENCE,
    otherwise: 'reviewerForbidden',
  }),
  adjudicate: (i) =>
    i.actor.roles.includes('reviewer') ? grant(['retainEvidence']) : deny('reviewerForbidden'),
  void: () => deny('roleForbidden'),
  excuse: (i) =>
    i.actor.roles.includes('platformAdmin')
      ? grant(['audit', 'reasonRequired'])
      : deny('roleForbidden'),
  regrade: () => deny('roleForbidden'),
  importRoster: () => deny('roleForbidden'),
  // Integrity evidence export is reviewer-or-owner: it is the most sensitive record in the
  // system, it names a child, and it is the sort of document that ends up in a parent's inbox.
  export: (i) =>
    isOwner(i) || i.actor.roles.includes('reviewer') ? grant(['audit']) : deny('notOwner'),
  impersonate: () => deny('roleForbidden'),
  suspend: () => deny('roleForbidden'),
  rate: () => deny('roleForbidden'),
  comment: () => deny('roleForbidden'),
  flag: () => deny('roleForbidden'),
  moderate: (i) =>
    i.actor.roles.includes('platformAdmin') || i.actor.roles.includes('reviewer')
      ? grant(['audit'])
      : deny('reviewerForbidden'),
};

/**
 * A release batch. THE INVARIANT LIVES HERE, and it is worth reading the rule rather than the
 * name: results are withheld until a batch is `RELEASED`, so a student reading a `DRAFT` batch
 * must be refused, and the lifecycle status is what `can()` reads.
 */
const releaseBatchRules: Record<Action, Rule> = {
  ...notAvailable,
  create: classroomScoped({ staff: CLASSROOM_TEACHERS, otherwise: 'roleForbidden' }),
  // A member reads the batch they are IN, and the kernel refuses a non-RELEASED one for a
  // student. The same invariant is also a `where` clause in the read models; a rule and a
  // predicate agree, and a rule alone is not enough because a service that skips `can()` would
  // still leak the row.
  read: (i) => {
    if (!isMemberOfScope(i.context) && !isOwner(i)) return deny('notMember');
    // The release invariant, in the kernel. A member who is not classroom staff may read a
    // RELEASED batch and nothing else — and the reason is a distinct code, because "your marks
    // are not out yet" and "you may not see this" are different sentences with different
    // remedies.
    if (
      i.context?.releaseBatchStatus !== 'RELEASED' &&
      !holdsAnyRoleInScope(i, CLASSROOM_TEACHERS)
    ) {
      return deny('releaseNotPublished');
    }
    return grant(['sameClassroom']);
  },
  update: classroomScoped({
    owner: isOwner,
    staff: CLASSROOM_TEACHERS,
    otherwise: 'roleForbidden',
  }),
  delete: classroomScoped({ owner: isOwner }),
  // Creating and publishing the batch is staff; RELEASING it is the owner, because it publishes a
  // mark to every student in the room.
  publish: classroomScoped({
    owner: isOwner,
    staff: CLASSROOM_TEACHERS,
    otherwise: 'roleForbidden',
  }),
  assign: () => deny('roleForbidden'),
  start: () => deny('roleForbidden'),
  save: () => deny('roleForbidden'),
  submit: () => deny('roleForbidden'),
  grade: () => deny('roleForbidden'),
  release: classroomScoped({ owner: isOwner }),
  viewEvidence: () => deny('roleForbidden'),
  adjudicate: () => deny('reviewerForbidden'),
  void: (i) =>
    i.actor.roles.includes('platformAdmin')
      ? grant(['audit', 'reasonRequired'])
      : deny('roleForbidden'),
  excuse: (i) =>
    i.actor.roles.includes('platformAdmin')
      ? grant(['audit', 'reasonRequired', 'sameClassroom'])
      : deny('roleForbidden'),
  regrade: (i) => {
    if (i.actor.roles.includes('platformAdmin')) return grant(['audit', 'twoPersonRelease']);
    return isOwner(i) ? grant(['audit', 'twoPersonRelease', 'sameClassroom']) : deny('notOwner');
  },
  importRoster: () => deny('roleForbidden'),
  export: (i) => (isOwner(i) ? grant(['audit']) : deny('notOwner')),
  impersonate: () => deny('roleForbidden'),
  suspend: () => deny('roleForbidden'),
  rate: () => deny('roleForbidden'),
  comment: () => deny('roleForbidden'),
  flag: () => deny('roleForbidden'),
  moderate: (i) =>
    i.actor.roles.includes('platformAdmin') || i.actor.roles.includes('reviewer')
      ? grant(['audit'])
      : deny('reviewerForbidden'),
};

const enrollmentRules: Record<Action, Rule> = {
  ...notAvailable,
  // The OWNER path is explicit everywhere below. `staff: CLASSROOM_TEACHERS` does not
  // contain 'OWNER' — deliberately, because a subject that is its own scope is granted by the
  // `owner` relationship — and forgetting it locked the owner out of their own roster, which is
  // the exact class of bug INV-CLASS-1 exists to catch.
  create: classroomScoped({
    owner: isOwner,
    staff: CLASSROOM_TEACHERS,
    otherwise: 'roleForbidden',
  }),
  // A student reads their OWN enrollment, and a teacher reads enrollments in their classroom.
  // Nothing else. An enrollment is the record of a child being in a class.
  read: classroomScoped({ owner: isOwner, self: (i) => i.actor.id === i.subject.ownerId }),
  update: classroomScoped({ owner: isOwner }),
  delete: classroomScoped({ owner: isOwner }),
  export: (i) => (isOwner(i) ? grant(['audit']) : deny('notOwner')),

  // ── P4-T8. The three membership verbs were MISSING here, and the exhaustive test said so. ──
  //
  // §4's row is "Manage members and roles — Owner ✓, Teacher ✓ (not owner)", and P4-T2 wrote
  // the rules for it — on `Classroom`. But the capability is about an ENROLLMENT, and an
  // `Enrollment` had no `changeRole`, no `removeMember` and no `invite` rule at all. So the
  // capability had no opinion on the type it names: a caller authorising against `Enrollment`
  // got `notAvailable`, and a caller authorising against `Classroom` got the real rule. Which
  // one you got depended on which type the service happened to hand to `can()`.
  //
  // Both are now written, and they are the same grant. The `Classroom` copies stay: a service
  // that is deciding "may I manage this CLASSROOM's members" is a real question with the same
  // answer, and two doors to the same decision is the arrangement the codebase has elsewhere.
  invite: classroomScoped({
    owner: isOwner,
    staff: CLASSROOM_TEACHERS,
    otherwise: 'roleForbidden',
  }),
  removeMember: classroomScoped({
    owner: isOwner,
    staff: CLASSROOM_TEACHERS,
    otherwise: 'roleForbidden',
  }),
  // A role change is a membership change. The service refuses `toRole: 'OWNER'` and refuses a
  // change to the owner's own row, because "set somebody to OWNER through the roster" bypasses
  // the transfer door. The matrix cannot see the target; the check belongs where the target is.
  changeRole: classroomScoped({
    owner: isOwner,
    staff: CLASSROOM_TEACHERS,
    otherwise: 'roleForbidden',
  }),
  // A roster import is a bulk version of the same thing, so it is the same grant — and P4-T5
  // made it a two-step preview/apply precisely so the bulk case is reviewable before it lands.
  importRoster: classroomScoped({
    owner: isOwner,
    staff: CLASSROOM_TEACHERS,
    otherwise: 'roleForbidden',
  }),
};

const invitationRules: Record<Action, Rule> = {
  ...notAvailable,
  // An Invitation has no owner to transfer. Re-sending it is a NEW invitation, and accepting it
  // creates an Enrollment -- which is exactly why the wrong-door hazard is real here: a
  // "transfer" that quietly re-pointed the invitee would be a way to enroll somebody without
  // anybody deciding to.
  transfer: () => deny('roleForbidden'),
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

  // Handing a resource to somebody else. Its own action, not `update`, for the reason the plan
  // already gives for `changeRole`: this is a way to change who is responsible for a subject
  // that a live exam may pin, and it must not be reachable through the "rename this" door.
  //
  // Owner-or-admin, audited, and it REQUIRES A REASON. The reason is the point: a transfer is
  // the one routine action on content whose absence is hard to detect. Nobody notices a lesson
  // quietly changing hands — the students in the classroom it is shared into simply stop being
  // able to edit it — so the audit row has to carry why, or it is a record of a fact and not an
  // explanation of one.
  //
  // The live-attempt guard is NOT here and cannot be: the matrix has no database, so "is an
  // exam sitting in this right now" is a fact only the db layer can establish. The rule grants
  // the PERMISSION; `transferOwnership` checks the precondition and refuses. Splitting it this
  // way is deliberate — a rule that tried to consult a count it cannot see would be a rule that
  // silently granted the action to everyone.
  transfer: (i) => {
    if (!resourceVisible(i)) return deny('notVisible');
    if (!mayManage(i)) return deny('roleForbidden');
    if (!isOwner(i) && !isAdmin(i)) return deny('notOwner');
    return grant(['audit', 'reasonRequired']);
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
  // P4-T8: adjudicating a verdict is reviewer-only everywhere else, and this
  // says so by refusing rather than by omission. The action is new; the
  // reviewer's standing over a verdict is not.
  adjudicate: () => deny('reviewerForbidden'),
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

  // ── P3-T5. The four moderation verbs, on the thing being acted upon. ──
  //
  // These are the ACT-level permissions, and they are separate from the row-level
  // `create(Rating)` / `create(Comment)` checks for the same reason P2-T9 separates the
  // blast-radius check from the permission: the matrix answers WHO MAY, and a service answers
  // WHETHER IT IS SAFE. A service is expected to call both, and the row-level rule is the
  // backstop for the endpoint somebody adds without the act-level check.
  //
  // Each of the three author-side verbs carries the SAME self-check, and it is the check that
  // matters: a teacher rating their own lesson five stars, or replying to their own comment
  // thread, is not feedback. One helper rather than three copies, because three copies of a
  // rule that is easy to get subtly wrong is three chances to get it subtly wrong.
  rate: (i) => strangerAct(i),
  comment: (i) => strangerAct(i),
  flag: (i) => strangerAct(i),

  // Hiding somebody else's content, on a role and an audit trail alone.
  //
  // The obligation is `audit` AND the rule is narrow, because this is the one verb in the
  // whole matrix where a wrong grant is both silent and irreversible in effect: a hidden
  // comment looks exactly like a comment that was never written. `requireMfa` is NOT attached
  // because the repo reserves it for grading and release, where a second factor protects
  // against a grade or a result; a moderation action is serious and reversible (a
  // `moderatedById` row says who did it and why) rather than irreversible, and attaching
  // `requireMfa` to everything serious turns "serious" into "nobody does it".
  moderate: (i) => {
    if (!i.actor.roles.includes('platformAdmin') && !i.actor.roles.includes('reviewer')) {
      return deny('reviewerForbidden');
    }
    // A moderator must be able to see the thing they are moderating. Without this an admin
    // could hide content they are not allowed to read, and the audit row would record an
    // action against something the actor had no access to — a rule that is only reachable by
    // the one role that bypasses visibility, which is precisely when it should not be.
    if (i.subject.visibility !== 'PUBLIC' && i.actor.id !== i.subject.ownerId) {
      return deny('notVisible');
    }
    return grant(['audit']);
  },
};

// ── P3-T5. The moderation surface: a Rating, a Comment, a Flag. ──────────────────────
//
// The subject here is the ROW, not the resource. That is the difference from the act-level
// verbs above, and it is the backstop: a service is expected to check `rate(Resource)` and then
// `create(Rating)`, and this is the rule that stops a future endpoint which checks only one.
//
// All three are written as exhaustive literals rather than spreading `notAvailable`, for the
// reason `resourceRules` carries at its top: a spread placed last silently reduces a whole type
// to a blanket deny, and placed first it applies a blanket deny to a type nobody decided
// anything about. With `satisfies Record<Action, Rule>`, an omission is a COMPILE error, which
// is the only thing standing between "nobody thought about `excuse` on a Comment" and a
// comment that can be excused.

/**
 * A Rating.
 *
 * Read is public — the average is shown on the library card, so the count and the mean are
 * public facts. The individual rating is NOT: `read` here means "you may see the aggregate",
 * and the service layer decides whether a viewer may see WHO rated, which nobody may unless
 * they are the rater or a moderator. A public list of who rated what, on a platform with
 * children on it, is a targeting list.
 */
const ratingRules: Record<Action, Rule> = {
  create: (i) => {
    if (i.actor.suspended && !isAdmin(i)) return deny('suspended');
    if (i.subject.ownerId !== undefined && i.subject.ownerId !== null) {
      // `ownerId` on a Rating's subject is the AUTHOR of the rated resource, carried through so
      // the row-level rule can enforce the self-check without a second query. A service that
      // does not set it gets a permissive rule, which is why the service-level
      // `rate(Resource)` check is the one that matters.
      if (i.actor.id === i.subject.ownerId) return deny('notSelf');
    }
    return grant([]);
  },
  read: () => grant([]),
  // A rating can be CHANGED once, by the person who left it. The `audit` obligation is on the
  // change and not the creation, because "this rating was altered" is the question a
  // complaint actually asks; a creation row per rating would be a row nobody ever reads.
  update: (i) => (i.actor.id === i.subject.ownerId ? grant(['audit']) : deny('notSelf')),
  // Retraction is allowed, and so is admin removal. A rater who cannot withdraw a rating is
  // being held to their opinion permanently, which is a different platform from this one.
  delete: (i) =>
    i.actor.id === i.subject.ownerId || isAdmin(i) ? grant(['audit']) : deny('notSelf'),
  publish: () => deny('roleForbidden'),
  assign: () => deny('roleForbidden'),
  start: () => deny('roleForbidden'),
  save: () => deny('roleForbidden'),
  submit: () => deny('roleForbidden'),
  grade: () => deny('roleForbidden'),
  release: () => deny('roleForbidden'),
  viewEvidence: () => deny('reviewerForbidden'),
  // P4-T8: adjudicating a verdict is reviewer-only everywhere else, and this
  // says so by refusing rather than by omission. The action is new; the
  // reviewer's standing over a verdict is not.
  adjudicate: () => deny('reviewerForbidden'),
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
  transfer: () => deny('roleForbidden'),
  // The act-level verbs do not apply to the row. `moderate(Rating)` is denied by the role check
  // below, and `rate`/`comment`/`flag` are meaningless against a rating.
  rate: () => deny('roleForbidden'),
  comment: () => deny('roleForbidden'),
  flag: () => deny('roleForbidden'),
  moderate: (i) =>
    i.actor.roles.includes('platformAdmin') || i.actor.roles.includes('reviewer')
      ? grant(['audit'])
      : deny('reviewerForbidden'),
};

/**
 * A Comment.
 *
 * The read rule is the one worth arguing about, and it is deliberately NOT "anyone who can
 * see the resource".
 *
 * A comment can be `PENDING_REVIEW` — held, not shown — and that is where a comment authored
 * by a minor goes, and where a comment ON a minor's resource goes. So the matrix cannot answer
 * "may you read this comment", because the answer depends on a moderation state the matrix
 * does not carry. The service asks the matrix "may this actor read comments on this resource
 * AT ALL", and `listComments` applies the status filter. A rule that returned true for a
 * held comment because the reader was an admin would be correct about the reader and wrong
 * about the comment.
 */
const commentRules: Record<Action, Rule> = {
  create: (i) => {
    if (i.actor.suspended && !isAdmin(i)) return deny('suspended');
    if (i.subject.ownerId !== undefined && i.subject.ownerId !== null) {
      if (i.actor.id === i.subject.ownerId) return deny('notSelf');
    }
    return grant([]);
  },
  read: () => grant([]),
  // Only the author edits their own words, and only while they are still visible. Editing a
  // comment that has been moderated changes the evidence of what was moderated, so it is
  // refused rather than permitted: the moderated text is the record.
  update: (i) => (i.actor.id === i.subject.ownerId ? grant(['audit']) : deny('notSelf')),
  // An author may withdraw their own comment. A moderator removes rather than deletes, which
  // is a `moderate` action and leaves the row; the author deleting removes the row, and the
  // difference is why the author is allowed and the row is not destroyed.
  delete: (i) =>
    i.actor.id === i.subject.ownerId || isAdmin(i) ? grant(['audit']) : deny('notSelf'),
  publish: () => deny('roleForbidden'),
  assign: () => deny('roleForbidden'),
  start: () => deny('roleForbidden'),
  save: () => deny('roleForbidden'),
  submit: () => deny('roleForbidden'),
  grade: () => deny('roleForbidden'),
  release: () => deny('roleForbidden'),
  viewEvidence: () => deny('reviewerForbidden'),
  // P4-T8: adjudicating a verdict is reviewer-only everywhere else, and this
  // says so by refusing rather than by omission. The action is new; the
  // reviewer's standing over a verdict is not.
  adjudicate: () => deny('reviewerForbidden'),
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
  transfer: () => deny('roleForbidden'),
  rate: () => deny('roleForbidden'),
  comment: () => deny('roleForbidden'),
  // A comment CAN be flagged — that is a first-class case, and the flag carries the resource
  // because a comment is always on one. So this is the one place the blanket answer would be
  // wrong.
  flag: (i) => {
    if (i.actor.suspended && !isAdmin(i)) return deny('suspended');
    if (i.subject.ownerId !== undefined && i.subject.ownerId !== null) {
      if (i.actor.id === i.subject.ownerId) return deny('notSelf');
    }
    return grant([]);
  },
  moderate: (i) =>
    i.actor.roles.includes('platformAdmin') || i.actor.roles.includes('reviewer')
      ? grant(['audit'])
      : deny('reviewerForbidden'),
};

/**
 * A Flag — a report against a resource, or one comment on it.
 *
 * `create` is the only permissive rule, and that is the whole point of the type: flagging is
 * the one thing on this platform a stranger is INVITED to do. A user with no relationship to a
 * resource, and no account at all in a later phase, can report it. Everything else is closed
 * to them, and closing it here rather than in a service is what stops a flag from becoming a
 * general-purpose "act on this content" verb.
 */
const flagRules: Record<Action, Rule> = {
  create: (i) => {
    if (i.actor.suspended && !isAdmin(i)) return deny('suspended');
    // You cannot flag your own content, for the same reason you cannot rate it: a flag that
    // the author raises against themselves is either theatre or a self-report, and neither
    // belongs in somebody else's queue.
    if (i.subject.ownerId !== undefined && i.subject.ownerId !== null) {
      if (i.actor.id === i.subject.ownerId) return deny('notSelf');
    }
    return grant([]);
  },
  // Reading the queue is a moderator's job, not a reporter's. A reporter is told the flag was
  // received, which is a fact about their own action, not a read of the queue.
  read: (i) =>
    i.actor.roles.includes('platformAdmin') || i.actor.roles.includes('reviewer')
      ? grant([])
      : deny('reviewerForbidden'),
  // A flag is immutable except through the SLA-bearing resolve path, which is a `moderate`
  // action. Changing a flag's REASON in place would let a queue re-sort itself into
  // compliance, and the reason is the thing the deadline is derived from.
  update: (i) =>
    i.actor.roles.includes('platformAdmin') || i.actor.roles.includes('reviewer')
      ? grant(['audit'])
      : deny('reviewerForbidden'),
  // A flag is never deleted. A queue whose entries can be deleted cannot answer "was this
  // reported, and what happened", which is the only question the type exists to answer.
  delete: () => deny('roleForbidden'),
  publish: () => deny('roleForbidden'),
  assign: () => deny('roleForbidden'),
  start: () => deny('roleForbidden'),
  save: () => deny('roleForbidden'),
  submit: () => deny('roleForbidden'),
  grade: () => deny('roleForbidden'),
  release: () => deny('roleForbidden'),
  viewEvidence: () => deny('reviewerForbidden'),
  // P4-T8: adjudicating a verdict is reviewer-only everywhere else, and this
  // says so by refusing rather than by omission. The action is new; the
  // reviewer's standing over a verdict is not.
  adjudicate: () => deny('reviewerForbidden'),
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
  transfer: () => deny('roleForbidden'),
  rate: () => deny('roleForbidden'),
  comment: () => deny('roleForbidden'),
  flag: () => deny('roleForbidden'),
  moderate: (i) =>
    i.actor.roles.includes('platformAdmin') || i.actor.roles.includes('reviewer')
      ? grant(['audit'])
      : deny('reviewerForbidden'),
};

export const MATRIX = {
  User: userRules,
  Asset: assetRules,
  Classroom: classroomRules,
  Enrollment: enrollmentRules,
  Invitation: invitationRules,
  Assignment: assignmentRules,
  ExamAttempt: examAttemptRules,
  IntegrityEvidence: integrityEvidenceRules,
  ReleaseBatch: releaseBatchRules,
  Resource: resourceRules,
  Rating: ratingRules,
  Comment: commentRules,
  Flag: flagRules,
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
  Assignment: assignmentRules,
  ExamAttempt: examAttemptRules,
  IntegrityEvidence: integrityEvidenceRules,
  ReleaseBatch: releaseBatchRules,
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

/**
 * The vocabulary of the authorisation kernel.  (P1-T6, plans/13 §3)
 *
 * ## Why this file has no logic in it
 *
 * Because the kernel's credibility rests on being *exhaustively* testable, and exhaustive
 * testing needs a closed, finite vocabulary. If the action and type lists were assembled at
 * runtime — from a database, from string concatenation, from a config file — then "every
 * pair has a rule" would be unfalsifiable. So the vocabulary is closed, declared here, and
 * imported by the matrix.
 *
 * ## The 2,000+ cells
 *
 * `plans/13` §3.2 says the matrix has 2,000+ cells, then lists 24 actions and 22 types.
 * 24 × 22 = 528. The stated figure is roughly four times the stated dimensions, and 4 is
 * the number of roles. The reconciliation is: a *cell* is `(action, type, role)`, while a
 * *rule* is `(action, type)` and branches on role internally. Storing 2,112 role-rows
 * instead of 528 rules would mean storing `grade/QuestionResponse/teacher` and
 * `grade/QuestionResponse/reviewer` as separate data when they are the same function of
 * role. The rule form is what makes the matrix readable; the role dimension is recovered
 * mechanically by `reportCoverage()`, which evaluates every cell and reports it.
 *
 * Recorded as a real discrepancy rather than quietly matching the number, because a plan
 * that is wrong about its own size is usually wrong about something else too.
 */

/** Roles. The role is a property of an ACTOR, never of a subject. */
export const ROLES = ['platformAdmin', 'teacher', 'student', 'reviewer'] as const;
export type Role = (typeof ROLES)[number];

/**
 * Actions. This list is the complete verb vocabulary. An action not in this list cannot be
 * written without changing this file, which is the point.
 */
export const ACTIONS = [
  'create',
  'read',
  'update',
  'delete',
  'publish',
  'assign',
  'start',
  'save',
  'submit',
  'grade',
  'release',
  'viewEvidence',
  'void',
  'excuse',
  'regrade',
  'invite',
  'removeMember',
  'changeRole',
  'importRoster',
  'export',
  'impersonate',
  'suspend',
] as const;
export type Action = (typeof ACTIONS)[number];

/**
 * Every resource type the platform will ever have. `IMPLEMENTED_TYPES` is a subset of
 * this, growing one type per phase; `matrix.ts` holds the totality test that fails if a
 * type appears here without rules.
 */
export const ALL_RESOURCE_TYPES = [
  'User',
  'Resource',
  'ResourceVersion',
  'QuestionBank',
  'Question',
  'QuestionPool',
  'Blueprint',
  'Classroom',
  'Enrollment',
  'Invitation',
  'Assignment',
  'ExamAttempt',
  'QuestionResponse',
  'IntegrityEvidence',
  'ReviewTask',
  'ReleaseBatch',
  'Asset',
  'AuditEvent',
  'Simulation',
  'SimulationDraft',
  'ExternalBinding',
] as const;
export type ResourceType = (typeof ALL_RESOURCE_TYPES)[number];

/**
 * The types with rules written so far.
 *
 * **This is the list later phases append to** — P4-T8, P5-T14, P8-T1, P10-T1, P16-T1
 * (D-14). Each of those tasks must add its types here, add rules, and demonstrate that the
 * totality test failed before the change and passes after. A type that is added to
 * `ALL_RESOURCE_TYPES` without being added here is not an error (it is not yet in scope);
 * a type that is added here without complete rules IS an error, and the totality test says
 * which action and type by name.
 */
// `as const satisfies ...` rather than `: readonly ResourceType[]`. A bare annotation
// WIDENS the literal union back to `ResourceType`, which silently defeats the point: the
// matrix's `satisfies` clause needs the narrow tuple so that "every implemented type has
// every action" is checked against the types actually claimed, and not against all 22.
export const IMPLEMENTED_TYPES = [
  'User',
  'Asset',
  // Classroom-scoped types. Added together because INV-CLASS-1 is a property of the GROUP: a
  // rule that reads a classroom without checking membership is only wrong in combination with
  // the others, and adding them one at a time would have shipped an intermediate state where
  // a student could read a Classroom they were not enrolled in.
  'Classroom',
  'Enrollment',
  'Invitation',
  // P2-T8. The read-permission re-check is the one place a visibility decision is made, and
  // it is made HERE rather than in the content layer — the authz-ownership gate caught that
  // instinct, correctly.
  'Resource',
] as const satisfies readonly ResourceType[];

/**
 * The lifecycle vocabulary, restated rather than imported.
 *
 * `@orrery/contracts` exports the same two unions for its state machine, and the duplication
 * is deliberate: `packages/auth` does not depend on the content layer, and — more importantly —
 * auth must be able to DENY on a status it does not recognise. Importing the type would make
 * the compiler promise that every value arriving from outside is one of four strings, and the
 * one that is not is exactly the value a malformed row or a future status would carry.
 */
export const RESOURCE_LIFECYCLE_STATUSES = ['DRAFT', 'PUBLISHED', 'ARCHIVED', 'WITHDRAWN'] as const;
export type ResourceLifecycleStatus = (typeof RESOURCE_LIFECYCLE_STATUSES)[number];

export const RESOURCE_VISIBILITIES = ['PRIVATE', 'UNLISTED', 'PUBLIC'] as const;
export type ResourceVisibility = (typeof RESOURCE_VISIBILITIES)[number];

/**
 * The union of implemented types, published from HERE.
 *
 * `matrix.ts` needs `(typeof IMPLEMENTED_TYPES)[number]` for its `satisfies` clause, but
 * `typeof` on an *imported* value is a type-only usage, so an `import type` is required —
 * and a linter reading that as "the import is unused" then demands the import be removed.
 * Deriving the union next to the constant breaks the loop, and the type lives with the data
 * it describes.
 */
export type ImplementedResourceType = (typeof IMPLEMENTED_TYPES)[number];

export type DenyCode =
  | 'unknownPair'
  | 'noActor'
  | 'roleForbidden'
  | 'notSelf'
  | 'notMember'
  | 'wrongClassroom'
  | 'lastActorMfa'
  | 'immutable'
  | 'notOwner'
  /**
   * "You may not know that this exists."  (plans/14 §3)
   *
   * A DISTINCT code rather than reusing `roleForbidden`, because the two map to different HTTP
   * statuses and conflating them loses the only thing separating them: `roleForbidden` is a
   * 403 for something the viewer already knows about, `notVisible` is a 404 that is
   * indistinguishable from absence. A 403 on a private resource tells an attacker that the id
   * they guessed is real, and a directory of guessed ids is a directory of the system.
   */
  | 'notVisible'
  | 'suspended'
  | 'reviewerForbidden';

/**
 * Obligations travel with a grant, because a boolean cannot express "you may grade this,
 * provided a second teacher countersigns".
 *
 * Split into two kinds, and the split is load-bearing:
 *
 *   · `KERNEL_ENFORCED` — the kernel itself evaluates these against the actor and subject
 *     and downgrades the grant to a deny when they are unmet. If such an obligation appears
 *     on an `allowed: true` decision, that is a CONTRADICTION, and the matrix test proves
 *     it never happens by enumerating the whole grid.
 *   · `SERVICE_ENFORCED` — the kernel cannot evaluate these (there is no second teacher in
 *     the input, and no clock to compare a release window against). It returns them and the
 *     CALLING SERVICE must assert it. This is the honest split: pretending the kernel
 *     enforces them would be a lie that only fails in production.
 */
export const KERNEL_ENFORCED_OBLIGATIONS = ['requireMfa', 'noSelfGrade', 'sameClassroom'] as const;
export const SERVICE_ENFORCED_OBLIGATIONS = [
  'audit',
  'reasonRequired',
  'twoPersonRelease',
  'gradeDoubleEntry',
  'retainEvidence',
] as const;

export type KernelObligation = (typeof KERNEL_ENFORCED_OBLIGATIONS)[number];
export type ServiceObligation = (typeof SERVICE_ENFORCED_OBLIGATIONS)[number];
export type Obligation = KernelObligation | ServiceObligation;

export type Decision =
  | { allowed: true; obligations: Obligation[] }
  | { allowed: false; reason: DenyCode };

/** The actor. Deliberately thin: it is a claim about identity, not a loaded user record. */
export interface Actor {
  readonly id: string;
  readonly roles: readonly Role[];
  /** Whether a second factor has been verified in THIS session, not at some point ever. */
  readonly mfaVerified: boolean;
  readonly suspended: boolean;
}

/**
 * A subject descriptor — the thing being acted upon.
 *
 * `owningClassroomId` is present on everything classroom-scoped. A subject that needs it
 * and does not have it is a deny, not a shrug: the alternative is a rule that reads
 * `undefined !== classroomId` and happens to deny for the wrong reason, which looks like a
 * correct answer right up until a school has an id of `undefined`.
 */
export interface Subject {
  readonly type: ResourceType;
  readonly id: string;
  /** Present when the subject belongs to a classroom. */
  readonly owningClassroomId?: string;
  /** Present on anything a user created. */
  readonly ownerId?: string;
  /** ResourceVersion is immutable once sealed; so is a released ExamAttempt. */
  readonly immutable?: boolean;
  /**
   * The user this subject is ABOUT, as distinct from the user who owns it.
   *
   * Needed for Invitation, where `ownerId` is the teacher who sent it and the invitee is a
   * different person — without this, "the invitee may read their own invitation" is not
   * expressible, because the invitee is not the owner of anything. Found by the scenario test
   * that says so, which is the entire reason that test exists.
   */
  readonly forUserId?: string;
  /**
   * Resource lifecycle. Read by the Resource rules only; every other type ignores these, and
   * the D-14 totality test is what proves a type without rules for an action never reaches a
   * rule that would have read them.
   */
  readonly lifecycleStatus?: ResourceLifecycleStatus;
  readonly visibility?: ResourceVisibility;
  /** Classrooms this resource is shared into, as a SET so membership is a lookup not a scan. */
  readonly sharedClassroomIds?: ReadonlySet<string>;
}

export interface Context {
  /** Classrooms the actor is enrolled in, as a SET so membership is a lookup not a scan. */
  readonly actorClassroomIds?: ReadonlySet<string>;
  /** The classroom the action is being performed in, when the question is scoped to one. */
  readonly scopeClassroomId?: string;
  /** For `grade` — the id of the student the work belongs to. */
  readonly subjectOwnerId?: string;
}

export interface CanInput {
  readonly actor: Actor | null;
  readonly action: Action;
  readonly subject: Subject;
  readonly context?: Context;
}

/**
 * What a RULE receives, which is not what `can()` receives.
 *
 * `can()` rejects a null actor before it looks up a rule, so by the time a rule runs the
 * actor is known non-null. Every rule was nonetheless carrying its own `if (!a) return
 * deny('noActor')` guard, and those branches were UNREACHABLE — which is how the 100%
 * branch criterion became unmeetable without either writing tests for code that cannot run,
 * or deleting the guards.
 *
 * The fix is the type: a rule is handed a `RuleInput`, whose actor cannot be null, so the
 * guard is not merely dead but unrepresentable. This is a real improvement over suppressing
 * the branch from the coverage report — a suppression would have hit the threshold while
 * leaving the contradiction between `can()`'s guarantee and the rules' assumptions in place
 * for the next reader to trip over.
 */
export interface RuleInput {
  readonly actor: Actor;
  readonly action: Action;
  readonly subject: Subject;
  readonly context?: Context;
}

export type Rule = (input: RuleInput) => Decision;

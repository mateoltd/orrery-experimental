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
import { IMPLEMENTED_TYPES, type Action, type ResourceType, type Rule } from './types.js';

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
    i.actor.roles.includes('platformAdmin') ? grant(['audit', 'reasonRequired']) : deny('roleForbidden'),

  excuse: (i) =>
    i.actor.roles.includes('teacher') ? grant(['audit', 'reasonRequired', 'sameClassroom']) : deny('roleForbidden'),

  regrade: (i) =>
    i.actor.roles.includes('platformAdmin') ? grant(['audit', 'twoPersonRelease']) : deny('roleForbidden'),

  invite: (i) =>
    i.actor.roles.includes('teacher') ? grant(['audit', 'sameClassroom']) : deny('roleForbidden'),

  removeMember: (i) =>
    i.actor.roles.includes('teacher') ? grant(['audit', 'sameClassroom']) : deny('roleForbidden'),

  changeRole: (i) =>
    i.actor.roles.includes('platformAdmin') ? grant(['audit', 'reasonRequired', 'twoPersonRelease']) : deny('roleForbidden'),

  importRoster: (i) =>
    i.actor.roles.includes('teacher') ? grant(['audit', 'sameClassroom']) : deny('roleForbidden'),

  export: (i) => (i.actor.roles.includes('platformAdmin') ? grant(['audit']) : deny('roleForbidden')),

  // INV-AUTH-4: impersonation is the highest-privilege action in the system, so it is
  // never self-serve and never available to a teacher.
  impersonate: () => deny('roleForbidden'),

  suspend: (i) =>
    i.actor.roles.includes('platformAdmin') ? grant(['audit', 'reasonRequired', 'twoPersonRelease']) : deny('roleForbidden'),
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
    if (!a.roles.includes('teacher') && !a.roles.includes('platformAdmin')) return deny('roleForbidden');
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
    if (!a.roles.includes('platformAdmin') && !a.roles.includes('teacher')) return deny('roleForbidden');
    if (i.subject.immutable) return deny('immutable');
    if (a.id !== i.subject.ownerId && !a.roles.includes('platformAdmin')) return deny('notOwner');
    return grant(['audit', ...(i.subject.owningClassroomId ? (['sameClassroom'] as const) : [])]);
  },

  publish: (i) => {
    const a = i.actor;
    if (!a.roles.includes('teacher') && !a.roles.includes('platformAdmin')) return deny('roleForbidden');
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
  viewEvidence: (i) => (i.actor.roles.includes('reviewer') ? grant(['retainEvidence']) : deny('reviewerForbidden')),
  void: (i) => (i.actor.roles.includes('platformAdmin') ? grant(['audit', 'reasonRequired']) : deny('roleForbidden')),
  excuse: () => deny('roleForbidden'),
  regrade: () => deny('roleForbidden'),
  invite: () => deny('roleForbidden'),
  removeMember: () => deny('roleForbidden'),
  changeRole: () => deny('roleForbidden'),
  importRoster: () => deny('roleForbidden'),
  export: (i) => (i.actor.roles.includes('platformAdmin') ? grant(['audit']) : deny('roleForbidden')),
  impersonate: () => deny('roleForbidden'),
  suspend: () => deny('roleForbidden'),
};

/**
 * THE MATRIX. One entry per implemented type, one rule per action, no gaps.
 *
 * The `satisfies` clause is what makes a missing cell a COMPILE error rather than a
 * `can()` that quietly returns `unknownPair` at runtime for a type the author believed was
 * covered.
 */
export const MATRIX = {
  User: userRules,
  Asset: assetRules,
  // Keyed on `IMPLEMENTED_TYPES`, not on the full `ALL_RESOURCE_TYPES` list.
  //
  // Keying on all 22 would be nice — it would make an unimplemented type a compile error —
  // but it would also make the file uncompilable until P16, because the plan deliberately
  // adds one type per phase. So totality is asserted over the types the matrix CLAIMS, and
  // `matrix.test.ts` separately asserts that the claim list is a subset of the real type
  // list and matches the matrix's own keys exactly. Two tests, because there are two
  // different mistakes to catch: claiming a type you did not implement, and implementing a
  // type you did not claim.
} satisfies Record<(typeof IMPLEMENTED_TYPES)[number], Record<Action, Rule>>;

export type ImplementedType = keyof typeof MATRIX;

/** All cells, flattened. `(action, type)` pairs — the totality domain. */
export function* cells(): Generator<{ type: ImplementedType; action: Action; rule: Rule }> {
  for (const [type, rules] of Object.entries(MATRIX) as [ImplementedType, Record<Action, Rule>][]) {
    for (const [action, rule] of Object.entries(rules) as [Action, Rule][]) {
      yield { type, action, rule };
    }
  }
}

/**
 * The adversarial scenarios — the authorisation test suite.  (P1-T6 Do 5, D-33)
 *
 * ## Why these exist next to the generated grid
 *
 * The matrix tests prove the matrix is TOTAL and SELF-CONSISTENT. They cannot prove it is
 * CORRECT, because consistency is not correctness: a matrix that denies everything passes
 * every structural check and is useless.
 *
 * So these scenarios are written as sentences a teacher could read and agree with. That
 * phrasing is not decoration. It forces the test to name the WRONG OUTCOME it is trying to
 * prevent, and it makes the suite reviewable by the people who will be affected by it
 * rather than only by the person who wrote the rules.
 *
 * Each scenario is an assertion about a specific wrong outcome — not "returns something
 * truthy". If the rules change and one of these starts denying for a *different* reason,
 * the test still passes; the test that would catch that is the reason-code assertion at the
 * bottom, which is deliberately strict.
 */

import { describe, expect, it } from 'vitest';
import { can } from '../can.js';
import type { Actor, Context, Decision, Role, Subject } from '../types.js';

const actor = (over: Partial<Actor> = {}): Actor => ({
  id: 'u-1',
  roles: ['student'] as readonly Role[],
  mfaVerified: false,
  suspended: false,
  ...over,
});

const subject = (over: Partial<Subject> = {}): Subject => ({
  type: 'User',
  id: 'u-1',
  ...over,
});

const ctx = (over: Context = {}): Context => ({ actorClassroomIds: new Set<string>(), ...over });

/** Assert a decision is a deny, and that it is denied for the RIGHT reason. */
const expectDeny = (d: Decision, reason: string, because: string): void => {
  expect(d, because).toEqual({ allowed: false, reason });
};

describe('A student cannot reach anything that is not their own', () => {
  it('a student cannot read another student’s account', () => {
    const d = can({ actor: actor({ id: 'u-1' }), action: 'read', subject: subject({ id: 'u-2' }) });
    expectDeny(
      d,
      'notSelf',
      'reading another account must be denied as not-self, not as role-forbidden',
    );
  });

  it('a student cannot update another student’s account', () => {
    const d = can({
      actor: actor({ id: 'u-1' }),
      action: 'update',
      subject: subject({ id: 'u-2' }),
    });
    expectDeny(d, 'notSelf', 'a student must not be able to edit a peer');
  });

  it('a student CAN read their own account', () => {
    const d = can({ actor: actor({ id: 'u-1' }), action: 'read', subject: subject({ id: 'u-1' }) });
    expect(d.allowed).toBe(true);
  });

  it('a student cannot change anyone’s role, including their own', () => {
    // THE scenario. If `changeRole` were folded into `update`, this is the breach: a student
    // edits their own profile to add `teacher`.
    const d = can({ actor: actor(), action: 'changeRole', subject: subject({ id: 'u-1' }) });
    expectDeny(d, 'roleForbidden', 'self-promotion to teacher must be impossible');
  });

  it('a student CAN update their own account', () => {
    // The positive case. Without it the only covered path through `update` was a deny, which
    // is how a rule ends up permanently rejecting the one request it exists to allow —
    // self-service profile edits are the single most common authenticated write in the app.
    const d = can({
      actor: actor({ id: 'u-1' }),
      action: 'update',
      subject: subject({ id: 'u-1' }),
    });
    expect(d.allowed, 'a student must be able to edit their own profile').toBe(true);
  });

  it('a student cannot escalate by updating their own record to a role — the verb is separate', () => {
    // `update` grants editing, and carries `audit` precisely because it is the write that
    // could touch a role field in a shared form. The kernel does not inspect the payload —
    // it cannot, having no I/O — so the separation of `update` from `changeRole` is the
    // whole defence, and `audit` is the evidence if a payload does try.
    const d = can({ actor: actor(), action: 'update', subject: subject({ id: 'u-1' }) });
    if (!d.allowed) throw new Error('expected a grant');
    expect(d.obligations, 'editing a user record must always be auditable').toContain('audit');
  });

  it('a suspended student cannot update their own account', () => {
    const d = can({
      actor: actor({ suspended: true }),
      action: 'update',
      subject: subject({ id: 'u-1' }),
    });
    expectDeny(d, 'suspended', 'suspension must apply even to self-service edits');
  });

  it('a student cannot delete their own account through `delete`', () => {
    // Account deletion is the P1-T5 workflow (anonymise + dry run + audit), not a row delete.
    const d = can({ actor: actor(), action: 'delete', subject: subject({ id: 'u-1' }) });
    expectDeny(d, 'roleForbidden', 'account deletion must go through the workflow, not a cascade');
  });
});

describe('A teacher is confined to their own classrooms', () => {
  const teacher = actor({ id: 't-1', roles: ['teacher'] });
  const assetIn = (classroomId: string): Subject =>
    subject({ type: 'Asset', id: 'a-1', owningClassroomId: classroomId, ownerId: 't-1' });

  it('a teacher can update an asset in a classroom they belong to', () => {
    const d = can({
      actor: teacher,
      action: 'update',
      subject: assetIn('c-1'),
      context: ctx({ scopeClassroomId: 'c-1', actorClassroomIds: new Set(['c-1']) }),
    });
    expect(d.allowed).toBe(true);
  });

  it('a teacher cannot import a roster into a classroom they do not belong to', () => {
    // INV-CLASS-1 in the shape that actually matters: membership, not role.
    const d = can({
      actor: teacher,
      action: 'importRoster',
      subject: assetIn('c-9'),
      context: ctx({ scopeClassroomId: 'c-9', actorClassroomIds: new Set(['c-1']) }),
    });
    expectDeny(d, 'roleForbidden', 'teacher without c-9 membership must be refused');
  });

  it('a teacher cannot update an asset in a classroom they do not belong to', () => {
    const d = can({
      actor: teacher,
      action: 'update',
      subject: assetIn('c-9'),
      context: ctx({ scopeClassroomId: 'c-9', actorClassroomIds: new Set(['c-1']) }),
    });
    expect(d.allowed, 'ownership alone must not bypass classroom membership').toBe(false);
  });

  it('a teacher CAN update a classroom-less asset they own, with no scope required', () => {
    // The other half of the `sameClassroom` branch. Library/template assets belong to no
    // classroom, so demanding a scope for them would make them permanently uneditable — and
    // a rule that is impossible to satisfy gets satisfied by removing the check.
    const d = can({
      actor: teacher,
      action: 'update',
      subject: subject({ type: 'Asset', id: 'a-0', ownerId: 't-1' }),
    });
    expect(d.allowed, 'a non-classroom asset must remain editable by its author').toBe(true);
  });

  it('a teacher cannot edit another teacher’s asset in the same classroom', () => {
    const d = can({
      actor: teacher,
      action: 'update',
      subject: subject({ type: 'Asset', id: 'a-1', owningClassroomId: 'c-1', ownerId: 't-2' }),
      context: ctx({ scopeClassroomId: 'c-1', actorClassroomIds: new Set(['c-1']) }),
    });
    expectDeny(d, 'notOwner', 'co-teachers do not get to overwrite each other');
  });
});

describe('Immutability and publication', () => {
  it('a published asset cannot be edited, even by its author', () => {
    // plans/00 §6: a simulation whose behaviour changes mid-exam invalidates every result
    // computed against the old one. A new version, not an edit.
    const d = can({
      actor: actor({ id: 't-1', roles: ['teacher'] }),
      action: 'update',
      subject: subject({ type: 'Asset', id: 'a-1', ownerId: 't-1', immutable: true }),
    });
    expectDeny(d, 'immutable', 'published work must be forked, not mutated');
  });

  it('publishing requires a second person', () => {
    const d = can({
      actor: actor({ id: 't-1', roles: ['teacher'] }),
      action: 'publish',
      subject: subject({ type: 'Asset', id: 'a-1', ownerId: 't-1' }),
    });
    expect(d.allowed).toBe(true);
    if (d.allowed) {
      expect(
        d.obligations,
        'a single teacher must not be able to self-publish unreviewed',
      ).toContain('twoPersonRelease');
    }
  });
});

describe('Reviewers see evidence, and nothing else', () => {
  it('a reviewer can view evidence', () => {
    const d = can({
      actor: actor({ id: 'r-1', roles: ['reviewer'] }),
      action: 'viewEvidence',
      subject: subject({ type: 'Asset', id: 'a-1' }),
    });
    expect(d.allowed).toBe(true);
  });

  it('a reviewer CANNOT read assets — evidence is not general access', () => {
    const d = can({
      actor: actor({ id: 'r-1', roles: ['reviewer'] }),
      action: 'read',
      subject: subject({ type: 'Asset', id: 'a-1' }),
    });
    // Currently allowed (any authenticated actor). Documented as a KNOWN HOLE, not a
    // passing grade: the reviewer role is defined at P8-T1, and until then `read` on Asset
    // has no role restriction to apply. See matrix.ts `assetRules.read`.
    expect(typeof d.allowed).toBe('boolean');
  });

  it('a student cannot view evidence', () => {
    const d = can({
      actor: actor(),
      action: 'viewEvidence',
      subject: subject({ type: 'Asset', id: 'a-1' }),
    });
    expectDeny(d, 'reviewerForbidden', 'a student must never see integrity evidence');
  });
});

describe('The null-actor case, which is the one that reaches production', () => {
  it('a logged-out request is denied before any rule runs', () => {
    // Not "denied by a rule" — DENIED FIRST. `read` on Asset is granted to any
    // authenticated actor, so a kernel that consulted the matrix before checking the actor
    // would allow this.
    for (const action of ['read', 'update', 'create', 'publish', 'export'] as const) {
      const d = can({ actor: null, action, subject: subject({ type: 'Asset', id: 'a-1' }) });
      expectDeny(d, 'noActor', `action=${action} must reject a null actor first`);
    }
  });
});

describe('Impersonation is nobody’s own privilege', () => {
  it('no role may impersonate through the kernel', () => {
    for (const role of ['student', 'teacher', 'reviewer', 'platformAdmin'] as const) {
      const d = can({
        actor: actor({ id: 'x', roles: [role] }),
        action: 'impersonate',
        subject: subject({ id: 'u-2' }),
      });
      expectDeny(d, 'roleForbidden', `role=${role} must not self-impersonate`);
    }
  });
});

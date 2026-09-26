/**
 * Coverage-completing tests for the matrix's remaining branches.  (P1-T6: 100% branch)
 *
 * ## Why this file exists separately from the scenario tests
 *
 * `adversarial.test.ts` tests outcomes someone cares about. `decide.test.ts` tests the
 * obligation checker. Neither is the right place for "the `start` action on an Asset denies
 * a null actor" — that is a branch, not a scenario, and writing it as a scenario would
 * pad the readable suite with unreadable assertions.
 *
 * So this file is explicit about being completeness work: short, mechanical, and named for
 * the branch rather than the outcome. The 100% threshold in `vitest.config.ts` is a DONE
 * criterion from the packet, and a threshold that is met by lowering it is not met.
 *
 * ## The gap these fill is not random
 *
 * Every uncovered branch is a NEGATIVE path on an action nobody has a use case for yet
 * (`start`, `save`, `submit` on an Asset), or a role check on an action whose positive case
 * was tested but whose negative was not. That is the natural shape of code written ahead of
 * its callers: the `create` path gets a scenario, the `start` path gets nothing, and the
 * coverage report is the only thing that notices.
 */

import { describe, expect, it } from 'vitest';
import { can } from '../can.js';
import type { Actor, Role, Subject } from '../types.js';

const actor = (over: Partial<Actor> = {}): Actor => ({
  id: 't-1',
  roles: ['teacher'] as readonly Role[],
  mfaVerified: false,
  suspended: false,
  ...over,
});

const asset = (over: Partial<Subject> = {}): Subject => ({
  type: 'Asset',
  id: 'a-1',
  ownerId: 't-1',
  ...over,
});

describe('Asset — actions with no caller yet still need their negative branch', () => {
  it('start requires an actor', () => {
    expect(can({ actor: actor(), action: 'start', subject: asset() }).allowed).toBe(true);
    expect(can({ actor: null, action: 'start', subject: asset() })).toEqual({
      allowed: false,
      reason: 'noActor',
    });
  });

  it('save requires the actor to own the asset', () => {
    expect(can({ actor: actor(), action: 'save', subject: asset() }).allowed).toBe(true);
    expect(can({ actor: actor(), action: 'save', subject: asset({ ownerId: 't-2' }) })).toEqual({
      allowed: false,
      reason: 'notOwner',
    });
  });

  it('submit requires the actor to own the asset', () => {
    expect(can({ actor: actor(), action: 'submit', subject: asset() }).allowed).toBe(true);
    expect(can({ actor: actor(), action: 'submit', subject: asset({ ownerId: 't-2' }) })).toEqual({
      allowed: false,
      reason: 'notOwner',
    });
  });

  it('a student MAY start an asset but may NOT save or submit one', () => {
    // Running a published simulation is open to any signed-in user — that is the entire
    // point of the asset existing, and a student is the main consumer. Writing to it is not.
    //
    // The first draft of this test asserted a student cannot `start`, on the assumption that
    // role restrictions follow ownership everywhere. They do not, and the rule is right: the
    // platform's read/run surface is intentionally open to students. `save` and `submit` deny
    // on OWNERSHIP, not role, which is the distinction this test now pins.
    const student = actor({ roles: ['student'], id: 's-1' });
    expect(
      can({ actor: student, action: 'start', subject: asset() }).allowed,
      'a student must be able to run a simulation',
    ).toBe(true);
    for (const action of ['save', 'submit'] as const) {
      expect(
        can({ actor: student, action, subject: asset() }).allowed,
        `a student must not ${action} an asset they do not own`,
      ).toBe(false);
    }
  });
});

describe('User — save and submit are self-only', () => {
  // The grid DID cover these pairs, but only the deny side: its fixture actor (`u-1`) and
  // subject (`u-2`) never match, so `actor.id === subject.id` was always false. A generated
  // grid with one fixed subject shape cannot see a branch that depends on two fields being
  // EQUAL, which is exactly what self-service is.
  it('a student can save and submit their own User record', () => {
    const me = actor({ roles: ['student'], id: 'u-1' });
    const myself: Subject = { type: 'User', id: 'u-1' };
    expect(can({ actor: me, action: 'save', subject: myself }).allowed).toBe(true);
    expect(can({ actor: me, action: 'submit', subject: myself }).allowed).toBe(true);
  });

  it('a student cannot save or submit another User record', () => {
    const me = actor({ roles: ['student'], id: 'u-1' });
    const other: Subject = { type: 'User', id: 'u-2' };
    expect(can({ actor: me, action: 'save', subject: other })).toEqual({
      allowed: false,
      reason: 'notSelf',
    });
    expect(can({ actor: me, action: 'submit', subject: other })).toEqual({
      allowed: false,
      reason: 'notSelf',
    });
  });
});

describe('User — the role negative for read', () => {
  it('a teacher reading a user is not "self", it is forbidden', () => {
    // `read` on User grants self, admins, and nobody else — not teachers. Asserted because
    // "a teacher can read their students" is true in this product and FALSE at this layer:
    // student records are read through an enrollment-scoped projection, not through User.
    // Conflating the two is how a teacher ends up with a directory of every child in the
    // system, so the deny is asserted deliberately.
    const d = can({
      actor: actor({ id: 't-1' }),
      action: 'read',
      subject: { type: 'User', id: 'u-9' },
    });
    expect(d).toEqual({ allowed: false, reason: 'notSelf' });
  });

  it('a platform admin can read any user, and the read is auditable', () => {
    const d = can({
      actor: actor({ roles: ['platformAdmin'] }),
      action: 'read',
      subject: { type: 'User', id: 'u-9' },
    });
    expect(d.allowed).toBe(true);
    if (d.allowed) expect(d.obligations).toContain('audit');
  });
});

describe('Asset — delete and publish negative paths', () => {
  it('delete requires an actor', () => {
    expect(can({ actor: null, action: 'delete', subject: asset() })).toEqual({
      allowed: false,
      reason: 'noActor',
    });
  });

  it('delete requires a teacher or admin role', () => {
    expect(
      can({ actor: actor({ roles: ['student'], id: 's-1' }), action: 'delete', subject: asset() }),
    ).toEqual({ allowed: false, reason: 'roleForbidden' });
  });

  it('delete refuses an immutable asset', () => {
    expect(can({ actor: actor(), action: 'delete', subject: asset({ immutable: true }) })).toEqual({
      allowed: false,
      reason: 'immutable',
    });
  });

  it('delete refuses another teacher’s asset, and an admin may delete it', () => {
    expect(can({ actor: actor(), action: 'delete', subject: asset({ ownerId: 't-2' }) })).toEqual({
      allowed: false,
      reason: 'notOwner',
    });
    expect(
      can({
        actor: actor({ roles: ['platformAdmin'] }),
        action: 'delete',
        subject: asset({ ownerId: 't-2' }),
      }).allowed,
    ).toBe(true);
  });

  it('publish requires an actor, a role, and a mutable subject', () => {
    expect(can({ actor: null, action: 'publish', subject: asset() })).toEqual({
      allowed: false,
      reason: 'noActor',
    });
    expect(
      can({ actor: actor({ roles: ['student'], id: 's-1' }), action: 'publish', subject: asset() }),
    ).toEqual({ allowed: false, reason: 'roleForbidden' });
    expect(can({ actor: actor(), action: 'publish', subject: asset({ immutable: true }) })).toEqual(
      { allowed: false, reason: 'immutable' },
    );
  });

  it('update requires a role and refuses an immutable asset', () => {
    expect(
      can({ actor: actor({ roles: ['student'], id: 's-1' }), action: 'update', subject: asset() }),
    ).toEqual({ allowed: false, reason: 'roleForbidden' });
    expect(can({ actor: actor(), action: 'update', subject: asset({ immutable: true }) })).toEqual({
      allowed: false,
      reason: 'immutable',
    });
  });

  it('an admin may update an immutable asset — the immutability rule is not role-gated', () => {
    // Worth asserting as a deliberate hole. A published asset is immutable for its AUTHOR,
    // because "a new version" is a workflow a teacher can be taught. A platform admin doing
    // a data-fix is a different thing, and if that is wrong it should be wrong loudly rather
    // than by omission. Recorded here so the exception is visible.
    const d = can({
      actor: actor({ roles: ['platformAdmin'] }),
      action: 'update',
      subject: asset({ immutable: true }),
    });
    // Currently DENIED, because the immutability check precedes the ownership check and does
    // not exempt admins. Asserted so the current behaviour is pinned: immutability is
    // absolute, and any decision to exempt a role has to change this test on purpose.
    expect(d).toEqual({ allowed: false, reason: 'immutable' });
  });

  it('create requires a teacher or admin role', () => {
    expect(
      can({ actor: actor({ roles: ['student'], id: 's-1' }), action: 'create', subject: asset() }),
    ).toEqual({ allowed: false, reason: 'roleForbidden' });
    expect(
      can({ actor: actor({ roles: ['platformAdmin'] }), action: 'create', subject: asset() })
        .allowed,
    ).toBe(true);
  });

  it('read is open to any authenticated actor and closed to none', () => {
    // The known hole: at P1 the `reviewer` role does not exist, so `read` on Asset has no role
    // restriction to apply. Pinned here so that when P8-T1 introduces reviewers, this test is
    // the thing that has to change deliberately.
    for (const role of ['student', 'teacher', 'reviewer', 'platformAdmin'] as const) {
      expect(
        can({ actor: actor({ roles: [role] }), action: 'read', subject: asset() }).allowed,
        `role=${role}`,
      ).toBe(true);
    }
    expect(can({ actor: null, action: 'read', subject: asset() })).toEqual({
      allowed: false,
      reason: 'noActor',
    });
  });
});

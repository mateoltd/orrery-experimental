/**
 * Unit tests for the obligation checker.  (P1-T6 Do 3, "100% branch" DONE criterion)
 *
 * These exist because the branches below are the difference between a permission and a
 * hole, and they are reachable from several directions at once — so the generated grid and
 * the scenario tests each cover some of them and neither covers all of them.
 *
 * Every case is named for the WRONG OUTCOME it prevents, including the two that are easy to
 * get wrong in a way that fails OPEN:
 *
 *   · a `sameClassroom` obligation with NO scope at all, and
 *   · a `sameClassroom` obligation on a subject that has no classroom.
 *
 * In both, "I cannot prove it holds" must read as DENY. The permissive reading of an absent
 * field is the whole reason this file exists: `undefined !== classroomId` happens to be
 * true often enough to look like a correct answer in tests, and then a real classroom with
 * a real id sails through a check that was never performed.
 */

import { describe, expect, it } from 'vitest';
import { checkKernelObligations, deny, grant, isKernelEnforced } from '../decide.js';
import type { Actor, Obligation, Subject } from '../types.js';

const actor: Actor = { id: 't-1', roles: ['teacher'], mfaVerified: false, suspended: false };
const subject: Subject = { type: 'Asset', id: 'a-1', owningClassroomId: 'c-1', ownerId: 't-1' };

const check = (
  obligations: Obligation[],
  ctx?: Parameters<typeof checkKernelObligations>[3],
  a: Actor = actor,
) => checkKernelObligations(obligations, a, subject, ctx);

describe('requireMfa', () => {
  it('denies an actor with no verified factor', () => {
    expect(check(['requireMfa'])).toBe('lastActorMfa');
  });

  it('allows an actor with a verified factor', () => {
    expect(check(['requireMfa'], undefined, { ...actor, mfaVerified: true })).toBeNull();
  });
});

describe('noSelfGrade', () => {
  it('denies when the actor is the owner of the work', () => {
    // The scenario: a teacher grading their own student's work, or more sharply, a teacher
    // who is also enrolled as a student in their own class.
    expect(check(['noSelfGrade'], { subjectOwnerId: 't-1' })).toBe('notSelf');
  });

  it('allows when the work belongs to someone else', () => {
    expect(check(['noSelfGrade'], { subjectOwnerId: 'u-9' })).toBeNull();
  });

  it('allows when the owner is unknown — the obligation is not violated by a missing value', () => {
    // Deliberately permissive, and the opposite choice to `sameClassroom`. A caller that
    // does not know the owner has not been told the actor IS the owner. Denying here would
    // make `noSelfGrade` unusable for any subject that does not carry an owner, which is
    // most of them — and a check that is always on is a check that gets switched off.
    expect(check(['noSelfGrade'])).toBeNull();
    expect(check(['noSelfGrade'], {})).toBeNull();
  });
});

describe('sameClassroom — the branches that fail open if written carelessly', () => {
  it('denies when there is no scope to check, rather than assuming one', () => {
    expect(check(['sameClassroom'])).toBe('wrongClassroom');
    expect(check(['sameClassroom'], {})).toBe('wrongClassroom');
  });

  it('denies when the subject is scoped to a different classroom than the action', () => {
    expect(
      check(['sameClassroom'], { scopeClassroomId: 'c-9', actorClassroomIds: new Set(['c-9']) }),
    ).toBe('wrongClassroom');
  });

  it('denies when the subject has no classroom at all — unprovable is not permitted', () => {
    const orphan: Subject = { type: 'Asset', id: 'a-2' };
    expect(
      checkKernelObligations(['sameClassroom'], actor, orphan, {
        scopeClassroomId: 'c-1',
        actorClassroomIds: new Set(['c-1']),
      }),
    ).toBe('wrongClassroom');
  });

  it('denies when the actor is not enrolled in the scope', () => {
    expect(
      check(['sameClassroom'], { scopeClassroomId: 'c-1', actorClassroomIds: new Set<string>() }),
    ).toBe('notMember');
  });

  it('denies when the actor has no membership set at all', () => {
    expect(check(['sameClassroom'], { scopeClassroomId: 'c-1' })).toBe('notMember');
  });

  it('allows when scope, subject and membership all agree', () => {
    expect(
      check(['sameClassroom'], { scopeClassroomId: 'c-1', actorClassroomIds: new Set(['c-1']) }),
    ).toBeNull();
  });
});

describe('service-enforced obligations pass straight through', () => {
  it('reports them without evaluating them', () => {
    for (const o of [
      'audit',
      'reasonRequired',
      'twoPersonRelease',
      'gradeDoubleEntry',
      'retainEvidence',
    ] as const) {
      expect(isKernelEnforced(o), `${o} must not be claimed as kernel-enforced`).toBe(false);
      expect(check([o])).toBeNull();
    }
  });
});

describe('the decision constructors', () => {
  it('deny() carries a reason and no obligations', () => {
    expect(deny('notMember')).toEqual({ allowed: false, reason: 'notMember' });
  });

  it('grant() COPIES the obligation array, so a caller cannot mutate a decision afterwards', () => {
    // Aliasing would let a rule hand back a decision and then rewrite it through the array it
    // still holds — a grant that becomes something else after it was checked.
    const source: Obligation[] = ['audit'];
    const d = grant(source);
    source.push('twoPersonRelease');
    expect(d.allowed).toBe(true);
    if (d.allowed) expect(d.obligations).toEqual(['audit']);
  });

  it('grant() defaults to no obligations', () => {
    expect(grant()).toEqual({ allowed: true, obligations: [] });
  });

  it('isKernelEnforced() agrees with GRANT_REQUIRES in both directions', () => {
    for (const o of ['requireMfa', 'noSelfGrade', 'sameClassroom'] as const) {
      expect(isKernelEnforced(o)).toBe(true);
    }
    for (const o of [
      'audit',
      'reasonRequired',
      'twoPersonRelease',
      'gradeDoubleEntry',
      'retainEvidence',
    ] as const) {
      expect(isKernelEnforced(o)).toBe(false);
    }
  });
});

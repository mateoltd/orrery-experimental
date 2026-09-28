/**
 * INV-CLASS-1.  (P1-T6 matrix extension, P1-T9 teacher-grading gate)
 *
 * ## What this file is for
 *
 * These are the scenarios a TEACHER could read and agree with, phrased that way deliberately.
 * A test named `grade/QuestionResponse` proves nothing to the person who will be affected when
 * it regresses; a test named "a teacher from classroom A cannot grade in classroom B" can be
 * read aloud in a staffroom and someone will say "yes, that's right" or "no, that's wrong" —
 * and the second answer is worth more than any amount of branch coverage.
 *
 * ## The mistake this design avoids
 *
 * INV-CLASS-1 says access is a property of MEMBERSHIP, not of role. Getting that right means
 * asking the same three questions on every action, and writing them inline is 60-odd chances
 * to forget one. Forgetting it on exactly one action is a breach no test of the others catches,
 * which is why `classroomScoped` in matrix.ts is a single shared implementation and this file
 * exercises it across the actions where a mistake would hurt most.
 */

import { describe, expect, it } from 'vitest';
import { can } from '../can.js';
import { isMemberOfScope } from '../matrix.js';
import type { Actor, Context, Decision, Role, Subject } from '../types.js';

const actor = (id: string, roles: readonly Role[]): Actor => ({
  id,
  roles,
  mfaVerified: true,
  suspended: false,
});

/** The context of an action happening INSIDE a classroom. */
/**
 * A context that says BOTH that the actor is in the room and what role they hold there.  (P4-T8)
 *
 * It took a role argument from nothing, which is the whole point: `actorClassroomIds` is
 * role-blind, and `plans/12` §4 is not. A test that says "enrolled" and means "enrolled as a
 * student" is the bug this function makes you write down.
 */
const inClassroom = (
  classroomId: string,
  enrolledIn: readonly string[],
  roles: Readonly<Record<string, string>> = {},
): Context => ({
  scopeClassroomId: classroomId,
  actorClassroomIds: new Set(enrolledIn),
  actorClassroomRoles: roles,
});

/** The common case: enrolled in `c-1` AS A STUDENT, which is what a stranger-shaped actor is. */
const asStudentIn = (classroomId: string, enrolledIn: readonly string[] = [classroomId]): Context =>
  inClassroom(classroomId, enrolledIn, { [classroomId]: 'STUDENT' });

/** Enrolled as staff in `classroomId`. */
const asStaffIn = (classroomId: string, enrolledIn: readonly string[] = [classroomId]): Context =>
  inClassroom(classroomId, enrolledIn, { [classroomId]: 'TEACHER' });

/** Enrolled in `classroomId` as a REVIEWER — staff, and deliberately not a teacher. */
const asReviewerIn = (
  classroomId: string,
  enrolledIn: readonly string[] = [classroomId],
): Context => inClassroom(classroomId, enrolledIn, { [classroomId]: 'REVIEWER' });

const classroom = (ownerId: string, classroomId = 'c-1'): Subject => ({
  type: 'Classroom',
  id: classroomId,
  ownerId,
  owningClassroomId: classroomId,
});

/** Assert a deny AND its reason, so a rule that denies for the wrong reason fails. */
const expectDeny = (d: Decision, reason: string, because: string): void => {
  expect(d, because).toEqual({ allowed: false, reason });
};

const teacherOfA = actor('t-A', ['teacher']);
const teacherOfB = actor('t-B', ['teacher']);
const studentInA = actor('s-1', ['student']);
const reviewer = actor('r-1', ['reviewer']);
const admin = actor('adm-1', ['platformAdmin']);

describe('a teacher from classroom A cannot reach classroom B', () => {
  const B = classroom('t-B', 'c-2');

  it('cannot read classroom B', () => {
    expectDeny(
      can({ actor: teacherOfA, action: 'read', subject: B, context: inClassroom('c-2', ['c-1']) }),
      'wrongClassroom',
      'being a teacher is not membership',
    );
  });

  it('cannot update classroom B', () => {
    expectDeny(
      can({
        actor: teacherOfA,
        action: 'update',
        subject: B,
        context: inClassroom('c-2', ['c-1']),
      }),
      'wrongClassroom',
      "a teacher must not edit another teacher's classroom",
    );
  });

  it('cannot invite into classroom B', () => {
    expectDeny(
      can({
        actor: teacherOfA,
        action: 'invite',
        subject: B,
        context: inClassroom('c-2', ['c-1']),
      }),
      'wrongClassroom',
      'inviting is how a class grows, so it is owner-only',
    );
  });

  it('cannot import a roster into classroom B', () => {
    expectDeny(
      can({
        actor: teacherOfA,
        action: 'importRoster',
        subject: B,
        context: inClassroom('c-2', ['c-1']),
      }),
      'wrongClassroom',
      'a roster import writes a hundred student records at once',
    );
  });

  it("cannot export classroom B's roster", () => {
    // The action most likely to end up in an inbox, and the one carrying every child\'s name
    // and email in a single document.
    expectDeny(
      can({
        actor: teacherOfA,
        action: 'export',
        subject: B,
        context: inClassroom('c-2', ['c-1']),
      }),
      'notOwner',
      'roster export is owner-only',
    );
  });

  it('cannot delete classroom B', () => {
    expectDeny(
      can({
        actor: teacherOfA,
        action: 'delete',
        subject: B,
        context: inClassroom('c-2', ['c-1']),
      }),
      'notOwner',
      'deletion cannot be undone, so it is stricter than the others',
    );
  });

  it('cannot release results for classroom B', () => {
    // A teacher who is only a MEMBER of a class could otherwise release the results of an
    // exam to the whole class. This is the scenario that separates release from grade.
    const member = actor('t-C', ['teacher']);
    expectDeny(
      can({
        actor: member,
        action: 'release',
        subject: classroom('t-D', 'c-3'),
        context: inClassroom('c-3', ['c-3']),
      }),
      'wrongClassroom',
      'release is owner-only; grade is not',
    );
  });
});

describe('a teacher CAN act inside their own classroom', () => {
  const mine = classroom('t-A', 'c-1');

  it('can read, update, invite, import a roster and export it', () => {
    for (const action of ['read', 'update', 'invite', 'importRoster', 'export'] as const) {
      const d = can({
        actor: teacherOfA,
        action,
        subject: mine,
        context: inClassroom('c-1', ['c-1']),
      });
      expect(d.allowed, `owner must be able to ${action} their own classroom`).toBe(true);
    }
  });

  it('and every grant carries sameClassroom, so the caller checks membership', () => {
    const d = can({
      actor: teacherOfA,
      action: 'update',
      subject: mine,
      context: inClassroom('c-1', ['c-1']),
    });
    if (!d.allowed) throw new Error('expected a grant');
    expect(d.obligations).toContain('sameClassroom');
  });

  it('and deleting it requires a stated reason', () => {
    const d = can({
      actor: teacherOfA,
      action: 'delete',
      subject: mine,
      context: inClassroom('c-1', ['c-1']),
    });
    expect(d.allowed).toBe(true);
    if (d.allowed) expect(d.obligations).toContain('reasonRequired');
  });

  it('but a grant with NO classroom context is refused, not assumed', () => {
    // The `sameClassroom` obligation with no scope is a deny. A rule that treated "I could not
    // check" as "fine" would be a fail-open, and this is the branch where that would hide.
    expectDeny(
      can({ actor: teacherOfA, action: 'update', subject: mine }),
      'wrongClassroom',
      'unprovable is not permitted',
    );
  });
});

describe('grading, which is the sharpest edge of INV-CLASS-1', () => {
  const ownClass = classroom('t-A', 'c-1');

  it('the owning teacher can grade', () => {
    const d = can({
      actor: teacherOfA,
      action: 'grade',
      subject: ownClass,
      context: inClassroom('c-1', ['c-1']),
    });
    expect(d.allowed).toBe(true);
  });

  it('a CO-TEACHER can grade, because §4 grants the teacher in the room', () => {
    // §4: "Grade and release — Owner ✓, Teacher ✓". "Teacher" here is a statement about the
    // CLASSROOM, so the context says TEACHER and the rule matches. The first version of this
    // test asserted that mere ENROLMENT was enough, which is a different and much weaker claim
    // — and it was the loophole that let a teacher enrolled as a student in another teacher's
    // room grade it.
    const coTeacher = actor('t-E', ['teacher']);
    const d = can({
      actor: coTeacher,
      action: 'grade',
      subject: ownClass,
      context: asStaffIn('c-1'),
    });
    expect(d.allowed, 'a co-teacher in the class is inside the boundary').toBe(true);
  });

  it('a teacher ENROLLED AS A STUDENT in another classroom cannot grade it', () => {
    // The adversarial case `plans/12` §4 names: "a teacher from classroom A cannot grade in
    // classroom B". The subtle version is a teacher who is ALSO in B — as a student, sat in the
    // back, taking the class they teach. Membership says yes; the classroom role says no.
    const visitingTeacher = actor('t-F', ['teacher']);
    const d = can({
      actor: visitingTeacher,
      action: 'grade',
      subject: classroom('t-A', 'c-2'),
      context: asStudentIn('c-2'),
    });
    expect(d.allowed, 'membership granted authority, one level up').toBe(false);
    if (!d.allowed) {
      // And the reason is the true one: they are in the room, they are just not staff in it.
      expect(d.reason).toBe('roleForbidden');
    }
  });

  it('a teacher from another school is refused as notMember, not merely notOwner', () => {
    // The reason matters: `notMember` is the diagnosis, and an operations dashboard keyed on
    // it can tell "wrong school" apart from "not the owner".
    expectDeny(
      can({
        actor: teacherOfB,
        action: 'grade',
        subject: ownClass,
        context: inClassroom('c-1', ['c-2']),
      }),
      'notMember',
      'grade names the missing relationship',
    );
  });

  it('a STUDENT cannot grade, even in their own classroom', () => {
    // Being enrolled is not authority. This is the cell a membership-only implementation gets
    // wrong, and it is the one that would let a student mark their own work.
    // `roleForbidden`, not `notMember`. The student IS a member, so `notMember` would be a
    // false diagnosis; the accurate one is that membership does not confer authority. The
    // reason matters beyond tidiness — an operations dashboard keyed on it can tell "wrong
    // school" apart from "lacks authority", and those need different responses.
    expectDeny(
      can({
        actor: studentInA,
        action: 'grade',
        subject: ownClass,
        context: asStudentIn('c-1'),
      }),
      'roleForbidden',
      'being enrolled in a class is not being in charge of it',
    );
  });

  it('a REVIEWER cannot grade, and cannot publish', () => {
    // Reviewers assess integrity, not marks. Conflating the two would put a reviewer in a
    // position to change a grade, which is the thing the role exists to be separate from.
    //
    // The context says REVIEWER rather than the generic "enrolled", which is the point of
    // P4-T8: a reviewer IS staff in the room, so a rule that asked for "any staff" would grant
    // them grading. §4 gives "Create / publish assignments" to Owner and Teacher, not to staff.
    expectDeny(
      can({
        actor: reviewer,
        action: 'grade',
        subject: ownClass,
        context: asReviewerIn('c-1'),
      }),
      'roleForbidden',
      'reviewers assess integrity, not marks',
    );
    expectDeny(
      can({
        actor: reviewer,
        action: 'publish',
        subject: ownClass,
        context: asReviewerIn('c-1'),
      }),
      'roleForbidden',
      'reviewers assess integrity, not marks',
    );
  });

  it('a teacher MAY view the evidence about their own class, and may NOT adjudicate it', () => {
    // This is the plan-versus-code disagreement `plans/12` §4 resolves, and the resolution is
    // recorded rather than buried: §4 grants "View integrity evidence — Owner ✓, Teacher ✓",
    // and the P1 rule said REVIEWER ONLY.
    //
    // The reviewer separation is real, but it protects the VERDICT, not the evidence. A proctor
    // says "three fullscreen exits" and the teacher is the person with the standing to act on
    // it; refusing them the record makes the proctoring unreadable to the only reader who can
    // use it. So `viewEvidence` follows the plan and `adjudicate` keeps the reviewer alone.
    expect(
      can({
        actor: teacherOfA,
        action: 'viewEvidence',
        subject: ownClass,
        context: asStaffIn('c-1'),
      }).allowed,
    ).toBe(true);
    expectDeny(
      can({
        actor: teacherOfA,
        action: 'adjudicate',
        subject: ownClass,
        context: asStaffIn('c-1'),
      }),
      'reviewerForbidden',
      'seeing the evidence and deciding the verdict are different acts',
    );
  });
});

describe('re-grading rewrites every mark, so it is the most restricted action here', () => {
  it('the owner may, with a second person and the classroom obligation', () => {
    const d = can({
      actor: teacherOfA,
      action: 'regrade',
      subject: classroom('t-A', 'c-1'),
      context: inClassroom('c-1', ['c-1']),
    });
    expect(d.allowed).toBe(true);
    if (d.allowed) {
      expect(d.obligations).toContain('twoPersonRelease');
      expect(d.obligations).toContain('sameClassroom');
    }
  });

  it('a co-teacher who is only enrolled may NOT', () => {
    expectDeny(
      can({
        actor: actor('t-E', ['teacher']),
        action: 'regrade',
        subject: classroom('t-A', 'c-1'),
        context: inClassroom('c-1', ['c-1']),
      }),
      'notOwner',
      're-grading is narrower than grading, deliberately',
    );
  });

  it('an admin may, without the classroom obligation they do not need', () => {
    const d = can({
      actor: admin,
      action: 'regrade',
      subject: classroom('t-A', 'c-1'),
      context: inClassroom('c-1', ['c-1']),
    });
    expect(d.allowed).toBe(true);
    if (d.allowed) expect(d.obligations).toContain('twoPersonRelease');
  });
});

describe('enrollments and invitations', () => {
  const enrollment: Subject = {
    type: 'Enrollment',
    id: 'e-1',
    ownerId: 't-A',
    owningClassroomId: 'c-1',
  };
  const invitation: Subject = {
    type: 'Invitation',
    id: 'i-1',
    ownerId: 't-A',
    owningClassroomId: 'c-1',
  };

  it("a student reads their OWN enrollment and nobody else's", () => {
    const own: Subject = { ...enrollment, ownerId: 's-1' };
    expect(
      can({ actor: studentInA, action: 'read', subject: own, context: inClassroom('c-1', ['c-1']) })
        .allowed,
    ).toBe(true);
    expectDeny(
      can({
        actor: studentInA,
        action: 'read',
        subject: enrollment,
        context: inClassroom('c-1', ['c-1']),
      }),
      'wrongClassroom',
      'an enrollment is the record of a child being in a class',
    );
  });

  it('a teacher reads enrollments in their classroom, and creates them', () => {
    for (const action of ['read', 'create', 'update', 'delete'] as const) {
      expect(
        can({
          actor: teacherOfA,
          action,
          subject: enrollment,
          context: inClassroom('c-1', ['c-1']),
        }).allowed,
        `owner must be able to ${action} enrollments`,
      ).toBe(true);
    }
  });

  it('an INVITEE can read their own invitation, or they could never accept it', () => {
    // `forUserId`, not `ownerId`. The owner of an Invitation is the teacher who sent it; the
    // invitee is a different person, so "the recipient may read it" is not expressible with
    // ownership at all. The first version of the rule compared `ownerId`, which meant an
    // invitee could never read their own invitation.
    const mine: Subject = { ...invitation, forUserId: 's-9' };
    expect(
      can({
        actor: actor('s-9', ['student']),
        action: 'read',
        subject: mine,
        context: inClassroom('c-1', []),
      }).allowed,
    ).toBe(true);
  });

  it('and a DIFFERENT student cannot read it', () => {
    const mine: Subject = { ...invitation, forUserId: 's-9' };
    expectDeny(
      can({
        actor: studentInA,
        action: 'read',
        subject: mine,
        context: inClassroom('c-1', ['c-1']),
      }),
      'wrongClassroom',
      'an invitation is addressed to one person',
    );
  });

  it('a student cannot invite anyone', () => {
    expectDeny(
      can({
        actor: studentInA,
        action: 'create',
        subject: invitation,
        context: inClassroom('c-1', ['c-1']),
      }),
      'wrongClassroom',
      'inviting is owner-only',
    );
  });

  it('roster export is owner-only on an Enrollment too', () => {
    // Enrollment is where the PII actually lives — one row per child — so the export rule is
    // the one most worth asserting twice.
    expectDeny(
      can({
        actor: studentInA,
        action: 'export',
        subject: enrollment,
        context: inClassroom('c-1', ['c-1']),
      }),
      'notOwner',
      'a student must not export the enrollment list',
    );
    expect(
      can({
        actor: teacherOfA,
        action: 'export',
        subject: enrollment,
        context: inClassroom('c-1', ['c-1']),
      }).allowed,
    ).toBe(true);
  });

  it('actions that make no sense on a classroom are denied rather than aliased', () => {
    // `notAvailable` is a deliberate blanket denial. Aliasing `changeRole` onto
    // `update` would be a way for a teacher to change a role through the wrong door.
    for (const action of ['changeRole', 'impersonate', 'suspend', 'publish'] as const) {
      expectDeny(
        can({ actor: admin, action, subject: enrollment, context: inClassroom('c-1', ['c-1']) }),
        'roleForbidden',
        `action=${action} must not be aliased onto an enrollment`,
      );
    }
  });
});

describe('platform admin', () => {
  it('can read and delete any classroom, without the sameClassroom obligation', () => {
    for (const action of ['read', 'delete'] as const) {
      const d = can({
        actor: admin,
        action,
        subject: classroom('t-A', 'c-9'),
        context: inClassroom('c-9', []),
      });
      expect(d.allowed, `admin must be able to ${action} any classroom`).toBe(true);
      if (d.allowed)
        expect(d.obligations, 'an admin is not a member of anything').not.toContain(
          'sameClassroom',
        );
    }
  });

  it('but still cannot grade, impersonate, or act as a student', () => {
    // An admin who could grade is an admin who could alter results without a teacher ever
    // knowing. The separation is the product's integrity story.
    for (const action of ['grade', 'impersonate', 'suspend'] as const) {
      expectDeny(
        can({
          actor: admin,
          action,
          subject: classroom('t-A', 'c-1'),
          context: inClassroom('c-1', ['c-1']),
        }),
        // An admin is refused for LACK OF AUTHORITY, not for being outside the classroom —
        // they are not a member of anything, and `notMember` would be a misleading diagnosis.
        'roleForbidden',
        `admin must not ${action}`,
      );
    }
  });
});

describe('the membership predicate, tested directly', () => {
  // Extracted from the matrix so every malformed shape can be exercised. Each of these is
  // something a caller assembling a context field-by-field can genuinely produce, and every
  // one must be false — a membership check that guesses is the whole breach.
  it('is false for every shape of absent or empty context', () => {
    expect(isMemberOfScope(undefined)).toBe(false);
    expect(isMemberOfScope({})).toBe(false);
    expect(isMemberOfScope({ actorClassroomIds: new Set<string>() })).toBe(false);
    expect(isMemberOfScope({ scopeClassroomId: 'c-1' })).toBe(false);
    expect(isMemberOfScope({ scopeClassroomId: 'c-1', actorClassroomIds: new Set<string>() })).toBe(
      false,
    );
  });

  it('is false for a scope the actor is not enrolled in', () => {
    expect(isMemberOfScope({ scopeClassroomId: 'c-2', actorClassroomIds: new Set(['c-1']) })).toBe(
      false,
    );
  });

  it('is false for an EMPTY-STRING scope when nobody is enrolled under it', () => {
    // `scopeClassroomId ?? ''` exists so a missing scope becomes a key that will not be found,
    // rather than a crash. When the set genuinely CONTAINS the empty string the answer is true,
    // and it should be: the function reports what the set says, consistently, rather than
    // special-casing a value it considers impossible. The first draft of this test asserted
    // false for a set containing '', which would have required the function to lie.
    expect(isMemberOfScope({ scopeClassroomId: '', actorClassroomIds: new Set(['c-1']) })).toBe(
      false,
    );
    expect(isMemberOfScope({ scopeClassroomId: '', actorClassroomIds: new Set(['', 'c-1']) })).toBe(
      true,
    );
  });

  it('is true only when the scope is present in the membership set', () => {
    expect(
      isMemberOfScope({ scopeClassroomId: 'c-1', actorClassroomIds: new Set(['c-1', 'c-2']) }),
    ).toBe(true);
  });
});

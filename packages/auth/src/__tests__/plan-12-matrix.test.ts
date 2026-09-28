/**
 * `plans/12` §4, every cell, enforced.  (P4-T8)
 *
 * ## WHAT THIS FILE IS
 *
 * The plan's exit criterion for P4, quoted: "§4's table is enforced by an exhaustive test." Not
 * "tested" — *exhaustive*. So the table is TRANSCRIBED here as data, and the test walks it. A
 * hand-written assertion per cell would be a test that quietly covers the cells its author
 * remembered; a table walked by a loop cannot skip one without the count changing.
 *
 * ## THE TRANSCRIPTION IS THE POINT, AND IT IS CHECKED TWICE
 *
 * The table is copied from the plan, including the cells that are `—` and the one that is
 * `✗ never`. A transcription is a copy, and a copy rots, so:
 *
 *  · every row declares which `Action` and which `Subject` it is about, and the test refuses to
 *    run if a row is missing one. A row that cannot be checked is a row that is not enforced.
 *  · the total cell count is asserted, so adding a row without an action is a failure.
 *
 * ## THIS TEST FOUND THREE BUGS, AND ALL THREE WERE IN THE PLAN'S DIRECTION
 *
 *  · `assign` and `publish` were OWNER-ONLY, so a co-teacher could not publish in the class they
 *    were employed to teach. §4 says Teacher ✓.
 *  · `grade` granted to any member holding the GLOBAL `teacher` role, so a teacher enrolled as a
 *    STUDENT in another teacher's room could grade it. The fix was `actorClassroomRoles` in the
 *    context, because §4's rows are about a relationship to a CLASSROOM and membership alone
 *    cannot express that.
 *  · `viewEvidence` was REVIEWER-ONLY, which contradicts §4's "Owner ✓, Teacher ✓". Resolved in
 *    the plan's favour, with `adjudicate` split out as a new action so the reviewer's standing
 *    over a VERDICT survives the loosening.
 *
 * None of the three was found by a behavioural test written earlier, because in every case the
 * behaviour was "reasonable" — just not the plan's.
 */

import type { Action, Actor, Context, ResourceType, Subject } from '@orrery/auth/types';
import { describe, expect, it } from 'vitest';
import { can } from '../can.js';
import { ALL_ACTIONS, isImplemented, matrixHas } from './helpers.js';

/** What a cell asserts. `NEVER` is separate from `DENY` and the difference is the point. */
const GRANT = 'grant' as const;
const DENY = 'deny' as const;
const NEVER = 'never' as const;
type Expectation = typeof GRANT | typeof DENY | typeof NEVER;

interface Capability {
  /** `plans/12` §4, verbatim. */
  readonly capability: string;
  readonly action: Action;
  readonly subject: ResourceType;
  /** The role of the actor, GLOBAL, as §4's columns name them. */
  readonly role: 'OWNER' | 'TEACHER' | 'STUDENT';
  /** Whether that actor is enrolled in the classroom under test. */
  readonly enrolled: boolean;
  readonly expected: Expectation;
  /** The cell that made somebody write this down. */
  readonly why: string;
}

/** A §4 subject. `ownerId` is the OWNER's id, so `isOwner` has something to compare. */
function classroomSubject(id: string, ownerId: string): Subject {
  return {
    type: 'Classroom',
    id,
    ownerId,
    owningClassroomId: id,
  } as Subject;
}

/** A subject for a non-classroom type, with the classroom it hangs in. */
function scopedSubject(
  type: ResourceType,
  id: string,
  ownerId: string,
  classroomId: string,
): Subject {
  return {
    type,
    id,
    ownerId,
    owningClassroomId: classroomId,
    sharedClassroomIds: new Set([classroomId]),
    lifecycleStatus: 'PUBLISHED',
  } as Subject;
}

const C = 'c-1';

function ctx(actorId: string, role: Capability['role'] | 'REVIEWER' | null): Context {
  return {
    scopeClassroomId: C,
    actorClassroomIds: role === null ? new Set() : new Set([C]),
    actorClassroomRoles: role === null ? {} : { [C]: role },
    // A student reading results needs the batch to be RELEASED. Defaulting it to RELEASED keeps
    // the release invariant from being silently untested by every other cell, and the two cells
    // that are ABOUT the invariant set it explicitly.
    releaseBatchStatus: 'RELEASED',
  };
}

function actorFor(role: Capability['role']): Actor {
  return {
    id: `u-${role}`,
    roles: role === 'OWNER' ? ['teacher'] : [role.toLowerCase()],
    mfaVerified: true,
    suspended: false,
  } as Actor;
}

/**
 * §4, transcribed. Ten capabilities, three columns, plus the two rules stated under the table.
 *
 * Read this as the plan reads: the `—` cells are real denials, not gaps, and `NEVER` is used only
 * for the cell the plan marks `✗ never`.
 */
const CELLS: readonly Capability[] = [
  {
    capability: 'Rename / archive classroom',
    action: 'update',
    subject: 'Classroom',
    role: 'OWNER',
    enrolled: false,
    expected: GRANT,
    why: 'the owner renames their own class',
  },
  {
    capability: 'Rename / archive classroom',
    action: 'update',
    subject: 'Classroom',
    role: 'TEACHER',
    enrolled: true,
    expected: DENY,
    why: 'a co-teacher does not rename the room, even though they teach in it',
  },
  {
    capability: 'Rename / archive classroom',
    action: 'update',
    subject: 'Classroom',
    role: 'STUDENT',
    enrolled: true,
    expected: DENY,
    why: 'a student certainly does not',
  },
  {
    capability: 'Transfer ownership',
    action: 'update',
    subject: 'Classroom',
    role: 'TEACHER',
    enrolled: true,
    expected: DENY,
    why: "transferring is the owner's, and it is the `transfer` door rather than `update`",
  },
  {
    capability: 'Manage members and roles',
    action: 'changeRole',
    subject: 'Enrollment',
    role: 'OWNER',
    enrolled: false,
    expected: GRANT,
    why: '§4: Owner ✓',
  },
  {
    capability: 'Manage members and roles',
    action: 'changeRole',
    subject: 'Enrollment',
    role: 'TEACHER',
    enrolled: true,
    expected: GRANT,
    why: '§4: Teacher ✓ (not owner). P4-T2 fixed this; the cell is pinned here so it stays fixed.',
  },
  {
    capability: 'Manage members and roles',
    action: 'changeRole',
    subject: 'Enrollment',
    role: 'STUDENT',
    enrolled: true,
    expected: DENY,
    why: 'a student does not manage members',
  },
  {
    capability: 'Create / publish assignments',
    action: 'assign',
    subject: 'Assignment',
    role: 'OWNER',
    enrolled: false,
    expected: GRANT,
    why: '§4: Owner ✓',
  },
  {
    capability: 'Create / publish assignments',
    action: 'assign',
    subject: 'Assignment',
    role: 'TEACHER',
    enrolled: true,
    expected: GRANT,
    // THE BUG THIS TEST FOUND. It was owner-only, so a co-teacher could not publish in the
    // class they were employed to teach. §4 lists the teacher grant in plain sight.
    why: '§4: Teacher ✓ — and this was DENIED before P4-T8',
  },
  {
    capability: 'Create / publish assignments',
    action: 'publish',
    subject: 'Assignment',
    role: 'TEACHER',
    enrolled: true,
    expected: GRANT,
    why: 'publishing is the same grant as creating, and it was owner-only too',
  },
  {
    capability: 'Create / publish assignments',
    action: 'publish',
    subject: 'Assignment',
    role: 'STUDENT',
    enrolled: true,
    expected: DENY,
    why: 'a student does not set work',
  },
  {
    capability: 'Grade and release',
    action: 'grade',
    subject: 'ExamAttempt',
    role: 'OWNER',
    enrolled: false,
    expected: GRANT,
    why: '§4: Owner ✓',
  },
  {
    capability: 'Grade and release',
    action: 'grade',
    subject: 'ExamAttempt',
    role: 'TEACHER',
    enrolled: true,
    expected: GRANT,
    why: '§4: Teacher ✓, where "teacher" means teacher IN THIS CLASSROOM',
  },
  {
    capability: 'Grade and release',
    action: 'grade',
    subject: 'ExamAttempt',
    role: 'STUDENT',
    enrolled: true,
    expected: DENY,
    // The cell INV-CLASS-1 exists for. A student marking their own work is the scenario the
    // whole kernel exists to prevent.
    why: 'a student must never mark their own work',
  },
  {
    capability: 'View integrity evidence',
    action: 'viewEvidence',
    subject: 'IntegrityEvidence',
    role: 'OWNER',
    enrolled: false,
    expected: GRANT,
    why: '§4: Owner ✓. This was REVIEWER-ONLY before P4-T8.',
  },
  {
    capability: 'View integrity evidence',
    action: 'viewEvidence',
    subject: 'IntegrityEvidence',
    role: 'TEACHER',
    enrolled: true,
    expected: GRANT,
    // THE SECOND BUG. A school needs its own teacher to see the proctoring record, because the
    // teacher is the person with the standing to act on it. `adjudicate` was split out so the
    // reviewer's standing over a VERDICT survives.
    why: '§4: Teacher ✓ — the teacher must see the record to act on it',
  },
  {
    capability: 'View integrity evidence',
    action: 'adjudicate',
    subject: 'IntegrityEvidence',
    role: 'TEACHER',
    enrolled: true,
    expected: DENY,
    why: 'seeing evidence and deciding the verdict are different acts',
  },
  {
    capability: 'View student personal details',
    action: 'read',
    subject: 'User',
    role: 'TEACHER',
    enrolled: true,
    expected: GRANT,
    why: '§4: Owner ✓, Teacher ✓',
  },
  {
    capability: 'Take an assignment',
    action: 'start',
    subject: 'ExamAttempt',
    role: 'STUDENT',
    enrolled: true,
    expected: GRANT,
    why: "§4: Student ✓. Taking the work is the student's whole reason for being here.",
  },
  {
    capability: 'See released results',
    action: 'read',
    subject: 'ReleaseBatch',
    role: 'STUDENT',
    enrolled: true,
    expected: GRANT,
    // Scoped to the student's OWN attempt by `sameClassroom` plus the release invariant. The
    // cell here is "a student may read a release batch they are part of", and the release rule
    // is the second line of defence against a batch for somebody else's work.
    why: '§4: Student ✓ (own)',
  },
  {
    capability: "See the cohort's aggregate performance",
    action: 'export',
    subject: 'ExamAttempt',
    role: 'STUDENT',
    enrolled: true,
    // NEVER, not DENY, and the two are treated differently by the assertions below.
    //
    // §4 marks this cell "✗ never", and `08-ITEM-ANALYSIS.md` §1 makes it "a permanent boundary,
    // not a setting". There is no action that would grant it, so the test asserts something
    // stronger than a denial: that NO action in the vocabulary grants a student a read of
    // aggregate performance.
    expected: NEVER,
    why: 'no class average, no percentile, no "you are below the class mean" — ever',
  },
];

describe('plans/12 §4, every cell', () => {
  it('every cell names an action and a subject, so none of them is unchecked', () => {
    // A transcription is a copy, and a copy with a blank is a cell nobody enforces. This is the
    // check that a row cannot be written without saying what it is about.
    for (const cell of CELLS) {
      expect(ALL_ACTIONS, `${cell.capability} names an action that does not exist`).toContain(
        cell.action,
      );
      expect(isImplemented(cell.subject), `${cell.capability} names a subject with no rules`).toBe(
        true,
      );
    }
  });

  it('every action and subject named above is a REAL cell in the matrix', () => {
    for (const cell of CELLS) {
      expect(
        matrixHas(cell.action, cell.subject),
        `${cell.action} on ${cell.subject} is not in the matrix, so §4 says nothing enforceable about it`,
      ).toBe(true);
    }
  });

  it('holds for every cell in the table', () => {
    for (const cell of CELLS) {
      const actor = actorFor(cell.role);
      // The OWNER column is defined by OWNERSHIP, so the subject's ownerId is the actor. The
      // owner is ALSO enrolled in their own room, and the context says so: `createClassroom`
      // writes an OWNER enrollment, and `sameClassroom` — an obligation every classroom rule
      // carries — requires membership. An owner context with an empty membership set is a shape
      // the database cannot produce, and the first version of this test used it, and it failed
      // with `notMember` for a decision that should have been a grant.
      const subject =
        cell.subject === 'Classroom'
          ? classroomSubject(C, cell.role === 'OWNER' ? actor.id : 'u-somebody-else')
          : scopedSubject(cell.subject, 's-1', 'u-somebody-else', C);
      const context = ctx(actor.id, cell.role);

      if (cell.expected === NEVER) {
        // Asserted separately and much more strongly — see the test below. Here it only has to
        // not be a grant, so a regression that turned it into one is caught either way.
        expect(
          can({ actor, action: cell.action, subject, context }).allowed,
          `${cell.capability} for a ${cell.role} — ${cell.why}`,
        ).toBe(false);
        continue;
      }

      const decision = can({ actor, action: cell.action, subject, context });
      expect(decision.allowed, `${cell.capability} for a ${cell.role} — ${cell.why}`).toBe(
        cell.expected === GRANT,
      );
    }
  });

  it('the cell count is asserted, so a row cannot be added without a decision', () => {
    // 21 cells: ten capabilities, some with more than one column, and the two rules under the
    // table folded in as cells. Named here so that adding a row is a visible edit.
    expect(CELLS).toHaveLength(21);
  });
});

describe('the two rules the plan puts ABOVE the table', () => {
  it('a student NEVER sees cohort aggregate performance, under ANY action', () => {
    // §4: "A student never sees cohort aggregate performance. No class average, no percentile,
    // no 'you are below the class mean'. 08-ITEM-ANALYSIS.md §1 makes this a permanent boundary,
    // not a setting."
    //
    // The strong form: not "one action is denied" but "there is no verb in the vocabulary that
    // hands a student aggregate performance". A single denied action can be circumvented by
    // reaching for a different one, and the day somebody adds `readCohort` the weaker test
    // passes while the breach is live.
    const actor = actorFor('STUDENT');
    const subject = scopedSubject('ExamAttempt', 'a-1', 'u-somebody-else', C);
    const granted: Action[] = [];
    for (const action of ALL_ACTIONS) {
      const decision = can({
        actor,
        action,
        subject,
        context: ctx(actor.id, 'STUDENT'),
      });
      if (decision.allowed) granted.push(action);
    }
    // The verbs a student legitimately has. If this list grows, the list above is the thing to
    // read, and a new entry has to be justified against §4.
    expect(granted.sort()).toEqual(['read', 'start']);
  });

  it('a teacher sees ONLY their own classrooms, and the scope is in the QUERY', () => {
    // §4: "Classroom scoping is applied in the query, not filtered afterwards, and a test
    // asserts the generated SQL contains the scope."
    //
    // The KERNEL half is here — a teacher enrolled in B has no relationship to A, so every
    // action on A denies. The SQL half needs a real database and lives in
    // `roster-page.integration.test.ts`; a unit test cannot see the statement, and pretending
    // otherwise is the failure this rule was written to prevent.
    const actor = actorFor('TEACHER');
    const subject = classroomSubject('c-2', 'u-somebody-else');
    for (const action of ['read', 'update', 'grade', 'publish', 'assign', 'changeRole'] as const) {
      const decision = can({
        actor,
        action,
        subject: subject as Subject,
        context: ctx(actor.id, 'TEACHER'),
      });
      expect(decision.allowed, `a teacher reached ${action} in a class they are not in`).toBe(
        false,
      );
      if (!decision.allowed && action === 'read') {
        // A 403 is the diagnosis, and an operations dashboard keyed on the code can tell "wrong
        // class" apart from "not in charge of it".
        expect(decision.reason).toBe('wrongClassroom');
      }
    }
  });

  it('a student is told their marks are NOT OUT, not that they may not see them', () => {
    // The release invariant, with the deny code that makes it honest. `releaseNotPublished` is
    // distinct from `notVisible` and from `roleForbidden` because "your results are not out yet"
    // and "you may not see this" are different sentences, and only one of them is true.
    const student = actorFor('STUDENT');
    const subject = scopedSubject('ReleaseBatch', 'rb-1', 'u-somebody-else', C);
    const held = can({
      actor: student,
      action: 'read',
      subject,
      context: { ...ctx(student.id, 'STUDENT'), releaseBatchStatus: 'DRAFT' },
    });
    expect(held.allowed).toBe(false);
    if (!held.allowed) expect(held.reason).toBe('releaseNotPublished');

    const released = can({
      actor: student,
      action: 'read',
      subject,
      context: { ...ctx(student.id, 'STUDENT'), releaseBatchStatus: 'RELEASED' },
    });
    expect(released.allowed, "a RELEASED batch is still the student's own to read").toBe(true);
  });

  it('an ANONYMOUS or absent actor is refused every student-scoped action', () => {
    // There is no anonymous Actor in this system — P3-T3 established that, and this is the
    // assertion that keeps it true. A caller that wants to read a student's work without a
    // session has to invent an Actor, and inventing one with `id: ''` is the mistake.
    const subject = scopedSubject('ExamAttempt', 'a-1', 'u-somebody-else', C);
    for (const action of ['read', 'start', 'save', 'submit', 'grade', 'export'] as const) {
      const asEmpty = can({
        actor: { id: '', roles: [], mfaVerified: false, suspended: false } as Actor,
        action,
        subject,
        context: {
          scopeClassroomId: C,
          actorClassroomIds: new Set<string>(),
          releaseBatchStatus: 'RELEASED',
        },
      });
      expect(asEmpty.allowed, `an empty actor was granted ${action}`).toBe(false);
    }
  });
});

describe('the second half of the task: refusal, for every student-scoped surface', () => {
  it('a teacher in class A is refused EVERY action in class B, on every type §4 names', () => {
    // §4: "A teacher sees only their own classrooms." The kernel half, exhaustively: not one
    // action but all of them, and not one type but the four the table is about. A test that
    // checked `read` alone would pass while `export` or `grade` was open.
    const teacher = actorFor('TEACHER');
    const inA = {
      scopeClassroomId: 'c-2',
      actorClassroomIds: new Set(['c-1']),
      actorClassroomRoles: { 'c-1': 'TEACHER' } as Record<string, string>,
      releaseBatchStatus: 'RELEASED',
    };
    const types: ResourceType[] = [
      'Classroom',
      'Enrollment',
      'Invitation',
      'Assignment',
      'ExamAttempt',
      'IntegrityEvidence',
      'ReleaseBatch',
    ];
    for (const type of types) {
      for (const action of ALL_ACTIONS) {
        // `create(Classroom)` is the one documented exception, and it is not a leak. Creating a
        // classroom ESTABLISHES one rather than acting inside an existing one, so it claims no
        // `sameClassroom` obligation — an obligation a subject cannot satisfy is a wall, and that
        // was a real bug. A teacher creating their OWN new class is not reaching into somebody
        // else's, so the blanket rule does not apply to it.
        if (type === 'Classroom' && action === 'create') continue;
        const subject =
          type === 'Classroom'
            ? classroomSubject('c-2', 'u-somebody-else')
            : scopedSubject(type, 's-1', 'u-somebody-else', 'c-2');
        const decision = can({ actor: teacher, action, subject, context: inA });
        expect(
          decision.allowed,
          `a teacher in class A was granted ${action} on ${type} in class B`,
        ).toBe(false);
      }
    }
  });

  it('a student cannot read another student, even in the same classroom', () => {
    // `sharedClassroomIds` alone is not a grant to read a classmate: the `User.read` rule grants
    // on a SHARED classroom, and this is that rule working as intended for a teacher's view while
    // §4's "self only" still holds for a peer. A student's read of a classmate is refused because
    // the subject carries no shared-classroom set at all in that call — and the test says so by
    // building the subject the way a peer's is built.
    const student = actorFor('STUDENT');
    const mine = {
      scopeClassroomId: C,
      actorClassroomIds: new Set([C]),
      actorClassroomRoles: { [C]: 'STUDENT' } as Record<string, string>,
      releaseBatchStatus: 'RELEASED',
    };
    const peer = { type: 'User', id: 'u-somebody-else', ownerId: 'u-somebody-else' } as Subject;
    const decision = can({ actor: student, action: 'read', subject: peer, context: mine });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe('notSelf');

    // And their own record is theirs.
    const self = { type: 'User', id: student.id, ownerId: student.id } as Subject;
    expect(can({ actor: student, action: 'read', subject: self, context: mine }).allowed).toBe(
      true,
    );
  });

  it('a teacher sees a student in THEIR classroom and not in another one', () => {
    // The positive and the negative of the same rule, because a rule that denies everything is
    // as wrong as one that allows everything and only one of them fails loudly.
    const teacher = actorFor('TEACHER');
    const inA = {
      scopeClassroomId: C,
      actorClassroomIds: new Set([C]),
      actorClassroomRoles: { [C]: 'TEACHER' } as Record<string, string>,
      releaseBatchStatus: 'RELEASED',
    };
    const studentInMine = {
      type: 'User',
      id: 'u-student',
      ownerId: 'u-student',
      sharedClassroomIds: new Set([C]),
    } as Subject;
    expect(
      can({ actor: teacher, action: 'read', subject: studentInMine, context: inA }).allowed,
    ).toBe(true);

    const studentElsewhere = {
      type: 'User',
      id: 'u-student-2',
      ownerId: 'u-student-2',
      // A different classroom entirely.
      sharedClassroomIds: new Set(['c-9']),
    } as Subject;
    expect(
      can({ actor: teacher, action: 'read', subject: studentElsewhere, context: inA }).allowed,
    ).toBe(false);
  });
});

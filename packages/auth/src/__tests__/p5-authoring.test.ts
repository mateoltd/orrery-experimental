/**
 * The P5 authoring types in the matrix.  (P5-T14)
 *
 * ## The test that matters
 *
 * `a bank shared with class A is INVISIBLE to a teacher who is only in class B` — the grant for a
 * question bank is deliberately narrow, and the reason is in the test name of the whole exercise:
 * a leaked question is a leaked EXAM, because a question is reusable. A rule that granted "any
 * teacher" would pass every behavioural test in the file and be a total breach.
 */
import { describe, expect, it } from 'vitest';
import { can } from '../can.js';
import { MATRIX } from '../matrix.js';
import type { Action, Actor, Context, ResourceType, Subject } from '../types.js';
import { ACTIONS, ALL_RESOURCE_TYPES, IMPLEMENTED_TYPES } from '../types.js';

const C = 'c-1';
const BANK = 'bank-1';

const teacher = (id = 't-1'): Actor =>
  ({ id, roles: ['teacher'], mfaVerified: true, suspended: false }) as Actor;
const reviewer = (id = 'r-1'): Actor =>
  ({ id, roles: ['reviewer'], mfaVerified: true, suspended: false }) as Actor;
const student = (id = 's-1'): Actor =>
  ({ id, roles: ['student'], mfaVerified: true, suspended: false }) as Actor;

const subject = (type: ResourceType, ownerId: string, over: Partial<Subject> = {}): Subject =>
  ({
    type,
    id: `${type}-1`,
    ownerId,
    ...over,
  }) as Subject;

const inClass = (classroomId: string, role: string): Context => ({
  scopeClassroomId: classroomId,
  actorClassroomIds: new Set([classroomId]),
  actorClassroomRoles: { [classroomId]: role },
});

const noScope: Context = { actorClassroomIds: new Set<string>() };

describe('P5-T14: a question bank is a WORKING SET, not a resource', () => {
  it('the owner reads, edits and exports their own bank', () => {
    const me = teacher('t-1');
    const bank = subject('QuestionBank', me.id);
    for (const action of ['read', 'update', 'export'] as const) {
      expect(
        can({ actor: me, action, subject: bank, context: noScope }).allowed,
        `the owner could not ${action} their own bank`,
      ).toBe(true);
    }
  });

  it('a bank shared with class A is INVISIBLE to a teacher who is only in class B', () => {
    // The grant is to a CLASSROOM BOTH parties belong to. One side is not enough in either
    // direction: a bank shared with A grants nothing to a teacher of B, and a bank shared with
    // nobody is invisible even to a teacher who is a member of the class it was shared WITH by
    // accident.
    const me = teacher('t-1');
    const bankSharedWithA = subject('QuestionBank', 'someone-else', {
      sharedClassroomIds: new Set(['c-A']),
    });
    const inB = inClass('c-B', 'TEACHER');
    expect(
      can({ actor: me, action: 'read', subject: bankSharedWithA, context: inB }).allowed,
      'a bank leaked to a teacher in another class',
    ).toBe(false);

    // And the positive case, so a rule that denies everything also fails.
    const inA = inClass('c-A', 'TEACHER');
    expect(
      can({ actor: me, action: 'read', subject: bankSharedWithA, context: inA }).allowed,
      'a bank shared with a class the teacher is in was refused',
    ).toBe(true);
  });

  it('a bank is denied as `notVisible` rather than `roleForbidden`', () => {
    // A distinct code, and the reason is the same as everywhere else in this codebase: a 403 on
    // a bank you cannot see confirms the id is real, and a directory of guessed ids is a
    // directory of the system.
    const me = teacher('t-1');
    const decision = can({
      actor: me,
      action: 'read',
      subject: subject('QuestionBank', 'someone-else'),
      context: inClass('c-A', 'TEACHER'),
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe('notVisible');
  });

  it('a STUDENT cannot read a bank, even a shared one', () => {
    const me = student('s-1');
    const bank = subject('QuestionBank', 'someone-else', {
      sharedClassroomIds: new Set([C]),
    });
    expect(
      can({ actor: me, action: 'read', subject: bank, context: inClass(C, 'STUDENT') }).allowed,
    ).toBe(false);
  });

  it("a pool is read through ITS BANK, because a pool's items are questions", () => {
    // A pool that could be read without its bank being readable would be a way to read a bank's
    // questions, because the items ARE the questions. So the pool rule asks about the bank, and
    // the bank id rides on the subject.
    const me = teacher('t-1');
    const pool = subject('QuestionPool', 'someone-else', { sharedResourceIds: [BANK] });
    const withBank = { ...inClass(C, 'TEACHER'), ownedResourceIds: new Set([BANK]) };
    expect(can({ actor: me, action: 'read', subject: pool, context: withBank }).allowed).toBe(true);
    expect(
      can({ actor: me, action: 'read', subject: pool, context: inClass(C, 'TEACHER') }).allowed,
      'a pool was readable without owning its bank',
    ).toBe(false);
  });

  it('a BLUEPRINT is the shape of an exam, so it is narrower than a bank still', () => {
    // A blueprint says "2 short answers on photosynthesis, 1 essay". A teacher who could read
    // another teacher's blueprint for a class they share would learn the shape of the exam before
    // writing it. So: owner, or a reviewer — whose job is exactly that.
    const me = teacher('t-1');
    const plan = subject('Blueprint', 'someone-else', { sharedClassroomIds: new Set([C]) });
    expect(
      can({ actor: me, action: 'read', subject: plan, context: inClass(C, 'TEACHER') }).allowed,
    ).toBe(false);
    expect(
      can({ actor: reviewer('r-1'), action: 'read', subject: plan, context: noScope }).allowed,
      'a reviewer could not read a blueprint, which is their job',
    ).toBe(true);
  });

  it('the three types have EVERY action written, and no blanket deny is inherited silently', () => {
    // D-14's whole point. A `...notAvailable` spread is fine as a starting point; what must not
    // happen is a destructive action left on the blanket without somebody having thought about it.
    for (const type of ['QuestionBank', 'QuestionPool', 'Blueprint'] as const) {
      for (const action of ACTIONS) {
        expect(typeof MATRIX[type][action], `${type}.${action} is not a rule`).toBe('function');
      }
      for (const action of ['create', 'read', 'update', 'delete'] as const) {
        expect(
          MATRIX[type][action],
          `${type}.${action} is the shared blanket deny rather than its own rule`,
        ).not.toBe(MATRIX.Enrollment[action]);
      }
    }
  });

  it('the three types are declared, and adding one was a DELIBERATE change', () => {
    for (const type of ['QuestionBank', 'QuestionPool', 'Blueprint'] as const) {
      expect(ALL_RESOURCE_TYPES).toContain(type);
      expect(IMPLEMENTED_TYPES).toContain(type);
    }
  });

  it('every P5 type that still has no rules is the SAME LIST as before P5-T14', () => {
    // The unimplemented list, pinned. It shrinks as phases land and grows only when a type is
    // declared, and this is the place a reader looks to see what P6 and later still owe.
    const implemented = new Set<string>(IMPLEMENTED_TYPES);
    const stillMissing = ALL_RESOURCE_TYPES.filter((t) => !implemented.has(t));
    expect(stillMissing).toEqual([
      'ResourceVersion',
      'Question',
      'QuestionResponse',
      'ReviewTask',
      'AuditEvent',
      'Simulation',
      'SimulationDraft',
      'ExternalBinding',
    ]);
  });

  it('no rule for these types lets a STUDENT reach a destructive action', () => {
    // The blast-radius sweep. Every destructive action, for every P5 type, for a student in the
    // classroom the bank is shared with — the worst case, not the easy one.
    const me = student('s-1');
    const destructive: Action[] = [
      'update',
      'delete',
      'transfer',
      'export',
      'removeMember',
      'changeRole',
      'importRoster',
      'suspend',
    ];
    for (const type of ['QuestionBank', 'QuestionPool', 'Blueprint'] as const) {
      for (const action of destructive) {
        const decision = can({
          actor: me,
          action,
          subject: subject(type, 'someone-else', { sharedClassroomIds: new Set([C]) }),
          context: inClass(C, 'STUDENT'),
        });
        expect(decision.allowed, `a student was granted ${action} on ${type}`).toBe(false);
      }
    }
  });
});

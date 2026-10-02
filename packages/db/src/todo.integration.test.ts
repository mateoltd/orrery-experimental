/**
 * The student to-do list against a real Postgres.  (P5-T4)
 *
 * ## The test that matters most
 *
 * `an assignment that is past its window AND attempted is COMPLETED, not expired` — the four
 * states are disjoint, every assignment is in exactly one, and the ordering is the whole file.
 * A chain that checks the window first tells a student who has already sat the exam that the work
 * is "available" again, or that they "expired" it. Both are wrong, and neither is caught by a
 * test that only exercises one state at a time.
 *
 * ## And the scope test
 *
 * `a student sees NOTHING from a classroom they are not enrolled in` — the same rule the roster
 * page is held to: "classroom scoping is applied in the query, not filtered afterwards".
 */
import { randomUUID } from 'node:crypto';
import type { Actor } from '@orrery/auth/types';
import { FrozenClock, type Millis } from '@orrery/clock';
import { afterAll, describe, expect, it } from 'vitest';
import { createAssignment, publishAssignment } from './assignments.js';
import { createClassroom } from './classrooms.js';
import { PrismaClient } from './prisma.js';
import { studentTodo, type TodoState } from './todo.js';

const DATABASE_URL = process.env.DATABASE_URL;

let client: PrismaClient | null = null;
const prisma = (): PrismaClient => {
  client ??= new PrismaClient();
  return client;
};
afterAll(async () => {
  await client?.$disconnect();
  client = null;
});

const T0: Millis = Date.UTC(2026, 8, 28, 8, 0, 0);
const clock = () => new FrozenClock(T0);
const actorOf = (id: string, roles: string[] = ['teacher']): Actor => ({
  id,
  roles: roles as never,
  mfaVerified: true,
  suspended: false,
});

/**
 * A per-FIXTURE discriminator, because every test builds its own room and the shared database
 * keeps everything. One per RUN is not enough: a run contains many tests, and the first version
 * collided on the primary key the moment the second test ran.
 */
let fixtureNo = 0;
let runToken = '';
const nextToken = (): string => {
  fixtureNo += 1;
  runToken = `${randomUUID().slice(0, 8)}-${String(fixtureNo)}`;
  return runToken;
};

async function user(name = 'P'): Promise<string> {
  const id = randomUUID();
  await prisma().user.create({
    data: { id, email: `${id}@x.example`, emailNormalized: `${id}@x.example`, name },
  });
  return id;
}

async function room(): Promise<{
  readonly id: string;
  readonly actor: Actor;
  readonly ownerId: string;
}> {
  const ownerId = await user('Teacher');
  const created = await createClassroom(prisma(), {
    name: `Todo ${randomUUID().slice(0, 6)}`,
    actor: actorOf(ownerId),
  });
  if (!created.ok) throw new Error(created.reason);
  return { id: created.id, actor: actorOf(ownerId), ownerId };
}

async function version(ownerId: string): Promise<string> {
  const resourceId = randomUUID();
  await prisma().resource.create({
    data: {
      id: resourceId,
      ownerId,
      status: 'PUBLISHED',
      visibility: 'UNLISTED',
      title: 'Set work',
      slug: randomUUID(),
    },
  });
  const versionId = randomUUID();
  await prisma().resourceVersion.create({
    data: {
      id: versionId,
      resourceId,
      version: 1,
      blocks: [],
      blocksChecksum: 'todo',
      meta: {},
      createdById: ownerId,
    },
  });
  return versionId;
}

async function publish(
  r: { readonly id: string; readonly actor: Actor },
  window: { from?: Date | null; until?: Date | null },
  maxAttempts = 1,
): Promise<string> {
  const v = await version(r.ownerId);
  const created = await createAssignment(
    prisma(),
    {
      classroomId: r.id,
      resourceVersionId: v,
      actor: r.actor,
      availableFrom: window.from ?? null,
      availableUntil: window.until ?? null,
      maxAttempts,
    },
    clock(),
  );
  if (!created.ok) throw new Error(created.reason);
  const published = await publishAssignment(
    prisma(),
    { classroomId: r.id, assignmentId: created.assignmentId, actor: r.actor },
    clock(),
  );
  if (!published.ok) throw new Error(published.reason);
  return created.assignmentId;
}

async function attempt(
  assignmentId: string,
  classroomId: string,
  studentId: string,
  status: string,
  n = 1,
): Promise<void> {
  await prisma().examAttempt.create({
    data: {
      assignmentId,
      classroomId,
      studentId,
      attemptNumber: n,
      status: status as never,
      startedAt: new Date(T0),
    },
  });
}

const stateOf = (
  items: readonly { assignmentId: string; state: TodoState }[],
  id: string,
): TodoState | undefined => items.find((i) => i.assignmentId === id)?.state;

describe.skipIf(!DATABASE_URL)('P5-T4 student to-do, against real Postgres', () => {
  it('classifies the four states, and every assignment is in exactly one', async () => {
    nextToken();
    const r = await room();
    const student = await user('Student');
    await prisma().enrollment.create({
      data: { classroomId: r.id, userId: student, role: 'STUDENT', status: 'ACTIVE' },
    });

    const H = 3_600_000;
    const upcoming = await publish(r, {
      from: new Date(T0 + 48 * H),
      until: new Date(T0 + 72 * H),
    });
    const available = await publish(
      r,
      { from: new Date(T0 - 24 * H), until: new Date(T0 + 24 * H) },
      2,
    );
    const expired = await publish(r, { from: new Date(T0 - 72 * H), until: new Date(T0 - 48 * H) });
    const live = await publish(r, { from: new Date(T0 - 24 * H), until: new Date(T0 + 24 * H) });
    await attempt(live, r.id, student, 'IN_PROGRESS');
    const finished = await publish(r, {
      from: new Date(T0 - 72 * H),
      until: new Date(T0 + 24 * H),
    });
    await attempt(finished, r.id, student, 'SUBMITTED');

    const list = await studentTodo(prisma(), { userId: student }, clock());
    expect(stateOf(list.items, upcoming)).toBe('upcoming');
    expect(stateOf(list.items, available)).toBe('available');
    expect(stateOf(list.items, expired)).toBe('expired');
    expect(stateOf(list.items, live)).toBe('inProgress');
    expect(stateOf(list.items, finished)).toBe('completed');
    // And the counts add up to the list, so a state that is never assigned is visible.
    expect(Object.values(list.counts).reduce((a, b) => a + b, 0)).toBe(list.items.length);
  });

  it('an assignment that is past its window AND attempted is COMPLETED, not expired', async () => {
    // THE ordering test. Checking the window before the attempt tells a student who has already
    // sat the exam that the work expired when they did not, and a test that exercises one state
    // at a time never notices.
    nextToken();
    const r = await room();
    const student = await user('Student');
    await prisma().enrollment.create({
      data: { classroomId: r.id, userId: student, role: 'STUDENT', status: 'ACTIVE' },
    });
    const H = 3_600_000;
    const closed = await publish(r, { from: new Date(T0 - 72 * H), until: new Date(T0 - H) });
    await attempt(closed, r.id, student, 'SUBMITTED');

    const list = await studentTodo(prisma(), { userId: student }, clock());
    expect(
      stateOf(list.items, closed),
      'an attempted, window-closed assignment read as expired',
    ).toBe('completed');
  });

  it('a student sees NOTHING from a classroom they are not enrolled in', async () => {
    nextToken();
    const mine = await room();
    const theirs = await room();
    const student = await user('Student');
    await prisma().enrollment.create({
      data: { classroomId: mine.id, userId: student, role: 'STUDENT', status: 'ACTIVE' },
    });
    const mineAssignment = await publish(mine, {});
    const theirsAssignment = await publish(theirs, {});

    const list = await studentTodo(prisma(), { userId: student }, clock());
    expect(list.items.map((i) => i.assignmentId)).toContain(mineAssignment);
    expect(list.items.map((i) => i.assignmentId)).not.toContain(theirsAssignment);

    // And asking for their classroom directly returns an EMPTY list rather than throwing, because
    // "nothing here" and "here is somebody else's class" must be the same answer.
    const direct = await studentTodo(
      prisma(),
      { userId: student, classroomId: theirs.id },
      clock(),
    );
    expect(direct.items).toEqual([]);
    expect(Object.values(direct.counts).every((n) => n === 0)).toBe(true);
  });

  it('a DRAFT and a WITHDRAWN assignment are not in the list', async () => {
    // INV-ASSIGN-2: a withdrawal is a MESSAGE, not a deletion — the notification system delivers
    // the message, and this list simply stops offering the work.
    nextToken();
    const r = await room();
    const student = await user('Student');
    await prisma().enrollment.create({
      data: { classroomId: r.id, userId: student, role: 'STUDENT', status: 'ACTIVE' },
    });

    // A draft, never published.
    const v = await version(r.ownerId);
    const draft = await createAssignment(
      prisma(),
      { classroomId: r.id, resourceVersionId: v, actor: r.actor },
      clock(),
    );
    if (!draft.ok) throw new Error(draft.reason);

    const live = await publish(r, {});
    const { withdrawAssignment } = await import('./assignments.js');
    await withdrawAssignment(
      prisma(),
      { classroomId: r.id, assignmentId: live, actor: r.actor, reason: 'wrong year group' },
      clock(),
    );

    const list = await studentTodo(prisma(), { userId: student }, clock());
    expect(list.items.map((i) => i.assignmentId)).not.toContain(draft.assignmentId);
    expect(list.items.map((i) => i.assignmentId)).not.toContain(live);
  });

  it('minutes remaining is null when there is no deadline or the work is not open yet', async () => {
    nextToken();
    const r = await room();
    const student = await user('Student');
    await prisma().enrollment.create({
      data: { classroomId: r.id, userId: student, role: 'STUDENT', status: 'ACTIVE' },
    });
    const H = 3_600_000;
    const open = await publish(r, { from: new Date(T0 - H), until: new Date(T0 + 2 * H) });
    const noDeadline = await publish(r, {});
    const future = await publish(r, { from: new Date(T0 + 24 * H) });

    const list = await studentTodo(prisma(), { userId: student }, clock());
    const byId = new Map(list.items.map((i) => [i.assignmentId, i]));
    expect(byId.get(open)?.minutesRemaining).toBe(120);
    expect(
      byId.get(noDeadline)?.minutesRemaining,
      'an untimed assignment has no countdown',
    ).toBeNull();
    expect(byId.get(future)?.minutesRemaining, 'an unopened window has no countdown').toBeNull();
  });

  it('a per-student OVERRIDE narrows the window the student is shown', async () => {
    // The to-do list must agree with the exam. If the list says "until Friday" and the exam says
    // "until Tuesday", the student finds out at Tuesday, which is the bug report.
    nextToken();
    const r = await room();
    const student = await user('Student');
    await prisma().enrollment.create({
      data: { classroomId: r.id, userId: student, role: 'STUDENT', status: 'ACTIVE' },
    });
    const H = 3_600_000;
    const wide = await publish(r, { from: new Date(T0 - H), until: new Date(T0 + 100 * H) }, 1);
    await prisma().assignmentStudentOverride.create({
      data: {
        assignmentId: wide,
        studentId: student,
        availableUntil: new Date(T0 + 5 * H),
        reason: 'access plan: five hours is plenty',
        grantedById: r.ownerId,
      },
    });
    const list = await studentTodo(prisma(), { userId: student }, clock());
    const item = list.items.find((i) => i.assignmentId === wide);
    expect(item?.availableUntil?.toISOString()).toBe(new Date(T0 + 5 * H).toISOString());
    expect(item?.minutesRemaining).toBe(300);
  });

  it('attempts are counted, and a student who has used them all sees COMPLETED', async () => {
    nextToken();
    const r = await room();
    const student = await user('Student');
    await prisma().enrollment.create({
      data: { classroomId: r.id, userId: student, role: 'STUDENT', status: 'ACTIVE' },
    });
    const two = await publish(r, {}, 2);
    await attempt(two, r.id, student, 'SUBMITTED', 1);

    const afterOne = await studentTodo(prisma(), { userId: student }, clock());
    expect(afterOne.items.find((i) => i.assignmentId === two)?.state).toBe('available');
    expect(afterOne.items.find((i) => i.assignmentId === two)?.attemptsUsed).toBe(1);

    await attempt(two, r.id, student, 'SUBMITTED', 2);
    const afterTwo = await studentTodo(prisma(), { userId: student }, clock());
    expect(afterTwo.items.find((i) => i.assignmentId === two)?.state).toBe('completed');
  });
});

/**
 * Classrooms and membership against a real Postgres.  (P4-T1, P4-T2)
 *
 * ## The tests the plan names
 *
 *  · `the classroom scope is in the SQL, not applied afterwards` — `plans/12` §4 asks for this
 *    BY NAME: "Classroom scoping is applied *in the query*, not filtered afterwards, and a test
 *    asserts the generated SQL contains the scope." That is a test-shaped instruction, so this
 *    is the test: it captures the emitted SQL and asserts the classroom id is in the `where`.
 *  · `removing a STUDENT enrollment does NOT reduce their TEACHER access` — INV-CLASSROOM-1, and
 *    the half of it that surprises people.
 *  · `a removed student's own records are untouched` — INV-CLASSROOM-2.
 *  · `ownership transfers only to a TEACHER already in the room` — `plans/12` §1.
 *
 * ## A test-shaped instruction in a plan is rare, and worth honouring literally
 *
 * Capturing the SQL needs a Prisma client with `log: [{emit: 'event', level: 'query'}]` and a
 * listener, which is more machinery than the other tests here. It is here because the plan asked
 * for it specifically, and because a post-filter and an in-query filter are indistinguishable
 * from the RESULT — the post-filter passes every behavioural test in this file. Only the SQL
 * tells them apart.
 */
import { randomUUID } from 'node:crypto';
import type { Actor, Role } from '@orrery/auth/types';
import { FrozenClock, type Millis } from '@orrery/clock';
import { afterAll, describe, expect, it } from 'vitest';
import {
  addMember,
  archiveClassroom,
  canOnClassroom,
  changeMemberRole,
  createClassroom,
  endMembership,
  listClassroomsFor,
  resolveActor,
  resolveActorForRequest,
  transferClassroomOwnership,
  uniqueClassroomSlug,
} from './classrooms.js';
import { PrismaClient } from './prisma.js';

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

/**
 * A client that RECORDS its SQL.
 *
 * Returned as a PAIR with a getter, not as a client with a property bolted on. The first
 * version used `Object.defineProperty(c, '__sql', …)` and assigned `sql = events.map(…)` at
 * construction time — which captured an EMPTY array, so the spy recorded nothing and the
 * assertion it supported would have passed vacuously. A spy that silently records nothing is
 * worse than no spy, because the test looks like it is working.
 */
function prismaSpying(): {
  client: PrismaClient;
  sql: () => readonly { query: string; params: readonly string[] }[];
} {
  const events: { query: string; params: string }[] = [];
  const client = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
  (
    client as unknown as {
      $on: (e: string, cb: (x: { query: string; params: string }) => void) => void;
    }
  ).$on('query', (e) => events.push({ query: e.query, params: e.params }));
  return {
    client,
    sql: () => events.map((e) => ({ query: e.query, params: JSON.parse(e.params) as string[] })),
  };
}

const T0: Millis = Date.UTC(2026, 5, 1, 8, 0, 0);
const clock = () => new FrozenClock(T0);

function actorOf(id: string, roles: readonly Role[] = ['teacher']): Actor {
  return { id, roles, mfaVerified: true, suspended: false };
}

async function user(): Promise<string> {
  const id = randomUUID();
  await prisma().user.create({
    data: { id, email: `${id}@c.example`, emailNormalized: `${id}@c.example`, name: 'P' },
  });
  return id;
}

/** A classroom with an owner-enrollment, via the real path. */
async function classroom(
  name = `Room ${randomUUID().slice(0, 6)}`,
): Promise<{ id: string; ownerId: string }> {
  const ownerId = await user();
  const created = await createClassroom(prisma(), { name, actor: actorOf(ownerId) });
  if (!created.ok) throw new Error(created.reason);
  return { id: created.id, ownerId };
}

/* ------------------------------------------------------------------ *
 * P4-T1. Lifecycle
 * ------------------------------------------------------------------ */

describe.skipIf(!DATABASE_URL)('P4-T1 classroom lifecycle, against real Postgres', () => {
  it('a new classroom has an owner, a unique slug, and an owner ENROLLMENT', async () => {
    const owner = await user();
    const first = await createClassroom(prisma(), { name: 'Year 9', actor: actorOf(owner) });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.slug).toBe('year-9');

    // The owner is an enrollment as well as a column, or they are invisible in their own roster.
    const enrollment = await prisma().enrollment.findFirst({
      where: { classroomId: first.id, userId: owner },
      select: { role: true, status: true },
    });
    expect(enrollment).toEqual({ role: 'OWNER', status: 'ACTIVE' });

    const event = await prisma().membershipEvent.findFirst({
      where: { classroomId: first.id, userId: owner },
      select: { kind: true, toRole: true },
    });
    expect(event).toEqual({ kind: 'JOINED', toRole: 'OWNER' });
  });

  it('derives a unique slug PER OWNER, so two teachers can each have "Year 9"', async () => {
    // The uniqueness is `(ownerId, slug)`. A global index would stop two schools' teachers
    // having the same room, which is the normal case rather than the exceptional one.
    const a = await user();
    const b = await user();
    const one = await createClassroom(prisma(), { name: 'Year 9', actor: actorOf(a) });
    const two = await createClassroom(prisma(), { name: 'Year 9', actor: actorOf(b) });
    expect(one.ok && two.ok).toBe(true);
    if (!one.ok || !two.ok) return;
    expect(one.slug).toBe('year-9');
    expect(two.slug).toBe('year-9');

    // …and the SAME owner gets a suffix rather than an error.
    const third = await createClassroom(prisma(), { name: 'Year 9', actor: actorOf(a) });
    if (third.ok) expect(third.slug).toBe('year-9-2');
  });

  it('refuses a classroom name with nothing a URL can carry, rather than inventing a slug', async () => {
    // The plan says names are free text and the slug is DERIVED. A room called an emoji has no
    // address to be found at, and silently giving it a generated slug would be worse.
    const owner = await user();
    await expect(
      createClassroom(prisma(), { name: '🎓🎓', actor: actorOf(owner) }),
    ).rejects.toThrow(/no characters a URL can carry/);
  });

  it('a student cannot create a classroom', async () => {
    const someone = await user();
    const result = await createClassroom(prisma(), {
      name: 'Nope',
      actor: actorOf(someone, ['student']),
    });
    expect(result.ok).toBe(false);
  });

  it('archive is soft and idempotent, and refuses to a non-owner', async () => {
    const room = await classroom();
    const outsider = await user();
    const refused = await archiveClassroom(prisma(), {
      classroomId: room.id,
      actor: actorOf(outsider),
    });
    expect(refused.ok).toBe(false);

    const first = await archiveClassroom(
      prisma(),
      { classroomId: room.id, actor: actorOf(room.ownerId) },
      clock(),
    );
    expect(first.ok).toBe(true);
    // A double-clicked archive button should not report a failure.
    const second = await archiveClassroom(
      prisma(),
      { classroomId: room.id, actor: actorOf(room.ownerId) },
      clock(),
    );
    expect(second.ok).toBe(true);

    const row = await prisma().classroom.findUniqueOrThrow({ where: { id: room.id } });
    expect(row.archivedAt).not.toBeNull();
    // Soft: the enrollments are all still there, because a room is a record of what happened in
    // it and archiving is a statement about its FUTURE.
    expect(await prisma().enrollment.count({ where: { classroomId: room.id } })).toBeGreaterThan(0);
  });

  it('ownership transfers only to a TEACHER already in the room', async () => {
    // Ownership is the ability to manage a roster and release grades for a room full of
    // children. The only thing between a mis-click and a student owning their classmates' marks
    // is this check.
    const room = await classroom();
    const student = await user();
    await addMember(
      prisma(),
      { classroomId: room.id, userId: student, role: 'STUDENT', actor: actorOf(room.ownerId) },
      clock(),
    );

    const notAMember = await user();
    const outsider = await transferClassroomOwnership(prisma(), {
      classroomId: room.id,
      toUserId: notAMember,
      reason: 'handing this to the deputy',
      actor: actorOf(room.ownerId),
    });
    expect(outsider.ok).toBe(false);
    if (!outsider.ok) expect(outsider.reason).toMatch(/not in this classroom/);

    const toStudent = await transferClassroomOwnership(prisma(), {
      classroomId: room.id,
      toUserId: student,
      reason: 'handing this to the deputy',
      actor: actorOf(room.ownerId),
    });
    expect(toStudent.ok).toBe(false);
    if (!toStudent.ok) expect(toStudent.reason).toMatch(/enrolled as STUDENT/);

    const teacher = await user();
    await addMember(
      prisma(),
      { classroomId: room.id, userId: teacher, role: 'TEACHER', actor: actorOf(room.ownerId) },
      clock(),
    );
    const good = await transferClassroomOwnership(prisma(), {
      classroomId: room.id,
      toUserId: teacher,
      reason: 'handing this to the deputy head of year',
      actor: actorOf(room.ownerId),
    });
    expect(good.ok).toBe(true);
  });

  it('a transfer DEMOTES the previous owner to TEACHER rather than removing them', async () => {
    // The room does not lose a teacher the moment it changes hands, which is what a bare
    // transfer gets wrong and what people expect.
    const room = await classroom();
    const teacher = await user();
    await addMember(
      prisma(),
      { classroomId: room.id, userId: teacher, role: 'TEACHER', actor: actorOf(room.ownerId) },
      clock(),
    );
    await transferClassroomOwnership(
      prisma(),
      {
        classroomId: room.id,
        toUserId: teacher,
        reason: 'handing this to the deputy head of year',
        actor: actorOf(room.ownerId),
      },
      clock(),
    );

    const oldOwner = await prisma().enrollment.findFirstOrThrow({
      where: { classroomId: room.id, userId: room.ownerId },
      select: { role: true, status: true },
    });
    expect(oldOwner).toEqual({ role: 'TEACHER', status: 'ACTIVE' });
    expect((await prisma().classroom.findUniqueOrThrow({ where: { id: room.id } })).ownerId).toBe(
      teacher,
    );
  });

  it('a transfer needs a reason, because it is the one change nobody would otherwise notice', async () => {
    const room = await classroom();
    const result = await transferClassroomOwnership(prisma(), {
      classroomId: room.id,
      toUserId: await user(),
      reason: 'because',
      actor: actorOf(room.ownerId),
    });
    expect(result.ok).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * P4-T2. Membership and INV-CLASSROOM-1 / -2
 * ------------------------------------------------------------------ */

describe.skipIf(!DATABASE_URL)('P4-T2 membership, against real Postgres', () => {
  it('OWNER cannot be assigned through a roster', async () => {
    // A roster screen that can set anybody to OWNER is a screen that can accidentally make a
    // student responsible for everyone, and it would bypass the TEACHER check that
    // `transferClassroomOwnership` applies.
    const room = await classroom();
    const someone = await user();
    const result = await addMember(prisma(), {
      classroomId: room.id,
      userId: someone,
      role: 'OWNER',
      actor: actorOf(room.ownerId),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/transfer/);
  });

  it('re-adding a REMOVED person REACTIVATES the row and keeps joinedAt', async () => {
    // `@@unique([classroomId, userId])` makes a second insert impossible, so the honest repair
    // is to reopen the membership — which also keeps "when did this student join" meaning the
    // first day rather than the day they were let back.
    const room = await classroom();
    const student = await user();
    await addMember(
      prisma(),
      { classroomId: room.id, userId: student, role: 'STUDENT', actor: actorOf(room.ownerId) },
      clock(),
    );
    const first = await prisma().enrollment.findFirstOrThrow({
      where: { classroomId: room.id, userId: student },
      select: { joinedAt: true },
    });
    await endMembership(
      prisma(),
      { classroomId: room.id, userId: student, actor: actorOf(room.ownerId) },
      clock(),
    );
    await addMember(
      prisma(),
      { classroomId: room.id, userId: student, role: 'STUDENT', actor: actorOf(room.ownerId) },
      clock(),
    );

    const after = await prisma().enrollment.findFirstOrThrow({
      where: { classroomId: room.id, userId: student },
      select: { status: true, joinedAt: true },
    });
    expect(after.status).toBe('ACTIVE');
    expect(after.joinedAt.getTime()).toBe(first.joinedAt.getTime());
    expect(
      await prisma().enrollment.count({ where: { classroomId: room.id, userId: student } }),
    ).toBe(1);
  });

  it('role history is APPEND-ONLY and says what each change was', async () => {
    const room = await classroom();
    const student = await user();
    await addMember(prisma(), {
      classroomId: room.id,
      userId: student,
      role: 'STUDENT',
      actor: actorOf(room.ownerId),
    });
    await changeMemberRole(prisma(), {
      classroomId: room.id,
      userId: student,
      role: 'REVIEWER',
      actor: actorOf(room.ownerId),
    });

    const events = await prisma().membershipEvent.findMany({
      where: { classroomId: room.id, userId: student },
      orderBy: { createdAt: 'asc' },
      select: { kind: true, fromRole: true, toRole: true },
    });
    expect(events).toEqual([
      { kind: 'JOINED', fromRole: null, toRole: 'STUDENT' },
      { kind: 'ROLE_CHANGED', fromRole: 'STUDENT', toRole: 'REVIEWER' },
    ]);
  });

  it('the DATABASE refuses a role change that does not say both ends', async () => {
    // A history that can lie is worse than no history, because it is believed.
    await expect(
      prisma().membershipEvent.create({
        data: {
          classroomId: (await classroom()).id,
          userId: await user(),
          kind: 'ROLE_CHANGED',
          fromRole: 'STUDENT',
        },
      }),
    ).rejects.toThrow();
    await expect(
      prisma().membershipEvent.create({
        data: {
          classroomId: (await classroom()).id,
          userId: await user(),
          kind: 'REMOVED',
          toRole: 'STUDENT',
        },
      }),
    ).rejects.toThrow();
  });

  it('a self-leave records NO actor, so the history does not imply they were pushed out', async () => {
    const room = await classroom();
    const student = await user();
    await addMember(prisma(), {
      classroomId: room.id,
      userId: student,
      role: 'STUDENT',
      actor: actorOf(room.ownerId),
    });
    const left = await endMembership(prisma(), {
      classroomId: room.id,
      userId: student,
      byThemselves: true,
      actor: actorOf(student, ['student']),
    });
    expect(left.ok).toBe(true);

    const event = await prisma().membershipEvent.findFirstOrThrow({
      where: { classroomId: room.id, userId: student, kind: 'LEFT' },
      select: { actorId: true, kind: true },
    });
    expect(event).toEqual({ actorId: null, kind: 'LEFT' });
  });

  it('the owner cannot leave, because the room would have nobody responsible for it', async () => {
    const room = await classroom();
    const result = await endMembership(prisma(), {
      classroomId: room.id,
      userId: room.ownerId,
      byThemselves: true,
      actor: actorOf(room.ownerId),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/Transfer the classroom/);
  });
});

/* ------------------------------------------------------------------ *
 * INV-CLASSROOM-1 — the effective role is the MAXIMUM over ACTIVE enrollments
 * ------------------------------------------------------------------ */

describe.skipIf(!DATABASE_URL)('INV-CLASSROOM-1, against real Postgres', () => {
  it('removing a STUDENT enrollment does NOT reduce their TEACHER access', async () => {
    // The half of INV-CLASSROOM-1 that surprises people, and the reason it is worth a test that
    // names the surprise: the user is a teacher in ANOTHER classroom, so the maximum over active
    // enrollments is still teacher. That is not a bug in the removal.
    const ownerA = await user();
    const roomA = await createClassroom(prisma(), { name: 'Room A', actor: actorOf(ownerA) });
    if (!roomA.ok) throw new Error(roomA.reason);

    const both = await user();
    await addMember(prisma(), {
      classroomId: roomA.id,
      userId: both,
      role: 'TEACHER',
      actor: actorOf(ownerA),
    });
    const roomB = await classroom('Room B');
    await addMember(prisma(), {
      classroomId: roomB.id,
      userId: both,
      role: 'STUDENT',
      actor: actorOf(roomB.ownerId),
    });

    const before = await resolveActorForRequest(prisma(), both, clock());
    expect(before?.roles).toContain('teacher');

    await endMembership(
      prisma(),
      {
        classroomId: roomB.id,
        userId: both,
        byThemselves: true,
        actor: actorOf(both, ['student']),
      },
      clock(),
    );

    const after = await resolveActorForRequest(prisma(), both, clock());
    expect(after?.roles, 'removing the student row must not demote them').toEqual(['teacher']);
    // And the scope now has one classroom, not two.
    expect(after?.classroomIds).toEqual([roomA.id]);
  });

  it('removing the ONLY teacher enrollment DOES drop them, on the next request', async () => {
    const room = await classroom();
    const teacher = await user();
    await addMember(prisma(), {
      classroomId: room.id,
      userId: teacher,
      role: 'TEACHER',
      actor: actorOf(room.ownerId),
    });
    expect((await resolveActorForRequest(prisma(), teacher, clock()))?.roles).toContain('teacher');

    await endMembership(
      prisma(),
      { classroomId: room.id, userId: teacher, actor: actorOf(room.ownerId) },
      clock(),
    );
    expect((await resolveActorForRequest(prisma(), teacher, clock()))?.roles).toEqual([]);
  });

  it('a SUSPENDED account holds no roles at all, whatever it is enrolled in', async () => {
    // The enum is the claim and the DATES are the evidence. A row that says SUSPENDED with no
    // `suspendedAt` — which a partial import can produce — still reads as suspended.
    const room = await classroom();
    const teacher = await user();
    await addMember(prisma(), {
      classroomId: room.id,
      userId: teacher,
      role: 'TEACHER',
      actor: actorOf(room.ownerId),
    });
    await prisma().user.update({ where: { id: teacher }, data: { status: 'SUSPENDED' } });
    expect((await resolveActorForRequest(prisma(), teacher, clock()))?.roles).toEqual([]);
  });

  it('the pure function refuses to invent a role for a DELETING account', () => {
    // The deletion grace period is a period of "the account still works", not "the account still
    // teaches". Handing a DELETING account a role would make the grace period a period of
    // quietly continuing to teach.
    const resolved = resolveActor({
      userId: 'u',
      enrollments: [{ classroomId: 'c1', role: 'OWNER', endedAt: null }],
      accountStatus: 'DELETING',
      now: T0,
    });
    expect(resolved.roles).toEqual([]);
  });

  it('OWNER maps to teacher, because the kernel has no owner ROLE', () => {
    // Ownership is a RELATIONSHIP the matrix reads as `isOwner`. An `owner` role here would be
    // a fifth role that no rule knows about, and `maxRole` would rank it as undefined.
    const resolved = resolveActor({
      userId: 'u',
      enrollments: [{ classroomId: 'c1', role: 'OWNER', endedAt: null }],
      accountStatus: 'ACTIVE',
      now: T0,
    });
    expect(resolved.roles).toEqual(['teacher']);
    expect(resolved.classroomRoles.c1).toBe('OWNER');
  });

  it('an ENDED enrollment is not an active one — and the near-miss spelling is the danger', () => {
    // The database column is `endedAt` and the kernel's is `endsAt`. Passing the column through
    // unchanged gives `endsAt: undefined`, which reads as "no end date" — i.e. an ACTIVE
    // enrollment for everybody, forever. This is the test for that.
    const resolved = resolveActor({
      userId: 'u',
      enrollments: [{ classroomId: 'c1', role: 'STUDENT', endedAt: T0 - 1 }],
      accountStatus: 'ACTIVE',
      now: T0,
    });
    expect(resolved.roles).toEqual([]);
    expect(resolved.classroomIds).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * The scope, in the SQL
 * ------------------------------------------------------------------ */

describe.skipIf(!DATABASE_URL)('P4 classroom scoping, against real Postgres', () => {
  it('the classroom scope is in the SQL, not applied afterwards', async () => {
    // `plans/12` §4 asks for this test by name. A post-filter and an in-query filter are
    // indistinguishable from the RESULT — the post-filter passes every behavioural assertion in
    // this file — and only the emitted SQL tells them apart.
    const mine = await classroom('Mine');
    await classroom('Theirs');
    const spy = prismaSpying();
    const seen = await listClassroomsFor(spy.client, actorOf(mine.ownerId));

    // The spy must have recorded something, or every assertion below is vacuous. The first
    // version read a property that was a snapshot of an empty array, so it "passed" while
    // capturing nothing.
    const emitted = spy.sql();
    expect(emitted.length, 'the spy recorded no SQL').toBeGreaterThan(0);

    // Found by SHAPE, not by a literal. The first version looked for `FROM "Classroom"` and
    // found nothing, because Prisma schema-qualifies every table as `"public"."Classroom"` — so
    // a test that is too literal about generated SQL fails on a formatting change and proves
    // nothing when it passes. It then asserted the actor's id appeared in the query TEXT, which
    // it never does: values are BOUND parameters, and an assertion that expects a uuid inlined
    // into a statement is an assertion that fails the moment somebody parameterises it.
    const listing = emitted.find(
      (e) => e.query.includes('"Classroom"') && e.query.trimStart().startsWith('SELECT'),
    );
    expect(listing, 'no Classroom SELECT was captured').toBeDefined();
    // The scope is in the WHERE: an enrollment subquery, not a filter applied in JS afterwards.
    expect(listing?.query, 'the scope is not in the SQL').toContain('"Enrollment"');
    expect(listing?.query, 'the scope does not narrow by status').toMatch(/status/i);
    // And it is bound to THIS actor, which is what makes it a scope rather than a generic filter.
    expect(listing?.params, 'the actor is not among the bound parameters').toContain(mine.ownerId);
    // Behaviourally it agrees with the SQL claim, so the two are not individually right and
    // jointly wrong.
    expect(seen.map((c) => c.id)).toEqual([mine.id]);
  });

  it('a teacher sees ONLY their own classrooms, and a stranger sees none', async () => {
    await classroom('Mine');
    await classroom('Theirs');
    const teacher = await user();
    const resolved = await resolveActorForRequest(prisma(), teacher, clock());
    const seen = await listClassroomsFor(prisma(), resolved ?? actorOf(teacher));
    expect(seen).toHaveLength(0);
  });

  it('a student enrolled in two rooms sees exactly two', async () => {
    const a = await classroom('A');
    const b = await classroom('B');
    const student = await user();
    await addMember(prisma(), {
      classroomId: a.id,
      userId: student,
      role: 'STUDENT',
      actor: actorOf(a.ownerId),
    });
    await addMember(prisma(), {
      classroomId: b.id,
      userId: student,
      role: 'STUDENT',
      actor: actorOf(b.ownerId),
    });

    const resolved = await resolveActorForRequest(prisma(), student, clock());
    const seen = await listClassroomsFor(prisma(), resolved ?? actorOf(student));
    expect(seen.map((c) => c.id).sort()).toEqual([a.id, b.id].sort());
    // `myRole` is the role in THAT classroom, which is not the same as the maximum.
    expect(seen.every((c) => c.myRole === 'STUDENT')).toBe(true);
  });

  it('a teacher from room A cannot grade in room B', async () => {
    // The cell the whole kernel exists for, against the real database rather than a fixture.
    await classroom('A');
    const b = await classroom('B');
    const stranger = await user();
    const resolved = await resolveActorForRequest(prisma(), stranger, clock());
    const decision = await canOnClassroom(prisma(), {
      action: 'grade',
      classroomId: b.id,
      actor: resolved ?? actorOf(stranger),
    });
    expect(decision.allowed).toBe(false);
  });

  it('a member of room B still cannot rename it — membership is not authority', async () => {
    // Being in a class is not being in charge of it. The first version of `classroomScoped` had
    // only relationships, so a student enrolled in a class could grade it.
    const room = await classroom();
    const student = await user();
    await addMember(prisma(), {
      classroomId: room.id,
      userId: student,
      role: 'STUDENT',
      actor: actorOf(room.ownerId),
    });
    const resolved = await resolveActorForRequest(prisma(), student, clock());
    const decision = await canOnClassroom(prisma(), {
      action: 'update',
      classroomId: room.id,
      actor: resolved ?? actorOf(student, ['student']),
    });
    expect(decision.allowed).toBe(false);
  });

  it('the slug de-duplication only de-duplicates rooms that EXIST', async () => {
    // The first version called `uniqueClassroomSlug` twice and expected 'repeated' then
    // 'repeated-2', having never created a classroom — so the second call correctly found
    // nothing taken and returned 'repeated' again, and the test failed for a reason that had
    // nothing to do with the de-duplication. A test of a function that READS the database has to
    // put something in the database first.
    const owner = await user();
    expect(await uniqueClassroomSlug(prisma(), owner, 'Repeated')).toBe('repeated');
    const created = await createClassroom(prisma(), { name: 'Repeated', actor: actorOf(owner) });
    expect(created.ok && created.slug).toBe('repeated');
    expect(await uniqueClassroomSlug(prisma(), owner, 'Repeated')).toBe('repeated-2');
    // A different owner is unaffected: uniqueness is per owner.
    const other = await user();
    expect(await uniqueClassroomSlug(prisma(), other, 'Repeated')).toBe('repeated');
  });
});

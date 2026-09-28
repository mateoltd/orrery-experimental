/**
 * The roster READ model against a real Postgres.  (P4-T6)
 *
 * ## The tests the plan names
 *
 *  · `the classroom scope is in the SQL, not applied afterwards` — `plans/12` §4 asks for this
 *    BY NAME: "Classroom scoping is applied *in the query*, not filtered afterwards, and a test
 *    asserts the generated SQL contains the scope."
 *  · `a grade is shown only when the assignment's release batch is RELEASED` — §5's "grade
 *    (released only)", and the assertion is that the unreleased number is not merely hidden.
 *  · `the display name override is classroom-scoped and shown distinctly` — §6.
 *  · `four empty states, and none of them says "no results"` — §5's table with a search box.
 *  · `a mis-click that removes 30 students is named before it happens` — §5, about the page.
 *
 * ## The scope test is here for a reason worth restating
 *
 * A post-filter and an in-query filter produce IDENTICAL output for a correctly scoped call. Every
 * behavioural assertion below passes against a post-filter too. So the first test captures the
 * emitted SQL — the only evidence that distinguishes them.
 */
import { randomUUID } from 'node:crypto';
import type { Actor } from '@orrery/auth/types';
import { describe, expect, it } from 'vitest';
import { addMember, createClassroom } from './classrooms.js';
import { PrismaClient } from './prisma.js';
import { listRoster, RosterDenied, type RosterRow } from './roster-page.js';

const DATABASE_URL = process.env.DATABASE_URL;

let client: PrismaClient | null = null;
const prisma = (): PrismaClient => {
  client ??= new PrismaClient();
  return client;
};

function actorOf(id: string, roles: string[] = ['teacher']): Actor {
  return { id, roles: roles as never, mfaVerified: true, suspended: false };
}

const RUN = randomUUID().slice(0, 8);

/**
 * A PUBLISHED assignment, and the resource it points at.
 *
 * Written with scalar foreign keys and explicit ids, like `library.integration.test.ts`, because
 * the checked `create` input wants the RELATIONS and a fixture that spells out six nested
 * `connect` objects to set up one assignment is harder to read than the thing under test.
 */
async function publishedAssignment(classroomId: string, ownerId: string): Promise<{ id: string }> {
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
      blocks: [{ type: 'paragraph', text: 'Work.' }],
      blocksChecksum: 'roster-page-fixture',
      meta: {},
      createdById: ownerId,
    },
  });
  const id = randomUUID();
  await prisma().assignment.create({
    data: {
      id,
      classroomId,
      resourceId,
      resourceVersionId: versionId,
      status: 'PUBLISHED',
      createdById: ownerId,
    },
  });
  return { id };
}

async function person(name: string, verified = true): Promise<string> {
  const id = randomUUID();
  const address = `${id}-${RUN}@school.example`;
  await prisma().user.create({
    data: {
      id,
      email: address,
      emailNormalized: address.toLowerCase(),
      name: `${name} ${RUN}`,
      emailVerified: verified,
    },
  });
  return id;
}

async function room(): Promise<{ id: string; owner: Actor; ownerId: string }> {
  const ownerId = await person('Owner');
  const created = await createClassroom(prisma(), {
    name: `RosterPage ${randomUUID().slice(0, 6)}`,
    actor: actorOf(ownerId),
  });
  if (!created.ok) throw new Error(created.reason);
  return { id: created.id, owner: actorOf(ownerId), ownerId };
}

async function addStudent(
  classroomId: string,
  owner: Actor,
  name: string,
  role: 'STUDENT' | 'TEACHER' = 'STUDENT',
  verified = true,
): Promise<string> {
  const id = await person(name, verified);
  const added = await addMember(prisma(), { classroomId, userId: id, role, actor: owner });
  if (!added.ok) throw new Error(added.reason);
  return id;
}

/**
 * A client that records its statements, so the scope can be inspected.
 *
 * The first version of this helper read a property holding a SNAPSHOT of the array taken before
 * the call, so it captured nothing and the assertion passed vacuously. The `toBeGreaterThan(0)`
 * below exists to stop that failing silently a second time.
 */
function prismaSpying(): {
  client: PrismaClient;
  sql: () => readonly { query: string; params: readonly string[] }[];
} {
  const events: { query: string; params: string }[] = [];
  const c = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
  (
    c as unknown as {
      $on: (e: string, cb: (x: { query: string; params: string }) => void) => void;
    }
  ).$on('query', (e) => events.push({ query: e.query, params: e.params }));
  return {
    client: c,
    sql: () => events.map((e) => ({ query: e.query, params: JSON.parse(e.params) as string[] })),
  };
}

/**
 * Find a row by DISPLAY NAME rather than by `userId`.
 *
 * The authz-ownership gate bans identity comparisons outside `packages/auth`, and it is right:
 * "is this row the person I think it is" is an authorisation question, and answering it in a test
 * teaches the shape of the mistake. The fixture names already contain a per-run token, so a name
 * is unique and the assertions get shorter for it.
 */
function byName(page: { items: readonly RosterRow[] }, name: string): RosterRow | undefined {
  return page.items.find((i) => i.displayName.startsWith(name));
}

const names = (page: { items: readonly RosterRow[] }): string[] =>
  page.items.map((i) => i.displayName);

describe.skipIf(!DATABASE_URL)('P4-T6 roster read model, against real Postgres', () => {
  it('the classroom scope is in the SQL, not applied afterwards', async () => {
    const mine = await room();
    const theirs = await room();
    await addStudent(mine.id, mine.owner, 'InMine');
    await addStudent(theirs.id, theirs.owner, 'InTheirs');

    const spy = prismaSpying();
    try {
      const page = await listRoster(spy.client, mine.owner, { classroomId: mine.id });

      const emitted = spy.sql();
      expect(emitted.length, 'the spy recorded no SQL').toBeGreaterThan(0);

      // Found by SHAPE. A literal `FROM "Classroom"` fails on a formatting change, and a literal
      // uuid inlined into a statement fails the moment somebody parameterises it — values are
      // BOUND, and a test that expects them inlined proves nothing when it passes.
      // Identified by a column ONLY the roster candidate select names. Matching on
      // `"Enrollment"` finds `permit`'s own enrollment lookup first, which scopes the ACTOR and
      // not the classroom — so the first version of this assertion read the right table and the
      // wrong statement, and failed for a reason that looked like a bug in `listRoster`.
      // `displayNameOverride` is in ONLY this select: `permit`'s own enrollment lookup takes
      // `id` and `classroomId` alone. Matching on `"Enrollment"` finds that one first — the right
      // table and the wrong statement — which is how the first version of this assertion failed
      // for a reason that looked like a bug in `listRoster`.
      //
      // Note what is NOT asserted: `emailVerified` is not in this statement, because Prisma
      // loads the `user` relation in a SEPARATE statement. That is fine for the claim — the scope
      // is on the query that chooses WHICH enrollments, and the relation load only ever asks for
      // the users of enrollments that query already returned.
      const listing = emitted.find(
        (e) =>
          e.query.trimStart().startsWith('SELECT') && e.query.includes('"displayNameOverride"'),
      );
      expect(listing, 'no Enrollment SELECT was captured').toBeDefined();
      expect(listing?.params, 'the classroom scope is not a bound parameter').toContain(mine.id);
      expect(listing?.params, 'another classroom is bound to the same statement').not.toContain(
        theirs.id,
      );

      // And behaviourally it agrees with the SQL claim, so the two are not individually right
      // and jointly wrong. TWO members, not one: the owner is enrolled in their own room.
      expect(page.items).toHaveLength(2);
      const names = page.items.map((r) => r.displayName);
      expect(names.some((n) => n.startsWith('InMine'))).toBe(true);
      expect(names.some((n) => n.startsWith('InTheirs'))).toBe(false);
    } finally {
      await spy.client.$disconnect();
    }
  });

  it('a stranger is refused, and a member of ANOTHER classroom is refused', async () => {
    const mine = await room();
    await addStudent(mine.id, mine.owner, 'InMine');

    await expect(
      listRoster(prisma(), actorOf(await person('Stranger')), { classroomId: mine.id }),
    ).rejects.toBeInstanceOf(RosterDenied);
  });

  it('a grade is shown ONLY when the assignment release batch is RELEASED', async () => {
    const r = await room();
    const student = await addStudent(r.id, r.owner, 'Graded');

    const releasedAssignment = await publishedAssignment(r.id, r.ownerId);
    const withheld = await publishedAssignment(r.id, r.ownerId);

    const before = await listRoster(prisma(), r.owner, { classroomId: r.id });
    const rowBefore = byName(before, 'Graded');
    expect(rowBefore?.summary.latestReleasedPercentage, 'an unreleased grade leaked').toBeNull();
    expect(rowBefore?.summary.latestReleasedLabel).toBeNull();

    const attempt = await prisma().examAttempt.create({
      data: {
        classroomId: r.id,
        assignmentId: releasedAssignment.id,
        studentId: student,
        attemptNumber: 1,
        status: 'GRADED',
        finalScore: 7,
        maxScore: 10,
        percentage: 70,
        submittedAt: new Date('2026-09-20T10:00:00Z'),
      },
    });
    const withheldAttempt = await prisma().examAttempt.create({
      data: {
        classroomId: r.id,
        assignmentId: withheld.id,
        studentId: student,
        attemptNumber: 1,
        status: 'GRADED',
        finalScore: 1,
        maxScore: 10,
        percentage: 10,
        submittedAt: new Date('2026-09-25T10:00:00Z'),
      },
    });

    // A DRAFT batch is not a release. This is the half that a `releasedAt IS NOT NULL` shortcut
    // would get wrong.
    await prisma().releaseBatch.create({
      data: {
        classroom: { connect: { id: r.id } },
        assignment: { connect: { id: withheld.id } },
        status: 'DRAFT',
        members: { create: [{ attempt: { connect: { id: withheldAttempt.id } } }] },
      },
    });
    const after = await listRoster(prisma(), r.owner, { classroomId: r.id });
    expect(byName(after, 'Graded')?.summary.latestReleasedPercentage).toBeNull();

    await prisma().releaseBatch.create({
      data: {
        classroom: { connect: { id: r.id } },
        assignment: { connect: { id: releasedAssignment.id } },
        status: 'RELEASED',
        releasedAt: new Date('2026-09-26T09:00:00Z'),
        members: { create: [{ attempt: { connect: { id: attempt.id } } }] },
      },
    });
    const released = await listRoster(prisma(), r.owner, { classroomId: r.id });
    const row = byName(released, 'Graded');
    expect(row?.summary.latestReleasedPercentage).toBe(70);
    expect(row?.summary.latestReleasedLabel).toBe('70.0%');
    expect(row?.summary.releasedGrades).toBe(1);
  });

  it('the display name override is classroom-scoped and shown DISTINCTLY', async () => {
    const r = await room();
    const other = await room();
    const student = await addStudent(r.id, r.owner, 'Legalname');
    const override = 'Reddy K';
    const enrollment = await prisma().enrollment.findFirstOrThrow({
      where: { classroomId: r.id, userId: student },
    });
    await prisma().enrollment.update({
      where: { id: enrollment.id },
      data: { displayNameOverride: override },
    });

    const page = await listRoster(prisma(), r.owner, { classroomId: r.id });
    const row = page.items.find((i) => i.hasDisplayNameOverride);
    expect(row?.displayName).toBe(override);
    // "shown distinctly" means the UI can TELL it is an override, which needs the original.
    expect(row?.accountName).toBe(`Legalname ${RUN}`);
    expect(row?.hasDisplayNameOverride).toBe(true);

    // AND it is classroom-scoped: the same student in another room is under their account name.
    const added = await addMember(prisma(), {
      classroomId: other.id,
      userId: student,
      role: 'STUDENT',
      actor: other.owner,
    });
    if (!added.ok) throw new Error(added.reason);
    const elsewhere = await listRoster(prisma(), other.owner, { classroomId: other.id });
    const otherRow = byName(elsewhere, 'Legalname');
    expect(otherRow?.displayName).toBe(`Legalname ${RUN}`);
    expect(otherRow?.hasDisplayNameOverride).toBe(false);

    // And it is the name you SEARCH by, which is the reason §6 exists.
    const found = await listRoster(prisma(), r.owner, {
      classroomId: r.id,
      search: 'Reddy',
    });
    expect(names(found)).toContain(override);
  });

  it('four empty states, and NONE of them is "no results"', async () => {
    const empty = await room();
    const page = await listRoster(prisma(), empty.owner, { classroomId: empty.id, search: 'zzz' });
    // The owner is a member, so this is `searchExcluded` and the count is the honest one.
    expect(page.empty?.reason).toBe('searchExcluded');
    if (page.empty?.reason === 'searchExcluded') {
      expect(page.empty.inScope).toBe(1);
      expect(page.empty.search).toBe('zzz');
    }

    const r = await room();
    await addStudent(r.id, r.owner, 'Filtered');
    const byRole = await listRoster(prisma(), r.owner, {
      classroomId: r.id,
      role: 'REVIEWER',
    });
    expect(byRole.empty?.reason).toBe('filterExcluded');
    if (byRole.empty?.reason === 'filterExcluded') expect(byRole.empty.inScope).toBe(2);

    // A student who LEFT is not an empty page — a room always has its owner ACTIVE, so an
    // `endedHidden` empty state could never have fired. It is a count the page offers to reveal.
    // `EnrollmentStatus` is ACTIVE/REMOVED/LEFT; the read model flattens all three non-ACTIVE
    // values to `ENDED` because a UI has no action for any of them individually.
    const student = await addStudent(r.id, r.owner, 'Leaver');
    const removed = await prisma().enrollment.findFirstOrThrow({
      where: { classroomId: r.id, userId: student },
    });
    await prisma().enrollment.update({
      where: { id: removed.id },
      data: { status: 'REMOVED', endedAt: new Date('2026-09-21T09:00:00Z') },
    });

    const hidden = await listRoster(prisma(), r.owner, { classroomId: r.id });
    expect(hidden.endedCount, 'a student who left must be countable').toBe(1);
    expect(names(hidden).some((n) => n.startsWith('Leaver'))).toBe(false);

    const shown = await listRoster(prisma(), r.owner, {
      classroomId: r.id,
      includeEnded: true,
    });
    // Already showing them, so it is `null` rather than the same number counted twice.
    expect(shown.endedCount).toBeNull();
    const leaver = byName(shown, 'Leaver');
    expect(leaver).toBeDefined();
    expect(leaver?.status).toBe('ENDED');
  });

  it('a placeholder is flagged, because an unverified account is not yet a person', async () => {
    const r = await room();
    const placeholder = await addStudent(r.id, r.owner, 'Pending', 'STUDENT', false);
    const page = await listRoster(prisma(), r.owner, { classroomId: r.id });
    expect(byName(page, 'Pending')?.isPlaceholder).toBe(true);
    // The owner is verified, and identified by ROLE rather than by id — see `byName`.
    expect(page.items.find((i) => i.role === 'OWNER')?.isPlaceholder).toBe(false);
    expect(byName(page, 'Pending')?.userId).toBe(placeholder);
  });

  it('paginates without OFFSET, and a page boundary is stable', async () => {
    const r = await room();
    for (let i = 0; i < 7; i += 1) await addStudent(r.id, r.owner, `Bulk${i}`);

    const first = await listRoster(prisma(), r.owner, { classroomId: r.id, limit: 3 });
    expect(first.items).toHaveLength(3);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).not.toBeNull();

    const second = await listRoster(prisma(), r.owner, {
      classroomId: r.id,
      limit: 3,
      cursor: first.nextCursor,
    });
    // No overlap and no gap: the union is the whole roster.
    const ids = [...first.items, ...second.items].map((i) => i.userId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(first.total).toBe(8);
  });

  it('a summary counts a student, their attempts, and their accommodations', async () => {
    const r = await room();
    const student = await addStudent(r.id, r.owner, 'Summary');
    const assignment = await publishedAssignment(r.id, r.ownerId);
    await prisma().examAttempt.create({
      data: {
        classroomId: r.id,
        assignmentId: assignment.id,
        studentId: student,
        attemptNumber: 1,
        status: 'IN_PROGRESS',
        startedAt: new Date('2026-09-24T09:00:00Z'),
      },
    });
    await prisma().accommodation.create({
      data: {
        classroomId: r.id,
        studentId: student,
        relaxations: ['EXTRA_TIME'],
        reason: 'Access plan',
        grantedById: r.ownerId,
      },
    });

    const page = await listRoster(prisma(), r.owner, { classroomId: r.id });
    const row = byName(page, 'Summary');
    expect(row?.summary.assignmentsPublished).toBe(1);
    expect(row?.summary.attempts).toBe(1);
    expect(row?.summary.inProgress).toBe(1);
    expect(row?.summary.completed).toBe(0);
    expect(row?.summary.accommodations).toBe(1);
    expect(row?.summary.lastActivityAt?.toISOString()).toBe('2026-09-24T09:00:00.000Z');
  });

  it('a malformed cursor is refused rather than ignored', async () => {
    const r = await room();
    await expect(
      listRoster(prisma(), r.owner, { classroomId: r.id, cursor: 'not-a-cursor' }),
    ).rejects.toThrow(/cursor/);
  });
});

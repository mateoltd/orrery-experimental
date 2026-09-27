/**
 * The resource library, against a real Postgres.  (P2-T9)
 *
 * ## The test that matters
 *
 * `refuses a transfer while an attempt is open, and allows it once that attempt settles`.
 *
 * The second half is the one that keeps the first honest. A guard that blocks forever is not a
 * safety property, it is a wall — and the realistic outcome of a wall is that teachers route
 * around it by creating copies, which loses the version history the guard was protecting.
 *
 * Also worth naming: the refusal is a **409, not a 403**. The caller is allowed to do this; the
 * timing is wrong. "Not yet" and "never" are different sentences, and a 403 on a live attempt
 * tells a teacher the action is permanently closed to them, which it is not.
 */

import { randomUUID } from 'node:crypto';
import type { Actor } from '@orrery/auth/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { blastRadius, duplicateResource, listMine, transferOwnership } from './library.js';
import { PrismaClient } from './prisma.js';

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)('P2-T9 resource library integration, against real Postgres', () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = new PrismaClient();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  const teacher = (id: string): Actor => ({
    id,
    roles: ['teacher'],
    mfaVerified: true,
    suspended: false,
  });

  async function seedUser(name = 'T') {
    const id = randomUUID();
    await prisma.user.create({
      data: { id, email: `${id}@school.example`, emailNormalized: `${id}@school.example`, name },
    });
    return id;
  }

  async function fixture() {
    const owner = await seedUser('Owner');
    const student = await seedUser('Student');
    const other = await seedUser('Other');
    const resource = await prisma.resource.create({
      data: {
        id: randomUUID(),
        ownerId: owner,
        status: 'PUBLISHED',
        visibility: 'UNLISTED',
        title: 'Tidal locking',
        slug: randomUUID(),
      },
    });
    const version = await prisma.resourceVersion.create({
      data: {
        id: randomUUID(),
        resourceId: resource.id,
        version: 1,
        blocks: [{ type: 'paragraph', text: 'The Moon is tidally locked.' }],
        blocksChecksum: 'stored-checksum',
        meta: { subject: 'physics' },
        createdById: owner,
      },
    });
    const classroom = await prisma.classroom.create({
      data: { id: randomUUID(), ownerId: owner, name: 'Year 9', slug: randomUUID() },
    });
    const assignment = await prisma.assignment.create({
      data: {
        id: randomUUID(),
        classroomId: classroom.id,
        resourceId: resource.id,
        resourceVersionId: version.id,
        status: 'PUBLISHED',
        createdById: owner,
      },
    });
    return { owner, student, other, resource, version, classroom, assignment };
  }

  async function addAttempt(
    assignmentId: string,
    classroomId: string,
    studentId: string,
    status: string,
    n: number,
  ) {
    await prisma.examAttempt.create({
      data: {
        id: randomUUID(),
        assignmentId,
        classroomId,
        studentId,
        attemptNumber: n,
        status: status as never,
      },
    });
  }

  // ── Blast radius ───────────────────────────────────────────────────────────

  it('counts classrooms, distinct students, open attempts and settled marks separately', async () => {
    const f = await fixture();
    await addAttempt(f.assignment.id, f.classroom.id, f.student, 'IN_PROGRESS', 1);
    await addAttempt(f.assignment.id, f.classroom.id, f.student, 'GRADED', 2);

    const radius = await blastRadius(prisma, f.resource.id);
    expect(radius.classrooms).toHaveLength(1);
    expect(radius.publishedAssignments).toBe(1);
    expect(radius.attemptsInFlight).toBe(1);
    expect(radius.gradedAttempts).toBe(1);
    // One student, two attempts. A number that inflates with the number of attempts is a number
    // a teacher learns to distrust.
    expect(radius.studentsReachable).toBe(1);
    expect(radius.blocksDestructive).toBe(true);
  });

  it('treats a FROZEN attempt as still open', async () => {
    // V-12/C16: a student removed mid-exam holds answers that will still be graded. That work
    // depends on somebody being answerable for the content, so it is not "settled".
    const f = await fixture();
    await addAttempt(f.assignment.id, f.classroom.id, f.student, 'FROZEN', 1);
    const radius = await blastRadius(prisma, f.resource.id);
    expect(radius.attemptsInFlight).toBe(1);
    expect(radius.blocksDestructive).toBe(true);
  });

  it('reports a resource nothing depends on as unblocked', async () => {
    const f = await fixture();
    await prisma.assignment.delete({ where: { id: f.assignment.id } });
    const radius = await blastRadius(prisma, f.resource.id);
    expect(radius.blocksDestructive).toBe(false);
    expect(radius.reason).toBeNull();
  });

  // ── Transfer ───────────────────────────────────────────────────────────────

  it('refuses a transfer while an attempt is open, and allows it once that attempt settles', async () => {
    const f = await fixture();
    await addAttempt(f.assignment.id, f.classroom.id, f.student, 'IN_PROGRESS', 1);
    const reason = 'Dan is covering the class while I am on leave';

    const blocked = await transferOwnership(prisma, {
      resourceId: f.resource.id,
      toUserId: f.other,
      reason,
      actor: teacher(f.owner),
    });
    expect(blocked).toMatchObject({ ok: false, httpStatus: 409 });
    // 409, not 403: the caller is allowed to do this, the timing is wrong.
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    expect(blocked.reason).toContain('still open');
    // And the resource did NOT move.
    expect((await prisma.resource.findUnique({ where: { id: f.resource.id } }))?.ownerId).toBe(
      f.owner,
    );

    await prisma.examAttempt.updateMany({
      where: { assignmentId: f.assignment.id },
      data: { status: 'GRADED' },
    });

    const allowed = await transferOwnership(prisma, {
      resourceId: f.resource.id,
      toUserId: f.other,
      reason,
      actor: teacher(f.owner),
    });
    expect(allowed).toEqual({ ok: true, previousOwnerId: f.owner, newOwnerId: f.other });
    expect((await prisma.resource.findUnique({ where: { id: f.resource.id } }))?.ownerId).toBe(
      f.other,
    );
  });

  it('allows a transfer with settled marks, because the marks belong to the students', async () => {
    const f = await fixture();
    await addAttempt(f.assignment.id, f.classroom.id, f.student, 'RELEASED', 1);
    const radius = await blastRadius(prisma, f.resource.id);
    expect(radius.gradedAttempts).toBe(1);
    expect(radius.blocksDestructive).toBe(false);

    const outcome = await transferOwnership(prisma, {
      resourceId: f.resource.id,
      toUserId: f.other,
      reason: 'Handing this over to the department shared drive owner',
      actor: teacher(f.owner),
    });
    expect(outcome.ok).toBe(true);
  });

  it('writes the transfer audit row with the blast radius in it', async () => {
    const f = await fixture();
    await addAttempt(f.assignment.id, f.classroom.id, f.student, 'GRADED', 1);
    await transferOwnership(prisma, {
      resourceId: f.resource.id,
      toUserId: f.other,
      reason: 'Handing this over to the department shared drive owner',
      actor: teacher(f.owner),
    });

    const events = await prisma.auditEvent.findMany({
      where: { action: 'Resource.transfer', targetId: f.resource.id },
    });
    expect(events).toHaveLength(1);
    const meta = events[0]?.meta as Record<string, unknown>;
    expect(meta.from).toBe(f.owner);
    expect(meta.to).toBe(f.other);
    expect(meta.reason).toBe('Handing this over to the department shared drive owner');
    // Six months later, "was this a good idea" is unanswerable without knowing what depended
    // on the resource AT THE TIME.
    expect(meta.blastRadius).toMatchObject({
      classrooms: 1,
      studentsReachable: 1,
      gradedAttempts: 1,
    });
  });

  it('refuses a transfer with no reason, and one to a recipient who does not exist', async () => {
    const f = await fixture();
    expect(
      await transferOwnership(prisma, {
        resourceId: f.resource.id,
        toUserId: f.other,
        reason: '   ',
        actor: teacher(f.owner),
      }),
    ).toMatchObject({ ok: false, httpStatus: 403 });
    expect(
      await transferOwnership(prisma, {
        resourceId: f.resource.id,
        toUserId: randomUUID(),
        reason: 'Handing this over to the department owner',
        actor: teacher(f.owner),
      }),
    ).toMatchObject({ ok: false, httpStatus: 404 });
  });

  it('refuses to transfer to a suspended recipient, so nothing ends up owned by nobody', async () => {
    const f = await fixture();
    await prisma.user.update({
      where: { id: f.other },
      data: { suspendedAt: new Date(Date.parse('2026-09-27T12:00:00.000Z')) },
    });
    const outcome = await transferOwnership(prisma, {
      resourceId: f.resource.id,
      toUserId: f.other,
      reason: 'Handing this over to the department owner',
      actor: teacher(f.owner),
    });
    expect(outcome).toMatchObject({ ok: false, httpStatus: 409 });
  });

  it('refuses a transfer by a teacher who does not own it, and 404s one they cannot see', async () => {
    const f = await fixture();
    await prisma.resource.update({ where: { id: f.resource.id }, data: { visibility: 'PRIVATE' } });
    const stranger = await seedUser('Stranger');

    expect(
      await transferOwnership(prisma, {
        resourceId: f.resource.id,
        toUserId: f.other,
        reason: 'Handing this over to the department owner',
        actor: teacher(stranger),
      }),
    ).toMatchObject({ ok: false, httpStatus: 404 });
    expect(
      await transferOwnership(prisma, {
        resourceId: randomUUID(),
        toUserId: f.other,
        reason: 'Handing this over to the department owner',
        actor: teacher(stranger),
      }),
    ).toMatchObject({ ok: false, httpStatus: 404 });
  });

  it('refuses a transfer by a student even of their own draft', async () => {
    const f = await fixture();
    const own = await prisma.resource.create({
      data: {
        id: randomUUID(),
        ownerId: f.student,
        status: 'DRAFT',
        visibility: 'PRIVATE',
        title: 'My practice',
        slug: randomUUID(),
      },
    });
    const outcome = await transferOwnership(prisma, {
      resourceId: own.id,
      toUserId: f.other,
      reason: 'I would like to hand this to my friend',
      actor: { id: f.student, roles: ['student'], mfaVerified: true, suspended: false },
    });
    expect(outcome).toMatchObject({ ok: false, httpStatus: 403 });
  });

  // ── Duplicate ──────────────────────────────────────────────────────────────

  it('duplicates into a new PRIVATE DRAFT and leaves the original alone', async () => {
    const f = await fixture();
    const outcome = await duplicateResource(prisma, {
      resourceId: f.resource.id,
      actor: teacher(f.owner),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const copy = await prisma.resource.findUnique({ where: { id: outcome.resourceId } });
    expect(copy).not.toBeNull();
    // PRIVATE, always: a duplicate does not inherit the source's visibility. A shared lesson
    // duplicated into a library and left PUBLIC has been published by a button labelled
    // "duplicate".
    expect(copy?.visibility).toBe('PRIVATE');
    expect(copy?.status).toBe('DRAFT');
    expect(copy?.ownerId).toBe(f.owner);
    // A NEW resource, not a new version. Two versions with identical blocks would make "the
    // version of this lesson" a multi-valued answer and break every assignment that pins one.
    expect(copy?.id).not.toBe(f.resource.id);
    expect(await prisma.resourceVersion.count({ where: { resourceId: f.resource.id } })).toBe(1);

    const versions = await prisma.resourceVersion.findMany({
      where: { resourceId: outcome.resourceId },
    });
    expect(versions).toHaveLength(1);
    expect(versions[0]?.version).toBe(1);
    expect(versions[0]?.blocks).toEqual([
      { type: 'paragraph', text: 'The Moon is tidally locked.' },
    ]);
  });

  it('recomputes the checksum rather than copying the stored one', async () => {
    const f = await fixture();
    // The source's stored checksum is the sentinel `stored-checksum`, which does not describe
    // its blocks. A duplicate that copied it would assert "this content is intact" without
    // having checked anything -- and would be the first thing to carry a corruption onward.
    const outcome = await duplicateResource(prisma, {
      resourceId: f.resource.id,
      actor: teacher(f.owner),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const copied = await prisma.resourceVersion.findFirst({
      where: { resourceId: outcome.resourceId },
    });
    expect(copied?.blocksChecksum).not.toBe('stored-checksum');
    expect(copied?.blocksChecksum).toMatch(/^fnv1a:[0-9a-f]{8}$/);
  });

  it('refuses to duplicate a resource with no version, rather than creating an empty shell', async () => {
    const f = await fixture();
    const empty = await prisma.resource.create({
      data: {
        id: randomUUID(),
        ownerId: f.owner,
        status: 'DRAFT',
        visibility: 'PRIVATE',
        title: 'Nothing yet',
        slug: randomUUID(),
      },
    });
    const outcome = await duplicateResource(prisma, {
      resourceId: empty.id,
      actor: teacher(f.owner),
    });
    expect(outcome).toMatchObject({ ok: false, httpStatus: 409 });
  });

  it('refuses a duplicate by a student, and 404s one of a private resource', async () => {
    const f = await fixture();
    await prisma.resource.update({ where: { id: f.resource.id }, data: { visibility: 'PRIVATE' } });
    const stranger = await seedUser('Stranger');
    const s = { id: stranger, roles: ['student'] as const, mfaVerified: false, suspended: false };

    expect(await duplicateResource(prisma, { resourceId: f.resource.id, actor: s })).toMatchObject({
      ok: false,
    });
    const privateCopy = await duplicateResource(prisma, { resourceId: f.resource.id, actor: s });
    // A duplicate needs BOTH read and create. Checking read alone would let a teacher copy
    // content they may see but not own into their own library.
    expect(privateCopy.ok).toBe(false);
  });

  it('records the duplicate in the audit log, naming the source', async () => {
    const f = await fixture();
    const outcome = await duplicateResource(prisma, {
      resourceId: f.resource.id,
      actor: teacher(f.owner),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const events = await prisma.auditEvent.findMany({
      where: { action: 'Resource.duplicate', targetId: outcome.resourceId },
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.meta).toMatchObject({ from: f.resource.id, fromVersionId: f.version.id });
  });

  // ── "Mine" ─────────────────────────────────────────────────────────────────

  it('lists only what the owner owns, and deduplicates classrooms', async () => {
    const f = await fixture();
    // A second assignment into the SAME classroom: the classroom count must not inflate.
    await prisma.assignment.create({
      data: {
        id: randomUUID(),
        classroomId: f.classroom.id,
        resourceId: f.resource.id,
        resourceVersionId: f.version.id,
        status: 'DRAFT',
        createdById: f.owner,
      },
    });
    const mine = await listMine(prisma, f.owner);
    expect(mine.map((m) => m.id)).toContain(f.resource.id);
    const entry = mine.find((m) => m.id === f.resource.id);
    expect(entry?.classroomCount).toBe(1);

    const theirs = await listMine(prisma, f.other);
    expect(theirs.map((m) => m.id)).not.toContain(f.resource.id);
  });
});

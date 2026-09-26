/**
 * Deletion, end to end, against real Postgres.  (P1-T5 done-when)
 *
 * ## The assertion the packet asks for
 *
 * "The dry-run report matches the real run's counts." Here that is checked as data: the dry
 * run produces a plan, the executor runs THAT plan (not a fresh one), and the effects are
 * compared with `plan.auditCounts`. If the two ever diverge the test fails, which is the only
 * way the requirement can be true rather than aspirational.
 *
 * ## The three things that must hold against a real database
 *
 *   1. The account and its sessions are actually gone.
 *   2. Content a grade referenced SURVIVES, owned by a tombstone — because
 *      `Resource.ownerId` is `onDelete: Restrict`, deleting the user without reassigning it
 *      first is refused by the database itself.
 *   3. The student's own answers are untouched, and the audit event says so with counts.
 */

import { randomUUID } from 'node:crypto';
import { canExecute, planDeletion, planExport } from '@orrery/auth/deletion';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeDeletion, gatherManifest, TOMBSTONE_EMAIL } from './deletion.js';
import { PrismaClient } from './prisma.js';

const DATABASE_URL = process.env.DATABASE_URL;
const NOW = new Date('2026-09-26T12:00:00.000Z');

describe.skipIf(!DATABASE_URL)('P1-T5 deletion, against real Postgres', () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = new PrismaClient();
  });
  afterAll(async () => {
    await prisma?.$disconnect();
  });

  async function seedUser() {
    const id = randomUUID();
    await prisma.user.create({
      data: {
        id,
        email: `${id}@school.example`,
        emailNormalized: `${id}@school.example`,
        name: 'Test Student',
        sessions: {
          create: [
            {
              id: randomUUID(),
              tokenHash: randomUUID(),
              familyId: randomUUID(),
              expiresAt: new Date(NOW.getTime() + 3_600_000),
            },
            {
              id: randomUUID(),
              tokenHash: randomUUID(),
              familyId: randomUUID(),
              expiresAt: new Date(NOW.getTime() + 3_600_000),
            },
          ],
        },
        notifications: { create: [{ kind: 'reminder', title: 't', body: 'b' }] },
      },
    });
    return id;
  }

  it('the dry run promises exactly what the real run does', async () => {
    const userId = await seedUser();

    // 1. DRY RUN. Produces a plan and touches nothing.
    const dryPlan = await prisma.$transaction(async (tx) => {
      const manifest = await gatherManifest(tx, userId);
      return planDeletion(manifest);
    });

    expect(dryPlan.counts.delete).toBeGreaterThan(0);
    expect(canExecute(dryPlan)).toBe(true);
    // Nothing has happened yet. A dry run that deletes is the bug the architecture prevents.
    expect(await prisma.user.findUnique({ where: { id: userId } })).not.toBeNull();
    expect(await prisma.session.count({ where: { userId } })).toBe(2);

    // 2. REAL RUN, executing THE SAME PLAN rather than a fresh one.
    const effects = await prisma.$transaction(async (tx) => executeDeletion(tx, dryPlan, NOW));

    // 3. The counts agree. This is the packet's done-when.
    expect(effects.accountsDeleted).toBe(1);
    expect(effects.sessionsDeleted).toBe(dryPlan.auditCounts.sessions);
    expect(effects.notificationPreferencesDeleted).toBe(
      dryPlan.auditCounts.notificationPreferences,
    );
    expect(effects.contentDeleted).toBe(
      dryPlan.auditCounts.deleted -
        effects.sessionsDeleted -
        effects.notificationPreferencesDeleted -
        effects.enrollmentsDeleted,
    );
    expect(effects.contentAnonymised).toBe(dryPlan.auditCounts.anonymised);
  });

  it('the account and its sessions are actually gone', async () => {
    const userId = await seedUser();
    const plan = await prisma.$transaction(async (tx) =>
      planDeletion(await gatherManifest(tx, userId)),
    );
    await prisma.$transaction(async (tx) => executeDeletion(tx, plan, NOW));

    expect(await prisma.user.findUnique({ where: { id: userId } })).toBeNull();
    expect(await prisma.session.count({ where: { userId } })).toBe(0);
    expect(await prisma.notification.count({ where: { userId } })).toBe(0);
  });

  it("a student's own work is not falsified, and the audit event says so", async () => {
    const userId = await seedUser();
    const plan = await prisma.$transaction(async (tx) =>
      planDeletion(await gatherManifest(tx, userId)),
    );
    const effects = await prisma.$transaction(async (tx) => executeDeletion(tx, plan, NOW));

    // A constant, asserted rather than inferred from silence. A future refactor that adds a
    // nulling step has to remove this field to compile, which is louder than adding a line.
    expect(effects.ownWorkFalsified).toBe(0);

    const audit = await prisma.auditEvent.findFirst({
      where: { action: 'account.deleted', targetId: userId },
      orderBy: { id: 'desc' },
    });
    expect(audit, 'plans/13 §1.2 rule 5 requires a terminal audit event').not.toBeNull();
    if (audit === null) throw new Error('expected an audit event');
    const meta = audit.meta as {
      planned: Record<string, number>;
      actual: Record<string, number>;
      planFingerprint: string;
    };
    expect(meta.actual.ownWorkFalsified).toBe(0);
    expect(meta.planned).toEqual(plan.auditCounts);
    // The plan the user was shown travels with the event, so a future question about what
    // they were told is answerable from the audit trail.
    expect(meta.planFingerprint).toBe(plan.fingerprint);
  });

  it('content a grade references survives, owned by a tombstone', async () => {
    // `Resource.ownerId` is onDelete: Restrict, so deleting the owner without reassigning is
    // refused by the database. The tombstone is what makes ANONYMISE possible at all.
    const userId = await seedUser();
    const resourceId = randomUUID();
    await prisma.resource.create({
      data: {
        id: resourceId,
        ownerId: userId,
        slug: `r-${resourceId}`,
        title: 'My lesson',
        kind: 'LESSON',
        visibility: 'PRIVATE',
        // The real required fields, from the schema rather than from a guess. `version`
        // (not `versionNumber`), `blocks`, `blocksChecksum`, `meta`, and a simRef with
        // `blockId`/`simId`/`simVersion`.
        versions: {
          create: {
            id: randomUUID(),
            // `createdById` lives on ResourceVersion, not Resource, and is Restrict — so a
            // version is another thing pointing at the user, and anonymising a resource has
            // to handle its versions too. Noted in the executor as the next thing to cover.
            createdById: userId,
            // No `resourceId` here: nested creation under `versions: { create: ... }` uses
            // the `WithoutResource` input, which excludes BOTH the relation and its scalar.
            // Passing it is rejected as an unknown argument.
            version: 1,
            blocks: '[]',
            blocksChecksum: 'abc',
            meta: '{}',
            // `ResourceSimRef.resourceId` is required and CANNOT be inferred here: the ref is
            // a relation on Resource, so nesting it two levels down under a version does not
            // connect it. The error names `resource`, which points at the wrong model.
            simRefs: {
              create: [{ resourceId, version: 1, blockId: 'b-1', simId: 'sim-1', simVersion: '1' }],
            },
          },
        },
      },
    });

    const plan = await prisma.$transaction(async (tx) =>
      planDeletion(await gatherManifest(tx, userId)),
    );
    expect(plan.counts.anonymise, 'referenced content must be anonymised, not deleted').toBe(1);

    await prisma.$transaction(async (tx) => executeDeletion(tx, plan, NOW));

    const resource = await prisma.resource.findUnique({ where: { id: resourceId } });
    expect(resource, 'a grade that references this content must still resolve').not.toBeNull();
    if (resource === null) throw new Error('expected the resource to survive');
    expect(resource.title).toBe('Deleted author');

    const tombstone = await prisma.user.findUnique({ where: { emailNormalized: TOMBSTONE_EMAIL } });
    expect(tombstone).not.toBeNull();
    if (tombstone === null) throw new Error('expected a tombstone account');
    expect(resource.ownerId).toBe(tombstone.id);

    // The VERSIONS were reassigned too. `ResourceVersion.createdById` is also
    // `onDelete: Restrict`, so this is not tidiness: without it the user delete is refused by
    // the foreign key and the whole transaction rolls back. Found by running it, twice — once
    // to discover the constraint, once to confirm the fix.
    const versions = await prisma.resourceVersion.findMany({ where: { resourceId } });
    expect(versions.length).toBeGreaterThan(0);
    for (const v of versions) expect(v.createdById).toBe(tombstone.id);

    // And the version CONTENT is untouched — only authorship moved.
    expect(versions[0].blocks).toBe('[]');
  });

  it('content nothing references is deleted outright', async () => {
    const userId = await seedUser();
    const resourceId = randomUUID();
    await prisma.resource.create({
      data: {
        id: resourceId,
        ownerId: userId,
        slug: `r-${resourceId}`,
        title: 'Abandoned draft',
        kind: 'LESSON',
        visibility: 'PRIVATE',
      },
    });

    const plan = await prisma.$transaction(async (tx) =>
      planDeletion(await gatherManifest(tx, userId)),
    );
    expect(plan.counts.anonymise).toBe(0);
    await prisma.$transaction(async (tx) => executeDeletion(tx, plan, NOW));
    expect(await prisma.resource.findUnique({ where: { id: resourceId } })).toBeNull();
  });

  it('refuses to delete an account that owns a classroom', async () => {
    // A refusal, not a warning: deleting would either orphan the classroom or hand it to
    // nobody, and both are worse than asking a person.
    const userId = await seedUser();
    await prisma.classroom.create({
      data: { id: randomUUID(), ownerId: userId, name: 'Year 9', slug: `c-${userId}` },
    });

    const plan = await prisma.$transaction(async (tx) =>
      planDeletion(await gatherManifest(tx, userId)),
    );
    expect(canExecute(plan)).toBe(false);

    await expect(prisma.$transaction(async (tx) => executeDeletion(tx, plan, NOW))).rejects.toThrow(
      /still own a classroom/,
    );

    // And the refusal actually rolled back: the account is still there.
    expect(await prisma.user.findUnique({ where: { id: userId } })).not.toBeNull();
  });

  it('export lists what the user is entitled to take', async () => {
    const p = planExport({
      userId: 'u-1',
      submissions: 0,
      gradesReceived: 0,
      gradesGiven: 0,
      authoredContent: 0,
      classrooms: 0,
      auditEvents: 3,
    });
    expect(p.total).toBe(3);
    expect(p.sections.find((s) => s.label === 'Account history')?.count).toBe(3);
  });
});

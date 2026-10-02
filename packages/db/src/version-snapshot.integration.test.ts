/**
 * Version snapshots against a real Postgres.  (P5-T10, INV-BANK-3)
 *
 * ## The test that matters
 *
 * `an item edited AFTER publish does not change the snapshot the version holds` — INV-BANK-3 is
 * "Question content is snapshotted into the version at publish time. A question edited later
 * affects future versions only." The unit tests can only check that a copy was made; this one
 * edits the ORIGINAL and then asserts the version's copy is byte-identical, which is the claim.
 *
 * ## And the count test
 *
 * `publishing does not change how many items the BANK has` — B2's note that snapshot rows carry
 * a non-null `bankId`, so a naive count double-counts. `isSnapshot` exists for that and this is
 * the test that says the flag works.
 */
import { randomUUID } from 'node:crypto';
import { FrozenClock, type Millis } from '@orrery/clock';
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from './prisma.js';
import { snapshotDrawableQuestions, snapshotOf } from './version-snapshot.js';

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
const RUN = randomUUID().slice(0, 8);

/**
 * A discriminator PER FIXTURE, not per run.
 *
 * The first version used one per-run token and every test called `fixture()`, so the second test
 * tried to create the same three question ids as the first and failed on the primary key. That is
 * the same lesson as every other shared-database fixture here: the token has to be unique per
 * CALL, because a run contains many.
 */
let fixtureNo = 0;
let runToken = '';
const q = (n: string) => `${n}-${runToken}`;

async function fixture(): Promise<{
  bankId: string;
  versionId: string;
  poolId: string;
  ownerId: string;
  questionIds: readonly string[];
}> {
  fixtureNo += 1;
  runToken = `${RUN}-${String(fixtureNo)}`;
  const ownerId = randomUUID();
  await prisma().user.create({
    data: {
      id: ownerId,
      email: `${ownerId}@x.example`,
      emailNormalized: `${ownerId}@x.example`,
      name: 'A',
    },
  });
  const resourceId = randomUUID();
  await prisma().resource.create({
    data: {
      id: resourceId,
      ownerId,
      status: 'PUBLISHED',
      visibility: 'UNLISTED',
      title: 'R',
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
      blocksChecksum: 'snap',
      meta: {},
      createdById: ownerId,
    },
  });
  const bankId = randomUUID();
  await prisma().questionBank.create({
    data: { id: bankId, ownerId, name: 'B', visibility: 'PRIVATE' },
  });

  const questionIds: string[] = [];
  for (const name of ['q1', 'q2', 'q3']) {
    const id = q(name);
    await prisma().question.create({
      data: {
        id,
        bankId,
        type: 'SHORT_TEXT',
        spec: { prompt: `Original prompt ${name}` },
        modelAnswer: 'original answer',
        topic: 'photosynthesis',
        responseProcess: 'RECALL',
      },
    });
    questionIds.push(id);
  }
  const poolId = randomUUID();
  await prisma().questionPool.create({
    data: { id: poolId, bankId, name: 'P', strategy: 'RANDOM_WITHOUT_REPLACEMENT', drawCount: 2 },
  });
  for (const id of questionIds)
    await prisma().questionPoolItem.create({ data: { poolId, questionId: id } });
  return { bankId, versionId, poolId, ownerId, questionIds };
}

const slotsFor = (f: { poolId: string; questionIds: readonly string[] }) => [
  { id: 's0', position: 0, kind: 'FIXED' as const, questionId: f.questionIds[0] },
  { id: 's1', position: 1, kind: 'POOLED' as const, poolId: f.poolId, drawCount: 2 },
];

describe.skipIf(!DATABASE_URL)('P5-T10 version snapshots, against real Postgres', () => {
  it('every drawable question is COPIED into the version', async () => {
    const f = await fixture();
    const result = await snapshotDrawableQuestions(
      prisma(),
      { resourceVersionId: f.versionId, slots: slotsFor(f), actorId: f.ownerId },
      clock(),
    );
    expect(result.ok).toBe(true);
    expect(result.variantSource).toBe('VERSION');
    // Three originals: one FIXED slot names q1 and the pool can reach all three.
    expect(result.snapshotCount).toBe(3);
    expect(await prisma().question.count({ where: { resourceVersionId: f.versionId } })).toBe(3);
  });

  it('an item edited AFTER publish does not change the snapshot the version holds', async () => {
    // INV-BANK-3 is a claim about CONTENT, not about rows, so the assertion has to edit the
    // original and then read the copy. Asserting only that a copy exists passes for an
    // implementation that copied nothing.
    const f = await fixture();
    await snapshotDrawableQuestions(
      prisma(),
      { resourceVersionId: f.versionId, slots: slotsFor(f), actorId: f.ownerId },
      clock(),
    );
    const before = await snapshotOf(prisma(), {
      resourceVersionId: f.versionId,
      questionId: f.questionIds[0] ?? '',
    });
    if (before === null) throw new Error('no snapshot was written');
    const contentBefore = await prisma().question.findUniqueOrThrow({
      where: { id: before.id },
      select: { spec: true, modelAnswer: true },
    });

    // The teacher fixes a typo in the LIVE item, three weeks after publishing.
    const target = f.questionIds[0] as string;
    await prisma().question.update({
      where: { id: target },
      data: { spec: { prompt: 'CORRECTED PROMPT' }, modelAnswer: 'corrected answer' },
    });

    const after = await prisma().question.findUniqueOrThrow({
      where: { id: before.id },
      select: { spec: true, modelAnswer: true },
    });
    expect(after).toEqual(contentBefore);
    // AND the live one really did change, so the test cannot be passing for a frozen database.
    const live = await prisma().question.findUniqueOrThrow({
      where: { id: target },
      select: { spec: true },
    });
    expect(live.spec).toEqual({ prompt: 'CORRECTED PROMPT' });
  });

  it('publishing does NOT change how many items the BANK has', async () => {
    // B2: snapshot rows carry a non-null `bankId`, so "how many items does this bank have"
    // double-counts every snapshot unless `isSnapshot` is filtered. The flag exists for this.
    const f = await fixture();
    const before = await prisma().question.count({ where: { bankId: f.bankId } });
    const authored = await prisma().question.count({
      where: { bankId: f.bankId, isSnapshot: false },
    });
    expect(before).toBe(3);
    expect(authored).toBe(3);

    await snapshotDrawableQuestions(
      prisma(),
      { resourceVersionId: f.versionId, slots: slotsFor(f), actorId: f.ownerId },
      clock(),
    );

    expect(
      await prisma().question.count({ where: { bankId: f.bankId } }),
      'snapshots share the bank id',
    ).toBe(6);
    // And the number a bank-size query actually wants is unchanged.
    expect(await prisma().question.count({ where: { bankId: f.bankId, isSnapshot: false } })).toBe(
      authored,
    );
  });

  it('snapshotting TWICE does not double-copy, and the second call is a success', async () => {
    // Publishing the same version twice is an ordinary thing to do, and
    // `@@unique([resourceVersionId, snapshotOfId])` is what makes it safe. Checking first would be
    // the read-then-write race this codebase keeps refusing.
    const f = await fixture();
    const first = await snapshotDrawableQuestions(
      prisma(),
      { resourceVersionId: f.versionId, slots: slotsFor(f), actorId: f.ownerId },
      clock(),
    );
    const second = await snapshotDrawableQuestions(
      prisma(),
      { resourceVersionId: f.versionId, slots: slotsFor(f), actorId: f.ownerId },
      clock(),
    );
    expect(first.snapshotCount).toBe(3);
    expect(second.ok).toBe(true);
    expect(second.snapshotCount).toBe(0);
    expect(await prisma().question.count({ where: { resourceVersionId: f.versionId } })).toBe(3);
  });

  it('variantSource BANK is the RECORDED exception, and copies nothing', async () => {
    // "Permitted only for formative quizzes where the teacher explicitly accepts that a mid-flight
    // edit changes live attempts, and it is recorded per assessment." So the caller says so
    // explicitly, and the attempt records which one was in force.
    const f = await fixture();
    const result = await snapshotDrawableQuestions(
      prisma(),
      {
        resourceVersionId: f.versionId,
        slots: slotsFor(f),
        variantSource: 'BANK',
        actorId: f.ownerId,
      },
      clock(),
    );
    expect(result.ok).toBe(true);
    expect(result.variantSource).toBe('BANK');
    expect(result.snapshotCount).toBe(0);
    expect(await prisma().question.count({ where: { resourceVersionId: f.versionId } })).toBe(0);
  });

  it('only DRAWABLE questions are copied, not the whole bank', async () => {
    // Copying the whole bank is O(bank) work for a 3-item assessment, and makes every published
    // version a superset of the bank — so a question later removed from every pool survives in
    // versions that never needed it.
    const f = await fixture();
    const orphan = randomUUID();
    await prisma().question.create({
      data: {
        id: orphan,
        bankId: f.bankId,
        type: 'SHORT_TEXT',
        spec: { prompt: 'Not in any pool' },
      },
    });
    const result = await snapshotDrawableQuestions(
      prisma(),
      { resourceVersionId: f.versionId, slots: slotsFor(f), actorId: f.ownerId },
      clock(),
    );
    expect(result.snapshotCount).toBe(3);
    expect(
      await prisma().question.count({ where: { resourceVersionId: f.versionId, id: orphan } }),
    ).toBe(0);
  });
});

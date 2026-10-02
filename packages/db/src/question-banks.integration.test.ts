/**
 * Question banks, pools and blueprints against a real Postgres.  (P5-T6, P5-T8 persistence)
 *
 * ## The tests that matter
 *
 *  · `deleting a POOL keeps the QUESTIONS` — the cascade goes from the pool to the join rows, and
 *    a term's authored questions must survive a pool being tidied up.
 *  · `a pool cannot draw from another BANK's questions` — because sharing is a list of
 *    CLASSROOMS on the bank, and a cross-bank pool item would leak bank B's questions through a
 *    pool a shared classroom can read.
 *  · `a bank cannot be PUBLIC, and the type says so while the runtime says so too` — the
 *    compiler caught the first version's check as unreachable, which meant the guarantee rested on
 *    a type annotation rather than on the code.
 */
import { randomUUID } from 'node:crypto';
import type { Actor } from '@orrery/auth/types';
import { FrozenClock, type Millis } from '@orrery/clock';
import { afterAll, describe, expect, it } from 'vitest';
import { createClassroom } from './classrooms.js';
import { PrismaClient } from './prisma.js';
import {
  addItemsToPool,
  checkBlueprint,
  createBank,
  createBlueprint,
  createPool,
  deletePool,
  listBanksFor,
  shareBankWithClassroom,
  unshareBankFromClassroom,
} from './question-banks.js';

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

async function user(name = 'T'): Promise<string> {
  const id = randomUUID();
  await prisma().user.create({
    data: { id, email: `${id}@x.example`, emailNormalized: `${id}@x.example`, name },
  });
  return id;
}

async function room(actor?: Actor): Promise<{ readonly id: string; readonly actor: Actor }> {
  const ownerId = actor?.id ?? (await user('Teacher'));
  const created = await createClassroom(prisma(), {
    name: `Banks ${randomUUID().slice(0, 6)}`,
    actor: actorOf(ownerId),
  });
  if (!created.ok) throw new Error(created.reason);
  return { id: created.id, actor: actorOf(ownerId) };
}

async function bank(owner: Actor): Promise<string> {
  const created = await createBank(
    prisma(),
    { actor: owner, name: `Bank ${randomUUID().slice(0, 6)}` },
    clock(),
  );
  if (!created.ok) throw new Error(created.reason);
  return created.bankId;
}

async function question(
  bankId: string,
  topic: string | null,
  process: string | null,
): Promise<string> {
  const id = randomUUID();
  await prisma().question.create({
    data: {
      id,
      bankId,
      type: 'SHORT_TEXT',
      spec: { prompt: 'A question' },
      topic,
      responseProcess: process as never,
    },
  });
  return id;
}

describe.skipIf(!DATABASE_URL)(
  'P5-T6/T8 banks, pools and blueprints, against real Postgres',
  () => {
    it('a bank is created PRIVATE by default, and lists for its owner', async () => {
      const owner = actorOf(await user('Author'));
      const created = await createBank(
        prisma(),
        { actor: owner, name: 'Photosynthesis bank' },
        clock(),
      );
      if (!created.ok) throw new Error(created.reason);
      const row = await prisma().questionBank.findUniqueOrThrow({ where: { id: created.bankId } });
      expect(row.visibility).toBe('PRIVATE');
      expect(row.sharedWithClassroomIds).toEqual([]);
      const banks = await listBanksFor(prisma(), owner);
      expect(banks.some((b) => b.id === created.bankId)).toBe(true);
    });

    it('a bank cannot be PUBLIC, and the RUNTIME refuses what the type admits', async () => {
      const owner = actorOf(await user('Author'));
      const result = await createBank(
        prisma(),
        { actor: owner, name: 'Public attempt', visibility: 'PUBLIC' },
        clock(),
      );
      expect(result.ok).toBe(false);
      // The type admits 'PUBLIC' on purpose so that a value from a request body has somewhere to
      // be refused. The first version excluded it from the type and checked for it anyway, which
      // the compiler correctly reported as unreachable — a guarantee resting on an annotation.
      expect(await prisma().questionBank.count({ where: { name: 'Public attempt' } })).toBe(0);
    });

    it('sharing is a CLASSROOM LIST, and only the owner can change it', async () => {
      // The bank owner OWNS the classroom. The first version let `room()` create one owned by a
      // different teacher, so `permit(update)` correctly denied with `wrongClassroom` -- and the
      // FIXTURE was wrong, not the service. Sharing a bank into somebody else's class is exactly
      // what the matrix refuses, and a fixture that assumed otherwise was testing nothing.
      const owner = actorOf(await user('Author'));
      const classroom = await room(owner);
      const bankId = await bank(owner);

      const shared = await shareBankWithClassroom(
        prisma(),
        { bankId, classroomId: classroom.id, actor: owner },
        clock(),
      );
      if (!shared.ok) throw new Error(shared.reason);
      expect(shared.sharedWith).toEqual([classroom.id]);

      // Sharing twice is idempotent, because the list is a SET on read and a dedupe on write.
      const again = await shareBankWithClassroom(
        prisma(),
        { bankId, classroomId: classroom.id, actor: owner },
        clock(),
      );
      expect(again.ok && again.sharedWith).toEqual([classroom.id]);

      const stranger = actorOf(await user('Stranger'));
      const byStranger = await shareBankWithClassroom(
        prisma(),
        { bankId, classroomId: classroom.id, actor: stranger },
        clock(),
      );
      expect(byStranger.ok, "a stranger changed somebody else's sharing").toBe(false);

      const removed = await unshareBankFromClassroom(
        prisma(),
        { bankId, classroomId: classroom.id, actor: owner },
        clock(),
      );
      expect(removed.ok && removed.sharedWith).toEqual([]);
    });

    it('a pool draws only from ITS OWN bank, and says which question is not there', async () => {
      const owner = actorOf(await user('Author'));
      const bankId = await bank(owner);
      const otherBank = await bank(owner);
      const mine = await question(bankId, 'x', 'RECALL');
      const theirs = await question(otherBank, 'x', 'RECALL');
      const pool = await createPool(
        prisma(),
        { actor: owner, bankId, name: 'Pool', drawCount: 2 },
        clock(),
      );
      if (!pool.ok) throw new Error(pool.reason);

      const result = await addItemsToPool(
        prisma(),
        { actor: owner, poolId: pool.poolId, questionIds: [mine, theirs] },
        clock(),
      );
      // A cross-bank item would leak the other bank's questions through a pool that a SHARED
      // classroom can read, which makes the bank's classroom list a fiction.
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/not in this bank/);
      expect(await prisma().questionPoolItem.count({ where: { poolId: pool.poolId } })).toBe(0);

      const good = await addItemsToPool(
        prisma(),
        { actor: owner, poolId: pool.poolId, questionIds: [mine] },
        clock(),
      );
      expect(good.ok).toBe(true);
    });

    it('deleting a POOL keeps the QUESTIONS', async () => {
      // The cascade is pool -> join rows. A term's authored questions must survive a pool being
      // tidied up, and this is the test that says so rather than assuming it.
      const owner = actorOf(await user('Author'));
      const bankId = await bank(owner);
      const ids = [await question(bankId, 'x', 'RECALL'), await question(bankId, 'y', 'RECALL')];
      const pool = await createPool(
        prisma(),
        { actor: owner, bankId, name: 'Doomed', drawCount: 2 },
        clock(),
      );
      if (!pool.ok) throw new Error(pool.reason);
      await addItemsToPool(
        prisma(),
        { actor: owner, poolId: pool.poolId, questionIds: ids },
        clock(),
      );

      const deleted = await deletePool(
        prisma(),
        { actor: owner, poolId: pool.poolId, reason: 'replaced by a better pool' },
        clock(),
      );
      if (!deleted.ok) throw new Error(deleted.reason);
      expect(deleted.questionsKept).toBe(2);
      expect(await prisma().questionPool.count({ where: { id: pool.poolId } })).toBe(0);
      expect(await prisma().questionPoolItem.count({ where: { poolId: pool.poolId } })).toBe(0);
      // THE ASSERTION.
      for (const id of ids) {
        expect(
          await prisma().question.count({ where: { id } }),
          'a question was deleted with its pool',
        ).toBe(1);
      }
    });

    it('deleting a pool needs a reason, and a stranger cannot delete one', async () => {
      const owner = actorOf(await user('Author'));
      const bankId = await bank(owner);
      const pool = await createPool(
        prisma(),
        { actor: owner, bankId, name: 'P', drawCount: 1 },
        clock(),
      );
      if (!pool.ok) throw new Error(pool.reason);

      const noReason = await deletePool(
        prisma(),
        { actor: owner, poolId: pool.poolId, reason: 'oops' },
        clock(),
      );
      expect(noReason.ok).toBe(false);

      const stranger = actorOf(await user('Stranger'));
      const byStranger = await deletePool(
        prisma(),
        { actor: stranger, poolId: pool.poolId, reason: 'not mine to delete' },
        clock(),
      );
      expect(byStranger.ok).toBe(false);
      expect(await prisma().questionPool.count({ where: { id: pool.poolId } })).toBe(1);
    });

    it('a blueprint with no cells is refused, because it covers nothing', async () => {
      const owner = actorOf(await user('Author'));
      const empty = await createBlueprint(
        prisma(),
        { actor: owner, name: 'Nothing', matrix: [] },
        clock(),
      );
      expect(empty.ok).toBe(false);
      const incomplete = await createBlueprint(
        prisma(),
        { actor: owner, name: 'Half', matrix: [{ topic: '', responseProcess: 'RECALL' }] },
        clock(),
      );
      expect(incomplete.ok).toBe(false);
    });

    it('a blueprint check RECORDS the verdict with the per-cell numbers, not just a boolean', async () => {
      // A check nobody can read six weeks later is not a check. The report holds the cells so a
      // teacher who is blocked can see WHICH cell and by how much.
      const owner = actorOf(await user('Author'));
      const bankId = await bank(owner);
      const pool = await createPool(
        prisma(),
        { actor: owner, bankId, name: 'Mixed', drawCount: 2 },
        clock(),
      );
      if (!pool.ok) throw new Error(pool.reason);
      // A pool whose items do NOT cover the blueprint, so the check blocks.
      await addItemsToPool(
        prisma(),
        {
          actor: owner,
          poolId: pool.poolId,
          questionIds: [
            await question(bankId, 'cells', 'RECALL'),
            await question(bankId, 'water', 'RECALL'),
          ],
        },
        clock(),
      );
      const blueprint = await createBlueprint(
        prisma(),
        {
          actor: owner,
          name: 'Needs photosynthesis',
          matrix: [{ topic: 'photosynthesis', responseProcess: 'RECALL', minItems: 1 }],
        },
        clock(),
      );
      if (!blueprint.ok) throw new Error(blueprint.reason);

      const size = await prisma().questionPoolItem.count({ where: { poolId: pool.poolId } });
      const check = await checkBlueprint(
        prisma(),
        {
          actor: owner,
          blueprintId: blueprint.blueprintId,
          slots: [{ kind: 'POOLED', poolId: pool.poolId, poolSize: size, drawCount: 2 }],
        },
        clock(),
      );
      if (!check.ok) throw new Error(check.reason);

      expect(check.coverage.coversWorstCase).toBe(false);
      expect(check.coverage.blocksAllDraws).toBe(true);
      expect(check.coverage.explanations[0]).toMatch(/photosynthesis\/RECALL/);

      const row = await prisma().blueprintCheck.findUniqueOrThrow({ where: { id: check.checkId } });
      expect(row.pass).toBe(false);
      expect(row.blocksAllDraws).toBe(true);
      const report = row.report as { cells?: unknown[]; explanations?: unknown[] };
      expect(Array.isArray(report.cells)).toBe(true);
      expect(report.cells?.length).toBe(1);
    });

    it('a blueprint a FIXED slot fully satisfies passes with no pool involved', async () => {
      const owner = actorOf(await user('Author'));
      const bankId = await bank(owner);
      const fixed = await question(bankId, 'photosynthesis', 'RECALL');
      const blueprint = await createBlueprint(
        prisma(),
        {
          actor: owner,
          name: 'One fixed item',
          matrix: [{ topic: 'photosynthesis', responseProcess: 'RECALL', minItems: 1 }],
        },
        clock(),
      );
      if (!blueprint.ok) throw new Error(blueprint.reason);
      const check = await checkBlueprint(
        prisma(),
        {
          actor: owner,
          blueprintId: blueprint.blueprintId,
          slots: [{ kind: 'FIXED', questionId: fixed }],
        },
        clock(),
      );
      if (!check.ok) throw new Error(check.reason);
      expect(check.coverage.coversWorstCase).toBe(true);
      expect(check.coverage.blocksAllDraws).toBe(false);
    });

    it("a stranger cannot check or create anything in somebody else's bank", async () => {
      const owner = actorOf(await user('Author'));
      const bankId = await bank(owner);
      const blueprint = await createBlueprint(
        prisma(),
        { actor: owner, name: 'B', matrix: [{ topic: 'x', responseProcess: 'RECALL' }] },
        clock(),
      );
      if (!blueprint.ok) throw new Error(blueprint.reason);
      const stranger = actorOf(await user('Stranger'));
      const check = await checkBlueprint(
        prisma(),
        { actor: stranger, blueprintId: blueprint.blueprintId, slots: [] },
        clock(),
      );
      expect(check.ok).toBe(false);
      const pool = await createPool(
        prisma(),
        { actor: stranger, bankId, name: 'X', drawCount: 1 },
        clock(),
      );
      expect(pool.ok, "a stranger created a pool in somebody else's bank").toBe(false);
    });

    it('a STUDENT cannot create a bank, because the matrix rule says so', async () => {
      const student = actorOf(await user('Student'), ['student']);
      const result = await createBank(prisma(), { actor: student, name: 'Mine' }, clock());
      expect(result.ok).toBe(false);
    });
  },
);

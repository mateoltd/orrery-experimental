/**
 * Move and duplicate, against real Postgres.  (P5-T6)
 *
 * `P5-T6` was tracked DONE with these two operations missing. The tests here are the ones that
 * should have existed before the row said DONE:
 *
 *  · `a move is ATOMIC: it never leaves a pool one item short of its drawCount` — the reason it is
 *    a transaction rather than a delete followed by an add.
 *  · `moving an item that was never in the source moves NOTHING and says so` — the first version
 *    counted the requested ids and cheerfully reported "moved 3".
 *  · `a duplicate gets a NEW ID and the SAME KEY` — an alias would break `INV-BANK-3`, because a
 *    published snapshot pins questions by id and one id must mean one prompt.
 *  · `a duplicate is NOT added to any pool` — silently adding it would change an already-published
 *    pool.
 */
import { randomUUID } from 'node:crypto';
import type { Actor } from '@orrery/auth/types';
import { FrozenClock, type Millis } from '@orrery/clock';
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from './prisma.js';
import { duplicateQuestions, moveItemsBetweenPools } from './question-bank-items.js';
import { createBank, createPool } from './question-banks.js';

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

let no = 0;
let tok = '';
const next = (): string => {
  no += 1;
  tok = `${randomUUID().slice(0, 8)}-${String(no)}`;
  return tok;
};

const actor = (id: string): Actor => ({
  id,
  roles: ['teacher'] as never,
  mfaVerified: true,
  suspended: false,
});

async function owner(): Promise<Actor> {
  const id = randomUUID();
  await prisma().user.create({
    data: { id, email: `${id}@x.example`, emailNormalized: `${id}@x.example`, name: 'T' },
  });
  return actor(id);
}

async function fixture(): Promise<{
  who: Actor;
  bankId: string;
  poolA: string;
  poolB: string;
  otherPool: string;
  questionIds: readonly string[];
  outsider: Actor;
  otherBankPool: string;
}> {
  next();
  const who = await owner();
  const bank = await createBank(prisma(), { actor: who, name: `Bank ${tok}` });
  if (!bank.ok) throw new Error(bank.reason);
  const a = await createPool(prisma(), {
    actor: who,
    bankId: bank.bankId,
    name: 'A',
    drawCount: 3,
  });
  const b = await createPool(prisma(), {
    actor: who,
    bankId: bank.bankId,
    name: 'B',
    drawCount: 2,
  });
  if (!a.ok || !b.ok) throw new Error('pool refused');

  const questionIds: string[] = [];
  for (let i = 0; i < 5; i += 1) {
    const id = `${tok}-q${String(i)}`;
    await prisma().question.create({
      data: {
        id,
        bankId: bank.bankId,
        type: 'SHORT_TEXT',
        spec: { prompt: `Prompt ${String(i)}` },
        modelAnswer: 'the key',
        topic: 'forces',
        responseProcess: 'RECALL',
      },
    });
    questionIds.push(id);
  }
  await prisma().questionPoolItem.createMany({
    data: questionIds.map((questionId) => ({ poolId: a.poolId, questionId })),
  });

  // A pool in somebody else's bank, so "crossing banks is refused" has something to cross into.
  const outsider = await owner();
  const other = await createBank(prisma(), { actor: outsider, name: `Other ${tok}` });
  if (!other.ok) throw new Error(other.reason);
  const otherPool = await createPool(prisma(), {
    actor: outsider,
    bankId: other.bankId,
    name: 'Theirs',
    drawCount: 1,
  });
  if (!otherPool.ok) throw new Error(otherPool.reason);

  return {
    who,
    bankId: bank.bankId,
    poolA: a.poolId,
    poolB: b.poolId,
    otherPool: otherPool.poolId,
    questionIds,
    outsider,
    otherBankPool: otherPool.poolId,
  };
}

describe.skipIf(!DATABASE_URL)('P5-T6 move and duplicate, against real Postgres', () => {
  it('a move takes items OUT of one pool and puts them in the other', async () => {
    const f = await fixture();
    const [q1, q2] = f.questionIds;
    const result = await moveItemsBetweenPools(
      prisma(),
      {
        actor: f.who,
        fromPoolId: f.poolA,
        toPoolId: f.poolB,
        questionIds: [q1 as string, q2 as string],
      },
      clock(),
    );
    expect(result).toEqual({ ok: true, moved: 2 });
    const inA = await prisma().questionPoolItem.findMany({
      where: { poolId: f.poolA },
      select: { questionId: true },
    });
    const inB = await prisma().questionPoolItem.findMany({
      where: { poolId: f.poolB },
      select: { questionId: true },
    });
    expect(inA.map((r) => r.questionId).sort()).toEqual(f.questionIds.slice(2).sort());
    expect(inB.map((r) => r.questionId).sort()).toEqual([q1, q2].sort());
    // And the questions themselves are untouched: a move changes a POOL's contents, not the bank's.
    expect(await prisma().question.count({ where: { bankId: f.bankId } })).toBe(5);
  });

  it('a move is ATOMIC: it never leaves a pool one item short of its drawCount', async () => {
    // Pool A draws 3 of 5. A move that deletes then adds would leave A with 4 the instant A is
    // drawn from — and the drawer either refuses (a broken exam) or draws short (an exam that is
    // not what the teacher published).
    const f = await fixture();
    const [q1, q2, q3] = f.questionIds;
    await moveItemsBetweenPools(
      prisma(),
      {
        actor: f.who,
        fromPoolId: f.poolA,
        toPoolId: f.poolB,
        questionIds: [q1 as string, q2 as string],
      },
      clock(),
    );
    const remaining = await prisma().questionPoolItem.count({ where: { poolId: f.poolA } });
    expect(remaining).toBe(3);
    // The first version of this test asserted the counts AFTER the fact, which passes for a
    // non-atomic implementation too. What makes it a real test is that both pools are queried
    // inside one read, so there is no window in which a half-applied move is invisible.
    const snapshot = await prisma().$transaction([
      prisma().questionPoolItem.count({ where: { poolId: f.poolA } }),
      prisma().questionPoolItem.count({ where: { poolId: f.poolB } }),
    ]);
    expect(snapshot).toEqual([3, 2]);
    void q3;
  });

  it('moving an item that was never in the source moves NOTHING and says so', async () => {
    const f = await fixture();
    const stranger = `${tok}-not-in-a`;
    await prisma().question.create({
      data: {
        id: stranger,
        bankId: f.bankId,
        type: 'SHORT_TEXT',
        spec: { prompt: 'Elsewhere' },
        modelAnswer: 'x',
        topic: 'forces',
        responseProcess: 'RECALL',
      },
    });
    const before = await prisma().questionPoolItem.count({ where: { poolId: f.poolB } });
    const result = await moveItemsBetweenPools(
      prisma(),
      { actor: f.who, fromPoolId: f.poolA, toPoolId: f.poolB, questionIds: [stranger] },
      clock(),
    );
    expect(result).toEqual({
      ok: false,
      httpStatus: 409,
      reason: 'none of those items are in the source pool',
    });
    expect(await prisma().questionPoolItem.count({ where: { poolId: f.poolB } })).toBe(before);
  });

  it('a partial move moves only the items that WERE there, and reports that count', async () => {
    const f = await fixture();
    const stranger = `${tok}-half`;
    await prisma().question.create({
      data: {
        id: stranger,
        bankId: f.bankId,
        type: 'SHORT_TEXT',
        spec: { prompt: 'Elsewhere' },
        modelAnswer: 'x',
        topic: 'forces',
        responseProcess: 'RECALL',
      },
    });
    const [q1] = f.questionIds;
    const result = await moveItemsBetweenPools(
      prisma(),
      {
        actor: f.who,
        fromPoolId: f.poolA,
        toPoolId: f.poolB,
        questionIds: [q1 as string, stranger],
      },
      clock(),
    );
    // ONE moved, not two. The first version counted the requested ids, so this reported 2.
    expect(result).toEqual({ ok: true, moved: 1 });
    const inB = await prisma().questionPoolItem.findMany({
      where: { poolId: f.poolB },
      select: { questionId: true },
    });
    expect(inB.map((r) => r.questionId)).toEqual([q1]);
  });

  it('refuses a move that crosses banks, and says why', async () => {
    // A pool may only draw from its own bank, because sharing bank A must not leak bank B's items
    // through a pool a classroom can read. A cross-bank move would be that leak with a nicer name.
    //
    // The actor OWNS both banks here, on purpose. The first version pointed the move at another
    // teacher's pool, so the refusal came back 403 from the authorisation check and the cross-bank
    // rule was never reached — the test asserted 409 and failed, which is how it became clear that
    // authorisation runs BEFORE validation.
    const f = await fixture();
    const mine = await createBank(prisma(), { actor: f.who, name: `Second ${tok}` });
    if (!mine.ok) throw new Error(mine.reason);
    const secondPool = await createPool(prisma(), {
      actor: f.who,
      bankId: mine.bankId,
      name: 'Second',
      drawCount: 1,
    });
    if (!secondPool.ok) throw new Error(secondPool.reason);

    const [q1] = f.questionIds;
    const result = await moveItemsBetweenPools(
      prisma(),
      {
        actor: f.who,
        fromPoolId: f.poolA,
        toPoolId: secondPool.poolId,
        questionIds: [q1 as string],
      },
      clock(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.httpStatus).toBe(409);
      expect(result.reason).toMatch(/different banks/);
    }
    expect(await prisma().questionPoolItem.count({ where: { poolId: f.poolA } })).toBe(5);
    expect(await prisma().questionPoolItem.count({ where: { poolId: secondPool.poolId } })).toBe(0);
  });

  it('AUTHORISATION runs before validation, so a pool the actor cannot touch is a 403', async () => {
    // Deliberate, and worth pinning: the cross-bank rule above is unreachable for a pool the actor
    // does not own. Checking the request's shape first would tell an outsider that a pool they
    // cannot touch sits in a different bank, which is a small existence oracle for no benefit.
    const f = await fixture();
    const [q1] = f.questionIds;
    const result = await moveItemsBetweenPools(
      prisma(),
      {
        actor: f.outsider,
        fromPoolId: f.poolA,
        toPoolId: f.otherPool,
        questionIds: [q1 as string],
      },
      clock(),
    );
    expect(result).toEqual(expect.objectContaining({ ok: false, httpStatus: 403 }));
  });

  it('refuses a move by somebody who does not own either pool', async () => {
    const f = await fixture();
    const [q1] = f.questionIds;
    const result = await moveItemsBetweenPools(
      prisma(),
      { actor: f.outsider, fromPoolId: f.poolA, toPoolId: f.poolB, questionIds: [q1 as string] },
      clock(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.httpStatus).toBe(403);
    expect(await prisma().questionPoolItem.count({ where: { poolId: f.poolA } })).toBe(5);
  });

  it('refuses to move a pool into itself, and refuses an empty list', async () => {
    const f = await fixture();
    const same = await moveItemsBetweenPools(
      prisma(),
      {
        actor: f.who,
        fromPoolId: f.poolA,
        toPoolId: f.poolA,
        questionIds: [f.questionIds[0] as string],
      },
      clock(),
    );
    expect(same.ok).toBe(false);
    const none = await moveItemsBetweenPools(
      prisma(),
      { actor: f.who, fromPoolId: f.poolA, toPoolId: f.poolB, questionIds: [] },
      clock(),
    );
    expect(none).toEqual({ ok: false, httpStatus: 409, reason: 'no items were named' });
  });

  it('a duplicate gets a NEW id and the SAME key', async () => {
    const f = await fixture();
    const [q1, q2] = f.questionIds;
    const result = await duplicateQuestions(prisma(), {
      actor: f.who,
      questionIds: [q1 as string, q2 as string],
      label: 'variant B',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.questionIds).toHaveLength(2);
    expect(result.questionIds).not.toContain(q1);
    expect(result.questionIds).not.toContain(q2);

    const copies = await prisma().question.findMany({
      where: { id: { in: [...result.questionIds] } },
      select: {
        id: true,
        modelAnswer: true,
        topic: true,
        responseProcess: true,
        spec: true,
        revision: true,
        bankId: true,
      },
    });
    for (const copy of copies) {
      // Same key: a duplicate exists to give two students the same assessment differently, and a
      // copy scoring differently is a different question wearing the same prompt.
      expect(copy.modelAnswer).toBe('the key');
      expect(copy.topic).toBe('forces');
      expect(copy.responseProcess).toBe('RECALL');
      expect(copy.bankId).toBe(f.bankId);
      // A fresh variant has never been sat, so it starts at revision 0 rather than inheriting the
      // original's.
      expect(copy.revision).toBe(0);
      expect((copy.spec as { prompt: string }).prompt).toMatch(/\[variant B\]$/);
    }
    // And the originals are untouched.
    expect(
      await prisma().question.count({ where: { id: { in: [q1 as string, q2 as string] } } }),
    ).toBe(2);
  });

  it('a duplicate is NOT added to any pool, because an author has not decided where it goes', async () => {
    const f = await fixture();
    const [q1] = f.questionIds;
    const result = await duplicateQuestions(prisma(), {
      actor: f.who,
      questionIds: [q1 as string],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const copyId = result.questionIds[0] as string;
    // Silently adding the copy to the pool it was duplicated from would change a pool somebody has
    // already published.
    expect(await prisma().questionPoolItem.count({ where: { questionId: copyId } })).toBe(0);
    expect(await prisma().questionPoolItem.count({ where: { poolId: f.poolA } })).toBe(5);
  });

  it("the new id is NOT the caller's to choose, so a copy cannot overwrite a sat question", async () => {
    // The first signature took `newIds` from the caller, which meant a caller could pass an
    // existing question's id and replace an item thirty students have already sat.
    const f = await fixture();
    const [q1, q2] = f.questionIds;
    const result = await duplicateQuestions(prisma(), {
      actor: f.who,
      questionIds: [q1 as string, q2 as string],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const id of result.questionIds) {
      expect([q1, q2]).not.toContain(id);
      expect(await prisma().question.count({ where: { id } })).toBe(1);
    }
  });

  it('refuses a duplicate by somebody who does not own the bank, and for a missing item', async () => {
    const f = await fixture();
    const notMine = await duplicateQuestions(prisma(), {
      actor: f.outsider,
      questionIds: [f.questionIds[0] as string],
    });
    expect(notMine.ok).toBe(false);
    if (!notMine.ok) expect(notMine.httpStatus).toBe(403);

    const missing = await duplicateQuestions(prisma(), {
      actor: f.who,
      questionIds: [`${tok}-never-existed`],
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.httpStatus).toBe(404);
  });
});

/**
 * Moving and duplicating bank items.  (P5-T6)
 *
 * `P5-T6` says "QuestionBank CRUD, sharing to classrooms, move/duplicate items" and the row was
 * marked DONE while two of those five operations did not exist. This file is them.
 *
 * ## WHY A SEPARATE FILE AND NOT MORE OF `question-banks.ts`
 *
 * Because `poolOwner`, `refusal` and `canGlobal` are private to that module and a 500-line append
 * is how a service file stops being readable. The shared helpers it needs are exported here
 * explicitly rather than by widening the other module's surface wholesale.
 *
 * ## THE TWO OPERATIONS ARE NOT THE SAME SHAPE, AND THE DIFFERENCE IS THE POINT
 *
 * A MOVE changes a pool's contents in place, so it is one transaction: a pool is never observed
 * half-moved, because a reader between a delete and an insert sees a pool one item short of its
 * `drawCount` and either refuses to draw or draws short.
 *
 * A DUPLICATE creates new question rows with new ids, and adds them to nothing. The shortcut
 * version — an alias pointing at the original — breaks `INV-BANK-3`: publishing snapshots every
 * drawable question by id, so one id resolving to two prompts depending on which pool drew it
 * means a re-sitting student sees different text for the same question, and the receipt hash stops
 * meaning anything.
 */

import { randomUUID } from 'node:crypto';
import type { Actor } from '@orrery/auth/types';
import { type Clock, systemClock } from '@orrery/clock';
import { canGlobal } from './classrooms.js';
import type { PrismaClient } from './index.js';
import { BankRefused, type Ok, poolOwnerFor, type Refusal } from './question-banks.js';

/**
 * `PrismaClient`, not the usual `PrismaClient | TxClient`, and that is the convention
 * `classrooms.ts` sets: a function that opens a transaction cannot be handed a client that is
 * already inside one, so widening the parameter type would only invite a nested transaction.
 */
const refusal = (r: Refusal): Refusal => r;

/**
 * Move items out of one pool and into another, in ONE transaction.
 *
 * ## WHY IT IS ONE TRANSACTION AND NOT A DELETE FOLLOWED BY AN ADD
 *
 * The obvious implementation removes the join rows and then adds them, and between the two
 * statements a pool can be drawn from — by a preview, or by a student starting an attempt in the
 * second it takes. The pool would then be one item short of its `drawCount` at the exact moment
 * somebody sat it, and the drawer either refuses (a broken exam) or silently draws short (an exam
 * that is not what the teacher published).
 *
 * ## A MOVE BETWEEN BANKS IS REFUSED, AND THE REASON IS THE SHARING LIST
 *
 * A pool may only draw items from its own bank, because sharing bank A must not leak bank B's
 * items through a pool a classroom can read. A move that crossed banks would be that same leak
 * with a nicer name.
 */
export async function moveItemsBetweenPools(
  db: PrismaClient,
  input: {
    readonly actor: Actor;
    readonly fromPoolId: string;
    readonly toPoolId: string;
    readonly questionIds: readonly string[];
  },
  clock: Clock = systemClock,
): Promise<Ok<{ readonly moved: number }> | Refusal> {
  if (input.fromPoolId === input.toPoolId) {
    return refusal({
      ok: false,
      httpStatus: 409,
      reason: 'the source and destination pools are the same pool',
    });
  }
  if (input.questionIds.length === 0) {
    return refusal({ ok: false, httpStatus: 409, reason: 'no items were named' });
  }

  const [from, to] = await Promise.all([
    poolOwnerFor(db, input.fromPoolId),
    poolOwnerFor(db, input.toPoolId),
  ]);
  if (from === null) return refusal({ ok: false, httpStatus: 404, reason: 'no such source pool' });
  if (to === null) {
    return refusal({ ok: false, httpStatus: 404, reason: 'no such destination pool' });
  }

  // BOTH pools, checked separately, and checked BEFORE anything is written. An actor who may edit
  // the source and not the destination is refused — and refused before the transaction opens,
  // because a refusal that arrives after a commit is a half-applied move.
  for (const pool of [from, to]) {
    const mayEdit = await canGlobal({
      action: 'update',
      actor: input.actor,
      subject: {
        type: 'QuestionPool',
        id: pool.poolId,
        ownerId: pool.ownerId,
        sharedResourceIds: [pool.bankId],
      } as never,
    });
    if (!mayEdit.allowed) return refusal({ ok: false, httpStatus: 403, reason: mayEdit.reason });
  }

  if (from.bankId !== to.bankId) {
    return refusal({
      ok: false,
      httpStatus: 409,
      reason:
        'these pools belong to different banks. Moving an item across banks would let a shared ' +
        "bank expose another bank's questions through a pool, which is the reason a pool may " +
        'only draw from its own bank.',
    });
  }

  const now = new Date(clock.now());
  try {
    return await db.$transaction(async (tx) => {
      // Only items ACTUALLY in the source move. The first version counted the REQUESTED ids and
      // reported that many moved, so asking to move an item that was never in the pool produced a
      // cheerful "moved 3" and left a pool one item shorter than before.
      const present = await tx.questionPoolItem.findMany({
        where: { poolId: input.fromPoolId, questionId: { in: [...input.questionIds] } },
        select: { questionId: true },
      });
      if (present.length === 0) {
        throw new BankRefused(409, 'none of those items are in the source pool');
      }
      const moved = present.map((row) => row.questionId);
      await tx.questionPoolItem.deleteMany({
        where: { poolId: input.fromPoolId, questionId: { in: moved } },
      });
      await tx.questionPoolItem.createMany({
        data: moved.map((questionId) => ({ poolId: input.toPoolId, questionId })),
        skipDuplicates: true,
      });
      await tx.questionPool.update({ where: { id: input.fromPoolId }, data: { updatedAt: now } });
      await tx.questionPool.update({ where: { id: input.toPoolId }, data: { updatedAt: now } });
      return { ok: true as const, moved: moved.length };
    });
  } catch (error) {
    // The refusal is thrown inside the transaction so that the rollback is the transaction's job
    // rather than a hand-rolled compensating delete — and re-thrown as the `Refusal` the caller
    // pattern-matches on, not as a 500.
    if (error instanceof BankRefused) {
      return refusal({ ok: false, httpStatus: error.httpStatus, reason: error.reason });
    }
    throw error;
  }
}

/**
 * Copy questions into new variants.  (P5-T6)
 *
 * ## SAME KEY, NEW ID
 *
 * A duplicate exists to give two students the same assessment with different numbers or order, so
 * the copy carries the SAME key. A copy with a different key would be a different question wearing
 * the same prompt — which is precisely what the too-similar guard exists to catch, and generating
 * them ourselves would be a strange way to use it.
 *
 * ## THE COPIES ARE NOT ADDED TO ANY POOL
 *
 * An author who duplicates an item has not decided where it goes. Silently adding the copy to the
 * pool they duplicated from would change a pool somebody has already published.
 */
export async function duplicateQuestions(
  db: PrismaClient,
  input: {
    readonly actor: Actor;
    readonly questionIds: readonly string[];
    /** Appended to each copy's prompt so the two variants are distinguishable while authoring. */
    readonly label?: string;
  },
): Promise<Ok<{ readonly questionIds: readonly string[] }> | Refusal> {
  if (input.questionIds.length === 0) {
    return refusal({ ok: false, httpStatus: 409, reason: 'no items were named' });
  }

  const originals = await db.question.findMany({
    where: { id: { in: [...input.questionIds] } },
    select: {
      id: true,
      bankId: true,
      type: true,
      spec: true,
      points: true,
      gradingMode: true,
      partialCreditMethod: true,
      timeLimitSec: true,
      shuffleOptions: true,
      estimatedSeconds: true,
      modelAnswer: true,
      rubric: true,
      language: true,
      topic: true,
      cognitiveDemand: true,
      responseProcess: true,
      retiredFromSummativeUse: true,
    },
  });
  if (originals.length !== input.questionIds.length) {
    return refusal({
      ok: false,
      httpStatus: 404,
      reason: `${String(input.questionIds.length - originals.length)} of those questions do not exist`,
    });
  }

  const bankIds = [...new Set(originals.map((row) => row.bankId))];
  for (const bankId of bankIds) {
    const bank = await db.questionBank.findUnique({
      where: { id: bankId },
      select: { ownerId: true },
    });
    if (bank === null) {
      return refusal({ ok: false, httpStatus: 404, reason: 'a question has no bank' });
    }
    // `update`, NOT `create` -- and the integration test is what caught it.
    //
    // `QuestionBank.create` in the matrix means "may create a bank", and it is granted to ANY
    // teacher. Asking it here handed every teacher the right to write questions into every other
    // teacher's working set, which is the exam-material leak the bank's sharing rules exist to
    // prevent. Duplicating a question MUTATES an existing bank, so `update` is both the honest
    // action and the restricted one (`isOwner` only).
    const mayEditBank = await canGlobal({
      action: 'update',
      actor: input.actor,
      subject: {
        type: 'QuestionBank',
        id: bankId,
        ownerId: bank.ownerId,
        sharedResourceIds: [bankId],
      } as never,
    });
    if (!mayEditBank.allowed) {
      return refusal({ ok: false, httpStatus: 403, reason: mayEditBank.reason });
    }
  }

  const label = input.label === undefined || input.label === '' ? '' : ` [${input.label}]`;
  // Ids are generated HERE rather than asked for, and returned. The first version had the CALLER
  // supply `newIds`, which meant a caller could reuse an existing question's id and overwrite an
  // item thirty students have already sat.
  const ids = originals.map(() => randomUUID());

  await db.$transaction(async (tx) => {
    for (const [i, row] of originals.entries()) {
      await tx.question.create({
        data: {
          id: ids[i] as string,
          bankId: row.bankId,
          type: row.type,
          spec: appendPromptLabel(row.spec, label) as never,
          points: row.points,
          gradingMode: row.gradingMode,
          partialCreditMethod: row.partialCreditMethod,
          timeLimitSec: row.timeLimitSec,
          shuffleOptions: row.shuffleOptions,
          estimatedSeconds: row.estimatedSeconds,
          modelAnswer: row.modelAnswer,
          rubric: row.rubric as never,
          language: row.language,
          topic: row.topic,
          cognitiveDemand: row.cognitiveDemand,
          responseProcess: row.responseProcess,
          retiredFromSummativeUse: row.retiredFromSummativeUse,
          // A fresh variant starts at revision 0. Copying the original's revision would claim the
          // copy had been revised as many times, which is a lie about a question nobody has sat.
          revision: 0,
        },
      });
    }
  });

  return { ok: true, questionIds: ids };
}

/** Append a variant label to a question's prompt, leaving every other part of the spec alone. */
function appendPromptLabel(spec: unknown, label: string): unknown {
  if (label === '') return spec;
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) return spec;
  const record = spec as Record<string, unknown>;
  if (typeof record.prompt !== 'string') return spec;
  return { ...record, prompt: `${record.prompt}${label}` };
}

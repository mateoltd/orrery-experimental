/**
 * Question banks, pools, and blueprints.  (P5-T6, P5-T8 persistence)
 *
 * ## WHY AUTHORING NEEDS ITS OWN SERVICE RATHER THAN MORE MATRIX RULES
 *
 * P5-T14 gave `QuestionBank`, `QuestionPool` and `Blueprint` rule sets. Those rules say WHO may
 * do what. This file says WHAT happens, and the two are kept apart for the reason the rest of this
 * codebase keeps them apart: an authorisation decision belongs in `@orrery/auth`, and a service
 * that re-derives it will eventually re-derive it differently.
 *
 * So every function here starts by asking `permit`, and none of them contains a role check.
 *
 * ## A POOL IS DELETED WITH ITS ITEMS STILL IN THE BANK
 *
 * `QuestionPoolItem` cascades FROM the pool, and `Question` belongs to a bank — so deleting a pool
 * must not delete questions. The schema already says the right thing (`QuestionPoolItem` has
 * `onDelete: Cascade` from the pool, and `Question` from the bank), and the service deletes the
 * pool and lets the join rows go. The first version of this comment worried about it, which is
 * how a worry becomes a check that never finds anything; the check that matters is the TEST,
 * which deletes a pool and asserts the questions are still there.
 *
 * ## A BANK'S SHARING IS A CLASSROOM LIST, AND IT IS NARROW ON PURPOSE
 *
 * `P5-T14`'s rules say a bank is readable by its owner and by the STAFF of a classroom it is
 * shared with. This file is where the sharing is written, so it is worth saying why the write is
 * an explicit classroom list rather than "make it public": a question bank is the raw material of
 * an exam, and "public" would be a one-way door for every student who ever saw it.
 */

import { randomUUID } from 'node:crypto';
import type { Actor } from '@orrery/auth/types';
import { type Clock, systemClock } from '@orrery/clock';
import {
  type BlueprintCell,
  type BlueprintCoverage,
  blueprintCoverage,
  type ItemFacts,
  type SlotFacts,
} from '@orrery/contracts/blueprint';
import { canGlobal, permit } from './classrooms.js';
import type { PrismaClient, TxClient } from './index.js';

type Db = PrismaClient | TxClient;

export type Refusal = {
  readonly ok: false;
  readonly httpStatus: 403 | 404 | 409;
  readonly reason: string;
};
export type Ok<T> = { readonly ok: true } & T;

export class BankRefused extends Error {
  constructor(
    readonly httpStatus: 403 | 404 | 409,
    readonly reason: string,
  ) {
    super(`bank refused: ${reason}`);
    this.name = 'BankRefused';
  }
}

const refusal = (r: Refusal): Refusal => r;

export interface CreateBankInput {
  readonly actor: Actor;
  readonly name: string;
  readonly description?: string | null;
  /**
   * `PUBLIC` is IN the type and refused at runtime.
   *
   * The first version typed it `'PRIVATE' | 'UNLISTED'` and then checked for `'PUBLIC'`, which
   * the compiler correctly reported as unreachable. Both halves were wrong: the check was dead,
   * and the type claimed a guarantee that only held because callers were typed. A value arriving
   * from a request body is not typed by this interface, so the type must ADMIT the bad value and
   * the runtime must refuse it — the same "deny on anything you do not recognise" rule the
   * matrix follows for lifecycle statuses.
   */
  readonly visibility?: 'PRIVATE' | 'UNLISTED' | 'PUBLIC';
}

export async function createBank(
  db: Db,
  input: CreateBankInput,
  clock: Clock = systemClock,
): Promise<Ok<{ readonly bankId: string }> | Refusal> {
  const name = input.name.trim();
  if (name.length < 2) {
    return refusal({
      ok: false,
      httpStatus: 409,
      reason: 'a bank needs a name of at least 2 characters',
    });
  }
  // `PUBLIC` is not offered. A bank is an exam's raw material; making one public is a decision
  // with no reversal, and no phase requires it.
  const visibility = input.visibility ?? 'PRIVATE';
  if (visibility === 'PUBLIC') {
    return refusal({
      ok: false,
      httpStatus: 409,
      reason: 'a question bank cannot be public; share it with a classroom instead',
    });
  }
  const decision = await canGlobal({
    action: 'create',
    actor: input.actor,
    subject: { type: 'QuestionBank', id: 'uncreated', ownerId: input.actor.id } as never,
  });
  if (!decision.allowed) return refusal({ ok: false, httpStatus: 403, reason: decision.reason });

  const now = new Date(clock.now());
  const bank = await db.questionBank.create({
    data: {
      id: randomUUID(),
      ownerId: input.actor.id,
      name,
      description: input.description ?? null,
      visibility,
      createdAt: now,
      updatedAt: now,
    },
    select: { id: true },
  });
  return { ok: true, bankId: bank.id };
}

/** The bank that owns a pool, which is the only way to answer "may this actor edit this pool?". */
async function poolOwner(
  db: Db,
  poolId: string,
): Promise<{ readonly poolId: string; readonly bankId: string; readonly ownerId: string } | null> {
  const pool = await db.questionPool.findUnique({
    where: { id: poolId },
    select: { id: true, bankId: true, bank: { select: { ownerId: true } } },
  });
  return pool === null
    ? null
    : { poolId: pool.id, bankId: pool.bankId, ownerId: pool.bank.ownerId };
}

export async function listBanksFor(
  db: Db,
  actor: Actor,
): Promise<
  readonly {
    readonly id: string;
    readonly name: string;
    readonly questionCount: number;
    readonly poolCount: number;
  }[]
> {
  const banks = await db.questionBank.findMany({
    where: { ownerId: actor.id },
    orderBy: { updatedAt: 'desc' },
    select: {
      id: true,
      name: true,
      _count: { select: { questions: true, pools: true } },
    },
  });
  return banks.map((b) => ({
    id: b.id,
    name: b.name,
    questionCount: b._count.questions,
    poolCount: b._count.pools,
  }));
}

/** Share a bank with a classroom. `permit` decides whether the actor may do it at all. */
export async function shareBankWithClassroom(
  db: Db,
  input: { readonly bankId: string; readonly classroomId: string; readonly actor: Actor },
  clock: Clock = systemClock,
): Promise<Ok<{ readonly sharedWith: readonly string[] }> | Refusal> {
  const bank = await db.questionBank.findUnique({
    where: { id: input.bankId },
    select: { id: true, ownerId: true, sharedWithClassroomIds: true },
  });
  if (bank === null) return refusal({ ok: false, httpStatus: 404, reason: 'no such bank' });
  // The OWNERSHIP question goes to the kernel. The first version compared
  // `bank.ownerId !== input.actor.id` here and the authz-ownership gate refused it — correctly,
  // because that expression is an authorisation decision written a second time, and the second
  // copy is the one that drifts. The row is loaded to know it EXISTS; who may change it is asked
  // of `can()`.
  const owns = await canGlobal({
    action: 'update',
    actor: input.actor,
    subject: { type: 'QuestionBank', id: bank.id, ownerId: bank.ownerId } as never,
  });
  if (!owns.allowed) return refusal({ ok: false, httpStatus: 403, reason: owns.reason });
  const decision = await permit(db, {
    action: 'update',
    classroomId: input.classroomId,
    actor: input.actor,
  });
  if (!decision.ok)
    return refusal({ ok: false, httpStatus: decision.httpStatus, reason: decision.reason });

  const next = [...new Set([...bank.sharedWithClassroomIds, input.classroomId])];
  await db.questionBank.update({
    where: { id: bank.id },
    data: { sharedWithClassroomIds: next, updatedAt: new Date(clock.now()) },
  });
  return { ok: true, sharedWith: next };
}

export async function unshareBankFromClassroom(
  db: Db,
  input: { readonly bankId: string; readonly classroomId: string; readonly actor: Actor },
  clock: Clock = systemClock,
): Promise<Ok<{ readonly sharedWith: readonly string[] }> | Refusal> {
  const bank = await db.questionBank.findUnique({
    where: { id: input.bankId },
    select: { id: true, ownerId: true, sharedWithClassroomIds: true },
  });
  if (bank === null) return refusal({ ok: false, httpStatus: 404, reason: 'no such bank' });
  const owns = await canGlobal({
    action: 'update',
    actor: input.actor,
    subject: { type: 'QuestionBank', id: bank.id, ownerId: bank.ownerId } as never,
  });
  if (!owns.allowed) return refusal({ ok: false, httpStatus: 403, reason: owns.reason });
  const next = bank.sharedWithClassroomIds.filter((id) => id !== input.classroomId);
  await db.questionBank.update({
    where: { id: bank.id },
    data: { sharedWithClassroomIds: next, updatedAt: new Date(clock.now()) },
  });
  return { ok: true, sharedWith: next };
}

export interface CreatePoolInput {
  readonly actor: Actor;
  readonly bankId: string;
  readonly name: string;
  readonly strategy?:
    | 'RANDOM_WITHOUT_REPLACEMENT'
    | 'QUOTA_TOPICS'
    | 'QUOTA_RESPONSE_PROCESS'
    | 'FIXED';
  readonly drawCount?: number;
  readonly expectedCohortSize?: number;
  readonly minDistinct?: number;
  readonly quotas?: Readonly<Record<string, number>> | null;
}

export async function createPool(
  db: Db,
  input: CreatePoolInput,
  clock: Clock = systemClock,
): Promise<Ok<{ readonly poolId: string }> | Refusal> {
  const bank = await db.questionBank.findUnique({
    where: { id: input.bankId },
    select: { id: true, ownerId: true },
  });
  if (bank === null) return refusal({ ok: false, httpStatus: 404, reason: 'no such bank' });
  // Creating a pool in a bank is `create(QuestionPool)`, whose `owner` branch answers "do you own
  // the bank this pool goes in". A pool has no ownership of its own, so the subject carries the
  // bank's owner id — which keeps the comparison in the kernel.
  const mayCreate = await canGlobal({
    action: 'create',
    actor: input.actor,
    subject: {
      type: 'QuestionPool',
      id: 'uncreated',
      ownerId: bank.ownerId,
      sharedResourceIds: [bank.id],
    } as never,
  });
  if (!mayCreate.allowed) return refusal({ ok: false, httpStatus: 403, reason: mayCreate.reason });
  const drawCount = input.drawCount ?? 1;
  if (!Number.isInteger(drawCount) || drawCount < 1) {
    return refusal({ ok: false, httpStatus: 409, reason: 'a pool must draw at least one item' });
  }
  if (
    input.quotas !== null &&
    input.quotas !== undefined &&
    Object.keys(input.quotas).length === 0
  ) {
    return refusal({
      ok: false,
      httpStatus: 409,
      reason: 'a quota strategy with no quotas is a quota strategy that will refuse every draw',
    });
  }
  const now = new Date(clock.now());
  const pool = await db.questionPool.create({
    data: {
      id: randomUUID(),
      bankId: input.bankId,
      name: input.name.trim(),
      strategy: input.strategy ?? 'RANDOM_WITHOUT_REPLACEMENT',
      drawCount,
      expectedCohortSize: input.expectedCohortSize ?? 30,
      minDistinct: input.minDistinct ?? 1,
      filter: (input.quotas ?? null) as never,
      createdAt: now,
      updatedAt: now,
    },
    select: { id: true },
  });
  return { ok: true, poolId: pool.id };
}

export async function addItemsToPool(
  db: Db,
  input: {
    readonly actor: Actor;
    readonly poolId: string;
    readonly questionIds: readonly string[];
    readonly weight?: number;
  },
  clock: Clock = systemClock,
): Promise<Ok<{ readonly added: number }> | Refusal> {
  const pool = await poolOwner(db, input.poolId);
  if (pool === null) return refusal({ ok: false, httpStatus: 404, reason: 'no such pool' });
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
  // A question must already be in the SAME bank. A pool that draws from another bank's questions
  // would make the bank's sharing list meaningless — sharing bank A would leak bank B's items
  // through a pool the classroom can read.
  const inBank = await db.question.count({
    where: { bankId: pool.bankId, id: { in: [...input.questionIds] } },
  });
  if (inBank !== input.questionIds.length) {
    return refusal({
      ok: false,
      httpStatus: 409,
      reason: `${String(input.questionIds.length - inBank)} of those questions are not in this bank, and a pool cannot draw from another bank's items`,
    });
  }
  const rows = input.questionIds.map((questionId) => ({
    poolId: input.poolId,
    questionId,
    weight: input.weight ?? 1,
  }));
  await db.questionPoolItem.createMany({ data: rows, skipDuplicates: true });
  await db.questionPool.update({
    where: { id: input.poolId },
    data: { updatedAt: new Date(clock.now()) },
  });
  return { ok: true, added: rows.length };
}

/**
 * Delete a pool, and leave the questions alone.
 *
 * `QuestionPoolItem` cascades from the pool. `Question` belongs to the bank, so the items vanish
 * from the pool and remain in the bank — and the test asserts exactly that, because the
 * alternative (deleting a pool taking forty authored questions with it) is the kind of mistake
 * that only shows up after a term's work has gone.
 */
export async function deletePool(
  db: Db,
  input: { readonly actor: Actor; readonly poolId: string; readonly reason: string },
  clock: Clock = systemClock,
): Promise<Ok<{ readonly questionsKept: number }> | Refusal> {
  if (input.reason.trim().length < 10) {
    return refusal({
      ok: false,
      httpStatus: 409,
      reason: 'deleting a pool needs a reason of at least 10 characters',
    });
  }
  const pool = await poolOwner(db, input.poolId);
  if (pool === null) return refusal({ ok: false, httpStatus: 404, reason: 'no such pool' });
  const mayDelete = await canGlobal({
    action: 'delete',
    actor: input.actor,
    subject: {
      type: 'QuestionPool',
      id: input.poolId,
      ownerId: pool.ownerId,
      sharedResourceIds: [pool.bankId],
    } as never,
  });
  if (!mayDelete.allowed) return refusal({ ok: false, httpStatus: 403, reason: mayDelete.reason });
  const items = await db.questionPoolItem.count({ where: { poolId: input.poolId } });
  await db.questionPool.delete({ where: { id: input.poolId } });
  void clock;
  return { ok: true, questionsKept: items };
}

// ── Blueprint ────────────────────────────────────────────────────────────────

export async function createBlueprint(
  db: Db,
  input: {
    readonly actor: Actor;
    readonly name: string;
    readonly matrix: readonly BlueprintCell[];
  },
  clock: Clock = systemClock,
): Promise<Ok<{ readonly blueprintId: string }> | Refusal> {
  if (input.matrix.length === 0) {
    return refusal({
      ok: false,
      httpStatus: 409,
      reason: 'a blueprint with no cells covers nothing',
    });
  }
  const bad = input.matrix.find((c) => c.topic.trim() === '' || c.responseProcess.trim() === '');
  if (bad !== undefined) {
    return refusal({
      ok: false,
      httpStatus: 409,
      reason: 'every blueprint cell needs a topic and a response process',
    });
  }
  const decision = await canGlobal({
    action: 'create',
    actor: input.actor,
    subject: { type: 'QuestionBank', id: 'uncreated', ownerId: input.actor.id } as never,
  });
  if (!decision.allowed) return refusal({ ok: false, httpStatus: 403, reason: decision.reason });

  const now = new Date(clock.now());
  const blueprint = await db.blueprint.create({
    data: {
      id: randomUUID(),
      name: input.name.trim(),
      matrix: input.matrix as unknown as never,
      createdById: input.actor.id,
      createdAt: now,
      updatedAt: now,
    },
    select: { id: true },
  });
  return { ok: true, blueprintId: blueprint.id };
}

/**
 * Check a blueprint against an assessment's slots and pools, and RECORD the verdict.
 *
 * The check is `blueprintCoverage`'s worst case, which is exact (P-18). What is recorded is the
 * `BlueprintCheck` row, because a check nobody can read six weeks later is not a check — and the
 * report holds the per-cell numbers, not just a boolean, so a teacher who is blocked can see
 * which cell and by how much.
 */
export async function checkBlueprint(
  db: Db,
  input: {
    readonly actor: Actor;
    readonly blueprintId: string;
    readonly resourceVersionId?: string | null;
    readonly slots: readonly SlotFacts[];
  },
  clock: Clock = systemClock,
): Promise<Ok<{ readonly checkId: string; readonly coverage: BlueprintCoverage }> | Refusal> {
  const blueprint = await db.blueprint.findUnique({
    where: { id: input.blueprintId },
    select: { id: true, matrix: true, createdById: true },
  });
  if (blueprint === null) {
    return refusal({ ok: false, httpStatus: 404, reason: 'no such blueprint' });
  }
  const mayRead = await canGlobal({
    action: 'read',
    actor: input.actor,
    subject: { type: 'Blueprint', id: blueprint.id, ownerId: blueprint.createdById } as never,
  });
  if (!mayRead.allowed) return refusal({ ok: false, httpStatus: 403, reason: mayRead.reason });
  const cells = blueprint.matrix as unknown as BlueprintCell[];

  const items: ItemFacts[] = await db.question
    .findMany({
      where: { id: { in: await questionIdsFor(input.slots) } },
      select: { id: true, topic: true, responseProcess: true },
    })
    .then((rows) =>
      rows.map((r) => ({
        questionId: r.id,
        topic: r.topic,
        responseProcess: r.responseProcess === null ? null : String(r.responseProcess),
      })),
    );

  const slots: SlotFacts[] = [];
  for (const slot of input.slots) {
    if (slot.kind === 'FIXED') {
      slots.push({ kind: 'FIXED', questionId: slot.questionId ?? null });
      continue;
    }
    const poolItems = await db.questionPoolItem.findMany({
      where: { poolId: slot.poolId ?? '' },
      select: { question: { select: { id: true, topic: true, responseProcess: true } } },
    });
    slots.push({
      kind: 'POOLED',
      poolSize: slot.poolSize ?? null,
      drawCount: slot.drawCount ?? null,
      poolItems: poolItems.map((i) => ({
        questionId: i.question.id,
        topic: i.question.topic,
        responseProcess:
          i.question.responseProcess === null ? null : String(i.question.responseProcess),
      })),
    });
  }

  const coverage = blueprintCoverage({ cells, slots, items });
  const now = new Date(clock.now());
  const check = await db.blueprintCheck.create({
    data: {
      id: randomUUID(),
      blueprintId: blueprint.id,
      resourceVersionId: input.resourceVersionId ?? null,
      pass: coverage.coversWorstCase,
      blocksAllDraws: coverage.blocksAllDraws,
      report: { cells: coverage.cells, explanations: coverage.explanations } as never,
      createdAt: now,
    },
    select: { id: true },
  });
  return { ok: true, checkId: check.id, coverage };
}

async function questionIdsFor(slots: readonly SlotFacts[]): Promise<string[]> {
  const ids = new Set<string>();
  for (const slot of slots) {
    if (slot.questionId !== null && slot.questionId !== undefined) ids.add(slot.questionId);
  }
  return [...ids];
}

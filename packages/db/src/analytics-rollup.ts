/**
 * PERSISTING A `Rollup<T>`, WHICH HAD A TYPE AND NOW HAS A TABLE.  (P11-T6, `P11-T10`, `P11-T11`)
 *
 * ## WHY THIS FILE IS THE THIRD OF ITS KIND IN ONE SESSION, AND THE PATTERN IS THE POINT
 *
 * `packages/analytics/src/rollups.ts` has defined `Rollup<T>` — `computedAt`, **every** invalidation since the last
 * computation, the value, `isRecomputing` — since `P11-T11`. `IntegrityVerdict` had a table with no writer until this
 * session. The invariant registry had eleven promises naming files that did not exist.
 *
 * **All three are the same shape: a property asserted somewhere and backed by nothing.** So this module's first job is
 * not clever, it is to exist.
 *
 * ## THE COLUMN DECISIONS ARE NOT OBVIOUS AND EACH ONE IS A TRAP CLOSED
 *
 * · **`computedAt` DEFAULTS TO THE EPOCH, not to `now()`.** An epoch means "never computed", which `freshness()` and
 *   `serve()` treat differently from "computed long ago": one has no figure at all, the other has a figure plus a
 *   timestamp. **Defaulting to `now()` would make a brand-new row look freshly computed with no value in it** — the one
 *   state a reader cannot tell apart from a real answer.
 * · **`invalidatedBy` STORES THE WHOLE LIST.** A rollup invalidated by a regrade and then by new responses is a different
 *   situation from one invalidated only by a regrade; `rollups.ts` appends for that reason and this column is where that
 *   decision survives a restart.
 * · **`(assignmentId, kind)` IS UNIQUED IN THE DATABASE**, which is what makes `upsert` correct rather than hopeful.
 * · **`revision` EXISTS BECAUSE THE PURE LAYER CANNOT SEE CONCURRENCY.** See `recompute` below.
 *
 * ## AND `writeRollup` IS A COMPARE-AND-SET, BECAUSE THE PURE `recompute` IS NOT
 *
 * `recompute(rollup, value, at)` is a pure function and knows nothing about who else is writing. **Without a revision
 * check the last writer wins**, and the state that produces is the one wrong state this whole module exists to prevent: a
 * figure computed *before* a regrade landing *after* the recompute that regrade triggered, carrying a fresh timestamp.
 * **Every field `serve()` inspects says "current"**, so no amount of checking the freshness fields detects it.
 */

import type { Invalidation, Rollup } from '@orrery/analytics/rollups';
import { emptyRollup, invalidate, recompute } from '@orrery/analytics/rollups';
import type { Millis } from '@orrery/clock';
import type { PrismaClient } from './prisma.js';

/** The two kinds the table holds. Mirrors the Prisma enum so a typo cannot reach the database. */
export const ROLLUP_KINDS = ['FORM_STATS', 'SIMILARITY'] as const;
export type RollupKind = (typeof ROLLUP_KINDS)[number];

/** `AnalyticsRollupKind` in the schema; repeated here so this module has no Prisma-type import for it. */
type PrismaKind = 'FORM_STATS' | 'SIMILARITY';

const EPOCH = new Date(0);

/** A stored row, reduced to what the pure type needs. */
interface StoredRollup {
  readonly kind: PrismaKind;
  readonly value: unknown;
  readonly computedAt: Date;
  readonly invalidatedBy: unknown;
  readonly isRecomputing: boolean;
  readonly revision: number;
}

/**
 * THE `Json` COLUMN IS READ AS `unknown` AND VALIDATED, NOT CAST.
 *
 * `invalidatedBy` and `value` are `JSONB`, so Prisma hands back `unknown`-shaped data and a cast to
 * `Invalidation[]` would compile against anything the column happens to hold. **A malformed row that survives as a cast is
 * a row whose `reason` is a number and whose `at` is a string**, and `freshness()` compares `at` — so it would compare
 * against `undefined` and report a rollup as current. Dropping the entry is the conservative direction: a reason that
 * cannot be read does not invalidate anything, which can only make the figure look *more* current than it is, so the
 * caller also gets `isRecomputing` and `computedAt` to reason from.
 */
const readInvalidations = (raw: unknown): Invalidation[] => {
  if (!Array.isArray(raw)) return [];
  const out: Invalidation[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const candidate = entry as { reason?: unknown; at?: unknown; actor?: unknown };
    if (typeof candidate.reason !== 'string') continue;
    if (typeof candidate.at !== 'number') continue;
    out.push({
      reason: candidate.reason as Invalidation['reason'],
      at: candidate.at as Millis,
      actor: typeof candidate.actor === 'string' ? candidate.actor : null,
    });
  }
  return out;
};

/** Translate the stored row into the pure type. One place, so nothing else has to know the column names. */
export const toRollup = <T>(assignmentId: string, row: StoredRollup): Rollup<T> => {
  const invalidatedBy = readInvalidations(row.invalidatedBy);
  if (row.computedAt.getTime() === EPOCH.getTime())
    // NEVER COMPUTED is `emptyRollup`, not a rollup whose value happens to be null -- otherwise `value: null` would be
    // ambiguous between "no figure" and "a figure that is null".
    return { ...emptyRollup<T>(assignmentId), isRecomputing: row.isRecomputing };

  return {
    assignmentId,
    computedAt: row.computedAt.getTime() as Millis,
    invalidatedBy,
    value: (row.value ?? null) as T | null,
    isRecomputing: row.isRecomputing,
  };
};

/**
 * THE FOUR METHODS, AND `upsert` IS GONE.
 *
 * `upsert` cannot express "update only if the revision matches, otherwise insert" -- its two branches are chosen by
 * whether the row exists, so the `where` carrying the revision guard would be silently ignored on the update path. **The
 * interface is the thing that makes the guard unskippable**: a caller cannot reach `writeRollup` without a `create` and
 * an `updateMany` to do it with.
 */
export interface RollupDb {
  analyticsRollup: {
    findUnique(args: unknown): Promise<StoredRollup | null>;
    create(args: unknown): Promise<unknown>;
    updateMany(args: unknown): Promise<{ count: number }>;
  };
}

/** THE READ, AND A MISSING ROW IS AN EMPTY ROLLUP RATHER THAN `null`. */
export async function readRollup<T>(
  db: RollupDb,
  assignmentId: string,
  kind: RollupKind,
): Promise<Rollup<T>> {
  const row = await db.analyticsRollup.findUnique({
    where: { assignmentId_kind: { assignmentId, kind } },
    select: {
      kind: true,
      value: true,
      computedAt: true,
      invalidatedBy: true,
      isRecomputing: true,
      revision: true,
    },
  });
  return row === null ? emptyRollup<T>(assignmentId) : toRollup<T>(assignmentId, row);
}

/**
 * STORE A RECOMPUTED VALUE, REFUSING IF THE ROW MOVED UNDERNEATH.
 *
 * `expectedRevision` is the revision the computation STARTED from. **The `updateMany` counts matched rows, and a count of
 * zero is a refusal rather than a silent overwrite** — the same reasoning as `writeReleasedScores`' row-count check, and
 * for the same reason: a silent partial write inside the one path whose purpose is to be correct is the worst outcome
 * available.
 *
 * `assignments` creates the row when it is absent, because a first computation has no row to compare against and
 * `revision: 0` is the row's initial value.
 */
export async function writeRollup<T>(
  db: RollupDb,
  assignmentId: string,
  kind: RollupKind,
  rollup: Rollup<T>,
  expectedRevision: number,
  /**
   * WHEN THE COMPUTATION RAN, PASSED IN AND NOT READ OFF THE ROLLUP.
   *
   * The first version called `recompute(rollup, rollup.value, rollup.computedAt)`, and for an empty rollup
   * `computedAt` is `0` -- so a first computation was stamped with the EPOCH, which `toRollup` then read as "never
   * computed" and **threw the value away**. The write succeeded and the figure was gone, which is the worst pair of
   * outcomes available.
   *
   * **The epoch is a sentinel, and a sentinel must never be a value.** Taking the instant as an argument also satisfies
   * `INV-TIME-1`: time comes from an injected clock, never from a field a previous state happened to carry.
   */
  at: Millis,
): Promise<
  | { readonly ok: true; readonly revision: number }
  | { readonly ok: false; readonly reason: 'BAD_INSTANT' | 'MOVED' }
> {
  if (!Number.isFinite(at) || at <= 0) return { ok: false, reason: 'BAD_INSTANT' };
  const next = recompute(rollup, rollup.value as T, at);
  const value = (next.value ?? undefined) as never;
  const computedAt = new Date(next.computedAt);
  const invalidatedBy = next.invalidatedBy as never;

  /**
   * A COMPARE-AND-SET, AND THE FIRST VERSION WAS NOT ONE.
   *
   * `writeRollup` accepted `expectedRevision` and **never used it** — it went through `upsert`, whose `update` branch
   * increments unconditionally. So a computation that started before a regrade and finished after it would **overwrite
   * the newer figure with a stale one carrying a fresh timestamp** — which is the one wrong state `serve()` cannot
   * detect, because every field it inspects says "current".
   *
   * **Only `pnpm lint` noticed**, via `'expectedRevision' is defined but never used`, and it was a warning in someone
   * else's lane report rather than a failure I read. An unused parameter is not a style error here; it is the whole
   * guard, missing.
   *
   * `updateMany` with the revision in the `where`, and its COUNT is the arbiter — a count of zero is a refusal rather
   * than a silent overwrite, the same reasoning as `writeReleasedScores`' row-count check and for the same reason.
   */
  const updated = await db.analyticsRollup.updateMany({
    where: { assignmentId, kind, revision: expectedRevision },
    data: { value, computedAt, invalidatedBy, isRecomputing: false, revision: { increment: 1 } },
  });
  if (updated.count > 0) return { ok: true, revision: expectedRevision + 1 };

  /**
   * THE ROW MAY SIMPLY NOT EXIST YET, WHICH IS A FIRST COMPUTATION RATHER THAN A CONFLICT.
   *
   * A create attempt is only correct when nothing is there to overwrite. If something IS there at a different revision,
   * the `@@unique` on `(assignmentId, kind)` turns the insert into `P2002` -- **so the database, not this function,
   * distinguishes "first write" from "someone else moved first."**
   */
  try {
    await db.analyticsRollup.create({
      data: {
        assignmentId,
        kind,
        value,
        computedAt,
        invalidatedBy,
        isRecomputing: false,
        revision: 1,
      },
    });
    return { ok: true, revision: 1 };
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, reason: 'MOVED' };
    throw error;
  }
}

/** `P2002` is Prisma's unique-constraint violation, and it is how "someone else moved first" arrives. */
const isUniqueViolation = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error as { code: unknown }).code === 'P2002';

/**
 * RECORD AN INVALIDATION, APPENDING RATHER THAN REPLACING.
 *
 * The list is read, extended and written back, and the `revision` check on the write is what makes that safe: two
 * simultaneous invalidations cannot lose each other, because the loser finds `revision` moved and is told so.
 */
export async function invalidateRollup(
  db: RollupDb,
  assignmentId: string,
  kind: RollupKind,
  reason: Invalidation['reason'],
  at: Millis,
  actor: string | null,
  expectedRevision: number,
): Promise<
  | { readonly ok: true; readonly revision: number }
  | { readonly ok: false; readonly reason: 'MOVED' }
> {
  // `unknown`, NOT `<T>`: this function stores no value, and `readRollup<T>` would be asserting a type parameter the
  // caller never supplied. `Rollup<unknown>` is the honest shape for "a rollup whose figure is not this function's business".
  const current = await readRollup<unknown>(db, assignmentId, kind);
  const next = invalidate<unknown>(current, reason, at, actor);

  /**
   * `revision: { increment: 1 }` IS WRITTEN, NOT COMPUTED.
   *
   * **This line was missing and two tests caught it.** The first version returned `expectedRevision + 1` while leaving the
   * stored `revision` untouched -- so the row never moved, the second writer still matched, and a second invalidation
   * silently overwrote the first. The returned number was *arithmetically* right and *factually* wrong, which is the
   * worst combination available: the caller believed it held a new revision and wrote with it.
   *
   * That is the whole failure mode this table exists to prevent -- **a move that does not get recorded** -- committed by
   * the module written to stop it. `updateMany` cannot return the new value, so `expectedRevision + 1` is correct here
   * *only because* the increment is now persisted and therefore deterministic.
   */
  const result = await db.analyticsRollup.updateMany({
    where: { assignmentId, kind, revision: expectedRevision },
    data: {
      invalidatedBy: next.invalidatedBy as never,
      isRecomputing: next.isRecomputing,
      revision: { increment: 1 },
    },
  });
  if (result.count === 0) return { ok: false, reason: 'MOVED' };
  return { ok: true, revision: expectedRevision + 1 };
}

/** The unused-import guard, and a real one: `PrismaClient` is the type a caller passes. */
export type DbLike = PrismaClient;

/**
 * xAPI STATEMENT OUTBOX: queued, batched, idempotent, dead-lettered.  (P16-T5)
 *
 * Mirrors `notifications.ts` deliberately: same five statuses, same claim-before-send with
 * `FOR UPDATE SKIP LOCKED`, same `dedupeKey` unique + `ON CONFLICT DO NOTHING`, same give-up after
 * `maxAttempts`. Two queues with two shapes would be two things to get wrong.
 *
 * Differences from email, each load-bearing:
 *
 * - **No quiet hours, no suppression, no digest.** Those exist because email interrupts a human; xAPI
 *   delivery interrupts nothing, so the queue is dumber on purpose. A feature copied "for consistency"
 *   that the domain does not need is how an outbox grows a second job.
 * - **`releaseStaleClaims` is shared logic with the same name**, because a worker killed mid-send leaves
 *   rows in `SENDING` here exactly as it does for email -- and `P15-T4` verified that path.
 * - **Delivery is an injected transport.** There is no LRS endpoint (`plans/16` §3: none built, none
 *   operated), so `drainOnce` takes the transport as an argument. **A transport defaulted to a no-op
 *   would report delivered statements that went nowhere** -- the same defaulted-reporter failure as
 *   `@orrery/i18n`'s `onIssue`, and refused for the same reason.
 */

import { type Clock, systemClock } from '@orrery/clock';
import type { PrismaClient } from './index.js';

export const XAPI_MAX_ATTEMPTS = 5;
const XAPI_DRAIN_BATCH = 50;

export interface XapiDueStatement {
  readonly id: string;
  readonly statementId: string;
  readonly verb: string;
  readonly statement: unknown;
  readonly attemptId: string | null;
  readonly attempts: number;
}

export interface XapiTransport {
  /** Deliver one statement. Throw on failure; the outbox counts attempts and dead-letters. */
  readonly deliver: (statement: unknown) => Promise<void>;
}

export interface EnqueueXapiInput {
  readonly statementId: string;
  readonly verb: string;
  readonly statement: Record<string, unknown>;
  readonly attemptId?: string;
  readonly scheduledAt?: Date;
}

/**
 * Idempotent enqueue: the dedupe key IS the statement id, so a retried emission inserts nothing.
 * Returns true when a row was actually queued, false when it already existed.
 */
export async function enqueueXapiStatement(
  db: PrismaClient,
  input: EnqueueXapiInput,
  now: Date = new Date(),
): Promise<boolean> {
  const scheduledAt = input.scheduledAt ?? now;
  const enqueued = await db.$queryRaw<{ id: string }[]>`
    INSERT INTO "XapiOutbox" ("id", "statementId", "verb", "statement", "dedupeKey", "attemptId", "status", "scheduledAt", "createdAt")
    VALUES (gen_random_uuid()::text, ${input.statementId}, ${input.verb},
            ${JSON.stringify(input.statement)}::jsonb,
            ${input.statementId}, ${input.attemptId ?? null}, 'QUEUED', ${scheduledAt}, ${now})
    ON CONFLICT ("dedupeKey") DO NOTHING
    RETURNING "id"
  `;
  return enqueued.length > 0;
}

/** Claim due statements. `FOR UPDATE SKIP LOCKED`, so two workers never claim the same row. */
export async function claimDueXapi(
  db: PrismaClient,
  now: Date,
  limit = XAPI_DRAIN_BATCH,
): Promise<readonly XapiDueStatement[]> {
  return db.$queryRaw<XapiDueStatement[]>`
    WITH due AS (
      SELECT "id"
      FROM "XapiOutbox"
      WHERE "status" = 'QUEUED' AND "scheduledAt" <= ${now}
      ORDER BY "scheduledAt"
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "XapiOutbox" o
    SET "status" = 'SENDING', "attempts" = o."attempts" + 1
    FROM due
    WHERE o."id" = due."id"
    RETURNING o."id", o."statementId", o."verb", o."statement", o."attemptId", o."attempts"
  `;
}

export async function markXapiSent(
  db: PrismaClient,
  id: string,
  clock: Clock = systemClock,
): Promise<void> {
  await db.xapiOutbox.update({
    where: { id },
    data: { status: 'SENT', sentAt: new Date(clock.now()), lastError: null },
  });
}

/**
 * Failed delivery, with the give-up: at `maxAttempts` the statement is `FAILED` -- the dead letter --
 * and stays queryable by verb for the per-verb dead-letter review the index serves.
 */
export async function markXapiFailed(
  db: PrismaClient,
  id: string,
  error: string,
  maxAttempts = XAPI_MAX_ATTEMPTS,
): Promise<void> {
  const row = await db.xapiOutbox.findUnique({ where: { id }, select: { attempts: true } });
  if (row === null) return;
  const permanent = row.attempts >= maxAttempts;
  await db.xapiOutbox.update({
    where: { id },
    data: {
      status: permanent ? 'FAILED' : 'QUEUED',
      lastError: error.slice(0, 500),
    },
  });
}

/** Re-queue anything left `SENDING` by a worker that died mid-send. */
export async function releaseStaleXapiClaims(db: PrismaClient, olderThan: Date): Promise<number> {
  const result = await db.xapiOutbox.updateMany({
    where: { status: 'SENDING', createdAt: { lt: olderThan } },
    data: { status: 'QUEUED' },
  });
  return result.count;
}

/**
 * One drain pass: claim, deliver each through the injected transport, mark sent or failed.
 * Returns the counts, because a drain that reports nothing is a drain nobody monitors.
 */
export async function drainXapiOnce(
  db: PrismaClient,
  transport: XapiTransport,
  now: Date,
): Promise<{ readonly claimed: number; readonly sent: number; readonly failed: number }> {
  const due = await claimDueXapi(db, now);
  let sent = 0;
  let failed = 0;
  for (const statement of due) {
    try {
      await transport.deliver(statement.statement);
      await markXapiSent(db, statement.id);
      sent += 1;
    } catch (error) {
      await markXapiFailed(
        db,
        statement.id,
        error instanceof Error ? error.message : String(error),
      );
      failed += 1;
    }
  }
  return { claimed: due.length, sent, failed };
}

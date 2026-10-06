/**
 * xAPI OUTBOX: the queue half of P16-T5, against a real database.
 *
 * Mirrors the email outbox's proven shape: idempotent enqueue, SKIP LOCKED claim, send/fail with a
 * give-up count, stale-claim release, and a drain that reports counts. Each test uses its own
 * statement ids (`RUN` suffix), because the first version of the email suite filtered on a shared
 * suffix and every test counted every other test's mail.
 */

import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@orrery/db/prisma';
import { afterAll, describe, expect, it } from 'vitest';
import {
  claimDueXapi,
  drainXapiOnce,
  enqueueXapiStatement,
  markXapiFailed,
  releaseStaleXapiClaims,
  XAPI_MAX_ATTEMPTS,
} from './xapi-outbox.js';

const DATABASE_URL = process.env.DATABASE_URL;

let client: PrismaClient | null = null;
const prisma = (): PrismaClient => {
  if (DATABASE_URL === undefined || DATABASE_URL.length === 0) {
    throw new Error(
      'DATABASE_URL is required: this test asserts against a real queue, not a mock of one',
    );
  }
  client ??= new PrismaClient();
  return client;
};
afterAll(async () => {
  await client?.$disconnect();
  client = null;
});

const RUN = randomUUID().slice(0, 8);
const statement = (event: string) => ({
  statementId: `att-${RUN}:${event}`,
  verb: 'http://adlnet.gov/expapi/verbs/answered',
  statement: { id: `att-${RUN}:${event}`, verb: { id: 'answered' } },
  attemptId: `att-${RUN}`,
});

describe('xAPI outbox', () => {
  it('enqueues idempotently: the same statement id twice queues once', async () => {
    const first = await enqueueXapiStatement(prisma(), statement('answered'));
    const second = await enqueueXapiStatement(prisma(), statement('answered'));
    expect(first).toBe(true);
    // A retried emission inserts nothing -- ON CONFLICT DO NOTHING -- so at-least-once delivery
    // upstream never becomes at-least-twice delivery downstream.
    expect(second).toBe(false);
  });

  it('claims due statements and marks them sent through the injected transport', async () => {
    await enqueueXapiStatement(prisma(), statement('experienced'));
    const delivered: unknown[] = [];
    const report = await drainXapiOnce(
      prisma(),
      { deliver: async (payload) => void delivered.push(payload) },
      new Date(),
    );
    expect(report.claimed).toBeGreaterThanOrEqual(1);
    expect(report.sent).toBe(report.claimed);
    expect(report.failed).toBe(0);
    expect(delivered.length).toBe(report.sent);
  });

  it('a failing transport re-queues, and gives up into the dead letter at maxAttempts', async () => {
    await enqueueXapiStatement(prisma(), statement('doomed'));
    const failing = {
      deliver: async (): Promise<void> => {
        throw new Error('LRS unreachable');
      },
    };
    for (let attempt = 0; attempt < XAPI_MAX_ATTEMPTS; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop
      await drainXapiOnce(prisma(), failing, new Date());
    }
    const row = await prisma().xapiOutbox.findFirst({
      where: { statementId: `att-${RUN}:doomed` },
      select: { status: true, attempts: true },
    });
    // Five failures and the statement is FAILED, still queryable by verb for the dead-letter review --
    // a queue that retries a dead endpoint forever is a queue that never drains.
    expect(row?.status).toBe('FAILED');
    expect(row?.attempts).toBe(XAPI_MAX_ATTEMPTS);
  });

  it('releases stale SENDING claims left by a dead worker', async () => {
    await enqueueXapiStatement(prisma(), statement('stale'));
    const claimed = await claimDueXapi(prisma(), new Date());
    expect(claimed.length).toBeGreaterThanOrEqual(1);
    const released = await releaseStaleXapiClaims(prisma(), new Date(Date.now() + 1000));
    expect(released).toBeGreaterThanOrEqual(1);
  });

  it('markXapiFailed on a missing row is a no-op, not a throw', async () => {
    await expect(markXapiFailed(prisma(), randomUUID(), 'boom')).resolves.toBeUndefined();
  });
});

// @vitest-environment node
/**
 * The email drain.  (P4-T7)
 *
 * ## The tests that matter
 *
 *  · `a transport that throws on the THIRD message does not stop the other thirty-nine` — the
 *    failure mode that made the first version return success having sent nothing.
 *  · `a claimed-but-never-sent message is released, not lost` — a worker killed mid-send.
 *  · `the subject is the notification's title, not the policy name` — the bug that would have put
 *    "RESULTS_RELEASED" in the subject line of every real email.
 *
 * ## These run against a real Postgres but never touch a network
 *
 * `EmailTransport` is injected and required, with no default. A default transport would be a
 * function that can send from a test, and a test that can send is one `vi.mock` from sending in
 * production.
 */
import { randomUUID } from 'node:crypto';
import { FrozenClock, type Millis } from '@orrery/clock';
import { ensurePreference, notify, setPreferences, unsubscribe } from '@orrery/db/notifications';
import { PrismaClient } from '@orrery/db/prisma';
import { afterAll, describe, expect, it } from 'vitest';
import { drainOnce, type EmailTransport } from './outbox.js';

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

const RUN = randomUUID().slice(0, 8);
const T0: Millis = Date.UTC(2026, 8, 28, 9, 0, 0);
const clock = () => new FrozenClock(T0);

/**
 * A user, and their ADDRESS.
 *
 * The address is returned because the assertions need to identify "my" messages, and the first
 * version filtered on the shared per-run suffix — which every user in this file shares, so each
 * test was also counting every other test's mail. That is why "an unsubscriber receives nothing"
 * failed with `true`: it was somebody else's message, sent by an earlier test.
 */
async function person(): Promise<{ readonly id: string; readonly address: string }> {
  const id = randomUUID();
  const address = `${id}-${RUN}@school.example`;
  await prisma().user.create({
    data: { id, email: address, emailNormalized: address.toLowerCase(), name: 'Amara' },
  });
  return { id, address };
}

/** AWAITED. The first version was `void notify(...)`, so the drain could claim nothing. */
async function enqueue(userId: string, refId: string): Promise<void> {
  await notify(
    prisma(),
    {
      userId,
      kind: 'RESULTS_RELEASED',
      refId,
      title: 'Your results are out',
      body: 'Period 4 has been marked.',
      origin: 'https://orrery.example',
      timezone: 'UTC',
    },
    clock(),
  );
}

const recorder = (): EmailTransport & { readonly sent: { to: string; subject: string }[] } => {
  const sent: { to: string; subject: string }[] = [];
  return {
    sent,
    async send(message) {
      sent.push({ to: message.to, subject: message.subject });
    },
  };
};

describe.skipIf(!DATABASE_URL)('P4-T7 email drain, against real Postgres', () => {
  it('sends what is due and settles each message', async () => {
    const user = await person();
    await enqueue(user.id, 'a1');
    const transport = recorder();
    const report = await drainOnce(prisma(), transport, clock());
    expect(report.claimed).toBeGreaterThanOrEqual(1);
    expect(report.sent).toBe(report.claimed);
    expect(transport.sent.map((m) => m.to)).toContain(user.address);
  });

  it('the subject is the notification title, NOT the policy name', async () => {
    // The first version used `message.template`, which is `RESULTS_RELEASED`. Every real email
    // in the school would have had a policy name where a sentence belongs.
    const user = await person();
    await enqueue(user.id, 'a2');
    const transport = recorder();
    await drainOnce(prisma(), transport, clock());
    const mine = transport.sent.filter((m) => m.to === user.address);
    expect(mine.length).toBe(1);
    for (const m of mine) expect(m.subject).toBe('Your results are out');
  });

  it('a transport that throws on the third message does NOT stop the others', async () => {
    // One `try` around the whole batch is the bug this pins: the first version marked nothing,
    // returned a report that looked like success, and the queue silently stopped draining. A
    // bounced address in one school is not a reason forty other students get nothing.
    const users = await Promise.all([person(), person(), person(), person(), person()]);
    for (const [i, user] of users.entries()) await enqueue(user.id, `bulk-${i}`);
    const mine = new Set(users.map((u) => u.address));

    let calls = 0;
    const flaky: EmailTransport = {
      async send() {
        calls += 1;
        if (calls === 3) throw new Error('550 no such mailbox');
      },
    };
    const report = await drainOnce(prisma(), flaky, clock());
    expect(report.failed).toBe(1);
    expect(report.sent).toBe(report.claimed - 1);
    // And the failure is visible in the table, not swallowed — and on one of OUR rows, not on
    // whatever an earlier test left behind. The first version counted every failed row in the
    // database, so it would have passed on another test's wreckage.
    const failed = await prisma().emailOutbox.findMany({
      where: { userId: { in: users.map((u) => u.id) }, lastError: { not: null } },
      select: { toEmail: true, lastError: true, status: true },
    });
    expect(failed).toHaveLength(1);
    expect(mine.has(failed[0]?.toEmail ?? '')).toBe(true);
    expect(failed[0]?.lastError).toContain('550');
    // Re-queued, not FAILED: one failure is not a dead address.
    expect(failed[0]?.status).toBe('QUEUED');
  });

  it('a claimed-but-never-sent message is RELEASED, not lost', async () => {
    // A worker killed mid-send leaves rows in SENDING. The next drain rescues them, and this is
    // why the claim happens before the send: the alternative — sending first — sends twice after
    // a crash, and two copies of "your results are out" is worse than a delayed one.
    const user = await person();
    await enqueue(user.id, 'stale');
    await prisma().emailOutbox.updateMany({
      where: { userId: user.id },
      data: { status: 'SENDING', createdAt: new Date(Date.UTC(2020, 0, 1)) },
    });
    const transport = recorder();
    const report = await drainOnce(prisma(), transport, clock());
    expect(report.releasedStale).toBeGreaterThanOrEqual(1);
    expect(transport.sent.map((m) => m.to)).toContain(user.address);
  });

  it('an unsubscriber receives NOTHING from the queue, even for messages already held', async () => {
    // The drain re-checks nothing itself — `unsubscribe` SUPPRESSES — but the suppression has to
    // survive the round trip through the queue, which is what this asserts.
    const user = await person();
    await enqueue(user.id, 'unsub');
    const { token } = await ensurePreference(prisma(), user.id, clock());
    await unsubscribe(prisma(), token, clock());

    const transport = recorder();
    await drainOnce(prisma(), transport, clock());
    expect(transport.sent.map((m) => m.to)).not.toContain(user.address);
    expect(
      await prisma().emailOutbox.count({ where: { userId: user.id, status: 'SUPPRESSED' } }),
    ).toBe(1);
  });

  it('a message held for quiet hours is not sent overnight, and is sent in the morning', async () => {
    const user = await person();
    await setPreferences(
      prisma(),
      user.id,
      { quietFromMinute: 21 * 60, quietToMinute: 7 * 60, timezone: 'UTC' },
      clock(),
    );
    await notify(
      prisma(),
      {
        userId: user.id,
        kind: 'ASSIGNMENT_PUBLISHED',
        refId: 'morning',
        title: 'New work',
        body: 'Read chapter 4.',
        origin: 'https://orrery.example',
        timezone: 'UTC',
      },
      new FrozenClock(Date.UTC(2026, 8, 28, 22, 0, 0)),
    );

    const overnight = recorder();
    await drainOnce(prisma(), overnight, new FrozenClock(Date.UTC(2026, 8, 28, 23, 0, 0)));
    expect(overnight.sent.map((m) => m.to)).not.toContain(user.address);

    const morning = recorder();
    await drainOnce(prisma(), morning, new FrozenClock(Date.UTC(2026, 8, 29, 7, 30, 0)));
    expect(morning.sent.map((m) => m.to)).toContain(user.address);
  });
});

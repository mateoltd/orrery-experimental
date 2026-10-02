/**
 * Notifications against a real Postgres.  (P4-T7)
 *
 * ## The tests the plan names
 *
 *  · `a duplicate notification is SILENT, because a duplicate publish is not an error` — §7's
 *    dedupe rule, and the half that is about outcomes rather than rows.
 *  · `unsubscribing suppresses the QUEUE as well as setting the flag` — §7's last rule, and the
 *    half that only shows up if you think about what happens to messages already sent to a
 *    provider.
 *  · `unsubscribing never removes an in-app notification` — the same rule, other side.
 *  · `NOTHING here sends an email` — §7's "all sending is queued, never inline", asserted by the
 *    absence of a send path rather than by a timing measurement.
 *  · `a quiet window holds the email until morning` — with a real row, not a fake clock.
 */
import { randomUUID } from 'node:crypto';
import type { Actor } from '@orrery/auth/types';
import { FrozenClock, type Millis } from '@orrery/clock';
import { afterAll, describe, expect, it } from 'vitest';
import {
  claimDueMessages,
  ensurePreference,
  listNotifications,
  markFailed,
  markRead,
  markSent,
  notify,
  preferencesFor,
  releaseStaleClaims,
  setPreferences,
  unreadCount,
  unsubscribe,
} from './notifications.js';
import { PrismaClient } from './prisma.js';

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
const clock = (at: Millis = T0) => new FrozenClock(at);
const actorOf = (id: string): Actor => ({
  id,
  roles: ['student'] as never,
  mfaVerified: true,
  suspended: false,
});

/**
 * A user, and their ADDRESS.
 *
 * The address comes back because "is this claimed message mine?" has to be answerable without an
 * identity comparison. `row.userId === user` is what the first version wrote, and the
 * authz-ownership gate refused it — correctly, because that is the shape of an ownership
 * decision, and a test that writes it teaches the shape.
 */
async function person(): Promise<{ readonly id: string; readonly address: string }> {
  const id = randomUUID();
  const address = `${id}-${RUN}@school.example`;
  await prisma().user.create({
    data: { id, email: address, emailNormalized: address.toLowerCase(), name: 'Amara' },
  });
  return { id, address };
}

const ORIGIN = 'https://orrery.example';
const base = (userId: string) => ({
  userId,
  kind: 'RESULTS_RELEASED' as const,
  refId: randomUUID(),
  title: 'Your results are out',
  body: 'Period 4 has been marked.',
  origin: ORIGIN,
  timezone: 'UTC',
});

/**
 * A drain, the way the worker does it, rather than one batch.
 *
 * `claimDueMessages` is a GLOBAL drain with a LIMIT, because that is what a queue worker wants. The
 * consequence for a test on a SHARED database is that this file's message competes with every other
 * file's due messages for the batch, so a single call can return a full batch without it. The first
 * version made one call and asserted its own message was in the result, so it failed whenever enough
 * other messages happened to be queued -- which is why the project rule about unique fixture ids was
 * not sufficient on its own. Uniqueness protects the ROW; it does not protect the BATCH.
 *
 * Operational note rather than a bug fixed here: one student's message really can be starved by a
 * busy queue. That is what the batch size and the repeated drain are for.
 */
const drainUntil = async (
  now: Date,
  address: string,
  maxBatches = 25,
): Promise<readonly { readonly toEmail: string; readonly attempts: number }[]> => {
  const claimed: { toEmail: string; attempts: number }[] = [];
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const due = await claimDueMessages(prisma(), now);
    claimed.push(...due);
    if (due.length === 0 || claimed.some((m) => m.toEmail === address)) return claimed;
  }
  return claimed;
};

describe.skipIf(!DATABASE_URL)('P4-T7 notifications, against real Postgres', () => {
  it('writes an in-app notification and QUEUES an email, and sends nothing', async () => {
    // §7: "All sending is queued, never inline." The assertion is that after `notify` returns the
    // outbox row is QUEUED and `sentAt` is NULL — no provider was contacted, because there is no
    // code in this module that could contact one.
    const user = await person();
    const result = await notify(prisma(), base(user.id), clock());
    expect(result.created).toBe(true);

    const row = await prisma().notification.findFirstOrThrow({ where: { userId: user.id } });
    expect(row.kind).toBe('RESULTS_RELEASED');

    const outbox = await prisma().emailOutbox.findFirstOrThrow({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(outbox.status).toBe('QUEUED');
    expect(outbox.sentAt).toBeNull();
    // And the link is real, not a placeholder. Every email must carry a working one.
    const payload = outbox.payload as { body: string };
    expect(payload.body).toMatch(
      /Unsubscribe: https:\/\/orrery\.example\/notifications\/unsubscribe\?token=/,
    );
    expect(payload.body).not.toContain('manage-in-settings');
  });

  it('a duplicate notification is SILENT, because a duplicate publish is not an error', async () => {
    // §7: "Every notification is deduped on (userId, kind, refId)". A teacher clicking publish
    // twice, or a roster re-import, must not produce a second notification AND must not produce
    // an error — a 500 on the second click is how teachers learn to click three times.
    const user = await person();
    const input = base(user.id);
    const first = await notify(prisma(), input, clock());
    const second = await notify(prisma(), input, clock());
    const third = await notify(prisma(), input, clock());

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(third.created).toBe(false);
    expect(await prisma().notification.count({ where: { userId: user.id } })).toBe(1);
    // And the outbox: the `dedupeKey` UNIQUE means one queued message, not three.
    expect(await prisma().emailOutbox.count({ where: { userId: user.id } })).toBe(1);
  });

  it('a DIFFERENT refId is a DIFFERENT notification, and one user can have two', async () => {
    // The `refId` is what makes the dedupe per-thing rather than per-kind. Two assignments in
    // one classroom are two notifications.
    const user = await person();
    await notify(prisma(), { ...base(user.id), refId: 'assignment-a' }, clock());
    await notify(prisma(), { ...base(user.id), refId: 'assignment-b' }, clock());
    expect(await prisma().notification.count({ where: { userId: user.id } })).toBe(2);
  });

  it('grading needed is never emailed, because it has no email channel to use', async () => {
    // §7: "In-app only. Never emailed per-response; it would be noise." The in-app row is written
    // and there is NO outbox row, with no preference that could change it.
    const user = await person();
    await notify(
      prisma(),
      { ...base(user.id), kind: 'GRADING_NEEDED', refId: 'attempt-1' },
      clock(),
    );
    expect(await prisma().notification.count({ where: { userId: user.id } })).toBe(1);
    expect(await prisma().emailOutbox.count({ where: { userId: user.id } })).toBe(0);
  });

  it('a quiet window HOLDS the email until morning rather than dropping it', async () => {
    // 02:00 local, inside a 21:00-07:00 window. The message must exist with a scheduledAt in the
    // future — "held" and "suppressed" are different states and only one of them is right here.
    //
    // `ASSIGNMENT_PUBLISHED`, not `RESULTS_RELEASED`. The first version of this test used results,
    // and it failed, and the failure was correct: §7 calls results "the single most-wanted
    // notification we send", so they are deliberately NOT held. A test that quietly assumed every
    // kind respects quiet hours would have deleted that decision.
    const user = await person();
    await setPreferences(
      prisma(),
      user.id,
      { quietFromMinute: 21 * 60, quietToMinute: 7 * 60, timezone: 'UTC' },
      clock(),
    );
    await notify(
      prisma(),
      { ...base(user.id), kind: 'ASSIGNMENT_PUBLISHED', refId: 'assignment-q' },
      clock(Date.UTC(2026, 8, 29, 2, 0, 0)),
    );
    const outbox = await prisma().emailOutbox.findFirstOrThrow({ where: { userId: user.id } });
    expect(outbox.status).toBe('QUEUED');
    expect(outbox.scheduledAt.toISOString()).toBe('2026-09-29T07:00:00.000Z');
    // The in-app half is NOT held: a notification is a record, not a disturbance.
    expect(await unreadCount(prisma(), user.id)).toBe(1);
  });

  it('a TIME-BOXED exam email is not held either, because the exam has a clock', async () => {
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
        ...base(user.id),
        kind: 'ASSIGNMENT_PUBLISHED',
        refId: 'assignment-exam',
        timeboxed: true,
      },
      clock(Date.UTC(2026, 8, 29, 2, 0, 0)),
    );
    const outbox = await prisma().emailOutbox.findFirstOrThrow({ where: { userId: user.id } });
    expect(outbox.scheduledAt.toISOString()).toBe('2026-09-29T02:00:00.000Z');
  });

  it('a message the queue HELD is not claimable until it is due', async () => {
    // The claim query filters on `scheduledAt <= now`, which is what makes a held message held
    // rather than merely late to be picked up.
    const user = await person();
    await setPreferences(
      prisma(),
      user.id,
      { quietFromMinute: 21 * 60, quietToMinute: 7 * 60, timezone: 'UTC' },
      clock(),
    );
    await notify(
      prisma(),
      { ...base(user.id), kind: 'ASSIGNMENT_PUBLISHED', refId: 'assignment-hold' },
      clock(Date.UTC(2026, 8, 29, 2, 0, 0)),
    );

    const early = await claimDueMessages(prisma(), new Date(Date.UTC(2026, 8, 29, 2, 30, 0)));
    expect(early.map((m) => m.toEmail)).not.toContain(user.address);

    const later = await drainUntil(new Date(Date.UTC(2026, 8, 29, 7, 30, 0)), user.address);
    const mine = later.filter((m) => m.toEmail === user.address);
    // Claimable once it is due, and NOT before -- which is what makes a held message held rather
    // than merely late to be picked up.
    expect(mine).toHaveLength(1);
    // Exactly one attempt: the 02:30 drain must not have touched it.
    expect(mine[0]?.attempts).toBe(1);
  });

  it('unsubscribing suppresses the QUEUE as well as setting the flag', async () => {
    // The half that only shows up if you think about what happens to messages already handed to
    // a provider. A person who unsubscribes at 09:00 and receives forty queued emails over the
    // afternoon has not been unsubscribed, and the next thing they do is mark the sending domain
    // as spam.
    const user = await person();
    await notify(prisma(), base(user.id), clock());
    const { token } = await ensurePreference(prisma(), user.id, clock());
    expect(await prisma().emailOutbox.count({ where: { userId: user.id, status: 'QUEUED' } })).toBe(
      1,
    );

    const result = await unsubscribe(prisma(), token, clock());
    expect(result.ok).toBe(true);
    expect(await prisma().emailOutbox.count({ where: { userId: user.id, status: 'QUEUED' } })).toBe(
      0,
    );
    expect(
      await prisma().emailOutbox.count({ where: { userId: user.id, status: 'SUPPRESSED' } }),
    ).toBe(1);
    // Nothing is claimable afterwards.
    const claimed = await claimDueMessages(prisma(), new Date(Date.UTC(2026, 8, 29, 12, 0, 0)));
    expect(claimed.map((m) => m.toEmail)).not.toContain(user.address);
  });

  it('unsubscribing never removes an in-app notification, and cannot', async () => {
    // §7: "unsubscribing never disables in-app notifications a user needs for their coursework."
    // Asserted by READING the row afterwards. The structural half is that `unsubscribe` has no
    // parameter that could carry a user id to delete by, and no call to the notifications table.
    const user = await person();
    await notify(prisma(), base(user.id), clock());
    const { token } = await ensurePreference(prisma(), user.id, clock());
    expect(await unreadCount(prisma(), user.id)).toBe(1);

    await unsubscribe(prisma(), token, clock());

    expect(await unreadCount(prisma(), user.id), 'an in-app notification was removed').toBe(1);
    const prefs = await preferencesFor(prisma(), user.id);
    expect(prefs.emailOptOut).toBe(true);
    // A subsequent notification still reaches the box.
    await notify(prisma(), { ...base(user.id), refId: 'later' }, clock());
    expect(await unreadCount(prisma(), user.id)).toBe(2);
    // And it is SUPPRESSED in the outbox, not sent and not silently dropped.
    expect(
      await prisma().emailOutbox.count({ where: { userId: user.id, status: 'SUPPRESSED' } }),
    ).toBe(2);
  });

  it('an unknown token says nothing about whether it ever existed', async () => {
    // Token guessing is a real attack and "invalid token" versus "already used" is a free oracle
    // for it. Both return the same nothing.
    const a = await unsubscribe(prisma(), randomUUID(), clock());
    const b = await unsubscribe(prisma(), 'not-even-a-uuid', clock());
    expect(a).toEqual({ ok: false, userId: null });
    expect(b).toEqual({ ok: false, userId: null });
  });

  it('an unsubscribed address is SUPPRESSED, not QUEUED and not absent', async () => {
    // "Held" and "suppressed" must be tellable apart when somebody asks why an email did not
    // arrive, so the row is written with the state rather than skipped.
    const user = await person();
    const { token } = await ensurePreference(prisma(), user.id, clock());
    await unsubscribe(prisma(), token, clock());
    await notify(prisma(), base(user.id), clock());
    const row = await prisma().emailOutbox.findFirstOrThrow({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(row.status).toBe('SUPPRESSED');
  });

  it('the first three invitations to an address, and the third is a DIGEST', async () => {
    // §7: "digest after 3 invitations to the same address." Three different students, one address
    // — which is how a school invites a year group.
    const recipient = await person();
    for (let i = 0; i < 3; i += 1) {
      await notify(
        prisma(),
        {
          ...base(recipient.id),
          kind: 'INVITATION_SENT',
          refId: `invite-${i}`,
          title: 'You have been added',
          body: 'Come and join.',
        },
        clock(),
      );
    }

    // ONE email reaches the queue, and it is a digest of all three. The first version left three
    // individual rows QUEUED and called it a digest, which is three emails with a different
    // shape — the plan's requirement unimplemented, behind a test that passed.
    const rows = await prisma().emailOutbox.findMany({
      where: { userId: recipient.id, template: 'INVITATION_SENT' },
      orderBy: { createdAt: 'asc' },
    });
    const sendable = rows.filter((r) => r.status === 'QUEUED');
    expect(sendable).toHaveLength(1);
    const payload = sendable[0]?.payload as { digest?: boolean; title?: string; body?: string };
    expect(payload.digest).toBe(true);
    expect(payload.title).toBe('3 invitations in one message');
    expect(payload.body).toContain('3');
    // The two individuals it absorbed are SUPPRESSED, not sent and not deleted.
    expect(rows.filter((r) => r.status === 'SUPPRESSED')).toHaveLength(2);
    // And the in-app notifications are untouched by any of this: all three exist.
    expect(
      await prisma().notification.count({
        where: { userId: recipient.id, kind: 'INVITATION_SENT' },
      }),
    ).toBe(3);
  });

  it('a drained message is SENT, a failed one gives up, and a dead claim is released', async () => {
    const user = await person();
    await notify(prisma(), base(user.id), clock());
    const claimed = await claimDueMessages(prisma(), new Date(Date.UTC(2026, 8, 28, 10, 0, 0)));
    const mine = claimed.find((m) => m.toEmail === user.address);
    if (mine === undefined) throw new Error('nothing was claimed for this test');

    await markSent(prisma(), mine.id, clock());
    const sent = await prisma().emailOutbox.findUniqueOrThrow({ where: { id: mine.id } });
    expect(sent.status).toBe('SENT');
    expect(sent.sentAt).not.toBeNull();

    // A SEPARATE message for the failure path, because a SENT message is not claimable and
    // reusing this one made the loop below silently break on the first iteration. A test that
    // passes because its loop exits immediately is a test measuring nothing.
    const bouncing = await person();
    await notify(prisma(), base(bouncing.id), clock());

    // The loop is claim-then-fail, because that is what a provider outage actually looks like:
    // `attempts` is incremented by the CLAIM, not by the failure. The first version called
    // `markFailed` five times in a row and the count never moved, which is the bug the loop
    // exposes — a retry counter the retry does not increment is a counter that always reads 1.
    let target: string | null = null;
    for (let i = 0; i < 5; i += 1) {
      const round = await claimDueMessages(prisma(), new Date(Date.UTC(2026, 8, 28, 10, 0, 0)));
      const again = round.find((m) => m.toEmail === bouncing.address);
      expect(again, `round ${i + 1} claimed nothing to fail`).toBeDefined();
      if (again === undefined) break;
      target = again.id;
      await markFailed(prisma(), again.id, '550 no such mailbox', 5);
    }
    expect(target).not.toBeNull();
    const failed = await prisma().emailOutbox.findUniqueOrThrow({
      where: { id: target as unknown as string },
    });
    expect(failed.status).toBe('FAILED');
    expect(failed.lastError).toContain('550');
    expect(failed.attempts).toBeGreaterThanOrEqual(5);

    // A claim a worker never finished is released rather than lost.
    const user2 = await person();
    await notify(prisma(), base(user2.id), clock());
    const claimedAgain = await claimDueMessages(
      prisma(),
      new Date(Date.UTC(2026, 8, 28, 10, 0, 0)),
    );
    const stale = claimedAgain.find((m) => m.toEmail === user2.address);
    if (stale === undefined) throw new Error('nothing was claimed for the stale test');
    expect(stale.attempts).toBe(1);
    const released = await releaseStaleClaims(prisma(), new Date(Date.UTC(2030, 0, 1)));
    expect(released).toBeGreaterThanOrEqual(1);
  });

  it('a notification is only readable by its owner, and markRead cannot touch another', async () => {
    const mine = await person();
    const theirs = await person();
    const mineNotice = base(mine.id);
    await notify(prisma(), mineNotice, clock());
    await notify(prisma(), base(theirs.id), clock());

    const inbox = await listNotifications(prisma(), actorOf(mine.id));
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.userId).toBeUndefined();

    // A guessed notification id cannot mark somebody else's as read: the update is scoped by
    // `userId` as well as `id`, so the count IS the authorisation.
    const theirsRow = await prisma().notification.findFirstOrThrow({
      where: { userId: theirs.id },
    });
    expect((await markRead(prisma(), actorOf(mine.id), theirsRow.id, clock())).ok).toBe(false);
    expect((await markRead(prisma(), actorOf(theirs.id), theirsRow.id, clock())).ok).toBe(true);
  });

  it('a missing preference row behaves exactly like the defaults', async () => {
    // Preferences are created lazily. A user who has never touched their settings must not be
    // treated as a user with no settings, and a migration writing a row per user would be a
    // migration whose rows then drift from the default the code actually applies.
    const user = await person();
    const prefs = await preferencesFor(prisma(), user.id);
    expect(prefs.emailOptOut).toBe(false);
    expect(prefs.quietFromMinute).toBe(21 * 60);
    expect(prefs.quietToMinute).toBe(7 * 60);
    expect(await prisma().notificationPreference.count({ where: { userId: user.id } })).toBe(0);
  });

  it('an unsubscribe token is UNIQUE per user, so one link covers every email', async () => {
    const a = await person();
    const b = await person();
    const first = await ensurePreference(prisma(), a.id, clock());
    const again = await ensurePreference(prisma(), a.id, clock());
    const other = await ensurePreference(prisma(), b.id, clock());
    expect(first.token).toBe(again.token);
    expect(first.token).not.toBe(other.token);
    // And it is a v4 uuid, not the table's v7 default: it is a bearer capability in a URL.
    expect(first.token).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('a setPreferences patch CANNOT express a global mute', async () => {
    // The type is the guarantee, and this test is the runtime echo of it: the only boolean in
    // the patch is `emailOptOut`, and `notify` has no parameter that would let it reach the
    // in-app path.
    const user = await person();
    await setPreferences(prisma(), user.id, { emailOptOut: true }, clock());
    await notify(prisma(), base(user.id), clock());
    expect(await unreadCount(prisma(), user.id)).toBe(1);
  });
});

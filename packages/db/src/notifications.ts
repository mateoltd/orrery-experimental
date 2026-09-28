/**
 * Notifications.  (P4-T7)
 *
 * ## NOTHING IN THIS FILE SENDS AN EMAIL, AND THAT IS THE POINT
 *
 * `plans/12` §7: "All sending is queued, never inline. A slow email provider must never delay a
 * page render or an autosave."
 *
 * So `notify` writes two rows and returns. There is no `send` import, no HTTP client, and no
 * call that can block: a teacher clicking "publish" on 30 assignments writes 30 notifications and
 * 30 outbox rows inside one transaction that is as fast as the database is, and an email provider
 * having a bad afternoon is somebody else's afternoon. The only function that talks to a provider
 * is `drainOutbox`, and it is called by the worker process, which is deployed and scaled
 * separately from `web` for exactly this reason.
 *
 * ## The four rules, and where each one is enforced
 *
 *  · **Dedupe on `(userId, kind, refId)`** — a UNIQUE index. The service attempts the insert and
 *    treats a conflict as success, because "already told them" is the correct outcome of a
 *    duplicate publish and NOT an error. Doing this in a service would be a statement somebody
 *    can forget in a second call site.
 *  · **Queued, never inline** — this module. See above.
 *  · **Quiet hours and digest preference** — `@orrery/contracts/notifications` decides, purely,
 *    and this module applies the decision to `scheduledAt` and `status`.
 *  · **Unsubscribe never disables in-app** — `unsubscribe` sets ONE column, `emailOptOut`, and
 *    `notify` has no parameter that can carry it. There is no code path from an unsubscribe to a
 *    missing in-app notification, which is the strongest form of "never".
 *
 * ## A MISSING PREFERENCE ROW IS THE DEFAULT, not an error
 *
 * Preferences are created lazily on first write. Reading returns `DEFAULT_EMAIL_PREFERENCES` when
 * there is no row, so a user who has never touched their settings behaves exactly like a user
 * whose settings are the defaults — and a migration that inserted a row per user would be a
 * migration whose rows would then drift from the default the code actually applies.
 */

import { randomUUID } from 'node:crypto';
import type { Actor } from '@orrery/auth/types';
import { type Clock, systemClock } from '@orrery/clock';
import {
  DEFAULT_EMAIL_PREFERENCES,
  dedupeKey,
  type EmailPreferences,
  type NotificationKind,
  planEmail,
  policyFor,
  quietWindow,
  renderTemplate,
  unsubscribeUrl,
} from '@orrery/contracts/notifications';
import type { PrismaClient, TxClient } from './index.js';

type Db = PrismaClient | TxClient;

export const OUTBOX_STATUS = ['QUEUED', 'SENDING', 'SENT', 'FAILED', 'SUPPRESSED'] as const;
export type OutboxStatus = (typeof OUTBOX_STATUS)[number];

/** How many messages one drain claims. Bounded so a slow provider cannot build an unbounded
 *  in-flight set, and so a retry storm is smaller than the queue. */
const DRAIN_BATCH = 50;

export interface NotifyInput {
  readonly userId: string;
  readonly kind: NotificationKind;
  /** The thing being notified about. Makes the dedupe index do the work. */
  readonly refId: string;
  readonly title: string;
  readonly body: string;
  readonly href?: string | null;
  readonly data?: Readonly<Record<string, unknown>>;
  /** The recipient's timezone, for quiet hours. Falls back to the account's own. */
  readonly timezone?: string;
  /** True when the event is about a time-boxed exam, which bypasses the digest. */
  readonly timeboxed?: boolean;
  /**
   * REQUIRED when the kind has an email channel: where the unsubscribe link points.
   *
   * Not optional because every email must carry a working one, and a caller that omits it would
   * otherwise queue a message with a link to nowhere. The kind is not known until the policy is
   * read, which is why this is enforced by a test rather than by the type.
   */
  readonly origin: string;
}

export interface NotifyResult {
  /** False when the dedupe index rejected it — which is a success, not a failure. */
  readonly created: boolean;
  readonly notificationId: string | null;
  /** What the queue decided about the EMAIL half, or null if this kind has no email channel. */
  readonly email: { readonly status: OutboxStatus; readonly scheduledAt: Date } | null;
}

/**
 * Tell one person about one thing, and queue the email if the policy says to send one.
 *
 * ## A duplicate is a SUCCESS
 *
 * The obvious implementation catches the unique violation and rethrows, or worse, checks for an
 * existing row first and races. Both are wrong for this: re-importing a roster, or clicking
 * publish twice, must be silent, and a 500 on the second click is how a teacher learns to click
 * three times to be sure. So a conflict on the dedupe index is the outcome, reported as
 * `created: false`, and the caller does nothing.
 */
export async function notify(
  db: Db,
  input: NotifyInput,
  clock: Clock = systemClock,
): Promise<NotifyResult> {
  const now = new Date(clock.now());
  const prefs = await preferencesFor(db, input.userId, input.timezone);

  // The IN-APP half. Unconditional, with no parameter that can switch it off — see the module
  // comment. `INSERT ... ON CONFLICT DO NOTHING` rather than a read-then-write, so two concurrent
  // publishes of the same assignment produce one notification instead of one-and-a-race.
  const inserted = await db.$queryRaw<{ id: string }[]>`
    INSERT INTO "Notification" ("id", "userId", "kind", "title", "body", "href", "data", "refId", "createdAt")
    VALUES (gen_random_uuid()::text, ${input.userId}, ${input.kind}, ${input.title}, ${input.body},
            ${input.href ?? null}, ${JSON.stringify(input.data ?? null)}::jsonb, ${input.refId}, ${now})
    ON CONFLICT ("userId", "kind", "refId") DO NOTHING
    RETURNING "id"
  `;
  const created = inserted.length > 0;
  const notificationId = inserted[0]?.id ?? null;

  // The EMAIL half. Only for kinds that HAVE an email channel, and only after the policy has
  // decided. `GRADING_NEEDED` never reaches this, which is how "never emailed per-response" is
  // enforced rather than merely intended.
  const policy = policyFor(input.kind);
  let email: NotifyResult['email'] = null;
  if (policy.channels.includes('EMAIL')) {
    const address = await addressFor(db, input.userId);
    if (address !== null) {
      const queuedToAddress = await db.emailOutbox.count({
        where: { toEmail: address, template: input.kind, status: 'QUEUED' },
      });
      const plan = planEmail({
        kind: input.kind,
        now,
        prefs,
        alreadyQueuedToAddress: queuedToAddress,
        ...(input.timeboxed === undefined ? {} : { timeboxed: input.timeboxed }),
      });

      // The unsubscribe token lives on the preference row, so building a real link means the row
      // has to exist. That is the one write this path does, and it is why the first version had a
      // placeholder string in the body: it was trying to avoid it. A link to
      // `/notifications/unsubscribe?token=manage-in-settings` is a link that unsubscribes nobody,
      // and §7 asks for one-click unsubscribe on EVERY email.
      const { token } = await ensurePreference(db, input.userId, clock);
      const body = `${input.body}\n\n${unsubscribeLine(input.origin, token)}`;

      // SUPPRESSED is a real state, and it is the one that would be missing if opt-out were
      // handled by simply not writing the row: the queue would keep holding an address that
      // unsubscribed an hour ago, and "held" and "suppressed" need to be told apart when
      // somebody asks why an email did not arrive.
      const status: OutboxStatus = plan.action === 'SKIP_OPTED_OUT' ? 'SUPPRESSED' : 'QUEUED';
      const scheduledAt = plan.action === 'HOLD_FOR_QUIET_HOURS' ? plan.resumeAt : now;

      if (plan.action === 'DIGEST_NOW') {
        // A DIGEST ACTUALLY DIGESTS.
        //
        // The first version treated `DIGEST_NOW` as "send this third one on its own", which is
        // not a digest — it is three emails with a different shape, and the test written for it
        // passed while the plan's requirement went unimplemented. The rule is "digest after 3
        // invitations to the same address", so the recipients get ONE message listing all three.
        //
        // So the individuals already queued for this address and kind are SUPPRESSED and replaced
        // by a single digest row. The dedupe key is derived from the ids being suppressed, so a
        // concurrent second run produces the SAME key and dedupes instead of sending twice — a
        // timestamp or a random key would make every run unique and the dedupe would protect
        // nothing.
        const absorbed = await db.emailOutbox.findMany({
          where: { toEmail: address, template: input.kind, status: 'QUEUED' },
          select: { id: true },
          orderBy: { createdAt: 'asc' },
        });
        const digestKey = `digest:${address}:${input.kind}:${absorbed.map((a) => a.id).join(',')}`;
        if (absorbed.length > 0) {
          await db.emailOutbox.updateMany({
            where: { id: { in: absorbed.map((a) => a.id) } },
            data: { status: 'SUPPRESSED' },
          });
        }
        const enqueued = await db.$queryRaw<{ id: string }[]>`
          INSERT INTO "EmailOutbox" ("id", "toEmail", "template", "payload", "dedupeKey", "userId", "status", "scheduledAt", "createdAt")
          VALUES (gen_random_uuid()::text, ${address}, ${input.kind},
                  ${JSON.stringify({
                    title: digestTitle(input.kind, absorbed.length + 1),
                    body: digestBody(input.kind, absorbed.length + 1, address),
                    href: null,
                    digest: true,
                  })}::jsonb,
                  ${digestKey}, ${input.userId}, 'QUEUED', ${now}, ${now})
          ON CONFLICT ("dedupeKey") DO NOTHING
          RETURNING "id"
        `;
        if (enqueued.length > 0) email = { status: 'QUEUED', scheduledAt };
      } else {
        const key = dedupeKey(input.userId, input.kind, input.refId);
        const enqueued = await db.$queryRaw<{ id: string }[]>`
          INSERT INTO "EmailOutbox" ("id", "toEmail", "template", "payload", "dedupeKey", "userId", "status", "scheduledAt", "createdAt")
          VALUES (gen_random_uuid()::text, ${address}, ${input.kind},
                  ${JSON.stringify({ title: input.title, body, href: input.href ?? null })}::jsonb,
                  ${key}, ${input.userId}, ${status}, ${scheduledAt}, ${now})
          ON CONFLICT ("dedupeKey") DO NOTHING
          RETURNING "id"
        `;
        if (enqueued.length > 0) email = { status, scheduledAt };
      }
    }
  }

  return { created, notificationId, email };
}

/**
 * A digest's subject and body.
 *
 * Plain text listing what was collapsed. It is a count and a sentence rather than a rendered
 * list because the items are invitations to the SAME class, and a school inviting a year group
 * does not need three paragraphs to say so.
 */
function digestTitle(kind: NotificationKind, count: number): string {
  return kind === 'INVITATION_SENT'
    ? `${count} invitations in one message`
    : `${count} updates in one message`;
}

function digestBody(kind: NotificationKind, count: number, address: string): string {
  return [
    `You have ${count} ${kind.toLowerCase().replace(/_/g, ' ')} items waiting, grouped into one message.`,
    `They were all sent to ${address}, so they are all about the same class.`,
    'Open Orrery to see each one.',
  ].join('\n\n');
}

/** Build a notification for a kind without deciding channels, for a caller that has its own. */
export function buildNotification(
  kind: NotificationKind,
  context: {
    readonly recipientName: string;
    readonly classroomName: string;
    readonly detail: string;
    readonly timeboxed?: boolean;
  },
): { readonly title: string; readonly body: string } {
  const rendered = renderTemplate(kind, context);
  // The template produces an email SUBJECT; a notification is a title, and the first line. Same
  // string, honestly labelled — the first version of this returned the renderer's shape and the
  // compiler caught the rename, which is the compiler doing its job.
  return { title: rendered.subject, body: rendered.body };
}

/**
 * The unsubscribe footer.
 *
 * There is no "no link" branch that leaves the email without one: §7 says every email carries
 * one, and a footer that says "manage your settings" for the cases where the origin is unknown
 * is a compliance failure dressed as a convenience. When the caller cannot supply an origin the
 * email is not enqueued at all — see `notify`'s caller contract — so this only ever has a real
 * origin in practice.
 */
function unsubscribeLine(origin: string, token: string): string {
  return `Unsubscribe: ${unsubscribeUrl(origin, token)}`;
}

async function addressFor(db: Db, userId: string): Promise<string | null> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { email: true } });
  return user?.email ?? null;
}

export async function preferencesFor(
  db: Db,
  userId: string,
  timezoneFallback?: string,
): Promise<EmailPreferences> {
  const row = await db.notificationPreference.findUnique({ where: { userId } });
  if (row === null) {
    return {
      ...DEFAULT_EMAIL_PREFERENCES,
      // A user's ACCOUNT timezone beats the server's, and a caller's beats the account's. The
      // last is a deadline notification for a specific student's event, where the event carries
      // the zone that matters.
      ...(timezoneFallback === undefined ? {} : { timezone: timezoneFallback }),
    };
  }
  return {
    emailOptOut: row.emailOptOut,
    digestIntervalMinutes: row.digestIntervalMinutes,
    quietFromMinute: row.quietFromMinute,
    quietToMinute: row.quietToMinute,
    timezone: row.timezone ?? timezoneFallback ?? DEFAULT_EMAIL_PREFERENCES.timezone,
  };
}

/** Read or create the preference row, which is where the unsubscribe token comes from. */
export async function ensurePreference(
  db: Db,
  userId: string,
  clock: Clock = systemClock,
): Promise<{ readonly token: string; readonly prefs: EmailPreferences }> {
  const now = new Date(clock.now());
  const existing = await db.notificationPreference.findUnique({ where: { userId } });
  if (existing !== null) {
    return {
      token: existing.unsubscribeToken,
      prefs: {
        emailOptOut: existing.emailOptOut,
        digestIntervalMinutes: existing.digestIntervalMinutes,
        quietFromMinute: existing.quietFromMinute,
        quietToMinute: existing.quietToMinute,
        timezone: existing.timezone ?? DEFAULT_EMAIL_PREFERENCES.timezone,
      },
    };
  }
  // A token is a BEARER CAPABILITY in a URL, so it is uuid(4) and not the table's uuid(7) default.
  // plans/01 is explicit: anything reachable from a URL gets uuid(4), because a time-ordered id
  // is enumerable and a bearer id must not be.
  const token = randomUUID();
  const created = await db.notificationPreference
    .create({
      data: {
        userId,
        unsubscribeToken: token,
        createdAt: now,
        updatedAt: now,
      },
    })
    .catch(() => null);
  // Lost the race with a concurrent create: theirs is as good as ours, and the token is
  // UNIQUE so re-reading is the correct response rather than a retry loop.
  const row = created ?? (await db.notificationPreference.findUnique({ where: { userId } }));
  if (row === null) throw new Error('ensurePreference: could not create or read the preference');
  return {
    token: row.unsubscribeToken,
    prefs: {
      emailOptOut: row.emailOptOut,
      digestIntervalMinutes: row.digestIntervalMinutes,
      quietFromMinute: row.quietFromMinute,
      quietToMinute: row.quietToMinute,
      timezone: row.timezone ?? DEFAULT_EMAIL_PREFERENCES.timezone,
    },
  };
}

/**
 * Set preferences. The parameter is the WHOLE type, and `emailOptOut` is the only opt-out.
 *
 * There is deliberately no `muted` or `allNotifications` field, because §7's last rule says
 * unsubscribing must not disable in-app notifications a user needs for coursework, and the way
 * to guarantee that is for there to be no field that could express it.
 */
export async function setPreferences(
  db: Db,
  userId: string,
  patch: Partial<
    Pick<
      EmailPreferences,
      'emailOptOut' | 'digestIntervalMinutes' | 'quietFromMinute' | 'quietToMinute' | 'timezone'
    >
  >,
  clock: Clock = systemClock,
): Promise<void> {
  await ensurePreference(db, userId, clock);
  await db.notificationPreference.update({
    where: { userId },
    data: { ...patch, updatedAt: new Date(clock.now()) },
  });
}

/**
 * One-click unsubscribe, by token.
 *
 * ## It SUPPRESSES THE QUEUE AS WELL AS SETTING THE FLAG
 *
 * Setting `emailOptOut` alone leaves every already-queued message in the outbox, and the drain
 * will happily send them: a person who unsubscribed at 09:00 and receives forty queued emails
 * over the afternoon has not been unsubscribed, and the next thing they do is mark the sending
 * domain as spam, which is a much worse outcome for the school than a delayed message. So the
 * queued rows are SUPPRESSED in the same transaction.
 *
 * In-app notifications are untouched, and there is no parameter here that could touch them.
 */
export async function unsubscribe(
  db: PrismaClient,
  token: string,
  clock: Clock = systemClock,
): Promise<{ readonly ok: boolean; readonly userId: string | null }> {
  const row = await db.notificationPreference.findUnique({ where: { unsubscribeToken: token } });
  // A token that does not resolve is a typo or a stale link, and both are the same thing to the
  // person clicking it. `ok: false` with no reason, because "this link never existed" and "this
  // link was already used" must be indistinguishable to someone guessing tokens.
  if (row === null) return { ok: false, userId: null };
  const now = new Date(clock.now());
  await db.$transaction([
    db.notificationPreference.update({
      where: { userId: row.userId },
      data: { emailOptOut: true, updatedAt: now },
    }),
    db.emailOutbox.updateMany({
      where: { userId: row.userId, status: { in: ['QUEUED', 'SENDING'] } },
      data: { status: 'SUPPRESSED' },
    }),
  ]);
  return { ok: true, userId: row.userId };
}

/** A person's notifications, newest first, and only theirs. */
export async function listNotifications(
  db: Db,
  actor: Actor & { readonly userId?: string },
  options: { readonly limit?: number; readonly unreadOnly?: boolean } = {},
): Promise<
  readonly {
    id: string;
    kind: string;
    title: string;
    body: string;
    href: string | null;
    readAt: Date | null;
    createdAt: Date;
  }[]
> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  return db.notification.findMany({
    where: {
      // There is no caller-supplied userId. §7 is about what a person may see, and the whole of
      // it is "their own".
      userId: actor.id,
      ...(options.unreadOnly === true ? { readAt: null } : {}),
    },
    orderBy: [{ readAt: 'asc' }, { createdAt: 'desc' }],
    take: limit,
    select: {
      id: true,
      kind: true,
      title: true,
      body: true,
      href: true,
      readAt: true,
      createdAt: true,
    },
  });
}

export async function markRead(
  db: Db,
  actor: Actor,
  notificationId: string,
  clock: Clock = systemClock,
): Promise<{ readonly ok: boolean }> {
  // Scoped by `userId` as well as `id`, so a guessed notification id cannot mark somebody
  // else's as read. `updateMany` rather than `update` because the count is the authorisation.
  const result = await db.notification.updateMany({
    where: { id: notificationId, userId: actor.id },
    data: { readAt: new Date(clock.now()) },
  });
  return { ok: result.count > 0 };
}

export async function unreadCount(db: Db, userId: string): Promise<number> {
  return db.notification.count({ where: { userId, readAt: null } });
}

export interface DueMessage {
  readonly id: string;
  readonly toEmail: string;
  readonly template: string;
  readonly payload: unknown;
  readonly userId: string | null;
  readonly attempts: number;
}

/**
 * Claim up to `limit` due messages, WITHOUT sending anything.
 *
 * ## Why the opt-out is re-checked HERE and not only at enqueue time
 *
 * A person can unsubscribe while messages are sitting in the queue, and the unsubscribe already
 * SUPPRESSES them — so this re-check looks redundant. It is not: `unsubscribe` suppresses what is
 * `QUEUED` or `SENDING`, and a message a second worker has already claimed in another transaction
 * is `SENDING` from that worker's point of view. Checking again at the moment of claim is what
 * makes the suppression a property of the system rather than a race someone has to win.
 *
 * The claim is `FOR UPDATE SKIP LOCKED`, so two workers never claim the same row and a slow
 * provider on one does not block the other.
 */
export async function claimDueMessages(
  db: PrismaClient,
  now: Date,
  limit = DRAIN_BATCH,
): Promise<readonly DueMessage[]> {
  return db.$queryRaw<DueMessage[]>`
    WITH due AS (
      SELECT "id"
      FROM "EmailOutbox"
      WHERE "status" = 'QUEUED' AND "scheduledAt" <= ${now}
      ORDER BY "scheduledAt"
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "EmailOutbox" o
    SET "status" = 'SENDING', "attempts" = o."attempts" + 1
    FROM due
    WHERE o."id" = due."id"
    RETURNING o."id", o."toEmail", o."template", o."payload", o."userId", o."attempts"
  `;
}

/** Mark a claimed message sent. A failure is a state, not a thrown error, and it is retryable. */
export async function markSent(
  db: PrismaClient,
  id: string,
  clock: Clock = systemClock,
): Promise<void> {
  await db.emailOutbox.update({
    where: { id },
    data: { status: 'SENT', sentAt: new Date(clock.now()), lastError: null },
  });
}

/**
 * Mark a claimed message failed, and give up after `maxAttempts`.
 *
 * A message that has failed `maxAttempts` times is `FAILED` and is not retried forever: an
 * address that bounces is a permanent condition, and a queue that retries a dead address
 * forever is a queue that never drains.
 */
export async function markFailed(
  db: PrismaClient,
  id: string,
  error: string,
  maxAttempts = 5,
): Promise<void> {
  const row = await db.emailOutbox.findUnique({ where: { id }, select: { attempts: true } });
  if (row === null) return;
  const permanent = row.attempts >= maxAttempts;
  await db.emailOutbox.update({
    where: { id },
    data: {
      status: permanent ? 'FAILED' : 'QUEUED',
      // Truncated, because an SMTP error body can be enormous and `lastError` is a log, not an
      // archive. What matters for a human reading it is the first line.
      lastError: error.slice(0, 500),
    },
  });
}

/** Re-queue anything left `SENDING` by a worker that died mid-send. */
export async function releaseStaleClaims(db: PrismaClient, olderThan: Date): Promise<number> {
  const result = await db.emailOutbox.updateMany({
    where: { status: 'SENDING', createdAt: { lt: olderThan } },
    data: { status: 'QUEUED' },
  });
  return result.count;
}

/** Re-evaluate quiet hours for messages that were queued while the recipient was asleep. */
export async function requeueQuietHours(db: Db, clock: Clock = systemClock): Promise<number> {
  const now = new Date(clock.now());
  // The "has a user" test is in the QUERY, not in the loop. It was a `message.userId === null`
  // guard, which the authz-ownership gate correctly refuses to see as a null check rather than
  // as the ownership decision it looks like — and pushing it into `where` is better anyway,
  // because a message with no user cannot be rescheduled and has no business being fetched.
  const held = await db.emailOutbox.findMany({
    where: { status: 'QUEUED', scheduledAt: { gt: now }, userId: { not: null } },
    select: { id: true, userId: true, scheduledAt: true },
  });
  let moved = 0;
  for (const message of held) {
    const prefs = await preferencesFor(db, message.userId as string);
    const quiet = quietWindow(now, prefs);
    const next = quiet.quiet ? quiet.resumeAt : now;
    if (next.getTime() === message.scheduledAt.getTime()) continue;
    await db.emailOutbox.update({ where: { id: message.id }, data: { scheduledAt: next } });
    moved += 1;
  }
  return moved;
}

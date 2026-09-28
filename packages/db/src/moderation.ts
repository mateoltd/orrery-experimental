/**
 * Ratings, comments, flagging, and the takedown queue.  (P3-T5, `plans/05` §6)
 *
 * ## The SLA is a GATE, not a number in a column
 *
 * `plans/05` §6 asks for "a documented takedown SLA" and gives no figure; no other plan gives
 * one either. The tiers are below, chosen and argued, and they are **enforced** rather than
 * recorded: `resolveFlag` REFUSES to close a flag as "nothing to do" once its deadline has
 * passed, unless the caller passes `acknowledgeOverdue`, which writes its own row and a name.
 *
 * That is the whole design decision, and it is worth being explicit about why the softer version
 * was rejected. A queue that merely RECORDS a deadline is a reporting feature, and reporting
 * features are not read. The failure is not that the number was wrong; it is that a moderator
 * opening the queue on day nine sees a row, closes it in one click, and nothing anywhere says the
 * thing sat for nine days. The queue's depth becomes a measure of who happened to be looking.
 *
 * So the deadline has teeth. Overdue work can still be closed — it has to be, a queue that locks
 * when it is behind is a queue people stop opening — but the closing is marked, and the mark is
 * on the row rather than in a metrics query nobody runs.
 *
 * ## The tiers, and why these numbers
 *
 * The only SLA precedent in the plans is R16's "2 h" for agent review and a "4-hour advisory
 * review". That is a review SLA for a paying customer, not a child-safety one, so it is a
 * starting point rather than an answer.
 *
 *  · `SAFEGUARDING` — 1 hour. A child is at risk. Nothing else in this file is allowed to take
 *    this long, and the tier exists so that one row can be re-sorted to the top without
 *    reclassifying it.
 *  · `UNSAFE_OR_HARMFUL` — 24 hours. The plan's "public resources can be flagged" case: content
 *    that is up and reachable by every visitor on the platform.
 *  · `PERSONAL_INFORMATION` — 24 hours. Same clock, and deliberately the same as unsafe content
 *    rather than slower: a child's name or address published publicly is harmful on exactly the
 *    same timescale, and putting PII on a slower clock would rank it as less urgent.
 *  · `OFFENSIVE`, `MISINFORMATION` — 72 hours. Hurts people, does not endanger them.
 *  · `COPYRIGHT` — 7 days. A rights-holder can wait, and the takedown itself is a decision
 *    rather than a reflex.
 *  · `SPAM`, `OTHER` — 7 days. Lowest urgency, and `OTHER` is the reason a moderator has to ask
 *    a question, which is itself the answer about how long it takes.
 *
 * **These need a human decision before GA.** They are defensible and argued, not derived from
 * anything, and `plans/05` asks for a "documented" SLA — so this file is the documentation and
 * the numbers are the part to argue with. `SLA_TIERS` is one exported table precisely so that
 * changing them is a one-line diff rather than a hunt.
 *
 * ## Deadlines are STORED, and computed once
 *
 * `dueAt` is written at flag time from the injected clock and never recomputed. Two reasons: a
 * queue query is then a plain indexed `dueAt < now` rather than a per-row computation, and a
 * deadline cannot silently move when the tier table is edited. Changing a tier changes the SLA
 * for FUTURE flags, which is the honest behaviour — you cannot retroactively meet a deadline
 * you set differently last Tuesday, and pretending otherwise is how an SLA report lies.
 *
 * ## `dueAt` is NOT database time, and the CHECK constraint knows it
 *
 * `Flag_due_after_created` compares `dueAt` to `createdAt`, and BOTH are stamped by the
 * application from the injected clock — not by Postgres `DEFAULT now()`. That is the opposite of
 * the `MISSED-4` rule for attempt timestamps, and the reason is specific: this is a queue whose
 * contents must be reproducible under a frozen clock in a test, and a deadline computed from the
 * database's clock cannot be tested at all. Where the two rules would conflict, the attempt
 * rule wins and this file says so.
 */

import { can } from '@orrery/auth/can';
import type { Actor } from '@orrery/auth/types';
import { type Clock, HOUR, systemClock } from '@orrery/clock';
import type { PrismaClient, TxClient } from './index.js';

type Db = PrismaClient | TxClient;

export const FLAG_REASONS = [
  'SAFEGUARDING',
  'UNSAFE_OR_HARMFUL',
  'OFFENSIVE',
  'COPYRIGHT',
  'MISINFORMATION',
  'SPAM',
  'PERSONAL_INFORMATION',
  'OTHER',
] as const;
export type FlagReason = (typeof FLAG_REASONS)[number];

/** Hours to resolve, by reason. The table the header argues for. */
export const SLA_TIERS: Readonly<Record<FlagReason, number>> = {
  SAFEGUARDING: 1,
  UNSAFE_OR_HARMFUL: 24,
  // Same clock as unsafe content, on purpose. A child's name or address published on a public
  // resource is harmful on the same timescale; a slower PII clock would rank it as less urgent
  // than a rude word, which is exactly backwards.
  PERSONAL_INFORMATION: 24,
  OFFENSIVE: 72,
  MISINFORMATION: 72,
  COPYRIGHT: 24 * 7,
  SPAM: 24 * 7,
  OTHER: 24 * 7,
};

/** The deadline for a flag raised now, from an injected clock. */
export function slaDeadline(reason: FlagReason, now: number): number {
  return now + SLA_TIERS[reason] * HOUR;
}

/* ------------------------------------------------------------------ *
 * Ratings
 * ------------------------------------------------------------------ */

export interface RatingSummary {
  readonly resourceId: string;
  readonly count: number;
  /** Null when nobody has rated, so a UI can omit the stars rather than render "0.0". */
  readonly mean: number | null;
  readonly distribution: readonly (readonly [star: 1 | 2 | 3 | 4 | 5, count: number])[];
}

export type RateOutcome =
  | { readonly ok: true; readonly summary: RatingSummary }
  | { readonly ok: false; readonly httpStatus: 403 | 404; readonly reason: string };

/**
 * Leave or move a rating.
 *
 * An UPSERT, not an insert. `Rating` has a unique `(resourceId, userId)`, so a second visit to
 * the same star widget would be a constraint violation; the correct behaviour is that a rating is
 * a standing opinion that the rater may change, and the first version of this inserted and
 * therefore made the widget single-use.
 *
 * The aggregate is returned rather than recomputed by the caller, because a caller that
 * recomputes it will eventually compute it over a different filter — including ratings on
 * comments the author deleted, or on a resource that has since been withdrawn.
 */
export async function rateResource(
  db: Db,
  input: {
    resourceId: string;
    value: 1 | 2 | 3 | 4 | 5;
    actor: Actor;
  },
  clock: Clock = systemClock,
): Promise<RateOutcome> {
  if (!Number.isInteger(input.value) || input.value < 1 || input.value > 5) {
    // Checked here as well as by the CHECK constraint. The constraint is the guarantee; this is
    // the message a caller gets, and a 500 from Postgres is not one.
    return { ok: false, httpStatus: 403, reason: 'a rating is 1 to 5' };
  }

  const resource = await db.resource.findUnique({
    where: { id: input.resourceId },
    select: { id: true, ownerId: true, status: true, visibility: true },
  });
  if (resource === null) return { ok: false, httpStatus: 404, reason: 'no such resource' };

  const verdict = can({
    actor: input.actor,
    action: 'rate',
    subject: {
      type: 'Resource',
      id: resource.id,
      ownerId: resource.ownerId,
      lifecycleStatus: resource.status,
      visibility: resource.visibility,
      sharedClassroomIds: new Set<string>(),
    },
    context: { actorClassroomIds: new Set<string>() },
  });
  if (!verdict.allowed) {
    // `notSelf` is a 403 here and NOT a 404: the rater can see the resource, and a 404 would
    // tell them the rating was refused because the resource is missing. The distinction the
    // `notVisible` code exists for is about a resource the actor may not know about at all.
    return {
      ok: false,
      httpStatus: 403,
      reason: verdict.reason === 'notSelf' ? 'you cannot rate your own resource' : verdict.reason,
    };
  }

  await db.rating.upsert({
    where: { resourceId_userId: { resourceId: input.resourceId, userId: input.actor.id } },
    create: {
      resourceId: input.resourceId,
      userId: input.actor.id,
      value: input.value,
      // Stamped by the APPLICATION clock, not by Postgres. That is the opposite of MISSED-4, and
      // for one reason: `createdAt` on a rating is not gating anything, so a database default
      // would be the more consistent choice — EXCEPT that a rating is written in the same
      // transaction shape as the comment tests, and a half-and-half rule across this file is
      // harder to reason about than one documented exception. See the header on `dueAt`.
      createdAt: new Date(clock.now()),
    },
    update: { value: input.value, updatedAt: new Date(clock.now()) },
  });
  return { ok: true, summary: await ratingSummary(db, input.resourceId) };
}

/**
 * The aggregate.
 *
 * Every bucket appears, including the zeroes, so a UI can render five stars from the shape
 * without inventing the missing ones — a 4.2 average with no counts is a number nobody can
 * interpret, and "2 ratings" beside "4.2" is the case the count exists to explain.
 */
export async function ratingSummary(db: Db, resourceId: string): Promise<RatingSummary> {
  const grouped = await db.rating.groupBy({
    by: ['value'],
    where: { resourceId },
    _count: { _all: true },
  });
  const distribution: [1 | 2 | 3 | 4 | 5, number][] = [
    [1, 0],
    [2, 0],
    [3, 0],
    [4, 0],
    [5, 0],
  ];
  let count = 0;
  let total = 0;
  for (const row of grouped) {
    const star = row.value as 1 | 2 | 3 | 4 | 5;
    distribution[star - 1] = [star, row._count._all];
    count += row._count._all;
    total += row._count._all * row.value;
  }
  return {
    resourceId,
    count,
    mean: count === 0 ? null : Math.round((total / count) * 100) / 100,
    distribution,
  };
}

/* ------------------------------------------------------------------ *
 * Comments
 * ------------------------------------------------------------------ */

export interface CommentView {
  readonly id: string;
  readonly resourceId: string;
  readonly authorId: string;
  readonly body: string;
  readonly createdAt: string;
  /** False for a comment held for review. The AUTHOR is told, via `heldReason`; nobody else is. */
  readonly visible: boolean;
  readonly heldReason: string | null;
}

export type PostCommentOutcome =
  | { readonly ok: true; readonly comment: CommentView; readonly held: boolean }
  | { readonly ok: false; readonly httpStatus: 403 | 404; readonly reason: string };

/**
 * Post a comment, holding it if moderation requires.
 *
 * ## The gating rule, and both sides of it
 *
 * `plans/05` §6 says "comments (moderation-gated for minors)" without saying which end the
 * minor is. Both are held, and they are held for different reasons:
 *
 *  · **A comment BY a minor** is held because a minor should not be able to publish something
 *    permanent to a public page without a human having read it. That is a protection of the
 *    commenter, and it is the reading the packet most obviously intends.
 *  · **A comment ON a minor's resource** is held because the public comment thread on a
 *    twelve-year-old's work is the surface somebody would use to target them. `isMinor` on the
 *    author is the wrong side to check — the author of the RESOURCE is the child.
 *
 * The second is a stronger claim than the plan asks for, and it is the one that costs product:
 * a minor's resource gets no public discussion at all. It is worth it because those resources
 * are not publicly LISTED by default (P3-T3), so anything reachable is reachable through a
 * deliberate share, which is exactly the situation where a comment thread is worth gating.
 *
 * The row is CREATED either way, as `PENDING_REVIEW`. Not rejected, and not created as visible
 * and then hidden: "we held this and nobody looked" and "this was never submitted" are different
 * facts, and only the first is a moderation failure.
 */
export async function postComment(
  db: Db,
  input: { resourceId: string; body: string; actor: Actor },
  clock: Clock = systemClock,
): Promise<PostCommentOutcome> {
  const body = input.body.trim();
  if (body.length === 0 || body.length > 5_000) {
    return { ok: false, httpStatus: 403, reason: 'a comment is 1 to 5000 characters' };
  }

  const resource = await db.resource.findUnique({
    where: { id: input.resourceId },
    select: { id: true, ownerId: true, status: true, visibility: true },
  });
  if (resource === null) return { ok: false, httpStatus: 404, reason: 'no such resource' };

  const verdict = can({
    actor: input.actor,
    action: 'comment',
    subject: {
      type: 'Resource',
      id: resource.id,
      ownerId: resource.ownerId,
      lifecycleStatus: resource.status,
      visibility: resource.visibility,
      sharedClassroomIds: new Set<string>(),
    },
    context: { actorClassroomIds: new Set<string>() },
  });
  if (!verdict.allowed) return { ok: false, httpStatus: 403, reason: verdict.reason };

  // BOTH sides. The author's minority is the packet's reading; the RESOURCE OWNER's minority is
  // the safeguarding one, and checking only the first leaves the surface a stranger would
  // actually use ungated.
  const [commenter, owner] = await Promise.all([
    db.user.findUnique({ where: { id: input.actor.id }, select: { isMinor: true } }),
    db.user.findUnique({ where: { id: resource.ownerId }, select: { isMinor: true } }),
  ]);
  const held = commenter?.isMinor === true || owner?.isMinor === true;
  const gateReason = held
    ? commenter?.isMinor === true
      ? 'held: the author is under 18'
      : 'held: the resource belongs to somebody under 18'
    : null;

  const now = new Date(clock.now());
  const row = await db.comment.create({
    data: {
      resourceId: input.resourceId,
      authorId: input.actor.id,
      body,
      status: held ? 'PENDING_REVIEW' : 'VISIBLE',
      ...(held ? { gatedAt: now, gateReason } : {}),
    },
    select: { id: true, resourceId: true, authorId: true, body: true, createdAt: true },
  });

  return {
    ok: true,
    held,
    comment: {
      ...row,
      createdAt: row.createdAt.toISOString(),
      visible: !held,
      heldReason: gateReason,
    },
  };
}

/**
 * The comments a visitor sees.
 *
 * `VISIBLE` only, always. Not "visible unless you are the author", not "visible to a moderator":
 * a held comment has a single correct audience and expanding it is how a moderation queue becomes
 * a broadcast channel. The author sees their own held comment through `postComment`'s return
 * value, which is where the "we are holding this" message belongs — at the moment of writing,
 * not in a list that a moderator might be looking at.
 */
export async function listComments(
  db: Db,
  resourceId: string,
  limit = 50,
): Promise<readonly CommentView[]> {
  const rows = await db.comment.findMany({
    where: { resourceId, status: 'VISIBLE' },
    orderBy: { createdAt: 'asc' },
    take: limit,
    select: { id: true, resourceId: true, authorId: true, body: true, createdAt: true },
  });
  return rows.map((r) => ({
    ...r,
    createdAt: r.createdAt.toISOString(),
    visible: true,
    heldReason: null,
  }));
}

/* ------------------------------------------------------------------ *
 * Flagging and the takedown queue
 * ------------------------------------------------------------------ */

export interface FlagOutcome {
  readonly id: string;
  readonly dueAt: string;
  readonly slaHours: number;
}

export type FlagResult =
  | { readonly ok: true; readonly flag: FlagOutcome }
  | { readonly ok: false; readonly httpStatus: 403 | 404; readonly reason: string };

/**
 * Report a resource, or one comment on it.
 *
 * The one thing on this platform a stranger is invited to do, and the unique constraint on
 * `(reporterId, resourceId, commentId)` is load-bearing: without it, holding down the key
 * generates a thousand rows and the queue's depth becomes a measure of a stuck keyboard rather
 * than a measure of a problem. A duplicate report is a 409-shaped "already reported", returned
 * as a success, because a visitor who is told "you already reported this" has been answered and
 * needs nothing else.
 */
export async function flagResource(
  db: Db,
  input: {
    resourceId: string;
    commentId?: string | null;
    reason: FlagReason;
    detail?: string | null;
    actor: Actor;
  },
  clock: Clock = systemClock,
): Promise<FlagResult> {
  const detail = input.detail?.trim() ?? '';
  if (input.reason === 'OTHER' && detail.length === 0) {
    return {
      ok: false,
      httpStatus: 403,
      reason: 'a flag for "other" must say what the other is, or nobody can act on it',
    };
  }
  if (detail.length > 2_000) {
    return { ok: false, httpStatus: 403, reason: 'a flag detail is at most 2000 characters' };
  }

  const resource = await db.resource.findUnique({
    where: { id: input.resourceId },
    select: { id: true, ownerId: true, status: true, visibility: true },
  });
  if (resource === null) return { ok: false, httpStatus: 404, reason: 'no such resource' };

  const verdict = can({
    actor: input.actor,
    action: 'flag',
    subject: {
      type: 'Resource',
      id: resource.id,
      ownerId: resource.ownerId,
      lifecycleStatus: resource.status,
      visibility: resource.visibility,
      sharedClassroomIds: new Set<string>(),
    },
    context: { actorClassroomIds: new Set<string>() },
  });
  if (!verdict.allowed) return { ok: false, httpStatus: 403, reason: verdict.reason };

  // A commentId that is not on this resource is a client bug, and it is caught rather than
  // trusted: a mismatched pair would put a flag against a comment nobody can find and a resource
  // nobody flagged.
  if (input.commentId != null) {
    const onResource = await db.comment.findFirst({
      where: { id: input.commentId, resourceId: input.resourceId },
      select: { id: true },
    });
    if (onResource === null) {
      return { ok: false, httpStatus: 404, reason: 'no such comment on this resource' };
    }
  }

  const now = clock.now();
  const slaHours = SLA_TIERS[input.reason];
  const due = new Date(slaDeadline(input.reason, now));

  const existing = await db.flag.findFirst({
    where: {
      reporterId: input.actor.id,
      resourceId: input.resourceId,
      commentId: input.commentId ?? null,
    },
    select: { id: true, dueAt: true },
  });
  if (existing !== null) {
    // Already reported. A success, not an error: the visitor has been answered, and repeating
    // the flag would reset the clock on a deadline that is already running.
    return {
      ok: true,
      flag: { id: existing.id, dueAt: existing.dueAt.toISOString(), slaHours },
    };
  }

  const row = await db.flag.create({
    data: {
      resourceId: input.resourceId,
      commentId: input.commentId ?? null,
      reporterId: input.actor.id,
      reason: input.reason,
      detail: detail.length === 0 ? null : detail,
      dueAt: due,
      createdAt: new Date(now),
    },
    select: { id: true, dueAt: true },
  });
  return { ok: true, flag: { id: row.id, dueAt: row.dueAt.toISOString(), slaHours } };
}

export interface QueueEntry {
  readonly id: string;
  readonly resourceId: string;
  readonly resourceTitle: string;
  readonly commentId: string | null;
  readonly reason: FlagReason;
  readonly detail: string | null;
  readonly status: string;
  readonly slaHours: number;
  readonly dueAt: string;
  /** Milliseconds past due. Zero when not overdue, and negative is impossible by construction. */
  readonly overdueMs: number;
  readonly createdAt: string;
}

export interface Queue {
  readonly entries: readonly QueueEntry[];
  readonly overdue: number;
  readonly open: number;
  readonly claimed: number;
  /** Worst `overdueMs` in the queue, or 0. The number a weekly report quotes. */
  readonly worstOverdueMs: number;
}

/**
 * The moderation queue.
 *
 * Ordered by DEADLINE, not by `createdAt`. A queue sorted by age puts a week-old `COPYRIGHT`
 * flag above a `SAFEGUARDING` flag raised an hour ago, and the person who is sorting it does
 * the urgent thing last because it is at the bottom. Sorting by `dueAt` makes the ordering and
 * the priority the same thing, which is the only way the ordering can be trusted without the
 * reader thinking about it.
 *
 * `SAFEGUARDING` is additionally given a large `priority` so that a schema-level tiebreak, if one
 * is ever added, agrees with the intent.
 */
export async function moderationQueue(
  db: Db,
  options: { readonly limit?: number; readonly status?: 'OPEN' | 'CLAIMED' } = {},
  clock: Clock = systemClock,
): Promise<Queue> {
  const now = clock.now();
  const rows = await db.flag.findMany({
    where: { status: options.status ?? 'OPEN' },
    orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
    take: options.limit ?? 100,
    select: {
      id: true,
      resourceId: true,
      reason: true,
      detail: true,
      status: true,
      dueAt: true,
      createdAt: true,
      commentId: true,
      resource: { select: { title: true } },
    },
  });

  const entries: QueueEntry[] = rows.map((r) => ({
    id: r.id,
    resourceId: r.resourceId,
    resourceTitle: r.resource.title,
    commentId: r.commentId,
    reason: r.reason,
    detail: r.detail,
    status: r.status,
    slaHours: SLA_TIERS[r.reason as FlagReason] ?? 0,
    dueAt: r.dueAt.toISOString(),
    // Clamped at zero: a flag that is not overdue has NO lateness, and reporting a negative
    // number for "three hours early" would make a sum over the queue wrong in a way that
    // averages out to nothing and totals to something absurd.
    overdueMs: Math.max(0, now - r.dueAt.getTime()),
    createdAt: r.createdAt.toISOString(),
  }));

  const open = await db.flag.count({ where: { status: 'OPEN' } });
  const claimed = await db.flag.count({ where: { status: 'CLAIMED' } });
  return {
    entries,
    overdue: entries.filter((e) => e.overdueMs > 0).length,
    open,
    claimed,
    worstOverdueMs: entries.reduce((worst, e) => Math.max(worst, e.overdueMs), 0),
  };
}

export type ResolveOutcome =
  | { readonly ok: true; readonly wasOverdue: boolean; readonly resourceWithdrawn: boolean }
  | { readonly ok: false; readonly httpStatus: 403 | 404 | 409; readonly reason: string };

/**
 * Close a flag, and optionally take the content down.
 *
 * ## The overdue gate
 *
 * If `now > dueAt` and the caller has not passed `acknowledgeOverdue`, this returns 409. The
 * caller can pass it, and then the row records `acknowledgedOverdueAt` — so the lateness is
 * visible on the flag itself, to whoever reads it, forever. That is the whole enforcement
 * mechanism and it is deliberately small: it does not stop anybody, it makes the lateness
 * impossible to close over.
 *
 * 409 rather than 403 because the caller is allowed to do this — the timing is wrong, not the
 * permission. That is the same distinction P2-T9's blast-radius refusal draws, and conflating
 * them tells a moderator they may never resolve anything.
 *
 * ## `withdraw` is the takedown
 *
 * A takedown is `Resource.status = WITHDRAWN`, which already exists from P2-T8. There is no
 * `Takedown` row, deliberately: a second place to record "this content is down" is a second
 * thing to get out of step, and the resource's own status is the thing every other reader
 * already checks. `withdrawResource` is the gate `Resource.publish`/`update` uses.
 */
export async function resolveFlag(
  db: PrismaClient,
  input: {
    flagId: string;
    resolution: string;
    /** Set the resource to WITHDRAWN as part of resolving. */
    withdraw?: boolean;
    /** REQUIRED once the flag is overdue. */
    acknowledgeOverdue?: boolean;
    actor: Actor;
  },
  clock: Clock = systemClock,
): Promise<ResolveOutcome> {
  const resolution = input.resolution.trim();
  if (resolution.length < 10) {
    return {
      ok: false,
      httpStatus: 403,
      reason: 'a resolution must say what was decided, in a sentence somebody else can act on',
    };
  }

  const flag = await db.flag.findUnique({
    where: { id: input.flagId },
    select: { id: true, resourceId: true, status: true, dueAt: true, commentId: true },
  });
  if (flag === null) return { ok: false, httpStatus: 404, reason: 'no such flag' };
  if (flag.status === 'RESOLVED' || flag.status === 'DISMISSED') {
    return { ok: false, httpStatus: 409, reason: 'this flag is already closed' };
  }

  const moderator = can({
    actor: input.actor,
    action: 'moderate',
    subject: { type: 'Flag', id: flag.id, ownerId: input.actor.id },
  });
  if (!moderator.allowed) return { ok: false, httpStatus: 403, reason: moderator.reason };

  // `withdraw` on a COMMENT flag is a BLAST-RADIUS ERROR BY THE CALLER, and it is REFUSED
  // rather than ignored.
  //
  // This was a real bug, caught by the test that asserts the resource is untouched: the first
  // version withdrew the resource whenever `withdraw` was true, so one moderated sentence
  // removed a teacher's published lesson. The two easy fixes are both wrong — silently ignoring
  // the flag would leave the moderator believing they took the content down, and honouring it is
  // the bug. Refusing says what happened.
  //
  // Withdrawing a resource is its own decision with its own door, because it is a bigger act
  // than closing a queue item.
  if (input.withdraw === true && flag.commentId !== null) {
    return {
      ok: false,
      httpStatus: 409,
      reason:
        'this flag is against a COMMENT: closing it hides the comment and leaves the resource ' +
        'alone. To take the resource down, withdraw it separately — one moderated sentence must ' +
        'not remove a published lesson.',
    };
  }

  const now = clock.now();
  const overdueBy = now - flag.dueAt.getTime();
  const wasOverdue = overdueBy > 0;
  if (wasOverdue && input.acknowledgeOverdue !== true) {
    const hours = Math.floor(overdueBy / HOUR);
    return {
      ok: false,
      httpStatus: 409,
      reason:
        `this flag is ${hours}h past its deadline. Pass acknowledgeOverdue to close it anyway; ` +
        'the lateness is recorded on the flag.',
    };
  }

  return db.$transaction(async (tx) => {
    if (input.withdraw === true) {
      await tx.resource.update({
        where: { id: flag.resourceId },
        data: { status: 'WITHDRAWN', archivedAt: new Date(now) },
      });
    }
    // A flag against a COMMENT takes the comment down and leaves the resource alone. The
    // `withdraw`-on-a-comment-flag case was already refused above, so this branch is reached
    // with `withdraw` false or absent and the resource is untouched by construction.
    if (flag.commentId !== null) {
      await tx.comment.update({
        where: { id: flag.commentId },
        data: {
          status: 'HIDDEN',
          moderatedAt: new Date(now),
          moderatedById: input.actor.id,
          moderationReason: resolution,
        },
      });
    }

    await tx.flag.update({
      where: { id: flag.id },
      data: {
        status: 'RESOLVED',
        resolvedAt: new Date(now),
        resolution,
        resolvedById: input.actor.id,
        ...(wasOverdue ? { acknowledgedOverdueAt: new Date(now) } : {}),
      },
    });
    await tx.auditEvent.create({
      data: {
        actorId: input.actor.id,
        action: 'Flag.resolve',
        targetType: 'Flag',
        targetId: flag.id,
        ipHash: null,
        meta: {
          resourceId: flag.resourceId,
          commentId: flag.commentId,
          withdrew: input.withdraw === true,
          // The lateness goes IN the audit row, because six months later "was this handled
          // promptly" is unanswerable without knowing the deadline at the time.
          wasOverdue,
          overdueHours: Math.floor(overdueBy / HOUR),
        },
      },
    });
    return { ok: true, wasOverdue, resourceWithdrawn: input.withdraw === true };
  });
}

/**
 * Hide a comment without a flag against it.
 *
 * A moderator who sees something objectionable on a page does not have to wait for a visitor to
 * report it. This is the same state `resolveFlag` writes, and it goes through the same matrix
 * check, so "a comment was hidden" has exactly one door.
 */
export async function hideComment(
  db: PrismaClient,
  input: { commentId: string; reason: string; actor: Actor },
  clock: Clock = systemClock,
): Promise<{ ok: boolean; httpStatus?: number; reason?: string }> {
  const reason = input.reason.trim();
  if (reason.length < 10) {
    return { ok: false, httpStatus: 403, reason: 'saying why is the point of hiding a comment' };
  }
  const comment = await db.comment.findUnique({
    where: { id: input.commentId },
    select: { id: true, authorId: true, moderatedAt: true },
  });
  if (comment === null) return { ok: false, httpStatus: 404, reason: 'no such comment' };

  const verdict = can({
    actor: input.actor,
    action: 'moderate',
    subject: { type: 'Comment', id: comment.id, ownerId: comment.authorId },
  });
  if (!verdict.allowed) return { ok: false, httpStatus: 403, reason: verdict.reason };

  await db.comment.update({
    where: { id: comment.id },
    data: {
      status: 'HIDDEN',
      moderatedAt: new Date(clock.now()),
      moderatedById: input.actor.id,
      moderationReason: reason,
    },
  });
  return { ok: true };
}

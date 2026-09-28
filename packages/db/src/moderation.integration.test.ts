/**
 * Ratings, comments, flagging and the takedown SLA, against a real Postgres.  (P3-T5)
 *
 * ## The tests that matter
 *
 *  · `an OVERDUE flag cannot be closed without an acknowledgement` — the SLA is a gate, not a
 *    number in a column. If this passes by being lenient, the whole feature is a reporting
 *    feature, and reporting features are not read.
 *  · `a comment BY a minor is held, and so is a comment ON a minor's resource` — `plans/05` §6
 *    says "moderation-gated for minors" without saying which end. Both are checked, and the
 *    second is the safeguarding one.
 *  · `the queue is ordered by DEADLINE, not by age` — a queue sorted by age puts a week-old
 *    COPYRIGHT flag above a SAFEGUARDING flag raised an hour ago, and the urgent thing is at the
 *    bottom.
 *  · `a flag against a COMMENT takes the comment down, not the resource` — the blast radius of a
 *    moderated sentence.
 *
 * ## The clock is FROZEN and moved by hand
 *
 * The SLA is a duration, so every test here advances a `FrozenClock` rather than sleeping. A
 * queue whose deadline can only be tested by waiting an hour is a queue whose deadline is never
 * tested.
 */
import { randomUUID } from 'node:crypto';
import type { Actor, Role } from '@orrery/auth/types';
import { FrozenClock, HOUR, type Millis } from '@orrery/clock';
import { afterAll, describe, expect, it } from 'vitest';
import {
  flagResource,
  hideComment,
  listComments,
  moderationQueue,
  postComment,
  rateResource,
  ratingSummary,
  resolveFlag,
  SLA_TIERS,
  slaDeadline,
} from './moderation.js';
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

const T0: Millis = Date.UTC(2026, 3, 1, 9, 0, 0);
const clock = () => new FrozenClock(T0);

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

async function user(opts: { isMinor?: boolean; roles?: string[] } = {}): Promise<string> {
  const id = randomUUID();
  await prisma().user.create({
    data: {
      id,
      email: `${id}@m.example`,
      emailNormalized: `${id}@m.example`,
      name: 'Person',
      ...(opts.isMinor === undefined ? {} : { isMinor: opts.isMinor }),
    },
  });
  return id;
}

/**
 * An Actor, which is a claim about identity and not a loaded user row.
 *
 * Typed as the real `Actor` and not a hand-written shape. The first version declared
 * `roles: never[]` and cast at the return, which typechecked and told the reader nothing: the
 * point of importing the kernel's own type is that a role typo becomes a compile error here
 * rather than a `reviewerForbidden` at runtime that reads like an authorisation bug.
 */
function actorOf(id: string, roles: readonly Role[] = []): Actor {
  return { id, roles, mfaVerified: true, suspended: false };
}

interface ResourceOpts {
  readonly ownerId?: string;
  readonly status?: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED' | 'WITHDRAWN';
  readonly visibility?: 'PRIVATE' | 'UNLISTED' | 'PUBLIC';
}

/** A PUBLISHED/PUBLIC resource with a real current version, so it is listable. */
async function resource(opts: ResourceOpts = {}): Promise<{ id: string; ownerId: string }> {
  const ownerId = opts.ownerId ?? (await user());
  const id = randomUUID();
  await prisma().resource.create({
    data: {
      id,
      ownerId,
      kind: 'LESSON',
      status: opts.status ?? 'PUBLISHED',
      visibility: opts.visibility ?? 'PUBLIC',
      title: `Resource ${id.slice(0, 8)}`,
      slug: id,
    },
  });
  const version = await prisma().resourceVersion.create({
    data: {
      resourceId: id,
      version: 1,
      blocks: [],
      blocksChecksum: '0'.repeat(64),
      meta: {},
      createdById: ownerId,
    },
    select: { id: true },
  });
  await prisma().resource.update({ where: { id }, data: { currentVersionId: version.id } });
  return { id, ownerId };
}

/* ------------------------------------------------------------------ *
 * Ratings
 * ------------------------------------------------------------------ */

describe.skipIf(!DATABASE_URL)('P3-T5 moderation integration, against real Postgres', () => {
  it('a rating is 1..5, enforced by the DATABASE and not only by the caller', async () => {
    const r = await resource();
    const rater = await user();
    const ok = await rateResource(
      prisma(),
      { resourceId: r.id, value: 4, actor: actorOf(rater) },
      clock(),
    );
    expect(ok.ok).toBe(true);

    // The application check gives a message. The constraint is the guarantee, and it is the
    // thing that holds when the write comes from a script or the next endpoint somebody adds.
    const bad = await rateResource(
      prisma(),
      { resourceId: r.id, value: 9 as never, actor: actorOf(rater) },
      clock(),
    );
    expect(bad.ok).toBe(false);
    await expect(
      prisma().rating.create({ data: { resourceId: r.id, userId: rater, value: 0 } }),
    ).rejects.toThrow();
    await expect(
      prisma().rating.create({ data: { resourceId: r.id, userId: rater, value: 11 } }),
    ).rejects.toThrow();
  });

  it('a rating is an UPSERT, so a rating can be changed rather than being single-use', async () => {
    // A unique (resourceId, userId) plus an INSERT makes the star widget single-use: the second
    // visit is a constraint violation, and a visitor who cannot change their mind has to create
    // another account or live with it.
    const r = await resource();
    const rater = await user();
    await rateResource(prisma(), { resourceId: r.id, value: 1, actor: actorOf(rater) }, clock());
    const second = await rateResource(
      prisma(),
      { resourceId: r.id, value: 5, actor: actorOf(rater) },
      clock(),
    );
    expect(second.ok).toBe(true);
    expect(await prisma().rating.count({ where: { resourceId: r.id, userId: rater } })).toBe(1);
    expect((await ratingSummary(prisma(), r.id)).mean).toBe(5);
  });

  it('you cannot rate your own resource', async () => {
    // The check that is easiest to forget, because a self-rating looks like an ordinary
    // request — and it moves a public average.
    const r = await resource();
    const author = actorOf(r.ownerId);
    const result = await rateResource(
      prisma(),
      { resourceId: r.id, value: 5, actor: author },
      clock(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/your own/);
  });

  it('the summary reports every bucket INCLUDING the zeroes, and null mean when empty', async () => {
    const r = await resource();
    const empty = await ratingSummary(prisma(), r.id);
    // A UI needs five buckets to render five stars, and "4.2" beside "2 ratings" is the case
    // the count exists to explain.
    expect(empty.mean).toBeNull();
    expect(empty.distribution.map(([star]) => star)).toEqual([1, 2, 3, 4, 5]);
    expect(empty.distribution.every(([, n]) => n === 0)).toBe(true);

    for (const [rater, value] of [
      [await user(), 5],
      [await user(), 4],
      [await user(), 1],
    ] as const) {
      await rateResource(prisma(), { resourceId: r.id, value, actor: actorOf(rater) }, clock());
    }
    const summary = await ratingSummary(prisma(), r.id);
    expect(summary.count).toBe(3);
    expect(summary.mean).toBeCloseTo(3.33, 2);
    expect(summary.distribution).toEqual([
      [1, 1],
      [2, 0],
      [3, 0],
      [4, 1],
      [5, 1],
    ]);
  });

  it('a suspended account cannot rate', async () => {
    const r = await resource();
    const rater = await user();
    const suspended = { ...actorOf(rater), suspended: true };
    const result = await rateResource(
      prisma(),
      { resourceId: r.id, value: 5, actor: suspended },
      clock(),
    );
    expect(result.ok).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Comments
 * ------------------------------------------------------------------ */

describe.skipIf(!DATABASE_URL)('P3-T5 comment gating', () => {
  it('a comment BY a minor is HELD, not rejected, and not visible', async () => {
    // `plans/05` §6: "comments (moderation-gated for minors)". The row is created as
    // PENDING_REVIEW because "we held this and nobody looked" and "this was never submitted"
    // are different facts, and only the first is a moderation failure.
    const r = await resource();
    const minor = actorOf(await user({ isMinor: true }));
    const result = await postComment(
      prisma(),
      { resourceId: r.id, body: 'this helped me', actor: minor },
      clock(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.held).toBe(true);
    expect(result.comment.visible).toBe(false);
    expect(result.comment.heldReason).toMatch(/under 18/);

    const row = await prisma().comment.findUniqueOrThrow({
      where: { id: result.comment.id },
      select: { status: true, gatedAt: true, gateReason: true },
    });
    expect(row.status).toBe('PENDING_REVIEW');
    expect(row.gatedAt).not.toBeNull();
    // Not even a moderator sees a held comment in the public list. A held comment has ONE
    // correct audience and expanding it is how a queue becomes a broadcast channel.
    expect(await listComments(prisma(), r.id)).toHaveLength(0);
  });

  it("a comment ON a minor's resource is HELD — the safeguarding side", async () => {
    // The author-side gate is the packet's reading. This side is the one that costs product and
    // the one a stranger would use: the public thread on a twelve-year-old's work.
    const child = await user({ isMinor: true });
    const r = await resource({ ownerId: child });
    const stranger = actorOf(await user());
    const result = await postComment(
      prisma(),
      { resourceId: r.id, body: 'nice work', actor: stranger },
      clock(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.held).toBe(true);
    expect(result.comment.heldReason).toMatch(/belongs to somebody under 18/);
  });

  it("a comment by an adult on an adult's resource is VISIBLE immediately", async () => {
    const r = await resource();
    const result = await postComment(
      prisma(),
      { resourceId: r.id, body: 'clear and useful', actor: actorOf(await user()) },
      clock(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.held).toBe(false);
    expect(result.comment.visible).toBe(true);
    const listed = await listComments(prisma(), r.id);
    expect(listed).toHaveLength(1);
    expect(listed[0].body).toBe('clear and useful');
  });

  it('a PENDING_REVIEW comment cannot be created without a gate reason', async () => {
    // The constraint, not the service. A held comment with no timestamp and no reason is an
    // unbounded hold that is indistinguishable from one that was never submitted.
    const minor = await user({ isMinor: true });
    const r = await resource();
    await expect(
      prisma().comment.create({
        data: {
          resourceId: r.id,
          authorId: minor,
          body: 'x',
          status: 'PENDING_REVIEW',
        },
      }),
    ).rejects.toThrow();
  });

  it('a HIDDEN comment must carry a reason', async () => {
    const r = await resource();
    const author = await user();
    await expect(
      prisma().comment.create({
        data: { resourceId: r.id, authorId: author, body: 'x', status: 'HIDDEN' },
      }),
    ).rejects.toThrow();
    // And with one, it goes in.
    const ok = await prisma().comment.create({
      data: {
        resourceId: r.id,
        authorId: author,
        body: 'x',
        status: 'HIDDEN',
        moderationReason: 'contained an address',
      },
    });
    expect(ok.status).toBe('HIDDEN');
  });

  it('you cannot comment on your own resource', async () => {
    const r = await resource();
    const result = await postComment(
      prisma(),
      { resourceId: r.id, body: 'replying to myself', actor: actorOf(r.ownerId) },
      clock(),
    );
    expect(result.ok).toBe(false);
  });

  it('an empty or enormous comment is refused with a message, not a 500', async () => {
    const r = await resource();
    const stranger = actorOf(await user());
    for (const body of ['', '   ', 'x'.repeat(5_001)]) {
      const result = await postComment(
        prisma(),
        { resourceId: r.id, body, actor: stranger },
        clock(),
      );
      expect(result.ok, JSON.stringify(body.slice(0, 12))).toBe(false);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Flagging and the SLA
 * ------------------------------------------------------------------ */

describe.skipIf(!DATABASE_URL)('P3-T5 the takedown SLA', () => {
  it('every reason has a tier, and SAFEGUARDING is the shortest by an order of magnitude', async () => {
    // The one row that can be re-sorted to the top without being reclassified.
    expect(SLA_TIERS.SAFEGUARDING).toBe(1);
    expect(SLA_TIERS.SAFEGUARDING * 10).toBeLessThan(SLA_TIERS.UNSAFE_OR_HARMFUL);
    // PII on the same clock as unsafe content, deliberately. A child's name published on a
    // public resource is harmful on the same timescale, and a slower PII clock would rank it
    // as less urgent than a rude word.
    expect(SLA_TIERS.PERSONAL_INFORMATION).toBe(SLA_TIERS.UNSAFE_OR_HARMFUL);
  });

  it('a flag records its deadline at write time, from the INJECTED clock', async () => {
    const r = await resource();
    const reporter = actorOf(await user());
    const c = clock();
    const result = await flagResource(
      prisma(),
      { resourceId: r.id, reason: 'UNSAFE_OR_HARMFUL', actor: reporter },
      c,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.flag.slaHours).toBe(24);
    // Computed from the frozen clock, so this is an exact equality rather than a window.
    expect(result.flag.dueAt).toBe(new Date(slaDeadline('UNSAFE_OR_HARMFUL', T0)).toISOString());
  });

  it('an OVERDUE flag cannot be closed without an acknowledgement — 409, not 403', async () => {
    // The enforcement mechanism, and the whole design decision.
    //
    // A queue that merely RECORDS a deadline is a reporting feature, and reporting features are
    // not read: a moderator opening the queue on day nine sees a row, closes it in one click,
    // and nothing anywhere says it sat for nine days. So the deadline has teeth.
    const r = await resource();
    const reporter = actorOf(await user());
    const moderator = actorOf(await user(), ['reviewer']);
    const c = clock();
    const flagged = await flagResource(
      prisma(),
      { resourceId: r.id, reason: 'SAFEGUARDING', actor: reporter },
      c,
    );
    expect(flagged.ok).toBe(true);
    if (!flagged.ok) return;

    // Two hours later, on a one-hour SLA.
    c.advance(2 * HOUR);
    const queue = await moderationQueue(prisma(), { limit: 5_000 }, c);
    const entry = queue.entries.find((e) => e.id === flagged.flag.id);
    expect(entry, 'an overdue flag must be in the queue').toBeDefined();
    expect(entry?.overdueMs).toBe(HOUR);

    const refused = await resolveFlag(
      prisma(),
      { flagId: flagged.flag.id, resolution: 'looked at it, seems fine', actor: moderator },
      c,
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    // 409 rather than 403: the caller IS allowed to do this, the timing is wrong. Conflating
    // them tells a moderator they may never resolve anything.
    expect(refused.httpStatus).toBe(409);
    expect(refused.reason).toMatch(/past its deadline/);
    expect(await prisma().flag.count({ where: { id: flagged.flag.id, status: 'OPEN' } })).toBe(1);
  });

  it('an overdue flag CAN be closed, and the lateness is recorded on the row', async () => {
    // The escape hatch has to exist: a queue that locks when it is behind is a queue people
    // stop opening. What must not happen is closing it silently.
    const r = await resource();
    const reporter = actorOf(await user());
    const moderator = actorOf(await user(), ['reviewer']);
    const c = clock();
    const flagged = await flagResource(
      prisma(),
      { resourceId: r.id, reason: 'SAFEGUARDING', actor: reporter },
      c,
    );
    if (!flagged.ok) return;
    c.advance(30 * HOUR);

    const closed = await resolveFlag(
      prisma(),
      {
        flagId: flagged.flag.id,
        resolution: 'child protection team notified and took it down',
        acknowledgeOverdue: true,
        actor: moderator,
      },
      c,
    );
    expect(closed.ok).toBe(true);
    if (!closed.ok) return;
    expect(closed.wasOverdue).toBe(true);

    const row = await prisma().flag.findUniqueOrThrow({
      where: { id: flagged.flag.id },
      select: { status: true, acknowledgedOverdueAt: true, resolvedById: true },
    });
    expect(row.status).toBe('RESOLVED');
    expect(
      row.acknowledgedOverdueAt,
      'the lateness is on the flag, not in a metrics query',
    ).not.toBeNull();
    expect(row.resolvedById).toBe(moderator.id);

    // And the audit row carries it too, because six months later "was this handled promptly" is
    // unanswerable without knowing the deadline at the time.
    const audit = await prisma().auditEvent.findFirst({
      where: { targetId: flagged.flag.id, action: 'Flag.resolve' },
      select: { meta: true },
    });
    expect((audit?.meta as { wasOverdue?: boolean } | null)?.wasOverdue).toBe(true);
  });

  it('a flag inside its deadline needs no acknowledgement', async () => {
    const r = await resource();
    const moderator = actorOf(await user(), ['reviewer']);
    const c = clock();
    const flagged = await flagResource(
      prisma(),
      { resourceId: r.id, reason: 'COPYRIGHT', actor: actorOf(await user()) },
      c,
    );
    if (!flagged.ok) return;
    c.advance(HOUR); // a 7-day tier, so nowhere near
    const closed = await resolveFlag(
      prisma(),
      {
        flagId: flagged.flag.id,
        resolution: 'rights holder contacted, licence restored',
        actor: moderator,
      },
      c,
    );
    expect(closed.ok).toBe(true);
    if (closed.ok) expect(closed.wasOverdue).toBe(false);
  });

  it('the queue is ordered by DEADLINE, not by age', async () => {
    // A queue sorted by age puts a week-old COPYRIGHT flag above a SAFEGUARDING flag raised an
    // hour ago, and the person sorting it does the urgent thing last because it is at the
    // bottom. Sorting by dueAt makes the ordering and the priority the same thing.
    const subject = await resource();
    const c = clock();
    const reporter = actorOf(await user());

    const old = await flagResource(
      prisma(),
      { resourceId: subject.id, reason: 'COPYRIGHT', actor: reporter },
      c,
    );
    c.advance(HOUR);
    const urgent = await flagResource(
      prisma(),
      {
        resourceId: subject.id,
        commentId: null,
        reason: 'SAFEGUARDING',
        actor: actorOf(await user()),
      },
      c,
    );
    expect(old.ok && urgent.ok).toBe(true);
    if (!old.ok || !urgent.ok) return;
    // Two DIFFERENT reporters, so both rows exist and neither took the "already reported" path.
    const queue = await moderationQueue(prisma(), { limit: 5_000 }, c);
    const order = queue.entries.filter((e) => [old.flag.id, urgent.flag.id].includes(e.id));
    expect(order, 'both flags must be in the queue page').toHaveLength(2);
    expect(order[0]?.id, 'the safeguarding flag is younger and must be first').toBe(urgent.flag.id);
  });

  it('the queue reports lateness, and never a NEGATIVE lateness for an early flag', async () => {
    const r = await resource();
    const c = clock();
    const flagged = await flagResource(
      prisma(),
      { resourceId: r.id, reason: 'COPYRIGHT', actor: actorOf(await user()) },
      c,
    );
    if (!flagged.ok) return;
    // A high limit, deliberately. `moderationQueue` returns the first N OPEN flags ordered by
    // deadline, and this suite shares one database with no cleanup — so after a few runs the
    // first 100 rows are other runs' flags and this test's own flag is simply not in the page.
    // The earlier version used the default limit and failed with `expected undefined to be +0`,
    // which reads like the queue lost a row rather than like the page did not reach it.
    const early = await moderationQueue(prisma(), { limit: 5_000 }, c);
    const entry = early.entries.find((e) => e.id === flagged.flag.id);
    expect(entry, 'the flag is not in the queue page').toBeDefined();
    // "Three hours early" reported as -3h would make a SUM over the queue wrong in a way that
    // averages to nothing and totals to something absurd.
    expect(entry?.overdueMs).toBe(0);
    expect(early.worstOverdueMs).toBe(0);
  });

  it('a duplicate report is a SUCCESS, and does not reset the running clock', async () => {
    // Without the unique constraint, holding down the key generates a thousand rows and the
    // queue's depth becomes a measure of a stuck keyboard. And a duplicate must not extend the
    // deadline, or a report could be kept alive forever by re-submitting it.
    const r = await resource();
    const reporter = actorOf(await user());
    const c = clock();
    const first = await flagResource(
      prisma(),
      { resourceId: r.id, reason: 'UNSAFE_OR_HARMFUL', actor: reporter },
      c,
    );
    c.advance(HOUR);
    const again = await flagResource(
      prisma(),
      { resourceId: r.id, reason: 'UNSAFE_OR_HARMFUL', actor: reporter },
      c,
    );
    expect(first.ok && again.ok).toBe(true);
    if (!first.ok || !again.ok) return;
    expect(again.flag.id).toBe(first.flag.id);
    expect(again.flag.dueAt).toBe(first.flag.dueAt);
    expect(
      await prisma().flag.count({ where: { resourceId: r.id, reporterId: reporter.id } }),
    ).toBe(1);
  });

  it('a flag for "other" must say what the other is', async () => {
    // A queue cannot act on "other", so a flag with no detail is a flag nobody can work. The
    // CHECK constraint is the guarantee; the message is the courtesy.
    const r = await resource();
    const reporter = actorOf(await user());
    const vague = await flagResource(
      prisma(),
      { resourceId: r.id, reason: 'OTHER', actor: reporter },
      clock(),
    );
    expect(vague.ok).toBe(false);
    await expect(
      prisma().flag.create({
        data: {
          resourceId: r.id,
          reporterId: reporter.id,
          reason: 'OTHER',
          dueAt: new Date(T0 + HOUR),
        },
      }),
    ).rejects.toThrow();
  });

  it('you cannot flag your own resource', async () => {
    const r = await resource();
    const result = await flagResource(
      prisma(),
      { resourceId: r.id, reason: 'SPAM', actor: actorOf(r.ownerId) },
      clock(),
    );
    expect(result.ok).toBe(false);
  });

  it('a commentId that is not on the resource is refused, not trusted', async () => {
    // A mismatched pair puts a flag against a comment nobody can find and a resource nobody
    // flagged, and the queue shows the resource title, so it looks fine.
    const a = await resource();
    const b = await resource();
    const comment = await postComment(
      prisma(),
      { resourceId: a.id, body: 'hello', actor: actorOf(await user()) },
      clock(),
    );
    expect(comment.ok).toBe(true);
    if (!comment.ok) return;
    const result = await flagResource(
      prisma(),
      {
        resourceId: b.id,
        commentId: comment.comment.id,
        reason: 'OFFENSIVE',
        actor: actorOf(await user()),
      },
      clock(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/on this resource/);
  });
});

/* ------------------------------------------------------------------ *
 * Takedown
 * ------------------------------------------------------------------ */

describe.skipIf(!DATABASE_URL)('P3-T5 takedown', () => {
  it('a takedown is the resource going WITHDRAWN — no separate Takedown row', async () => {
    // A second place to record "this content is down" is a second thing to get out of step, and
    // the resource's own status is what every other reader already checks.
    const r = await resource();
    const moderator = actorOf(await user(), ['reviewer']);
    const c = clock();
    const flagged = await flagResource(
      prisma(),
      { resourceId: r.id, reason: 'UNSAFE_OR_HARMFUL', actor: actorOf(await user()) },
      c,
    );
    if (!flagged.ok) return;
    const closed = await resolveFlag(
      prisma(),
      {
        flagId: flagged.flag.id,
        resolution: 'removed: it names a pupil',
        withdraw: true,
        actor: moderator,
      },
      c,
    );
    expect(closed.ok).toBe(true);
    const after = await prisma().resource.findUniqueOrThrow({
      where: { id: r.id },
      select: { status: true, archivedAt: true },
    });
    expect(after.status).toBe('WITHDRAWN');
    expect(after.archivedAt).not.toBeNull();
  });

  it('a flag against a COMMENT takes the comment down, NOT the resource', async () => {
    // The blast radius. Reporting a comment and withdrawing the lesson it sits on would let one
    // moderated sentence remove a teacher's published work.
    const r = await resource();
    const c = clock();
    const posted = await postComment(
      prisma(),
      { resourceId: r.id, body: 'something objectionable', actor: actorOf(await user()) },
      c,
    );
    expect(posted.ok).toBe(true);
    if (!posted.ok) return;
    const moderator = actorOf(await user(), ['reviewer']);
    const flagged = await flagResource(
      prisma(),
      {
        resourceId: r.id,
        commentId: posted.comment.id,
        reason: 'OFFENSIVE',
        actor: actorOf(await user()),
      },
      c,
    );
    if (!flagged.ok) return;
    // Asking to withdraw as well is REFUSED, not ignored. Silently ignoring it would leave the
    // moderator believing they had taken the lesson down; honouring it is the bug this test
    // was written to catch.
    const greedy = await resolveFlag(
      prisma(),
      {
        flagId: flagged.flag.id,
        resolution: 'comment hidden, and the lesson too',
        withdraw: true,
        actor: moderator,
      },
      c,
    );
    expect(greedy.ok).toBe(false);
    if (!greedy.ok) {
      expect(greedy.httpStatus).toBe(409);
      expect(greedy.reason).toMatch(/one moderated sentence must not remove/);
    }

    const closed = await resolveFlag(
      prisma(),
      {
        flagId: flagged.flag.id,
        resolution: 'comment hidden, lesson left alone',
        actor: moderator,
      },
      c,
    );
    expect(closed.ok).toBe(true);
    const comment = await prisma().comment.findUniqueOrThrow({
      where: { id: posted.comment.id },
      select: { status: true, moderationReason: true },
    });
    expect(comment.status).toBe('HIDDEN');
    expect(comment.moderationReason).toMatch(/lesson left alone/);
    // Named `after` rather than `resource`: shadowing the fixture with a `const` in the same
    // scope is a temporal-dead-zone error, and the message ("Cannot access 'resource' before
    // initialization") points at the test's own name rather than at the rename.
    const after = await prisma().resource.findUniqueOrThrow({
      where: { id: r.id },
      select: { status: true },
    });
    expect(after.status, 'the resource must be untouched').toBe('PUBLISHED');
  });

  it('a resolution under ten characters is refused — saying what was decided is the point', async () => {
    const r = await resource();
    const moderator = actorOf(await user(), ['reviewer']);
    const c = clock();
    const flagged = await flagResource(
      prisma(),
      { resourceId: r.id, reason: 'SPAM', actor: actorOf(await user()) },
      c,
    );
    if (!flagged.ok) return;
    const terse = await resolveFlag(
      prisma(),
      { flagId: flagged.flag.id, resolution: 'nope', actor: moderator },
      c,
    );
    expect(terse.ok).toBe(false);
  });

  it('a non-moderator cannot resolve a flag', async () => {
    const r = await resource();
    const c = clock();
    const flagged = await flagResource(
      prisma(),
      { resourceId: r.id, reason: 'SPAM', actor: actorOf(await user()) },
      c,
    );
    if (!flagged.ok) return;
    const result = await resolveFlag(
      prisma(),
      {
        flagId: flagged.flag.id,
        resolution: 'closing this myself, seems fine',
        actor: actorOf(await user()),
      },
      c,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/reviewerForbidden|roleForbidden/);
  });

  it('a closed flag cannot be closed again', async () => {
    const r = await resource();
    const moderator = actorOf(await user(), ['reviewer']);
    const c = clock();
    const flagged = await flagResource(
      prisma(),
      { resourceId: r.id, reason: 'SPAM', actor: actorOf(await user()) },
      c,
    );
    if (!flagged.ok) return;
    await resolveFlag(
      prisma(),
      { flagId: flagged.flag.id, resolution: 'removed as duplicate content', actor: moderator },
      c,
    );
    const again = await resolveFlag(
      prisma(),
      { flagId: flagged.flag.id, resolution: 'actually, let me look again', actor: moderator },
      c,
    );
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.httpStatus).toBe(409);
  });

  it('a moderator can hide a comment WITHOUT a flag, through the same door', async () => {
    // A moderator who sees something objectionable does not wait for a visitor to report it, and
    // "a comment was hidden" having exactly one door is why the same matrix check is called.
    const r = await resource();
    const posted = await postComment(
      prisma(),
      { resourceId: r.id, body: 'something a moderator dislikes', actor: actorOf(await user()) },
      clock(),
    );
    if (!posted.ok) return;
    const result = await hideComment(
      prisma(),
      {
        commentId: posted.comment.id,
        reason: 'contains a home address',
        actor: actorOf(await user(), ['reviewer']),
      },
      clock(),
    );
    expect(result.ok).toBe(true);
    expect(await listComments(prisma(), r.id)).toHaveLength(0);
  });
});

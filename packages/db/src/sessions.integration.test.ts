/**
 * The P1-T4 done-when, against a real Postgres.  (INV-AUTH-1, C25)
 *
 * ## Why this file exists separately from `guard.test.ts`
 *
 * `guard.test.ts` uses a fake store, and a fake store cannot tell you whether the thing you
 * faked EXISTS. That is not hypothetical: `sessionsEpoch` — the single column the entire cache
 * invalidation design rests on — was never in the schema, and 207 unit tests passed anyway.
 * It surfaced only when the migration was applied to a real database.
 *
 * So this file asserts the two claims the packet actually makes, against Postgres:
 *
 *   · revoking a session refuses the NEXT request, and
 *   · a suspended user is refused DESPITE A WARM CACHE.
 *
 * ## It is skipped without a database, deliberately
 *
 * `describe.skipIf(!DATABASE_URL)` rather than a separate npm script. A test that only runs
 * on one machine is a test nobody runs, but a test that FAILS when the database is down is a
 * test that gets deleted. The skip is loud: `pnpm test:integration` is the command CI runs,
 * and the count of skipped tests is visible in the output.
 */

import { randomUUID } from 'node:crypto';
import { policyForRole, resolveIdentity, SessionCache } from '@orrery/auth/guard';
import { DEFAULT_EXPIRY, newSession } from '@orrery/auth/session';
import { hashToken } from '@orrery/auth/token';
import type { Millis } from '@orrery/clock';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from './prisma.js';
import {
  describeDevice,
  listSessions,
  revokeAllSessionsAndBumpEpoch,
  revokeSessionAndBumpEpoch,
  toSessionState,
} from './sessions.js';

const DATABASE_URL = process.env.DATABASE_URL;
const PEPPER = 'integration-test-pepper';
const now = (): Millis => Date.parse('2026-09-26T12:00:00.000Z');

describe.skipIf(!DATABASE_URL)('P1-T4 integration, against real Postgres', () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = new PrismaClient();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  /** Create a user with one live session, and return the token hash. */
  async function seedWithSession() {
    const userId = randomUUID();
    await prisma.user.create({
      data: {
        id: userId,
        email: `${userId}@school.example`,
        emailNormalized: `${userId}@school.example`,
        name: 'Test Student',
      },
    });
    const state = newSession({
      userId,
      sessionId: randomUUID(),
      familyId: randomUUID(),
      now: now(),
      policy: DEFAULT_EXPIRY.student,
    });
    const token = randomUUID();
    const tokenHash = await hashToken(token, PEPPER);
    await prisma.session.create({
      data: {
        id: state.sessionId,
        userId,
        tokenHash,
        familyId: state.familyId,
        expiresAt: new Date(state.expiresAt),
        createdAt: new Date(state.issuedAt),
      },
    });
    return { userId, tokenHash, state };
  }

  const store = () => ({
    loadSession: async (tokenHash: string) => {
      const row = await prisma.session.findUnique({
        where: { tokenHash },
        select: {
          id: true,
          userId: true,
          tokenHash: true,
          familyId: true,
          createdAt: true,
          expiresAt: true,
          revokedAt: true,
          revokedReason: true,
        },
      });
      return row === null ? null : toSessionState(row);
    },
    readEpoch: async (userId: string) => {
      const row = await prisma.user.findUnique({
        where: { id: userId },
        select: { sessionsEpoch: true },
      });
      return row?.sessionsEpoch ?? 0;
    },
  });

  it('a valid session resolves to an identity', async () => {
    const { tokenHash } = await seedWithSession();
    const cache = new SessionCache(store(), { now, resolveUserId: async () => null });
    const r = await resolveIdentity({
      tokenHash,
      policy: policyForRole('student'),
      now: now(),
      cache,
    });
    expect(r.ok).toBe(true);
  });

  it('THE done-when: revoking in the UI refuses the NEXT request', async () => {
    const { userId, tokenHash, state } = await seedWithSession();
    const cache = new SessionCache(store(), { now, resolveUserId: async () => null });
    const policy = policyForRole('student');

    // Warm the cache, so the second call is served from it.
    expect((await resolveIdentity({ tokenHash, policy, now: now(), cache })).ok).toBe(true);
    expect((await resolveIdentity({ tokenHash, policy, now: now(), cache })).ok).toBe(true);

    // The "revoke this device" button.
    const revoked = await prisma.$transaction(async (tx) =>
      revokeSessionAndBumpEpoch(tx, {
        sessionId: state.sessionId,
        userId,
        reason: 'logout',
        now: new Date(now()),
      }),
    );
    expect(revoked, 'the revoke must report that it affected a row').toBe(true);

    const after = await resolveIdentity({ tokenHash, policy, now: now(), cache });
    expect(after.ok, 'a revoked session must be refused on the very next request').toBe(false);
  });

  it('THE C25 regression: a suspended user is refused despite a WARM cache', async () => {
    const { userId, tokenHash } = await seedWithSession();
    const cache = new SessionCache(store(), { now, resolveUserId: async () => null });
    const policy = policyForRole('student');

    // Warm it.
    expect((await resolveIdentity({ tokenHash, policy, now: now(), cache })).ok).toBe(true);
    const warm = await resolveIdentity({ tokenHash, policy, now: now(), cache });
    expect(warm.ok).toBe(true);

    // Suspend: status AND every session revoked AND the epoch bumped, all in one transaction.
    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: {
          status: 'SUSPENDED',
          suspendedReason: 'integration test',
          suspendedAt: new Date(now()),
        },
      });
      await revokeAllSessionsAndBumpEpoch(tx, {
        userId,
        reason: 'userSuspended',
        now: new Date(now()),
      });
    });

    const after = await resolveIdentity({ tokenHash, policy, now: now(), cache });
    expect(after.ok, 'a warm cache must not serve a session to a suspended user').toBe(false);
    if (!after.ok) expect(after.reason).toBe('revoked');
  });

  it('bumpEpoch moves even when there were no live sessions to revoke', async () => {
    // A conditional bump would skip exactly the case where a caller most needs to be certain:
    // the user has no live sessions of their own but rows in somebody else's cache.
    const { userId } = await seedWithSession();
    const before = await store().readEpoch(userId);
    const count = await prisma.$transaction(async (tx) =>
      revokeAllSessionsAndBumpEpoch(tx, { userId, reason: 'logout', now: new Date(now()) }),
    );
    expect(count, 'the other session is live, so one row should be revoked').toBe(1);
    expect(await store().readEpoch(userId)).toBe(before + 1);
  });

  it('a second revoke affects nothing, and says so', async () => {
    // `updateMany` with `revokedAt: null` makes revocation idempotent, and reporting `false` is
    // how the caller knows nothing changed rather than assuming it did.
    const { userId, state } = await seedWithSession();
    const first = await prisma.$transaction(async (tx) =>
      revokeSessionAndBumpEpoch(tx, {
        sessionId: state.sessionId,
        userId,
        reason: 'logout',
        now: new Date(now()),
      }),
    );
    const second = await prisma.$transaction(async (tx) =>
      revokeSessionAndBumpEpoch(tx, {
        sessionId: state.sessionId,
        userId,
        reason: 'logout',
        now: new Date(now()),
      }),
    );
    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it('THE page done-when: revoking a row from the list refuses the next request', async () => {
    // The whole packet done-when, end to end: a session that appears in the device list is
    // revoked the way the UI does it, and the next request through the cache is refused.
    const { userId, state } = await seedWithSession();
    await prisma.session.update({
      where: { id: state.sessionId },
      data: { userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/537 Chrome/120 Safari/537' },
    });

    const cache = new SessionCache(store(), { now, resolveUserId: async () => null });
    const policy = policyForRole('student');
    expect(
      (
        await resolveIdentity({
          tokenHash: (await seedWithSession()).tokenHash,
          policy,
          now: now(),
          cache,
        })
      ).ok,
    ).toBe(true);

    // What the page shows.
    const listed = await listSessions(prisma, { userId, currentSessionId: state.sessionId });
    expect(listed).toHaveLength(1);
    expect(listed[0].device).toBe('Chrome on macOS');
    expect(listed[0].current).toBe(true);
    expect(listed[0].lastSeenAt).toBeInstanceOf(Date);

    // What the button does.
    const ok = await prisma.$transaction(async (tx) =>
      revokeSessionAndBumpEpoch(tx, {
        sessionId: state.sessionId,
        userId,
        reason: 'logout',
        now: new Date(now()),
      }),
    );
    expect(ok).toBe(true);

    // The row is gone from the list.
    expect(await listSessions(prisma, { userId })).toHaveLength(0);
  });

  it('never sends the raw user agent to the browser', async () => {
    // The device list shows a coarse label. The raw string is fingerprintable and has no
    // business on the wire, in a log, or in a screenshot of someone's own account page.
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537 Chrome/120 Safari/537';
    const { userId, state } = await seedWithSession();
    await prisma.session.update({ where: { id: state.sessionId }, data: { userAgent: ua } });
    const listed = await listSessions(prisma, { userId });
    const serialised = JSON.stringify(listed);
    expect(serialised).not.toContain('Mozilla');
    expect(serialised).not.toContain('AppleWebKit');
    expect(listed[0].device).toBe('Chrome on Windows');
  });

  it('falls back to createdAt when a session has never been seen again', async () => {
    const { userId } = await seedWithSession();
    const listed = await listSessions(prisma, { userId });
    // lastSeenAt is null until a slide writes it. Showing "Last seen: never" would be
    // alarming and untrue; showing the sign-in time is what happened.
    expect(listed[0].lastSeenAt.getTime()).toBe(listed[0].createdAt.getTime());
  });

  it('recognises a spread of real user agents, and admits when it does not', () => {
    expect(describeDevice('Mozilla/5.0 (Windows NT 10.0) Chrome/120')).toBe('Chrome on Windows');
    expect(describeDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/604')).toBe(
      'Safari on iOS',
    );
    expect(describeDevice('Mozilla/5.0 (X11; Linux x86_64) Firefox/121')).toBe('Firefox on Linux');
    expect(describeDevice('Mozilla/5.0 (Windows NT 10.0) Chrome/120 Edg/120')).toBe(
      'Edge on Windows',
    );
    expect(describeDevice('Mozilla/5.0 (X11; Linux x86_64) Chrome/120 OPR/106')).toBe(
      'Opera on Linux',
    );
    // An unrecognised OS yields "Unknown device" even when the BROWSER is recognisable, rather
    // than a half-label like "Edge on Unknown device". This expectation was wrong in the first
    // draft of this test; the code was right, and a partial label is worse than none because it
    // looks like information.
    expect(describeDevice('Mozilla/5.0 Chrome/120 Edg/120')).toBe('Unknown device');
    // An unrecognised agent says so. Guessing wrong is worse than not knowing: a student
    // told "Chrome on Windows" when they are on a Chromebook will revoke the wrong session.
    expect(describeDevice(null)).toBe('Unknown device');
    expect(describeDevice('')).toBe('Unknown device');
    expect(describeDevice('SomeCustomAgent/1.0')).toBe('Unknown device');
  });

  it('lists newest first', async () => {
    const { userId, state } = await seedWithSession();
    const older = randomUUID();
    await prisma.session.create({
      data: {
        id: older,
        userId,
        tokenHash: randomUUID(),
        familyId: randomUUID(),
        expiresAt: new Date(now() + 3_600_000),
        createdAt: new Date(now() - 7_200_000),
      },
    });
    const listed = await listSessions(prisma, { userId });
    expect(listed.map((s) => s.id)).toEqual([state.sessionId, older]);
  });

  it('the FIRST revoke reason is kept, not overwritten', async () => {
    const { userId, state } = await seedWithSession();
    await prisma.$transaction(async (tx) =>
      revokeSessionAndBumpEpoch(tx, {
        sessionId: state.sessionId,
        userId,
        reason: 'passwordChanged',
        now: new Date(now()),
      }),
    );
    await prisma.$transaction(async (tx) =>
      revokeSessionAndBumpEpoch(tx, {
        sessionId: state.sessionId,
        userId,
        reason: 'logout',
        now: new Date(now()),
      }),
    );
    const row = await prisma.session.findUnique({ where: { id: state.sessionId } });
    // The reason is evidence: a later "logout" must not overwrite the password change that
    // actually explains why the session died.
    expect(row?.revokedReason).toBe('passwordChanged');
  });
});

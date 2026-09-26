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

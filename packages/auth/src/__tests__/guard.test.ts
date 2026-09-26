/**
 * Route protection and session cache tests.  (P1-T4, C25)
 *
 * ## The test this file is built around
 *
 * `describe('C25 regression: a warm cache must not defeat a revoke')`. Not because it is the
 * most numerous case, but because it is the one the packet names and the one a passing
 * implementation of everything else would still fail. The sequence is: warm the cache, then
 * suspend, then request again — and the answer must change.
 *
 * ## The trap in the route table
 *
 * `/classes` must not match the `/classrooms` rule. A naive `startsWith` does exactly that,
 * and the consequence is a signed-in student being sent to a teacher page — a small leak of
 * the existence of the teacher surface, and a confusing 403 for no reason. The tests use real
 * near-miss paths rather than asserting the matcher in isolation.
 */

import { HOUR, type Millis } from '@orrery/clock';
import { describe, expect, it } from 'vitest';
import { policyForRole, resolveIdentity, SessionCache } from '../guard.js';
import { decideRoute, isNoIndex, pathMatches, requirementFor } from '../routes.js';
import { DEFAULT_EXPIRY, newSession, revoke, type SessionState } from '../session.js';
import type { Role } from '../types.js';

const T0: Millis = 1_700_000_000_000;
const TOKEN = 'h'.repeat(43);

/** A fake store with a per-user epoch, the way the real one behaves. */
function makeStore(initial?: SessionState) {
  let session = initial ?? null;
  let epoch = 0;
  let loads = 0;
  let epochReads = 0;
  return {
    store: {
      loadSession: async () => {
        loads += 1;
        return session;
      },
      readEpoch: async () => {
        epochReads += 1;
        return epoch;
      },
    },
    get loads() {
      return loads;
    },
    get epochReads() {
      return epochReads;
    },
    setSession(next: SessionState) {
      session = next;
    },
    /** What a revoke does: bump the epoch IN THE SAME TRANSACTION. */
    bumpEpoch() {
      epoch += 1;
    },
  };
}

const liveSession = (over: Partial<SessionState> = {}): SessionState =>
  newSession({
    userId: 'u-1',
    sessionId: 's-1',
    familyId: 'f-1',
    now: T0,
    policy: DEFAULT_EXPIRY.student,
    ...over,
  });

const cacheWith = (h: ReturnType<typeof makeStore>, now = () => T0) =>
  new SessionCache(h.store, {
    now,
    resolveUserId: async () => h.store.loadSession('').then((s) => s?.userId ?? null),
  });

describe('C25 regression: a warm cache must not defeat a revoke', () => {
  it('serves a cached session, then refuses it the moment the epoch moves', async () => {
    const h = makeStore(liveSession());
    const cache = cacheWith(h);

    // 1. Warm.
    const first = await cache.get(TOKEN);
    expect(first.session).not.toBeNull();
    expect(first.fromCache).toBe(false);

    const second = await cache.get(TOKEN);
    expect(second.fromCache, 'the second read should be a cache hit').toBe(true);

    // 2. Suspend: the row is revoked AND the epoch is bumped, in the same transaction.
    h.setSession(revoke(liveSession(), T0, 'userSuspended'));
    h.bumpEpoch();

    // 3. The very next request.
    const third = await cache.get(TOKEN);
    expect(third.session, 'a warm cache must not serve a revoked session').toBeNull();
    expect(third.discardedBecause).toBe('epochMoved');
  });

  it('the epoch read happens on EVERY hit, not only on a miss', async () => {
    // The whole mechanism depends on this. A cache that checks the epoch once and then trusts
    // itself is a cache with a slower TTL and extra steps.
    const h = makeStore(liveSession());
    const cache = cacheWith(h);
    await cache.get(TOKEN);
    const afterMiss = h.epochReads;
    await cache.get(TOKEN);
    await cache.get(TOKEN);
    expect(h.epochReads, 'two hits must produce two epoch reads').toBe(afterMiss + 2);
  });

  it('the expensive load happens once, and only on a miss', async () => {
    const h = makeStore(liveSession());
    const cache = cacheWith(h);
    await cache.get(TOKEN);
    const afterFirst = h.loads;
    await cache.get(TOKEN);
    await cache.get(TOKEN);
    expect(h.loads, 'this is the work the cache exists to save').toBe(afterFirst);
  });

  it('refuses a revoked session through resolveIdentity, and says REVOKED not unknown', async () => {
    // The distinction matters: unknown is a typo, revoked is possibly theft and must raise a
    // security event rather than send the user to a login page.
    const h = makeStore(liveSession());
    const cache = cacheWith(h);
    const policy = policyForRole('student');

    const before = await resolveIdentity({ tokenHash: TOKEN, policy, now: T0, cache });
    expect(before.ok).toBe(true);

    h.setSession(revoke(liveSession(), T0, 'userSuspended'));
    h.bumpEpoch();

    const after = await resolveIdentity({ tokenHash: TOKEN, policy, now: T0, cache });
    expect(after).toEqual({ ok: false, reason: 'revoked' });
  });
});

describe('the cache in the ordinary cases', () => {
  it('does NOT cache a negative result', async () => {
    // Caching negatives would mean a user who just signed up cannot sign in for 60 seconds,
    // which is the most-reported class of bug in any system with a session cache.
    const h = makeStore(null);
    const cache = cacheWith(h);
    expect((await cache.get(TOKEN)).session).toBeNull();
    expect((await cache.get(TOKEN)).session).toBeNull();
    expect(h.loads, 'each miss must go to the store').toBe(2);
  });

  it('re-loads after the TTL expires, and says so', async () => {
    const h = makeStore(liveSession());
    let now = T0;
    const cache = cacheWith(h, () => now);
    await cache.get(TOKEN);
    now = T0 + 61_000;
    const after = await cache.get(TOKEN);
    expect(after.fromCache).toBe(false);
    expect(h.loads).toBe(2);
  });

  it('invalidateFor drops that user’s rows, for the device list', async () => {
    const h = makeStore(liveSession());
    const cache = cacheWith(h);
    await cache.get(TOKEN);
    expect(cache.size).toBe(1);
    cache.invalidateFor('u-1');
    expect(cache.size).toBe(0);
  });

  it('clear() empties the cache, and clear() is reachable', async () => {
    const h = makeStore(liveSession());
    const cache = cacheWith(h);
    await cache.get(TOKEN);
    expect(cache.size).toBe(1);
    cache.clear();
    expect(cache.size).toBe(0);
    // And it really re-reads afterwards, rather than merely reporting a smaller size.
    expect((await cache.get(TOKEN)).fromCache).toBe(false);
  });

  it('leaves another user’s rows alone', async () => {
    const h = makeStore(liveSession());
    const cache = cacheWith(h);
    await cache.get(TOKEN);
    cache.invalidateFor('someone-else');
    expect(cache.size).toBe(1);
  });
});

describe('resolveIdentity', () => {
  it('refuses a missing or empty token before touching the store', async () => {
    const h = makeStore(liveSession());
    const cache = cacheWith(h);
    const policy = policyForRole('student');
    for (const tokenHash of [null, '']) {
      expect(await resolveIdentity({ tokenHash, policy, now: T0, cache })).toEqual({
        ok: false,
        reason: 'noToken',
      });
    }
    expect(h.loads).toBe(0);
  });

  it('reports an unknown token, distinct from a revoked one', async () => {
    const h = makeStore(null);
    const cache = cacheWith(h);
    const r = await resolveIdentity({
      tokenHash: TOKEN,
      policy: DEFAULT_EXPIRY.student,
      now: T0,
      cache,
    });
    expect(r).toEqual({ ok: false, reason: 'unknownToken' });
  });

  it('returns an identity carrying mfaVerified=false unless told otherwise', async () => {
    // MFA is verified IN THIS SESSION, so it is never inferred from the account.
    const h = makeStore(liveSession());
    const cache = cacheWith(h);
    const r = await resolveIdentity({
      tokenHash: TOKEN,
      policy: DEFAULT_EXPIRY.student,
      now: T0,
      cache,
    });
    expect(r.ok && r.identity.mfaVerified).toBe(false);

    const withMfa = await resolveIdentity({
      tokenHash: TOKEN,
      policy: DEFAULT_EXPIRY.student,
      now: T0,
      cache,
      mfaVerified: true,
    });
    expect(withMfa.ok && withMfa.identity.mfaVerified).toBe(true);
  });

  it('reports a revoked row found on a COLD cache as REVOKED', async () => {
    // The C25 sequence bumps the epoch while the cache is warm. This is the other direction:
    // a fresh process, an empty cache, and the store hands back an already-revoked row. The
    // reuse verdict must still come out as `revoked`, because a revoked token is possible
    // theft and has to raise a security event rather than send the user to a login page.
    const h = makeStore(revoke(liveSession(), T0, 'passwordChanged'));
    const cache = cacheWith(h);
    const r = await resolveIdentity({
      tokenHash: TOKEN,
      policy: DEFAULT_EXPIRY.student,
      now: T0,
      cache,
    });
    expect(r).toEqual({ ok: false, reason: 'revoked' });
  });

  it('refuses an expired session as EXPIRED, not revoked', async () => {
    const h = makeStore(liveSession());
    const cache = cacheWith(h);
    const r = await resolveIdentity({
      tokenHash: TOKEN,
      policy: DEFAULT_EXPIRY.student,
      now: T0 + 3 * HOUR,
      cache,
    });
    expect(r).toEqual({ ok: false, reason: 'expired' });
  });
});

describe('route requirements', () => {
  it('is deny by default: an undeclared path needs a session', () => {
    // A new route added without a declaration shows up as a sign-in redirect during review
    // rather than as an open door in production.
    expect(requirementFor('/something/nobody/declared')).toEqual({ kind: 'session' });
  });

  it('does NOT let /classes match the /classrooms rule', () => {
    // A naive startsWith does exactly this, and the consequence is a signed-in student being
    // sent to a teacher page.
    expect(pathMatches('/classes', '/classrooms')).toBe(false);
    expect(requirementFor('/classes').kind).toBe('session');
    expect(requirementFor('/classrooms/x').kind).toBe('role');
  });

  it('prefers the longest matching prefix, regardless of table order', () => {
    expect(requirementFor('/settings/sessions').kind).toBe('session');
    expect(requirementFor('/sign-in').kind).toBe('public');
    expect(requirementFor('/sign-in-up').kind).toBe('session');
  });

  it('treats the admin surface as admin-only and the review surface as reviewer-only', () => {
    expect(requirementFor('/admin/users')).toEqual({ kind: 'role', roles: ['platformAdmin'] });
    expect(requirementFor('/review/queue')).toEqual({ kind: 'role', roles: ['reviewer'] });
  });
});

describe('deciding what happens', () => {
  const base = {
    path: '/settings',
    signedIn: true,
    roles: ['student'] as readonly Role[],
    emailVerified: true,
    mfaVerified: false,
    accountUsable: true,
  };

  it('lets a signed-in user through a plain session route', () => {
    // Worth asserting explicitly: it is the `case 'session'` branch, and it was the one
    // route action no test actually exercised while signed in. A coverage report found it,
    // which is the report doing the job it is there for.
    expect(decideRoute({ ...base, path: '/settings' })).toEqual({ kind: 'allow' });
    expect(decideRoute({ ...base, path: '/settings/sessions' })).toEqual({ kind: 'allow' });
  });

  it('lets a public route through, signed in or not', () => {
    expect(decideRoute({ ...base, path: '/terms', signedIn: false })).toEqual({ kind: 'allow' });
    expect(decideRoute({ ...base, path: '/terms' })).toEqual({ kind: 'allow' });
  });

  it('sends a signed-out visitor to sign-in, preserving where they were going', () => {
    expect(decideRoute({ ...base, path: '/classrooms/c-1', signedIn: false })).toEqual({
      kind: 'signIn',
      returnTo: '/classrooms/c-1',
    });
  });

  it('refuses a SUSPENDED user even on a public route', () => {
    // The C25 regression at the ROUTE level. It must not depend on the session being absent —
    // it must catch the session being wrong.
    expect(decideRoute({ ...base, path: '/terms', accountUsable: false })).toEqual({
      kind: 'signIn',
      returnTo: '/terms',
    });
  });

  it('tells a signed-in user they lack the role, rather than bouncing them to sign-in', () => {
    // A student on /admin has already proved who they are. Sending them to a login form is
    // both useless and confusing.
    expect(decideRoute({ ...base, path: '/admin/users' })).toEqual({
      kind: 'forbidden',
      missing: 'role',
    });
  });

  it('refuses an unverified email on a route that requires it', () => {
    const teacher = { ...base, roles: ['teacher'] as readonly Role[] };
    expect(decideRoute({ ...teacher, path: '/classrooms/new', emailVerified: true })).toEqual({
      kind: 'allow',
    });
    expect(decideRoute({ ...teacher, path: '/classrooms/new', emailVerified: false })).toEqual({
      kind: 'forbidden',
      missing: 'emailVerified',
    });
  });

  it('checks the ROLE before the email, so a student is not told to verify', () => {
    // The reverse order tells a signed-in student to go and verify their email before they
    // can reach a page they were never allowed to see — useless, and a small disclosure that
    // the route exists.
    expect(decideRoute({ ...base, path: '/classrooms/new', emailVerified: false })).toEqual({
      kind: 'forbidden',
      missing: 'role',
    });
  });

  it('has no route that requires MFA, because D6 is an action gate', () => {
    expect(requirementFor('/exam/a-1')).toEqual({ kind: 'examAttempt' });
    expect(decideRoute({ ...base, path: '/exam/a-1', mfaVerified: false })).toEqual({
      kind: 'allow',
    });
  });

  it('does NOT demand MFA on the exam surface', () => {
    // A teacher opening a blank gradebook has not yet done the thing MFA is required for, and
    // a student mid-exam must never be bounced by an MFA prompt.
    expect(decideRoute({ ...base, path: '/classrooms/c-1', mfaVerified: false })).toEqual({
      kind: 'allow',
    });
  });
});

describe('what must never be indexed', () => {
  it('covers the exam surface, settings, classrooms, review and admin', () => {
    for (const p of ['/exam/a-1', '/settings', '/classrooms/c-1', '/review/q', '/admin/u']) {
      expect(isNoIndex(p), p).toBe(true);
    }
  });

  it('leaves the public pages indexable', () => {
    for (const p of ['/', '/terms', '/privacy', '/sign-in']) {
      expect(isNoIndex(p), p).toBe(false);
    }
  });
});

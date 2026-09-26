/**
 * Route protection and the session cache.  (P1-T4, INV-AUTH-1, C25)
 *
 * ## The tension this file exists to resolve
 *
 * `plans/13` §2 requires that a teacher suspending a student, or removing them from a
 * classroom, "must take effect on the next request, including mid-exam". That rules out the
 * naive cache: C25 found that a 60-second session cache silently defeats INV-AUTH-1, because
 * the next sixty seconds of requests are answered from a stale session and the removal simply
 * does not happen.
 *
 * So we want a cache for the expensive part and none for the revocation check. The split:
 *
 *   · **Cached:** the session row, keyed by token hash. This is the expensive lookup — a
 *     HMAC, an indexed query, and a row read.
 *   · **Never cached:** the per-user `sessionsEpoch`. One small integer, read fresh on every
 *     request, and bumped inside the same transaction as every revoke.
 *
 * A cached row is only served if its epoch still matches. One extra cheap read buys back the
 * expensive one and preserves the invariant.
 *
 * ## Why not simply cache nothing
 *
 * Because the honest version of that choice costs a round trip per request anyway, and the
 * plan explicitly asks for a 60-second maximum rather than none. The difference is real: a
 * hash plus a full row read, once per request, for every concurrent exam taker, is a
 * measurable load on a database that is also running a release batch.
 *
 * ## The remaining honest caveat
 *
 * The epoch read is a database round trip. If that read is itself served from a replica that
 * has not yet replicated, a revoke can be up to one replication delay late. That is a
 * property of the deployment, not of this code, and it is why `sessionsEpoch` is written by
 * the SAME primary that writes the revocations, with the read forced to the primary. Written
 * down here so the deployment decision is made knowingly rather than discovered.
 */

import type { Millis } from '@orrery/clock';
import { DEFAULT_EXPIRY, type ExpiryPolicy, evaluateToken, type SessionState } from './session.js';

/** How stale a cached session row may be. The plan's 60 seconds. */
export const SESSION_CACHE_TTL = 60_000;

/** The store this module reads through. Every method is async and injected. */
export interface SessionStore {
  /** Expensive: resolve a token hash to a row. Never called on a cache hit. */
  readonly loadSession: (tokenHash: string) => Promise<SessionState | null>;
  /**
   * CHEAP and NEVER CACHED. The per-user epoch. Bumped in the same transaction as every
   * revoke, and read from the primary.
   */
  readonly readEpoch: (userId: string) => Promise<number>;
}

export interface CacheEntry {
  readonly session: SessionState;
  /** The epoch this row was valid at. Served only while it still matches. */
  readonly epoch: number;
  readonly cachedAt: Millis;
}

export interface CachedSession {
  readonly session: SessionState | null;
  /** True when the answer came from cache, for metrics and for the tests to assert on. */
  readonly fromCache: boolean;
  /** Why a cached row was discarded. Null on a normal hit. */
  readonly discardedBecause: 'epochMoved' | 'ttlExpired' | null;
}

export interface SessionCacheOptions {
  readonly ttl?: Millis;
  readonly now: () => Millis;
  /**
   * Resolve the user whose epoch to check. Needed because a cache entry is keyed by TOKEN and
   * the epoch is per USER — so a cache hit still costs one indexed read to learn the userId.
   * That read is far cheaper than the row load it replaces, which is the entire trade.
   */
  readonly resolveUserId: (tokenHash: string) => Promise<string | null>;
}

export class SessionCache {
  private readonly entries = new Map<string, CacheEntry>();

  // `options` is a plain parameter, not a `private readonly` property: everything it supplies
  // is destructured into a field below, so keeping a reference to the whole object would be a
  // second copy of the same truth that can drift from the fields derived from it.
  private readonly ttl: Millis;
  private readonly now: () => Millis;

  constructor(
    private readonly store: SessionStore,
    options: SessionCacheOptions,
  ) {
    this.ttl = options.ttl ?? SESSION_CACHE_TTL;
    this.now = options.now;
  }

  /**
   * Resolve a token to a session, consulting the cache only when it is provably still valid.
   *
   * A null session is NOT cached. Caching negative results would mean a user who just signed
   * up cannot sign in for 60 seconds, which is the most-reported class of bug in any system
   * with a session cache.
   */
  async get(tokenHash: string): Promise<CachedSession> {
    const now = this.now();
    const cached = this.entries.get(tokenHash);

    if (cached) {
      const withinTtl = now - cached.cachedAt < this.ttl;
      if (withinTtl) {
        const epoch = await this.store.readEpoch(cached.session.userId);
        if (epoch === cached.epoch) {
          return { session: cached.session, fromCache: true, discardedBecause: null };
        }
        // The epoch moved, which means a revoke happened. The row is not merely stale, it is
        // known-wrong, and serving it is precisely the C25 defect.
        this.entries.delete(tokenHash);
        return { session: null, fromCache: false, discardedBecause: 'epochMoved' };
      }
      // TTL expiry is NOT a negative answer. Drop the entry and FALL THROUGH to a reload.
      // There is no `break` and no `case` here, so `no-fallthrough` does not apply and no
      // suppression is needed. An unused eslint-disable is itself an error, and worse than
      // none: it advertises a suppression that is not happening, so a REAL fallthrough added
      // later would sail through unreviewed.
      //
      // The first version returned `{ session: null }` here, which meant that after 60 seconds
      // EVERY session in the system started resolving as `unknownToken` — a total outage that
      // would have looked like a mass logout. The test caught it by asserting on the load
      // count rather than on the shape of the result, which is the only reason to count loads
      // in a test about caching.
      this.entries.delete(tokenHash);
    }

    const session = await this.store.loadSession(tokenHash);
    if (session === null) return { session: null, fromCache: false, discardedBecause: null };

    const epoch = await this.store.readEpoch(session.userId);
    this.entries.set(tokenHash, { session, epoch, cachedAt: now });
    return { session, fromCache: false, discardedBecause: null };
  }

  /**
   * Drop everything cached for a user.
   *
   * Best-effort and NOT sufficient on its own — a multi-replica deployment has caches in
   * every process, and this only clears this one. It exists to make the common single-process
   * case correct without a round trip to the epoch, and to keep a revoked token from occupying
   * memory until its TTL. The epoch remains the mechanism that makes it work everywhere.
   */
  invalidateFor(userId: string): void {
    for (const [tokenHash, entry] of this.entries) {
      if (entry.session.userId === userId) this.entries.delete(tokenHash);
    }
  }

  /** Every cached token, for the device list. Never returns a token, only a count. */
  get size(): number {
    return this.entries.size;
  }

  /** Test hook. */
  clear(): void {
    this.entries.clear();
  }
}

/**
 * Turn a resolved session into the request-scoped identity, or a refusal.
 *
 * The policy for WHICH policy applies is here rather than at each call site, because choosing
 * per-request would be a silent bypass waiting to happen: a route that picks `teacher`
 * timings for a student gets a 14-day window for a student.
 */
export interface RequestIdentity {
  readonly userId: string;
  readonly sessionId: string;
  readonly familyId: string;
  readonly expiresAt: Millis;
  /** Whether a second factor was verified in THIS session. */
  readonly mfaVerified: boolean;
}

export type SessionOutcome =
  | { ok: true; identity: RequestIdentity }
  | { ok: false; reason: 'noToken' | 'unknownToken' | 'revoked' | 'expired' };

/**
 * Resolve a request's identity.
 *
 * `evaluateToken` is used rather than `evaluateSession` because it distinguishes
 * `reuseDetected` — a revoked token is not an expired session, it is possible theft, and the
 * caller needs to raise a security event rather than send the user to a login page.
 */
export async function resolveIdentity(input: {
  tokenHash: string | null;
  policy: ExpiryPolicy;
  now: Millis;
  cache: SessionCache;
  mfaVerified?: boolean;
}): Promise<SessionOutcome> {
  if (input.tokenHash === null || input.tokenHash === '') return { ok: false, reason: 'noToken' };

  const result = await input.cache.get(input.tokenHash);
  const session = result.session;

  if (session === null) {
    // A row that existed but whose epoch moved is a REVOKED session, not an unknown token.
    // The distinction matters: unknown is a typo, revoked is possibly an attack.
    return {
      ok: false,
      reason: result.discardedBecause === 'epochMoved' ? 'revoked' : 'unknownToken',
    };
  }

  const verdict = evaluateToken(session, input.now, input.policy);
  if (!verdict.ok) {
    return { ok: false, reason: verdict.reason === 'reuseDetected' ? 'revoked' : 'expired' };
  }

  return {
    ok: true,
    identity: {
      userId: session.userId,
      sessionId: session.sessionId,
      familyId: session.familyId,
      expiresAt: verdict.session.expiresAt,
      mfaVerified: input.mfaVerified ?? false,
    },
  };
}

/** Pick the expiry policy for a role. One function so no call site invents its own. */
export function policyForRole(role: 'student' | 'teacher' | 'staff'): ExpiryPolicy {
  return DEFAULT_EXPIRY[role];
}

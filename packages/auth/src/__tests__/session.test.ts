/**
 * Session policy tests.  (P1-T1, INV-AUTH-1)
 *
 * ## The test this file exists for
 *
 * `describe('an attacker holding a stolen token')` below. Not because it is the most
 * numerous case, but because it is the one whose absence is a breach.
 *
 * The specific bug is the ORDERING inside `evaluateToken`: check expiry first, report
 * "expired", and the reuse is never noticed. Every test still passes, the user logs in
 * again, and the attacker's other sessions stay live indefinitely. Only a test that
 * deliberately presents a REVOKED token can catch that, so that is the test that exists.
 *
 * ## The clock
 *
 * Every test uses an explicit `now` rather than reading the wall clock, so the sliding-window
 * maths is exact instead of approximately right. A session test that uses real time is a
 * test that passes at 3am and fails on a slow CI runner.
 */

import { DAY, HOUR, type Millis } from '@orrery/clock';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EXPIRY,
  evaluateSession,
  evaluateToken,
  MAGIC_LINK,
  newSession,
  nextExpiry,
  revoke,
  revokeFamily,
  rotationReasonFor,
  SESSION_COOKIE,
  type SessionState,
} from '../session.js';

const T0: Millis = 1_700_000_000_000;
const policy = DEFAULT_EXPIRY.student;

const make = (over: Partial<SessionState> = {}): SessionState => ({
  userId: 'u-1',
  sessionId: 's-1',
  familyId: 'f-1',
  issuedAt: T0,
  expiresAt: T0 + policy.idle,
  revokedAt: null,
  revokedReason: null,
  slidCount: 0,
  ...over,
});

describe('sliding expiry with an absolute cap', () => {
  it('slides forward once the window is under half the idle limit', () => {
    const s = make();
    const now = T0 + 1.5 * HOUR; // 30 minutes left of a 2-hour window
    const r = evaluateSession(s, now, policy);
    expect(r.valid).toBe(true);
    expect(r.shouldSlide).toBe(true);
    expect(r.nextExpiresAt).toBe(now + policy.idle);
  });

  it('does NOT slide at exactly half the idle limit — the boundary is pinned, not assumed', () => {
    // `shouldSlide` is `remaining < idle / 2`, so the exact midpoint is a NO-slide. This was
    // the first test to fail in this file, because it was written assuming a slide at
    // `T0 + idle/2`. Pinning the boundary is the point: an off-by-one here means either a
    // write on every request or a window that never extends.
    const s = make();
    const r = evaluateSession(s, T0 + policy.idle / 2, policy);
    expect(r.valid).toBe(true);
    expect(r.shouldSlide).toBe(false);
  });

  it('does NOT slide on a burst of requests, to avoid a write per request', () => {
    const s = make();
    // Just after issue, the window is nearly full, so no write is needed.
    const r = evaluateSession(s, T0 + MINUTE_LATER, policy);
    expect(r.valid).toBe(true);
    expect(r.shouldSlide).toBe(false);
    expect(r.nextExpiresAt).toBe(nowish(T0 + MINUTE_LATER, policy));
  });

  it('honours the absolute cap even on a request just inside the idle window', () => {
    // The bug the cap exists to prevent. With idle=2h and absolute=12h, at t=11h the sliding
    // answer is 13h — which would be past the cap. Anchoring the cap to `issuedAt` (not to
    // the previous expiry) is what makes it hold.
    const s = make();
    const now = T0 + 11 * HOUR;
    const next = nextExpiry(s, now, policy);
    expect(next).toBe(T0 + policy.absolute);
    expect(next).toBeLessThan(now + policy.idle);
  });

  it('expires absolutely, even when the idle window is still open', () => {
    const s = make();
    const r = evaluateSession(s, T0 + policy.absolute, policy);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('absoluteExpired');
  });

  it('expires on idle, well before the absolute cap', () => {
    const s = make();
    const r = evaluateSession(s, T0 + policy.idle, policy);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('idleExpired');
  });

  it('cannot slide past the cap over many requests — the cap is a wall, not a suggestion', () => {
    // Simulate a real client: request every 10 minutes for a full day and track the window.
    let s = make();
    for (let elapsed = 0; elapsed <= 20 * HOUR; elapsed += 10 * MINUTE_LATER) {
      const r = evaluateSession(s, T0 + elapsed, policy);
      if (!r.valid) break;
      s = { ...s, expiresAt: r.nextExpiresAt, slidCount: s.slidCount + 1 };
    }
    expect(
      s.expiresAt,
      'a session must never be extended beyond the absolute cap',
    ).toBeLessThanOrEqual(T0 + policy.absolute);
  });
});

describe('a revoked session says it was revoked', () => {
  it('reports "revoked", not "idleExpired"', () => {
    // Found by the coverage report flagging this branch as untested. The branch returned
    // `reason: 'idleExpired'` for a revoked session — a false statement about why the
    // session died, and the kind that turns "you were removed from a classroom mid-exam"
    // into "your session expired, please log in again".
    const r = evaluateSession(revoke(make(), T0 + 1, 'userSuspended'), T0 + 2, policy);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('revoked');
    expect(r.shouldSlide).toBe(false);
  });

  it('revocation outranks BOTH kinds of expiry', () => {
    const revoked = revoke(make(), T0 + 1, 'userSuspended');
    for (const now of [T0 + policy.idle, T0 + policy.absolute, T0 + 99 * DAY]) {
      expect(evaluateSession(revoked, now, policy).reason, `at +${now - T0}ms`).toBe('revoked');
    }
  });
});

describe('role-based expiry', () => {
  it('gives a student a shorter idle window than a teacher', () => {
    // A student is mid-assessment constantly; a teacher prepares over days.
    expect(DEFAULT_EXPIRY.student.idle).toBeLessThan(DEFAULT_EXPIRY.teacher.idle);
  });

  it('gives every role a finite absolute cap', () => {
    for (const [role, p] of Object.entries(DEFAULT_EXPIRY)) {
      expect(p.absolute, `${role} must have an absolute cap`).toBeGreaterThan(0);
      expect(Number.isFinite(p.absolute), `${role} cap must be finite`).toBe(true);
    }
  });

  it('gives staff a shorter idle window than teachers, because staff hold the most power', () => {
    expect(DEFAULT_EXPIRY.staff.idle).toBeLessThan(DEFAULT_EXPIRY.teacher.idle);
  });
});

describe('revocation', () => {
  it('is idempotent, and the FIRST reason wins', () => {
    // A later "logout" must not overwrite the "passwordChanged" that actually explains why
    // the session died. The reason is evidence.
    const s = revoke(make(), T0 + 5, 'passwordChanged');
    const again = revoke(s, T0 + 9, 'logout');
    expect(again.revokedAt).toBe(T0 + 5);
    expect(again.revokedReason).toBe('passwordChanged');
  });

  it('revokes a whole family at once', () => {
    const family = [
      make({ sessionId: 's-1' }),
      make({ sessionId: 's-2' }),
      make({ sessionId: 's-3' }),
    ];
    const out = revokeFamily(family, T0 + 1, 'familyRotated');
    expect(out).toHaveLength(3);
    for (const s of out) expect(s.revokedReason).toBe('familyRotated');
  });

  it('leaves already-revoked members alone when revoking a family', () => {
    const family = [make({ sessionId: 's-1' }), revoke(make({ sessionId: 's-2' }), T0, 'logout')];
    const out = revokeFamily(family, T0 + 1, 'familyRotated');
    expect(out).toHaveLength(1);
    expect(out[0].sessionId).toBe('s-1');
  });
});

describe('THE test: an attacker holding a stolen token', () => {
  it('presents a token that was revoked when the password changed', () => {
    // Timeline: the attacker's token is revoked by a password change. The legitimate user
    // logs in again on a new family. Later the attacker retries the old token.
    const stolen = revoke(make({ familyId: 'f-old' }), T0 + 10, 'passwordChanged');

    const verdict = evaluateToken(stolen, T0 + 20, policy);

    // The verdict MUST be reuseDetected, not 'expired' and not 'revoked'.
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason, 'a revoked token is evidence of theft, not an expired session').toBe(
        'reuseDetected',
      );
    }
  });

  it('the reuse verdict survives even when the stolen token is ALSO long expired', () => {
    // This is the ordering bug in its purest form. A month later the stolen session is both
    // revoked and idle-expired. A naive implementation checks expiry first and reports
    // "idleExpired" — the security event never fires, and the attacker's remaining sessions
    // are never killed. The whole family stays alive.
    const stolen = revoke(make(), T0 + 10, 'passwordChanged');
    const muchLater = T0 + 40 * DAY;

    const verdict = evaluateToken(stolen, muchLater, policy);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason, 'revocation must outrank expiry in the verdict').toBe('reuseDetected');
    }
  });

  it('a live token from the same family is unaffected by the theft', () => {
    // The blast radius is the STOLEN family, not every session. Killing the legitimate
    // user's fresh session as well would be a denial of service the attacker can trigger.
    const attackerRow = revoke(make({ familyId: 'f-old' }), T0 + 10, 'passwordChanged');
    const victimRow = make({ familyId: 'f-new', sessionId: 's-new' });

    expect(evaluateToken(attackerRow, T0 + 20, policy).ok).toBe(false);
    expect(evaluateToken(victimRow, T0 + 20, policy).ok).toBe(true);
  });
});

describe('an unknown token is not a theft', () => {
  it('reports notFound, so a wrong password cannot look like an attack', () => {
    // Generic failure copy depends on this: `notFound` and `reuseDetected` must not be
    // distinguishable to the CALLER, or the endpoint becomes a token oracle. The difference
    // is server-side (does it raise a security event), not in what the response says.
    const verdict = evaluateToken(null, T0, policy);
    expect(verdict).toEqual({ ok: false, reason: 'notFound' });
  });

  it('reports the expiry reason verbatim, with no silent fallback', () => {
    // `evaluateToken` used to write `result.reason ?? 'idleExpired'`. That fallback was
    // unreachable, and it would have mislabelled an absolute-expiry as idle-expiry if it
    // ever were reachable. The discriminated union on SessionVerdict now makes it a type
    // error rather than a comment.
    expect(evaluateToken(make(), T0 + policy.idle, policy)).toEqual({
      ok: false,
      reason: 'idleExpired',
    });
    expect(evaluateToken(make(), T0 + policy.absolute, policy)).toEqual({
      ok: false,
      reason: 'absoluteExpired',
    });
  });
});

describe('rotation triggers', () => {
  it('maps every trigger to a distinct, persisted reason', () => {
    const reasons = (['passwordChanged', 'mfaChanged', 'emailChanged', 'roleChanged'] as const).map(
      rotationReasonFor,
    );
    expect(new Set(reasons).size, 'each trigger needs its own reason for the audit trail').toBe(4);
  });
});

describe('newSession', () => {
  it('clamps the first expiry to the absolute cap', () => {
    // A policy where idle > absolute must not produce a session born already-expired.
    const weird = { idle: 30 * DAY, absolute: 12 * HOUR };
    const s = newSession({ userId: 'u', sessionId: 's', familyId: 'f', now: T0, policy: weird });
    expect(s.expiresAt).toBe(T0 + weird.absolute);
    expect(evaluateSession(s, T0 + HOUR, weird).valid).toBe(true);
  });
});

describe('the cookie', () => {
  it('is a __Host- cookie, which makes three mistakes impossible at once', () => {
    // __Host- is enforced by the BROWSER: it rejects the cookie outright if Domain or a
    // path other than / is present. That is a guarantee we do not have to maintain.
    expect(SESSION_COOKIE.name.startsWith('__Host-')).toBe(true);
    expect(SESSION_COOKIE.path).toBe('/');
    expect('domain' in SESSION_COOKIE).toBe(false);
  });

  it('is HttpOnly and Secure, with no way to opt out', () => {
    expect(SESSION_COOKIE.httpOnly).toBe(true);
    expect(SESSION_COOKIE.secure).toBe(true);
  });

  it('is SameSite=Lax rather than Strict, so a magic link opened from mail still works', () => {
    // Strict would break the one legitimate cross-site navigation in the product. Not
    // `None`, because that would permit CSRF against every mutating route.
    expect(SESSION_COOKIE.sameSite).toBe('Lax');
  });
});

describe('magic links', () => {
  it('are single use, short lived, and invalidate the family on use', () => {
    expect(MAGIC_LINK.ttl).toBe(15 * MINUTE_LATER);
    expect(MAGIC_LINK.singleUse).toBe(true);
    expect(MAGIC_LINK.invalidatesFamilyOnUse).toBe(true);
  });
});

// Local aliases so the intent of the arithmetic above is readable without importing five
// more names at the top.
const MINUTE_LATER = 60_000;
const nowish = (t: Millis, p: typeof policy): Millis => Math.min(t + p.idle, T0 + p.absolute);

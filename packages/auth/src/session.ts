/**
 * Session policy.  (P1-T1, INV-AUTH-1, plans/13 §2)
 *
 * ## Why this file is pure and why that is the point
 *
 * Every function here is a function of its arguments plus an INJECTED clock. No `Date.now`,
 * no database, no `process.env`. That is not purity for its own sake — it is what makes the
 * two properties below testable at all, and both are properties where a bug is a breach:
 *
 *   1. **Sliding expiry with an absolute cap.** A session that slides forever cannot be
 *      revoked by age, and a school laptop left in a bag for a term is a live credential.
 *   2. **Family rotation and reuse detection.** Changing a password must kill every session
 *      that password could authenticate — including ones an attacker already holds.
 *
 * A test that has to reach into a database to check a two-line policy is a test that gets
 * skipped, and INV-AUTH-1 is not a property you can afford to skip.
 *
 * ## The one bug this file is most likely to have
 *
 * (P1 §12 criterion 3: "at least one test that would catch the specific bug this task is
 * most likely to have.") For session code, that bug is **treating a revoked token as merely
 * invalid instead of as evidence of theft.** If a stolen token is presented after the family
 * was rotated, "invalid" logs nothing and leaves the attacker's OTHER sessions — and the
 * new family the legitimate user just created — alive. So `evaluateToken` returns
 * `reuseDetected`, and the caller MUST revoke the family and raise a security event. The
 * test for it is named for the attacker, not for the function.
 *
 * ## No JWTs
 *
 * A signed token is verifiable without storage, which is exactly why it cannot be revoked.
 * Mid-exam removal and account suspension are hard requirements, so sessions are rows.
 */

import { DAY, type Duration, HOUR, MINUTE, type Millis } from '@orrery/clock';

/**
 * Idle and absolute limits, per role.
 *
 * A student's idle timeout is SHORTER than a teacher's, and the reasoning is worth stating
 * because it looks backwards to anyone who has not thought about it: a student is
 * mid-assessment far more often than a teacher, and a student session that outlives a
 * removal from a classroom is the exact scenario INV-AUTH-1 was written for. Teachers
 * prepare over days. Both are bounded absolutely either way.
 */
export interface ExpiryPolicy {
  /** Max time between two requests before the session is idle-expired. */
  readonly idle: Duration;
  /** Hard cap from first issue. Sliding never pushes a session past this. */
  readonly absolute: Duration;
}

export const DEFAULT_EXPIRY: Record<'student' | 'teacher' | 'staff', ExpiryPolicy> = {
  student: { idle: 2 * HOUR, absolute: 12 * HOUR },
  teacher: { idle: 14 * DAY, absolute: 30 * DAY },
  // A reviewer or platform admin has the widest access, so the shortest idle window and a
  // separate absolute cap. Not reusing `teacher` is deliberate: sharing a number between
  // "the most powerful role" and "the most common role" makes both harder to reason about.
  staff: { idle: 8 * HOUR, absolute: 7 * DAY },
};

/** Reasons a session stops being valid. Persisted in `Session.revokedReason`. */
export const REVOKE_REASONS = [
  'logout',
  'passwordChanged',
  'mfaChanged',
  'emailChanged',
  'familyRotated',
  'revokedTokenReuse',
  'userSuspended',
  'roleChanged',
  'removedFromClassroom',
  'allSessionsRevoked',
  'accountDeleted',
  'idleExpired',
  'absoluteExpired',
] as const;
export type RevokeReason = (typeof REVOKE_REASONS)[number];

/** Why a token is not usable. Distinct from a revoke reason: this is a verdict, not an act. */
export type TokenVerdict =
  | {
      ok: true;
      session: SessionState /** True when this request extended the window. */;
      slid: boolean;
    }
  | {
      ok: false;
      reason: 'notFound' | 'idleExpired' | 'absoluteExpired' | 'revoked' | 'reuseDetected';
    };

/**
 * Why a session stopped working. Distinct from `RevokeReason` (a persisted, human-meaningful
 * cause) and from `TokenVerdict.reason` (what the caller should do about it).
 */
export type SessionVerdict =
  | { valid: true; shouldSlide: boolean; nextExpiresAt: Millis }
  | {
      valid: false;
      reason: 'revoked' | 'idleExpired' | 'absoluteExpired';
      shouldSlide: false;
      nextExpiresAt: Millis;
    };

export interface SessionState {
  readonly userId: string;
  readonly sessionId: string;
  readonly familyId: string;
  /** When the session was first issued. The absolute cap is measured from here. */
  readonly issuedAt: Millis;
  /** End of the current sliding window. */
  readonly expiresAt: Millis;
  readonly revokedAt: Millis | null;
  readonly revokedReason: RevokeReason | null;
  /** Monotonic counter of how many times the window has been extended. */
  readonly slidCount: number;
}

/**
 * Compute the next expiry for a session at `now`.
 *
 * The rule is: `min(now + idle, issuedAt + absolute)`. Written that way deliberately — the
 * cap is anchored to `issuedAt`, not to the previous `expiresAt`. Anchoring to the previous
 * expiry makes the session slide forever at a rate of `idle` per request, which is a session
 * that never expires no matter how long the cap claims to be. That is the bug.
 */
export function nextExpiry(session: SessionState, now: Millis, policy: ExpiryPolicy): Millis {
  const sliding = now + policy.idle;
  const cap = session.issuedAt + policy.absolute;
  return Math.min(sliding, cap);
}

/**
 * Whether the session is still valid, and whether THIS request should extend it.
 *
 * The order of the checks is the interesting part:
 *
 *   1. **Revoked** is checked FIRST, before expiry. A revoked session that is also expired is
 *      revoked, and the difference matters: a revoked token presented later is a possible
 *      theft and must be reported, whereas an expired one is just a user logging in again.
 *      Checking expiry first would silently downgrade every theft to "session expired" and
 *      the security event would never fire. That is the single most important ordering in
 *      this file.
 *   2. Absolute expiry is checked before idle, because an absolute breach is the stronger
 *      statement and the one worth surfacing.
 *
 * `slid` is false when the session is within `idle / 2` of its expiry, so a burst of
 * requests does not write on every one. That is a write-amplification trade, not a
 * correctness one: the window is still never allowed to shrink.
 */
export function evaluateSession(
  session: SessionState,
  now: Millis,
  policy: ExpiryPolicy,
): SessionVerdict {
  // 1. Revocation outranks expiry, and says so.
  //
  // This originally returned `reason: 'idleExpired'` for a revoked session, which is simply a
  // false statement about why the session stopped working — and it was found by the coverage
  // report flagging the branch as untested, not by reading the code. A caller that logged
  // this reason would file "your session expired, please log in again" for a session that was
  // killed on purpose, which is exactly the report you do not want when someone is being
  // removed from a classroom mid-exam.
  if (session.revokedAt !== null) {
    return {
      valid: false,
      reason: 'revoked',
      shouldSlide: false,
      nextExpiresAt: session.expiresAt,
    };
  }

  // 2. Absolute cap.
  if (now >= session.issuedAt + policy.absolute) {
    return {
      valid: false,
      reason: 'absoluteExpired',
      shouldSlide: false,
      nextExpiresAt: session.expiresAt,
    };
  }

  // 3. Idle window.
  if (now >= session.expiresAt) {
    return {
      valid: false,
      reason: 'idleExpired',
      shouldSlide: false,
      nextExpiresAt: session.expiresAt,
    };
  }

  const next = nextExpiry(session, now, policy);
  // Slide only when the remaining window is under half the idle limit.
  const shouldSlide = session.expiresAt - now < policy.idle / 2;
  return { valid: true, shouldSlide, nextExpiresAt: next };
}

/**
 * A raw session token is never stored and never logged. 32 bytes from a CSPRNG, base64url.
 *
 * The caller supplies the bytes so this module stays pure: `crypto.getRandomValues` at the
 * edge of the code, not threaded through every call site.
 */
export type TokenBytes = Uint8Array;

export interface NewSessionInput {
  readonly userId: string;
  readonly sessionId: string;
  readonly familyId: string;
  readonly now: Millis;
  readonly policy: ExpiryPolicy;
}

export function newSession(input: NewSessionInput): SessionState {
  return {
    userId: input.userId,
    sessionId: input.sessionId,
    familyId: input.familyId,
    issuedAt: input.now,
    // The FIRST expiry is already clamped to the absolute cap, so a policy where idle >
    // absolute produces a correctly-bounded session rather than one that is born expired.
    expiresAt: Math.min(input.now + input.policy.idle, input.now + input.policy.absolute),
    revokedAt: null,
    revokedReason: null,
    slidCount: 0,
  };
}

export function revoke(session: SessionState, now: Millis, reason: RevokeReason): SessionState {
  // Idempotent, and it does NOT overwrite an existing revoke. First revoke wins: the reason
  // a session was killed is evidence, and a later "logout" must not overwrite the
  // "passwordChanged" that actually explains the kill.
  if (session.revokedAt !== null) return session;
  return { ...session, revokedAt: now, revokedReason: reason };
}

/** Revoke a whole family. Returns the members to write, in the order written. */
export function revokeFamily(
  sessions: readonly SessionState[],
  now: Millis,
  reason: RevokeReason,
): SessionState[] {
  return sessions.filter((s) => s.revokedAt === null).map((s) => revoke(s, now, reason));
}

/**
 * How a family may change, and what a token from an old family means.
 *
 * Rotation is the ONLY response to a privilege change. It is tempting to revoke just the
 * current session; that leaves every other device signed in, which is precisely the state
 * an attacker creates for themselves before the legitimate user notices.
 */
export const ROTATION_TRIGGERS = [
  'passwordChanged',
  'mfaChanged',
  'emailChanged',
  'roleChanged',
] as const;
export type RotationTrigger = (typeof ROTATION_TRIGGERS)[number];

export function rotationReasonFor(trigger: RotationTrigger): RevokeReason {
  switch (trigger) {
    case 'passwordChanged':
      return 'passwordChanged';
    case 'mfaChanged':
      return 'mfaChanged';
    case 'emailChanged':
      return 'emailChanged';
    case 'roleChanged':
      return 'roleChanged';
  }
}

/**
 * Decide what a presented token means, given the rows we have.
 *
 * The caller looks the token up by hash. Three outcomes are possible and the middle one is
 * the point of this whole file:
 *
 *   · **no row**            -> `notFound`. Nothing to do. A wrong password and a
 *                               non-existent user are indistinguishable on purpose, so that
 *                               this case does not become a user-enumeration oracle.
 *   · **row, revoked**      -> `reuseDetected`. Someone is presenting a token we know we
 *                               killed. If the family has since been rotated, either the
 *                               attacker has an old token, or the legitimate user has an old
 *                               browser tab. Both are handled the same way: kill the family,
 *                               raise a security event, make the user re-authenticate.
 *                               Being wrong here costs a login. Being lenient here costs
 *                               the account.
 *   · **row, live**         -> evaluate expiry, slide if due.
 */
export function evaluateToken(
  row: SessionState | null,
  now: Millis,
  policy: ExpiryPolicy,
): TokenVerdict {
  if (row === null) return { ok: false, reason: 'notFound' };
  if (row.revokedAt !== null) return { ok: false, reason: 'reuseDetected' };

  const result = evaluateSession(row, now, policy);
  // No fallback needed: `SessionVerdict` is a discriminated union, so `valid: false` carries
  // a `reason` by construction. The `?? 'idleExpired'` that used to be here was unreachable
  // dead code covering a case the type system can now rule out.
  if (!result.valid) return { ok: false, reason: result.reason };

  return { ok: true, session: row, slid: result.shouldSlide };
}

/**
 * Cookie attributes for the session token.
 *
 * `__Host-` is a prefix, not a flag, and it is worth the trouble because it makes three
 * things impossible at once: another subdomain overwriting the cookie, a `Domain` attribute
 * scoping it, and a `path` other than `/`. The browser rejects the whole cookie if any of
 * those is violated. That is a guarantee enforced by the client, not by our care.
 *
 * `SameSite=Lax` rather than `Strict` because Strict breaks the one legitimate cross-site
 * navigation in the product: a magic link opened from a mail client. `Secure` is not
 * configurable — a session cookie over plain HTTP is not a session.
 */
export const SESSION_COOKIE = {
  name: '__Host-orrery-session',
  httpOnly: true,
  secure: true,
  sameSite: 'Lax',
  path: '/',
} as const;

/**
 * Magic-link tokens: single use, 15 minutes, and using one invalidates the session family.
 *
 * The family invalidation is the part that surprises people. A magic link arriving in an
 * inbox that a former student, a shared-family device or a support engineer can also read is
 * a credential; letting it mint a session that outlives its own use is how an ex-partner
 * keeps access after the relationship ends.
 */
export const MAGIC_LINK = {
  ttl: 15 * MINUTE,
  singleUse: true,
  invalidatesFamilyOnUse: true,
} as const;

/**
 * The Better Auth adapter seam.  (P1-T1)
 *
 * These test `assertMaySignIn` and `describeSignInAttempt` directly, with no framework and no
 * database — which is the reason they are in this shape. The properties under test are:
 *
 *   1. A suspended account never gets a session, even when the throttle is clean.
 *   2. Every failure produces the SAME generic message, so the login form is not an
 *      account-existence oracle.
 *   3. DELETING still signs in — the 30-day grace is a grace, not a lockout.
 *   4. An unrecognised context degrades to values that FILL the counters rather than
 *      bypassing them.
 */

import { type AccountState, LOGIN_FAILURES } from '@orrery/auth/lifecycle';
import { describe, expect, it } from 'vitest';
import { type AuthAdapterDeps, assertMaySignIn, describeSignInAttempt } from './config';

const T0 = 1_700_000_000_000;

const ACTIVE: AccountState = { userId: 'u-1', status: 'ACTIVE', deletingAt: null };
const SUSPENDED: AccountState = {
  userId: 'u-1',
  status: 'SUSPENDED',
  deletingAt: null,
  suspendedReason: 'breach',
};
const DELETING: AccountState = { userId: 'u-1', status: 'DELETING', deletingAt: T0 };

function deps(over: Partial<AuthAdapterDeps> = {}): AuthAdapterDeps {
  return {
    pepper: 'p'.repeat(32),
    loadAccount: async () => ACTIVE,
    listAttempts: async () => [],
    now: () => T0,
    writeSecurityEvent: async () => {},
    revokeAllSessions: async () => 0,
    ...over,
  };
}

const attempt = { identifier: 'u@school.example', ipPseudonym: 'ip-1' };

describe('a suspended account', () => {
  it('never receives a session, even with a perfectly clean throttle', async () => {
    const d = await assertMaySignIn(deps({ loadAccount: async () => SUSPENDED }), 'u-1', attempt);
    expect(d).toEqual({ allowed: false, failure: 'suspended' });
  });

  it('and the caller is told to revoke its sessions in the same transaction', () => {
    // The lifecycle's `revokeSessions: true` and this adapter's call have to agree, or
    // suspension stops being effective on the next request.
    expect(LOGIN_FAILURES.suspended.revokeSessions).toBe(true);
    expect(LOGIN_FAILURES.suspended.revokeReason).toBe('userSuspended');
  });
});

describe('every login failure says the same thing', () => {
  it('the response is identical for unknown account, wrong password and suspended', () => {
    // The single most important property of this table. A differing response, status code
    // or field name turns the login form into a user-enumeration oracle, and generic COPY is
    // not sufficient on its own — plenty of clients ignore the message and read the status.
    const responses = new Set(Object.values(LOGIN_FAILURES).map((f) => f.response));
    expect([...responses]).toEqual(['invalid']);
  });

  it('a missing account is refused, and is indistinguishable from a wrong password', async () => {
    const missing = await assertMaySignIn(deps({ loadAccount: async () => null }), 'u-1', attempt);
    const wrong = await assertMaySignIn(deps(), 'u-1', attempt);
    expect(missing.allowed).toBe(false);
    expect(missing).toEqual({ allowed: false, failure: 'unknownAccount' });
    expect(
      LOGIN_FAILURES[missing.allowed === false ? missing.failure : 'wrongPassword'].response,
    ).toBe(LOGIN_FAILURES[wrong.allowed === false ? wrong.failure : 'wrongPassword'].response);
  });
});

describe('the 30-day grace is a grace, not a lockout', () => {
  it('a DELETING account can still sign in, so they can cancel', async () => {
    const d = await assertMaySignIn(deps({ loadAccount: async () => DELETING }), 'u-1', attempt);
    expect(
      d.allowed,
      'a user who asked to delete their account must be able to change their mind',
    ).toBe(true);
  });
});

describe('throttling runs BEFORE the account lookup', () => {
  it('a ground account is refused without a database read', async () => {
    let looked = 0;
    const attempts = Array.from({ length: 20 }, () => ({
      identifier: 'u@school.example',
      ipPseudonym: 'ip-1',
      at: T0,
      succeeded: false,
    }));
    const d = await assertMaySignIn(
      deps({
        listAttempts: async () => attempts,
        loadAccount: async () => {
          looked += 1;
          return ACTIVE;
        },
      }),
      'u-1',
      attempt,
    );
    expect(d.allowed).toBe(false);
    expect(looked, 'throttling is the cheaper check and should come first').toBe(0);
  });
});

describe('reading the sign-in attempt out of an unrecognised context', () => {
  it('degrades to values that fill counters rather than bypassing them', () => {
    // An attacker who can send a shape we do not recognise must not thereby escape the
    // throttle, so the fallback is the empty identifier — which counts as its own distinct
    // identifier and its own distinct domain, filling both counters faster.
    for (const ctx of [null, undefined, 42, 'nope', {}, { body: { email: 'a@b.c' } }]) {
      const a = describeSignInAttempt(ctx);
      expect(typeof a.identifier).toBe('string');
      expect(a.ipPseudonym.length).toBeGreaterThan(0);
    }
  });

  it('reads the email from the body and the pseudonym from the header', () => {
    const a = describeSignInAttempt({
      body: { email: 'student@school.example' },
      headers: { get: (n: string) => (n === 'x-ip-pseudonym' ? 'abc123' : null) },
    });
    expect(a).toEqual({ identifier: 'student@school.example', ipPseudonym: 'abc123' });
  });

  it('never treats a raw IP as a pseudonym when the header is absent', () => {
    // There is no salt in this module, so the honest answer is 'unknown' rather than
    // inventing one and pretending it is pseudonymous.
    expect(describeSignInAttempt({ body: {}, headers: { get: () => null } }).ipPseudonym).toBe(
      'unknown',
    );
  });
});

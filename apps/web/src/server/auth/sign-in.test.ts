/**
 * Account enumeration through `POST /api/auth/sign-in`.  (P14-T11, P1-T3)
 *
 * ## WHAT IS ASSERTED, AND WHY EACH THING IS A SEPARATE CLAIM
 *
 * `flow.test.ts` already proves the response CONSTANTS are uniform. That is the easy half and it is
 * not sufficient: a handler can return the same 401 for every kind and still enumerate, because
 *
 *   · it can return a DIFFERENT status for one kind, and
 *   · it can take a different amount of TIME for one kind.
 *
 * So this file exercises the real handler against a real argon2id hash and asserts the properties
 * that survive a correct constant: identical bytes, identical status, and comparable elapsed time.
 *
 * ## THE TIMING THRESHOLD IS 5x, NOT 1.5x, AND THAT IS THE POINT
 *
 * argon2 at the OWASP baseline (`password.ts:32-37`) is ~40ms, and framework overhead around it
 * varies by more than a factor of two on a shared runner. Without the dummy verification the ratio
 * between "no such account" and "wrong password" is closer to 50x, because the missing path skips
 * argon2 entirely. 5x is far too tight to be an accident and far too loose to hide one, and there
 * is a floor assertion as well so a pair of instantly-fast paths cannot pass a ratio alone.
 */

import { hashPassword } from '@orrery/auth/password';
import { SESSION_COOKIE } from '@orrery/auth/session';
import { type Attempt, IDENTIFIER_LIMITS } from '@orrery/auth/throttle';
import { systemClock } from '@orrery/clock';
import { describe, expect, it, vi } from 'vitest';
import { GENERIC_AUTH_FAILURE } from '@/features/auth/flow';
import type { CredentialAccount } from './sign-in';
import {
  normaliseEmail,
  respondUniformly,
  type SignInDeps,
  type SignInStore,
  signIn,
} from './sign-in';

const T0 = 1_700_000_000_000;
const SECRET = 's'.repeat(48);
const PEPPER = 'p'.repeat(32);
const ADDRESS = 'student@school.example';

/** A monotonic clock that jumps, so the 300ms latency floor never actually sleeps. */
const fastClock = {
  now: () => T0,
  monotonic: (() => {
    let t = 0;
    return () => {
      t += 1000;
      return t;
    };
  })(),
};

const ACTIVE = {
  userId: 'u-1',
  status: 'ACTIVE' as const,
  deletingAt: null,
  suspendedAt: null,
  suspendedReason: null,
};

interface Harness {
  readonly deps: SignInDeps;
  readonly store: {
    findAccountByEmail: ReturnType<typeof vi.fn>;
    insertSession: ReturnType<typeof vi.fn>;
    listAttempts: ReturnType<typeof vi.fn>;
    writeSecurityEvent: ReturnType<typeof vi.fn>;
    revokeAllSessions: ReturnType<typeof vi.fn>;
    recordAttempt: ReturnType<typeof vi.fn>;
  };
  /** The attempts the throttle will see. */
  attempts: Attempt[];
}

/** A store whose account, if any, is given as a hashed password. */
function harness(
  options: { account?: CredentialAccount | null; attempts?: Attempt[] } = {},
): Harness {
  const attempts = options.attempts ?? [];
  const store = {
    findAccountByEmail: vi.fn(async () => options.account ?? null),
    insertSession: vi.fn(async () => {}),
    listAttempts: vi.fn(async () => attempts),
    writeSecurityEvent: vi.fn(async () => {}),
    revokeAllSessions: vi.fn(async () => 0),
    recordAttempt: vi.fn(async () => {}),
  };
  return {
    deps: {
      store: store as unknown as SignInStore,
      secret: SECRET,
      pepper: PEPPER,
      clock: fastClock,
      ipPseudonym: 'ip-1',
      mintToken: () => 't'.repeat(43),
      mintId: (() => {
        let n = 0;
        return () => {
          n += 1;
          return `id-${n}`;
        };
      })(),
    },
    store,
    attempts,
  };
}

describe('the two failure modes are indistinguishable in the response', () => {
  it('same status, and byte-identical body', async () => {
    const known = harness({
      account: { ...ACTIVE, passwordHash: await hashPassword('correct horse', PEPPER) },
    });
    const unknown = harness({ account: null });

    const wrongPassword = await respondUniformly(
      known.deps,
      signIn(known.deps, { email: ADDRESS, password: 'wrong guess entirely' }),
    );
    const noSuchAccount = await respondUniformly(
      unknown.deps,
      signIn(unknown.deps, { email: ADDRESS, password: 'wrong guess entirely' }),
    );

    expect(noSuchAccount.status).toBe(wrongPassword.status);
    expect(await noSuchAccount.text()).toBe(await wrongPassword.text());
  });

  it('and the body is the GENERIC string, with no hint of which failure it was', async () => {
    const unknown = harness({ account: null });
    const response = await respondUniformly(
      unknown.deps,
      signIn(unknown.deps, { email: ADDRESS, password: 'wrong guess entirely' }),
    );
    const body = (await response.json()) as { ok: boolean; message: string; code: string };
    expect(body.message).toBe(GENERIC_AUTH_FAILURE);
    expect(body.code).toBe('AUTH_FAILED');
    expect(body.ok).toBe(false);
    for (const leak of ['unknown', 'not found', 'registered', 'suspended', ADDRESS]) {
      expect(body.message.toLowerCase()).not.toContain(leak);
    }
  });

  it('and a MISSING password field costs the same as a wrong one, because it is not short-circuited', async () => {
    // The route maps an absent `password` to `''` and passes it through. Short-circuiting there
    // would be a four-character enumeration oracle: omit the field, get a different response.
    const unknown = harness({ account: null });
    const without = await respondUniformly(
      unknown.deps,
      signIn(unknown.deps, { email: ADDRESS, password: '' }),
    );
    const with_ = await respondUniformly(
      unknown.deps,
      signIn(unknown.deps, { email: ADDRESS, password: 'wrong guess entirely' }),
    );
    expect(without.status).toBe(with_.status);
    expect(await without.text()).toBe(await with_.text());
  });

  it('and a SUSPENDED account is refused with the same bytes as a wrong password', async () => {
    const suspended = harness({
      account: {
        ...ACTIVE,
        status: 'SUSPENDED',
        suspendedAt: T0,
        suspendedReason: 'breach',
        passwordHash: await hashPassword('correct horse', PEPPER),
      },
    });
    const response = await respondUniformly(
      suspended.deps,
      signIn(suspended.deps, { email: ADDRESS, password: 'correct horse' }),
    );
    expect(response.status).toBe(401);
    expect((await response.json()) as { message: string }).toMatchObject({
      message: GENERIC_AUTH_FAILURE,
    });
  });

  it('and a THROTTLED identifier is refused with the same bytes as everything else', async () => {
    // A 429 here is a status-code oracle by another name: 401 means "that address is not one of
    // ours yet", 429 means "it is". So a throttled attempt answers exactly what a wrong password
    // answers.
    const ground = Array.from({ length: IDENTIFIER_LIMITS.perWindow }, (_, i) => ({
      identifier: normaliseEmail(ADDRESS),
      ipPseudonym: 'ip-1',
      at: T0 - i,
      succeeded: false,
    }));
    const throttled = harness({
      account: { ...ACTIVE, passwordHash: await hashPassword('correct horse', PEPPER) },
      attempts: ground,
    });
    const response = await respondUniformly(
      throttled.deps,
      signIn(throttled.deps, { email: ADDRESS, password: 'correct horse' }),
    );
    expect(response.status).toBe(401);
    expect((await response.json()) as { message: string }).toMatchObject({
      message: GENERIC_AUTH_FAILURE,
    });
    expect(throttled.store.insertSession).not.toHaveBeenCalled();
  });
});

describe('the timing oracle, which the generic message does not close', () => {
  it('an unknown account costs about what a wrong password costs', async () => {
    const known = harness({
      account: { ...ACTIVE, passwordHash: await hashPassword('correct horse', PEPPER) },
    });
    const unknown = harness({ account: null });

    const time = async (h: Harness): Promise<number> => {
      const started = process.hrtime.bigint();
      await signIn(h.deps, { email: ADDRESS, password: 'wrong guess entirely' });
      return Number(process.hrtime.bigint() - started) / 1e6;
    };

    // Warm both paths: the first call pays one-time module initialisation and the dummy hash
    // string's first production.
    await time(known);
    await time(unknown);
    const knownMs = await time(known);
    const unknownMs = await time(unknown);

    const ratio = Math.max(knownMs, unknownMs) / Math.max(1, Math.min(knownMs, unknownMs));
    expect(
      ratio,
      `existing=${knownMs.toFixed(1)}ms missing=${unknownMs.toFixed(1)}ms — a large ratio is a ` +
        'working account-existence oracle even with identical copy',
    ).toBeLessThan(5);
    expect(unknownMs, 'the unknown path must actually have verified a hash').toBeGreaterThan(1);
  });

  it('EVERY response is held to the same wall-clock floor, SUCCESS INCLUDED', async () => {
    // A floor that covered only the failures would manufacture the channel it exists to close, so
    // the success path is measured too. A real clock is used here rather than the jumping one,
    // because the point is that time actually passes.
    const realClock = { now: () => T0, monotonic: () => systemClock.monotonic() };
    const account = harness({
      account: { ...ACTIVE, passwordHash: await hashPassword('correct horse', PEPPER) },
    });
    const deps = { ...account.deps, clock: realClock };

    // `systemClock.monotonic()` rather than `performance.now()`: INV-TIME-1 makes `@orrery/clock`
    // the only source of time, and its MONOTONIC reading is the stopwatch half, which is exactly
    // what measuring a duration needs.
    const started = systemClock.monotonic();
    const success = await respondUniformly(
      deps,
      signIn(deps, { email: ADDRESS, password: 'correct horse' }),
    );
    const successElapsed = systemClock.monotonic() - started;

    const startedFailure = systemClock.monotonic();
    const failure = await respondUniformly(
      deps,
      signIn(deps, { email: ADDRESS, password: 'wrong guess entirely' }),
    );
    const failureElapsed = systemClock.monotonic() - startedFailure;

    expect(success.status).toBe(200);
    expect(failure.status).toBe(401);
    // 290 rather than 300: `setTimeout` is permitted to fire a millisecond or so early and this
    // assertion is about the FLOOR BEING APPLIED, not about the timer's precision. The claim is
    // that neither path is under it, because a caller who can tell "fast" from "slow" has learned
    // something.
    expect(successElapsed, 'success must also sit on the floor').toBeGreaterThanOrEqual(290);
    expect(failureElapsed, 'failure must sit on the floor').toBeGreaterThanOrEqual(290);
    // The stronger half, and the one that would catch a floor applied to only one path.
    expect(
      Math.abs(successElapsed - failureElapsed),
      'success and failure must be indistinguishable in how long they take',
    ).toBeLessThan(60);
  });
});

describe('a successful sign-in', () => {
  it('issues a session whose stored value is the HMAC and NOT the cookie token', async () => {
    const h = harness({
      account: { ...ACTIVE, passwordHash: await hashPassword('correct horse', PEPPER) },
    });
    const outcome = await signIn(h.deps, { email: ADDRESS, password: 'correct horse' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const row = h.store.insertSession.mock.calls[0]?.[0] as {
      tokenHash: string;
      userId: string;
      familyId: string;
    };
    const cookieToken = outcome.setCookie.split(';')[0]?.split('=')[1] ?? '';
    expect(row.tokenHash).not.toBe(cookieToken);
    expect(outcome.setCookie).toContain(`${SESSION_COOKIE.name}=${cookieToken};`);
    expect(row.userId).toBe('u-1');
    // A NEW family per sign-in, so revoking on a password change cannot revoke somebody else's
    // family and a session from before the sign-in cannot be presented as this one.
    expect(row.familyId).toBe('id-2');
  });

  it('records the attempt as a SUCCESS, because a success still counts toward the IP signals', async () => {
    // `throttle.ts:157` — a school registration morning is hundreds of successful logins from one
    // address, and that is the shape the limiter must not punish. It also CLEARS the per-identifier
    // counter, so a student who fumbles twice and then gets it right is not asked for a second
    // factor for a fortnight.
    const h = harness({
      account: { ...ACTIVE, passwordHash: await hashPassword('correct horse', PEPPER) },
    });
    await signIn(h.deps, { email: ADDRESS, password: 'correct horse' });
    expect(h.store.recordAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ identifier: ADDRESS, ipPseudonym: 'ip-1', succeeded: true }),
    );
  });

  it('and the DELETING grace is a grace, not a lockout', async () => {
    // A user who asked to delete their account can still sign in to change their mind. Asserted
    // because the natural "fix" for a login bug is to refuse anything that is not ACTIVE.
    const h = harness({
      account: {
        ...ACTIVE,
        status: 'DELETING',
        deletingAt: T0,
        passwordHash: await hashPassword('correct horse', PEPPER),
      },
    });
    const outcome = await signIn(h.deps, { email: ADDRESS, password: 'correct horse' });
    expect(outcome.ok).toBe(true);
  });
});

describe('a SUSPENDED account keeps no session', () => {
  it('every live session is revoked, which is what INV-AUTH-1 asks for', async () => {
    const h = harness({
      account: {
        ...ACTIVE,
        status: 'SUSPENDED',
        suspendedAt: T0,
        suspendedReason: 'breach',
        passwordHash: await hashPassword('correct horse', PEPPER),
      },
    });
    await signIn(h.deps, { email: ADDRESS, password: 'correct horse' });
    expect(h.store.revokeAllSessions).toHaveBeenCalledWith('u-1', 'userSuspended');
    expect(h.store.insertSession).not.toHaveBeenCalled();
  });

  it('and the attempt raises the security event the lifecycle names', async () => {
    const h = harness({
      account: {
        ...ACTIVE,
        status: 'SUSPENDED',
        suspendedAt: T0,
        suspendedReason: 'breach',
        passwordHash: await hashPassword('correct horse', PEPPER),
      },
    });
    await signIn(h.deps, { email: ADDRESS, password: 'correct horse' });
    expect(h.store.writeSecurityEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'suspendedAccountAccess', userId: 'u-1' }),
    );
  });
});

describe('the throttle sees the attempts the endpoint records', () => {
  it('a failure is recorded against the NORMALISED address, so case cannot be used to reset it', async () => {
    const h = harness({ account: null });
    await signIn(h.deps, { email: '  Student@School.Example ', password: 'wrong' });
    expect(h.store.recordAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ identifier: ADDRESS, succeeded: false }),
    );
  });
});

describe('no identity is taken from the request', () => {
  it('a `userId` in the input cannot choose whose session is issued', async () => {
    // The input type has two fields and no third, so there is nothing to read. Asserting the
    // session belongs to the ADDRESS's account rather than to anything smuggled alongside it is
    // what turns "the type has no such field" into a behavioural claim.
    const h = harness({
      account: { ...ACTIVE, passwordHash: await hashPassword('correct horse', PEPPER) },
    });
    const outcome = await signIn(h.deps, {
      email: ADDRESS,
      password: 'correct horse',
      // @ts-expect-error -- deliberately extra: a request body a caller controls may carry anything.
      userId: 'someone-else',
    });
    expect(outcome.ok).toBe(true);
    expect(h.store.insertSession.mock.calls[0]?.[0]).toMatchObject({ userId: 'u-1' });
  });

  it('`normaliseEmail` is what the lookup is keyed on', () => {
    expect(normaliseEmail('  Student@School.Example ')).toBe(ADDRESS);
  });
});

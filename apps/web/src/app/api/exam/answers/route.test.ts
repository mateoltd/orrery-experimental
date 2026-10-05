/**
 * The answers route's caller handling.  (P14-T11, P8-T9)
 *
 * ## THE PROPERTY UNDER TEST IS A PAIR, AND THE SECOND HALF IS THE ONE THAT CHANGED
 *
 *   1. No session means no data. That half was already true — the route read
 *      `ORRERY_DEV_USER_ID` and returned `null` when it was unset, so it failed closed.
 *   2. **A caller reaching for somebody else's attempt gets the SAME response as a caller with no
 *      session at all.** That half was not true: the not-yours case answered `403 FORBIDDEN` while
 *      the anonymous case answered `401 UNAUTHENTICATED`, and the difference confirms that the row
 *      exists. Over a school, that is a directory of every sitting.
 *
 * So the assertion is `expect(notMine.text).toBe(anonymous.text)` and `expect(notMine.status).toBe(
 * anonymous.status)` — not two separate assertions that each refusal is a refusal, which is what the
 * route did before and which is why the oracle shipped.
 *
 * ## THE ROUTE RUNS FOR REAL; ONLY PRISMA IS FAKED
 *
 * `requireUser` is NOT mocked. A test that replaced the session reader with a stub would assert
 * that the route calls something it was told to call, which is the shape of test that passes
 * forever. Instead a real `Session` row is written into the fake database and the real cookie is
 * presented, so `hashToken`, `evaluateToken` and the `__Host-` parse all execute.
 */

import { SESSION_COOKIE } from '@orrery/auth/session';
import { hashToken } from '@orrery/auth/token';
import { systemClock } from '@orrery/clock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from './route';

const SECRET = 's'.repeat(48);
const TOKEN = 'k'.repeat(43);
const OWNER = 'u-owner';
const OTHER = 'u-other';

// Parameterised, so `mock.calls[n]` is typed as a tuple and the assertions below can read an
// argument. A zero-argument mock types `calls` as `[]`, which makes every call-site assertion a
// compile error rather than a check.
const submitAnswer = vi.fn(async (..._args: unknown[]) => ({
  status: 200,
  body: { ok: true, revision: 1 },
}));

const rows = {
  session: {
    id: 's-1',
    userId: OWNER,
    tokenHash: '',
    familyId: 'f-1',
    createdAt: new Date(systemClock.now() - 1_000),
    expiresAt: new Date(systemClock.now() + 7_200_000),
    revokedAt: null as Date | null,
    revokedReason: null as string | null,
  },
  attempt: { studentId: OWNER, gracePeriodSec: 60 } as {
    studentId: string;
    gracePeriodSec: number;
  },
};

function fakeDb() {
  return {
    user: { findUnique: async () => null, update: async () => ({}), updateMany: async () => ({}) },
    session: {
      // The lookup is keyed by TOKEN HASH — this is the join the whole session layer turns on, and
      // a fake that answered for any token would make the forged-cookie tests vacuous.
      findUnique: async ({ where }: { where: { tokenHash: string } }) =>
        where.tokenHash === rows.session.tokenHash ? rows.session : null,
      create: async () => ({}),
      update: async () => ({}),
      updateMany: async () => ({ count: 0 }),
    },
    securityEvent: { upsert: async () => ({}) },
    examAttempt: { findUnique: async () => rows.attempt },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
    $queryRaw: async () => [],
  };
}

vi.mock('@orrery/db', () => ({ getPrisma: () => fakeDb() }));
vi.mock('@orrery/db/answer-write', () => ({
  submitAnswer: (...args: unknown[]) => submitAnswer(...args),
}));

/** A `POST` with an optional session cookie. */
async function post(options: { token?: string | null; body?: unknown } = {}): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (typeof options.token === 'string') {
    headers.cookie = `${SESSION_COOKIE.name}=${options.token}`;
  }
  return POST(
    new Request('http://orrery.test/api/exam/answers', {
      method: 'POST',
      headers,
      body: JSON.stringify(
        options.body ?? {
          attemptId: 'a-1',
          questionId: 'q-1',
          idempotencyKey: 'k-1',
          expectedRevision: 0,
          answer: 'forty two',
        },
      ),
    }),
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
});

beforeEach(async () => {
  submitAnswer.mockClear();
  rows.attempt = { studentId: OWNER, gracePeriodSec: 60 };
  rows.session = {
    id: 's-1',
    userId: OWNER,
    tokenHash: await hashToken(TOKEN, SECRET),
    familyId: 'f-1',
    // A real instant, because the route evaluates `SESSION_EXPIRY_POLICY` against the SYSTEM clock:
    // a row stamped in 2023 is dead on arrival and every "live session" test would be asserting on
    // a refusal. `@orrery/clock` rather than `Date.now` because INV-TIME-1 makes it the only source.
    createdAt: new Date(systemClock.now() - 1_000),
    expiresAt: new Date(systemClock.now() + 7_200_000),
    revokedAt: null,
    revokedReason: null,
  };
  process.env.AUTH_SECRET = SECRET;
  // The escape hatch must be OFF for every test here, or "no cookie" would quietly resolve. Cleared
  // through `stubEnv` rather than `delete` so vitest restores the previous value afterwards: a test
  // that sets NODE_ENV=production and does not put it back silently disables the very guard the
  // next test is asserting.
  vi.stubEnv('ORRERY_DEV_USER_ID', '');
  vi.stubEnv('ORRERY_ALLOW_DEV_IDENTITY', '');
});

describe('the route fails closed with no session at all', () => {
  it('refuses, and writes nothing', async () => {
    const response = await post({ token: null });
    expect(response.status).toBe(401);
    expect(submitAnswer).not.toHaveBeenCalled();
  });

  it('and it is UNAUTHENTICATED, not a 403 that would confirm the attempt exists', async () => {
    expect(await (await post({ token: null })).json()).toEqual({
      ok: false,
      reason: 'UNAUTHENTICATED',
    });
  });

  it('and a FORGED cookie is refused exactly like no cookie', async () => {
    const forged = await post({ token: `${'z'.repeat(43)}` });
    const absent = await post({ token: null });
    expect(forged.status).toBe(absent.status);
    expect(await forged.text()).toBe(await absent.text());
  });
});

describe("a caller reaching for somebody else's attempt", () => {
  it('gets the BYTE-IDENTICAL response an unauthenticated caller gets', async () => {
    // The whole point of the change. `403 FORBIDDEN` confirmed the row exists; this does not.
    rows.attempt = { studentId: OTHER, gracePeriodSec: 60 };
    const notMine = await post({ token: TOKEN });
    const anonymous = await post({ token: null });

    expect(notMine.status).toBe(anonymous.status);
    expect(await notMine.text()).toBe(await anonymous.text());
  });

  it('and no answer is written', async () => {
    rows.attempt = { studentId: OTHER, gracePeriodSec: 60 };
    await post({ token: TOKEN });
    expect(submitAnswer).not.toHaveBeenCalled();
  });
});

describe('a caller writing their OWN attempt', () => {
  it('is let through, so the refusals above are not a blanket refusal', async () => {
    const response = await post({ token: TOKEN });
    expect(response.status).toBe(200);
    expect(submitAnswer).toHaveBeenCalledTimes(1);
    expect(submitAnswer.mock.calls[0]?.[1]).toMatchObject({
      attemptId: 'a-1',
      actorId: OWNER,
      source: 'CLIENT',
    });
  });

  it('and a userId in the BODY cannot change whose answer is written', async () => {
    // No user id is accepted for identity purposes from the request. The cookie decides, and the
    // body only says which attempt to write to.
    await post({
      token: TOKEN,
      body: {
        userId: OTHER,
        attemptId: 'a-1',
        questionId: 'q-1',
        idempotencyKey: 'k-1',
        expectedRevision: 0,
      },
    });
    expect(submitAnswer.mock.calls[0]?.[1]).toMatchObject({ actorId: OWNER });
  });
});

describe('the escape hatch on the answer write path', () => {
  it('is INERT without the opt-in, even with a real user id in the environment', async () => {
    // The hazard TM-01 describes: one variable left in an environment makes every caller that
    // user. It now requires a second, deliberate one.
    vi.stubEnv('ORRERY_DEV_USER_ID', OWNER);
    const response = await post({ token: null });
    expect(response.status).toBe(401);
    expect(submitAnswer).not.toHaveBeenCalled();
  });

  it('and acts when BOTH are set, and only off production', async () => {
    vi.stubEnv('ORRERY_DEV_USER_ID', OWNER);
    vi.stubEnv('ORRERY_ALLOW_DEV_IDENTITY', 'true');
    expect((await post({ token: null })).status).toBe(200);
    vi.stubEnv('NODE_ENV', 'production');
    expect((await post({ token: null })).status).toBe(401);
  });

  it('and a STALE cookie is NOT quietly replaced by the escape hatch', async () => {
    // A caller whose session expired must get `null`, not "you are somebody else". Otherwise
    // "my session expired" silently becomes "your marks moved", which is a genuinely baffling bug
    // and would be found in production.
    vi.stubEnv('ORRERY_DEV_USER_ID', OTHER);
    vi.stubEnv('ORRERY_ALLOW_DEV_IDENTITY', 'true');
    rows.attempt = { studentId: OWNER, gracePeriodSec: 60 };
    const response = await post({ token: `${'z'.repeat(43)}` });
    expect(response.status).toBe(401);
  });
});

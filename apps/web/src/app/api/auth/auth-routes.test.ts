/**
 * The two auth routes at their HTTP edges.  (P14-T11)
 *
 * ## WHAT THIS FILE COVERS THAT THE CORE TESTS CANNOT
 *
 * `sign-in.test.ts` and `forgot.test.ts` exercise the handlers with injected dependencies. What is
 * left is the wiring, and two of the things it does are security properties rather than plumbing:
 *
 *   1. **A MISSING `AUTH_SECRET` REFUSES EVERY SIGN-IN.** With no secret the handler would still
 *      work — argon2 verifies against hashes made with an empty pepper, and the session HMAC is
 *      keyed with the empty string. That is exactly why it must not: a key every deployment shares
 *      turns a staging dump into a production session. The failure is a generic 401 rather than a
 *      503, because a distinguishable status for a configuration fault is an enumeration oracle in
 *      its own right.
 *   2. **A MALFORMED BODY IS A 400 AND NOT THE GENERIC FAILURE**, and the reasoning is worth
 *      stating because it looks like an inconsistency: a body that is not a JSON object contains no
 *      address, so it discloses nothing about any account, and a 400 tells the caller their client is
 *      broken. `transport.ts:38` collapses it to the generic string anyway.
 *
 * ## THE SECRET IS A MODULE-LEVEL READ, SO IT IS SET AND RESTORED PER TEST
 *
 * `buildDeps` reads `process.env` when the request arrives rather than at import time, which is
 * what makes this testable at all. Leaking it into the next test would silently disable the guard
 * being asserted, which is the failure mode `can.ts` warns about for actor-presence checks.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GENERIC_AUTH_FAILURE } from '@/features/auth/flow';
import { POST as forgotPost } from './forgot/route';
import { POST as signInPost } from './sign-in/route';

/** Just enough Prisma for the sign-in handler's account lookup and session insert. */
// Parameterised so `vi.mock`'s forwarding call type-checks; the returned row shape is exercised
// in `sign-in.test.ts`, where the handler itself is under test rather than the wiring.
const findUnique = vi.fn(async (..._args: unknown[]) => null as unknown);
vi.mock('@orrery/db', () => ({
  getPrisma: () => ({
    user: {
      findUnique: (...args: unknown[]) => findUnique(...args),
      update: async () => ({}),
      updateMany: async () => ({ count: 0 }),
    },
    session: {
      findUnique: async () => null,
      create: async () => ({}),
      update: async () => ({}),
      updateMany: async () => ({ count: 0 }),
    },
    securityEvent: { upsert: async () => ({}) },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
    $queryRaw: async () => [],
  }),
}));

const SECRET = 's'.repeat(48);

function postJson(path: 'sign-in' | 'forgot', body: unknown, raw?: string): Promise<Response> {
  const route = path === 'sign-in' ? signInPost : forgotPost;
  return route(
    new Request(`http://orrery.test/api/auth/${path === 'sign-in' ? 'sign-in' : 'forgot'}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: raw ?? JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  findUnique.mockClear();
  // `stubEnv` rather than assignment: vitest restores the previous value in `afterEach`, and
  // `NODE_ENV` is typed read-only by `@types/node`, so a plain assignment is both a compile error
  // and a leak into every test that runs afterwards.
  vi.stubEnv('AUTH_SECRET', SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('POST /api/auth/sign-in', () => {
  it('refuses EVERY sign-in when AUTH_SECRET is absent, rather than keying the HMAC with nothing', async () => {
    vi.stubEnv('AUTH_SECRET', '');
    const response = await postJson('sign-in', { email: 'a@b.co', password: 'x' });
    // The GENERIC failure, not a 500 and not a 503: a status that says "this server is
    // misconfigured" is a status an attacker reads.
    expect(response.status).toBe(401);
    expect((await response.json()) as { message: string }).toMatchObject({
      message: GENERIC_AUTH_FAILURE,
    });
  });

  it('and when the secret is too short to key anything with', async () => {
    vi.stubEnv('AUTH_SECRET', 'short');
    expect((await postJson('sign-in', { email: 'a@b.co', password: 'x' })).status).toBe(401);
  });

  it('a body that is not a JSON object is a 400, which discloses nothing about any account', async () => {
    for (const raw of ['not json at all', '[]', '"a string"', '42']) {
      const response = await postJson('sign-in', null, raw);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ ok: false, reason: 'MALFORMED_BODY' });
    }
  });

  it('an unknown address gets the generic failure and never a session row', async () => {
    findUnique.mockResolvedValue(null);
    const response = await postJson('sign-in', {
      email: 'nobody@school.example',
      password: 'wrong guess entirely',
    });
    expect(response.status).toBe(401);
    expect(response.headers.get('set-cookie')).toBeNull();
  });
});

describe('POST /api/auth/forgot', () => {
  it('a body that is not a JSON object is a 400', async () => {
    expect((await postJson('forgot', null, 'nope')).status).toBe(400);
  });

  it('an unknown address still answers 200 with the conditional sentence', async () => {
    findUnique.mockResolvedValue(null);
    const response = await postJson('forgot', { email: 'nobody@school.example' });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { message: string };
    expect(body.message).toContain('If that address has an account');
  });

  it('and sets NO cookie, so a dispatch cannot be told from a refusal by the headers', async () => {
    const response = await postJson('forgot', { email: 'nobody@school.example' });
    expect(response.headers.get('set-cookie')).toBeNull();
  });
});

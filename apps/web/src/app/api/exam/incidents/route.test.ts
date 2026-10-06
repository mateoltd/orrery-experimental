/**
 * The incidents route, at the HTTP boundary: auth, shape, and delegation.
 *
 * Mirrors the answers route test exactly (real token hashed against a real secret, fake session keyed
 * by token hash, mocked service), because a second route with a second test shape would be two things
 * to get wrong. What is asserted here and nowhere else: unauthenticated callers are refused before the
 * body is read, malformed bodies are 400 AFTER auth, and a created report returns its id with the
 * service receiving the session's user id (not anything from the body).
 */

import { SESSION_COOKIE } from '@orrery/auth/session';
import { hashToken } from '@orrery/auth/token';
import { systemClock } from '@orrery/clock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from './route';

const SECRET = 's'.repeat(48);
const TOKEN = 'k'.repeat(43);
const OWNER = 'u-owner';

const reportIncident = vi.fn(async (..._args: unknown[]) => ({ ok: true, id: 'inc-1' }));

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
};

function fakeDb() {
  return {
    user: { findUnique: async () => null, update: async () => ({}) },
    session: {
      // Keyed by TOKEN HASH: a fake answering for any token would make the forged-cookie tests vacuous.
      findUnique: async ({ where }: { where: { tokenHash: string } }) =>
        where.tokenHash === rows.session.tokenHash ? rows.session : null,
      create: async () => ({}),
      update: async () => ({}),
    },
    securityEvent: { upsert: async () => ({}) },
  };
}

vi.mock('@orrery/db', () => ({ getPrisma: () => fakeDb() }));
vi.mock('@orrery/db/exam-incidents', () => ({
  reportIncident: (...args: unknown[]) => reportIncident(...args),
}));

async function post(options: { token?: string | null; body?: unknown } = {}): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (typeof options.token === 'string') {
    headers.cookie = `${SESSION_COOKIE.name}=${options.token}`;
  }
  return POST(
    new Request('http://orrery.test/api/exam/incidents', {
      method: 'POST',
      headers,
      body: JSON.stringify(options.body ?? { attemptId: 'a-1', reason: 'TYPO' }),
    }),
  );
}

beforeEach(async () => {
  reportIncident.mockClear();
  rows.session = {
    id: 's-1',
    userId: OWNER,
    tokenHash: await hashToken(TOKEN, SECRET),
    familyId: 'f-1',
    createdAt: new Date(systemClock.now() - 1_000),
    expiresAt: new Date(systemClock.now() + 7_200_000),
    revokedAt: null,
    revokedReason: null,
  };
  process.env.AUTH_SECRET = SECRET;
  vi.stubEnv('ORRERY_DEV_USER_ID', '');
  vi.stubEnv('ORRERY_ALLOW_DEV_IDENTITY', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the incidents route', () => {
  it('refuses unauthenticated callers before reading the body, and writes nothing', async () => {
    const response = await post({ token: null });
    expect(response.status).toBe(401);
    expect(reportIncident).not.toHaveBeenCalled();
  });

  it('and a FORGED cookie is refused exactly like no cookie', async () => {
    const forged = await post({ token: 'z'.repeat(43) });
    const absent = await post({ token: null });
    expect(forged.status).toBe(absent.status);
    expect(await forged.text()).toBe(await absent.text());
  });

  it('rejects a body missing attemptId with 400, after auth', async () => {
    const response = await post({ token: TOKEN, body: { reason: 'TYPO' } });
    expect(response.status).toBe(400);
    expect(reportIncident).not.toHaveBeenCalled();
  });

  it('delegates a well-formed body to the service with the SESSION user id, and returns the incident id', async () => {
    const response = await post({
      token: TOKEN,
      body: {
        attemptId: 'a-1',
        questionId: 'q-9',
        reason: 'BROKEN_QUESTION',
        detail: 'Option B is blank.',
      },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, id: 'inc-1' });
    expect(reportIncident).toHaveBeenCalledOnce();
    const [, callerId, input] = reportIncident.mock.calls[0] as [
      unknown,
      string,
      Record<string, unknown>,
    ];
    // The caller id comes from the SESSION, never the body: a body-carried userId would let any
    // caller file reports as any other student.
    expect(callerId).toBe(OWNER);
    expect(input).toMatchObject({ attemptId: 'a-1', questionId: 'q-9', reason: 'BROKEN_QUESTION' });
  });
});

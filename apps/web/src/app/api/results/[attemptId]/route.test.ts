/**
 * THE RESULTS ROUTE'S SECURITY PROPERTIES, ASSERTED AGAINST THE REAL HANDLER.  (P10-T4, `P10-T8`)
 *
 * ## WHY THESE TESTS EXIST RATHER THAN THE VIEW'S OWN
 *
 * `StudentResultsView.test.tsx` proves the component renders what it is given. **It cannot prove the handler never gives
 * it somebody else's paper**, because that question is about the identity supplying the query, and the component is
 * downstream of the answer. So every case below is about the boundary: who is calling, and what comes back.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * READ THE SHIPPED SOURCE, because two of these claims are about the code that ships rather than about a function's
 * current behaviour — "it does not re-check release" and "it is `force-dynamic`" are both statements about this file.
 *
 * **RESOLVED FROM THE PACKAGE ROOT, NOT FROM `import.meta.url`, AND THE FIRST ATTEMPT AT THIS WAS WRONG.** I wrote it the
 * way `packages/contracts/src/grading/receipt.test.ts` does — `new URL('./route.ts', import.meta.url)` through
 * `fileURLToPath` — and it failed with `The URL must be of scheme file`. `import.meta.url` IS a `file:` URL here for a
 * static import (I checked) and is NOT for this module under vitest's runner, so the working pattern in one package is
 * not a guarantee in another. `process.cwd()` is the vitest root, which is `apps/web`, and is deterministic here.
 *
 * A copy that fails for a reason unrelated to the handler teaches the reader nothing, which is the whole objection to
 * asserting against source at all — so the path has to be boring.
 */
const source = (): string =>
  readFileSync(join(process.cwd(), 'src/app/api/results/[attemptId]/route.ts'), 'utf8');

const requireUser = vi.fn();
const refuseCaller = vi.fn(() =>
  Response.json({ ok: false, reason: 'UNAUTHENTICATED' }, { status: 401 }),
);
const loadStudentResults = vi.fn();

vi.mock('@/server/auth/session-runtime', () => ({ requireUser }));
vi.mock('@/server/auth/session-user', () => ({ refuseCaller }));
vi.mock('@orrery/db/student-results', () => ({
  loadStudentResults,
  // `results-response.ts` reads `RESULTS_HEADERS` at module scope, so the mock must supply it. A mock that omits an
  // export the module under test touches fails with a message about the MOCK rather than about the handler, which is a
  // confusing way to learn that the fixture is incomplete.
  RESULTS_HEADERS: Object.freeze({ 'Cache-Control': 'private, no-store', Vary: 'Cookie' }),
}));
vi.mock('@orrery/db', () => ({ getPrisma: () => ({}) }));

const ATTEMPT = 'att-1';
const ctx = (): { params: Promise<{ attemptId: string }> } => ({
  params: Promise.resolve({ attemptId: ATTEMPT }),
});

/** A caller, as `requireUser` returns one. `kind` is the discriminant that keeps a dev identity out. */
const sessionCaller = (userId: string) => ({
  caller: { kind: 'session' as const, userId, sessionId: 's1', familyId: 'f1' },
  setCookie: null,
});

const get = async (request: Request) => {
  // `./route`, not `../route`: this file lives beside the handler, inside the same `[attemptId]` segment.
  const { GET } = await import('./route');
  return GET(request, ctx());
};

afterEach(() => {
  vi.clearAllMocks();
});

describe('the route fails closed, and the refusal does not depend on the attempt existing', () => {
  it('refuses an unauthenticated caller BEFORE reading the path, so it is not an existence oracle', async () => {
    /**
     * The point is `loadStudentResults` NEVER RUNS. If the ownership query were consulted first, a caller could learn
     * something about the row from the difference between 401 and 404.
     */
    requireUser.mockResolvedValue(null);
    const response = await get(new Request(`http://x/api/results/${ATTEMPT}`));
    expect(response.status).toBe(401);
    expect(loadStudentResults).not.toHaveBeenCalled();
  });

  it('refuses a FORGED, EXPIRED or REVOKED cookie identically, because requireUser returns null for all three', async () => {
    /**
     * `resolveCaller` distinguishes the three internally for the security event and returns `null` for each. This test
     * pins the consequence at the route: **the caller cannot tell which failure occurred.**
     */
    requireUser.mockResolvedValue(null);
    const forged = await get(
      new Request(`http://x/api/results/${ATTEMPT}`, { headers: { cookie: 'x=forged' } }),
    );
    const absent = await get(new Request(`http://x/api/results/${ATTEMPT}`));
    expect(forged.status).toBe(absent.status);
    expect(await forged.text()).toBe(await absent.text());
  });
});

describe('a DEVELOPMENT IDENTITY CANNOT REACH A MARK', () => {
  it("refuses `kind: 'dev'` even when the dev opt-in produced a perfectly valid user id", async () => {
    /**
     * `ORRERY_ALLOW_DEV_IDENTITY` is off in production and `devIdentity` refuses when `NODE_ENV === 'production'`, so
     * this state is unreachable in production — which is exactly why it must be refused HERE rather than relied upon
     * three layers down. The discriminant exists so the check is visible in a type and in a test rather than in a
     * comment somebody scrolls past.
     */
    requireUser.mockResolvedValue({
      caller: { kind: 'dev', userId: 'dev-user', sessionId: null, familyId: null },
      setCookie: null,
    });
    const response = await get(new Request(`http://x/api/results/${ATTEMPT}`));
    expect(response.status).toBe(404);
    expect(loadStudentResults).not.toHaveBeenCalled();
  });
});

describe('the identity comes from the session and from nowhere else', () => {
  it('passes the SESSION user id to the loader, not one from the path', async () => {
    requireUser.mockResolvedValue(sessionCaller('student-42'));
    loadStudentResults.mockResolvedValue(null);
    await get(new Request(`http://x/api/results/${ATTEMPT}`));
    expect(loadStudentResults).toHaveBeenCalledWith(expect.anything(), 'student-42', ATTEMPT);
  });

  it('does not accept an identity in the query string', async () => {
    /**
     * `?studentId=someone-else` is the obvious forgery and it must be inert. **The test asserts the loader was called
     * with the session id**, which is the stronger claim: it does not merely ignore the parameter, it cannot pass it on.
     */
    requireUser.mockResolvedValue(sessionCaller('student-42'));
    loadStudentResults.mockResolvedValue(null);
    await get(new Request(`http://x/api/results/${ATTEMPT}?studentId=someone-else`));
    expect(loadStudentResults).toHaveBeenCalledWith(expect.anything(), 'student-42', ATTEMPT);
  });

  it('does not accept an identity in a header', async () => {
    requireUser.mockResolvedValue(sessionCaller('student-42'));
    loadStudentResults.mockResolvedValue(null);
    await get(
      new Request(`http://x/api/results/${ATTEMPT}`, { headers: { 'x-user-id': 'someone-else' } }),
    );
    expect(loadStudentResults).toHaveBeenCalledWith(expect.anything(), 'student-42', ATTEMPT);
  });
});

describe('missing and other-owner attempts are the SAME answer', () => {
  it('returns 404 and the identical body for both, which is what makes 403 unusable here', async () => {
    /**
     * `403` for "not yours" would confirm the row exists, and `404` for "no such row" would confirm that. One body for
     * `null` is enforced by `resultsResponse`, so the route cannot get it wrong by forgetting.
     */
    requireUser.mockResolvedValue(sessionCaller('student-42'));
    loadStudentResults.mockResolvedValue(null);
    const otherOwner = await get(new Request(`http://x/api/results/other-attempt`));
    const noSuchAttempt = await get(new Request(`http://x/api/results/no-such-attempt`));
    expect(otherOwner.status).toBe(404);
    expect(noSuchAttempt.status).toBe(404);
    expect(await otherOwner.text()).toBe(await noSuchAttempt.text());
  });
});

describe('what the route does and does not re-check', () => {
  it('does NOT re-check release — the loader resolves the attempt own RELEASED membership', async () => {
    /**
     * **THE RELEASE PREDICATE IS NOT DUPLICATED HERE, DELIBERATELY.** A second copy of "is this released" is a second
     * thing to get wrong and nothing enforces that the two agree. The sealed arm has no score field at all, so the
     * handler never receives a mark to leak.
     */
    const body = source().slice(source().indexOf('export async function GET'));
    expect(body).not.toMatch(/status\s*===\s*'RELEASED'|releasedAt|finalScore/);
    expect(body).toContain('loadStudentResults');
  });

  it('is `force-dynamic`, because a correct body served from Next own cache is still a leak', async () => {
    expect(source()).toContain("export const dynamic = 'force-dynamic'");
  });
});

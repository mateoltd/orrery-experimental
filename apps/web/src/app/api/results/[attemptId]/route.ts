/**
 * THE STUDENT RESULTS ROUTE — THE FIRST STUDENT-FACING ROUTE THAT CAN RETURN A MARK.  (P10-T4, `P10-T8`)
 *
 * ## WHY THIS FILE IS THE ONE TO READ CAREFULLY
 *
 * `transport.ts` posted to `/api/auth/sign-in` before that route existed, and `apps/web` had no session at all, so
 * every "ownership-gated" query in the product was gated on an **environment variable**. The session now exists
 * (`P14-T11`) and this route is what makes it load-bearing rather than decorative: **`studentId` is taken from the
 * session and from nowhere else**, and the query re-applies it, so a caller cannot ask for somebody else's paper by
 * putting their id in the path.
 *
 * ## THE ID IS IN THE PATH. THE IDENTITY IS NOT. THAT IS THE WHOLE DESIGN.
 *
 * `attemptId` is caller-supplied and therefore treated as untrusted input. `studentId` is not in the URL, not in the
 * query string, not in a header, and **not read from the body** — a `GET` has no body, and a body-derived identity would
 * be a caller-chosen one. It comes from `requireUser`, which returns `null` for every failure, and `null` is a refusal.
 *
 * ## A DEVELOPMENT IDENTITY CANNOT REACH A MARK, AND THAT IS THE POINT OF THE DISCRIMINANT
 *
 * `Caller.kind` is `'session' | 'dev'`. `loadStudentResults` needs a **verified** caller, so this route requires
 * `kind === 'session'` and refuses a dev identity. A developer can therefore read their own results through the loader
 * and its tests without a mountable route existing that serves a mark to an unverified caller — **which is the shape
 * that made the pre-session roster page an unauthenticated read AND write.**
 *
 * ## `404` FOR BOTH "NO SUCH ATTEMPT" AND "NOT YOURS", AND ONE FUNCTION OWNS THAT DECISION
 *
 * `403` for "not yours" confirms the row exists, which turns a results route into an existence oracle over every
 * attempt in the school; `404` then becomes the confirmation. `resultsResponse` already returns one body for `null`, so
 * this route cannot get that wrong by forgetting. The refusal for an unauthenticated caller is likewise
 * `refuseCaller()`'s single `401`, because a status meaning "you are not allowed to know" is itself a statement about
 * the row.
 *
 * ## RELEASED-ONLY IS THE LOADER'S JOB AND IS NOT RESTATED HERE
 *
 * `loadStudentResults` resolves the attempt's own `RELEASED` membership and returns a sealed arm with **no score field
 * at all** before that. A handler cannot leak a mark it never receives, and this route therefore does not re-check
 * release, does not branch on it, and cannot be edited into branching on it without the type complaining.
 */

import { getPrisma } from '@orrery/db';
import { loadStudentResults } from '@orrery/db/student-results';
import { resultsResponse } from '@/features/results/results-response';
import { requireUser } from '@/server/auth/session-runtime';
import { refuseCaller } from '@/server/auth/session-user';

/**
 * `no-store` AT THE ROUTE LEVEL, not only in `RESULTS_HEADERS`.
 *
 * A response header is the right place for a policy, but Next may serve a Route Handler from its own cache before the
 * handler runs, and **a correct body served from a cache is still a leak.** `force-dynamic` removes that second path.
 */
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  context: { params: Promise<{ attemptId: string }> },
): Promise<Response> {
  const caller = await requireUser(request);

  /**
   * FAIL CLOSED, AND FAIL CLOSED BEFORE THE PATH IS EVEN READ.
   *
   * The unauthenticated answer does not depend on whether the attempt exists, which is what stops this route being an
   * existence oracle for anonymous callers. `refuseCaller()` is shared with the answers route so the two cannot drift.
   */
  if (caller === null) return refuseCaller();

  /**
   * A DEV IDENTITY IS REFUSED HERE, EXPLICITLY, WITH A DIFFERENT STATUS.
   *
   * It is not `403` because the caller is not forbidden — they are *unverified*, and the distinction is worth keeping in
   * the logs even though the two must be indistinguishable from outside. `kind` exists as a discriminant precisely so
   * this check is a compile-time-visible branch rather than a comment somebody scrolls past.
   */
  if (caller.caller.kind !== 'session')
    return Response.json(
      { error: 'NOT_FOUND' },
      { status: 404, headers: { 'Cache-Control': 'no-store' } },
    );

  const { attemptId } = await context.params;

  /**
   * THE OWNERSHIP PREDICATE IS PASSED IN, NOT RE-DERIVED.
   *
   * `loadStudentResults` filters `{ id: attemptId, studentId }` itself, so the query is the boundary and this route is
   * only the thing that supplies an identity it cannot forge. **The ownership test is not duplicated here**, because a
   * second copy of "is this yours" is a second thing to get wrong and nothing enforces that the two agree.
   */
  const results = await loadStudentResults(getPrisma(), caller.caller.userId, attemptId);
  return resultsResponse(results);
}

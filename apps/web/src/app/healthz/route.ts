import { isoNow } from '@orrery/clock';

/**
 * Liveness. Answers "is this process running", and must not touch a dependency —
 * a liveness probe that fails when Postgres is slow will restart the app during an outage
 * it could have ridden out (plans/18 §3).
 *
 * Uses `@orrery/clock`'s `isoNow()` rather than `new Date()`. Not ceremony: the INV-TIME-1
 * lint rule caught `new Date()` on this very line during `next build`, correctly. The fix
 * was to add `toIso`/`isoNow` to the clock module — the sanctioned place — rather than to
 * weaken the rule or add an exception. A banned construct that everyone needs a workaround
 * for is a banned construct with a missing function.
 */
export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json(
    { status: 'ok', service: 'web', ts: isoNow() },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

/**
 * Readiness. Answers "should this process receive traffic", and DOES check dependencies.
 *
 * Readiness failing during a database blip removes the replica from rotation, which is the
 * correct response — unlike liveness, where restarting would make things worse.
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  const checks: Record<string, 'ok' | 'fail'> = { web: 'ok' };
  // The real Postgres and Redis probes land with P0-T4's migration runner and P0-T10's
  // telemetry. Declared here so the shape of the endpoint is fixed before the checks are.
  let healthy = true;
  for (const [name, state] of Object.entries(checks)) {
    if (state !== 'ok') healthy = false;
    void name;
  }
  return Response.json(
    { status: healthy ? 'ready' : 'not-ready', checks },
    { status: healthy ? 200 : 503, headers: { 'Cache-Control': 'no-store' } },
  );
}

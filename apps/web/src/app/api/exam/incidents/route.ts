import { actorPresence } from '@orrery/auth/can';
import { getPrisma } from '@orrery/db';
import { reportIncident } from '@orrery/db/exam-incidents';
import { requireUser } from '@/server/auth/session-runtime';
import { refuseCaller } from '@/server/auth/session-user';

/**
 * Report a problem during an exam.  (P17-T5, reporting half)
 *
 * Same shape as the answers route: session identity, no-store, cookie refresh on every response
 * including refusals. The service owns the own-attempt check; this route owns transport.
 */

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

function field(body: Record<string, unknown>, name: string): string | null {
  const value = body[name];
  return typeof value === 'string' ? value : null;
}

export async function POST(request: Request): Promise<Response> {
  const db = getPrisma();
  const resolution = await requireUser(request);
  const actor = actorPresence(resolution?.caller.userId ?? null);
  if (!actor.ok) return refuseCaller();
  const userId = actor.actorId;
  const refresh: Record<string, string> = resolution?.setCookie
    ? { 'Set-Cookie': resolution.setCookie }
    : {};

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json(
      { ok: false, reason: 'MALFORMED_BODY' },
      { status: 400, headers: { ...NO_STORE, ...refresh } },
    );
  }

  const attemptId = field(body, 'attemptId');
  const reason = field(body, 'reason');
  if (attemptId === null || reason === null) {
    return Response.json(
      { ok: false, reason: 'MALFORMED_BODY' },
      { status: 400, headers: { ...NO_STORE, ...refresh } },
    );
  }
  const questionId = field(body, 'questionId');

  const outcome = await reportIncident(db, userId, {
    attemptId,
    ...(questionId === null ? {} : { questionId }),
    reason,
    ...(typeof body.detail === 'string' ? { detail: body.detail } : {}),
  });
  if (!outcome.ok) {
    const status = outcome.httpStatus === 403 ? 403 : outcome.httpStatus === 404 ? 404 : 400;
    return Response.json(
      { ok: false, reason: outcome.reason },
      { status, headers: { ...NO_STORE, ...refresh } },
    );
  }
  return Response.json({ ok: true, id: outcome.id }, { headers: { ...NO_STORE, ...refresh } });
}

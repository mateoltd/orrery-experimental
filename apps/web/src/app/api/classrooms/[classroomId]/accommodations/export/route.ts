import { actorPresence } from '@orrery/auth/can';
import { getPrisma } from '@orrery/db';
import { requireUser } from '@/server/auth/session-runtime';
import { refuseCaller } from '@/server/auth/session-user';

/**
 * Audit export: every accommodation grant in the room as CSV.  (P13-T6)
 *
 * Teacher-or-owner gated, no-store, and the SAME rows the register shows -- an export that disagreed
 * with the screen would be two records, and the compliance argument needs exactly one. CSV rather than
 * JSON because the consumer is a spreadsheet in a review meeting, not a program.
 */

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

function csvCell(value: string): string {
  return `"${value.replace(/"/gu, '""')}"`;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ classroomId: string }> },
): Promise<Response> {
  const [{ classroomId }, resolution] = await Promise.all([params, requireUser(request)]);
  const actor = actorPresence(resolution?.caller.userId ?? null);
  if (!actor.ok) return refuseCaller();
  const refresh: Record<string, string> = resolution?.setCookie
    ? { 'Set-Cookie': resolution.setCookie }
    : {};

  const db = getPrisma();
  const { resolveActorForRequest } = await import('@orrery/db/classrooms');
  const resolved = await resolveActorForRequest(db, actor.actorId);
  const role = resolved?.classroomRoles[classroomId];
  if (resolved === null || (role !== 'OWNER' && role !== 'TEACHER')) {
    return Response.json(
      { ok: false, reason: 'NOT_A_TEACHER' },
      { status: 403, headers: NO_STORE },
    );
  }

  const rows = await db.accommodation.findMany({
    where: { classroomId },
    include: { student: { select: { email: true } }, grantedBy: { select: { email: true } } },
    orderBy: { grantedAt: 'asc' },
  });
  const lines = [
    'granted_at,student,relaxations,extra_time_percent,reason,status,granted_by',
    ...rows.map((row) =>
      [
        row.grantedAt.toISOString(),
        row.student.email,
        row.relaxations.join(';'),
        row.extraTimePercent?.toString() ?? '',
        row.reason,
        row.status,
        row.grantedBy.email,
      ]
        .map(csvCell)
        .join(','),
    ),
  ];
  return new Response(`${lines.join('\n')}\n`, {
    headers: { ...NO_STORE, ...refresh, 'content-type': 'text/csv; charset=utf-8' },
  });
}

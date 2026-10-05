import type { Actor } from '@orrery/auth/types';
import type { Clock } from '@orrery/clock';
import { Prisma } from '../prisma/generated/client/client.js';
import type { PrismaClient } from './index.js';
import { ReportDenied, requireReportTeacher } from './report-access.js';

// `plans/08` requires query suppression independently of the pure analytics boundary.
export const REPORT_FACILITY_MIN_N = 5;

export interface QueryItemAnalysis {
  readonly assignmentId: string;
  readonly questionId: string;
  readonly n: number;
  readonly pFull: number | null;
  readonly pCredit: number | null;
  readonly computedAt: number;
}

/** Group in Postgres and page by item ID; no cohort-sized response array reaches the process. */
export async function* readItemAnalysis(
  db: PrismaClient,
  actor: Actor,
  scope: { readonly classroomId: string; readonly assignmentId: string },
  clock: Clock,
): AsyncGenerator<QueryItemAnalysis> {
  await requireReportTeacher(db, actor, scope.classroomId);
  const assignment = await db.assignment.findFirst({
    where: { id: scope.assignmentId, classroomId: scope.classroomId },
    select: { resourceVersionId: true },
  });
  if (assignment === null) throw new ReportDenied(404);
  let after = '';
  for (;;) {
    await requireReportTeacher(db, actor, scope.classroomId);
    const page: { questionId: string; n: number; pFull: number | null; pCredit: number | null }[] =
      await db.$queryRaw(Prisma.sql`
      WITH items AS (
        SELECT id, points FROM "Question"
        WHERE "resourceVersionId" = ${assignment.resourceVersionId} AND id > ${after}
        ORDER BY id LIMIT 100
      ), scored AS (
        SELECT r."questionId", COALESCE(r."manualScore", r."autoRawScore", r."autoScore") AS mark
        FROM "QuestionResponse" r JOIN "ExamAttempt" a ON a.id = r."attemptId"
        WHERE a."classroomId" = ${scope.classroomId} AND a."assignmentId" = ${scope.assignmentId}
          AND a.purpose = 'GRADED' AND a.status NOT IN ('EXCUSED', 'VOIDED')
          AND NOT r."isExcused" AND NOT r."needsHuman" AND NOT r."isOmitted" AND NOT r."notReached"
          AND r."questionId" IN (SELECT id FROM items)
          AND EXISTS (SELECT 1 FROM "ReleaseBatchMember" m JOIN "ReleaseBatch" b ON b.id = m."batchId"
            WHERE m."attemptId" = a.id AND b.status = 'RELEASED')
          AND NOT EXISTS (SELECT 1 FROM "ExamAttempt" newer WHERE newer."assignmentId" = a."assignmentId"
            AND newer."studentId" = a."studentId" AND newer.purpose = 'GRADED' AND newer."attemptNumber" > a."attemptNumber")
      )
      SELECT i.id AS "questionId", count(s.mark)::int AS n,
        CASE WHEN count(s.mark) >= ${REPORT_FACILITY_MIN_N}
          THEN avg(CASE WHEN s.mark >= i.points THEN 1.0 ELSE 0.0 END)::float8 ELSE NULL END AS "pFull",
        CASE WHEN count(s.mark) >= ${REPORT_FACILITY_MIN_N}
          THEN avg(least(1.0, greatest(0.0, s.mark / i.points)))::float8 ELSE NULL END AS "pCredit"
      FROM items i LEFT JOIN scored s ON s."questionId" = i.id AND s.mark IS NOT NULL AND i.points > 0
      GROUP BY i.id ORDER BY i.id
    `);
    for (const row of page)
      yield { ...row, assignmentId: scope.assignmentId, computedAt: clock.now() };
    if (page.length < 100) return;
    after = page[page.length - 1]?.questionId ?? '';
  }
}

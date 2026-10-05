import type { Actor } from '@orrery/auth/types';
import type { Clock } from '@orrery/clock';
import { renderCsvCell } from '@orrery/contracts/csv';
import type { PrismaClient } from '@orrery/db';
import type { ItemReportInput } from '../../../../../packages/analytics/src/item-report.js';
import { itemReportCells } from '../../../../../packages/analytics/src/item-report.js';
import type { Rollup } from '../../../../../packages/analytics/src/rollups.js';
import { requireReportTeacher } from '../../../../../packages/db/src/report-access.js';
import type { LedgerRow } from '../../../../../packages/db/src/report-gradebook.js';
import { readIntegrityReportFacts } from '../../../../../packages/db/src/report-integrity.js';
import { readItemAnalysis } from '../../../../../packages/db/src/report-item-analysis.js';
import {
  type ReportScope,
  readGradebook,
  readSubmissions,
  type SubmissionRow,
} from '../../../../../packages/db/src/report-queries.js';
import { buildIntegrityReport, integrityLines } from './integrity-report.js';
import { streamPdf } from './pdf.js';

export type CsvRow = readonly string[];

function csvCell(value: string): string {
  // Spreadsheet importers can strip whitespace before recognising a formula prefix.
  let start = 0;
  while (start < value.length && (value.charCodeAt(start) <= 32 || /\s/u.test(value.charAt(start))))
    start += 1;
  return renderCsvCell(/^[=+@-]/u.test(value.slice(start)) ? `'${value}` : value);
}

export async function* streamCsv(
  header: CsvRow,
  rows: AsyncIterable<CsvRow>,
): AsyncGenerator<string> {
  yield `${header.map(csvCell).join(',')}\r\n`;
  for await (const row of rows) yield `${row.map(csvCell).join(',')}\r\n`;
}

export const GRADEBOOK_HEADER = [
  'Ledger scope',
  'Student ID',
  'Student',
  'Assignment ID',
  'Assignment',
  'Latest assessment attempt ID',
  'Weight',
  'Status',
  'Release state',
  'Score percent',
  'Score notice',
  'Provisional',
  'Resolved variant',
  'Resolved question IDs',
  'Form information',
  'Course total percent',
  'Included weight',
  'Unresolved weight',
  'Excused weight',
  'Computed at',
] as const;

export async function* gradebookCells(rows: AsyncIterable<LedgerRow>): AsyncGenerator<CsvRow> {
  for await (const row of rows) {
    for (const cell of row.cells)
      yield [
        'Active students; course total includes all published assignments; practice attempts excluded',
        row.studentId,
        row.student,
        cell.assignmentId,
        cell.assignment,
        cell.attemptId ?? '',
        String(cell.weight),
        cell.flag,
        cell.state,
        cell.score?.finalScore === null || cell.score === null ? '' : String(cell.score.finalScore),
        cell.scoreNotice,
        String(cell.score?.isProvisional ?? false),
        cell.variant.label,
        cell.variant.questionIds.join(' | '),
        cell.formNotice,
        row.total.percentage === null ? '' : String(row.total.percentage),
        String(row.total.includedWeight),
        String(row.total.pendingWeight),
        String(row.total.excusedWeight),
        new Date(cell.computedAt).toISOString(),
      ];
  }
}

const SUBMISSION_HEADER = [
  'Response ID',
  'Attempt ID',
  'Assignment ID',
  'Student ID',
  'Question ID',
  'Resolved position',
  'Answer',
  'Submitted at',
  'Receipt',
];

export async function* submissionCells(rows: AsyncIterable<SubmissionRow>): AsyncGenerator<CsvRow> {
  for await (const row of rows)
    yield [
      row.responseId,
      row.attemptId,
      row.assignmentId,
      row.studentId,
      row.questionId,
      String(row.position),
      typeof row.answer === 'string' ? row.answer : (JSON.stringify(row.answer) ?? ''),
      row.submittedAt ?? '',
      row.receipt ?? '',
    ];
}

export async function* exportGradebookCsv(
  db: PrismaClient,
  actor: Actor,
  scope: ReportScope,
  clock: Clock,
) {
  // Authorise before even the header; generic stream helpers are not access boundaries.
  await requireReportTeacher(db, actor, scope.classroomId);
  yield* streamCsv(GRADEBOOK_HEADER, gradebookCells(readGradebook(db, actor, scope, clock)));
}

export async function* exportSubmissionsCsv(db: PrismaClient, actor: Actor, scope: ReportScope) {
  await requireReportTeacher(db, actor, scope.classroomId);
  yield* streamCsv(SUBMISSION_HEADER, submissionCells(readSubmissions(db, actor, scope)));
}

export async function* exportGradebookPdf(
  db: PrismaClient,
  actor: Actor,
  scope: ReportScope,
  clock: Clock,
) {
  await requireReportTeacher(db, actor, scope.classroomId);
  async function* lines() {
    yield 'Gradebook. Non-ASCII characters are preserved as Unicode code-point escapes.';
    yield 'Scope: active students. Course totals include all published assignments, even in a filtered view. Practice attempts are excluded.';
    for await (const row of readGradebook(db, actor, scope, clock)) {
      yield `${row.student} (${row.studentId})`;
      for (const cell of row.cells) {
        yield `${cell.assignment}, latest graded-purpose attempt ${cell.attemptId ?? 'none'}: ${cell.flag}, ${cell.state}, weight ${cell.weight}, score ${cell.score?.finalScore ?? 'unavailable'}${cell.score?.isProvisional ? ' (provisional)' : ''}`;
        yield cell.variant.label;
        if (cell.scoreNotice) yield cell.scoreNotice;
        yield `Resolved IDs: ${cell.variant.questionIds.join(', ')}`;
        yield cell.formNotice;
        yield `Computed at: ${new Date(cell.computedAt).toISOString()}`;
      }
      yield `Weighted total: ${row.total.percentage ?? 'unavailable'}; included weight ${row.total.includedWeight}, unresolved weight ${row.total.pendingWeight}, excused weight ${row.total.excusedWeight}`;
    }
  }
  yield* streamPdf(lines());
}

export const ITEM_ANALYSIS_HEADER = [
  'Assignment ID',
  'Computed at',
  'Freshness',
  'Purpose',
  'Validity caveats',
  'Question ID',
  'Form count',
  'Statistics',
];

export async function* itemAnalysisCells(
  rows: AsyncIterable<Rollup<ItemReportInput>>,
  clock: Clock,
): AsyncGenerator<CsvRow> {
  for await (const row of rows) yield itemReportCells(row, clock.now());
}

/** The live query currently supplies facility; unavailable indices are named rather than invented. */
export async function* exportItemAnalysisCsv(
  db: PrismaClient,
  actor: Actor,
  scope: { readonly classroomId: string; readonly assignmentId: string },
  clock: Clock,
) {
  await requireReportTeacher(db, actor, scope.classroomId);
  async function* rows(): AsyncGenerator<Rollup<ItemReportInput>> {
    for await (const row of readItemAnalysis(db, actor, scope, clock))
      yield {
        assignmentId: row.assignmentId,
        computedAt: row.computedAt,
        invalidatedBy: [],
        isRecomputing: false,
        value: {
          questionId: row.questionId,
          formCount: null,
          metrics: [
            {
              name: 'pFull (uncorrected for guessing)',
              stat: 'facility',
              n: row.n,
              value: row.pFull,
              interval: null,
            },
            {
              name: 'pCredit (mean proportion of credit)',
              stat: 'facility',
              n: row.n,
              value: row.pCredit,
              interval: null,
            },
            {
              name: 'Correlation (not computed; form count unavailable)',
              stat: 'correlation',
              n: row.n,
              value: null,
              interval: null,
            },
          ],
        },
      };
  }
  yield* streamCsv(ITEM_ANALYSIS_HEADER, itemAnalysisCells(rows(), clock));
}

export async function* exportIntegrityPdf(
  db: PrismaClient,
  actor: Actor,
  scope: { readonly classroomId: string; readonly attemptId: string },
  clock: Clock,
) {
  const input = await readIntegrityReportFacts(db, actor, scope, clock);
  const report = buildIntegrityReport(input);
  yield* streamPdf(integrityLines(report));
}

/** `highWaterMark: 0` prevents pulling another database page ahead of download demand. */
export function reportDownload(
  source: AsyncGenerator<string | Uint8Array>,
  format: 'csv' | 'pdf',
): Response {
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const next = await source.next();
          if (next.done) controller.close();
          else
            controller.enqueue(
              typeof next.value === 'string' ? Buffer.from(next.value, 'utf8') : next.value,
            );
        } catch (error) {
          controller.error(error);
          await source.return(undefined);
        }
      },
      async cancel() {
        await source.return(undefined);
      },
    },
    { highWaterMark: 0 },
  );
  return new Response(body, {
    headers: {
      'Content-Type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/pdf',
      'Content-Disposition': `attachment; filename="report.${format}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    },
  });
}

export type TeacherReportRequest =
  | { readonly kind: 'gradebook'; readonly format: 'csv' | 'pdf'; readonly scope: ReportScope }
  | { readonly kind: 'submissions'; readonly format: 'csv'; readonly scope: ReportScope }
  | {
      readonly kind: 'itemAnalysis';
      readonly format: 'csv';
      readonly scope: { readonly classroomId: string; readonly assignmentId: string };
    }
  | {
      readonly kind: 'integrity';
      readonly format: 'pdf';
      readonly scope: { readonly classroomId: string; readonly attemptId: string };
    };

/** Access refusal happens before constructing a successful download response. */
export async function teacherReportDownload(
  db: PrismaClient,
  actor: Actor,
  request: TeacherReportRequest,
  clock: Clock,
): Promise<Response> {
  await requireReportTeacher(db, actor, request.scope.classroomId);
  if (request.kind === 'gradebook')
    return reportDownload(
      request.format === 'csv'
        ? exportGradebookCsv(db, actor, request.scope, clock)
        : exportGradebookPdf(db, actor, request.scope, clock),
      request.format,
    );
  if (request.kind === 'submissions')
    return reportDownload(exportSubmissionsCsv(db, actor, request.scope), 'csv');
  if (request.kind === 'itemAnalysis')
    return reportDownload(exportItemAnalysisCsv(db, actor, request.scope, clock), 'csv');
  const input = await readIntegrityReportFacts(db, actor, request.scope, clock);
  return reportDownload(streamPdf(integrityLines(buildIntegrityReport(input))), 'pdf');
}

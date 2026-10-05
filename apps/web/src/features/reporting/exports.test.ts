import type { Actor } from '@orrery/auth/types';
import { parseCsv } from '@orrery/contracts/csv';
import type { PrismaClient } from '@orrery/db';
import { describe, expect, it } from 'vitest';
import { buildLedgerRow } from '../../../../../packages/db/src/report-gradebook.js';
import {
  GRADEBOOK_HEADER,
  gradebookCells,
  reportDownload,
  streamCsv,
  submissionCells,
  teacherReportDownload,
} from './exports.js';
import { streamPdf } from './pdf.js';

async function textOf(source: AsyncIterable<string>): Promise<string> {
  let output = '';
  for await (const chunk of source) output += chunk;
  return output;
}

describe('P11-T10 streamed reporting exports', () => {
  it('denies a global teacher enrolled as a student before returning a download', async () => {
    const db = {
      classroom: { findUnique: async () => ({ id: 'room', ownerId: 'owner', archivedAt: null }) },
      enrollment: {
        findMany: async () => [{ classroomId: 'room', role: 'STUDENT' }],
        findFirst: async () => null,
      },
    } as unknown as PrismaClient;
    const actor: Actor = { id: 'student', roles: ['teacher'], suspended: false, mfaVerified: true };
    for (const kind of ['gradebook', 'submissions', 'itemAnalysis'] as const)
      await expect(
        teacherReportDownload(
          db,
          actor,
          { kind, format: 'csv', scope: { classroomId: 'room', assignmentId: 'a' } },
          { now: () => 20, monotonic: () => 0 },
        ),
      ).rejects.toThrow('access refused');
    await expect(
      teacherReportDownload(
        db,
        actor,
        { kind: 'integrity', format: 'pdf', scope: { classroomId: 'room', attemptId: 'a' } },
        { now: () => 20, monotonic: () => 0 },
      ),
    ).rejects.toThrow('access refused');
  });
  it('download demand and cancellation reach the source without speculative reads', async () => {
    let pulls = 0;
    let closed = false;
    async function* source() {
      try {
        while (pulls < 5000) {
          pulls += 1;
          yield `row ${pulls}\r\n`;
        }
      } finally {
        closed = true;
      }
    }
    const response = reportDownload(source(), 'csv');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(pulls).toBe(0);
    const reader = response.body?.getReader();
    await reader?.read();
    expect(pulls).toBe(1);
    await reader?.cancel();
    expect(pulls).toBe(1);
    expect(closed).toBe(true);
  });
  it('does not consume any of 5,000 students for the CSV header, or the next student before demand', async () => {
    let consumed = 0;
    let closed = false;
    async function* students() {
      try {
        for (let id = 0; id < 5000; id++) {
          consumed += 1;
          yield buildLedgerRow({
            studentId: String(id),
            student: `Student ${id}`,
            computedAt: 20,
            assignments: [
              {
                id: 'a',
                title: 'Assignment',
                weight: 1,
                dueAt: 10,
                latePenaltyPercent: 0,
                possibleItemCount: 60,
              },
            ],
            attempts: [],
          });
        }
      } finally {
        closed = true;
      }
    }
    const output = streamCsv(GRADEBOOK_HEADER, gradebookCells(students()));
    await output.next();
    expect(consumed).toBe(0);
    expect((await output.next()).value).toContain('Student 0');
    expect(consumed).toBe(1);
    await output.return(undefined);
    expect(consumed).toBe(1);
    expect(closed).toBe(true);
  });
  it.each([
    '=HYPERLINK("https://evil","click")',
    '+cmd|evil',
    '-1+2',
    '@SUM(1)',
    '\t=1',
    '\r=1',
    '  =1',
    '\n@SUM(1)',
  ])('neutralises attacker-controlled CSV cell %j', async (attack) => {
    async function* rows() {
      yield [attack, 'comma,quote"\nnewline'];
    }
    const output = await textOf(streamCsv(['Name', 'Answer'], rows()));
    expect(output).toContain("'");
    const parsed = parseCsv(output);
    expect(parsed.ok).toBe(true);
    expect(parsed.rows[0]?.[0]).toBe(`'${attack}`);
    expect(parsed.rows[0]?.[1]).toBe('comma,quote"\nnewline');
  });
  it('applies escaping to names, titles, IDs and raw submission answer text', async () => {
    const ledger = buildLedgerRow({
      studentId: '=ID',
      student: '=HYPERLINK("evil")',
      computedAt: 20,
      assignments: [
        {
          id: '@ID',
          title: '+cmd',
          weight: 1,
          dueAt: null,
          latePenaltyPercent: 0,
          possibleItemCount: null,
        },
      ],
      attempts: [],
    });
    async function* students() {
      yield ledger;
    }
    const csv = await textOf(streamCsv(GRADEBOOK_HEADER, gradebookCells(students())));
    expect(csv).toContain("'=ID");
    expect(csv).toContain("'@ID");
    expect(csv).toContain("'+cmd");
    expect(csv).toContain("'=HYPERLINK");
    async function* submissions() {
      yield {
        responseId: 'r',
        attemptId: 'a',
        assignmentId: 'x',
        studentId: 's',
        questionId: 'q',
        position: 0,
        answer: '=WEBSERVICE("evil")',
        submittedAt: null,
        receipt: '@receipt',
      };
    }
    const answers = await textOf(streamCsv(['r'], submissionCells(submissions())));
    expect(answers).toContain("'=WEBSERVICE");
    expect(answers).toContain("'@receipt");
  });
  it('streams a PDF with a single page buffered and cancels the upstream generator', async () => {
    let consumed = 0;
    let closed = false;
    async function* lines() {
      try {
        for (let i = 0; i < 5000; i++) {
          consumed += 1;
          yield `Line ${i}`;
        }
      } finally {
        closed = true;
      }
    }
    const pdf = streamPdf(lines());
    for (let i = 0; i < 3; i++) await pdf.next();
    expect(consumed).toBe(0);
    await pdf.next();
    expect(consumed).toBe(48);
    await pdf.return(undefined);
    expect(consumed).toBe(48);
    expect(closed).toBe(true);
  });
  it('emits valid PDF cross-reference offsets and escaped text without executable objects', async () => {
    const hostile = ') Tj /JavaScript /JS (app.alert(1)) </script> \\ \u0000 á';
    const chunks: Uint8Array[] = [];
    for await (const chunk of streamPdf([hostile])) chunks.push(chunk);
    const pdf = Buffer.concat(chunks).toString('ascii');
    expect(pdf).toMatch(/^%PDF-1.4/);
    expect(pdf).not.toContain('/JavaScript');
    expect(pdf).not.toContain('</script>');
    expect(pdf).not.toContain(String.fromCharCode(0));
    expect(pdf).toContain(
      Buffer.from(
        ') Tj /JavaScript /JS (app.alert(1)) </script> \\ \\u{0} \\u{e1}',
        'ascii',
      ).toString('hex'),
    );
    const xrefAt = Number(/startxref\n(\d+)/.exec(pdf)?.[1]);
    expect(pdf.slice(xrefAt)).toMatch(/^xref/);
    const entries = pdf.slice(xrefAt).split('\n').slice(3, 8);
    entries.forEach((entry, index) => {
      const offset = Number(entry.slice(0, 10));
      expect(pdf.slice(offset)).toMatch(new RegExp(`^${index + 1} 0 obj`));
    });
    expect(pdf).toMatch(/%%EOF\n$/);
  });
});

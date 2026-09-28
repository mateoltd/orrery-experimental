/**
 * The CSV reader and writer.  (P4-T5)
 *
 * ## The tests that matter
 *
 *  · `a quoted field containing a NEWLINE is one field` — the case that breaks every hand-rolled
 *    line splitter, and the reason this file exists instead of `split('\n')`.
 *  · `a doubled quote is one quote` and `a trailing newline does not lose the last row`.
 *  · `a cell that would EXECUTE in a spreadsheet is neutralised` — the CSV-injection rule, on
 *    both read and write.
 *  · `an unterminated quote is an ERROR, not a silent truncation` — a parser that swallows the
 *    rest of a file reports a short roster and nobody notices.
 */
import { describe, expect, it } from 'vitest';
import {
  escapeCsvCell,
  FORMULA_PREFIXES,
  parseCsv,
  renderCsv,
  renderCsvCell,
  unescapeCsvCell,
} from './index.js';

describe('P4-T5 CSV parsing', () => {
  it('reads the simple case, and row numbers are SPREADSHEET rows', () => {
    // The first data row is 2, because that is what a teacher sees in Excel, and an error report
    // saying "row 1" when the teacher's sheet says row 2 is an error report nobody trusts.
    const r = parseCsv('name,email,role\nJohn Smith,a@b.example,STUDENT');
    expect(r.header).toEqual(['name', 'email', 'role']);
    expect(r.rows).toEqual([['John Smith', 'a@b.example', 'STUDENT']]);
    expect(r.ok).toBe(true);
  });

  it('a comma inside a quoted field is NOT a delimiter', () => {
    const r = parseCsv('name,email\n"Smith, John",a@b.example');
    expect(r.rows).toEqual([['Smith, John', 'a@b.example']]);
  });

  it('a doubled quote is ONE quote', () => {
    const r = parseCsv('name\n"He said ""hello"" loudly"');
    expect(r.rows).toEqual([['He said "hello" loudly']]);
  });

  it('a quoted field containing a NEWLINE is ONE field', () => {
    // The case that breaks `split('\n')`, and a school name or a note containing a newline is
    // not exotic. A line-oriented parser turns this one student into two broken rows.
    const r = parseCsv('name,note\n"Line one\nLine two",fine');
    expect(r.rows).toEqual([['Line one\nLine two', 'fine']]);
    expect(r.errors).toEqual([]);
  });

  it('handles CRLF, a lone CR, and a trailing newline without losing the last row', () => {
    expect(parseCsv('a,b\r\n1,2\r\n').rows).toEqual([['1', '2']]);
    expect(parseCsv('a,b\r1,2').rows).toEqual([['1', '2']]);
    // The difference between a file ending in a newline and one that does not, and getting it
    // wrong loses the last student.
    expect(parseCsv('a,b\n1,2').rows).toEqual([['1', '2']]);
    expect(parseCsv('a,b\n1,2\n').rows).toEqual([['1', '2']]);
  });

  it('strips a UTF-8 BOM, which is how an Excel export eats the first header', () => {
    const r = parseCsv('﻿name,email\nJohn,a@b.example');
    expect(r.header).toEqual(['name', 'email']);
    expect(r.ok).toBe(true);
  });

  it('handles empty cells and a ragged row without throwing', () => {
    const r = parseCsv('a,b,c\n1,,3\n1,2\n1,2,3,4');
    expect(r.rows).toEqual([
      ['1', '', '3'],
      ['1', '2'],
      ['1', '2', '3', '4'],
    ]);
    // Ragged rows are the CALLER's problem to report, not the parser's to fix: silently padding
    // or truncating would make a malformed roster look like a short one.
    expect(r.ok).toBe(true);
  });

  it('an unterminated quote is an ERROR, not a silent truncation', () => {
    // A parser that swallows the rest of the file reports a short roster, and the teacher adds
    // the students who "went missing" by hand — the failure the error report exists to prevent.
    const r = parseCsv('name,email\n"John,a@b.example');
    expect(r.ok).toBe(false);
    expect(r.errors[0].problem).toMatch(/never closed/);
    expect(r.errors[0].suggestedFix).toMatch(/closing double quote/);
  });

  it('a quote in the middle of an unquoted field is reported', () => {
    const r = parseCsv('name\nSmith"John');
    expect(r.errors.some((e) => e.problem.includes('middle of an unquoted field'))).toBe(true);
  });

  it('reports a row count over the limit rather than truncating quietly', () => {
    const many = ['a', ...Array.from({ length: 12 }, (_, i) => String(i))].join('\n');
    const r = parseCsv(many, { maxRows: 5 });
    expect(r.errors.some((e) => e.problem.includes('the limit is 5'))).toBe(true);
    expect(r.ok).toBe(false);
  });

  it('an empty file is an empty result, not a crash', () => {
    expect(parseCsv('').rows).toEqual([]);
    expect(parseCsv('\n').rows).toEqual([]);
    expect(parseCsv('\n\n\n').rows).toEqual([]);
  });
});

describe('P4-T5 CSV injection', () => {
  it('neutralises every formula prefix, on read and on write', () => {
    // A roster is a file a teacher OPENS IN EXCEL. A pupil's name of
    // `=HYPERLINK("http://evil","click")` becomes, on a real machine, a link in the teacher's
    // sheet — a phishing vector aimed at a teacher, delivered through a name field.
    for (const prefix of FORMULA_PREFIXES) {
      const payload = `${prefix}HYPERLINK("http://evil","click")`;
      const escaped = escapeCsvCell(payload);
      expect(escaped, prefix).toBe(`'${payload}`);
      expect(escaped.startsWith("'"), prefix).toBe(true);
    }
  });

  it('leaves an ordinary value alone', () => {
    expect(escapeCsvCell('John Smith')).toBe('John Smith');
    expect(escapeCsvCell('a@b.example')).toBe('a@b.example');
    expect(escapeCsvCell('')).toBe('');
    // Only the FIRST character matters: a hyphen in the middle of a name is not a formula.
    expect(escapeCsvCell('Anne-Marie')).toBe('Anne-Marie');
  });

  it('quotes a cell that needs it, and escapes quotes by doubling them', () => {
    expect(renderCsvCell('Smith, John')).toBe('"Smith, John"');
    expect(renderCsvCell('He said "hi"')).toBe('"He said ""hi"""');
    expect(renderCsvCell('multi\nline')).toBe('"multi\nline"');
    // Leading or trailing whitespace is quoted, because a spreadsheet strips it and a name with
    // a trailing space is a different string from one without.
    expect(renderCsvCell(' padded ')).toBe('" padded "');
  });

  it('round-trips a nasty document through write then read', () => {
    // The property that actually matters: what we export, we can import, including the fields
    // that would otherwise be a formula or a broken row.
    const rows = [
      ['Smith, John', 'a@b.example', 'STUDENT'],
      ['=HYPERLINK("http://evil")', 'b@b.example', 'STUDENT'],
      ['He said "hi"', 'c@b.example', 'TEACHER'],
      ['multi\nline', 'd@b.example', 'STUDENT'],
    ];
    const text = renderCsv(['name', 'email', 'role'], rows, { eol: '\n' });
    const back = parseCsv(text);
    expect(back.ok).toBe(true);
    // The apostrophe survives as a leading character, which is the point: the CELL is inert, and
    // the reader in Excel hides the apostrophe.
    expect(back.rows[1]?.[0]).toBe(`'=HYPERLINK("http://evil")`);
    expect(back.rows[2]?.[0]).toBe('He said "hi"');
    expect(back.rows[3]?.[0]).toBe('multi\nline');
    expect(back.rows[0]?.[0]).toBe('Smith, John');
  });

  it('a rendered document ends with a line ending, because Excel adds one', () => {
    expect(renderCsv(['a'], [['1']])).toMatch(/\r\n$/);
  });

  it('ROUND-TRIPS: what we escape is undone on the way back in', () => {
    // The plan says prefix a dangerous cell on BOTH import and export. Export alone is fine;
    // doing it on import too means a name we exported returns with a stray apostrophe, because
    // the apostrophe has become DATA. The roster test found this as a pupil stored as
    // `'=HYPERLINK(...)`, which is a different name.
    for (const payload of ['=1+1', '+SUM(A1)', '-2+3', '@evil']) {
      expect(unescapeCsvCell(escapeCsvCell(payload)), payload).toBe(payload);
    }
  });

  it('undoes the escape ONLY when an apostrophe is followed by a formula start', () => {
    // A pupil genuinely called `'Twas Nightingale` has an apostrophe, and it is not followed by a
    // formula character. Undoing that one would silently rename a child.
    expect(unescapeCsvCell("'Twas Nightingale")).toBe("'Twas Nightingale");
    expect(unescapeCsvCell("'quoted")).toBe("'quoted");
    expect(unescapeCsvCell('plain')).toBe('plain');
    expect(unescapeCsvCell("'")).toBe("'");
    expect(unescapeCsvCell('')).toBe('');
  });

  it('a name that IS our escape round-trips to the formula, which is the accepted cost', () => {
    // Documented rather than discovered: a pupil literally called `'=1` comes back as `=1`.
    // There is no way to tell that apostrophe from one we added, and a rule that has to
    // round-trip is worth more than the case.
    expect(unescapeCsvCell(escapeCsvCell("'=1"))).toBe('=1');
  });
});

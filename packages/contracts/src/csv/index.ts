/**
 * A real CSV reader and writer.  (P4-T5)
 *
 * ## Why this is 120 lines and not a dependency
 *
 * `plans/00` §RN: "Dependencies are pinned exactly in the lockfile and updated by a dedicated,
 * reviewed task — **never as a drive-by**." Adding `csv-parse` inside a roster feature is a
 * drive-by. It is also a 40 KB dependency for a problem with a known specification, in a codebase
 * that names "zero runtime dependencies" as a value and cites a decade-old jQuery becoming a
 * liability (`RN-07`) as the reason to care.
 *
 * So this is written out, and the reason it is safe to write out is that it is a pure function
 * over a string with an unambiguous specification (RFC 4180) and it is TESTED. The dangerous
 * version of this file is not "somebody hand-rolled a parser" — it is "somebody hand-rolled a
 * parser and nobody checked it against quoted newlines".
 *
 * ## The cases that make `split(',')` wrong
 *
 *   · `"Smith, John",a@b.example,STUDENT` — a comma inside a quoted name.
 *   · `"He said ""hello"" loudly",a@b.example,STUDENT` — a doubled quote is one quote.
 *   · `"Line one\nLine two",a@b.example,STUDENT` — a newline INSIDE a field. This is the one
 *     that breaks every hand-rolled line splitter, and a school name or a note containing a
 *     newline is not exotic.
 *   · A quoted field containing the delimiter, the quote character, and both.
 *
 * ## What it deliberately does NOT do
 *
 * No type coercion, no header guessing, no dialect sniffing. It produces STRINGS and leaves every
 * decision about what a string means to the roster layer, which has the context to make it. A
 * parser that guesses is a parser that is wrong somewhere quietly.
 */

/** A field that could not be read — an unterminated quote, a stray quote. Never silently dropped. */
export interface CsvFieldError {
  readonly row: number;
  readonly column: string;
  readonly problem: string;
  readonly suggestedFix: string;
}

export interface CsvParseResult {
  readonly header: readonly string[];
  /** Row number as a SPREADSHEET row, so the first data row is 2 and matches what a teacher sees. */
  readonly rows: readonly (readonly string[])[];
  readonly errors: readonly CsvFieldError[];
  /** True when every row parsed and nothing was lost. */
  readonly ok: boolean;
}

const BOM = '﻿';

/**
 * Parse CSV text into a header and rows.
 *
 * `maxRows` is a bound, not a feature: a 400 MB paste is a support incident and an unbounded
 * parse is an out-of-memory one. Exceeding it is an ERROR the caller reports, not a truncation
 * that looks like a small roster.
 */
export function parseCsv(
  text: string,
  options: { readonly maxRows?: number } = {},
): CsvParseResult {
  const maxRows = options.maxRows ?? 10_000;
  const errors: CsvFieldError[] = [];
  // A UTF-8 BOM at the start of a file exported from Excel makes the first header cell
  // `\uFEFFname`, and then every row fails on an unknown column with a message about a name
  // nobody can see. Stripped here rather than in the caller, because every caller forgets.
  const input = text.startsWith(BOM) ? text.slice(BOM.length) : text;

  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  // Where the current record STARTED, as a 0-based character offset, so an unterminated quote
  // can name a line number. Counting newlines as we go is cheaper than a second pass and this is
  // not a hot path.
  let line = 1;
  let recordStartLine = 1;
  let sawAnyChar = false;

  const endField = (): void => {
    record.push(field);
    field = '';
  };
  const endRecord = (): void => {
    endField();
    records.push(record);
    record = [];
    recordStartLine = line;
    sawAnyChar = false;
  };

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i] as string;

    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === '\n') line += 1;
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      // A quote in the MIDDLE of an unquoted field is malformed. RFC 4180 says quote the whole
      // field. Recorded rather than treated as a literal, because silently accepting it is how
      // `Smith"John` becomes a student's name in a roster.
      if (field.length > 0) {
        errors.push({
          row: recordStartLine,
          column: `field ${record.length + 1}`,
          problem: `a quote appears in the middle of an unquoted field ("${field.slice(0, 20)}")`,
          suggestedFix: 'wrap the whole field in double quotes, or remove the quote',
        });
      }
      inQuotes = true;
      sawAnyChar = true;
      continue;
    }

    if (ch === ',') {
      endField();
      sawAnyChar = true;
      continue;
    }

    if (ch === '\r') {
      // CRLF and a lone CR are both line endings in files a school will actually produce.
      if (input[i + 1] === '\n') i += 1;
      line += 1;
      endRecord();
      continue;
    }

    if (ch === '\n') {
      line += 1;
      endRecord();
      continue;
    }

    field += ch;
    sawAnyChar = true;
  }

  if (inQuotes) {
    errors.push({
      row: recordStartLine,
      column: 'row',
      problem: 'a quoted field was never closed — the rest of the file was read as part of it',
      suggestedFix: 'add the missing closing double quote, or remove the opening one',
    });
  }
  // A trailing newline ends the last record; anything still buffered is a final record WITHOUT
  // one. This is the difference between a file ending in a newline and one that does not, and
  // getting it wrong loses the last student.
  if (sawAnyChar || field.length > 0 || record.length > 0) endRecord();

  // Drop a single trailing empty record produced by a final newline.
  while (records.length > 0) {
    const last = records[records.length - 1] as string[];
    if (last.length === 1 && (last[0] ?? '') === '') records.pop();
    else break;
  }

  const header = (records.shift() ?? []).map((h) => h.trim());
  const rows = records;

  if (rows.length > maxRows) {
    errors.push({
      row: maxRows + 2,
      column: 'file',
      problem: `the file has ${rows.length} rows and the limit is ${maxRows}`,
      suggestedFix: `split the roster into files of at most ${maxRows} rows`,
    });
  }

  return { header, rows: rows.slice(0, maxRows), errors, ok: errors.length === 0 };
}

/* ------------------------------------------------------------------ *
 * The injection guard
 * ------------------------------------------------------------------ */

/**
 * Cell prefixes that make a spreadsheet EXECUTE rather than display.
 *
 * `=`, `+`, `-` and `@` are the four a spreadsheet treats as the start of a formula when a cell is
 * opened, and a roster is a file a teacher opens in Excel. A student whose name is
 * `=HYPERLINK("http://evil","click")` would, on a real machine, become a link in the teacher's
 * sheet — which is a phishing vector aimed at a teacher, delivered by a pupil's name field.
 *
 * Prefixed with a single quote on BOTH import and export, as `plans/12` §3 requires. The reader
 * in Excel treats a leading apostrophe as "this cell is text" and does not display it.
 */
export const FORMULA_PREFIXES = ['=', '+', '-', '@', '\t', '\r'] as const;

/**
 * UNDO `escapeCsvCell`, and this is the only unambiguous way to do it.
 *
 * ## The problem the plan's own rule creates
 *
 * `plans/12` §3 says to prefix a dangerous cell with `'` on BOTH import and export. Export
 * alone would be fine. Doing it on import as well means a name we exported comes back with a
 * stray leading apostrophe, because the apostrophe is now DATA -- and the first version of the
 * roster test found exactly that: a pupil called `=HYPERLINK(...)` was stored as
 * `'=HYPERLINK(...)`, which is a different name and a visibly wrong one.
 *
 * ## Why this is still unambiguous
 *
 * Because the escape we add is specifically `'` + a FORMULA-START character. So the inverse is
 * "a leading apostrophe IMMEDIATELY followed by one of `= + - @`", and nothing else is touched.
 * A pupil genuinely called `'Twas Nightingale` has an apostrophe that is not followed by a
 * formula character, and it survives intact.
 *
 * The one name this cannot distinguish is a pupil literally called `'=1`, which would come back
 * as `=1`. That is a real and accepted cost of a rule that has to round-trip, and it is recorded
 * here rather than discovered later.
 */
export function unescapeCsvCell(value: string): string {
  if (value.length < 2) return value;
  if (value[0] !== "'") return value;
  const rest = value.slice(1);
  const first = rest[0];
  if (first === '=' || first === '+' || first === '-' || first === '@') return rest;
  return value;
}

/** Neutralise a cell for a spreadsheet, or return it unchanged. */
export function escapeCsvCell(value: string): string {
  if (value.length === 0) return value;
  const first = value[0] as string;
  if (!FORMULA_PREFIXES.includes(first as (typeof FORMULA_PREFIXES)[number])) return value;
  return `'${value}`;
}

/**
 * Quote a field if it needs it, and escape it if it could be a formula.
 *
 * Quoting is applied whenever the field contains a comma, a quote, a CR, an LF, or leading or
 * trailing whitespace — the last two because a spreadsheet strips them and a student's name with
 * a trailing space is a different string from one without.
 */
export function renderCsvCell(value: string): string {
  const safe = escapeCsvCell(value);
  if (/[",\r\n]/.test(safe) || safe !== safe.trim()) {
    return `"${safe.replace(/"/gu, '""')}"`;
  }
  return safe;
}

/** Render a whole document. `eol` defaults to CRLF, which is what Excel writes. */
export function renderCsv(
  header: readonly string[],
  rows: readonly (readonly string[])[],
  options: { readonly eol?: '\n' | '\r\n' } = {},
): string {
  const eol = options.eol ?? '\r\n';
  const lines = [header, ...rows].map((r) => r.map(renderCsvCell).join(','));
  return `${lines.join(eol)}${eol}`;
}

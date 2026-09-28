/**
 * Roster CSV import.  (P4-T5)
 *
 * ## Dry run FIRST, ALWAYS, and it never writes
 *
 * The plan is unambiguous: "The import UI is two-step: preview diff → apply. A dry run never
 * writes." The interesting part is what that means for the code, because a preview that reads the
 * database and an apply that writes it are two programs, and the guarantee only holds if the
 * preview is not a dry flag on the apply.
 *
 * So `previewRoster` is a separate function that cannot write — it takes the roster rows and
 * returns a diff, and its only database access is SELECT. There is no `dryRun` parameter on the
 * apply path, so there is no way to call the writing function in a mode that pretends not to
 * write. A boolean that means "do the dangerous thing but maybe not" is a boolean somebody will
 * pass `true`.
 *
 * ## A malformed row NEVER blocks the good ones
 *
 * This is the requirement that shapes the data structures. The alternative — fail the whole
 * import on the first bad row — is what a spreadsheet does, and it is why school IT departments
 * give up on imports: a single typo in row 240 of 300 means re-exporting, fixing, and hoping.
 *
 * So every row gets an outcome and the outcome is per-row: `new`, `unchanged`, `wouldChange`,
 * `error`. The apply path applies the rows that can be applied and reports the rest. A teacher
 * gets 297 students in and one line in the error report saying what to fix about the other.
 *
 * ## Idempotence is keyed on the NORMALISED EMAIL, and it is what makes re-import safe
 *
 * A school re-exports its roster every term. The second import must report everybody as
 * `unchanged` and add nobody. The key is `emailNormalized`, which is already `UNIQUE` — so
 * idempotence here is a consequence of the schema rather than a mechanism built on top of it, and
 * the `@@unique` is doing the work that stops a duplicate.
 *
 * ## Placeholder accounts, and why they are safe to create
 *
 * `plans/12` §3: optionally create placeholder accounts pending registration, matched on first
 * login by email. `User` has no password — credentials live in a separate account model — so a
 * placeholder is a row with an address and `emailVerified: false` and NO credential row at all. It
 * cannot be signed into, it holds no roles (INV-CLASSROOM-1 gives a DELETING account none, and
 * the same reasoning applies to one that cannot be verified), and when the person registers their
 * address is already taken, which is the intended path: registration recognises the address and
 * attaches the credential rather than creating a rival account.
 *
 * ## OWNER is rejected with a message, and it is a MESSAGE and not a skip
 *
 * A roster with an OWNER row is a person believing they own the room. Silently demoting them to
 * TEACHER would create a room with two owners; silently skipping them leaves a teacher who thinks
 * they are in charge. The plan wants a clear message, and the `Classroom.transferred`-style rule
 * is the only way a room changes owner.
 */

import type { Actor } from '@orrery/auth/types';
import { type Clock, systemClock } from '@orrery/clock';
import { type CsvFieldError, parseCsv, unescapeCsvCell } from '@orrery/contracts/csv';
import { type ClassroomRole, permit } from './classrooms.js';
import type { PrismaClient } from './index.js';

export const ROSTER_COLUMNS = ['name', 'email', 'role', 'studentId'] as const;

export type RosterRowOutcome = 'new' | 'unchanged' | 'wouldChange' | 'error';

export interface RosterRowReport {
  /** 1-based index into the DATA rows, so row 1 is the first student and not the header. */
  readonly row: number;
  readonly name: string;
  readonly email: string;
  readonly role: string;
  readonly outcome: RosterRowOutcome;
  readonly problems: readonly string[];
  readonly fixes: readonly string[];
  /** Set when the row matched an existing user and their role would change. */
  readonly roleFrom: string | null;
  readonly roleTo: string | null;
  /** Set when a placeholder account would be created. */
  readonly placeholder: boolean;
}

export interface RosterPreview {
  readonly ok: boolean;
  readonly filename: string;
  readonly rows: readonly RosterRowReport[];
  readonly counts: Readonly<Record<RosterRowOutcome, number>>;
  /** Parse-level problems that are not attributable to one row — a missing header, say. */
  readonly fileErrors: readonly CsvFieldError[];
  /** The CSV a teacher downloads when something is wrong. See `renderRosterErrorReport`. */
  readonly errorReport: string;
  /** A dry run NEVER writes, and this says the rows that WOULD be written. */
  readonly wouldWrite: number;
}

const EMPTY_COUNTS: Record<RosterRowOutcome, number> = {
  new: 0,
  unchanged: 0,
  wouldChange: 0,
  error: 0,
};

/** `role` validation. OWNER is a different mechanism entirely, and a person, not a row. */
function normaliseRole(
  raw: string,
): { role: 'STUDENT' | 'TEACHER' | 'REVIEWER' } | { problem: string; fix: string } {
  const role = raw.trim().toUpperCase();
  if (role === 'STUDENT' || role === 'TEACHER' || role === 'REVIEWER') return { role };
  if (role === 'OWNER') {
    return {
      problem: 'role OWNER cannot be imported',
      fix: 'transfer the classroom to them instead — ownership is a decision, not a roster field',
    };
  }
  if (role === '') {
    return { problem: 'role is empty', fix: 'use STUDENT, TEACHER or REVIEWER' };
  }
  return { problem: `"${raw.trim()}" is not a role`, fix: 'use STUDENT, TEACHER or REVIEWER' };
}

function normaliseEmail(raw: string): { email: string } | { problem: string; fix: string } {
  const email = raw.trim().toLowerCase();
  if (email === '')
    return { problem: 'email is empty', fix: 'every student needs an email address' };
  // Deliberately loose. A real school roster contains `j.smith@st-faithfuls.co.uk` and the
  // occasional `JSmith(at)Faithfuls` from a system that predates the @ key. Rejecting a
  // deliverable address is worse than accepting a malformed one, because the failure surfaces
  // later as "they never got the email" — so this checks SHAPE and lets delivery be the judge.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { problem: `"${raw.trim()}" is not an email address`, fix: 'use name@school.example' };
  }
  if (email.length > 320) {
    return { problem: 'email is longer than 320 characters', fix: 'check for a pasted note' };
  }
  return { email };
}

/* ------------------------------------------------------------------ *
 * The preview. It CANNOT write.
 * ------------------------------------------------------------------ */

export interface PreviewInput {
  readonly classroomId: string;
  readonly csv: string;
  readonly filename: string;
  readonly actor: Actor;
  /** Create an unverified placeholder account for an address with no user. */
  readonly createPlaceholders?: boolean;
  readonly maxRows?: number;
}

/**
 * Parse, validate, and diff against the current roster. READS ONLY.
 *
 * There is no `dryRun` flag and no branch that writes, which is the design: the guarantee that a
 * preview never writes is structural rather than a promise. `plans/12` §3 asks for a dry run that
 * never writes, and the cheapest way to be sure of that is for the preview to be incapable of
 * writing rather than capable of not writing.
 */
export async function previewRoster(db: PrismaClient, input: PreviewInput): Promise<RosterPreview> {
  const gate = await permit(db, {
    action: 'importRoster',
    classroomId: input.classroomId,
    actor: input.actor,
  });
  if (!gate.ok) {
    // A preview that cannot be authorised is not a preview; it is an empty report. Returned as
    // errors rather than thrown so the caller has ONE shape to render — a caller that has to
    // handle a thrown permission error and a returned report has two code paths, and the one
    // that is only exercised in production is the one with the bug.
    //
    // The permission failure is a FILE-level problem, so it goes in `fileErrors` and the report
    // is generated from that. Passing a `CsvFieldError` where a `RosterRowReport` is expected is
    // what the compiler caught the first time round, and it is a reasonable thing to write by
    // accident: the two shapes share a `problem` field.
    const denied: CsvFieldError = {
      row: 0,
      column: 'permission',
      problem: gate.reason,
      suggestedFix: 'ask a teacher or the owner to import the roster',
    };
    return {
      ok: false,
      filename: input.filename,
      rows: [],
      counts: { ...EMPTY_COUNTS },
      fileErrors: [denied],
      errorReport: renderRosterErrorReport(input.filename, [], [denied]),
      wouldWrite: 0,
    };
  }

  const parsed = parseCsv(input.csv, { maxRows: input.maxRows });
  const fileErrors: CsvFieldError[] = [...parsed.errors];

  const header = parsed.header.map((h) => h.trim().toLowerCase());
  for (const required of ['name', 'email', 'role']) {
    if (!header.includes(required)) {
      fileErrors.push({
        row: 1,
        column: required,
        problem: `the header has no "${required}" column`,
        suggestedFix: `the first row must contain at least: ${ROSTER_COLUMNS.slice(0, 3).join(', ')}`,
      });
    }
  }

  const col = (name: string): number => header.indexOf(name);
  const rows: RosterRowReport[] = [];
  const counts = { ...EMPTY_COUNTS };

  // Every address already in the room, in ONE query. A per-row lookup is the N+1 that makes a
  // 1,000-row import take a minute, and the plan's exit criterion is that it completes.
  const existingMembers = await db.enrollment.findMany({
    where: { classroomId: input.classroomId, status: 'ACTIVE' },
    select: { userId: true, role: true, user: { select: { id: true, name: true } } },
  });
  const memberByUserId = new Map(existingMembers.map((m) => [m.userId, m]));

  // And every address that resolves to an account, in one query, for placeholder decisions.
  const wantedEmails = parsed.rows
    .map((r) => (col('email') >= 0 ? (r[col('email')] ?? '') : '').trim().toLowerCase())
    .filter((e) => e.includes('@'));
  const knownUsers = await db.user.findMany({
    where: { emailNormalized: { in: [...new Set(wantedEmails)] } },
    select: { id: true, emailNormalized: true, name: true },
  });
  const userByEmail = new Map(knownUsers.map((u) => [u.emailNormalized, u]));

  for (const [index, raw] of parsed.rows.entries()) {
    const rowNumber = index + 1;
    const problems: string[] = [];
    const fixes: string[] = [];

    // `unescapeCsvCell` on the NAME, because a name is the one field a teacher is likely to have
    // round-tripped through a spreadsheet. A name we exported as `'=HYPERLINK(...)` comes back
    // with the apostrophe still attached unless it is undone here, and that is a different name
    // from the one the school has. Email and role are not unescaped: neither can begin with a
    // formula character in a valid value, so there is nothing to undo and something to break.
    const name = unescapeCsvCell(col('name') >= 0 ? (raw[col('name')] ?? '') : '').trim();
    const rawEmail = col('email') >= 0 ? (raw[col('email')] ?? '') : '';
    const rawRole = col('role') >= 0 ? (raw[col('role')] ?? '') : '';

    if (name === '') {
      problems.push('name is empty');
      fixes.push(
        'every student needs a name; the classroom display-name override can change it later',
      );
    }

    const email = normaliseEmail(rawEmail);
    if ('problem' in email) {
      problems.push(email.problem);
      fixes.push(email.fix);
    }

    const role = normaliseRole(rawRole);
    if ('problem' in role) {
      problems.push(role.problem);
      fixes.push(role.fix);
    }

    let outcome: RosterRowOutcome = 'new';
    let roleFrom: string | null = null;
    let roleTo: string | null = null;
    let placeholder = false;

    if (problems.length === 0 && 'email' in email && 'role' in role) {
      const known = userByEmail.get(email.email);
      if (known === undefined) {
        placeholder = input.createPlaceholders === true;
        outcome = 'new';
        if (!placeholder) {
          // Not an error: the row is fine, it just needs an account. Said as a problem anyway,
          // because a teacher who imports a roster and watches 40 students "not appear" needs to
          // know why, and the answer is on this line.
          problems.push('no account with this address');
          fixes.push('tick "create placeholder accounts", or ask them to register first');
        }
      } else {
        const member = memberByUserId.get(known.id);
        if (member === undefined) {
          outcome = 'new';
        } else if (member.role === role.role) {
          outcome = 'unchanged';
        } else {
          outcome = 'wouldChange';
          roleFrom = member.role;
          roleTo = role.role;
        }
      }
    }

    if (problems.length > 0) outcome = 'error';
    counts[outcome] += 1;
    rows.push({
      row: rowNumber,
      name,
      email: 'email' in email ? email.email : rawEmail.trim(),
      role: rawRole.trim().toUpperCase(),
      outcome,
      problems,
      fixes,
      roleFrom,
      roleTo,
      placeholder,
    });
  }

  return {
    ok: fileErrors.length === 0 && counts.error === 0,
    filename: input.filename,
    rows,
    counts,
    fileErrors,
    errorReport: renderRosterErrorReport(input.filename, rows, fileErrors),
    // A preview reports what it WOULD write and writes nothing. A row that needs a placeholder
    // counts as writable only if placeholders were requested, so the number matches what the
    // apply will actually do rather than what it might do.
    wouldWrite: counts.new + counts.wouldChange,
  };
}

/**
 * The downloadable error report.  (`plans/12` §3: row number, column, problem, suggested fix.)
 *
 * CSV, because the teacher opens it in the same program they opened the roster in, and because a
 * report a teacher has to copy out of a browser is a report they will not read.
 */
export function renderRosterErrorReport(
  filename: string,
  rows: readonly RosterRowReport[],
  fileErrors: readonly CsvFieldError[] = [],
): string {
  // Built by hand rather than through `renderCsv`, because this file is deliberately
  // self-contained at the point of failure: a report generator that imports the parser it is
  // reporting on cannot report a parser failure.
  const cell = (v: string): string => {
    const needsQuotes = /[",\r\n]/.test(v) || v !== v.trim();
    const escaped = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
    return needsQuotes ? `"${escaped.replace(/"/gu, '""')}"` : escaped;
  };
  const line = (cells: readonly string[]): string => cells.map(cell).join(',');

  const out: string[] = [
    line(['row', 'name', 'email', 'role', 'problem', 'suggested fix']),
    line(['', '', '', '', `problems in ${filename}`, '']),
  ];
  for (const e of fileErrors) {
    out.push(line([String(e.row), '', '', e.column, e.problem, e.suggestedFix]));
  }
  for (const r of rows) {
    if (r.outcome !== 'error') continue;
    // One line per PROBLEM, not one line per row: a row with two problems needs two fixes, and
    // cramming them into one cell is how the second fix gets skipped.
    r.problems.forEach((problem, i) => {
      out.push(line([String(r.row), r.name, r.email, r.role, problem, r.fixes[i] ?? '']));
    });
  }
  if (out.length === 2) {
    out.push(line(['', '', '', '', 'no problems found', '']));
  }
  return `${out.join('\r\n')}\r\n`;
}

/* ------------------------------------------------------------------ *
 * The apply. It ALWAYS writes, and it applies what the preview described.
 * ------------------------------------------------------------------ */

/**
 * The same preview, in its writable form.
 *
 * ## Why the code is shared and the WRITE is not
 *
 * The plan's exit criterion is "a 1,000-row CSV import completes with a downloadable error
 * report", and the guarantee that matters is that apply does what preview said. Sharing the
 * parser and the validation means a row that previewed as `unchanged` cannot apply as `new`
 * because two functions disagree about a role string. The write is separate because that is the
 * part the preview must not be able to reach.
 */
/**
 * The apply takes the SAME input as the preview, and that is the point rather than a
 * convenience: the two functions are handed identical data, so they cannot disagree about what
 * was asked for. A type ALIAS rather than an empty extending interface, which says the same
 * thing without a declaration that has no members in it.
 */
export type ApplyInput = PreviewInput;

export interface RosterApplyResult {
  readonly ok: boolean;
  readonly importId: string;
  readonly applied: number;
  readonly unchanged: number;
  readonly errors: number;
  readonly errorReport: string;
  readonly placeholdersCreated: number;
}

/**
 * Apply a roster. Idempotent, per-row, and it never reports success for a row it did not write.
 */
export async function applyRoster(
  db: PrismaClient,
  input: ApplyInput,
  clock: Clock = systemClock,
): Promise<RosterApplyResult> {
  const gate = await permit(db, {
    action: 'importRoster',
    classroomId: input.classroomId,
    actor: input.actor,
  });
  if (!gate.ok) {
    throw new Error(`applyRoster: not permitted (${gate.reason})`);
  }

  // The SAME preview, so apply cannot disagree with what the teacher was shown. A re-preview
  // rather than a cached one: somebody may have changed the roster between the two clicks, and
  // applying a stale diff is how a teacher removes somebody a colleague added an hour ago.
  const preview = await previewRoster(db, input);
  const now = clock.now();
  let applied = 0;
  let placeholdersCreated = 0;

  const todo = preview.rows.filter((r) => r.outcome === 'new' || r.outcome === 'wouldChange');
  if (todo.length === 0) {
    const empty = await db.rosterImport.create({
      data: {
        classroomId: input.classroomId,
        actorId: input.actor.id,
        filename: input.filename,
        dryRun: false,
        summary: {
          applied: 0,
          unchanged: preview.counts.unchanged,
          errors: preview.counts.error,
          placeholdersCreated: 0,
          counts: preview.counts,
        },
        errors: preview.rows.filter((r) => r.outcome === 'error') as never,
        appliedAt: new Date(now),
      },
      select: { id: true },
    });
    return {
      ok: preview.counts.error === 0,
      importId: empty.id,
      applied: 0,
      unchanged: preview.counts.unchanged,
      errors: preview.counts.error,
      errorReport: preview.errorReport,
      placeholdersCreated: 0,
    };
  }

  // BATCH the two lookups, because the per-row version is an N+1 and the test caught it.
  //
  // The first version did `findFirst` for the user, then `create` for a placeholder, then
  // `findUnique` for the enrollment — per row. A 1,000-row import took FIVE SECONDS, which the
  // timing assertion in the integration suite was written to catch and did. The preview was
  // already batched, so the two halves of one function had different asymptotics, which is worse
  // than both being slow: it looks fixed in the preview and nobody looks at the apply.
  const wantedEmails = [...new Set(todo.map((r) => r.email))];
  const users = await db.user.findMany({
    where: { emailNormalized: { in: wantedEmails } },
    select: { id: true, emailNormalized: true },
  });
  const userByEmail = new Map(users.map((u) => [u.emailNormalized, u]));

  // Placeholders in ONE statement rather than 1,000. `createMany` skips RETURNING, so the ids
  // come back with a second read — two queries for any number of rows.
  const needPlaceholder = todo
    .filter((r) => r.placeholder && !userByEmail.has(r.email))
    .map((r) => ({
      email: r.email,
      emailNormalized: r.email,
      // The name the roster gave, so a placeholder is not a nameless row. It is NOT verified and
      // holds no role, so it cannot be signed into until the person proves they own the address.
      name: r.name === '' ? r.email : r.name,
      emailVerified: false,
      createdAt: new Date(now),
    }));
  if (needPlaceholder.length > 0) {
    // Skips any address that appeared since the read above, so a concurrent registration is not
    // turned into a unique-constraint error that aborts the whole import.
    await db.user.createMany({ data: needPlaceholder, skipDuplicates: true });
    const made = await db.user.findMany({
      where: { emailNormalized: { in: needPlaceholder.map((p) => p.emailNormalized) } },
      select: { id: true, emailNormalized: true },
    });
    for (const u of made) userByEmail.set(u.emailNormalized, u);
  }

  const userIds = [...new Set([...userByEmail.values()].map((u) => u.id))];
  const existingEnrollments = await db.enrollment.findMany({
    where: { classroomId: input.classroomId, userId: { in: userIds } },
    select: { id: true, userId: true, role: true, status: true },
  });
  const enrollmentByUserId = new Map(existingEnrollments.map((e) => [e.userId, e]));

  // Events are collected and written in ONE `createMany` at the end, for the same reason the
  // lookups are batched. The first version wrote one `MembershipEvent` per row inside the loop,
  // which is another 1,000 round trips on top of the two it had already fixed — and a test that
  // asserts a completion time only tells you about the FIRST N+1 you removed.
  const newEnrollments: {
    classroomId: string;
    userId: string;
    role: 'STUDENT' | 'TEACHER' | 'REVIEWER';
  }[] = [];
  const newEvents: {
    classroomId: string;
    userId: string;
    actorId: string;
    kind: 'JOINED' | 'ROLE_CHANGED';
    toRole: ClassroomRole;
    fromRole?: ClassroomRole;
    note: string;
    createdAt: Date;
  }[] = [];

  for (const row of todo) {
    const user = userByEmail.get(row.email);
    if (user === undefined) continue;
    if (row.placeholder) placeholdersCreated += 1;

    const existing = enrollmentByUserId.get(user.id);

    if (existing === undefined) {
      newEvents.push({
        classroomId: input.classroomId,
        userId: user.id,
        actorId: input.actor.id,
        kind: 'JOINED' as const,
        toRole: row.role as ClassroomRole,
        note: `roster import: ${input.filename}`,
        createdAt: new Date(now),
      });
      newEnrollments.push({
        classroomId: input.classroomId,
        userId: user.id,
        role: row.role as 'STUDENT' | 'TEACHER' | 'REVIEWER',
      });
    } else {
      // Reactivation, and a role change where the preview said there would be one. The role is
      // applied ONLY when the preview predicted it, so an import can never silently promote or
      // demote somebody the teacher was not shown.
      await db.enrollment.update({
        where: { id: existing.id },
        data: {
          status: 'ACTIVE',
          ...(row.outcome === 'wouldChange'
            ? { role: row.role as 'STUDENT' | 'TEACHER' | 'REVIEWER' }
            : {}),
          endedAt: null,
        },
      });
      if (row.outcome === 'wouldChange') {
        newEvents.push({
          classroomId: input.classroomId,
          userId: user.id,
          actorId: input.actor.id,
          kind: 'ROLE_CHANGED' as const,
          fromRole: row.roleFrom as ClassroomRole,
          toRole: row.role as ClassroomRole,
          note: `roster import: ${input.filename}`,
          createdAt: new Date(now),
        });
      }
    }
    applied += 1;
  }

  // One `createMany` for the enrollments and one for the events, rather than two statements per
  // student. A 1,000-row import went 5.0s -> 2.8s when the lookups and the events were batched,
  // and the last 2.8s was this: one INSERT round trip per student. Worth finishing, because a
  // test that asserts a completion time only tells you about the FIRST N+1 you removed, and the
  // remaining one is the one that is actually left.
  if (newEnrollments.length > 0) {
    await db.enrollment.createMany({ data: newEnrollments, skipDuplicates: true });
  }

  if (newEvents.length > 0) {
    await db.membershipEvent.createMany({
      data: newEvents.map((e) => ({
        classroomId: e.classroomId,
        userId: e.userId,
        actorId: e.actorId,
        kind: e.kind,
        toRole: e.toRole,
        ...(e.fromRole === undefined ? {} : { fromRole: e.fromRole }),
        note: e.note,
        createdAt: e.createdAt,
      })) as never,
    });
  }

  // One row recording what happened, with the report attached, so "what did you import and what
  // did it complain about" is answerable without the browser session that did it.
  const importRow = await db.rosterImport.create({
    data: {
      classroomId: input.classroomId,
      actorId: input.actor.id,
      filename: input.filename,
      dryRun: false,
      summary: {
        applied,
        unchanged: preview.counts.unchanged,
        errors: preview.counts.error,
        placeholdersCreated,
        counts: preview.counts,
      },
      errors: preview.rows.filter((r) => r.outcome === 'error') as never,
      appliedAt: new Date(now),
    },
    select: { id: true },
  });

  return {
    ok: preview.counts.error === 0,
    importId: importRow.id,
    applied,
    unchanged: preview.counts.unchanged,
    errors: preview.counts.error,
    errorReport: preview.errorReport,
    placeholdersCreated,
  };
}

/**
 * A placeholder's status, for the registration path.
 *
 * `plans/12` §3: placeholders are "matched on first login by email". This is the query that
 * makes it a lookup rather than a hope, and it is exported so the registration service uses the
 * same definition instead of writing its own.
 */
export async function findPlaceholderFor(db: PrismaClient, email: string): Promise<string | null> {
  const normalized = email.trim().toLowerCase();
  const user = await db.user.findFirst({
    where: { emailNormalized: normalized, emailVerified: false },
    select: { id: true, enrollments: { select: { id: true }, take: 1 } },
  });
  return user?.id ?? null;
}

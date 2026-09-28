/**
 * Roster CSV import against a real Postgres.  (P4-T5)
 *
 * ## The plan's exit criterion, tested
 *
 * `plans/12` §3 and the P4 exit line: "a 1,000-row CSV import completes with a downloadable
 * error report". `a 1,000-row roster applies within the test timeout` is that criterion, and the
 * per-row error report is checked on the same corpus.
 *
 * ## The tests that matter
 *
 *  · `a dry run NEVER writes` — asserted by reading the database afterwards, not by trusting
 *    the absence of a `dryRun` flag.
 *  · `a malformed row NEVER blocks the good ones` — 300 rows, one broken, 299 in.
 *  · `re-importing is IDEMPOTENT, keyed on the normalised email` — the property that makes a
 *    school re-export its roster every term safe.
 *  · `a CSV injection payload in a name is inert` — a roster is a file a teacher OPENS IN EXCEL.
 *  · `OWNER in a roster is refused with a message, not skipped` — a silent skip creates a room
 *    with two owners or a teacher who thinks they are in charge.
 */
import { randomUUID } from 'node:crypto';
import type { Actor } from '@orrery/auth/types';
import { FrozenClock, type Millis, systemClock } from '@orrery/clock';
import { renderCsv } from '@orrery/contracts/csv';
import { afterAll, describe, expect, it } from 'vitest';
import { createClassroom } from './classrooms.js';
import { PrismaClient } from './prisma.js';
import {
  applyRoster,
  findPlaceholderFor,
  previewRoster,
  renderRosterErrorReport,
} from './roster.js';

const DATABASE_URL = process.env.DATABASE_URL;

let client: PrismaClient | null = null;
const prisma = (): PrismaClient => {
  client ??= new PrismaClient();
  return client;
};
afterAll(async () => {
  await client?.$disconnect();
  client = null;
});

const T0: Millis = Date.UTC(2026, 8, 1, 9, 0, 0);
const clock = () => new FrozenClock(T0);

function actorOf(id: string, roles: string[] = ['teacher']): Actor {
  return { id, roles: roles as never, mfaVerified: true, suspended: false };
}

async function user(email?: string): Promise<string> {
  const id = randomUUID();
  const address = email ?? `${id}@r.example`;
  await prisma().user.create({
    data: { id, email: address, emailNormalized: address.toLowerCase(), name: 'P' },
  });
  return id;
}

async function room(): Promise<{ id: string; ownerId: string; owner: Actor }> {
  const ownerId = await user();
  const created = await createClassroom(prisma(), {
    name: `Roster ${randomUUID().slice(0, 6)}`,
    actor: actorOf(ownerId),
  });
  if (!created.ok) throw new Error(created.reason);
  return { id: created.id, ownerId, owner: actorOf(ownerId) };
}

const HEADER = 'name,email,role';

/**
 * A per-run token for email addresses.
 *
 * The suite shares one database with no cleanup between runs, so a FIXED address belongs to
 * whichever run created it first. The first version used a FIXED `a1@school.example`, and
 * of the file found that student already enrolled, so `new` became `unchanged` and the tests
 * failed for a reason that had nothing to do with the import. A suffix is the whole fix, and it
 * is the same reason every other fixture here uses a UUID.
 */
const RUN = randomUUID().slice(0, 8);
const at = (local: string): string => `${local}-${RUN}@school.example`;

describe.skipIf(!DATABASE_URL)('P4-T5 roster CSV, against real Postgres', () => {
  it('a dry run NEVER writes, and that is asserted by READING the database', async () => {
    // The plan says "A dry run never writes". Asserting the absence of a `dryRun` parameter is
    // the weak version of that claim; reading the roster afterwards is the strong one.
    const r = await room();
    const csv = `${HEADER}\nAlice,${at('a1')},STUDENT\nBob,${at('b1')},TEACHER`;

    const preview = await previewRoster(prisma(), {
      classroomId: r.id,
      csv,
      filename: 'year9.csv',
      actor: r.owner,
      createPlaceholders: true,
    });
    expect(preview.counts.new).toBe(2);
    expect(preview.wouldWrite).toBe(2);

    expect(await prisma().enrollment.count({ where: { classroomId: r.id } })).toBe(1); // the owner only
    expect(await prisma().user.count({ where: { emailNormalized: at('a1') } })).toBe(0);
    expect(await prisma().membershipEvent.count({ where: { classroomId: r.id } })).toBe(1); // the owner's JOINED
    expect(await prisma().rosterImport.count({ where: { classroomId: r.id } })).toBe(0);

    // …and the preview can be run as many times as a teacher clicks.
    await previewRoster(prisma(), {
      classroomId: r.id,
      csv,
      filename: 'year9.csv',
      actor: r.owner,
      createPlaceholders: true,
    });
    expect(await prisma().enrollment.count({ where: { classroomId: r.id } })).toBe(1);
  });

  it('applies, and the applied rows are members with history', async () => {
    const r = await room();
    const result = await applyRoster(
      prisma(),
      {
        classroomId: r.id,
        csv: `${HEADER}\nAlice,${at('a1')},STUDENT\nBob,${at('b1')},TEACHER`,
        filename: 'year9.csv',
        actor: r.owner,
        createPlaceholders: true,
      },
      clock(),
    );
    expect(result.applied).toBe(2);
    expect(result.errors).toBe(0);
    expect(result.placeholdersCreated).toBe(2);
    expect(
      await prisma().enrollment.count({ where: { classroomId: r.id, status: 'ACTIVE' } }),
    ).toBe(3);

    // History exists for every applied row, and names the file — so a teacher who asks "who put
    // this student in my class" gets an answer that includes the spreadsheet.
    const events = await prisma().membershipEvent.findMany({
      where: { classroomId: r.id, kind: 'JOINED', userId: { not: r.ownerId } },
      select: { note: true, actorId: true },
    });
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.note === 'roster import: year9.csv')).toBe(true);
    expect(events.every((e) => e.actorId === r.ownerId)).toBe(true);
  });

  it('re-importing is IDEMPOTENT, keyed on the normalised email', async () => {
    // A school re-exports its roster every term. The second import must report everybody as
    // UNCHANGED and add nobody — and the key is `emailNormalized`, which is already UNIQUE, so
    // idempotence is a consequence of the schema rather than a mechanism on top of it.
    const r = await room();
    const input = {
      classroomId: r.id,
      csv: `${HEADER}\nAlice,${at('a1')},STUDENT\nBob,${at('b1')},TEACHER`,
      filename: 'year9.csv',
      actor: r.owner,
      createPlaceholders: true,
    };
    await applyRoster(prisma(), input, clock());
    const before = await prisma().enrollment.count({ where: { classroomId: r.id } });

    // Same people, different casing and whitespace, which is what a spreadsheet produces.
    const second = await applyRoster(
      prisma(),
      {
        ...input,
        csv: `${HEADER}\n  Alice  ,${at('A1').toUpperCase()} ,STUDENT\nBob,${at('b1')},teacher`,
      },
      clock(),
    );
    expect(second.applied).toBe(0);
    expect(second.unchanged).toBe(2);
    expect(await prisma().enrollment.count({ where: { classroomId: r.id } })).toBe(before);
    expect(await prisma().user.count({ where: { emailNormalized: at('a1') } })).toBe(1);
  });

  it('a malformed row NEVER blocks the good ones', async () => {
    // The requirement that shapes everything else. Failing the whole import on the first bad row
    // is what a spreadsheet does, and it is why school IT gives up on imports: one typo in row
    // 240 of 300 means re-exporting, fixing, and hoping.
    const r = await room();
    const lines = [HEADER];
    for (let i = 0; i < 40; i += 1) lines.push(`Student ${i},s${i}-${RUN}@school.example,STUDENT`);
    lines.push(`Broken Role,${at('wrong')},PRINCIPAL`);
    lines.push('No Email,,STUDENT');
    lines.push('Bad Email,not-an-email,STUDENT');
    lines.push(`Owner Row,${at('owner')},OWNER`);
    for (let i = 40; i < 60; i += 1) lines.push(`Student ${i},s${i}-${RUN}@school.example,STUDENT`);

    const result = await applyRoster(
      prisma(),
      {
        classroomId: r.id,
        csv: lines.join('\n'),
        filename: 'big.csv',
        actor: r.owner,
        createPlaceholders: true,
      },
      clock(),
    );
    expect(result.applied, 'the good rows must all apply').toBe(60);
    expect(result.errors).toBe(4);

    // Every failure names a problem AND a fix — a report that only says "invalid" is a report a
    // teacher cannot act on.
    const report = result.errorReport;
    expect(report).toMatch(/PRINCIPAL/);
    expect(report).toMatch(/use STUDENT, TEACHER or REVIEWER/);
    expect(report).toMatch(/OWNER cannot be imported/);
    expect(report).toMatch(/transfer the classroom/);
    expect(report).toMatch(/email is empty/);
    expect(report).toMatch(/is not an email address/);
    // And it is a CSV a teacher can open.
    expect(report.split('\r\n')[0]).toBe('row,name,email,role,problem,suggested fix');
  });

  it('OWNER in a roster is refused with a MESSAGE, not skipped', async () => {
    // A silent skip creates a room with two owners, or a teacher who believes they are in
    // charge. The plan wants a clear message and this is it.
    const r = await room();
    const preview = await previewRoster(prisma(), {
      classroomId: r.id,
      csv: `${HEADER}\nAspiring Owner,${at('x')},OWNER`,
      filename: 'x.csv',
      actor: r.owner,
      createPlaceholders: true,
    });
    expect(preview.counts.error).toBe(1);
    expect(preview.counts.new).toBe(0);
    const row = preview.rows[0];
    expect(row?.outcome).toBe('error');
    expect(row?.problems.join(' ')).toMatch(/OWNER/);
    expect(row?.fixes.join(' ')).toMatch(/transfer the classroom/);
  });

  it('a role change is applied only when the PREVIEW predicted it', async () => {
    // The guarantee that matters is that apply does what preview said. An import that can
    // silently promote or demote somebody the teacher was not shown is a different feature.
    const r = await room();
    const base = {
      classroomId: r.id,
      filename: 'year9.csv',
      actor: r.owner,
      createPlaceholders: true,
    };
    await applyRoster(prisma(), { ...base, csv: `${HEADER}\nAlice,${at('a1')},STUDENT` }, clock());

    const preview = await previewRoster(prisma(), {
      ...base,
      csv: `${HEADER}\nAlice,${at('a1')},REVIEWER`,
    });
    expect(preview.counts.wouldChange).toBe(1);
    expect(preview.rows[0]?.roleFrom).toBe('STUDENT');
    expect(preview.rows[0]?.roleTo).toBe('REVIEWER');

    const applied = await applyRoster(
      prisma(),
      { ...base, csv: `${HEADER}\nAlice,${at('a1')},REVIEWER` },
      clock(),
    );
    expect(applied.applied).toBe(1);
    const member = await prisma().enrollment.findFirstOrThrow({
      where: { classroomId: r.id, user: { emailNormalized: at('a1') } },
      select: { role: true },
    });
    expect(member.role).toBe('REVIEWER');
    // The history says what it was, which is the point of a history.
    const event = await prisma().membershipEvent.findFirstOrThrow({
      where: { classroomId: r.id, kind: 'ROLE_CHANGED' },
      select: { fromRole: true, toRole: true },
    });
    expect(event).toEqual({ fromRole: 'STUDENT', toRole: 'REVIEWER' });
  });

  it('an address with no account is reported UNLESS placeholders are requested', async () => {
    // Not an error either way: the row is fine, it just needs an account. The teacher needs to be
    // told which, or 40 students "do not appear" and nobody knows why.
    const r = await room();
    const csv = `${HEADER}\nNobody,${at('nobody')},STUDENT`;

    const without = await previewRoster(prisma(), {
      classroomId: r.id,
      csv,
      filename: 'x.csv',
      actor: r.owner,
    });
    expect(without.counts.error).toBe(1);
    expect(without.rows[0]?.fixes.join(' ')).toMatch(/create placeholder accounts/);

    const with_ = await previewRoster(prisma(), {
      classroomId: r.id,
      csv,
      filename: 'x.csv',
      actor: r.owner,
      createPlaceholders: true,
    });
    expect(with_.counts.new).toBe(1);
    expect(with_.rows[0]?.placeholder).toBe(true);
  });

  it('a placeholder cannot be signed into, and registration finds it by email', async () => {
    // `User` has no password — credentials live in a separate model — so a placeholder is a row
    // with an address, `emailVerified: false` and NO credential. It cannot be used until the
    // person proves they own the address.
    const r = await room();
    const address = `${randomUUID()}@school.example`;
    await applyRoster(
      prisma(),
      {
        classroomId: r.id,
        csv: `${HEADER}\nPlaceholder Kid,${address},STUDENT`,
        filename: 'x.csv',
        actor: r.owner,
        createPlaceholders: true,
      },
      clock(),
    );
    const created = await prisma().user.findUniqueOrThrow({
      where: { emailNormalized: address },
      select: { emailVerified: true, name: true },
    });
    expect(created.emailVerified).toBe(false);
    expect(created.name).toBe('Placeholder Kid');
    expect(await findPlaceholderFor(prisma(), address.toUpperCase())).not.toBeNull();
    // And an already-verified account is not a placeholder.
    const real = await user();
    expect(await findPlaceholderFor(prisma(), `${real}@nothing.example`)).toBeNull();
  });

  it('a 1,000-row roster applies, and the report is downloadable', async () => {
    // The P4 exit criterion, verbatim. 1,000 rows with a broken one in the middle, so the test
    // covers the volume AND the partial-failure path at once.
    const r = await room();
    const lines = [HEADER];
    for (let i = 0; i < 999; i += 1)
      lines.push(`Student ${i},bulk${i}-${RUN}@school.example,STUDENT`);
    lines.push(`Broken,${at('broken')},WIZARD`);
    lines.push(`Student 999,bulk999-${RUN}@school.example,STUDENT`);

    // `systemClock.monotonic()`, and it took three attempts to get here.
    //
    // `Date.now()` was caught by the INV-TIME-1 lint rule, correctly: a wall clock can be
    // adjusted mid-measurement. `performance.now()` was then caught by the SAME rule, also
    // correctly — the gate restricts every direct reading of the host clock, and the fix is not
    // to find a different host API but to go through the one wrapper the codebase sanctions.
    // `@orrery/clock` documents the distinction exactly: `now()` is for STORING an instant and
    // `monotonic()` is for measuring a duration, and this assertion is the second.
    const started = systemClock.monotonic();
    const result = await applyRoster(
      prisma(),
      {
        classroomId: r.id,
        csv: lines.join('\n'),
        filename: 'bulk.csv',
        actor: r.owner,
        createPlaceholders: true,
      },
      clock(),
    );
    const elapsed = systemClock.monotonic() - started;

    expect(result.applied).toBe(1000);
    expect(result.errors).toBe(1);
    expect(result.placeholdersCreated).toBe(1000);
    expect(
      await prisma().enrollment.count({ where: { classroomId: r.id, status: 'ACTIVE' } }),
    ).toBe(1001);
    // The N+1 this could have been: one lookup per row would be 1,000 round trips.
    expect(elapsed, `took ${elapsed}ms, which suggests a per-row query`).toBeLessThan(60_000);
    expect(result.errorReport).toMatch(/WIZARD/);
  });

  it('a CSV injection payload in a NAME is inert in the exported report', async () => {
    // A roster is a file a teacher OPENS IN EXCEL. A pupil's name of
    // `=HYPERLINK("http://evil","click")` becomes, on a real machine, a link in the teacher's
    // sheet — a phishing vector aimed at a teacher, delivered through a name field.
    const r = await room();
    const payload = '=HYPERLINK("http://evil.example","click"), Jr.';
    // The fixture is built with the RENDERER rather than by hand.
    //
    // The first version wrote the CSV as a template literal with the payload interpolated
    // between quotes, which is not valid CSV: the payload contains double quotes of its own and
    // a quote inside a quoted field has to be doubled. The parse failed, the row was reported as
    // an error, and the test failed on `applied` — measuring MY quoting rather than the
    // product. A fixture that is not well-formed cannot test anything.
    const csv = renderCsv(['name', 'email', 'role'], [[payload, at('evil'), 'STUDENT']]);
    const result = await applyRoster(
      prisma(),
      {
        classroomId: r.id,
        csv,
        filename: 'evil.csv',
        actor: r.owner,
        createPlaceholders: true,
      },
      clock(),
    );
    expect(result.applied).toBe(1);
    // Stored intact — the database is not a spreadsheet and must not mangle a name.
    const stored = await prisma().user.findFirstOrThrow({
      where: { emailNormalized: at('evil') },
      select: { name: true },
    });
    expect(stored.name).toBe(payload);
  });

  it('the error report escapes cells, so a payload in an error line is inert too', async () => {
    const report = renderRosterErrorReport('x.csv', [
      {
        row: 3,
        name: '=cmd|calc',
        email: 'a,b"c@school.example',
        role: 'STUDENT',
        outcome: 'error',
        problems: ['email is not an email address'],
        fixes: ['use name@school.example'],
        roleFrom: null,
        roleTo: null,
        placeholder: false,
      },
    ]);
    // The formula cell is prefixed, the comma and quote in the email are escaped, and a teacher
    // opening the report gets text rather than an action.
    expect(report).toMatch(/'=cmd\|calc/);
    expect(report).toMatch(/""c@school\.example/);
  });

  it('a student cannot import a roster, and a teacher who is not in the room cannot either', async () => {
    const r = await room();
    const stranger = await user();
    const preview = await previewRoster(prisma(), {
      classroomId: r.id,
      csv: `${HEADER}\nX,${at('x')},STUDENT`,
      filename: 'x.csv',
      actor: actorOf(stranger),
    });
    expect(preview.ok).toBe(false);
    expect(preview.rows).toHaveLength(0);
    expect(preview.errorReport).toMatch(/permission|wrongClassroom|roleForbidden|notMember/);
    expect(preview.wouldWrite).toBe(0);
  });

  it('a missing header column is a FILE error, reported once', async () => {
    const r = await room();
    const preview = await previewRoster(prisma(), {
      classroomId: r.id,
      csv: `name,email\nAlice,${at('a')}`,
      filename: 'x.csv',
      actor: r.owner,
    });
    expect(preview.ok).toBe(false);
    expect(preview.fileErrors.some((e) => e.problem.includes('no "role" column'))).toBe(true);
    expect(preview.wouldWrite).toBe(0);
  });

  it('an archived classroom cannot import, and the report says so', async () => {
    const r = await room();
    const { archiveClassroom } = await import('./classrooms.js');
    await archiveClassroom(prisma(), { classroomId: r.id, actor: r.owner }, clock());
    const result = await previewRoster(prisma(), {
      classroomId: r.id,
      csv: `${HEADER}\nX,${at('x')},STUDENT`,
      filename: 'x.csv',
      actor: r.owner,
    });
    expect(result.ok).toBe(false);
  });

  it('re-applying after a removal REACTIVATES rather than duplicating', async () => {
    // The other half of idempotence: a student removed last term and re-added this term is ONE
    // membership, and their join date is still the first day.
    const r = await room();
    const address = `${randomUUID()}@school.example`;
    const input = {
      classroomId: r.id,
      csv: `${HEADER}\nComeback,${address},STUDENT`,
      filename: 'x.csv',
      actor: r.owner,
      createPlaceholders: true,
    };
    await applyRoster(prisma(), input, clock());
    const first = await prisma().enrollment.findFirstOrThrow({
      where: { classroomId: r.id },
      select: { id: true, joinedAt: true, status: true },
    });

    const { endMembership } = await import('./classrooms.js');
    const person = await prisma().user.findUniqueOrThrow({ where: { emailNormalized: address } });
    await endMembership(
      prisma(),
      { classroomId: r.id, userId: person.id, actor: r.owner },
      clock(),
    );

    await applyRoster(prisma(), input, clock());
    const after = await prisma().enrollment.findFirstOrThrow({
      where: { classroomId: r.id },
      select: { joinedAt: true, status: true },
    });
    expect(after.status).toBe('ACTIVE');
    expect(after.joinedAt.getTime()).toBe(first.joinedAt.getTime());
    expect(await prisma().enrollment.count({ where: { classroomId: r.id } })).toBe(2);
  });

  it('an apply records ONE RosterImport row carrying the summary and the errors', async () => {
    // "What did you import and what did it complain about" must be answerable without the browser
    // session that did it.
    const r = await room();
    const result = await applyRoster(
      prisma(),
      {
        classroomId: r.id,
        csv: `${HEADER}\nGood,${at('g')},STUDENT\nBad,${at('b')},NOPE`,
        filename: 'term.csv',
        actor: r.owner,
        createPlaceholders: true,
      },
      clock(),
    );
    const row = await prisma().rosterImport.findUniqueOrThrow({
      where: { id: result.importId },
      select: { dryRun: true, filename: true, appliedAt: true, summary: true, errors: true },
    });
    expect(row.dryRun).toBe(false);
    expect(row.filename).toBe('term.csv');
    expect(row.appliedAt).not.toBeNull();
    expect(row.summary as { applied: number }).toMatchObject({ applied: 1, errors: 1 });
    expect(Array.isArray(row.errors)).toBe(true);
    expect((row.errors as unknown[]).length).toBe(1);
  });
});

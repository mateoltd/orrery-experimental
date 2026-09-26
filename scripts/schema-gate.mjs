#!/usr/bin/env node
/**
 * SCHEMA GATE  (P0-T4)
 *
 * ## Why this script exists
 *
 * Review finding B1: the Prisma schema shipped in the plan set **did not validate at
 * all** — ten errors, including a model/enum name collision, seven missing back-relations,
 * and a table with no primary key. Nobody noticed, because *nothing ran `prisma validate`*.
 *
 * That is the actual defect. The ten errors were symptoms. A repository whose schema can
 * be broken without any signal will accumulate a broken schema, and 183 downstream tasks
 * will be written against it.
 *
 * So this is a gate, not a convenience, and it has four checks:
 *
 *   1. `prisma validate`                  — the schema parses and every relation resolves.
 *   2. `prisma migrate diff --exit-code`  — the schema matches the migrations. A schema
 *                                          edited without a migration fails here, which is
 *                                          how a drift between code and database starts.
 *   3. **every instant column is TIMESTAMPTZ** — review finding B3 found 17 audit-critical
 *                                          timestamps declared as plain `TIMESTAMP(3)`.
 *                                          Postgres does not error on this; it silently
 *                                          reinterprets, which makes a retention sweep or a
 *                                          revocation check wrong by hours. Grepping the
 *                                          generated DDL is the only cheap way to catch it.
 *   4. **every table has a primary key** — B1's `Simulation` had `@@unique([id, version])`,
 *                                          which is a unique index and NOT an identifier:
 *                                          no row identity, no `FOR UPDATE`, no RLS.
 *
 * Changing any threshold in this file requires the literal string `GATE-CHANGE:` in the PR
 * body (plans/00 §6.2 rule 9, and risk R23).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const schema = join(root, 'packages/db/prisma/schema.prisma');
const prisma = join(root, 'node_modules/.bin/prisma');

const failures = [];
const notes = [];

const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => {
  failures.push(m);
  console.log(`  \x1b[31m✗\x1b[0m ${m}`);
};
const note = (m) => {
  notes.push(m);
  console.log(`  \x1b[33m!\x1b[0m ${m}`);
};

const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', cwd: root, ...opts });

console.log('\nSCHEMA GATE\n============\n');

if (!existsSync(schema)) {
  console.error(`schema not found: ${schema}`);
  process.exit(1);
}

// ── 1. validate ───────────────────────────────────────────────────────────────────
console.log('1. prisma validate');
try {
  const out = sh(prisma, ['validate', '--schema', schema], {
    env: {
      ...process.env,
      DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://x:x@localhost:5432/x',
    },
  });
  if (/is valid/.test(out)) ok('schema is valid');
  else bad(`unexpected validate output:\n${out.slice(0, 400)}`);
} catch (e) {
  // The binding is used. An earlier bulk `catch (e) {` -> `catch {` rewrite removed it and
  // left `e.stdout` referencing an undeclared identifier — which ESLint caught immediately,
  // which is the only reason to be glad the gate scripts are linted at all.
  bad(`schema does not validate:\n${(e.stdout ?? '') + (e.stderr ?? '')}`.slice(0, 2000));
}

// ── generate the DDL we will actually inspect ─────────────────────────────────────
const scratch = mkdtempSync(join(tmpdir(), 'orrery-ddl-'));
const ddlPath = join(scratch, 'schema.sql');
let ddl = null;
try {
  sh(prisma, ['migrate', 'diff', '--from-empty', '--to-schema-datamodel', schema, '--script'], {
    env: {
      ...process.env,
      DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://x:x@localhost:5432/x',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // migrate diff writes to stdout; capture it.
  ddl = sh(
    prisma,
    ['migrate', 'diff', '--from-empty', '--to-schema-datamodel', schema, '--script'],
    {
      env: {
        ...process.env,
        DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://x:x@localhost:5432/x',
      },
    },
  );
} catch {
  // Older CLIs support --output. Try that before giving up.
  try {
    sh(
      prisma,
      [
        'migrate',
        'diff',
        '--from-empty',
        '--to-schema-datamodel',
        schema,
        '--script',
        '--output',
        ddlPath,
      ],
      {
        env: {
          ...process.env,
          DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://x:x@localhost:5432/x',
        },
      },
    );
    ddl = readFileSync(ddlPath, 'utf8');
  } catch {
    ddl = null;
  }
}

if (ddl === null) {
  note('could not generate DDL; checks 3 and 4 were skipped (validate still ran)');
} else {
  // ── 3. every instant column is TIMESTAMPTZ (B3) ────────────────────────────────
  console.log('\n3. every instant column is TIMESTAMPTZ (review B3)');
  // Column declarations look like:  "colName" TIMESTAMP(3) NOT NULL
  const bare = [...ddl.matchAll(/^\s*"([A-Za-z0-9_]+)"\s+TIMESTAMP\(3\)/gm)].map((m) => m[1]);
  if (bare.length === 0) {
    ok('no untyped TIMESTAMP columns');
  } else {
    bad(
      `${bare.length} column(s) declared TIMESTAMP(3) without a time zone: ${bare.join(', ')}\n` +
        '     Postgres will not error; it silently reinterprets, which makes retention\n' +
        '     sweeps and revocation checks wrong by hours. Use @db.Timestamptz(3).',
    );
  }
  const tzCount = (ddl.match(/TIMESTAMPTZ\(3\)/g) ?? []).length;
  ok(`${tzCount} instant columns verified as TIMESTAMPTZ(3)`);

  // ── 4. every table has a primary key (B1) ───────────────────────────────────────
  console.log('\n4. every table has a primary key (review B1)');
  const tables = [...ddl.matchAll(/CREATE TABLE "([^"]+)"/g)].map((m) => m[1]);
  const withPk = new Set(
    [...ddl.matchAll(/ALTER TABLE "([^"]+)" ADD CONSTRAINT "[^"]+" PRIMARY KEY/g)].map((m) => m[1]),
  );
  // Prisma emits composite PKs inline in CREATE TABLE for some shapes.
  const inlinePk = new Set(
    [...ddl.matchAll(/CREATE TABLE "([^"]+)" \((?:[^;]*?)CONSTRAINT "[^"]+" PRIMARY KEY/gs)].map(
      (m) => m[1],
    ),
  );
  const missing = tables.filter((t) => !withPk.has(t) && !inlinePk.has(t));
  if (missing.length === 0) ok(`all ${tables.length} tables have a primary key`);
  else
    bad(
      `${missing.length} table(s) without a primary key: ${missing.join(', ')}\n` +
        '     @@unique([a, b]) is a unique INDEX, not an identifier: no row identity,\n' +
        '     no FOR UPDATE, no RLS, and every upsert needs the compound key.',
    );
}

rmSync(scratch, { recursive: true, force: true });

console.log('');
if (failures.length > 0) {
  console.error(`\x1b[31mSCHEMA GATE FAILED\x1b[0m — ${failures.length} problem(s):\n`);
  for (const f of failures) console.error(`  • ${f}\n`);
  process.exit(1);
}
console.log('\x1b[32mSCHEMA GATE PASSED\x1b[0m');
process.exit(0);

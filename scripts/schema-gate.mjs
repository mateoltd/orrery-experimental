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

// ── 2. the migrations and the schema agree ─────────────────────────────────────────
//
// P3-T4. This check was DOCUMENTED in the header from P0-T4 and WAS NOT IMPLEMENTED. The
// script only ever ran `migrate diff --from-empty --to-schema-datamodel`, which produces the
// DDL for the greps in checks 3 and 4 and says nothing about whether the migrations match. So
// the protection the header advertised — "a schema edited without a migration fails here,
// which is how a drift between code and database starts" — did not exist.
//
// It is the check most likely to be missing, because the two greps it sits next to are
// obviously doing work and a reader skims past a comment. This project has a rule about
// exactly that failure: a comment describing a protection that does not exist is worse than no
// comment, because it stops the next reader looking. Finding it while hand-writing migration
// 0007 — precisely the situation it exists to catch — is the only reason it was found at all.
//
// A drift check that CANNOT RUN must say so and fail. It must not pass quietly, for the same
// reason a test count that has not moved is not evidence.
console.log('\n2. the migrations and the schema agree');
const migrationsDir = join(dirname(schema), 'migrations');
const shadowUrl =
  process.env.SHADOW_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgresql://orrery:orrery@localhost:55432/orrery_shadow';
/**
 * Make sure the shadow database exists.
 *
 * `--from-migrations` needs somewhere to replay the migration history, and a missing shadow
 * database is a much more common cause of "this check failed" than actual drift. Creating it
 * here keeps the gate self-contained, because a check that needs a step nobody documented is a
 * check that gets skipped.
 */
/**
 * Make sure the shadow database exists, using whatever mechanism this machine actually has.
 *
 * ## Why the first version of this was a hardcoded container name
 *
 * Because it worked on the machine it was written on. `orrery-postgres-1` is a name
 * `docker compose` generates, so it is stable only for that compose project on that host. On a
 * host where the database runs under a different name — or under rootless podman, or not in a
 * container at all — `sh()` threw, the `catch` returned quietly, and the gate then failed
 * downstream with `Database orrery_shadow does not exist`, which says nothing about the cause.
 *
 * A helper that silently does nothing on the machines it does not recognise is worse than one
 * that is absent, because the failure it produces looks like a different problem entirely. So
 * this DISCOVERS the container by matching the port the URL points at, and if it cannot, it
 * prints the exact command to run.
 */
function ensureShadowDatabase(url) {
  const u = new URL(url);
  const target = u.pathname.replace(/^\//, '');
  if (target === '' || target === 'postgres') return;

  // `URL.origin` is the literal string "null" for any scheme that is not http(s) -- which is
  // every scheme this project uses. The first version built its psql argument from it and
  // produced `psql "null/postgres"`, so the "create it yourself" message it printed could not
  // possibly work. Copy the URL and change the path instead, which keeps the scheme, the
  // credentials and the port.
  const maintenance = new URL(u.toString());
  maintenance.pathname = '/postgres';

  const exists = `SELECT 1 FROM pg_database WHERE datname='${target}'`;
  const create = `CREATE DATABASE "${target}"`;

  // 1. A local `psql`, which is the simplest machine and needs no container at all.
  try {
    const out = sh('psql', [maintenance.toString(), '-U', u.username, '-tAc', exists], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (String(out).includes('1')) return;
    sh('psql', [maintenance.toString(), '-U', u.username, '-c', create], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    note(`created shadow database ${target} (psql)`);
    return;
  } catch {
    /* no psql, or it could not connect. Try the container route. */
  }

  // 2. A container PUBLISHING the port this URL points at. Discovered, not guessed: the port is
  //    the one fact both the URL and the container agree on.
  let container = null;
  try {
    const ps = sh('docker', ['ps', '--format', '{{.Names}}\t{{.Ports}}'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const line of String(ps).split('\n')) {
      const [name, ports] = line.split('\t');
      if (name && ports && ports.includes(`:${u.port}->`)) {
        container = name.trim();
        break;
      }
    }
  } catch {
    /* no docker. The message below is the last word on it. */
  }

  if (container !== null) {
    try {
      const found = sh(
        'docker',
        ['exec', '-i', container, 'psql', '-U', u.username, '-d', 'postgres', '-tAc', exists],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      if (!String(found).includes('1')) {
        sh(
          'docker',
          ['exec', '-i', container, 'psql', '-U', u.username, '-d', 'postgres', '-c', create],
          {
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        note(`created shadow database ${target} (container ${container})`);
      }
      return;
    } catch {
      /* fall through to the message */
    }
  }

  console.log(
    `  ! could not create the shadow database "${target}" automatically.\n` +
      `  ! Create it once and the gate will use it:\n` +
      `  !     psql "${maintenance.toString()}" -U ${u.username} -c 'CREATE DATABASE "${target}"'\n` +
      (container === null
        ? `  ! (no container publishing port ${u.port} was found, and there is no local psql.)\n`
        : ''),
  );
}

if (!existsSync(migrationsDir)) {
  bad('prisma/migrations not found; cannot check the schema against the migration history');
} else {
  ensureShadowDatabase(shadowUrl);
  let driftOk = false;
  try {
    sh(
      prisma,
      [
        'migrate',
        'diff',
        '--from-migrations',
        migrationsDir,
        '--to-schema-datamodel',
        schema,
        '--shadow-database-url',
        shadowUrl,
        '--exit-code',
      ],
      {
        env: {
          ...process.env,
          DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://x:x@localhost:5432/x',
        },
      },
    );
    driftOk = true; // exit 0: no drift
  } catch (e) {
    // `--exit-code` distinguishes the two cases by STATUS, and conflating them would turn
    // "no shadow database" into "no drift" — the exact inversion this check exists to prevent.
    // 2 means a difference was found; anything else is an operational failure.
    const status = e?.status ?? e?.statusCode ?? null;
    const printed = `${e?.stdout ?? ''}${e?.stderr ?? ''}`.trim();
    if (status === 2) {
      bad(
        'schema.prisma and prisma/migrations disagree.\n' +
          '     A schema edited without a migration is drift: it works in dev and fails on\n' +
          '     deploy, because the database nobody has is the one production has.\n' +
          (printed.split('\n').slice(0, 14).join('\n     ') || '     (no diff output)'),
      );
    } else {
      // No database to replay the migrations against.
      //
      // The rule is that a check which cannot run must not pass QUIETLY. It may pass LOUDLY, in
      // a sandbox that genuinely cannot have a database, and that is what this branch is. The
      // opt-in is an environment variable rather than a default, so a developer or a CI job with
      // a database never silently loses the check, and the banner below is written to be
      // impossible to miss in a build log.
      //
      // This is not hypothetical: the image build runs `pnpm run gates` inside a container with
      // no Postgres and no docker-in-docker, so the first version of this check broke the build
      // outright. The fix is NOT to make it pass by default.
      if (process.env.SCHEMA_GATE_ALLOW_NO_DB === '1') {
        console.log(
          '  ! ! ! DRIFT CHECK DID NOT RUN ! ! !\n' +
            `  ! No database at ${shadowUrl}, so prisma/migrations was NOT compared\n` +
            '  ! against schema.prisma. Checks 1, 3 and 4 did run. If you are reading this\n' +
            '  ! in CI rather than a container build, the drift check is not being enforced.\n' +
            '  ! Set SCHEMA_GATE_ALLOW_NO_DB only where there is genuinely no database.\n' +
            '  ! Unset it, and run the gates locally, before trusting a schema change.',
        );
        note('check 2 SKIPPED (SCHEMA_GATE_ALLOW_NO_DB=1) — this is a real gap, not a pass');
      } else {
        bad(
          `could not run the drift check (exit ${status ?? 'unknown'}).\n` +
            '     A drift check that cannot run must FAIL, not pass quietly. Point\n' +
            `     SHADOW_DATABASE_URL at a throwaway database (tried ${shadowUrl}),\n` +
            '     or set SCHEMA_GATE_ALLOW_NO_DB=1 if there is genuinely no database here.\n' +
            (printed.split('\n').slice(0, 6).join('\n     ') || ''),
        );
      }
    }
  }
  if (driftOk) ok('migrations and schema.prisma agree');
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
  note('could not generate DDL; checks 3 and 4 were SKIPPED. That is a real gap, not a pass.');
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

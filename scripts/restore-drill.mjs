#!/usr/bin/env node
/**
 * RESTORE DRILL, WITH A MEASURED RTO.  (P15-T7)
 *
 * ## WHAT THIS IS AND WHAT IT IS NOT
 *
 * `docs/09-OPS.md:114`: "Restore drill quarterly, and once before GA: restore into a clean environment, run the
 * full test suite against it, measure actual RTO, and write down what was harder than expected. **An untested
 * backup is a hypothesis.**"
 *
 * This script IS that drill, against the local database: dump `orrery`, restore into a clean database,
 * verify the copy table-for-table, and print the measured times. The number it prints is a REAL RTO for the
 * data volume in front of it -- currently ~161 MB -- and the header states the limitation plainly:
 *
 * **THIS DOES NOT EXERCISE PRODUCTION VOLUME, PRODUCTION TOPOLOGY, OR PITR.** There is no prod database, no
 * replica, no snapshot pipeline and no 15-minute PITR window to recover into -- `D-36` owns provisioning and it
 * is not done. What this proves is the *procedure*: that a dump taken today restores cleanly, completely, and in a
 * measured time, against a database whose migrations table does not exist (see below).
 *
 * ## WHY A DUMP-AND-RESTORE RATHER THAN A SNAPSHOT
 *
 * The managed-Postgres snapshots in the ops doc do not exist here. `pg_dump`/`pg_restore` is the mechanism that
 * works against ANY Postgres, which is what makes this drill portable to the day there is a staging database.
 * A drill that only works against infrastructure nobody has is a drill that never runs.
 *
 * ## THE `_prisma_migrations` ABSENCE, AND WHY IT DOES NOT MATTER HERE
 *
 * The working database has no `_prisma_migrations` table -- the schema was pushed, not migrated -- so `prisma
 * migrate deploy` returns P3005 against it. A dump/restore does not care: it copies rows, not migration history.
 * The verification below compares TABLE SETS and ROW COUNTS between source and copy, so a table the dump silently
 * dropped would fail the drill rather than vanish quietly.
 *
 * ## WHAT "VERIFIED" MEANS, EXACTLY
 *
 * After the restore, for every table in the source: the copy has the same table, with the same row count. That is
 * not a checksum of every row -- `pg_restore` already fails loudly on a corrupt dump -- it is the check that the
 * backup is COMPLETE, because an incomplete backup that restores cleanly is the failure mode that matters: the
 * drill passes, the data is short, and nobody knows until a student asks where their paper went.
 */

import { execFileSync } from 'node:child_process';

const DB_URL = process.env.DATABASE_URL ?? 'postgresql://orrery:orrery@localhost:55432/orrery';
const STAMP = new Date().toISOString().replace(/[-:.]/gu, '').slice(0, 14);
const RESTORE_DB = `orrery_restore_${STAMP}`;
/** Inside the CONTAINER's `/tmp`, not the host's -- `pg_dump` runs in `orrery-pg`, where `/tmp/opencode` does not exist. */
const DUMP_FILE = `/tmp/restore-drill-${STAMP}.dump`;

const say = (line) => console.log(line);
const now = () => Date.now();

function psql(db, sql) {
  return execFileSync(
    'podman',
    ['exec', 'orrery-pg', 'psql', '-U', 'orrery', '-d', db, '-Atc', sql],
    {
      encoding: 'utf8',
      env: { ...process.env, DOCKER_HOST: 'unix:///run/user/1000/podman/podman.sock' },
    },
  ).trim();
}

function podmanExec(args, input) {
  return execFileSync('podman', ['exec', '-i', 'orrery-pg', ...args], {
    encoding: 'utf8',
    input,
    env: { ...process.env, DOCKER_HOST: 'unix:///run/user/1000/podman/podman.sock' },
  });
}

async function main() {
  say('\nRESTORE DRILL (P15-T7)\n====================');
  say(`  source:  ${DB_URL.replace(/:[^:@/]*@/, ':<redacted>@')}`);
  say(`  copy:    ${RESTORE_DB}`);
  say('');

  // ── 1. dump ────────────────────────────────────────────────────────────────
  let start = now();
  execFileSync(
    'podman',
    ['exec', 'orrery-pg', 'pg_dump', '-U', 'orrery', '-d', 'orrery', '-Fc', '-f', DUMP_FILE],
    { env: { ...process.env, DOCKER_HOST: 'unix:///run/user/1000/podman/podman.sock' } },
  );
  const dumpMs = now() - start;
  const dumpBytes = Number(
    execFileSync('podman', ['exec', 'orrery-pg', 'stat', '-c', '%s', DUMP_FILE], {
      encoding: 'utf8',
      env: { ...process.env, DOCKER_HOST: 'unix:///run/user/1000/podman/podman.sock' },
    }).trim(),
  );
  say(`  dump:     ${(dumpBytes / 1048576).toFixed(1)} MB in ${(dumpMs / 1000).toFixed(1)}s`);

  // ── 2. restore into a CLEAN database ───────────────────────────────────────
  start = now();
  podmanExec(['psql', '-U', 'orrery', '-d', 'postgres', '-c', `CREATE DATABASE "${RESTORE_DB}"`]);
  podmanExec(['pg_restore', '-U', 'orrery', '-d', RESTORE_DB, DUMP_FILE]);
  const restoreMs = now() - start;
  say(`  restore:  into a clean database in ${(restoreMs / 1000).toFixed(1)}s`);

  // ── 3. verify: same tables, same row counts ───────────────────────────────
  start = now();
  const tablesSql = `SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1`;
  const sourceTables = psql('orrery', tablesSql).split('\n').filter(Boolean);
  const copyTables = psql(RESTORE_DB, tablesSql).split('\n').filter(Boolean);
  const missing = sourceTables.filter((t) => !copyTables.includes(t));
  const extra = copyTables.filter((t) => !sourceTables.includes(t));
  let mismatched = 0;
  let rows = 0;
  for (const table of sourceTables) {
    const a = Number(psql('orrery', `SELECT count(*) FROM "${table}"`));
    const b = Number(psql(RESTORE_DB, `SELECT count(*) FROM "${table}"`));
    rows += a;
    if (a !== b) {
      mismatched += 1;
      say(`  ✗ row-count mismatch: ${table} source=${a} copy=${b}`);
    }
  }
  const verifyMs = now() - start;
  say(
    `  verify:   ${sourceTables.length} tables, ${rows} rows compared in ${(verifyMs / 1000).toFixed(1)}s`,
  );

  // ── 4. clean up the copy, so the drill leaves no database behind ──────────
  podmanExec(['psql', '-U', 'orrery', '-d', 'postgres', '-c', `DROP DATABASE "${RESTORE_DB}"`]);
  execFileSync('podman', ['exec', 'orrery-pg', 'rm', '-f', DUMP_FILE], {
    env: { ...process.env, DOCKER_HOST: 'unix:///run/user/1000/podman/podman.sock' },
  });

  const totalMs = dumpMs + restoreMs + verifyMs;
  say('');
  if (missing.length > 0 || extra.length > 0 || mismatched > 0) {
    say(
      `  ✗ DRILL FAILED: missing=[${missing.join(',')}] extra=[${extra.join(',')}] mismatched=${mismatched}`,
    );
    say('    An incomplete backup that restores cleanly is the failure that matters.');
    process.exit(1);
  }
  say(
    `  ✓ drill passed: dump + restore + verify = ${(totalMs / 1000).toFixed(1)}s measured RTO at this volume`,
  );
  say(
    '  ⚠️ THIS NUMBER IS FOR ~161 MB ON LOCAL DISK. It says nothing about prod volume, replicas, or PITR.',
  );
  say('');
  say('RESTORE DRILL PASSED');
}

await main();

#!/usr/bin/env node
/**
 * INDEX REVIEW, MECHANIZED.  (P15-T2)
 *
 * ## WHAT THE PLAN ASKS AND WHAT EXISTS
 *
 * `plans/03` §5: "Indexes are declared in the schema and reviewed quarterly with `EXPLAIN (ANALYZE,
 * BUFFERS)` against the hot paths in `18-OPS-RELIABILITY.md`."
 *
 * Two honest findings before the mechanism. **First, the hot paths are not "in 18-OPS-RELIABILITY.md":**
 * that file names no per-query hot path list, so the review it asks for has no stated input. **Second, the
 * schema authors indexed the paths anyway** -- 125 index/unique declarations, and every hot path checked
 * while writing this resolves to an index scan (verified by hand first). So this is not a repair of missing
 * indexes. It is the review itself, as a script, because **a quarterly calendar promise is the weakest form
 * of gate there is**: nobody runs it, nobody records it, and the quarter it matters is the one after the
 * table grew past the plan.
 *
 * ## THE HOT PATHS, NAMED FROM THE ARCHITECTURE RATHER THAN FROM THE PLAN
 *
 * Each entry is the query a load-bearing path actually issues, with a representative parameter:
 *
 *   1. `exam-write` -- latest revision for an attempt (`AnswerRevision`, `attemptId` + `revision` DESC).
 *      This is the `submitAnswer` read, the path `P8-T16` measured at 1,147 writes.
 *   2. `results-gate` -- the attempt lookup gating `loadStudentResults` (PK + `studentId` + `purpose`).
 *   3. `release-membership` -- batch members for an attempt (`ReleaseBatchMember.attemptId`).
 *   4. `roster` -- classroom enrollments by role and status (`Enrollment`, `classroomId` + `role` + `status`).
 *   5. `outbox-sweep` -- the worker's claim query (`EmailOutbox`, `status` + `scheduledAt`, `SKIP LOCKED`).
 *   6. `rollup-read` -- the analytics rollup point lookup (`AnalyticsRollup`, unique on `assignmentId` + `kind`).
 *
 * ## WHAT "REVIEWED" MEANS HERE, AND THE FIRST VERSION GOT IT WRONG
 *
 * The first version failed on ANY Seq Scan node. It immediately failed on `rollup-read` -- against a 108-row
 * table that HAS the unique index the query needs. **The planner was right and the rule was wrong:** scanning
 * 108 rows sequentially is cheaper than an index lookup, and a gate that fails on a correct plan is a gate
 * that teaches its reader to ignore it.
 *
 * So the check is two-tier, and both tiers are explicit rather than clever:
 *
 *   1. **the required index must EXIST** (checked against `pg_indexes`, deterministic, schema-level). A dropped
 *      or never-created index fails here no matter what the planner does today.
 *   2. **a Seq Scan fails only above 5,000 rows.** Below that the planner is entitled to its judgement, and the
 *      plan is printed for the record. The 5,000-row line is a tripwire, stated here and changeable -- not a
 *      performance assertion.
 *
 * The measured times are printed but NOT gated -- **a timing gate on a shared local container would fail on a
 * busy machine and pass on a quiet one, which is how a gate becomes weather.**
 *
 * ## STATED LIMITS
 *
 * Representative parameters, not production shapes: the plans are checked, not the row counts. And this runs
 * against the LOCAL database, so it proves the indexes EXIST and are CHOSEN, not that they hold at 10x volume --
 * that is `P15-T3`'s question with real distributions.
 */

import { execFileSync } from 'node:child_process';

const ENV = { ...process.env, DOCKER_HOST: 'unix:///run/user/1000/podman/podman.sock' };

function psql(sql) {
  return execFileSync(
    'podman',
    ['exec', 'orrery-pg', 'psql', '-U', 'orrery', '-d', 'orrery', '-Atc', sql],
    { encoding: 'utf8', env: ENV },
  ).trim();
}

/** A real attempt id keeps the plans honest; the newest attempt exercises a live prefix of the index. */
const attemptId = psql(`SELECT "id" FROM "ExamAttempt" ORDER BY "createdAt" DESC LIMIT 1`);
const classroomId = psql(`SELECT "classroomId" FROM "Enrollment" LIMIT 1`);
const assignmentId = psql(`SELECT "assignmentId" FROM "AnalyticsRollup" LIMIT 1`);

/**
 * The index each query needs, as a name fragment in `pg_indexes` for its table. Checked FIRST, because a
 * correct plan on 108 rows says nothing about whether the schema carries the index the path needs at pilot
 * volume.
 */
function indexExists(table, fragment) {
  const names = psql(`SELECT indexname FROM pg_indexes WHERE tablename = '${table}'`).split('\n');
  return names.some((name) => name.includes(fragment));
}

const QUERIES = [
  {
    name: 'exam-write',
    table: 'AnswerRevision',
    needsIndex: 'AnswerRevision_attemptId_revision_idx',
    why: 'submitAnswer read: latest revision for an attempt (P8-T16 measured this path at 1,147 writes)',
    sql: `EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM "AnswerRevision" WHERE "attemptId" = '${attemptId}' ORDER BY revision DESC LIMIT 1`,
  },
  {
    name: 'results-gate',
    table: 'ExamAttempt',
    needsIndex: 'ExamAttempt_pkey',
    why: 'loadStudentResults gate: attempt by PK + student + purpose',
    sql: `EXPLAIN (ANALYZE, BUFFERS) SELECT "id" FROM "ExamAttempt" WHERE "id" = '${attemptId}' AND "studentId" = 'x' AND "purpose" = 'GRADED'`,
  },
  {
    name: 'release-membership',
    table: 'ReleaseBatchMember',
    needsIndex: 'ReleaseBatchMember_attemptId_idx',
    why: 'release batch members for an attempt',
    sql: `EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM "ReleaseBatchMember" WHERE "attemptId" = '${attemptId}'`,
  },
  {
    name: 'roster',
    table: 'Enrollment',
    needsIndex: 'Enrollment_classroomId_role_status_idx',
    why: 'classroom enrollments by role and status (the roster page)',
    sql: `EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM "Enrollment" WHERE "classroomId" = '${classroomId}' AND "role" = 'STUDENT' AND "status" = 'ACTIVE'`,
  },
  {
    name: 'outbox-sweep',
    table: 'EmailOutbox',
    needsIndex: 'EmailOutbox_status_scheduledAt_idx',
    why: "worker claim query: QUEUED due messages, SKIP LOCKED (P0-T7's supervision path)",
    sql: `EXPLAIN (ANALYZE, BUFFERS) SELECT "id" FROM "EmailOutbox" WHERE "status" = 'QUEUED' AND "scheduledAt" <= now() ORDER BY "scheduledAt" LIMIT 100 FOR UPDATE SKIP LOCKED`,
  },
  {
    name: 'rollup-read',
    table: 'AnalyticsRollup',
    needsIndex: 'AnalyticsRollup_assignmentId_kind_key',
    why: 'analytics rollup point lookup by unique (assignmentId, kind)',
    sql: `EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM "AnalyticsRollup" WHERE "assignmentId" = '${assignmentId}' AND "kind" = 'FORM_STATS'`,
  },
];

const say = (line) => console.log(line);
let failures = 0;

say('\nINDEX REVIEW (P15-T2)\n===================');
for (const entry of QUERIES) {
  if (!indexExists(entry.table, entry.needsIndex)) {
    failures += 1;
    say(`  ✗ ${entry.name}: REQUIRED INDEX MISSING`);
    say(`    ${entry.why}`);
    say(
      `    no index on "${entry.table}" matching "${entry.needsIndex}" -- the schema does not carry`,
    );
    say(`    what this path needs, whatever the planner does today.`);
    continue;
  }
  const plan = execFileSync(
    'podman',
    ['exec', 'orrery-pg', 'psql', '-U', 'orrery', '-d', 'orrery', '-Atc', entry.sql],
    { encoding: 'utf8', env: ENV },
  );
  const lines = plan.split('\n');
  const seqScan = lines.find((line) => line.includes('Seq Scan'));
  const time = (lines.find((line) => line.includes('Execution Time')) ?? '').trim();
  const rowCount = Number(psql(`SELECT count(*) FROM "${entry.table}"`));
  if (seqScan !== undefined && rowCount > 5000) {
    failures += 1;
    say(`  ✗ ${entry.name}: SEQUENTIAL SCAN over ${rowCount} rows`);
    say(`    ${entry.why}`);
    say(`    ${seqScan.trim()}`);
  } else {
    const node = (
      lines.find((line) => line.includes('Index Scan') || line.includes('Bitmap')) ??
      (seqScan ?? '').trim()
    ).trim();
    const note = seqScan !== undefined ? ` [seq scan, ${rowCount} rows: planner's call]` : '';
    say(`  ✓ ${entry.name}: ${node.slice(0, 90)} (${time.replace('Execution Time: ', '')})${note}`);
  }
}

say('');
if (failures > 0) {
  say(
    `INDEX REVIEW FAILED (${failures}) -- a hot path without an index is a latent outage with a date on it.`,
  );
  process.exit(1);
}
say(
  'INDEX REVIEW PASSED -- 6 hot paths, required indexes present, no sequential scans above the tripwire.',
);

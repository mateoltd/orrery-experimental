/**
 * The tracker integrity gate.
 *
 * ## WHY THIS EXISTS, AND WHY IT IS A GATE RATHER THAN A CONVENTION
 *
 * `.tmp/TRACKER.md` has been silently truncated TWICE by an automated edit that anchored on a heading
 * it believed was unique. `String.prototype.indexOf` finds the FIRST match, so a splice anchored on
 * `#### P6-T11 evidence` removed everything from the first such heading to the next unrelated marker --
 * fourteen sections, including the write-ups for five simulations. Both times the file still parsed,
 * still had a summary table, and still had no obvious hole where a section used to be. Both times the
 * damage was only noticed by diffing heading counts against the previous commit.
 *
 * A document whose failure mode is "looks fine, is missing half its content" needs a mechanical check.
 * "Be careful when editing" is not a control.
 *
 * ## WHAT IT CHECKS
 *
 * 1. **Section count never decreases.** Compared against `HEAD`, so a destructive edit fails the gate
 *    even though the file is syntactically fine.
 * 2. **Every task id appears in exactly one summary row.** A duplicated row means two edits believed
 *    they owned the same task.
 * 3. **No summary row carries a `*(next commit)*` placeholder.** Resolving it in the same commit as the
 *    work is the rule the tracker states; this is the rule being enforced.
 * 4. **No heading is duplicated**, except the deliberately repeated per-task evidence headings.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const TRACKER = join(process.cwd(), '.tmp', 'TRACKER.md');

// THE TRACKER IS NOT IN THE DOCKER CONTEXT, AND THAT IS CORRECT.
//
// `.dockerignore` excludes `.tmp`, and `infra/docker/web.Dockerfile` runs `pnpm run gates` during the
// image build. So adding this gate to `gates` made every image build fail with
// `ENOENT: .tmp/TRACKER.md` -- a working document broke a product build. The tracker is the record of the
// work; it is not an artifact of the work, and a repository-only check has no business failing a build
// that legitimately has no repository in it.
//
// So the absence is a SKIP, stated as a skip. Silently passing would be the worse bug: it would look like
// the tracker had been verified.
if (!existsSync(TRACKER)) {
  console.log('TRACKER INTEGRITY GATE');
  console.log('  SKIPPED — .tmp/TRACKER.md is not in this context.');
  console.log(
    '  This is expected inside the image build, where .tmp is excluded by .dockerignore.',
  );
  console.log('  Run it from the repository checkout to check the tracker.');
  process.exit(0);
}

const problems = [];
const bad = (message) => problems.push(message);

const current = readFileSync(TRACKER, 'utf8');
const headings = (text) => text.split('\n').filter((line) => line.startsWith('#### '));

// --- 1. section count must not decrease ------------------------------------
let previous = null;
try {
  previous = execFileSync('git', ['show', 'HEAD:.tmp/TRACKER.md'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
} catch {
  bad(
    'the tracker is not in HEAD, so this cannot be the first tracker commit — nothing to compare against',
  );
}
if (previous !== null) {
  const before = headings(previous).length;
  const now = headings(current).length;
  // UNIQUE headings, because a DUPLICATE is not content.
  //
  // This fired on a splice that removed a repeated `#### P6-T11 evidence` section -- an artefact of an
  // earlier insert, not a section anyone lost -- and reported "the tracker lost sections" about a change
  // that deleted a duplicate. A control that cannot tell a duplicate from a deletion cries wolf, and a gate
  // that cries wolf is a gate people learn to ignore. So the comparison counts DISTINCT headings, and the
  // duplicate count is reported so a real duplicate cannot hide either.
  const distinct = (text) => new Set(headings(text)).size;
  const distinctBefore = distinct(previous);
  const distinctNow = distinct(current);
  if (distinctNow < distinctBefore) {
    bad(
      `the tracker lost sections: ${String(distinctBefore)} distinct at HEAD, ${String(distinctNow)} now ` +
        `(${String(before)} -> ${String(now)} headings). A splice anchored on a heading that turned out not\n` +
        '    to be unique deletes silently and leaves a file that still parses.',
    );
  }
  const duplicates = before - distinctBefore;
  if (duplicates > 0) {
    process.stderr.write(
      `note: HEAD carries ${String(duplicates)} duplicate section heading(s); they are not counted as content\n`,
    );
  }
}

// --- 2. one summary row per task id ----------------------------------------
const rowPattern = /^\|\s*(P\d+-T\d+)\s/gm;
const rows = [...current.matchAll(rowPattern)].map((match) => match[1]);
const seen = new Map();
for (const id of rows) {
  seen.set(id, (seen.get(id) ?? 0) + 1);
}
for (const [id, count] of seen) {
  if (count > 1) {
    bad(
      `${id} has ${String(count)} summary rows; exactly one task row per id, or two edits both believe they own it`,
    );
  }
}

// --- 3. no unresolved placeholders in summary rows -------------------------
for (const line of current.split('\n')) {
  if (line.startsWith('| P') && line.includes('*(next commit)*')) {
    const id = /^\|\s*(P\d+-T\d+)/.exec(line)?.[1] ?? 'a row';
    bad(
      `${id} still carries a *(next commit)* placeholder in its summary row; resolve it in the following commit`,
    );
  }
}

// --- 3b. an OPEN row is allowed to have no commit, and anything else is not ----
// A `OPEN` row with `--` in the commit column is a DEFECT someone found and did not fix, and it is the
// only legitimate reason for that column to be empty. Without this rule an OPEN row would need a commit it
// cannot have, and the alternative -- inventing one -- is worse than the ambiguity.
for (const line of current.split('\n')) {
  const match =
    /^\|\s*(P\d+-T\d+)[^|]*\|\s*\*\*(DONE|OPEN|IN PROGRESS)\*\*\s*\|\s*`?([^|`]*?)`?\s*\|/.exec(
      line,
    );
  if (match === null) continue;
  const [, id, status, commit] = match;
  const blank = commit.trim() === '' || commit.trim() === '--';
  if (status === 'DONE' && blank) {
    bad(`${id} is DONE with no commit; DONE requires a commit and evidence, or it is not DONE`);
  }
  if (status !== 'DONE' && status !== 'IN PROGRESS' && !blank) {
    bad(
      `${id} is ${status} but carries a commit (${commit.trim()}), which reads as work already landed`,
    );
  }
}

// --- 4. no duplicated section headings (evidence headings excepted) --------
const counted = new Map();
for (const line of headings(current)) {
  const name = line.replace(/^#### /, '');
  if (name === 'P6-T11 evidence' || name.endsWith('evidence')) continue;
  counted.set(name, (counted.get(name) ?? 0) + 1);
}
for (const [name, count] of counted) {
  if (count > 1) bad(`section "${name}" appears ${String(count)} times`);
}

console.log('TRACKER INTEGRITY GATE');
console.log(`  sections: ${String(headings(current).length)}`);
console.log(`  task rows: ${String(rows.length)}`);
console.log(`  placeholders in summary rows: 0 expected`);
if (problems.length > 0) {
  console.error(`\n  TRACKER INTEGRITY GATE FAILED — ${String(problems.length)} problem(s)`);
  for (const problem of problems) console.error(`    • ${problem}`);
  process.exit(1);
}
console.log('\n  ✓ section count did not decrease');
console.log(`  ✓ ${String(rows.length)} task rows, one per id`);
console.log('  ✓ no placeholders in summary rows');
console.log('  ✓ no duplicated sections');
console.log('  ✓ every DONE row carries a commit, and no OPEN row fakes one');
console.log('\nTRACKER INTEGRITY GATE PASSED');

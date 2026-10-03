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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const TRACKER = join(process.cwd(), '.tmp', 'TRACKER.md');
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
  if (now < before) {
    bad(
      `the tracker lost sections: ${String(before)} at HEAD, ${String(now)} now. A splice anchored on a\n` +
        '    heading that turned out not to be unique deletes silently and leaves a file that still parses.',
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
console.log('\nTRACKER INTEGRITY GATE PASSED');

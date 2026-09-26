#!/usr/bin/env node
/**
 * PINNING GATE  (INV-ASSIGN-1)
 *
 * ## What this enforces
 *
 * `01-DOMAIN-MODEL.md` INV-ASSIGN-1: *a student's assessment surface derives ONLY from
 * `Assignment.resourceVersionId` and the attempt's policy snapshot. No code path may read
 * `Resource.currentVersionId` when rendering an assessment.*
 *
 * This is the invariant the whole grading model rests on. If it leaks, a student can be
 * assessed on content their teacher never assigned, and every grade in the system becomes
 * arguable.
 *
 * ## Why it is a script and not a lint rule
 *
 * The plan originally said this was "enforced by a lint rule on the assessment routers".
 * That is **not implementable**: deciding it requires taint analysis, because the forbidden
 * value reaches the renderer through a dozen call frames. Review D-29 caught it.
 *
 * A generic ESLint rule cannot do taint analysis. So the enforcement is split into the two
 * parts that ARE checkable:
 *
 *   1. **A path ban on the identifier.** Under the assessment and exam route globs, the
 *      identifier `currentVersionId` is forbidden. Not "no path reaches it" — "the name does
 *      not appear". That is decidable, and it is a genuinely strong constraint: the only way
 *      to get a draft version onto an assessment surface is to rename the local, which
 *      shows up in review.
 *
 *   2. **The stronger assertion the original mutation test missed** (24 MISSED-6): even with
 *      the name banned, an assessment could still be wrong if the slot list and the question
 *      rows disagree (`INV-SLOT-1`). That is a separate, data-level check in `P5-T12`.
 *
 * ## What would break this gate
 *
 * Reading the draft head of a resource anywhere under the assessment or exam surfaces. If a
 * legitimate future need appears — say an authoring preview — the preview route must be
 * outside these globs and must be documented here.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Globs, relative to the repo root, where the draft head is forbidden.
 * Each one exists because it renders or scores an assessment.
 */
const FORBIDDEN_GLOBS = [
  'apps/web/src/features/assessment',
  'apps/web/src/features/exam',
  'apps/web/src/features/grading',
  'apps/web/src/app/exam',
  'packages/exam-engine/src',
  'packages/grading/src',
];

/** The identifier that must not appear in the globs above. */
const FORBIDDEN_IDENTIFIER = 'currentVersionId';

function filesUnder(dir) {
  const out = [];
  let st;
  try {
    st = statSync(join(root, dir));
  } catch {
    return out; // a phase that has not landed yet contributes no files
  }
  if (!st.isDirectory()) return out;
  for (const name of readdirSync(join(root, dir))) {
    const p = join(dir, name);
    if (statSync(join(root, p)).isDirectory()) out.push(...filesUnder(p));
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

const failures = [];
const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => {
  failures.push(m);
  console.log(`  \x1b[31m✗\x1b[0m ${m}`);
};
const soft = (m) => console.log(`  \x1b[33m·\x1b[0m ${m}`);

console.log('\nPINNING GATE  (INV-ASSIGN-1)\n============================\n');

let checked = 0;
for (const glob of FORBIDDEN_GLOBS) {
  const files = filesUnder(glob);
  if (files.length === 0) {
    soft(`${glob.padEnd(38)} not present yet — nothing to check`);
    continue;
  }
  const offenders = [];
  for (const f of files) {
    const text = readFileSync(join(root, f), 'utf8');
    text.split('\n').forEach((line, i) => {
      // Allow the mention in a comment that explains the ban itself.
      if (line.includes(`${FORBIDDEN_IDENTIFIER}`) && !/^\s*(\/\/|\*|\/\*)/.test(line)) {
        offenders.push(`${relative(root, join(root, f))}:${i + 1}  ${line.trim()}`);
      }
    });
  }
  checked += files.length;
  if (offenders.length === 0) ok(`${glob.padEnd(38)} ${files.length} file(s) clean`);
  else {
    bad(
      `${glob}: \`${FORBIDDEN_IDENTIFIER}\` appears ${offenders.length} time(s)\n` +
        offenders.map((o) => `         ${o}`).join('\n') +
        '\n     The draft head must never reach an assessment surface (INV-ASSIGN-1).',
    );
  }
}

// ── the gate must not be vacuous ─────────────────────────────────────────────────
// A pinning gate that checks zero files has no teeth. Before P2 lands, that is expected
// and is reported honestly; once any assessment surface exists, an empty check is a defect.
if (checked === 0) {
  soft('no assessment surfaces exist yet — this gate is inert until P2 lands');
  console.log(
    '     This is the same shape as an unrunnable conformance test. It becomes a hard\n' +
      '     check automatically as soon as any of the globs above exists.',
  );
} else {
  ok(`${checked} file(s) checked across ${FORBIDDEN_GLOBS.length} glob(s)`);
}

console.log('');
if (failures.length > 0) {
  console.error(`\x1b[31mPINNING GATE FAILED\x1b[0m — ${failures.length} problem(s)\n`);
  for (const f of failures) console.error(`  • ${f}\n`);
  process.exit(1);
}
console.log('\x1b[32mPINNING GATE PASSED\x1b[0m\n');

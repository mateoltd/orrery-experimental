#!/usr/bin/env node
/**
 * CI grep: no ownership comparisons outside packages/auth.  (P1-T6 Do-not, plans/13 §3.3)
 *
 * ## Why a grep and not a lint rule
 *
 * ESLint's `no-restricted-properties` can see `a.ownerId === b.id`, but the bug this targets
 * is usually written with local variable names that do not contain "owner" at all:
 *
 *     if (resource.authorId === session.userId) return ...
 *     if (item.createdBy === me) ...
 *     if (row.teacherId === user.id) ...
 *
 * So the patterns are broad and the check is textual. A lint rule would miss all three; a
 * grep catches them, at the cost of false positives — which is why every hit is reported
 * with its file and line and the script fails loudly rather than trying to be clever.
 *
 * ## Why it is a separate gate and not a test
 *
 * Because a test that can be skipped is not a gate (D-35), and because this check must
 * scan files that have nothing to do with authorisation — routes, components, worker jobs.
 * It belongs where a reviewer will see it fail the build.
 *
 * ## The escape hatch
 *
 * There is none, by design. The packet says: "If you find one, fix it, do not suppress it."
 * If a legitimate case appears — an admin tool that must compare ownership, say — the fix is
 * to move the comparison into `packages/auth` and call `can()`, not to widen this list.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();

/** The one place ownership comparisons belong. */
const ALLOWED_PREFIX = 'packages/auth/';

/** Directories never worth scanning. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  'dist',
  'coverage',
  'build',
  '.tmp',
  '.turbo',
]);

const SCAN_EXT = /\.(ts|tsx|js|jsx|mts|mjs)$/;

/**
 * The patterns. Each is [label, RegExp]. The regexes are intentionally loose: this is a
 * "show a human the line and let them judge" check, not a parser.
 */
const PATTERNS = [
  // ownerId / createdBy / authorId / teacherId compared against a user/session id.
  [
    'owner-id comparison',
    /\b\w*(?:owner|owned|createdBy|author|teacher|user)_?[Ii]d\b\s*(?:===|!==|==|!=)/,
  ],
  ['author-id comparison', /\b\w*(?:author|creator|createdBy)_?[Ii]d\b\s*(?:===|!==|==|!=)/],
  // The reverse order: session.userId === resource.ownerId
  [
    'session-id on the left',
    /\b(?:session|auth|currentUser|viewer|me)\??\.\w*[Ii]d\b\s*(?:===|!==|==|!=)/,
  ],
  // React Router loaders comparing a path param to a user id.
  ['param-id comparison', /\bparams\.\w+[Ii]d\b\s*(?:===|!==|==|!=)/],
];

/** Files that are allowed to contain these, and why. */
const ALLOWLIST = new Map([
  // This script describes the patterns; scanning itself would always match.
  ['scripts/authz-ownership-gate.mjs', 'this file'],
]);

/** @returns {string[]} absolute paths of scannable source files */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else if (SCAN_EXT.test(entry)) out.push(full);
  }
  return out;
}

const violations = [];

for (const file of walk(ROOT)) {
  const rel = relative(ROOT, file);
  if (rel.startsWith(ALLOWED_PREFIX)) continue;
  if (ALLOWLIST.has(rel)) continue;

  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((text, idx) => {
    // Comments are not code. Skipping them avoids a gate that fails on the very
    // documentation explaining why the gate exists.
    const trimmed = text.trim();
    if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return;
    for (const [label, re] of PATTERNS) {
      if (re.test(text)) {
        violations.push({ rel, line: idx + 1, label, text: trimmed.slice(0, 110) });
      }
    }
  });
}

console.log('AUTHORISATION OWNERSHIP GATE');
console.log('='.repeat(70));

if (violations.length === 0) {
  console.log('AUTHORISATION OWNERSHIP GATE PASSED');
  console.log('  no ownership comparison outside packages/auth');
  process.exit(0);
}

console.log(`FAILED — ${violations.length} ownership comparison(s) outside ${ALLOWED_PREFIX}\n`);
for (const v of violations) {
  console.log(`  ${v.rel}:${v.line}  [${v.label}]`);
  console.log(`    ${v.text}`);
}
console.log('\nFix: move the decision into packages/auth and call can(). Do not suppress.');
process.exit(1);

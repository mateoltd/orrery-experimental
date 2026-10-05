/**
 * INV-RELEASE-2 across the LTI/xAPI boundary: the ONLY-PATH audit.  (P10-T10)
 *
 * ## WHAT THIS IS THE THIRD ANSWER TO
 *
 * `plans/20`'s P10 exit criterion ends with "a CI test proves no score crosses the LTI or xAPI boundary before
 * release", and there were already two mechanisms in the repository for the STUDENT boundary:
 *
 *  · **(a) type-level** -- the sealed DTO arm has no score field to omit, so a leak is a compile error;
 *  · **(b) generated** -- `scripts/audit-routes.mjs` diffs the Next route table against `audit/student-routes.json`.
 *
 * **NEITHER CAN ANSWER THIS QUESTION, AND BOTH STAYED GREEN THROUGH A REAL LEAK.** The roster-page bug
 * (`audit/score-projections.json`, `$why_it_exists`) was in a PROJECTION, not a route: the route was correct and the
 * query was wrong. The interop equivalent is worse, because there is no route table on this side either -- an LTI AGS
 * passback is a function call inside a worker, and an xAPI statement is a queue entry. **A mechanism that reads a route
 * table cannot see a function that posts a grade.**
 *
 * So this is a third question: *may any file other than the chokepoint name an LTI/xAPI score field at all?*
 *
 * ## THE MEASUREMENT THAT PROVES THE QUESTION IS WORTH ASKING
 *
 * `SCORE_BEARING_KEYS` does not contain `scoreGiven`, `scoreMaximum`, `resultScore`, `success`, `completion` or
 * `scaled` -- which are the names the two standards actually use. `assertNoScoreLeak({ scoreGiven: 87 })` returns
 * clean. `outbound.test.ts` asserts that as a DEFECT, with a comment saying it is one, so the day it stops being true
 * somebody has to come and decide whether the chokepoint's widened list is still the right answer.
 *
 * **WHICH MEANS A SCANNER OVER KEY NAMES IS NOT ENOUGH ON ITS OWN** -- the same blindness `audit-projections.mjs`
 * documents. What it IS enough for is a narrower and much more checkable claim: the chokepoint is the only place these
 * names appear, so there is exactly one vocabulary to widen and exactly one place to audit. A codec that needs
 * `scoreGiven` must obtain it from `prepareOutbound`, which means it went through the gate.
 *
 * ## THE FOUR FAILURES, AND EACH ONE WAS VERIFIED BY BREAKING IT
 *
 *  1. a file naming an interop score key that is not the audited chokepoint;
 *  2. a listed file that no longer names one -- a stale entry is a claim nobody is checking, and it is the same defect
 *     as a stale route entry;
 *  3. a chokepoint that does not export `prepareOutbound`, which would mean the audited file is not the chokepoint;
 *  4. **`@orrery/interop` gaining a dependency.** This one is the reason the script reads a `package.json` at all: the
 *     "only path" argument is that the interop package cannot send a payload because it has nothing to send one WITH.
 *     A dependency is the hole in that argument, and nothing else in the repository would notice it.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const auditPath = join(root, 'audit', 'outbound-boundary.json');
const interopPackage = join(root, 'packages', 'interop', 'package.json');

if (!existsSync(auditPath)) {
  console.log('OUTBOUND BOUNDARY AUDIT (INV-RELEASE-2 across LTI/xAPI)');
  console.log('  SKIPPED — audit/outbound-boundary.json is not in this context.');
  process.exit(0);
}

const { INTEROP_SCORE_BEARING_KEYS, LTI_AGS_SCORE_KEYS } = await import(
  join(root, 'packages', 'interop', 'dist', 'outbound.js')
);

/**
 * THE SCANNED VOCABULARY IS A CLAIM IN THE AUDIT FILE, NOT A COMPUTED SET.
 *
 * The first version of this script derived its key list from `INTEROP_SCORE_BEARING_KEYS`, which is a UNION with
 * `SCORE_BEARING_KEYS` -- and it reported **90 files**, every one of them a false positive: `success:` in a contrast
 * check, `outcome:` in a watchdog, `total:` in a clock. A gate that fires on the whole repository is a gate that gets
 * deleted, and it would have been deleted for being noise rather than for being wrong.
 *
 * **SO ONLY NAMES THAT ARE EVIDENCE OF AN INTEROP PAYLOAD ARE SCANNED**, and the list lives in
 * `audit/outbound-boundary.json` so that narrowing it is a reviewed act. Five AGS field names, plus the three xAPI verb
 * IRIs that `plans/16` §3 puts after release. Nothing generic: `success` and `completion` are on the chokepoint's
 * WATCHED list but not on the SCANNED one, because `{ success: true }` is a contrast ratio passing and a library
 * request succeeding, and a scanner cannot tell those from a verdict.
 */
const audit = JSON.parse(readFileSync(auditPath, 'utf8'));
const scanned = audit.$scanned_field_names;
if (!Array.isArray(scanned) || scanned.length === 0) {
  console.error(
    'audit/outbound-boundary.json has no $scanned_field_names array. Nothing to check.',
  );
  process.exit(1);
}
for (const name of scanned) {
  if (typeof name !== 'string' || name === '') {
    console.error(
      'audit/outbound-boundary.json $scanned_field_names contains a non-string or empty entry.',
    );
    process.exit(1);
  }
}
/**
 * EVERY SCANNED NAME MUST BE ONE THE CHOKEPOINT ACTUALLY WATCHES, OR THE VOCABULARY HAS DRIFTED FROM THE GUARD.
 *
 * The three xAPI verb IRIs are the exception and are checked as such: they are names a payload CARRIES, not keys a
 * guard scans for, and `XAPI_SCORE_KEYS` cannot contain a URL. They are asserted by a separate rule below.
 */
const verbIris = scanned.filter((name) => name.includes('/'));
const fieldNames = scanned.filter((name) => !name.includes('/'));
for (const name of fieldNames) {
  if (!LTI_AGS_SCORE_KEYS.has(name) && !INTEROP_SCORE_BEARING_KEYS.has(name)) {
    console.error(
      `audit/outbound-boundary.json scans for "${name}", which prepareOutbound does not watch. A scanner vocabulary\n` +
        '    wider than the guard checks for a leak the guard would have refused, which makes the audit right and the\n' +
        '    system wrong. Add the name to LTI_AGS_SCORE_KEYS/XAPI_SCORE_KEYS or drop it from the scanned list.',
    );
    process.exit(1);
  }
}

const SCANNED_ROOTS = [join(root, 'packages'), join(root, 'apps')];

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'generated',
  '.turbo',
  'coverage',
  'test-results',
  'playwright-report',
]);

/** Tests are not production: the chokepoint's own test file names every key on purpose, in order to prove it refuses them. */
const isTest = (file) =>
  /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file) || /\.assert\.types\.ts$/.test(file);

const walk = (dir) => {
  const found = [];
  if (!existsSync(dir)) return found;
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...walk(full));
    else if (/\.(?:ts|tsx)$/.test(entry) && !isTest(full)) found.push(full);
  }
  return found;
};

/**
 * A KEY IN AN OBJECT LITERAL, OR A FIELD NAME ANYWHERE IN THE SOURCE.
 *
 * Two forms because the two ways this happens are different bugs: `{ scoreGiven: 87 }` is somebody building a payload,
 * and `'http://adlnet.gov/expapi/verbs/scored'` is somebody emitting a statement without an object literal in sight.
 * A word boundary keeps `scoreGivenCount` -- a count, not a mark -- out of the report.
 */
const namesInteropScore = (source) => {
  const hits = new Set();
  for (const name of [...fieldNames, ...verbIris]) {
    const pattern = new RegExp(
      `(?<![\\w$])["']?${escapeForRegExp(name)}["']?\\s*[:=]|${escapeForRegExp(name)}`,
      'g',
    );
    if (pattern.test(source)) hits.add(name);
  }
  return [...hits];
};

const escapeForRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const listed = new Map((audit.files ?? []).map((entry) => [entry.file, entry.why]));

const findings = [];
const failures = [];

for (const dir of SCANNED_ROOTS) {
  for (const file of walk(dir)) {
    const rel = relative(root, file).split(/[\\/]/).join('/');
    const hits = namesInteropScore(readFileSync(file, 'utf8'));
    if (hits.length === 0) continue;
    findings.push({ file: rel, hits: hits.sort() });
    if (!listed.has(rel)) {
      failures.push(
        `${rel} names an LTI/xAPI score field (${hits.sort().join(', ')}) outside the audited chokepoint.\n` +
          '    A mark that reaches an LMS or a learning record store crosses the sealed/released boundary, so it may\n' +
          '    only be produced by packages/interop/src/outbound.ts. Route it through prepareOutbound(), which refuses\n' +
          '    an unreleased attempt, or rename the field if it is genuinely not a mark.',
      );
    }
  }
}

for (const file of listed.keys()) {
  if (!findings.some((entry) => entry.file === file)) {
    failures.push(
      `${file} is listed in audit/outbound-boundary.json but names no interop score field. A stale entry is a claim\n` +
        '    nobody is checking, and it is the same defect as a stale route entry.',
    );
  }
}

// Failure 3: the audited file must actually BE the chokepoint.
const CHOKEPOINT = 'packages/interop/src/outbound.ts';
const chokepointSource = existsSync(join(root, CHOKEPOINT))
  ? readFileSync(join(root, CHOKEPOINT), 'utf8')
  : '';
if (!/export\s+function\s+prepareOutbound\b/.test(chokepointSource)) {
  failures.push(
    `${CHOKEPOINT} does not export a function called prepareOutbound. The audited file is supposed to be the single\n` +
      '    chokepoint every outbound payload passes through, and this script will not accept a rename without someone\n' +
      '    deciding what happened to the old name.',
  );
}
if (!listed.has(CHOKEPOINT)) {
  failures.push(`${CHOKEPOINT} is not listed in audit/outbound-boundary.json.`);
}

// Failure 4: the package must stay unable to send anything itself.
const pkg = JSON.parse(readFileSync(interopPackage, 'utf8'));
const dependencies = Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies });
if (dependencies.length > 0) {
  failures.push(
    `packages/interop now depends on ${dependencies.join(', ')}.\n` +
      '    The "only path" argument is that this package cannot send a payload because it has no transport and no\n' +
      '    dependency that could provide one. A dependency here is a way around its own boundary. Move the transport to\n' +
      '    the caller and keep the chokepoint dependency-free, as P5-T13 decided.',
  );
}

console.log('OUTBOUND BOUNDARY AUDIT (INV-RELEASE-2 across LTI/xAPI)');
console.log(
  `  names scanned for: ${String(scanned.length)} — ${String(fieldNames.length)} field names + ` +
    `${String(verbIris.length)} verb IRIs`,
);
console.log(`  keys the chokepoint watches: ${String(INTEROP_SCORE_BEARING_KEYS.size)}`);
console.log(`  files naming one: ${String(findings.length)} (${String(listed.size)} audited)`);
for (const entry of findings) console.log(`    ${entry.file}: ${entry.hits.join(', ')}`);

if (failures.length > 0) {
  console.log(`\nFAILED — ${String(failures.length)} problem(s):\n`);
  for (const failure of failures) console.log(`  • ${failure}\n`);
  process.exit(1);
}

console.log('\nOUTBOUND BOUNDARY AUDIT PASSED');
console.log(
  '  Limits, so this is not mistaken for more than it is: it matches KEY NAMES in source. It cannot see a payload\n' +
    '    built by string concatenation or computed keys, it cannot see a mark under a name neither standard uses, and\n' +
    '    it cannot tell whether prepareOutbound was CALLED -- only that the vocabulary appears in one file.',
);

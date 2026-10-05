/**
 * INV-RELEASE-2, mechanism (c): the PROJECTION audit.  (P10-T8)
 *
 * ## THE TWO EXISTING MECHANISMS ANSWER DIFFERENT QUESTIONS, AND A THIRD QUESTION WAS UNANSWERED
 *
 * - **(a) type-level** (`5a9a52f`): the sealed DTO arm has NO score field -- not nullable, absent -- so a handler that
 *   reads or sends a score from it does not compile. Costs nothing at runtime.
 * - **(b) generated** (`scripts/audit-routes.mjs`): reads the Next route table, diffs it against
 *   `audit/student-routes.json`, and fails on any unlisted student-facing route and on any listed route that no longer
 *   exists.
 *
 * Both were live and green on the day of the roster leak. **Both stayed green because the leak was not in a route.**
 *
 * ## WHAT ACTUALLY HAPPENED, AND WHY NEITHER MECHANISM COULD SEE IT
 *
 * `packages/db/src/roster-page.ts` gated a SEALED GRADE like this:
 *
 * ```ts
 * assignment: { releaseBatches: { some: { status: 'RELEASED' } } }
 * ```
 *
 * which asks "does this assignment own SOME released batch" -- a fact about the assignment. Release is per
 * MEMBERSHIP (`plans/01` §10: membership is frozen on `RELEASING`, and a batch releases exactly its own members). Two
 * batches on one assignment, one `RELEASED` and one `DRAFT`, and the `DRAFT` batch's members had `finalScore`,
 * `maxScore` and `percentage` selected and displayed -- on the strength of *another student's* batch being released.
 *
 * **The relation needed for the correct query, `ExamAttempt.releaseMembers`, had existed since `0001_init`.** The
 * query was available and chose differently, which is worse than a missing schema feature: **a gate can be wrong while
 * everything it is built from is correct**, and gates fail quietly rather than loudly.
 *
 * So: the ROUTE was fine, the DTO was fine, and the handler was fine. **The projection was wrong.** `audit-routes.mjs`
 * reads a route table and has no way to express "this handler loads the marks", which is the only thing that mattered.
 *
 * ## AND EVERY TEST HAD THE ONE SHAPE THAT HIDES IT
 *
 * The existing release tests put the withheld attempt on a DIFFERENT ASSIGNMENT. That is the single case in which
 * "does this assignment own a released batch" and "is this attempt in a released batch" give the same answer, so a
 * whole file of passing tests was compatible with the bug. The regression test added with the fix uses **two batches on
 * one assignment** and fails against the old predicate with `expected 30 to be null`.
 *
 * ## WHAT THIS SCRIPT DOES, AND WHY IT IS A LIST RATHER THAN A HEURISTIC
 *
 * It walks every `select:` in the repository, collects the property names, and fails on any that names a key in
 * `SCORE_BEARING_KEYS` unless the file appears in `audit/score-projections.json` with a stated reason.
 *
 * **A heuristic would have been worse than nothing here.** "Does the enclosing function mention `RELEASED`?" is the
 * wrong test twice over: it would pass the roster bug before the fix (that file does mention `RELEASED`, in the wrong
 * place) and it would fail a correct predicate written as a JOIN or through a helper. Deciding whether a projection is
 * properly gated is a judgement about intent, so the artefact is a **deliberate claim to be reviewed** rather than a
 * guess the script makes. The same reasoning as `audit/student-routes.json`: adding a student-facing query must be an
 * act with a human decision attached, because a list computed from the filesystem is not a list, it is a description.
 *
 * **AND THE ENTRY IS NOT A PERMISSION SLIP.** It says "I claim this projection is correctly gated" -- and the reason
 * field in that file is where the actual predicate belongs, so a reader can check the claim instead of taking it on
 * faith.
 *
 * ## WHAT IT STILL CANNOT SEE, because a gate that overclaims is worse than one that does not run
 *
 * - **A projection expressed as a raw SQL string.** `$queryRawUnsafe` with a template literal defeats this completely,
 *   and the repository now has two such statements (`runExclusive`'s lock and this fix's `FOR UPDATE`).
 * - **A score reached through a relation.** `include: { answers: true }` loads an entire table without naming one key.
 * - **A score computed rather than selected.** `percentage: (raw / max) * 100` names no key and is still a score.
 * - **Whether the predicate in an audited file is CORRECT.** This script checks that a claim exists, not that it holds.
 *   That is what the integration tests are for, and it is why the roster fix shipped with one.
 *
 * Each is recorded here rather than left for someone to discover. **A gate that cannot see four kinds of leak should
 * say so on its own output**, which is what the closing note does.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const auditPath = join(root, 'audit', 'score-projections.json');

if (!existsSync(auditPath)) {
  console.log('SCORE PROJECTION AUDIT (INV-RELEASE-2, mechanism c)');
  console.log('  SKIPPED — audit/score-projections.json is not in this context.');
  process.exit(0);
}

const { SCORE_BEARING_KEYS } = await import(
  join(root, 'packages', 'interop', 'dist', 'boundary.js')
);

const audited = JSON.parse(readFileSync(auditPath, 'utf8'));
const claims = new Map(audited.projections.map((entry) => [entry.file, entry.why]));

/** Directories whose queries reach a browser. Everything else cannot leak a mark because nobody sees it. */
const SCANNED_ROOTS = [
  join(root, 'packages', 'db', 'src'),
  join(root, 'apps', 'web', 'src'),
  join(root, 'apps', 'worker', 'src'),
];

const SKIP_DIRS = new Set(['node_modules', 'dist', 'generated', '.turbo', 'coverage']);

/**
 * TEST FILES ARE NOT SCANNED, and the first run flagged four of them.
 *
 * A test is not reachable by a browser, so a score it selects cannot leak to a student -- and the production function
 * it exercises IS scanned, which is where the claim belongs. Listing `question-bank-items.integration.test.ts`
 * separately from `question-bank-items.ts` would double the audit's size for no additional coverage, and it would put a
 * test author in the position of making a release-gating decision about production code.
 */
const isTest = (file) => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file);

const walk = (dir) => {
  const found = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...walk(full));
    else if (/\.(?:ts|tsx)$/.test(entry) && !isTest(full)) found.push(full);
  }
  return found;
};

/**
 * PROPERTY NAMES INSIDE A `select:` or `include:` OBJECT LITERAL.
 *
 * A small scanner rather than a parser, and the limitation is deliberate and stated in the header: it reads the keys
 * of a `select: { ... }` or `include: { ... }` block, so a nested `{ select: { ... } }` yields the INNER keys too,
 * which is what we want (a nested select is still a projection), and a computed property
 * (`percentage: (a, b) => ...`) yields its NAME, which is also what we want since the name is the score-bearing part.
 */
const selectedKeys = (source) => {
  const keys = new Set();
  const pattern = /(?:select|include)\s*:\s*\{/g;
  let match = pattern.exec(source);
  while (match !== null) {
    // Walk to the matching brace, tracking depth so a nested object does not end the block early.
    let depth = 0;
    let i = match.index + match[0].length - 1;
    for (; i < source.length; i += 1) {
      const ch = source[i];
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    const body = source.slice(match.index + match[0].length, i);
    for (const property of body.matchAll(/^\s{0,8}([A-Za-z_$][\w$]*)\s*[:,]/gm)) {
      keys.add(property[1]);
    }
    pattern.lastIndex = i;
    match = pattern.exec(source);
  }
  return keys;
};

const failures = [];
const found = [];

for (const dir of SCANNED_ROOTS) {
  if (!existsSync(dir)) continue;
  for (const file of walk(dir)) {
    const rel = relative(root, file);
    const source = readFileSync(file, 'utf8');
    const hits = [...selectedKeys(source)].filter((key) => SCORE_BEARING_KEYS.has(key));
    if (hits.length === 0) continue;
    found.push({ file: rel, hits: hits.sort() });
    if (!claims.has(rel)) {
      failures.push(
        `${rel} selects score-bearing key(s) ${hits.map((k) => `"${k}"`).join(', ')} and is not in ` +
          'audit/score-projections.json.\n' +
          '    Decide whether this projection is correctly gated on release, add it with a reason that states the\n' +
          '    PREDICATE (not the conclusion), and add the test that would fail if the predicate were wrong.',
      );
    }
  }
}

for (const file of claims.keys()) {
  if (!found.some((entry) => entry.file === file)) {
    failures.push(
      `${file} is listed in audit/score-projections.json but selects no score-bearing key. ` +
        'A stale entry is a claim nobody is checking, and it is the same defect as a stale route entry.',
    );
  }
}

console.log('SCORE PROJECTION AUDIT (INV-RELEASE-2, mechanism c)');
console.log(`  score-bearing keys watched: ${String(SCORE_BEARING_KEYS.size)}`);
console.log(`  projections naming one: ${String(found.length)} (${String(claims.size)} audited)`);
for (const entry of found) {
  console.log(`    ${entry.file}: ${entry.hits.join(', ')}`);
}

if (failures.length > 0) {
  console.log(`\nFAILED — ${String(failures.length)} undeclared or stale projection claim(s):\n`);
  for (const failure of failures) console.log(`  • ${failure}\n`);
  process.exit(1);
}

console.log('\nSCORE PROJECTION AUDIT PASSED');
console.log(
  '  Limits, so this is not mistaken for more than it is: it reads `select:`/`include:` KEY NAMES. It cannot see a\n' +
    '  projection written as raw SQL, a score reached through a whole-table relation, a score COMPUTED rather than\n' +
    '  selected, and it cannot tell whether an audited predicate is CORRECT -- only that a claim exists.',
);

/**
 * INV-RELEASE-2, mechanism (b): the GENERATED route audit.  (P10-T8)
 *
 * `plans/20`'s P10 exit criterion is that "a student polling every student-facing route before release finds no grade
 * data anywhere, including error payloads, headers and cached responses". Mechanism (a) is the type-level one -- the
 * sealed DTO arm has no score field to omit, so a leak is a compile error (`5a9a52f`). This is the other half, and it
 * exists because a type-level guarantee cannot see a route that was never written.
 *
 * ## WHY THE AUDITED LIST IS A FILE AND NOT A CONSTANT IN HERE
 *
 * Because adding a student-facing route must be a DELIBERATE act with a human decision attached: is this route
 * score-free, and if not, is it gated on release? A list computed from the filesystem is not a list, it is a
 * description. So `audit/student-routes.json` is the authority and this script fails on anything unlisted.
 *
 * The failure message names the unlisted route and the two things to decide. A gate that says "route audit failed"
 * teaches nothing; one that says "add /attempts/x/results to the list and state whether it is score-free" gets acted on.
 *
 * ## AND IT FAILS ON A STUDENT-FACING ROUTE THAT IS NOT LISTED AT ALL, INCLUDING A NEW ONE
 *
 * That is the whole point. The route table did not exist in this repository until now -- five routes, none
 * student-facing -- and P10-T8 could not have been written before the API surface existed. That is recorded on the
 * tracker row rather than glossed.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const appDir = join(root, 'apps', 'web', 'src', 'app');
const auditPath = join(root, 'audit', 'student-routes.json');

/** Every `route.ts` in the app directory, as a normalised path. */
const walk = (dir) => {
  const found = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...walk(full));
    } else if (entry === 'route.ts' || entry === 'route.tsx') {
      found.push(full);
    }
  }
  return found;
};

/**
 * The route path for a file, with Next's dynamic segments PRESERVED rather than resolved.
 *
 * `/attempts/[attemptId]/results` is kept as written. A checker that reported a concrete path could not tell a
 * dynamic route from a static one, and "unlisted" for a dynamic segment is exactly the case worth failing on.
 */
const routePathFor = (file) => {
  const rel = relative(appDir, file).split(/[\\/]/).join('/');
  const withoutFile = rel.replace(/(^|\/)route\.tsx?$/, '');
  // ALWAYS a leading slash, which the first version omitted -- so `robots.txt` did not match `^\/robots\.txt` and
  // every infrastructure route was reported as unlisted. The audit then "failed" for the right reason on the wrong
  // routes, which is the worst combination: it looks like it works.
  return withoutFile === '' ? '/' : `/${withoutFile}`;
};

const audit = existsSync(auditPath) ? JSON.parse(readFileSync(auditPath, 'utf8')) : { routes: [] };
const listed = new Map(audit.routes.map((entry) => [entry.path, entry]));

const actual = walk(appDir).map(routePathFor).sort();

const problems = [];

/**
 * A ROUTE THAT SERVES STUDENTS MUST BE DECLARED.
 *
 * The classification is deliberately coarse and generous: anything not obviously infrastructure counts as
 * student-facing, because the cost of wrongly auditing an internal route is a few minutes and the cost of wrongly
 * EXEMPTING a student route is a mark leaked before release.
 */
const INFRASTRUCTURE = /^\/(healthz|readyz|robots\.txt|sitemap\.xml|og)(\/|$)/;

for (const path of actual) {
  if (INFRASTRUCTURE.test(path)) continue;
  if (!listed.has(path)) {
    problems.push(
      `UNLISTED STUDENT-FACING ROUTE: ${path}\n` +
        `  Add it to audit/student-routes.json with "scoreFree": true|false and a one-line reason.\n` +
        `  If it returns grade data it must be gated on release; if it does not, say so, so the next reader\n` +
        `  does not have to read the handler to find out.`,
    );
  }
}

/** A ROUTE THAT WAS DELETED MUST NOT REMAIN LISTED, or the list rots into fiction. */
for (const path of listed.keys()) {
  if (!actual.includes(path)) {
    problems.push(
      `LISTED ROUTE NO LONGER EXISTS: ${path}\n` +
        `  Remove it from audit/student-routes.json, or the list becomes a description of a codebase that\n` +
        `  is not this one.`,
    );
  }
}

/** A DECLARED SCORE-FREE ROUTE MAY NOT CARRY A SCORE-BEARING KEY IN ITS OWN FILES. */
const SCORE_BEARING = [
  'finalScore',
  'autoScore',
  'manualScore',
  'maxScore',
  'rawScore',
  'rawTotal',
  'percentage',
  'letterGrade',
  'correctCount',
  'numCorrect',
  'correctAnswer',
  'pointsAwarded',
];

for (const [path, entry] of listed) {
  if (entry.scoreFree !== true) continue;
  const file = join(appDir, path === '/' ? '' : path, 'route.ts');
  if (!existsSync(file)) continue;
  const source = readFileSync(file, 'utf8');
  for (const key of SCORE_BEARING) {
    if (source.includes(key)) {
      problems.push(
        `DECLARED SCORE-FREE BUT MENTIONS A SCORE KEY: ${path} uses "${key}"\n` +
          `  Either it is not score-free, or the name appears in something other than a payload. Fix the\n` +
          `  declaration or the route; do not silence this.`,
      );
    }
  }
}

console.log('STUDENT ROUTE LEAK AUDIT (INV-RELEASE-2, mechanism b)');
console.log(`  routes found:     ${String(actual.length)}`);
console.log(`  listed:           ${String(listed.size)}`);
console.log(`  infrastructure:   ${String(actual.filter((p) => INFRASTRUCTURE.test(p)).length)}`);

if (problems.length === 0) {
  console.log('  ✓ every student-facing route is declared');
  console.log('  ✓ no declared route has been deleted');
  console.log('  ✓ no score-free route mentions a score key');
  console.log('\nSTUDENT ROUTE LEAK AUDIT PASSED');
} else {
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  console.error(`\nSTUDENT ROUTE LEAK AUDIT FAILED (${String(problems.length)})`);
  process.exitCode = 1;
}

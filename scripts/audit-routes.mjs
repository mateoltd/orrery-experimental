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
import { dirname, join, relative } from 'node:path';
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
    } else if (SERVING_FILES.has(entry)) {
      found.push(full);
    }
  }
  return found;
};

/**
 * ## ⚠️ THIS NOW WALKS PAGES AND LAYOUTS, NOT JUST `route.ts`, AND THE BLIND SPOT WAS EXACTLY THE BIGGEST DEFECT
 *
 * The first version of this script enumerated `route.ts` only. **A server component renders grade data into HTML, and
 * `RESULTS_HEADERS` does nothing for it** -- `private, no-store` and `Vary: Cookie` are properties of a route handler's
 * response, and a page has none of them unless it sets its own.
 *
 * That blind spot is not hypothetical. **It is how `/exam/[attemptId]/page.tsx` shipped as a placeholder paragraph while `P8`
 * was reported DONE at 17/17** -- an audit that only looked at API routes would never have noticed, because there was no
 * leaking route. The hole in the audit was the same shape as the hole in the product.
 *
 * `page.tsx` and `layout.tsx` are therefore audited too. A layout can fetch and render, and `/exam/[attemptId]/layout.tsx`
 * is the one that mounts `ExamShell`.
 */

/** Files in the app directory that can put bytes in front of a student. */
const SERVING_FILES = new Set(['route.ts', 'route.tsx', 'page.tsx', 'layout.tsx']);

/**
 * The route path for a file, with Next's dynamic segments PRESERVED rather than resolved.
 *
 * `/attempts/[attemptId]/results` is kept as written. A checker that reported a concrete path could not tell a
 * dynamic route from a static one, and "unlisted" for a dynamic segment is exactly the case worth failing on.
 */
const routePathFor = (file) => {
  const rel = relative(appDir, file).split(/[\\/]/).join('/');
  const withoutFile = rel.replace(/(^|\/)(route|page|layout)\.tsx?$/, '');
  // ALWAYS a leading slash, which the first version omitted -- so `robots.txt` did not match `^\/robots\.txt` and
  // every infrastructure route was reported as unlisted. The audit then "failed" for the right reason on the wrong
  // routes, which is the worst combination: it looks like it works.
  return withoutFile === '' ? '/' : `/${withoutFile}`;
};

/**
 * Which of the THREE serving-file kinds this is: `route`, `page` or `layout`.
 *
 * Separate from the path, because they collide at one path in ways that silently lose a file. `/(auth)/sign-in` could be a
 * route or a page. **`/exam/[attemptId]` holds BOTH a `page.tsx` and a `layout.tsx`** -- and with two kinds the two keys
 * collide, the Map keeps one, and the other is never audited while the summary still reports the count. That is precisely the
 * "reports clean because it read the wrong file" failure this script exists to prevent, introduced by the fix for it.
 *
 * `layout.tsx` is audited in its own right because a layout fetches and renders: `/exam/[attemptId]/layout.tsx` is the one
 * that mounts `ExamShell`.
 */
const kindOf = (file) => {
  if (/(^|\/)layout\.tsx?$/.test(file)) return 'layout';
  if (/(^|\/)page\.tsx?$/.test(file)) return 'page';
  return 'route';
};

/**
 * THE CALL GRAPH, FOLLOWED TRANSITIVELY.  (P10-T8 remainder)
 *
 * ## WHAT WAS MISSING, AND IT IS THE HOLE THE TASK ITSELF NAMED
 *
 * The score-key check read each surface's own source. **A surface that DELEGATES shows nothing.** The declared
 * score-free `/classrooms/[classroomId]/roster` page mentions no score key at all -- it imports `rosterPageData`
 * from `@/server/roster` and renders whatever that returns. So the check on it was not evidence; it was the absence
 * of a string in a file that never had one in the first place.
 *
 * **THE SEALED-DTO ARGUMENT IS GOOD, AND IT IS NOT SOMETHING A STRING SEARCH CAN MAKE.** Mechanism (a) of
 * INV-RELEASE-2 -- the sealed arm having no score field to omit -- is a type-level property of a function this
 * audit does not call. So the honest move is not to fake the type check. It is to **at least prove that a
 * surface declared score-free reaches only code that is itself free of score keys**, and to make a delegation into
 * territory that is not a finding rather than a silence.
 *
 * ## WHAT IT IS NOT
 *
 * This is not a bundler and not a type checker. It resolves relative and `@/`-aliased imports -- what the app's
 * own files use for anything local -- and STOPS at `@orrery/*` package specifiers, because those are real
 * packages with their own gates and pretending to follow them would be a claim this script cannot support. Every
 * hop count is printed per surface, so a reader can see how deep the walk went and what it declined to follow.
 *
 * Comments and template literals are stripped before the search, because a score key named in a comment is not a
 * score key in a payload -- the same prose-versus-code trap this session has walked into repeatedly.
 */

/** Import specifiers this walk will follow: relative paths and the app's own `@/` alias. */
const FOLLOWABLE = /^(?:\.|@\/)/u;
/** A termination guarantee, not a policy: cyclic import graphs are legal in ES modules. */
const MAX_HOPS = 24;

// `apps/web/src`, NOT `join(appDir, 'src')` -- that would be `apps/web/src/app/src`, so every `@/` alias
// resolved to nothing and the walk reported "1 files" for every surface while looking like it had run.
const webSrc = join(appDir, '..');

const codeOf = (file) =>
  readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/(^|[^:])\/\/[^\n]*/gu, '$1')
    .replace(/`(?:\\.|[^`\\])*`/gu, '``');

/** Resolves one specifier from one importer, or null when it is not a followable local file. */
function resolveSpecifier(specifier, importer) {
  if (!FOLLOWABLE.test(specifier)) return null;
  const base = specifier.startsWith('@/')
    ? join(webSrc, specifier.slice(2))
    : join(dirname(importer), specifier);
  for (const candidate of [
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Every local file `entry` can reach, plus the specifiers deliberately not followed.
 *
 * Truncation at the hop limit is REPORTED, never silent: a silently truncated walk under-reports reachability,
 * which is the exact failure this closes.
 */
function reach(entry) {
  const seen = new Set([entry]);
  const frontier = [entry];
  const declined = new Set();
  let hops = 0;
  let truncated = false;

  while (frontier.length > 0) {
    const file = frontier.shift();
    const specifiers = [...codeOf(file).matchAll(/\bfrom\s+['"]([^'"]+)['"]/gu)].map((m) => m[1]);
    for (const specifier of specifiers) {
      if (!FOLLOWABLE.test(specifier)) continue;
      const resolved = resolveSpecifier(specifier, file);
      if (resolved === null) {
        declined.add(specifier);
        continue;
      }
      if (seen.has(resolved)) continue;
      if (hops >= MAX_HOPS) {
        truncated = true;
        continue;
      }
      seen.add(resolved);
      hops += 1;
      frontier.push(resolved);
    }
  }
  return { files: [...seen], declined: [...declined].sort(), truncated };
}

const audit = existsSync(auditPath)
  ? JSON.parse(readFileSync(auditPath, 'utf8'))
  : { routes: [], exempt: [] };
/** Keyed by `path#kind`, because a page and a route can share a path and need separate decisions. */
const key = (path, kind) => `${path}#${kind}`;
const listed = new Map(
  audit.routes.map((entry) => [key(entry.path, entry.kind ?? 'route'), entry]),
);

/**
 * Infrastructure exemptions, EXACT PATHS ONLY, declared in the audit file.
 *
 * The first version used `INFRASTRUCTURE = /^\/(healthz|readyz|robots\.txt|sitemap\.xml|og)(\/|$)/`, and the `(\/|$)`
 * made it a PREFIX rule: **any route ever added under `/og/` would be silently exempt forever.** `/og/[slug]` is a PNG
 * generator today. `/og/api/attempt-scores` would return grade JSON, match the regex, and the audit would report PASS.
 *
 * **A widening exemption is worse than no exemption, because it converts a future decision into a present pass.** So
 * exemptions are now exact strings in the audit file, each with a reason, which means widening the exemption is a visible
 * edit rather than a new route's accident.
 */
/**
 * Exemptions are `{ path, reason }` objects, not bare strings, for the same reason the routes are: **an exemption with no
 * stated reason is a permission somebody granted and nobody justified.** `reason` is required by the rot check below, which
 * reports the reason it saw -- so a reader meeting an unfamiliar exemption learns why it exists.
 */
const exemptEntries = audit.exempt ?? [];
const exempt = new Set(exemptEntries.map((entry) => entry.path));
const serving = walk(appDir).map((file) => ({
  path: routePathFor(file),
  kind: kindOf(file),
  file,
}));
const actual = serving.map((entry) => key(entry.path, entry.kind)).sort();
const infrastructure = serving
  .filter((entry) => exempt.has(entry.path))
  .map((entry) => key(entry.path, entry.kind));

const problems = [];

/**
 * EVERY EXEMPTION MUST STATE WHY.
 *
 * Placed here rather than beside the `exempt` Set because the first version sat ABOVE `problems`'s declaration, in
 * its temporal dead zone. **It worked, because every exemption in the file had a reason, so the `push` never ran** --
 * and removing one reason would have thrown `ReferenceError` instead of reporting the finding. A check that has
 * never executed is not evidence that it works, and this is the third time this session that something looked
 * green only because the branch was cold.
 */
for (const entry of exemptEntries) {
  if (typeof entry?.reason === 'string' && entry.reason.length > 0) continue;
  problems.push(
    `EXEMPTION WITH NO REASON: ${entry?.path ?? String(entry)}\n` +
      `  An exemption is a decision not to audit something. State why, in the file, where the next\n` +
      `  reader will find it without reading this script.`,
  );
}

/**
 * A ROUTE THAT SERVES STUDENTS MUST BE DECLARED.
 *
 * The classification is deliberately coarse and generous: anything not obviously infrastructure counts as
 * student-facing, because the cost of wrongly auditing an internal route is a few minutes and the cost of wrongly
 * EXEMPTING a student route is a mark leaked before release.
 */
for (const path of actual) {
  if (infrastructure.includes(path)) continue;
  if (!listed.has(path)) {
    problems.push(
      `UNLISTED STUDENT-FACING SURFACE: ${path}\n` +
        `  Add it to audit/student-routes.json with "kind": "route"|"page", "scoreFree": true|false and a\n` +
        `  one-line reason. If it renders grade data it must be gated on release AND must set its own\n` +
        `  cache headers -- a page does not inherit the route handler's.\n` +
        `  If it is genuinely infrastructure, add its EXACT path to "exempt" with a reason. A prefix is not\n` +
        `  accepted: the previous regex exempted every /og/ route forever.`,
    );
  }
}

/** AN EXEMPTION THAT NO LONGER MATCHES ANYTHING IS ROT, and must be removed rather than left as a false claim. */
for (const entry of exemptEntries) {
  const path = entry?.path;
  if (!serving.some((candidate) => candidate.path === path)) {
    problems.push(
      `EXEMPT PATH MATCHES NO SURFACE ANY MORE: ${path}\n` +
        `  It is infrastructure that was deleted or renamed. Remove it from "exempt", or the audit file\n` +
        `  accumulates permissions for things that do not exist.`,
    );
  }
}

/**
 * A DECLARED KIND MUST MATCH THE FILE ON DISK.
 *
 * Without this, deleting `/exam/[attemptId]/route.ts` and adding `page.tsx` at the same path would silently satisfy the
 * route declaration with a page -- **auditing the wrong file and reporting clean.**
 */
for (const [declared, entry] of listed) {
  const found = serving.find((candidate) => key(candidate.path, candidate.kind) === declared);
  if (found) continue;
  const wrongKind = serving.find((candidate) => candidate.path === entry.path);
  problems.push(
    wrongKind
      ? `DECLARED AS "${entry.kind ?? 'route'}" BUT THE FILE IS A "${wrongKind.kind}": ${declared}\n` +
          `  A page and a route at one path are different surfaces. Change "kind" or delete the entry.`
      : `LISTED SURFACE NO LONGER EXISTS: ${declared}\n` +
          `  Remove it from audit/student-routes.json, or the list becomes a description of a codebase that\n` +
          `  is not this one.`,
  );
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

/** Per-surface reachability, so the summary can print the depth the walk actually achieved. */
const reachability = [];

for (const [declared, entry] of listed) {
  if (entry.scoreFree !== true) continue;
  const found = serving.find((candidate) => key(candidate.path, candidate.kind) === declared);
  if (!found) continue;

  const walked = reach(found.file);
  reachability.push({ declared, ...walked });

  for (const file of walked.files) {
    const source = codeOf(file);
    for (const scoreKey of SCORE_BEARING) {
      if (!source.includes(scoreKey)) continue;
      const where =
        file === found.file
          ? ''
          : ` via ${relative(root, file)}\n    REACHED TRANSITIVELY, so this is not the surface's own payload.`;
      problems.push(
        `DECLARED SCORE-FREE BUT REACHES A SCORE KEY: ${declared} uses "${scoreKey}"${where}\n` +
          `  Either it is not score-free, or the name appears in something other than a payload.\n` +
          `  A surface that DELEGATES shows nothing in its own file, which is why this follows the imports.\n` +
          `  Fix the declaration or the code; do not silence this.`,
      );
    }
  }

  if (walked.truncated) {
    // Never silent. A truncated walk UNDER-reports reachability, which is the failure this check closes, so
    // saying nothing here would reintroduce it in a new place.
    problems.push(
      `THE CALL-GRAPH WALK HIT ITS HOP LIMIT: ${declared}\n` +
        `  Reached ${String(walked.files.length)} files and stopped at ${String(MAX_HOPS)} hops, so this surface's\n` +
        `  reachability is UNDER-REPORTED. Raise MAX_HOPS, or accept the gap explicitly here.`,
    );
  }
}

console.log('STUDENT ROUTE LEAK AUDIT (INV-RELEASE-2, mechanism b)');
console.log(`  routes found:     ${String(actual.length)}`);
console.log(`  listed:           ${String(listed.size)}`);
console.log(
  `  infrastructure:   ${String(infrastructure.length)} (exact paths, not a prefix rule)`,
);

if (reachability.length > 0) {
  console.log(
    '\n  call graph followed per score-free surface (local imports only; @orrery/* not followed):',
  );
  for (const entry of reachability) {
    console.log(
      `    ${entry.declared.padEnd(38)} ${String(entry.files.length)} files` +
        (entry.truncated ? '  ⚠️ TRUNCATED' : '') +
        (entry.declined.length > 0 ? `  (not followed: ${entry.declined.join(', ')})` : ''),
    );
  }
}

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

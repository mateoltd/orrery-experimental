#!/usr/bin/env node
/**
 * `INV-RELEASE-2` across the telemetry boundary: `packages/telemetry` cannot become a score-leak path.  (P14-T14)
 *
 * ## WHY THIS IS A FOURTH GATE AND NOT A LINE IN `audit-projections.mjs`
 *
 * `scripts/audit-projections.mjs` walks three roots — `packages/db/src`, `apps/web/src`, `apps/worker/src` — and fails
 * on a `select:`/`include:` key that is in `SCORE_BEARING_KEYS` unless the file is declared in
 * `audit/score-projections.json` with its predicate. **`packages/telemetry` is not one of those roots**, so a new package
 * that holds telemetry rows would sit outside the one gate that exists to keep a mark out of a projection. A gate with a
 * fixed root list does not extend itself, which is the same defect as `TM-22`'s stale registry: the instrument cannot see
 * the thing it was written about.
 *
 * Extending `SCANNED_ROOTS` there would have been the obvious fix and it is the wrong one, because **`packages/telemetry`
 * holds no Prisma client and therefore has no `select:` to walk.** Adding a root that cannot match anything produces a
 * green gate with no subject, which `audit-projections.mjs` itself warns against at `:57-67`. So this script asks the
 * question that package's shape actually raises, which is a different and stronger one.
 *
 * ## THE FOUR CHECKS, AND WHAT EACH ONE IS FOR
 *
 *  1. **The package holds no database access.** `eslint.config.js` already bans `@prisma/client` outside `packages/db`;
 *    this repeats it for the MANIFEST, because a dependency is a hole in an argument that only a manifest-level check can
 *    see — `audit-outbound.mjs:29-38` records exactly that reasoning for `@orrery/interop` gaining a dependency.
 *  2. **The package writes no `select:`/`include:` projection.** Same question one level down, in case the first is ever
 *    answered by widening the manifest.
 *  3. **No declared field on the stored row is score-bearing.** Read out of the source TEXT rather than imported from the
 *    module, because a gate that asks the module under audit what its fields are is a gate that agrees with whatever the
 *    module says — `audit-payloads.mjs:549-551` states that in its own words.
 *  4. **There is no second `detail` vocabulary.** `INV-TELEMETRY-2`'s control is the twenty-two names in
 *    `@orrery/exam-engine`, and a list written here would be a twenty-fourth place for `audit-payloads.mjs` to have to be
 *    taught about.
 *
 * ## AND A FLOOR, BECAUSE A GATE THAT AUDITS NOTHING MUST NOT BE ABLE TO PASS
 *
 * `STORED_EVENT_INTERFACE_FOUND` is checked. If the interface this script reads were renamed, this script would find no
 * field names at all, report no violation, and exit 0 — the same vacuity `audit-payloads.mjs:48-53` refuses for its own
 * corpus. A gate whose subject has moved is a gate that has stopped running, and it must say so rather than pass.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const packageRoot = join(root, 'packages', 'telemetry');
const srcRoot = join(packageRoot, 'src');

const failures = [];
const fail = (message) => failures.push(message);

const SKIP_DIRS = new Set(['node_modules', 'dist', 'generated', '.turbo', 'coverage']);

/** The files this gate reads. Test files are excluded for the reason `audit-projections.mjs:100-106` gives. */
const isTest = (file) => /\.(?:test|spec|assert\.types)\.[cm]?[jt]sx?$/.test(file);

const walk = (dir) => {
  const found = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...walk(full));
    else if (/\.[cm]?tsx?$/.test(entry) && !isTest(entry)) found.push(full);
  }
  return found;
};

let files;
try {
  files = walk(srcRoot);
} catch {
  console.log('TELEMETRY LEAK GATE (INV-RELEASE-2 across packages/telemetry)');
  console.log('  SKIPPED — packages/telemetry is not in this context.');
  process.exit(0);
}

const { SCORE_BEARING_KEYS } = await import(
  join(root, 'packages', 'interop', 'dist', 'boundary.js')
);

/**
 * The two independent lists this gate's fourth check compares against, both read out of `@orrery/exam-engine`.
 *
 * `PII_OR_CONTENT_KEYS` is deliberately NOT this gate's own copy of the forbidden list: `audit-payloads.mjs:556-584`
 * keeps its own, and that separation is the reason a widened allowlist is caught rather than agreed with. This gate's
 * version is a different question — "did somebody write a NEW key list here" — and it needs the real names to answer it.
 */
const { EVIDENCE_DETAIL_KEYS, PII_OR_CONTENT_KEYS } = await import(
  join(root, 'packages', 'exam-engine', 'dist', 'evidence.js')
);
const ALLOWLIST = new Set(EVIDENCE_DETAIL_KEYS);
const CONTENT_OR_PERSON = new Set(PII_OR_CONTENT_KEYS);

const findings = [];

// ── 1. the manifest must not buy the package a way to name a column ────────────────────────────
const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
const declared = {
  ...manifest.dependencies,
  ...manifest.devDependencies,
  ...manifest.peerDependencies,
};
/**
 * `packages/db` is the only package that may hold a Prisma client (`eslint.config.js:216-220`), so a dependency on it —
 * or on the generated client directly — is the one manifest entry that could make this gate's other two checks vacuous.
 */
const FORBIDDEN_DEPENDENCIES = ['@orrery/db', '@prisma/client', 'prisma'];
for (const name of FORBIDDEN_DEPENDENCIES) {
  if (declared[name] !== undefined) {
    fail(
      `packages/telemetry/package.json declares "${name}". The argument that this package cannot project a score is ` +
        'that it has no database access at all, and a dependency is a hole in that argument that nothing else in the ' +
        'repository would notice — `audit-outbound.mjs:29-38` records the same reasoning for @orrery/interop.',
    );
  }
}

// ── 2 & 4. per file: no projection literal, no second `detail` vocabulary ───────────────────────
for (const file of files) {
  const rel = relative(root, file);
  const source = readFileSync(file, 'utf8');
  const lines = source.split('\n');

  lines.forEach((text, index) => {
    // A projection is the ONLY way this package could name a column, so its absence is the property rather than a
    // heuristic. Reported with its line, because a reviewer should judge it rather than trust it.
    if (/\b(?:select|include)\s*:\s*\{/.test(text)) {
      fail(
        `${rel}:${index + 1}  writes a \`select:\`/\`include:\` projection, and packages/telemetry holds no database ` +
          'client — so this is either a second way of reaching a column or a leftover from a copy.',
      );
      findings.push(rel);
    }
  });

  // ── 4. no second `detail` vocabulary, decided SEMANTICALLY rather than by a name ────────────────
  /**
   * THE CHECK IS ON THE TUPLE'S CONTENTS, NOT ON WHAT IT IS CALLED.
   *
   * The first version matched the identifier — `/DETAIL_KEYS\s*=\s*\[/` — and fired immediately on
   * `MACHINE_WORD_DETAIL_KEYS = ['outcome', 'phase', 'status', 'code', 'reason']`, which is a SUBSET RULE and not a
   * vocabulary: every one of those five is already one of the twenty-two. A gate whose first act is to fail on a correct
   * file is a gate that gets deleted for being noise rather than for being wrong, which is the outcome
   * `audit-outbound.mjs:63-69` records the whole of.
   *
   * So the test is: does any tuple declared HERE have the same members as the allowlist, or contain a name that names
   * content or a person? Both are read out of `@orrery/exam-engine`, which is a different module from this gate's
   * independent list in `audit-payloads.mjs` — so a widening of either shows up as a disagreement rather than as two
   * files agreeing with each other.
   */
  const declaredTuples = [
    ...source.matchAll(/([A-Z][A-Z0-9_]*)\s*(?::[^=;]+)?=\s*(?:Object\.freeze\()?\s*\[([^\]]*)\]/g),
  ];
  for (const [, tupleName, body] of declaredTuples) {
    const members = [...body.matchAll(/'([^']+)'/g)].map((match) => match[1]);
    if (members.length === 0) continue;
    const asSet = new Set(members);
    const isTheAllowlist =
      asSet.size === ALLOWLIST.size && [...ALLOWLIST].every((key) => asSet.has(key));
    if (isTheAllowlist) {
      fail(
        `${rel}: \`${tupleName}\` declares the twenty-two reviewed \`detail\` keys. The vocabulary is ` +
          '`EVIDENCE_DETAIL_KEYS` in @orrery/exam-engine and is walked by `pnpm audit:payloads`; a copy here would be ' +
          'a list `INV-TELEMETRY-2` no longer describes, and nothing else would fail.',
      );
    }
    for (const member of members) {
      if (CONTENT_OR_PERSON.has(member)) {
        fail(
          `${rel}: \`${tupleName}\` contains "${member}", which names content or a person. A key list written here is a ` +
            'key list no gate in this repository reads, so it is a list that exists only in the file.',
        );
      }
    }
  }
}

/**
 * THE DECLARED FIELDS OF THE STORED ROW, READ OUT OF THE SOURCE TEXT.
 *
 * The interface block is located by name and its body read to the matching brace, so a nested object type inside it does
 * not end the scan early — the same technique, and the same reason, as `audit-projections.mjs:128-151`'s `selectedKeys`.
 *
 * Reading the TEXT rather than importing the module is deliberate and is the difference between a gate and a mirror: a
 * gate that imported `StoredTelemetryEvent` would be told whatever that interface says, and a widening would pass.
 */
const STORED_EVENT_INTERFACE = 'StoredTelemetryEvent';
const declaredFields = [];
const offenders = files.filter((file) =>
  readFileSync(file, 'utf8').includes(`interface ${STORED_EVENT_INTERFACE}`),
);
if (offenders.length === 0) {
  fail(
    `no \`interface ${STORED_EVENT_INTERFACE}\` was found in packages/telemetry/src, so this gate audited no field ` +
      'name at all. A gate whose subject has moved has stopped running, and it must report that rather than pass — ' +
      'the same reason `audit-payloads.mjs:48-53` puts a floor under its corpus.',
  );
}
for (const file of offenders) {
  const rel = relative(root, file);
  const source = readFileSync(file, 'utf8');
  const start = source.indexOf(`interface ${STORED_EVENT_INTERFACE}`);
  const open = source.indexOf('{', start);
  let depth = 0;
  let end = open;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const body = source.slice(open, end);
  for (const property of body.matchAll(/^\s{2}(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*[?:]/gm)) {
    declaredFields.push({ field: property[1], where: rel });
  }
}

if (declaredFields.length === 0 && offenders.length > 0) {
  fail(
    `the \`${STORED_EVENT_INTERFACE}\` interface was found but no field name could be read from it, so this gate ` +
      'audited nothing. Check the scanner rather than the row.',
  );
}

const scoreBearing = declaredFields.filter((entry) => SCORE_BEARING_KEYS.has(entry.field));
for (const entry of scoreBearing) {
  fail(
    `${entry.where}: \`${STORED_EVENT_INTERFACE}.${entry.field}\` is a score-bearing key. Integrity telemetry carries no ` +
      'mark, and a field on this row named after one is either the mark or a name so like it that the next reader will ' +
      'treat it as one.',
  );
}

console.log('TELEMETRY LEAK GATE (INV-RELEASE-2 across packages/telemetry)');
console.log(`  score-bearing keys watched: ${String(SCORE_BEARING_KEYS.size)}`);
console.log(`  files scanned: ${String(files.length)}`);
console.log(`  declared fields on ${STORED_EVENT_INTERFACE}: ${String(declaredFields.length)}`);
console.log(`  forbidden dependencies watched: ${String(FORBIDDEN_DEPENDENCIES.length)}`);
console.log(
  `  fields: ${
    declaredFields
      .map((entry) => entry.field)
      .sort()
      .join(', ') || '(none — see the failure below)'
  }`,
);

if (failures.length > 0) {
  console.log(`\nFAILED — ${String(failures.length)} telemetry leak risk(s):\n`);
  for (const failure of failures) console.log(`  • ${failure}\n`);
  process.exit(1);
}

console.log('\nTELEMETRY LEAK GATE PASSED');
console.log(
  '  telemetry holds no database access and writes no projection, so it cannot read or write a mark. Limits, stated so\n' +
    '    this is not mistaken for more: it reads field NAMES and a manifest. It cannot see a mark reached through a\n' +
    '    relation, one computed rather than selected, or a payload whose value is a mark under an allowed `detail` key —\n' +
    '    which is the limit `evidence.ts:326-333` states for a closed key list, and the reason `narrowTelemetryDetail`\n' +
    '    checks the VALUE of the five machine-word keys rather than only their names.',
);

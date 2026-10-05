#!/usr/bin/env node
/**
 * `pnpm i18n:scan` — FIND EVERY HARD-CODED USER-FACING STRING IN `apps/web`.  (P13-T7)
 *
 * ## WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT
 *
 * **IT REPORTS. IT DOES NOT REWRITE.** An extraction tool that rewrites JSX into catalogue entries
 * without anyone looking at the result produces a catalogue full of machine-generated keys nobody
 * chose, and the next real extraction never happens because the directory is already full of
 * automatically-named garbage. So this finds, names, and refuses to let the count grow.
 *
 * ## WHY A CHECKED-IN BASELINE AND NOT A LINT RULE BANNING EVERY RAW STRING
 *
 * A lint rule that bans string literals in JSX is the stronger instrument, and it was the obvious
 * choice. It is not adoptable here, and the reason is arithmetic rather than taste: `apps/web`
 * already contains several hundred hard-coded strings, so the rule cannot land without either an
 * allow-list that is as long as the finding list (same information, expressed as suppression comments,
 * which rot silently) or a mass mechanical rewrite nobody reviewed.
 *
 * **THE BASELINE CARRIES THE SAME INFORMATION AND MAKES THE DELTA THE ACTIONABLE PART.** Today's debt
 * is recorded; tomorrow's is a failure. A file that gains a hard-coded user-facing string fails the
 * gate with the file, the line and the string, and nothing else in the tree can be ignored. That is
 * the property the task asks for: *the NEXT hard-coded string is a visible failure rather than a
 * silent gap.*
 *
 * ## WHAT IS DELIBERATELY OVER-DETECTED
 *
 * The heuristic is generous, because in a baseline-diff design a false positive costs one baseline
 * line and a false negative costs a hard-coded string forever. Anything with three consecutive
 * ASCII letters is a candidate unless it sits in a position that is provably a machine token — a
 * module specifier, a property name, a `className`, an `aria-live`. So the baseline over-reports, on
 * purpose, and `pnpm i18n:scan --update` is how a reviewer prunes it.
 *
 * ## THE BASELINE IS KEYED BY `file` + `value`, NOT BY LINE NUMBER
 *
 * A line-keyed baseline breaks on every edit to a file that has any finding in it, which is most of
 * them — and a gate that cries wolf on a formatting change is a gate that gets deleted. Line numbers
 * belong in the REPORT, where they help a reader, and not in the BASELINE, where they would only
 * churn.
 *
 * ## WHAT IT CANNOT SEE, PRINTED ON EVERY RUN
 *
 * A string built by concatenation, by `String(x)`, by `.join(' ')`, or returned from a function is
 * invisible here, because it is not a literal in the AST. Nor is text inside a markdown file, or a
 * string in `packages/*` that reaches the screen through an API. This is a floor, and a floor that is
 * labelled as one.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = join(root, 'scripts/i18n-baseline.json');
const UPDATE = process.argv.includes('--update');

/** Roots the scan reads. `apps/web` is where user-facing copy is written in this repository. */
const SCAN_ROOTS = ['apps/web/src'];

/**
 * Attribute and property names whose value is a MACHINE TOKEN, never a sentence.
 *
 * `aria-label` is deliberately ABSENT: it is announced aloud by a screen reader, so it is exactly the
 * kind of string this is looking for. Every other `aria-*` is a token.
 */
const MACHINE_VALUE_NAMES = new Set([
  'accept',
  'action',
  'allow',
  'as',
  'autoComplete',
  'charset',
  'className',
  'colSpan',
  'crossOrigin',
  'dir',
  'download',
  'encType',
  'formAction',
  'formMethod',
  'href',
  'htmlFor',
  'httpEquiv',
  'id',
  'inputMode',
  'key',
  'kind',
  'lang',
  'loading',
  'media',
  'method',
  'name',
  'pattern',
  'placeholder_',
  'poster',
  'preload',
  'referrerPolicy',
  'rel',
  'role',
  'rowSpan',
  'sandbox',
  'scope',
  'slot',
  'src',
  'srcSet',
  'target',
  'to',
  'type',
  'width',
  'height',
]);

/**
 * A candidate has at least this many consecutive ASCII letters in it.
 *
 * NECESSARY BUT NOT SUFFICIENT. The first cut of this scan flagged every literal with three letters
 * in it and produced a 2,037-line baseline containing `'use client'`, `'3rem'` and the route segment
 * `'forgot'` — **a baseline that large is not a record of debt, it is a record of the heuristic being
 * wrong**, and a reviewer cannot triage it, so nobody triages it and the gate becomes theatre. The
 * predicate below is `isUserFacingCopy`, and it exists because of that number.
 */
const WORD = /[A-Za-z]{3}/;

/** A module directive. Never copy, and it has a space in it so it must be named explicitly. */
const DIRECTIVE = /^use (client|server|strict)$/;

/** A CSS length, an angle, or a duration. `3rem`, `44rem`, `200ms`, `50%`. */
const DIMENSION = /^-?[\d.]+(px|rem|em|vh|vw|vmin|vmax|ch|fr|ms|s|deg|%)?$/i;

/** `orrery-save`, `orrery-save--failed`, `text-muted`. One lowercase kebab token and nothing else. */
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** `application/json`, `en-GB`, `America/London`, `polite`, `forgot`. One lowercase token. */
const LOWERCASE_TOKEN = /^[a-z0-9_./]+$/;

/** A media type, a header name, a route segment. Slash- or dot-joined lowercase words. */
const MACHINE_WORD = /^[a-z0-9]+([./-][a-z0-9]+)+$/;

/** `MALFORMED_BODY`, `AUTH_SECRET` — an enum member or an env var name, not a sentence. */
const SCREAMING_IDENT = /^[A-Z][A-Z0-9_]*$/;

/** `wrongPassword`, `signIn` — a camelCase identifier, which is code rather than copy. */
const CAMEL_IDENT = /^[a-z]+[A-Z][A-Za-z0-9]*$/;

/** A CSS font stack: `system-ui, sans-serif`. Has a space and no capitals. */
const FONT_STACK = /^[a-z0-9 -]+(, [a-z0-9 -]+)+$/;

/**
 * A CSS-in-JS template. `{ … display: none; }` has a brace, a colon and a semicolon and is not a sentence.
 *
 * `@orrery/grading` stylesheets are built in TypeScript and produced 40-odd findings on their own,
 * which is the difference between a baseline a reviewer can skim and one they stop opening.
 */
const CSS_BLOCK = /[{;]\s*[a-z-]+\s*:[^;}]*[;}]/;

/** A PDF byte template: `xref`, `trailer`, `startxref`, `%%EOF`, `N 0 obj`. */
const PDF_BYTES = /(obj\nendobj|\bstartxref\b|%%EOF|\btrailer\b|\/MediaBox \[)/;

/** Sentence-ending punctuation. `Saving…`, `Saved.`, `Try again!` */
const SENTENCE_END = /[.!?…:]$/;

/**
 * IS THIS SHAPE USER-FACING COPY?
 *
 * **THE TEST IS "DOES IT LOOK LIKE A WORD SOMEONE READS".** A real string of copy has a capital
 * somewhere, or more than one word, or ends like a sentence. A token has none of those: `polite`,
 * `button`, `3rem`, `orrery-save` and `en-GB` are all lowercase, single-token and unsentenced, and a
 * filter that cannot tell those from `Saved` is a filter that will eventually be ignored.
 */
function isUserFacingCopy(value) {
  if (value.length === 0) return false;
  if (DIRECTIVE.test(value)) return false;
  if (DIMENSION.test(value)) return false;
  if (MACHINE_WORD.test(value)) return false;
  if (SCREAMING_IDENT.test(value)) return false;
  if (CAMEL_IDENT.test(value)) return false;
  if (FONT_STACK.test(value)) return false;
  if (CSS_BLOCK.test(value)) return false;
  if (PDF_BYTES.test(value)) return false;
  const hasSpace = /\s/.test(value);
  if (!hasSpace) {
    // One token: it must look like a word to count. `Review` does; `polite` and `orrery-save` do not.
    if (KEBAB.test(value) || LOWERCASE_TOKEN.test(value)) return false;
    if (!/[A-Z]/.test(value)) return false;
  }
  // `hasSpace` and a capital, or an ending like a sentence. `'Someone else saved first'`,
  // `'Saved'`, `'Saving…'`, `' left on this exam.'`
  return hasSpace || /[A-Z]/.test(value) || SENTENCE_END.test(value);
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(path));
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry.name)) continue;
    // Tests are excluded ON PURPOSE and it is worth saying why: a test's expected strings are the
    // best possible inventory of what the component says, and baselining them would bury the
    // production findings. The conversion of a component changes its tests, and a baseline that fails
    // on that would teach people to stop converting components.
    if (/\.(test|d)\.(ts|tsx)$/.test(entry.name)) continue;
    out.push(path);
  }
  return out;
}

/** Is this string literal sitting in a position that is provably a machine token? */
function isMachinePosition(node, sourceFile) {
  const parent = node.parent;
  if (parent === undefined) return false;

  // `import x from './mod'` — a module specifier.
  if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) return true;
  if (ts.isImportTypeNode(parent) || ts.isExternalModuleReference(parent)) return true;

  // `foo.bar` / `{ bar: … }` — the NAME side of a property or element access.
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return true;
  if (ts.isElementAccessExpression(parent) && parent.argumentExpression === node) return true;

  // `require('…')` / `vi.mock('…')` — still a module specifier in practice.
  if (ts.isCallExpression(parent) && ts.isIdentifier(parent.expression)) {
    if (['require', 'vi', 'jest'].includes(parent.expression.text)) return true;
  }

  // `console.warn(…)` / `console.error(…)` — a LOG LINE, never screen copy.
  //
  // Excluded rather than baselined, and the exclusion is a judgement: a string that only ever reaches a
  // terminal is not something a translator should be asked to localise, and listing every one of them
  // buries the screen copy this gate exists to find. The cost is real and is stated: a log line a
  // teacher has to read is not checked, and if that ever becomes a requirement this exclusion is the
  // first thing to revisit.
  if (
    (ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
    ts.isPropertyAccessExpression(parent.expression) &&
    ts.isIdentifier(parent.expression.expression) &&
    parent.expression.expression.text === 'console'
  ) {
    return true;
  }

  // A JSX attribute NAME is not a value at all.
  if (ts.isJsxAttribute(parent) && parent.name === node) return true;

  // `className="x"`, `role="alert"`, `type="button"`, and every other token-shaped attribute.
  if (ts.isJsxAttribute(parent)) {
    const attrName = parent.name.getText(sourceFile);
    if (attrName.startsWith('aria-') && attrName !== 'aria-label') return true;
    if (MACHINE_VALUE_NAMES.has(attrName)) return true;
  }

  // The same names as an object property, for the non-JSX form: `{ role: 'alert' }`.
  if (ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) {
    if (MACHINE_VALUE_NAMES.has(parent.name.text)) return true;
  }
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    if (MACHINE_VALUE_NAMES.has(parent.name.text)) return true;
  }
  if (ts.isPropertyDeclaration(parent) && ts.isPropertySignature(parent.name)) return true;

  // A TS type/literal position: `'button'` as a union member is a type, not copy.
  if (ts.isLiteralTypeNode(parent)) return true;
  if (ts.isTypeReferenceNode(parent)) return true;

  return false;
}

function kindOf(node) {
  if (ts.isJsxText(node)) return 'jsx-text';
  if (ts.isJsxExpression(node)) return 'jsx-expression';
  if (ts.isTemplateExpression(node)) return 'template';
  if (ts.isNoSubstitutionTemplateLiteral(node)) return 'template';
  return 'literal';
}

/** The literal text a template piece carries. */
function textOf(node) {
  if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
    return node.text;
  }
  if (ts.isJsxText(node)) return node.text;
  return node.text ?? '';
}

/**
 * A WHOLE template, as one finding.
 *
 * **REPORTING EACH `TemplateHead`/`TemplateMiddle`/`TemplateTail` SEPARATELY WAS THE FIRST VERSION AND
 * IT REPORTED USELESS FRAGMENTS.** `` `${n} — your last attempt could not be stored.` `` came out as
 * `["", " — your last ", " attempt could not be stored."]`, and the finding a reviewer acts on is the
 * whole sentence: a fragment has no meaning until you open the file, and the whole sentence is what
 * belongs in a catalogue. Interpolations become `{…}` so the reader can see where the holes are.
 */
function templateText(node) {
  return `${node.head.text}${node.templateSpans.map((span) => `{…}${span.literal.text}`).join('')}`;
}

function scanFile(path) {
  const text = readFileSync(path, 'utf8');
  const sourceFile = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    /\.tsx$/.test(path) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const findings = [];
  const record = (node, value) => {
    const candidate = value.trim();
    if (candidate.length === 0) return;
    if (!WORD.test(candidate)) return;
    if (!isUserFacingCopy(candidate)) return;
    if (isMachinePosition(node, sourceFile)) return;
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    findings.push({
      file: relative(root, path),
      line: line + 1,
      kind: kindOf(node),
      value: candidate.length > 120 ? `${candidate.slice(0, 117)}...` : candidate,
    });
  };
  const visit = (node) => {
    if (ts.isTemplateExpression(node)) {
      // The whole template, once, and its quasis are not visited separately.
      record(node, templateText(node));
      for (const span of node.templateSpans) ts.forEachChild(span.expression, visit);
      for (const span of node.templateSpans) ts.forEachChild(span.literal, visit);
      ts.forEachChild(node.head, visit);
      return;
    }
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isJsxText(node)
    ) {
      record(node, textOf(node));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

const files = SCAN_ROOTS.filter((r) => existsSync(join(root, r))).flatMap((r) =>
  walk(join(root, r)),
);
const found = files.flatMap(scanFile);

const keyOf = (f) => `${f.file}${f.value}`;
// Deduped by `file` + `value`: two occurrences of the same sentence on the same file are one debt item,
// and one line moved by an edit is not a new one.
const unique = [...new Map(found.map((f) => [keyOf(f), f])).values()].sort((a, b) =>
  keyOf(a) < keyOf(b) ? -1 : 1,
);

if (UPDATE) {
  writeFileSync(
    BASELINE,
    `${JSON.stringify(
      {
        _what:
          'Hard-coded user-facing strings that already exist in SCAN_ROOTS. Generated by `pnpm i18n:scan --update`. ' +
          'The gate fails on a string NOT listed here. Keyed by file + value, not line number, so a reformat ' +
          'does not invalidate it.',
        _scannedRoots: SCAN_ROOTS,
        _exclude: '*.test.ts, *.test.tsx, *.d.ts — see the header on why tests are excluded.',
        findings: unique.map(({ file, value, kind }) => ({ file, value, kind })),
      },
      null,
      2,
    )}\n`,
  );
  /**
   * **FORMAT THE FILE WITH THE REPO'S OWN FORMATTER, OR `--update` LEAVES THE REPO LINT-RED.**
   *
   * This is not tidiness. `pnpm lint` runs `biome check .` over the whole tree, so a baseline written
   * with `JSON.stringify(_, _, 2)` fails the formatter on the array layout and the next person to run
   * `--update` inherits a broken tree and a gate they think is broken.
   */
  const fmt = spawnSync(join(root, 'node_modules/.bin/biome'), ['format', '--write', BASELINE], {
    cwd: root,
    encoding: 'utf8',
  });
  if (fmt.status !== 0) {
    console.warn(
      'i18n:scan: biome could not format the baseline; run `pnpm lint:fix` before committing',
    );
    process.stderr.write(fmt.stderr ?? '');
  }
  console.log(`i18n:scan: baseline written — ${String(unique.length)} entries`);
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
const known = new Set(baseline.findings.map((f) => keyOf(f)));
const fresh = unique.filter((f) => !known.has(keyOf(f)));
const stale = baseline.findings.filter((f) => !new Set(unique.map(keyOf)).has(keyOf(f)));

console.log(`i18n:scan: ${String(files.length)} files under ${SCAN_ROOTS.join(', ')}`);
console.log(
  `  known debt: ${String(known.size)} hard-coded strings, baselined. These are NOT failures; they are`,
);
console.log(
  '  what already existed before the gate and is owned by whoever next touches that file.',
);
console.log(`  new debt:   ${String(fresh.length)}`);

if (stale.length > 0) {
  console.log(
    `  note:       ${String(stale.length)} baseline entries no longer exist (a string was extracted).`,
  );
  console.log('              Run `pnpm i18n:scan --update` to prune them.');
}

console.log(
  '  scope:      string LITERALS and template pieces only. Copy built by concatenation, `String(x)`,\n' +
    '              `.join()` or returned from a function is invisible here, and so is text in packages/*.',
);

if (fresh.length === 0) {
  console.log('\nEXTRACTION GATE PASSED — no new hard-coded user-facing strings.');
  process.exit(0);
}

console.error(
  '\nEXTRACTION GATE FAILED — a hard-coded user-facing string is not in the baseline:\n',
);
for (const f of fresh) {
  const { line } = f;
  console.error(`  ${f.file}:${String(line)}  [${f.kind}]  ${JSON.stringify(f.value)}`);
}
console.error(
  '\n  Fix it by moving the string into packages/i18n/src/catalogues.ts and calling the translator.\n' +
    '  If it genuinely is not user-facing, add an explanation to scripts/i18n-baseline.json by hand —\n' +
    '  a line added with `--update` records no decision, and a decision nobody wrote down is a\n' +
    '  suppression with extra steps.',
);
process.exit(1);

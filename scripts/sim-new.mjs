#!/usr/bin/env node

/**
 * `pnpm sim:new` — scaffold a simulation from `sims/_template`.  (P6-T10)
 *
 * ## WHY A SCAFFOLDER AND NOT A DOCUMENT
 *
 * `plans/10` §6 lists `pnpm sim:new` as the only way a sim comes into existence, and the reason is
 * throughput: six parallel author lanes at one sim per two hours only works if the boring 90% is
 * already correct. A document describing the layout is a document somebody reads once.
 *
 * ## IT REPLACES THE PLACEHOLDERS, AND IT PROVES THE RESULT IS VALID
 *
 * A scaffolder that copies `SUBJECT.slug` into a directory and exits is a trap: the author finds out
 * it did not substitute in the `id` field when `sim:validate` refuses it an hour later.
 *
 * So this substitutes in `sim.manifest.json`, in `meta.id` in both `src/` files, in the spec card's
 * headings and in the test file, and then RUNS the validator. `sim:new` either produces something
 * `sim:validate` accepts or it says why not.
 *
 * ## THE ID IS VALIDATED HERE, NOT BY THE MANIFEST SCHEMA
 *
 * Because `id` is `subject.slug` and the subject must be one we have a tree for (`gate:subjects`), a
 * typo like `maths.projectile_motion` produces a directory that can never be published. The cheapest
 * place to catch that is before the files are written.
 *
 * Usage:
 *   node scripts/sim-new.mjs maths.projectile-motion
 *   node scripts/sim-new.mjs chemistry.titration-curve --title "Titration curve"
 *   node scripts/sim-new.mjs maths.projectile-motion --force   # overwrite, deliberately
 */

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SIMS_DIR = join(root, 'sims');
const TEMPLATE = join(SIMS_DIR, '_template');
const ESC = String.fromCharCode(27);
const c = {
  red: (s) => `${ESC}[31m${s}${ESC}[0m`,
  green: (s) => `${ESC}[32m${s}${ESC}[0m`,
  yellow: (s) => `${ESC}[33m${s}${ESC}[0m`,
  dim: (s) => `${ESC}[2m${s}${ESC}[0m`,
};

/**
 * Strip ANSI colour before matching on validator output.
 *
 * The validator colours its problem lines, so a filter written against raw output matches NOTHING — and
 * the first version of this file proved it by reporting a template's own bug as a clean scaffold. A
 * check that cannot fail is not a check, and this is where that almost shipped.
 */
// Built from the code point rather than written as a regex literal: a literal control character in a
// pattern is unreadable in review and is a lint error, and this way the reason is the whole line.
const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'gu');
const stripAnsi = (text) => text.replace(ANSI_PATTERN, '');

const fail = (message) => {
  process.stderr.write(`${c.red('FAIL')} ${message}\n`);
  process.exit(1);
};

/**
 * The subjects `gate:subjects` enforces, and `sims/_template`'s default.
 *
 * Hard-coded here rather than read from the gate script because the gate exists to FAIL the build, not
 * to be a library — importing a script whose job is to exit non-zero is how a scaffolder ends up
 * exiting non-zero itself.
 */
const SUBJECTS = [
  'maths',
  'physics',
  'chemistry',
  'biology',
  'computing',
  'astronomy',
  'geography',
  'computing-science',
  'general-science',
];

const parseArgs = (argv) => {
  const out = { id: null, title: null, force: false, author: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--force') out.force = true;
    else if (arg === '--title' || arg === '--author') {
      const next = argv[i + 1];
      if (next === undefined) fail(`${arg} needs a value`);
      if (arg === '--title') out.title = next;
      else out.author = next;
      i += 1;
    } else if (arg.startsWith('-')) fail(`unknown flag ${arg}`);
    else if (out.id === null) out.id = arg;
    else fail(`unexpected argument ${arg}`);
  }
  return out;
};

const titleCase = (slug) =>
  slug
    .split('-')
    .map((part) => (part.length === 0 ? part : part[0].toUpperCase() + part.slice(1)))
    .join(' ');

/**
 * Placeholder substitution, applied to every text file in the scaffolded tree.
 *
 * Ordered longest-first for a non-obvious reason: `SUBJECT Title` and `SUBJECT.slug` share a prefix, and
 * replacing `SUBJECT` before the longer tokens would leave `slug` in place. The placeholders are
 * replaced as whole tokens with a word boundary, which is what makes `SUBJECT.slug` safe to leave until
 * last.
 */
const substitute = (text, values) => {
  let out = text;
  for (const [placeholder, value] of Object.entries(values)) {
    if (value === undefined || value === null) continue;
    out = out.replace(
      new RegExp(placeholder.replace(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`), 'gu'),
      String(value),
    );
  }
  // `SUBJECT` on its own, last: anything left is the bare placeholder.
  if (values.SUBJECT !== undefined) {
    out = out.replace(/\bSUBJECT\b/gu, String(values.SUBJECT));
  }
  return out;
};

const TEXT_EXTENSIONS = new Set(['.ts', '.md', '.css', '.json', '.html', '.txt']);
const BINARY_EXTENSIONS = new Set(['.png', '.jpg', '.svgz', '.woff', '.woff2']);

const substituteTree = (dir, values) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      substituteTree(path, values);
      continue;
    }
    if (BINARY_EXTENSIONS.has(path.split('.').pop() ?? '')) continue;
    const extension = path.includes('.') ? path.slice(path.lastIndexOf('.')) : '';
    if (!TEXT_EXTENSIONS.has(extension)) continue;
    writeFileSync(path, substitute(readFileSync(path, 'utf8'), values), 'utf8');
  }
};

/**
 * How many `REPLACE:` markers are left in the new sim.
 *
 * Counted rather than listed because there are typically fifteen of them and a wall of lines tells an
 * author nothing about where to start. The card is the place to start, and the message says so.
 */
const countPlaceholders = (dir) => {
  let total = 0;
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!TEXT_EXTENSIONS.has(path.includes('.') ? path.slice(path.lastIndexOf('.')) : ''))
        continue;
      const matches = readFileSync(path, 'utf8').match(/REPLACE:/gu);
      total += matches === null ? 0 : matches.length;
    }
  };
  walk(dir);
  return total;
};

const main = () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.id === null) {
    fail('usage: pnpm sim:new <subject.slug> [--title "Title"] [--author "Name"] [--force]');
  }

  const match = /^([a-z][a-z0-9-]*)\.([a-z0-9]+(?:-[a-z0-9]+)*)$/u.exec(args.id);
  if (match === null) {
    fail(
      `"${args.id}" is not subject.slug. The subject must be one of: ${SUBJECTS.join(', ')}. ` +
        'A directory that can never be published is the cheapest thing to catch before the files exist.',
    );
  }
  const subject = match[1];
  const slug = match[2];
  if (!SUBJECTS.includes(subject)) {
    fail(`"${subject}" is not a subject. Expected one of: ${SUBJECTS.join(', ')}`);
  }

  const target = join(SIMS_DIR, args.id);
  if (existsSync(target)) {
    if (!args.force) {
      fail(`${relative(root, target)} already exists. Pass --force to overwrite it.`);
    }
  }
  if (!existsSync(TEMPLATE)) fail(`the template is missing: ${relative(root, TEMPLATE)}`);

  cpSync(TEMPLATE, target, { recursive: true });
  const title = args.title ?? titleCase(slug);
  substituteTree(target, {
    'SUBJECT.slug': args.id,
    'SUBJECT Title': title,
    SUBJECT: subject,
    'Your Name': args.author ?? 'Orrery',
  });

  // And PROVE it. `sim:new` producing something `sim:validate` refuses is a trap, and the author finds
  // out an hour later instead of now.
  const check = spawnSync(
    process.execPath,
    [
      join(root, 'scripts/sim-validate.mjs'),
      '--manifest',
      join(relative(root, target), 'sim.manifest.json'),
    ],
    { cwd: root, encoding: 'utf8' },
  );
  const out = `${check.stdout ?? ''}${check.stderr ?? ''}`;
  // A validator problem line starts with a JSON pointer: `#/grading` or `/grading`. Anything else in
  // the output is the header or the summary, and treating those as problems made the scaffolder
  // declare its own healthy template broken.
  const problems = stripAnsi(out)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^#?\//u.test(line));

  // A brand-new sim has NOT BEEN BUILT, so "entry does not exist" is the expected state and saying so
  // is noise. What matters is whether the MANIFEST is well formed, because that is the part the
  // template was supposed to get right.
  const notBuiltYet = (line) => /no such file exists/.test(line) && /no built artefact/.test(line);
  const real = problems.filter((line) => !notBuiltYet(line));

  process.stdout.write(`${c.green('CREATED')} ${relative(root, target)}\n`);
  process.stdout.write(
    `${c.dim('  sims/_template -> here, with every SUBJECT placeholder substituted')}\n`,
  );

  if (real.length > 0) {
    // The scaffold itself is wrong, which is a bug in the template and not in the author's work.
    process.stdout.write(`${c.red('  and the SCAFFOLD is malformed — this is a template bug:')}\n`);
    for (const line of real) process.stdout.write(`${c.dim(`  ${line}`)}\n`);
    process.exitCode = 1;
    return;
  }

  const rePlaces = countPlaceholders(target);
  if (rePlaces > 0) {
    process.stdout.write(
      `${c.yellow(`  ${rePlaces} REPLACE: marker(s) left to fill, as designed`)}\n`,
    );
    process.stdout.write(
      `${c.dim('  Fill in every REPLACE: in sim.spec.md FIRST — the card is the review artefact — then the code.')}\n`,
    );
  }
  process.stdout.write(
    `${c.dim('  Next: pnpm sim:build --all, then pnpm sim:conformance. A new sim is not real until the conformance suite has run it.')}\n`,
  );
};

main();

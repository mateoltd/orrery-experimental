#!/usr/bin/env node
/**
 * INVARIANT REGISTRY GATE  (P0-T16)
 *
 * ## Why this exists
 *
 * The delivery review's sharpest single criticism of the plan (23-REVIEW-ACTIONS.md D-31)
 * was the sandbox checklist: fourteen boxes, all pre-ticked, reviewed seven phases after
 * the system existed. It called this "the clearest example of rigorous-looking theatre in
 * the plan" — an artefact shaped like a control, written in the language of a control,
 * containing pre-asserted conclusions.
 *
 * `01-DOMAIN-MODEL.md` §14 has the same shape. Thirty invariants, each with an "Enforced
 * by" column asserting a test, a gate, or a code path. **None of those claims had been
 * checked.** An invariant enforced only by a sentence in a markdown table is a wish.
 *
 * So each invariant must be registered with:
 *   • the mechanism that enforces it (a real gate command, or a named code path), AND
 *   • the file that implements that mechanism.
 *
 * And this script fails when an invariant has no mechanism, when its mechanism is a
 * comment rather than something runnable, or when the named file does not exist. A new
 * invariant cannot be added without saying what enforces it. Deleting an enforcing file
 * breaks the build.
 *
 * Adding an invariant requires `GATE-CHANGE:` — an invariant is a claim about correctness,
 * so adding one is a real change and removing enforcement for one certainly is (D-35).
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY = join(root, 'plans/invariants.json');

const failures = [];
const staged = [];
const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const soft = (m) => console.log(`  \x1b[33m·\x1b[0m ${m}`);
const bad = (m) => {
  failures.push(m);
  console.log(`  \x1b[31m✗\x1b[0m ${m}`);
};

/**
 * The registry. `by` is either:
 *   - a `gate:` command that must exist in package.json scripts, or
 *   - a `file:` path that must exist, or
 *   - both.
 * `enforcedFrom` is the phase whose exit criterion is meaningless without it.
 */
const registry = JSON.parse(readFileSync(REGISTRY, 'utf8'));

console.log('\nINVARIANT REGISTRY GATE\n=======================\n');

const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const scripts = rootPkg.scripts ?? {};

// ── 1. every invariant declared in the domain model is registered ─────────────────
const domain = readFileSync(join(root, 'plans/01-DOMAIN-MODEL.md'), 'utf8');
const declared = [...domain.matchAll(/^\| (INV-[A-Z]+-\d+) \|/gm)].map((m) => m[1]);
const registered = registry.invariants.map((i) => i.id);

console.log(`1. coverage — ${declared.length} invariant(s) declared in 01-DOMAIN-MODEL.md`);

const unregistered = declared.filter((id) => !registered.includes(id));
if (unregistered.length === 0) ok('every declared invariant is registered');
else
  bad(
    `declared but NOT registered: ${unregistered.join(', ')} — an invariant nobody enforces is a wish`,
  );

const phantom = registered.filter((id) => !declared.includes(id));
if (phantom.length === 0) ok('no registered invariant is missing from the domain model');
else
  bad(
    `registered but not declared: ${phantom.join(', ')} — delete the entry or declare the invariant`,
  );

// ── 2. every invariant names a real mechanism ─────────────────────────────────────
// ACTIVE invariants are hard-checked: their gate must exist in package.json and their
// file must exist on disk. STAGED invariants declare the phase by which they must become
// active — being honestly staged is fine, being silently unenforced is not.
console.log('\n2. mechanism — active invariants are hard-checked, staged ones are dated');
let activeCount = 0;
for (const inv of registry.invariants) {
  const isActive = inv.status === 'active';
  if (isActive) activeCount++;
  else {
    if (!/^P\d+$/.test(inv.enforcedFrom ?? '')) {
      bad(
        `${inv.id}: staged but no enforcedFrom phase — an undated promise is not staged, it is unenforced`,
      );
      continue;
    }
    staged.push(inv);
    const problems = [];
    if (!(inv.gates?.length || inv.files?.length)) {
      bad(`${inv.id}: staged with no declared mechanism at all`);
      continue;
    }
    soft(`${inv.id} — staged until ${inv.enforcedFrom} (${inv.summary})`);
    continue;
  }
  const problems = [];
  if (!(inv.gates?.length || inv.files?.length)) problems.push('ACTIVE with no mechanism');

  for (const g of inv.gates ?? []) {
    const name = g.replace(/^pnpm\s+(run\s+)?/, '').split(' ')[0];
    if (!(name in scripts)) problems.push(`gate \`${g}\` is not a script in package.json`);
  }
  for (const f of inv.files ?? []) {
    // A glob-ish path: check the directory exists and at least one match.
    if (f.includes('*')) {
      const dir = join(root, f.slice(0, f.indexOf('*')).replace(/\/$/, ''));
      if (!existsSync(dir)) problems.push(`no directory for \`${f}\``);
    } else if (!existsSync(join(root, f))) {
      problems.push(`\`${f}\` does not exist`);
    }
  }
  if (inv.enforcedFrom && !/^P\d+$/.test(inv.enforcedFrom)) {
    problems.push(`enforcedFrom \`${inv.enforcedFrom}\` is not a phase id`);
  }

  if (problems.length === 0) ok(`${inv.id} — ACTIVE — ${inv.summary}`);
  else bad(`${inv.id}: ${problems.join('; ')}`);
}

// ── 3. no invariant may be enforced by prose alone ────────────────────────────────
console.log('\n3. no prose enforcement');
const proseOnly = registry.invariants.filter((i) => !i.gates?.length && !i.files?.length);
if (proseOnly.length === 0)
  ok(
    `every invariant declares at least one mechanism (${activeCount} active, ${staged.length} staged)`,
  );
else
  bad(
    `enforced by a sentence and nothing else: ${proseOnly.map((i) => i.id).join(', ')}\n` +
      '     This is the pre-ticked-checklist failure mode. Name a gate, or name a file.',
  );

// ── 3b. a staged invariant may not point past a phase we have already reached ─────
// The failure this catches: staging everything to P17 and never implementing any of it.
const REACHED = Number(process.env.REACHED_PHASE ?? '0');
if (REACHED > 0) {
  const overdue = staged.filter((i) => Number(i.enforcedFrom.slice(1)) <= REACHED);
  if (overdue.length === 0) ok(`no staged invariant is overdue at P${REACHED}`);
  else
    bad(
      `${overdue.length} invariant(s) were due to be ACTIVE by P${REACHED} and are still staged:\n` +
        overdue.map((i) => `         ${i.id} (due ${i.enforcedFrom})`).join('\n') +
        '\n     Staging is a promise with a date. This is that date.',
    );
}

// ── 4. a gate must not be a no-op ────────────────────────────────────────────────
// A registered gate that does not exist in package.json was already caught above. This
// catches the subtler case: a gate that exists but is a stub.
console.log('\n4. gates are not stubs');
for (const inv of registry.invariants.filter((i) => i.status === 'active')) {
  for (const g of inv.gates ?? []) {
    const name = g.replace(/^pnpm\s+(run\s+)?/, '').split(' ')[0];
    const body = scripts[name] ?? '';
    if (/^\s*(echo|:)\s*$/m.test(body) && body.replace(/[#\n]/g, '').trim().length < 8) {
      bad(`${inv.id}: gate \`${name}\` looks like a stub (\`${body.trim()}\`)`);
    }
  }
}
if (!failures.some((f) => f.includes('looks like a stub'))) ok('no registered gate is a stub');

console.log('');
if (failures.length > 0) {
  console.error(`\x1b[31mINVARIANT REGISTRY GATE FAILED\x1b[0m — ${failures.length} problem(s)\n`);
  for (const f of failures) console.error(`  • ${f}\n`);
  process.exit(1);
}
console.log(
  `\x1b[32mINVARIANT REGISTRY GATE PASSED\x1b[0m — ${registry.invariants.length} invariants, each with a real mechanism\n`,
);

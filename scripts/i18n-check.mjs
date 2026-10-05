#!/usr/bin/env node
/**
 * `pnpm i18n:check` — WHICH `ci.yml` HAS BEEN CALLING SINCE IT DID NOT EXIST.  (`P13-T7`)
 *
 * ## WHY THIS STEP, AND WHY IT RUNS BEFORE THE DEPENDENCY SCAN EVER DID
 *
 * `ci.yml`'s `policy` job ran `pnpm i18n:check`, no such script existed, and the job died on step
 * one — so `i18n:check` and the dependency scan that sat after it both never ran. `P14-T15` moved the
 * dependency scan above and left this step commented out "rather than deleted, because a deleted CI
 * step is indistinguishable from a control that was deliberately removed". This file is what makes it
 * honest to uncomment.
 *
 * ## THE SOURCE LOCALE IS PRINTED FIRST, BEFORE ANY CHECK RUNS
 *
 * **TWO CATALOGUES COMPARED FOR EQUALITY CANNOT TELL WHICH IS AUTHORITATIVE.** Three keys deleted from
 * `en-GB` and left in `en-US` looks exactly like three keys missing from `en-US`, and a reader of the
 * second version opens the wrong file. So `SOURCE_LOCALE` is declared in one place
 * (`packages/i18n/src/locale.ts`), every check is stated relative to it, and the first thing printed is
 * which locale that is.
 *
 * ## THE RULES ARE NOT WRITTEN HERE
 *
 * `auditCatalogues` in `packages/i18n/src/audit.ts` is a pure function, imported below. This file
 * prints what it returns and exits non-zero; `packages/i18n/src/audit.test.ts` plants a violation of
 * each rule and asserts it is caught. **A gate whose rules exist only inside the gate has one caller,
 * and that caller is a process that exits.**
 *
 * ## WHY THIS SCRIPT ALSO RUNS THE EXTRACTION SCAN
 *
 * **A COMPLETENESS GATE THAT PASSES WHILE NOTHING CALLS THE FRAMEWORK IS THE SAME SHAPE AS NO GATE.**
 * Every key can be translated perfectly while the app keeps gaining hard-coded English. The two checks
 * are reported in separate sections so a failure is unambiguous about which one produced it, and both
 * must pass.
 *
 * ## WHAT IT CANNOT SEE, PRINTED ON EVERY RUN
 *
 * A green tick from this script means four things and not a fifth: no catalogue is missing a key, none
 * has an orphan, no translation has changed a placeholder, and no message's plural arms are short for
 * the locale they will serve. It does NOT mean the copy is translated well, does not mean the layout
 * survives text expansion (that is `P13-T8`), and does not mean right-to-left renders correctly (also
 * `P13-T8`). A green tick from a floor-level check is still a claim, so the claim is labelled.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * TEACH NODE THIS REPOSITORY'S `.js`-IN-`.ts` IMPORT CONVENTION, FOR THIS PROCESS ONLY.
 *
 * `packages/i18n`'s TypeScript sources import each other as `./intl.js`, which is what `module: NodeNext`
 * requires for emitted ESM. Node's type stripping runs `.ts` files but its resolver does not map a
 * `.js` specifier onto a `.ts` file, so importing the catalogues directly fails on `intl.js` without
 * this. **The alternative was a build step or a `vitest` subprocess, and both were rejected**: a stale
 * `dist/` would make the gate report on code that is not what is about to ship, and a subprocess buries
 * the findings in a test runner's output format. A 10-line resolver hook is the honest third option,
 * and it changes nothing outside this process.
 */
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL) {
      const base = dirname(fileURLToPath(context.parentURL));
      const candidate = resolve(base, specifier.replace(/\.js$/, '.ts'));
      if (existsSync(candidate)) return { url: pathToFileURL(candidate).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const { auditCatalogues } = await import('../packages/i18n/src/audit.ts');
const { CATALOGUES } = await import('../packages/i18n/src/catalogues.ts');
const { LOCALES, SOURCE_LOCALE } = await import('../packages/i18n/src/locale.ts');

console.log('i18n:check — catalogue completeness and extraction  (P13-T7)\n');
console.log(
  `  SOURCE LOCALE: ${SOURCE_LOCALE}   (every finding below is stated relative to this one)`,
);
console.log(`  locales declared in LOCALES: ${LOCALES.join(', ')}`);
console.log(`  catalogues present:          ${Object.keys(CATALOGUES).join(', ')}`);

const report = auditCatalogues({
  sourceLocale: SOURCE_LOCALE,
  catalogues: CATALOGUES,
  declaredLocales: LOCALES,
});

console.log(`\n  keys in the source catalogue: ${String(report.keyCount)}`);

if (report.findings.length === 0) {
  console.log(
    '  \u001b[32m✓\u001b[0m every locale has every source key, no orphans, placeholders match, plurals covered',
  );
} else {
  // STDOUT, NOT STDERR. The scan below is a child process writing to both, and a report whose two
  // halves arrive interleaved out of order is a report nobody reads the end of.
  console.log(`\n  \u001b[31m✗ ${String(report.findings.length)} findings\u001b[0m\n`);
  for (const finding of report.findings) {
    console.log(`    ${finding.locale.padEnd(8)} ${finding.rule.padEnd(21)} ${finding.key}`);
    console.log(`             ${finding.detail}`);
  }
  console.log('\n  Every finding names its key. "12 missing keys" is not actionable.');
}

// ── The extraction delta. Separate section so a failure says which check produced it. ──────────────
console.log('\n  ── extraction ──');
const scan = spawnSync(process.execPath, [join(root, 'scripts/i18n-scan.mjs')], {
  cwd: root,
  encoding: 'utf8',
});
process.stdout.write(scan.stdout ?? '');
process.stderr.write(scan.stderr ?? '');
const scanFailed = scan.status !== 0;

console.log('\n  scope of this gate:');
console.log(
  '    ✓ same keys in every locale, orphans, placeholder sets, plural-arm coverage per locale',
);
console.log('    ✓ no NEW hard-coded user-facing string in apps/web/src (scripts/i18n-scan.mjs)');
console.log('    ✗ NOT copy quality, text expansion, or RTL layout — P13-T8.');
console.log(
  '    ✗ NOT strings built by concatenation or returned from a function — see the scan header.',
);

if (report.findings.length > 0 || scanFailed) {
  console.error('\ni18n:check FAILED');
  process.exit(1);
}
console.log('\ni18n:check PASSED');

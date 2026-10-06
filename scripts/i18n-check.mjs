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
 * A green tick from this script means five things and not a sixth: no catalogue is missing a key, none
 * has an orphan, no translation has changed a placeholder, no message's plural arms are short for
 * the locale they will serve, and every message still parses with its placeholders intact after
 * **+30% text expansion** (`P13-T8`). It does NOT mean the copy is translated well, and it does NOT
 * mean the LAYOUT survives the expansion -- see the RTL note below, which is the more important
 * half. A green tick from a floor-level check is still a claim, so the claim is labelled.
 *
 * ## ⚠️ THERE IS NO RTL CHECK IN THIS SCRIPT, AND ONE WOULD BE A GATE THAT CANNOT FAIL
 *
 * `P13-T8` asks for "RTL layout check in CI". `plans/20-PHASE-PACKETS.md` cut the third locale, so
 * the shipped locales are `en-GB` and `en-US` -- **neither of which is right-to-left, and no RTL text
 * exists anywhere in the repository.** An RTL gate written today would have nothing to assert on and
 * would report PASS on every run, forever.
 *
 * **A check that cannot fail is worse than no check, because it is read as evidence.** So there is
 * no RTL step here. `plans/15-A11Y-I18N.md`'s exit criteria still demand "three locales ... and
 * correct RTL behaviour" while the phase packet cut the locale that would have supplied them: that
 * contradiction is recorded against `P13-T8` rather than ticked. The check becomes meaningful in the
 * same commit that adds a locale with an RTL script, and not one commit before.
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
const { auditExpansion } = await import('../packages/i18n/src/expansion.ts');
const { parseMessage } = await import('../packages/i18n/src/message.ts');
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

// ── +30% text expansion. `P13-T8`. ────────────────────────────────────────────────────────────────
console.log('\n  ── text expansion (+30%) ──');
const expansionReports = [];
for (const tag of Object.keys(CATALOGUES)) {
  const catalogue = CATALOGUES[tag];
  expansionReports.push({
    tag,
    report: auditExpansion(catalogue, CATALOGUES[SOURCE_LOCALE], parseMessage),
  });
}
const expansionFindings = expansionReports.flatMap(({ tag, report: one }) =>
  one.findings.map((finding) => ({ ...finding, tag })),
);
const expansionKeys = expansionReports.reduce((total, one) => total + one.report.checked, 0);
if (expansionFindings.length === 0) {
  console.log(
    `    ✓ ${expansionKeys} messages still parse, and keep every placeholder, at +30%` +
      ` (German and Finnish are about this much longer than English).`,
  );
} else {
  for (const finding of expansionFindings) {
    console.log(`    ${finding.tag.padEnd(8)} ${finding.rule.padEnd(30)} ${finding.key}`);
    console.log(`      ${finding.detail}`);
  }
}
console.log(
  '    ✗ NOT layout. A message can be 30% longer and still be CLIPPED by a max-width or an',
);
console.log(
  '      ellipsis, which is a rendering property — P13-T6/P13-T9, in a real screen reader.',
);

console.log('\n  scope of this gate:');
console.log(
  '    ✓ same keys in every locale, orphans, placeholder sets, plural-arm coverage per locale',
);
console.log('    ✓ no NEW hard-coded user-facing string in apps/web/src (scripts/i18n-scan.mjs)');
console.log('    ✓ +30% expansion leaves every message parseable with its placeholders intact');
console.log('    ✗ NOT copy quality.');
console.log('    ✗ NOT RTL layout — NO RTL TEXT EXISTS, so such a check could never fail.');
console.log(
  '    ✗ NOT strings built by concatenation or returned from a function — see the scan header.',
);

if (report.findings.length > 0 || scanFailed || expansionFindings.length > 0) {
  console.error('\ni18n:check FAILED');
  process.exit(1);
}
console.log('\ni18n:check PASSED');

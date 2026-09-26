#!/usr/bin/env node
/**
 * JS BUDGET GATE  (P0-T7)
 *
 * ## Why this exists
 *
 * plans/03 §8 sets a JS budget per route, and the exam runtime's budget is a *release
 * gate* rather than a target. The reason is concrete: a heavy exam start is a real
 * failure. A student on school wifi must be able to begin an exam. A bundle that grew
 * 40 KB because a dependency was added for a dashboard is not a style regression, it is
 * a student waiting at a deadline.
 *
 * This script is a GATE, and like every gate in this repository it is proven to be able
 * to fail — see `budget.spec.mjs` and the P0-T7 exit criteria. A budget script that
 * silently passes when it cannot find a bundle is worse than no script at all, so
 * **a missing bundle is a failure**, not a skip.
 *
 * Thresholds are plans/03 §8 verbatim. Changing one requires `GATE-CHANGE:` (D-35), which
 * `.github/workflows/ci.yml::gate-integrity` enforces.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** plans/03 §8. Keys are gzipped KB, because that is what a student downloads. */
export const BUDGETS = {
  'public resource': 180,
  'library/dashboard': 220,
  studio: 400,
  // The one that matters most.
  exam: 250,
  'app vs registry independence': 0, // must not grow as sims are added (plans/11)
};

const failures = [];
const warn = [];

const gz = (buf) => {
  // gzip level 9, matching what a CDN would serve. Node's zlib, no dependency.
  const { gzipSync } = require('node:zlib');
  return gzipSync(buf, { level: 9 }).length;
};

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (p.endsWith('.js') || p.endsWith('.mjs')) out.push(p);
  }
  return out;
}

function totalGzKb(files) {
  let raw = 0;
  for (const f of files) raw += statSync(f).size;
  const { gzipSync } = require('node:zlib');
  return gzipSync(Buffer.alloc(0)) && raw
    ? gz(Buffer.concat(files.map((f) => readFileSync(f)))) / 1024
    : 0;
}

/** The exam runtime is the hard gate. Everything else warns until the app has routes. */
const hard = process.argv.includes('--hard');
const isCi = !!process.env.CI;

console.log('\nBUNDLE BUDGET GATE\n==================\n');

const examDir = join(root, 'apps/web/.next/static');
const buildDir = join(root, 'apps/web/dist');

if (!existsSync(examDir) && !existsSync(buildDir)) {
  // NOT a skip. A gate that passes because it found nothing has no teeth.
  console.error(
    '  ✗ no build output found (apps/web/.next/static or apps/web/dist).\n' +
      '    Run `pnpm build` first. A budget gate that cannot find a bundle must fail,\n' +
      '    otherwise it is decoration — the same defect as an unrunnable conformance test.',
  );
  process.exit(1);
}

const files = [...walk(examDir), ...walk(buildDir)];
if (files.length === 0) {
  console.error('  ✗ build directory exists but contains no JS. Treating as a failure.');
  process.exit(1);
}

const kb = totalGzKb(files);
const limit = BUDGETS.exam;

console.log(`  measured : ${kb.toFixed(1)} KB gzipped across ${files.length} chunk(s)`);
console.log(`  limit    : ${limit} KB gzipped (plans/03 §8, exam runtime)\n`);

if (kb > limit) {
  const over = (kb - limit).toFixed(1);
  const msg =
    `bundle is ${over} KB over the exam budget (${kb.toFixed(1)} > ${limit} KB gzipped)\n` +
    '     A heavy exam start is a real failure: a student on school wifi must be able to begin.\n' +
    '     Before raising this number, find what was added and whether the exam surface needs it.';
  if (hard || isCi) {
    console.error(`  ✗ ${msg}`);
    failures.push(msg);
  } else {
    console.log(`  ! ${msg}`);
    warn.push(msg);
  }
} else {
  console.log(`  ✓ within budget (${(limit - kb).toFixed(1)} KB headroom)`);
}

// ── registry independence (D-20, plans/11)
// The app bundle must not grow as simulations are added. Sims are content-addressed and
// lazy; the catalogue fetches a metadata index, never code. If a sim bundle ever appears
// under the app's static dir, this is the check that notices.
const simLeaks = files.filter((f) => /\/sims\//.test(f) || /sim-.*\.[0-9a-f]{8,}\.js$/.test(f));
if (simLeaks.length > 0) {
  const msg =
    `${simLeaks.length} simulation bundle(s) found inside the app's static output:\n` +
    simLeaks
      .slice(0, 5)
      .map((f) => `       ${f.replace(root, '.')}`)
      .join('\n') +
    '\n     Sim bundles must be served from the separate sims origin and lazy-loaded.';
  console.error(`  ✗ ${msg}`);
  failures.push(msg);
} else {
  console.log('  ✓ no simulation bundles in the app output (registry independence holds)');
}

console.log('');
if (failures.length > 0) {
  console.error('\x1b[31mBUNDLE BUDGET GATE FAILED\x1b[0m\n');
  for (const f of failures) console.error(`  • ${f}\n`);
  process.exit(1);
}
if (warn.length > 0) {
  console.log('\x1b[33mBUNDLE BUDGET GATE PASSED WITH WARNINGS\x1b[0m (CI enforces these)');
  process.exit(0);
}
console.log('\x1b[32mBUNDLE BUDGET GATE PASSED\x1b[0m');

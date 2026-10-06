#!/usr/bin/env node
/**
 * JS BUDGET GATE  (P0-T7)
 *
 * ## Why this exists
 *
 * plans/03 §8 sets a JS budget per route, and the exam runtime's budget is a *release
 * gate* rather than a target. The reason is concrete: a heavy exam start is a real failure.
 * A student on school wifi must be able to begin an exam. A bundle that grew 40 KB because
 * a dependency was added for a dashboard is not a style regression; it is a student waiting
 * at a deadline.
 *
 * ## A note on how this gate nearly shipped broken
 *
 * The first version of this script used `require()` inside an `.mjs` file. It threw on the
 * happy path, and every "mutation test" I ran against it exercised only the *no build*
 * branch — so it appeared to work while never once measuring a real bundle. It was
 * vacuously green.
 *
 * That is the exact failure this repository keeps running into (D-31's pre-ticked
 * checklist, D-35's bypassable gates, MISSED-7's unverified invariants). So this script has
 * two extra properties:
 *
 *   1. It never exits 0 on an internal error. A crash is a failure, because a gate that
 *      crashes open is worse than a gate that is absent.
 *   2. It prints the measured number unconditionally, so "0 KB" is visibly wrong rather
 *      than quietly passing.
 *
 * Changing a threshold requires `GATE-CHANGE:` (D-35), enforced by the `gate-integrity` job.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

/** plans/03 §8. KB, gzipped, because that is what a student downloads. */
export const BUDGETS = {
  exam: 250,
  'shared first load': 120,
};

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const failures = [];
const say = (s) => console.log(s);
const ok = (m) => say(`  \x1b[32m✓\x1b[0m ${m}`);
/**
 * ⚠️ `soft()` AND THE "PASSED WITH NOTES" EXIT WERE DELETED, DELIBERATELY.
 *
 * `soft()` existed for exactly one caller in this file's life: the `const prev = 40` guard, which had been exceeded by 2.5x
 * since it was written and therefore printed the same yellow note on every run of the repository's history. So once the
 * ratchet replaced it, `notes` was always empty and **`BUNDLE BUDGET GATE PASSED WITH NOTES` became unreachable** -- a softer
 * green that nothing could produce.
 *
 * Leaving it in place would mean keeping a second, quieter way for this gate to pass, and a gate with two greens is a gate
 * whose green you have to check the spelling of. **Every green this script can print is now a real green.** A future advisory
 * that is worth having should be added with its reason, not inherited as a channel.
 */
const bad = (m) => {
  failures.push(m);
  say(`  \x1b[31m✗\x1b[0m ${m}`);
};

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(js|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

say('\nBUNDLE BUDGET GATE\n==================\n');

try {
  const staticDir = join(root, 'apps/web/.next/static');
  const chunksDir = join(root, 'apps/web/.next/server/chunks');
  const distDir = join(root, 'apps/web/dist');

  const buildDir = [staticDir, chunksDir, distDir].find((d) => existsSync(d));
  if (!buildDir) {
    // NOT a skip. A gate that passes because it found nothing has no teeth.
    bad(
      'no build output found (apps/web/.next/static or apps/web/dist).\n' +
        '     Run `pnpm build` first. A budget gate that cannot find a bundle must FAIL —\n' +
        '     otherwise it is decoration, which is how the first version of this script\n' +
        '     shipped green without ever measuring anything.',
    );
    throw new Error('no build output');
  }

  // ── measure the EXAM ROUTE's first load, not every chunk ────────────────────
  // The budget in plans/03 §8 is per-route. Gzipping a concatenation of every chunk in the
  // build measures the wrong thing: it includes server-only chunks, the marketing page and
  // the not-found page, none of which a student downloads when starting an exam. An earlier
  // version of this script did exactly that and reported 339.8 KB for a route Next itself
  // reports as 102 KB.
  //
  // `app-build-manifest.json` is Next's own answer: the exact file list each route pulls
  // on first load. Measure that, and the number is comparable to the one Next prints.
  const manifestPath = join(root, 'apps/web/.next/app-build-manifest.json');
  // SAY WHY, AND SAY WHAT TO DO.
  //
  // Without a build the gate measured 1735 KB gzipped -- not a real number at all, just the fallback
  // directory listing. It did fail, which is the important part, but "1735 KB over a 250 KB budget" reads
  // like a catastrophic regression when the truth is that nobody had built the app. `pnpm gates` now builds
  // first so the measurement is reproducible rather than dependent on what happened to be lying around.
  if (!existsSync(manifestPath)) {
    bad('no app-build-manifest.json — cannot measure a per-route budget');
    throw new Error('no manifest');
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const pages = manifest.pages ?? {};

  // The route the budget is actually about. Named explicitly so that renaming or splitting
  // the exam surface cannot silently remove it from the measurement.
  const EXAM_ROUTES = ['/exam/[attemptId]/page', '/exam/[attemptId]/layout', '/layout'];

  const missing = EXAM_ROUTES.filter((r) => !(r in pages));
  if (missing.length > 0) {
    bad(`exam route(s) absent from the build manifest: ${missing.join(', ')}
     The budget cannot be measured against a route that does not exist, and a silently absent exam surface is worse than a heavy one.`);
  }

  const examFiles = [...new Set(EXAM_ROUTES.flatMap((r) => pages[r] ?? []))].filter(
    (f) => f.startsWith('static/') || f.includes('/static/'),
  );

  if (examFiles.length === 0) {
    bad('exam route resolved to zero static chunks — cannot measure');
    throw new Error('no exam chunks');
  }

  const readChunk = (rel) => {
    const p = join(root, 'apps/web/.next', rel.replace(/^\.?\/?/, ''));
    return existsSync(p) ? readFileSync(p) : null;
  };
  const buffers = examFiles.map(readChunk).filter((b) => b !== null);
  const kb = gzipSync(Buffer.concat(buffers), { level: 9 }).length / 1024;

  say(`  exam route: /exam/[attemptId]`);
  say(`  chunks    : ${examFiles.length} (from Next's own app-build-manifest)`);
  say(`  gzipped   : ${kb.toFixed(1)} KB first load`);
  say(`  budget    : ${BUDGETS.exam} KB\n`);

  if (kb > BUDGETS.exam) {
    bad(
      `the exam route's first load is ${kb.toFixed(1)} KB gzipped, over the ${BUDGETS.exam} KB budget.\n` +
        '     A heavy exam start is a real failure. Before raising the number, find what\n' +
        '     was added to the exam surface and whether it needs to be there.',
    );
  } else {
    ok(`exam first load within budget (${(BUDGETS.exam - kb).toFixed(1)} KB headroom)`);
  }

  // ── the REGRESSION guard: a ratchet against a RECORDED value  (P12-T6) ─────────
  //
  // This used to be `const prev = 40`, and it was the weakest line in the file:
  //
  //   - it was a CONSTANT, so nothing measured anything -- a regression guard needs a previous
  //     MEASUREMENT to be a guard, and 40 was a number someone typed;
  //   - the exam route measured 99.5 KB, so it had been exceeded by 2.5x since the commit that
  //     introduced it, and `soft()` never fails, so it printed the same yellow note on every run
  //     of the repository's entire life;
  //   - 40 KB appears in no plan. plans/03 §8 sets 250 KB for the exam runtime, and that budget is
  //     enforced above and passes.
  //
  // **A GUARD WHOSE THRESHOLD HAS NEVER BEEN MET CANNOT DISTINGUISH A REGRESSION FROM THE STATUS QUO**,
  // and one that is permanently noisy is one everybody learns to skip -- the same lesson as the
  // permanently-RED gate, in yellow.
  //
  // So the previous value is recorded in `audit/bundle-baseline.json`, the comparison is a real
  // one, and exceeding the tolerance FAILS. Raising the baseline is a deliberate act: it is a
  // diff, it is reviewable, and `gate-integrity` requires `GATE-CHANGE:` on this file.
  const baselinePath = join(root, 'audit', 'bundle-baseline.json');
  if (!existsSync(baselinePath)) {
    bad(
      'audit/bundle-baseline.json is missing, so there is no previous measurement to regress from.\n' +
        '     A regression guard with no baseline is a constant compared against a number typed by\n' +
        '     hand, which is what this check used to be. Restore the file, or record a baseline and\n' +
        '     say why.',
    );
  } else {
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
    const recorded = baseline.examFirstLoadKb;
    const tolerance = baseline.toleranceKb ?? 0;
    if (typeof recorded !== 'number') {
      bad(
        `audit/bundle-baseline.json has no numeric examFirstLoadKb (found ${JSON.stringify(recorded)}).`,
      );
    } else if (kb > recorded + tolerance) {
      bad(
        `the exam route's first load GREW: ${kb.toFixed(1)} KB against a recorded ${String(recorded)} KB ` +
          `(+${(kb - recorded).toFixed(1)} KB, tolerance ${String(tolerance)} KB).\n` +
          '     Still under the absolute budget, so this is the check that catches a slow drift\n' +
          '     before it becomes a breach. Find what was added to the exam surface and whether it\n' +
          '     needs to be there. If the growth is deliberate, record it in\n' +
          '     audit/bundle-baseline.json in the same commit as the change -- that diff is the review.',
      );
    } else {
      ok(
        `exam first load against the recorded baseline: ${kb.toFixed(1)} KB vs ${String(recorded)} KB ` +
          `(+${Math.max(0, kb - recorded).toFixed(1)}, tolerance ${String(tolerance)})`,
      );
    }
  }

  // NOTE: the registry-independence check below walks the static directory ON DISK, not
  // this manifest list. A leaked sim bundle is by definition not in the app's manifest —
  // scanning the manifest is what made this check vacuous the first time round.

  // ── registry independence (D-20, plans/11) ───────────────────────────────────
  // Sim bundles are content-addressed and served from a SEPARATE origin. The app bundle
  // must not grow as the registry does. If a sim bundle appears under the app's static
  // dir, the sandbox and the budget are both quietly undermined.
  const onDisk = [...walk(staticDir), ...walk(distDir)];

  /**
   * DETECTED BY THE ARTEFACT'S OWN NAME, TAKEN FROM THE REGISTRY -- NOT BY A FILENAME PATTERN.
   *
   * The old test was `/sim[-_.][a-z0-9-]*\.[0-9a-f]{8,}\.js$/`, i.e. "a file whose name STARTS WITH `sim`".
   * **A simulation's artefacts are named `browser.41b0adba2fe6.js` and `grader.fc006cd16a56.js`** -- the `sim` prefix is
   * in the DIRECTORY name, never the file. So that alternative could never match a real simulation bundle.
   *
   * Proven by planting: a real artefact, `grader.fc006cd16a56.js`, copied into `apps/web/.next/static/chunks/`, and the
   * gate printed **"no simulation bundles in the app output (registry independence holds)"**.
   *
   * The only alternative that could have fired is the PATH test `/sims\//`, which needs the bundle nested under a directory
   * literally named `sims`. **A bundler that emits simulation chunks FLAT into the app's static directory -- which is exactly
   * what happens the moment somebody imports a simulation into the app -- produces `grader.<hash>.js` and passes.**
   *
   * So the comparison is now against the registry's own list of artefact filenames, by exact name. That cannot be evaded by
   * renaming a directory, because content-hash names are what the build produced and the build is what shipped.
   *
   * The path test is kept as a second net, not as the only one.
   */
  const registryJson = join(root, 'sims/registry/registry.json');
  const registeredArtefacts = new Set();
  if (existsSync(registryJson)) {
    const parsed = JSON.parse(readFileSync(registryJson, 'utf8'));
    for (const entry of parsed.entries ?? []) {
      for (const artefact of Object.values(entry.bundle ?? {})) {
        if (typeof artefact === 'string') registeredArtefacts.add(artefact.replace(/^\.\//u, ''));
      }
    }
  }

  const simLeaks = onDisk.filter(
    (f) => /[\\/]sims[\\/]/u.test(f) || registeredArtefacts.has(f.split(/[\\/]/u).pop()),
  );
  if (simLeaks.length > 0) {
    bad(
      `${simLeaks.length} simulation bundle(s) inside the app's static output:\n` +
        simLeaks
          .slice(0, 5)
          .map((f) => `         ${relative(root, f)}`)
          .join('\n') +
        '\n     Sim bundles belong on the sims origin and must be lazy-loaded.',
    );
  } else {
    ok('no simulation bundles in the app output (registry independence holds)');
  }
} catch (e) {
  if (e instanceof Error && e.message === 'no build output') {
    /* already reported */
  } else if (e instanceof Error && e.message === 'empty build') {
    /* already reported */
  } else {
    // A crash is a FAILURE. A gate that crashes open is worse than no gate at all.
    bad(`gate crashed: ${e?.message ?? e}\n     A gate that cannot complete must not pass.`);
  }
}

say('');
if (failures.length > 0) {
  console.error(`\x1b[31mBUNDLE BUDGET GATE FAILED\x1b[0m — ${failures.length} problem(s)\n`);
  for (const f of failures) console.error(`  • ${f}\n`);
  process.exit(1);
}
say('\x1b[32mBUNDLE BUDGET GATE PASSED\x1b[0m');

#!/usr/bin/env node
/**
 * SIMULATION REGISTRY ARTEFACT GATE — `INV-SIM-1` and `INV-SIM-2`.  (P14-T18)
 *
 * > `plans/10` §6: "Registration is a CI job, not a human database edit."
 * > `plans/14` §5:62 lists as a ticked release gate: *"registry built by CI only; no user code (`ADR-0018`)."*
 *
 * ## THE TICK WAS A PROSE TICK (`TM-18`)
 *
 * `apps/worker/src/index.ts:142-150` — `sim.build` — throws `not implemented — P6-T4`. Nothing in this repository
 * built `sims/registry/registry.json`; it was a committed file of untraced provenance. The escape gate
 * (`scripts/sim-sandbox-escape.mjs`) is real and self-checks that it observed a blocked escape, and it tests the escapes
 * AGAINST this registry — **so the artefact the sandbox's central ADR is argued from was produced by nobody.** It failed
 * safe, because a registry nobody builds means nothing is being served. It was Medium because "no user code reaches the
 * sandbox" rested on a directory listing.
 *
 * ## AND A JOB THAT REPORTS SUCCESS WITHOUT PRODUCING THE ARTEFACT IS WORSE THAN NO JOB
 *
 * This script exists to answer one question — **did the build actually produce the registry?** — and the answer has to be
 * checked rather than inferred from an exit code, because `sim-build.mjs`'s `main()` returns without writing anything when
 * `discover()` finds no manifests (`:610-616`) and still prints `sim:build passed`. The same class of failure is recorded
 * twice more in that file: `writeRegistry` once received an empty list and "quietly emitted nothing while the build
 * printed 1/1 simulations" (`:626-630`), and the regression guard's registry key was the DIRECTORY rather than
 * `manifest.id`, so an 18.4% regression passed silently (`:431-438`).
 *
 * So every claim below is asserted against the FILES, not against the build's exit status:
 *
 *  1. the three registry artefacts exist and parse;
 *  2. the entry set is EXACTLY the set of simulation manifests on disk — which is what "no user code" means, because an
 *     entry with no manifest is an entry no build could have produced;
 *  3. **every bundle path in every entry resolves to a file that exists on disk with the byte count the registry claims**,
 *     which is the check that distinguishes a registry from a plausible-looking JSON document;
 *  4. the digest recomputes — the file was produced by `buildRegistry`, not typed by a human, which is the mechanical half
 *     of "registration is a CI job";
 *  5. the catalogue index carries NO bundle path (`plans/10` §9: "the catalogue fetches a metadata index, never code"), and
 *     it covers every registry entry;
 *  6. the registry loads back through `resolve()` — the one function every consumer shares — so an artefact that parses
 *     but cannot resolve is caught here rather than in a student's browser.
 *
 * ## IT READS THE ARTEFACT AND DOES NOT BUILD IT, DELIBERATELY
 *
 * `sim-build.mjs` builds. This asserts. A gate that built its own input could not tell a stale registry from a fresh one,
 * which is the defect `previousBytes`'s header calls "a guard that can never fail". `ci.yml`'s `sim-registry` job builds
 * first and then runs this; a developer runs `pnpm sim:build` and then `pnpm gate:sim-registry`.
 *
 * ## AND IT DOES NOT USE `git`, DELIBERATELY
 *
 * `sim-build.mjs` reads `git show HEAD:sims/registry/registry.json` for its regression baseline (`:499`). This gate does
 * not, and the reason is not squeamishness about the working tree: **a comparison against `HEAD` in a four-lane concurrent
 * tree compares the artefact against whatever some other lane last committed.** Claims 2 and 3 above are absolute — they
 * are true or false of the files in front of the gate — and they are what "the artefact exists" has to mean.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const load = async (relative) => import(pathToFileURL(join(root, relative)).href);

const failures = [];
const fail = (message) => failures.push(message);

/** The three files `writeRegistry` produces. All three, because a registry somebody cannot read is one they will edit. */
const REGISTRY_JSON = join(root, 'sims/registry/registry.json');
const INDEX_JSON = join(root, 'sims/registry/index.json');
const README_MD = join(root, 'sims/registry/README.md');

/** Mirrors `sim-build.mjs`'s `NOT_A_SIM`: directories under `sims/` that are not simulations. */
const NOT_A_SIM = new Set(['_template', '_fixtures', 'registry']);

// ── 1. the artefacts exist ────────────────────────────────────────────────────────────────────
for (const [label, path] of [
  ['registry.json', REGISTRY_JSON],
  ['index.json', INDEX_JSON],
  ['README.md', README_MD],
]) {
  if (!existsSync(path)) {
    fail(
      `${label} does not exist. \`sims/registry/\` is a BUILD ARTEFACT: run \`pnpm sim:build\` (\`scripts/sim-build.mjs\`). ` +
        'Nothing in this repository produces it, which is `TM-18` — and a registry that is absent means nothing is being ' +
        'served, so it fails safe, while a registry that is STALE means a bundle path that resolves to nothing.',
    );
  }
}

/**
 * THE EARLY EXIT, AND IT PRINTS RATHER THAN CALLING `report()`.
 *
 * The first version called `report(0, 0, 0)` here and CRASHED with `ReferenceError: Cannot access 'manifestNames' before
 * initialization` — `manifestNames` is a `const` declared further down, so the early exit sat in its temporal dead zone.
 * **The exit code was still 1, so CI would still have gone red**, which is the worst version of this bug: a gate that
 * fails for the right reason and reports the wrong one trains a reader to trust the colour and ignore the text. That is
 * exactly the failure `sim-build.mjs`'s own header warns about — "a build gate that crashes open is worse than no gate" —
 * except this one crashed with the right code, which is harder to notice still.
 */
if (failures.length > 0) {
  process.stdout.write('SIMULATION REGISTRY ARTEFACT GATE (INV-SIM-1, INV-SIM-2)\n');
  process.stdout.write(`  registry entries: 0 (no artefact)\n`);
  process.stdout.write(`\nFAILED — ${String(failures.length)} artefact problem(s):\n`);
  for (const failure of failures) process.stdout.write(`  • ${failure}\n`);
  process.exit(1);
}

const registry = JSON.parse(readFileSync(REGISTRY_JSON, 'utf8'));
const index = JSON.parse(readFileSync(INDEX_JSON, 'utf8'));
const entries = Array.isArray(registry) ? registry : registry.entries;

// ── 2. the entry set is EXACTLY the manifest set — this is what "no user code" means ───────────
/**
 * **THIS IS THE `plans/14` §5:62 CLAIM, MECHANISED.**
 *
 * "Registry built by CI only; no user code" is a statement that every entry in the registry traces to a simulation in
 * this tree. The check that makes it true is set equality in BOTH directions:
 *
 *  · an entry with no manifest is an entry no build could have produced, so somebody typed it;
 *  · a manifest with no entry is a simulation the catalogue does not offer, which fails safe but is still a drift.
 *
 * Neither direction alone is the claim. An `every entry has a manifest` check passes on a registry holding one hand-typed
 * entry; a `every manifest has an entry` check passes on a registry with the same. Equality is the claim.
 */
const simsDir = join(root, 'sims');
const manifestNames = existsSync(simsDir)
  ? readdirSync(simsDir, { withFileTypes: true })
      .filter(
        (entry) => entry.isDirectory() && !NOT_A_SIM.has(entry.name) && !entry.name.startsWith('_'),
      )
      .map((entry) => entry.name)
      .filter((name) => existsSync(join(simsDir, name, 'sim.manifest.json')))
      .sort()
  : [];

const registryIds = entries.map((entry) => `${entry.id}@${entry.version}`).sort();
if (registryIds.length === 0) {
  fail(
    'the registry has no entries. An empty registry is indistinguishable from no build having run.',
  );
}

const { simManifestSchema } = await load('packages/contracts/dist/sim-manifest/index.js');
const manifests = new Map();
for (const name of manifestNames) {
  const parsed = simManifestSchema.parse(
    JSON.parse(readFileSync(join(simsDir, name, 'sim.manifest.json'), 'utf8')),
  );
  manifests.set(`${parsed.id}@${parsed.version}`, parsed);
}
const manifestIds = [...manifests.keys()].sort();

for (const id of registryIds) {
  if (!manifestIds.includes(id)) {
    fail(
      `the registry holds ${id} and there is no simulation manifest for it. An entry no build could produce was typed by ` +
        'hand, which is exactly what "registration is a CI job, not a human database edit" forbids.',
    );
  }
}
for (const id of manifestIds) {
  if (!registryIds.includes(id)) {
    fail(
      `${id} has a manifest on disk but no registry entry, so the catalogue cannot offer it. This fails SAFE — nothing ` +
        'is served — which is why it is a report rather than an outage, and a report that has never once been read.',
    );
  }
}

// ── 3. every bundle path resolves, with the byte count the registry claims ──────────────────────
/**
 * THE CHECK THAT DISTINGUISHES A REGISTRY FROM A PLAUSIBLE-LOOKING JSON DOCUMENT.
 *
 * `entryFromManifest` asserts that every path is `./<name>.<12 hex>.js` — relative and content-hashed — and throws
 * otherwise. That is a good property and it is about the STRING. **Nothing in this repository asserted that the file
 * those strings name exists on disk**, because until `P14-T18` nothing built the registry and therefore nothing had ever
 * looked. A registry whose `browser` path resolves to nothing produces an iframe that 404s, which a student's browser
 * reports as a blank simulation, which `SIM_LOAD_FAILED` records as *"a capability failure, not misconduct"* — so the
 * symptom is attributed to the student's device.
 */
let bundleFiles = 0;
for (const entry of entries) {
  // `dist/`, NOT `<id>/<version>/`. The first version of this gate looked in `sims/<id>/<version>/` and reported 48
  // failures against a registry that was perfectly good — `sim-build.mjs:240` writes to `join(dir, 'dist')`, and
  // `simAssetUrl`'s `<simId>/<version>/` composition is the DEPLOYED path, not the build path. A gate that guesses where
  // an artefact lives is a gate that reports a fiction.
  const directory = join(simsDir, entry.id, 'dist');
  if (!existsSync(directory)) {
    fail(
      `${entry.id}@${entry.version}: no ${join('sims', entry.id, 'dist')} to resolve its bundle paths against, so this ` +
        'entry was never built.',
    );
    continue;
  }
  for (const role of ['page', 'browser', 'grader', 'style']) {
    const relative = entry.bundle?.[role];
    if (relative === null || relative === undefined) {
      // `style` is legitimately absent on some sims. Any other role missing is a broken entry.
      if (role !== 'style') fail(`${entry.id}@${entry.version}: bundle.${role} is missing`);
      continue;
    }
    const path = join(directory, String(relative).replace(/^\.\//, ''));
    if (!existsSync(path)) {
      fail(
        `${entry.id}@${entry.version}: bundle.${role} is "${String(relative)}" and there is no such file. The registry ` +
          'describes an artefact that was never built, or was built from a different source than the one committed.',
      );
      continue;
    }
    bundleFiles += 1;
    const actual = statSync(path).size;
    const claimed = role === 'page' ? entry.bytes?.total : entry.bytes?.[role];
    // `total` covers page + browser + grader + style together, so it is not comparable to one file's size. The per-role
    // byte counts ARE, and comparing them is what catches a registry and a build that disagree.
    if (role !== 'page' && typeof claimed === 'number' && claimed !== actual) {
      fail(
        `${entry.id}@${entry.version}: bundle.${role} claims ${String(claimed)} bytes and the file is ${String(actual)}. ` +
          'The registry and the build disagree, so either the registry is stale or a bundle was rebuilt without it.',
      );
    }
  }
}

// ── 4. the digest recomputes, so the file was BUILT rather than typed ───────────────────────────
/**
 * `buildRegistry` sorts its entries and hashes the sorted set with `setDigest`, so two builds of one tree produce the same
 * digest and an order-dependent digest makes every rebuild look like a change. Recomputing it here is what turns
 * "registration is a CI job" from a sentence into a check: a hand-edited registry fails, because editing an entry changes
 * the set the digest covers.
 *
 * `setDigest` comes from `@orrery/interop` and is NOT a security primitive — its own header says so. It is a change
 * detector, and it is the right instrument for "did this file come out of the builder".
 */
const { setDigest } = await load('packages/interop/dist/digest.js');
const registryModule = await load('packages/sim-registry/dist/index.js');
const sorted = [...entries].sort((a, b) =>
  `${a.id}@${a.version}` < `${b.id}@${b.version}` ? -1 : 1,
);
const recomputed = setDigest(sorted);
if (registry.digest !== recomputed) {
  fail(
    `the registry digest does not recompute: the file says ${String(registry.digest)} and its own entries hash to ` +
      `${String(recomputed)}. A registry whose digest does not match its contents was edited after it was written, which ` +
      'is the thing `plans/10` §6 forbids.',
  );
}

// ── 5. the catalogue index is metadata and covers everything ───────────────────────────────────
/**
 * `catalogueIndex` exists so "the catalogue fetches a metadata index, never code" is enforced by the absence of a field a
 * bundle URL could go in. **Asserting the absence from outside is what stops the type from being widened later** — and a
 * catalogue page that could be used to load a simulation would turn every lesson into a code-delivery channel, since the
 * catalogue is fetched by every student in every lesson.
 */
const BUNDLE_PATH_FIELDS = ['bundle', 'page', 'browser', 'grader', 'style', 'src', 'url', 'href'];
if (!Array.isArray(index)) {
  fail('index.json is not an array. `catalogueIndex` returns a projection, not a wrapper.');
} else {
  if (index.length !== entries.length) {
    fail(
      `index.json holds ${String(index.length)} catalogue entries and the registry holds ${String(entries.length)}. ` +
        'The catalogue is fetched by every student in every lesson, so a short index is a set of simulations nobody can ' +
        'find.',
    );
  }
  for (const item of index) {
    for (const field of BUNDLE_PATH_FIELDS) {
      if (field in item) {
        fail(
          `index.json's entry ${String(item.id)} carries a "${field}" field. The catalogue projection must carry NO field ` +
            'a bundle path could go in, or "the catalogue fetches a metadata index, never code" is a convention.',
        );
      }
    }
    // `bytes` IS on the catalogue entry and is legitimate — a number a catalogue has to display — but a NUMBER is the
    // whole point: a string there would be a path. The first version of this gate banned the field name and reported 24
    // failures against a correct index, which is the "assert the key rather than the property" mistake again.
    if ('bytes' in item && typeof item.bytes !== 'number') {
      fail(
        `index.json's entry ${String(item.id)} has a non-numeric \`bytes\` (${typeof item.bytes}). A number is a size; a ` +
          'string in that field is a path, and the catalogue is fetched by every student in every lesson.',
      );
    }
  }
}

// ── 6. the registry loads back through the ONE resolution function every consumer shares ─────────
/**
 * `packages/sim-registry`'s own header gives the reason this is here: three consumers must agree on what `simId@2.1.0`
 * means, and a disagreement shows up as a student's exam grading against a different simulation than they sat.
 *
 * `pinned: true` because every stored state is pinned by definition, and `DISABLED` is resolvable for a pinned resource on
 * purpose — "disabling must not empty a live classroom". An unpinned `ACTIVE` resolution is also asserted so a registry
 * full of prereleases cannot pass: a draft is never served unpinned.
 */
let resolvedPinned = 0;
for (const entry of entries) {
  const resolution = registryModule.resolve(
    registryModule.buildRegistry([entry], '1970-01-01'),
    entry.id,
    entry.version,
    { pinned: true },
  );
  if (!resolution.ok) {
    fail(
      `${entry.id}@${entry.version} is in the registry but does not resolve for a PINNED resource: ${resolution.reason}. ` +
        'A pinned resource that cannot resolve is a student mid-exam with a stored state and no simulation.',
    );
  } else {
    resolvedPinned += 1;
  }
  const unpinned = registryModule.resolve(
    registryModule.buildRegistry([entry], '1970-01-01'),
    entry.id,
    null,
    { pinned: false },
  );
  if (!unpinned.ok && unpinned.reason !== 'DISABLED' && unpinned.reason !== 'UNKNOWN_SIM') {
    fail(`${entry.id}@${entry.version} does not resolve unpinned: ${unpinned.reason}`);
  }
}

report(entries.length, bundleFiles, resolvedPinned);

function report(entryCount, fileCount, resolved) {
  process.stdout.write('SIMULATION REGISTRY ARTEFACT GATE (INV-SIM-1, INV-SIM-2)\n');
  process.stdout.write(`  manifests on disk: ${String(manifestNames.length)}\n`);
  process.stdout.write(`  registry entries: ${String(entryCount)}\n`);
  process.stdout.write(`  bundle files resolved: ${String(fileCount)}\n`);
  process.stdout.write(`  entries resolvable when pinned: ${String(resolved)}\n`);
  process.stdout.write(`  digest: ${String(registry?.digest ?? '(no registry)')}\n`);

  if (failures.length > 0) {
    process.stdout.write(`\nFAILED — ${String(failures.length)} artefact problem(s):\n`);
    for (const failure of failures.slice(0, 25)) process.stdout.write(`  • ${failure}\n`);
    if (failures.length > 25)
      process.stdout.write(`  … and ${String(failures.length - 25)} more\n`);
    process.exit(1);
  }
  process.stdout.write('\nSIMULATION REGISTRY ARTEFACT GATE PASSED\n');
  process.exit(0);
}

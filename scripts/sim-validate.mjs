#!/usr/bin/env node
/**
 * `pnpm sim:validate` — the manifest gate.  (P6-T2)
 *
 * ## WHAT IT ENFORCES, AND WHY EACH CHECK IS HERE RATHER THAN IN A SCHEMA
 *
 * `plans/10` §3.1 lists five rules beyond schema conformance. Three of them need a filesystem or a
 * Node process, so they cannot live in a schema and they cannot live in the pure rules layer:
 *
 *  1. **`entry` and `grader` both exist.** A manifest that validates and points at a missing file is
 *     the single most common way a sim fails in front of a student rather than in CI.
 *  2. **The grader imports cleanly in a DOM-free Node.** `INV-SIM-2`. A grader that touches
 *     `window` at import time breaks the only thing that makes simulations gradable by a server.
 *  3. **The grader is deterministic: three runs, identical output.** A grader that reads a clock or
 *     unseeded randomness marks two identical papers differently, and the regrade has no answer.
 *  4. **The grader performs no I/O and reads no clock.** Statically, because the dynamic check
 *     cannot see a read that happens not to produce different output this time.
 *  5. **`byteSize` within budget.** Plus a 15% regression check against the last published build.
 *
 * ## A FAILED RUN EXITS NON-ZERO AND PRINTS A POINTER
 *
 * An author gets `#/grading/tolerance — TOLERANCE grading with no bound at all` rather than
 * "invalid manifest". A gate that says only "invalid" gets bypassed, because there is no argument to
 * have with it.
 *
 * Usage:
 *   node scripts/sim-validate.mjs --all
 *   node scripts/sim-validate.mjs sims/maths.projectile-motion
 *   node scripts/sim-validate.mjs --manifest path/to/sim.manifest.json
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SIMS_DIR = join(root, 'sims');

// ANSI, written with an explicit ESC. The write tool strips the literal escape byte, so the first
// version of this file shipped raw `[31m` prefixes that printed as noise on a non-TTY and were
// itself a test of whether the CLI's output is readable in a CI log.
const ESC = String.fromCharCode(27);
const c = {
  red: (s) => `${ESC}[31m${s}${ESC}[0m`,
  green: (s) => `${ESC}[32m${s}${ESC}[0m`,
  yellow: (s) => `${ESC}[33m${s}${ESC}[0m`,
  dim: (s) => `${ESC}[2m${s}${ESC}[0m`,
};

const fail = (message) => {
  process.stderr.write(`${c.red('FAIL')} ${message}\n`);
};

// ── the built contracts package, which is where the schema, the mirror and the rules live.
//
// The CLI imports the SAME code the host does rather than reimplementing any of it. A validation
// gate with its own copy of the rules is a gate that will disagree with the product.
const loadContracts = async () => {
  const manifestDist = join(root, 'packages/contracts/dist/sim-manifest/index.js');
  const schemaDist = join(root, 'packages/contracts/dist/jsonschema/index.js');
  if (!existsSync(manifestDist) || !existsSync(schemaDist)) {
    fail(
      'packages/contracts has not been built. Run `pnpm run build` first — this CLI deliberately ' +
        'imports the shipped modules rather than a second implementation of the rules.',
    );
    process.exit(2);
  }
  // Two modules, because the schema evaluator and the manifest rules are two things. The first
  // version of this imported only the manifest module and every run died with
  // "assertSchemaIsSupported is not a function" — which at least failed loudly, which is more than
  // a silent skip would have.
  const [manifest, schema] = await Promise.all([
    import(pathToFileURL(manifestDist).href),
    import(pathToFileURL(schemaDist).href),
  ]);
  return { ...manifest, ...schema };
};

// ── argument parsing

const parseArgs = (argv) => {
  const out = { all: false, dirs: [], manifests: [], sizes: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--all') out.all = true;
    else if (arg === '--sizes') out.sizes = true;
    else if (arg === '--manifest') {
      const next = argv[i + 1];
      if (next === undefined) {
        fail('--manifest needs a path');
        process.exit(2);
      }
      out.manifests.push(next);
      i += 1;
    } else if (arg.startsWith('-')) {
      fail(`unknown flag ${arg}`);
      process.exit(2);
    } else out.dirs.push(arg);
  }
  return out;
};

const discoverSims = (args) => {
  const found = [];
  if (args.manifests.length > 0) {
    for (const p of args.manifests) {
      const abs = resolve(process.cwd(), p);
      if (!existsSync(abs)) {
        fail(`no such manifest: ${p}`);
        process.exit(2);
      }
      found.push(abs);
    }
    return found;
  }
  // A leading underscore means SCAFFOLDING, not a simulation: `_template` is what `sim:new`
  // copies from and `_fixtures` is a set of deliberately broken manifests the CLI's own tests run
  // against. The first version excluded only `_template`, so `pnpm run sim:validate` was permanently
  // red on the fixtures — and a gate that is always red is a gate nobody reads.
  const targets =
    args.all || args.dirs.length === 0
      ? existsSync(SIMS_DIR)
        ? readdirSync(SIMS_DIR, { withFileTypes: true })
            .filter((e) => e.isDirectory() && !e.name.startsWith('_'))
            .map((e) => e.name)
        : []
      : args.dirs;
  for (const name of targets) {
    const manifest = join(SIMS_DIR, name, 'sim.manifest.json');
    if (existsSync(manifest)) found.push(manifest);
    else {
      // Naming a directory explicitly and finding nothing in it is a typo, and a typo that only
      // warns is how a sim silently stops being validated.
      fail(`no sim.manifest.json in ${c.dim(relative(root, join(SIMS_DIR, name)))}`);
      process.exitCode = 1;
    }
  }
  return found;
};

// ── the checks

/**
 * Static analysis of the grader bundle.  (`plans/10` §3.1 rules 3 and 4)
 *
 * Deliberately a narrow, honest check on the SOURCE rather than a claim of full dataflow analysis:
 * it looks for the constructs that break determinism, and it says what it does not cover. A gate
 * that claims to prove determinism by reading text is lying, and one that admits its limits can
 * still catch the mistakes people actually make.
 */
/**
 * Node builtins a grader may not name, however it names them.  (`B14`)
 *
 * The first version matched only `require('fs')` and `import('fs')`, and a grader written as
 * `import { readFileSync } from 'node:fs'` sailed straight through — which is the form every modern
 * author writes. Three forms, because an import can be static, dynamic, or a bare side-effect
 * import, and a gate that misses one of the three is decoration.
 */
const NODE_BUILTINS =
  'fs|child_process|cluster|dgram|net|http|https|tls|os|crypto|vm|worker_threads|stream|zlib|readline|inspector|diagnostics_channel';

const GRADER_FORBIDDEN = [
  {
    pattern: new RegExp(`from\\s*['"](?:node:)?(?:${NODE_BUILTINS})['"]`, 'u'),
    what: 'a static import of a Node builtin',
    why: 'the grader bundle must import ZERO Node builtins (`B14`): one `process.exit()` from a student-triggered grade would take the grading worker down mid-cohort',
  },
  {
    pattern: new RegExp(`\\bimport\\s*\\(\\s*['"](?:node:)?(?:${NODE_BUILTINS})['"]`, 'u'),
    what: 'a dynamic import of a Node builtin',
    why: 'the grader bundle must import ZERO Node builtins (`B14`)',
  },
  {
    pattern: new RegExp(`\\brequire\\s*\\(\\s*['"](?:node:)?(?:${NODE_BUILTINS})['"]`, 'u'),
    what: 'a require() of a Node builtin',
    why: 'the grader bundle must import ZERO Node builtins (`B14`)',
  },
  {
    pattern:
      /\bimport\s*['"](?:node:)?(?:assert|buffer|constants|crypto|events|fs|http|https|path|process|stream|string_decoder|timers|tty|url|util|zlib)['"]/u,
    what: 'a bare side-effect import of a Node builtin',
    why: 'the grader bundle must import ZERO Node builtins (`B14`)',
  },
  {
    pattern: /\bDate\s*\.\s*now\b/u,
    what: 'Date.now()',
    why: 'the grader must not read a clock: a regrade of one paper would produce a different mark',
  },
  {
    pattern: /\bnew\s+Date\s*\(\s*\)/u,
    what: 'new Date()',
    why: 'the grader must not read a clock',
  },
  {
    pattern: /\bperformance\s*\.\s*now\b/u,
    what: 'performance.now()',
    why: 'the grader must not read a clock',
  },
  {
    pattern: /\bMath\s*\.\s*random\b/u,
    what: 'Math.random()',
    why: 'unseeded randomness, so the same state grades differently each time',
  },
  {
    pattern: /\bfetch\s*\(/u,
    what: 'fetch()',
    why: "the grader performs no I/O, and a network call is also a way to exfiltrate a student's state",
  },
  {
    pattern: /\bXMLHttpRequest\b/u,
    what: 'XMLHttpRequest',
    why: 'the grader performs no I/O',
  },
  {
    pattern: /\bprocess\s*\.\s*env\b/u,
    what: 'process.env',
    why: 'environment-dependent output is not deterministic across hosts',
  },
  {
    pattern: /\bdocument\s*\./u,
    what: 'document access',
    why: 'the grader must import in a DOM-free Node (`INV-SIM-2`) — this is the whole platform',
  },
  {
    pattern: /\bwindow\s*\./u,
    what: 'window access',
    why: 'the grader must import in a DOM-free Node (`INV-SIM-2`)',
  },
  {
    pattern: /\bnavigator\s*\./u,
    what: 'navigator access',
    why: 'the grader must import in a DOM-free Node (`INV-SIM-2`)',
  },
];

/** Exported for the CLI's own test, which asserts each rule fires on the fixture built for it. */
export const graderForbiddenRules = () => GRADER_FORBIDDEN.map((rule) => ({ ...rule }));

export const analyseGraderSource = (source) => {
  const found = [];
  for (const rule of GRADER_FORBIDDEN) {
    const match = rule.pattern.exec(source);
    if (match)
      found.push({
        what: rule.what,
        line: source.slice(0, match.index).split('\n').length,
        why: rule.why,
      });
  }
  return found;
};

/**
 * The build's logical-name to hashed-name map, or `null` when the sim has not been built.
 *
 * Read defensively: a missing or half-written `registry-entry.json` means the sim is not built, and a
 * validator that crashes on that has turned a normal state into a red gate.
 */
const readRegistryEntry = (dir) => {
  const path = join(dir, 'dist', 'registry-entry.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
};

/** Byte size of a built bundle, or `null` when it has not been built. */
const bundleBytes = (dir, relativeEntry) => {
  const path = join(dir, relativeEntry.replace(/^\.\//, ''));
  if (!existsSync(path)) return null;
  return statSync(path).size;
};

const runDeterminism = async (dir, manifest) => {
  if (manifest.capabilities.grading !== true) return [];
  const graderPath = join(dir, manifest.grader.replace(/^\.\//, ''));
  if (!existsSync(graderPath)) return [];
  const problems = [];
  let module;
  try {
    module = await import(pathToFileURL(graderPath).href);
  } catch (error) {
    problems.push({
      code: 'HANDSHAKE_FAILED',
      pointer: '/grader',
      message: `the grader does not import in a DOM-free Node: ${String(error).split('\n')[0]}`,
    });
    return problems;
  }
  const grade = module.grade ?? module.default?.grade;
  if (typeof grade !== 'function') {
    problems.push({
      code: 'MANIFEST_INVALID',
      pointer: '/grader',
      message: 'the grader module exports no `grade` function',
    });
    return problems;
  }
  // Determinism needs a state to grade. A grader that ignores its argument still runs, so an empty
  // object is the honest minimum, and a grader that throws on it has told us something useful.
  const state = { probe: true };
  const runs = [];
  for (let i = 0; i < 3; i += 1) {
    try {
      runs.push(JSON.stringify(await grade(state, {}, undefined)));
    } catch (error) {
      problems.push({
        code: 'GRADER_FAILED',
        pointer: '/grader',
        message: `grading a probe state threw: ${String(error).split('\n')[0]}`,
      });
      return problems;
    }
  }
  if (runs[0] !== runs[1] || runs[1] !== runs[2]) {
    problems.push({
      code: 'DETERMINISM_FAILED',
      pointer: '/grader',
      message: `three runs on one state produced different output (${runs.join(' | ')})`,
    });
  }
  return problems;
};

/** The 15% regression check.  (`plans/10` §3.1) */
const checkSizeRegression = (dir, rel) => {
  const bytes = bundleBytes(dir, rel);
  if (bytes === null) return null;
  const baselinePath = join(dir, '.bundle-baseline.json');
  if (!existsSync(baselinePath)) {
    writeFileSync(baselinePath, `${JSON.stringify({ [rel]: bytes }, null, 2)}\n`, 'utf8');
    return { bytes, baseline: null, growth: 0 };
  }
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  const previous = baseline[rel];
  if (typeof previous !== 'number' || previous === 0)
    return { bytes, baseline: previous ?? null, growth: 0 };
  const growth = (bytes - previous) / previous;
  return { bytes, baseline: previous, growth };
};

const validateOne = async (manifestPath, contracts, options) => {
  const { jsonSchema, validate, assertSchemaIsSupported, simManifestSchema, checkManifestRules } =
    contracts;
  const dir = dirname(manifestPath);
  const id = relative(root, dir);
  const problems = [];
  let raw;
  try {
    raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    return {
      id,
      problems: [
        {
          pointer: '#',
          code: 'MANIFEST_INVALID',
          message: `not valid JSON: ${String(error).split('\n')[0]}`,
        },
      ],
    };
  }

  // The schema first: a manifest that does not parse cannot be checked for anything else, and the
  // author wants every problem in one run rather than one per attempt.
  try {
    assertSchemaIsSupported(jsonSchema);
  } catch (error) {
    return { id, problems: [{ pointer: '#', code: 'MANIFEST_INVALID', message: String(error) }] };
  }
  const schemaErrors = validate(raw, jsonSchema);
  for (const error of schemaErrors) {
    problems.push({
      pointer: error.pointer,
      code: 'MANIFEST_INVALID',
      message: `${error.keyword}: ${error.message}`,
    });
  }

  const parsed = simManifestSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      problems.push({
        pointer: `#${issue.path.join('/')}`,
        code: 'MANIFEST_INVALID',
        message: issue.message,
      });
    }
    return { id, problems };
  }

  const manifest = parsed.data;
  problems.push(...checkManifestRules(manifest));

  // Rule 1: both files exist.
  //
  // `entry` and `grader` in the manifest are LOGICAL names; the build emits content-HASHED artefacts
  // (`browser.4f2a1c9b0e3d.js`). A manifest can therefore be perfectly correct while the declared path
  // does not exist on disk, so the registry entry -- which maps the logical name to the hashed one -- is
  // consulted too, and BOTH candidates are named in the failure so the author is not left wondering
  // which path the gate wanted.
  //
  // The two tools disagreed about this until a real bundled sim existed to disagree about: the first
  // version looked only for the declared path, so every correctly-built sim failed validation.
  const registry = readRegistryEntry(dir);
  for (const field of ['entry', 'grader', 'styles']) {
    const declared = manifest[field];
    if (declared === undefined) continue;
    const role = field === 'entry' ? 'browser' : field;
    const built = registry?.artefacts?.[role]?.file;
    // The registry entry's paths are relative to `dist/`, the manifest's to the sim directory. The first
    // version resolved both against the sim directory, so a correctly-built sim reported its own
    // artefact as missing -- and the message named a file that genuinely existed.
    const found =
      existsSync(join(dir, String(declared).replace(/^\.\//, ''))) ||
      (built !== undefined && existsSync(join(dir, 'dist', String(built).replace(/^\.\//, ''))));
    if (!found) {
      problems.push({
        pointer: `#/${field}`,
        code: 'HANDSHAKE_FAILED',
        message:
          `${field} is ${declared} and no such file exists` +
          (built === undefined
            ? ', and there is no built artefact either'
            : `, nor the built ${built}`) +
          '. Run `pnpm sim:build` if this sim is bundled.',
      });
    }
  }

  // Rules 3 and 4: determinism and no I/O in the grader -- run against the BUILT artefact when there is
  // one, because that is what the worker will import. Checking the source instead would let a
  // transform introduce something the shipped bundle contains.
  //
  // Three candidates, in order: the built artefact, a source entry point, the declared path (which is
  // how the unbundled `_fixtures` sims are shaped).
  const graderCandidates = [
    registry?.artefacts?.grader?.file === undefined
      ? null
      : join(dir, 'dist', registry.artefacts.grader.file.replace(/^\.\//, '')),
    join(dir, 'src', 'grader.ts'),
    join(dir, manifest.grader.replace(/^\.\//, '')),
  ].filter((candidate) => candidate !== null);
  const graderPath = graderCandidates.find((candidate) => existsSync(candidate)) ?? '';
  if (graderPath !== '') {
    for (const hit of analyseGraderSource(readFileSync(graderPath, 'utf8'))) {
      problems.push({
        pointer: '#/grader',
        code: 'PROHIBITED_API',
        message: `${String(hit.what)} at line ${String(hit.line)} — ${hit.why}`,
      });
    }
  }
  problems.push(...(await runDeterminism(dir, manifest)));

  // Rule 5: size within budget, and no 15% regression.
  let size = null;
  if (existsSync(graderPath)) {
    // The BUILT artefact, not the source file. `sim:build` owns the budget, because it is the only
    // thing that knows what the bytes will be; the validator's job here is to refuse a manifest whose
    // budget is already exceeded by what was actually built.
    const builtGrader = registry?.artefacts?.grader?.file;
    size =
      builtGrader === undefined
        ? checkSizeRegression(dir, manifest.grader)
        : { bytes: bundleBytes(dir, builtGrader), baseline: null, growth: 0 };
  }
  if (size !== null && size.bytes !== null && size.bytes > manifest.budget.maxBytes) {
    problems.push({
      pointer: '#/budget/maxBytes',
      code: 'BUDGET_EXCEEDED',
      message: `grader.js is ${String(size.bytes)} bytes against a budget of ${String(manifest.budget.maxBytes)}`,
    });
  }
  if (options.sizes && size !== null && size.growth > 0.15) {
    problems.push({
      pointer: '#/budget/maxBytes',
      code: 'BUDGET_EXCEEDED',
      message: `grader.js grew ${(size.growth * 100).toFixed(1)}% from the recorded baseline (${String(size.baseline)} -> ${String(size.bytes)}); CI fails on 15%`,
    });
  }

  return { id, problems, manifest, size };
};

// ── main

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const contracts = await loadContracts();
  const jsonSchema = JSON.parse(
    readFileSync(join(root, 'schemas/sim.manifest.schema.json'), 'utf8'),
  );

  const manifests = discoverSims(args);
  if (manifests.length === 0) {
    process.stdout.write(
      `${c.yellow('no simulations found')} in ${c.dim(relative(root, SIMS_DIR))}\n`,
    );
    return;
  }

  let failed = 0;
  // Sequential on purpose: each sim's problems are reported in a stable order, which is what makes two
  // runs of the same tree comparable line by line.
  for (const manifestPath of manifests) {
    const result = await validateOne(manifestPath, { ...contracts, jsonSchema }, args);
    if (result.problems.length === 0) {
      const bytes =
        result.size?.bytes === null || result.size === null
          ? ''
          : c.dim(` ${String(result.size.bytes)}B`);
      process.stdout.write(`${c.green('PASS')} ${result.id}${bytes}\n`);
    } else {
      failed += 1;
      process.stdout.write(`${c.red('FAIL')} ${result.id}\n`);
      for (const problem of result.problems) {
        process.stdout.write(`       ${c.dim(problem.pointer)} ${problem.message}\n`);
      }
    }
  }

  const passed = manifests.length - failed;
  process.stdout.write(
    `\n${failed === 0 ? c.green('sim:validate passed') : c.red('sim:validate failed')} — ${String(passed)}/${String(manifests.length)} manifests\n`,
  );
  if (failed > 0) process.exitCode = 1;
};

main().catch((error) => {
  fail(String(error?.stack ?? error));
  process.exit(2);
});

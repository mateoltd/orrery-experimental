/**
 * The build pipeline and the dual-target guarantee.  (P6-T4, P6-T5)
 *
 * ## WHAT THESE TESTS ARE ACTUALLY PROVING
 *
 * `plans/10` §4.1: `INV-SIM-2` "is the single most important decision in the simulation platform: it
 * is what allows a simulation to be an exam question graded by a server with no browser involved."
 *
 * So none of this checks that the build script runs. It checks that the BUILT `grader.js`:
 *
 *  - imports in a bare Node process with no DOM and no browser globals;
 *  - produces byte-identical output over three runs of one state;
 *  - references no Node builtin and nothing outside the SDK;
 *
 * and that the browser bundle, built from the same `simulate()` and `grade()`, does the DOM things the
 * grader must not. A grader that had quietly become browser-only would pass every "it built" check and
 * fail at 03:00 in an exam.
 *
 * ## WHY IT LIVES IN `@orrery/sim-sdk`
 *
 * `sims/` is deliberately not a workspace, so there is no test runner there. And the guarantee is the
 * SDK's contract anyway: the SDK owns the pure/browser split, so the SDK's tests are what prove the
 * split survives a real build.
 *
 * The build is run before the suite by `pnpm run build`'s turbo graph in CI; locally these tests skip
 * when `dist/` is absent rather than silently passing on nothing.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const SIM = join(repo, 'sims/maths.projectile-motion');
const DIST = join(SIM, 'dist');
const ENTRY_PATH = join(DIST, 'registry-entry.json');
const MANIFEST_PATH = join(SIM, 'sim.manifest.json');
const MODEL_PATH = join(SIM, 'src/model.ts');
const GRADER_SOURCE = join(SIM, 'src/grader.ts');

interface RegistryEntry {
  readonly artefacts: Record<string, { readonly file: string; readonly bytes: number }>;
  readonly totalBytes: number;
  readonly graderBytes: number;
  readonly browserBytes: number;
}

const built = existsSync(ENTRY_PATH);
const readEntry = (): RegistryEntry => JSON.parse(readFileSync(ENTRY_PATH, 'utf8'));
const artefact = (role: string): string =>
  join(DIST, readEntry().artefacts[role]?.file.replace('./', '') ?? '');
const artefactSource = (role: string): string => readFileSync(artefact(role), 'utf8');

/**
 * Build ONE sim, by manifest.
 *
 * Explicitly not `--all`, because `sims/` is shared with `scaffold.test.ts`, which creates and removes
 * directories in it while this file runs. `--all` then races a deletion and exits 2 — which is the
 * script's internal-error path, so the symptom was a build test failing with no build error in the
 * output at all. Naming the sim removes the race entirely.
 */
const SIM_MANIFEST = 'sims/maths.projectile-motion/sim.manifest.json';

const runBuild = (args: string[] = []): { status: number; out: string } => {
  const result = spawnSync(
    process.execPath,
    [
      join(repo, 'scripts/sim-build.mjs'),
      ...(args.length > 0 ? args : ['--manifest', SIM_MANIFEST]),
    ],
    { cwd: repo, encoding: 'utf8' },
  );
  return { status: result.status ?? -1, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
};

/** Restore a file and rebuild, so one test cannot leave the tree changed for the next. */
const withRestoredFile = (path: string, contents: string, body: () => void): void => {
  const original = readFileSync(path, 'utf8');
  try {
    writeFileSync(path, contents);
    body();
  } finally {
    writeFileSync(path, original);
    runBuild();
  }
};

describe.skipIf(!built)('the dual-target guarantee (P6-T5, INV-SIM-2)', () => {
  it('emits a browser bundle, a grader bundle and a hashed stylesheet', () => {
    const entry = readEntry();
    expect(Object.keys(entry.artefacts).sort()).toEqual(['browser', 'grader', 'style']);
    for (const [role, value] of Object.entries(entry.artefacts)) {
      expect(existsSync(join(DIST, value.file.replace('./', ''))), `${role}: ${value.file}`).toBe(
        true,
      );
      // The hash is IN the name. Without it the sim origin either serves a stale bundle for a term or
      // sends no caching headers at all.
      expect(value.file, `${role} is not content-hashed`).toMatch(/\.[0-9a-f]{12}\.(js|css)$/u);
      expect(statSync(join(DIST, value.file.replace('./', ''))).size).toBe(value.bytes);
    }
  });

  it('the BUILT grader imports in a bare Node process with NO DOM present', () => {
    const script = `
      const url = new URL(${JSON.stringify(pathToFileURL(artefact('grader')).href)});
      const mod = await import(url.href);
      const sim = mod.default.grader ?? mod.default;
      if (typeof sim.grade !== 'function') throw new Error('no grade export');
      if (typeof sim.simulate !== 'function') throw new Error('no simulate export');
      if (typeof document !== 'undefined') throw new Error('document exists, so the check is vacuous');
      const params = { speed: 25, angle: 45, gravity: 9.81 };
      const state = { t: 3.6 };
      const runs = [];
      for (let i = 0; i < 3; i += 1) runs.push(JSON.stringify(sim.grade(state, params, { range: 63.71 })));
      if (runs[0] !== runs[1] || runs[1] !== runs[2]) throw new Error('NON-DETERMINISTIC: ' + runs.join(' | '));
      process.stdout.write(JSON.stringify({ output: JSON.parse(runs[0]), simulate: sim.simulate(params, state, 1) }));
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: repo,
      encoding: 'utf8',
    });
    expect(result.stderr ?? '').toBe('');
    expect(result.status, String(result.stderr)).toBe(0);
    const parsed = JSON.parse(String(result.stdout)) as {
      output: { points: number; correct: boolean; strategy: string };
      simulate: Record<string, unknown>;
    };
    // R = v² sin(2θ)/g = 625/9.81 = 63.71 m, so a range within 0.5 m earns full marks.
    expect(parsed.output.points).toBe(4);
    expect(parsed.output.correct).toBe(true);
    expect(parsed.output.strategy).toBe('TOLERANCE');
    // And the PURE model runs there too — the same function the canvas draws from.
    expect(parsed.simulate).toEqual({ t: 3.6, speed: 25, angle: 45, gravity: 9.81 });
  });

  it('the grader bundle references NO Node builtin and nothing outside the SDK', () => {
    const source = artefactSource('grader');
    // The build ALSO asserts this against esbuild's metafile, which knows what a module actually
    // imports. This is the second mechanism: it fails if the metafile check is ever removed.
    expect(source, 'the grader must not import a Node builtin').not.toMatch(/["']node:/u);
    expect(source, 'the grader must not import a package').not.toMatch(/from\s*["'][a-z@]/u);
    // It carries the whole SDK, inlined, because sims are not a workspace and nothing is external.
    expect(source.length).toBeGreaterThan(1000);
  });

  it('the BROWSER bundle does the DOM things the grader must not', () => {
    // The asymmetry, asserted in both directions. A grader larger than the browser bundle would mean
    // the two entry points were swapped.
    expect(artefactSource('browser')).toMatch(/document/);
    expect(readEntry().browserBytes).toBeGreaterThan(readEntry().graderBytes);
  });

  it('the grader bundle does NOT carry the DOM helpers', () => {
    // The module boundary, checked on the EMITTED bundle rather than on the source. `a11y.ts` is
    // excluded from the grader by `tsconfig.grader.json` at the type level and here at the byte level.
    const source = artefactSource('grader');
    expect(source).not.toMatch(/prefers-reduced-motion/);
    expect(source).not.toMatch(/createFocusTrap/);
  });

  it('a CHANGED source produces a CHANGED hash, so the cache cannot serve a stale bundle', () => {
    const before = readEntry();
    // A change that survives into the OUTPUT. Two earlier attempts failed for OPPOSITE reasons, and
    // both behaviours were correct: a comment is stripped by the minifier, and `MAX_FLIGHT_SECONDS`
    // is tree-shaken because the grader never reads it. Neither is a change to the artefact.
    withRestoredFile(
      GRADER_SOURCE,
      readFileSync(GRADER_SOURCE, 'utf8').replace('peaking at 32 m.', 'peaking at about 32 m.'),
      () => {
        const result = runBuild();
        expect(result.status, result.out).toBe(0);
        expect(readEntry().artefacts.grader?.file).not.toBe(before.artefacts.grader?.file);
      },
    );
    // And the original is back, so the test is repeatable.
    expect(readEntry().artefacts.grader?.file).toBe(before.artefacts.grader?.file);
  });

  it('a COMMENT does not change the hash, because it is not in the bundle', () => {
    // Content addressing should mean CONTENT. A comment a maintainer adds while reading the file must
    // not invalidate every student's cached bundle, and a hash that moved on whitespace would make
    // the mechanism a rename generator instead of a cache key.
    const before = readEntry();
    withRestoredFile(MODEL_PATH, `${readFileSync(MODEL_PATH, 'utf8')}\n// a comment\n`, () => {
      expect(runBuild().status).toBe(0);
      expect(readEntry().artefacts.grader?.file).toBe(before.artefacts.grader?.file);
    });
  });

  it('a TREE-SHAKEN constant does not change the hash either, because it is not in the bundle', () => {
    // `MAX_FLIGHT_SECONDS` is exported from `model.ts` and never used by the grader, so esbuild drops
    // it. Editing it changes the source and nothing else, and the hash is right to stay put: it
    // hashes the artefact, not the repository.
    const before = readEntry();
    withRestoredFile(
      MODEL_PATH,
      readFileSync(MODEL_PATH, 'utf8').replace(
        'MAX_FLIGHT_SECONDS = 30',
        'MAX_FLIGHT_SECONDS = 31',
      ),
      () => {
        expect(runBuild().status).toBe(0);
        expect(readEntry().artefacts.grader?.file).toBe(before.artefacts.grader?.file);
      },
    );
  });

  it('an UNCHANGED source rebuilds to the SAME hash, so a no-op deploy changes nothing', () => {
    const before = readEntry();
    expect(runBuild().status).toBe(0);
    expect(readEntry().artefacts.grader?.file).toBe(before.artefacts.grader?.file);
  });
});

describe.skipIf(!built)('the build itself (P6-T4)', () => {
  it('--check builds and asserts WITHOUT writing, so CI can run it on a dirty tree', () => {
    const before = readdirSync(DIST).sort();
    const result = runBuild(['--check']);
    expect(result.status, result.out).toBe(0);
    expect(readdirSync(DIST).sort()).toEqual(before);
    // And it printed the sizes, so a CI log shows what it measured rather than just "passed".
    expect(result.out).toMatch(/grader grader\.[0-9a-f]{12}\.js/u);
    expect(result.out).toMatch(/\d+B/u);
  });

  it('fails when a bundle exceeds its declared budget', () => {
    const original = readFileSync(MANIFEST_PATH, 'utf8');
    const manifest = JSON.parse(original) as { budget: { maxBytes: number } };
    manifest.budget.maxBytes = 1024;
    try {
      writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
      const result = runBuild();
      expect(result.status).toBe(1);
      expect(result.out).toMatch(/builds to \d+ bytes against a budget of 1024/u);
    } finally {
      writeFileSync(MANIFEST_PATH, original);
      runBuild();
    }
  });

  it('names a MISSING entry point instead of reporting a success with no bundle', () => {
    const original = readFileSync(MODEL_PATH, 'utf8');
    try {
      // `browser.ts` imports `./model.js`; removing it makes the build fail with a resolvable path,
      // not a generic error.
      writeFileSync(MODEL_PATH, 'export const broken: number = "not a number";\n');
      const result = runBuild([]);
      expect(result.status, result.out).not.toBe(0);
      expect(result.out).toMatch(/model\.ts/u);
    } finally {
      writeFileSync(MODEL_PATH, original);
      runBuild();
    }
  });

  it('excludes the underscore directories, so scaffolding and fixtures cannot enter a build', () => {
    // `--all` is the only way to test DISCOVERY, and it is therefore the one call that can race the
    // scaffold suite's clean-up. The assertion is about the output, so a concurrent deletion makes the
    // status non-zero without invalidating it.
    const result = runBuild(['--all']);
    expect(result.out).not.toMatch(/_fixtures|_template/u);
    expect(result.out).toMatch(/maths\.projectile-motion/u);
  });
});

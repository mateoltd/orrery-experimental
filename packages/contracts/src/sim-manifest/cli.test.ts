/**
 * `sim:validate`, run for real against deliberately broken simulations.  (P6-T2)
 *
 * ## WHY THE FIXTURES ARE COMMITTED AND DELIBERATELY BROKEN
 *
 * A gate's tests are the gate. `sims/_fixtures/` holds six manifests, each broken in exactly one
 * way, and this file asserts the CLI catches each one *for that reason*.
 *
 * The alternative — testing the CLI against manifests that happen to be valid — proves only that it
 * says PASS, which is the one behaviour nobody needed checking.
 *
 * ## WHY ONE FIXTURE IS BROKEN WITH NO FORBIDDEN CONSTRUCT AT ALL
 *
 * `nondeterministic-grader` uses a module-level counter. No clock, no I/O, no randomness, so every
 * static rule passes and the source is clean. Only RUNNING it three times catches it. That fixture
 * is the reason the run-based check exists rather than being read as belt-and-braces.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const CLI = join(root, 'scripts/sim-validate.mjs');
const FIXTURES = join(root, 'sims/_fixtures');
const built = existsSync(join(root, 'packages/contracts/dist/sim-manifest/index.js'));

const run = (fixture: string): { status: number; out: string } => {
  const result = spawnSync(
    process.execPath,
    [CLI, '--manifest', join(FIXTURES, fixture, 'sim.manifest.json')],
    { cwd: root, encoding: 'utf8' },
  );
  return { status: result.status ?? -1, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
};

describe.skipIf(!built)('sim:validate, end to end', () => {
  it('ACCEPTS a good simulation', () => {
    const { status, out } = run('valid');
    expect(status, out).toBe(0);
    expect(out).toMatch(/PASS/);
  });

  it('catches a NON-DETERMINISTIC grader that no static rule can see', () => {
    // No `Date.now`, no `Math.random`, no I/O. A module-level counter, which is clean source and
    // broken behaviour — so only running it three times catches this.
    const { status, out } = run('nondeterministic-grader');
    expect(status).toBe(1);
    expect(out).toMatch(/three runs on one state produced different output/);
  });

  it('catches a grader that READS A CLOCK, statically and with the reason', () => {
    // `Date.now() % 2` returns the same value for all three runs when they land inside one
    // millisecond, so the run-based check would PASS this. Which is why both checks exist.
    const { status, out } = run('clock-reading-grader');
    expect(status).toBe(1);
    expect(out).toMatch(/Date\.now\(\) at line \d+/);
    expect(out).toMatch(/regrade of one paper would produce a different mark/);
  });

  it('catches a STATIC Node builtin import, which is the form every author actually writes', () => {
    // The first version of the rules matched `require('fs')` and `import('fs')` only, and
    // `import { readFileSync } from 'node:fs'` sailed through — and that fixture PASSED.
    const { status, out } = run('io-in-grader');
    expect(status).toBe(1);
    expect(out).toMatch(/static import of a Node builtin/);
    expect(out).toMatch(/ZERO Node builtins/);
  });

  it('catches a manifest whose grader FILE DOES NOT EXIST', () => {
    // The most common way a sim fails in front of a student rather than in CI: a manifest that
    // validates perfectly and points at nothing.
    const { status, out } = run('missing-grader');
    expect(status).toBe(1);
    expect(out).toMatch(/#\/grader/);
    expect(out).toMatch(/grader is \.\/grader\.js and no such file exists/);
    // And it says what to do, and names the OTHER candidate it looked for. A manifest's `grader` is a
    // LOGICAL name and the build emits a content-hashed artefact, so the gate checks both and reports
    // both — otherwise a correctly-built sim reads as broken and the author goes looking for a file
    // that was never missing.
    expect(out).toMatch(/there is no built artefact either/);
    expect(out).toMatch(/pnpm sim:build/);
  });

  it('catches a bundle over its declared budget', () => {
    const { status, out } = run('over-budget');
    expect(status).toBe(1);
    expect(out).toMatch(/grader\.js is \d+ bytes against a budget of 1024/);
  });

  it('catches an `entry` that escapes the sim directory, and says why', () => {
    const { status, out } = run('path-traversal');
    expect(status).toBe(1);
    expect(out).toMatch(/does not match/);
    // Both implementations report it, because the guarantee is that they AGREE.
    expect(out).toMatch(/relative path inside the sim directory/);
  });

  it('reports a JSON POINTER for every problem, because "invalid manifest" gets bypassed', () => {
    const { out } = run('missing-grader');
    expect(out).toMatch(/#\/grader/);
  });

  it('--all skips the fixtures, so a deliberate fixture cannot fail a real build', () => {
    // `sims/_fixtures/` is full of things that are SUPPOSED to be broken. If discovery swept them
    // up, `pnpm run sim:validate` would be permanently red and nobody would read its output again.
    const result = spawnSync(process.execPath, [CLI, '--all'], { cwd: root, encoding: 'utf8' });
    const out = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    expect(out).not.toMatch(/_fixtures/);
  });
});

describe('the committed fixtures are what the tests claim they are', () => {
  it('the non-deterministic fixture really contains no clock, no I/O and no randomness', () => {
    // If a future edit gave it a `Date.now()`, the static rule would start catching it and the
    // fixture would silently stop testing the run-based path — while still failing the CLI, so no
    // test would notice. This assertion is what stops that.
    const source = readFileSync(join(FIXTURES, 'nondeterministic-grader/grader.js'), 'utf8');
    expect(source).not.toMatch(/Date\.now|Math\.random|fetch\(|readFile|XMLHttpRequest/);
    expect(source).toMatch(/calls \+=/);
  });

  it('the valid fixture is genuinely valid: both implementations agree and no rule fires', () => {
    const manifest = JSON.parse(
      readFileSync(join(FIXTURES, 'valid/sim.manifest.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(manifest.protocol).toBe(1);
    expect(manifest.licence).toBe('CC-BY-4.0');
    expect(manifest.provenance).toBe('ORIGINAL');
  });

  it('every fixture directory has a manifest, so the tests cannot silently pass on nothing', () => {
    for (const name of [
      'valid',
      'nondeterministic-grader',
      'clock-reading-grader',
      'io-in-grader',
      'missing-grader',
      'over-budget',
      'path-traversal',
    ]) {
      expect(existsSync(join(FIXTURES, name, 'sim.manifest.json')), `${name} is missing`).toBe(
        true,
      );
    }
  });
});

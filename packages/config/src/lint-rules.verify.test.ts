/**
 * GATE VERIFICATION  (P0-T11, and plans/23-REVIEW-ACTIONS.md D-35)
 *
 * Every rule in `eslint.config.js` is theatre until something proves it fires. This test
 * runs ESLint programmatically against deliberately bad fixtures and asserts each rule
 * rejects them — and, just as importantly, asserts clean code is NOT rejected.
 *
 * The delivery review's sharpest criticism (D-35) was that "every gate in the plan is
 * local — a CI job that runs the gate is bypassable by editing the gate", and that a
 * skipped test appeared in the protocol's own model PR body. So: a rule that cannot fail
 * is deleted, and a rule whose only proof is "it's in the config file" is untested.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { afterAll, describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
// Inside the repo, because ESLint refuses to lint files outside its base path.
// `.tmp/` is gitignored, and eslint.config.js deliberately does not ignore it.
const scratch = join(root, '.tmp', 'lint-fixtures');
// Path-SCOPED rules need fixtures at the paths the rule is scoped to. This harness used to
// write every fixture to `.tmp/lint-fixtures/`, which is never `packages/*/src/**`, so the
// test named "rejects `import 'next'` inside a package" was actually asserting a GLOBAL ban
// and would have kept passing after the rule was correctly scoped to packages only.
//
// That is the failure this file exists to prevent: a test that looks like it covers a rule
// and covers something else instead. A probe package gives the harness a real path to lint.
//
// Named `zz-` so it sorts last, holds no package.json (so pnpm never treats it as a
// workspace package), and is removed in afterAll.
mkdirSync(scratch, { recursive: true });
const probe = join(root, 'packages', 'zz-lint-probe');
const probeSrc = join(probe, 'src');
const appSrc = join(root, 'apps', 'web', 'src', 'zz-lint-probe');
// The rule scopes the `next` ban to `packages/*` and `scripts/`, so a fixture that claims
// to test "outside the app" has to actually live in one of those. An earlier version of this
// test wrote to `.tmp/` — which is exempt by both globs — and therefore asserted a rule that
// did not exist. The test now names the path it means.
const scriptsSrc = join(root, 'scripts');
mkdirSync(probeSrc, { recursive: true });
mkdirSync(appSrc, { recursive: true });
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
  rmSync(probe, { recursive: true, force: true });
  rmSync(appSrc, { recursive: true, force: true });
  // Fixtures written into the real `scripts/` directory. Removing them is not tidiness: a
  // leftover `scripts/fixture-N.ts` is a stray source file that ESLint, tsc and git will all
  // try to treat as real. `pnpm lint` and `pnpm typecheck` must be unaffected by having run
  // the test suite.
  for (const f of written) rmSync(f, { force: true });
});

const eslint = new ESLint({ cwd: root, overrideConfigFile: join(root, 'eslint.config.js') });

let fixtureCount = 0;
/** Every fixture path written, so a test run cannot leave files in a real source directory. */
const written: string[] = [];

async function lint(code: string, dir: string = scratch) {
  // A UNIQUE path per call. Reusing one path risks ESLint serving a cached result, which
  // would let a dead rule look alive — the exact failure this test exists to prevent.
  const file = join(dir, `fixture-${fixtureCount++}.ts`);
  writeFileSync(file, code, 'utf8');
  written.push(file);
  const results = await eslint.lintFiles([file], { warnIgnored: false });
  return results.flatMap((r) => r.messages).map((m) => m.ruleId ?? m.message);
}

const fired = (rules: (string | null)[], rule: string) =>
  expect(rules, `expected rule ${rule} to fire, got: ${JSON.stringify(rules)}`).toContain(rule);

describe('INV-TIME-1 — no second clock', () => {
  it('rejects Date.now()', async () => {
    fired(await lint('export const a = Date.now();'), 'no-restricted-properties');
  });
  it('rejects performance.now()', async () => {
    fired(await lint('export const a = performance.now();'), 'no-restricted-properties');
  });
  it('rejects the Date constructor (via no-restricted-syntax, the mechanism that works)', async () => {
    fired(await lint('export const a = new Date().getTime();'), 'no-restricted-syntax');
  });
  it('ALLOWS the injected clock', async () => {
    const rules = await lint(
      `import { systemClock } from '@orrery/clock';\nexport const a = systemClock.now();`,
    );
    expect(rules).not.toContain('no-restricted-globals');
    expect(rules).not.toContain('no-restricted-properties');
  });
});

describe('INV-RNG-1 — no unseeded randomness', () => {
  it('rejects Math.random()', async () => {
    fired(await lint('export const a = Math.random();'), 'no-restricted-properties');
  });
  it('ALLOWS the seeded rng', async () => {
    const rules = await lint(
      `import { createRng } from '@orrery/rng';\nexport const a = createRng('s').next();`,
    );
    expect(rules).not.toContain('no-restricted-globals');
    expect(rules).not.toContain('no-restricted-properties');
  });
});

describe('ADR-0005 — packages stay framework-light', () => {
  it("rejects `import 'next'` inside a package", async () => {
    // Linted at a REAL packages/*/src path, so this asserts the scoped rule and not a
    // global one.
    fired(
      await lint("import x from 'next';\nexport default x;", probeSrc),
      'no-restricted-imports',
    );
  });

  it('ALLOWS `next/server` in the app, which is where it belongs', async () => {
    // Regression: the `next` ban was originally global and fired on apps/web/src/middleware.ts,
    // which is a legitimate framework import. An over-broad rule teaches agents to suppress
    // rather than fix (ADR-0027), so the scoping is now itself tested.
    const rules = await lint(
      "import { NextResponse } from 'next/server';\nexport const x = NextResponse;",
      appSrc,
    );
    expect(
      rules,
      `app must be allowed to import next, got: ${JSON.stringify(rules)}`,
    ).not.toContain('no-restricted-imports');
  });

  it('rejects `next` in scripts/ too — only the APP is exempt', async () => {
    // Guards against a future "fix" that narrows the ban back to packages only and lets a
    // build script start importing the framework.
    fired(
      await lint("import x from 'next/server';\nexport default x;", scriptsSrc),
      'no-restricted-imports',
    );
  });
  it('rejects importing Prisma outside packages/db', async () => {
    fired(
      await lint("import { PrismaClient } from '@prisma/client';\nexport const p = PrismaClient;"),
      'no-restricted-imports',
    );
  });
});

describe('ADR-0016 — no barrel files', () => {
  it('rejects a `**/index` subpath import', async () => {
    fired(await lint("import { x } from './index';\nexport const y = x;"), 'no-restricted-imports');
  });
});

describe('the gate is real, not theatre', () => {
  it('clean code produces no errors at all', async () => {
    const rules = await lint(
      `import { FrozenClock } from '@orrery/clock';
       import { createRng } from '@orrery/rng';
       export function f(seed: string) {
         const clock = new FrozenClock(0).advance(1000);
         return { t: clock.now(), v: createRng(seed).next() };
       }`,
    );
    expect(rules.filter((r) => r !== 'no-undef')).toEqual([]);
  });
});

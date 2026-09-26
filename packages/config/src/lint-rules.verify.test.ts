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
mkdirSync(scratch, { recursive: true });
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const eslint = new ESLint({ cwd: root, overrideConfigFile: join(root, 'eslint.config.js') });

async function lint(code: string, filename = 'packages/x/src/fixture.ts') {
  const file = join(scratch, 'fixture.ts');
  writeFileSync(file, code, 'utf8');
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
    fired(await lint("import x from 'next';\nexport default x;"), 'no-restricted-imports');
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

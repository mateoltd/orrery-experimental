/**
 * The scaffolder, and the template it copies.  (P6-T10)
 *
 * ## A SCAFFOLDER THAT DOES NOT SUBSTITUTE IS A TRAP
 *
 * Copying `SUBJECT.slug` into a directory and exiting looks like `sim:new` and is not: the author
 * finds out the `id` field was not substituted when `sim:validate` refuses it an hour later. So the
 * tests here assert the substitution happened in **every** file that mentions it — the manifest, both
 * `src/` entry points, the spec card and the test file — and that the scaffold is accepted by the
 * validator apart from the two complaints that are simply "this has not been built yet".
 *
 * ## THE TEMPLATE'S OWN INCONSISTENCY IS THE FINDING
 *
 * The first version of `_template/sim.manifest.json` declared `capabilities.grading: true` with no
 * `grading` block, so every scaffolded sim failed validation on the template's bug before the author
 * had typed anything. That is the failure mode a scaffolder exists to prevent, so the test asserts the
 * scaffold is CLEAN — not merely that files appeared.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const SIMS = join(repo, 'sims');
const TEMPLATE = join(SIMS, '_template');

const SIM_NEW = join(repo, 'scripts/sim-new.mjs');
const SIM_VALIDATE = join(repo, 'scripts/sim-validate.mjs');

const created: string[] = [];
const runNew = (args: string[]): { status: number; out: string } => {
  const result = spawnSync(process.execPath, [SIM_NEW, ...args], { cwd: repo, encoding: 'utf8' });
  return { status: result.status ?? -1, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
};
/**
 * Strip ANSI before matching. The validator colours its problem lines, and a filter written against
 * raw coloured output matches NOTHING — which is how `sim-new` reported a genuinely malformed scaffold
 * as clean until this was found.
 */
const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'gu');
const stripAnsi = (text: string): string => text.replace(ANSI_PATTERN, '');

const validate = (id: string): { status: number; out: string } => {
  const result = spawnSync(
    process.execPath,
    [SIM_VALIDATE, '--manifest', `sims/${id}/sim.manifest.json`],
    {
      cwd: repo,
      encoding: 'utf8',
    },
  );
  return { status: result.status ?? -1, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
};

afterEach(() => {
  for (const id of created.splice(0)) rmSync(join(SIMS, id), { recursive: true, force: true });
});

const scaffold = (id: string, extra: string[] = []): string => {
  const result = runNew([id, ...extra]);
  expect(result.status, result.out).toBe(0);
  created.push(id);
  return id;
};

describe('the sim:new scaffolder', () => {
  it('creates every file the pipeline expects', () => {
    scaffold('maths.titration-curve');
    for (const file of [
      'sim.manifest.json',
      'sim.spec.md',
      'style.css',
      'LICENCE',
      'src/model.ts',
      'src/grader.ts',
      'src/browser.ts',
      'src/controls.ts',
      'test/grader.test.ts',
    ]) {
      expect(existsSync(join(SIMS, 'maths.titration-curve', file)), file).toBe(true);
    }
  });

  it('substitutes the placeholders in EVERY file that mentions one', () => {
    // The whole reason `sim:new` exists rather than a paragraph describing the layout: an unsubstituted
    // `id` is found by `sim:validate` an hour later, not now.
    const dir = join(SIMS, 'maths.titration-curve');
    scaffold('maths.titration-curve');
    const offenders: string[] = [];
    const walk = (current: string): void => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const path = join(current, entry.name);
        if (entry.isDirectory()) {
          walk(path);
          continue;
        }
        const text = readFileSync(path, 'utf8');
        if (text.includes('SUBJECT')) offenders.push(path.slice(dir.length + 1));
      }
    };
    walk(dir);
    expect(offenders).toEqual([]);

    const manifest = JSON.parse(readFileSync(join(dir, 'sim.manifest.json'), 'utf8')) as {
      id: string;
      title: string;
      subjects: string[];
    };
    expect(manifest.id).toBe('maths.titration-curve');
    expect(manifest.title).toBe('Titration Curve');
    expect(manifest.subjects).toEqual(['maths']);
    // And in the code, where a wrong `meta.id` is a handshake failure rather than a typo.
    expect(readFileSync(join(dir, 'src/grader.ts'), 'utf8')).toContain(
      "id: 'maths.titration-curve'",
    );
    expect(readFileSync(join(dir, 'src/browser.ts'), 'utf8')).toContain(
      "id: 'maths.titration-curve'",
    );
    expect(readFileSync(join(dir, 'sim.spec.md'), 'utf8')).toContain('# maths.titration-curve');
  });

  it('the scaffold is CLEAN, apart from not having been built', () => {
    // The finding: the first template declared `grading: true` with no `grading` block, so every new
    // sim failed validation on the TEMPLATE's bug. A scaffolder that produces a broken tree is worse
    // than no scaffolder.
    scaffold('maths.titration-curve');
    const { status, out } = validate('maths.titration-curve');
    const problems = stripAnsi(out)
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^#?\//u.test(line));
    const real = problems.filter((line) => !/no such file exists/u.test(line));
    expect(real, `unexpected problems: ${real.join(' | ')}`).toEqual([]);
    // The only complaints are that the bundles have not been built, which is correct for a new sim —
    // and it is worth asserting that these two complaints ARE there, because a filter that matched
    // nothing would make every one of these assertions pass for the wrong reason.
    expect(problems.filter((line) => /no such file exists/u.test(line))).toHaveLength(2);
    expect(status).toBe(1);
  });

  it('honours --title and --author', () => {
    scaffold('chemistry.stoichiometry-balance', [
      '--title',
      'Balancing equations',
      '--author',
      'A. Chemist',
    ]);
    const manifest = JSON.parse(
      readFileSync(join(SIMS, 'chemistry.stoichiometry-balance/sim.manifest.json'), 'utf8'),
    ) as { title: string; authors: string[] };
    expect(manifest.title).toBe('Balancing equations');
    expect(manifest.authors).toEqual(['A. Chemist']);
  });

  it('counts the REPLACE: markers rather than listing them', () => {
    // Fifteen near-identical lines tell an author nothing about where to start. The card is where they
    // start, and the message says so.
    const { out } = runNew(['biology.cell-division']);
    created.push('biology.cell-division');
    expect(out).toMatch(/REPLACE: marker\(s\) left to fill/u);
    expect(out).toMatch(/sim\.spec\.md FIRST/u);
    // And it says what comes next, because a sim that has never been through conformance is not a sim.
    expect(out).toMatch(/sim:conformance/u);
  });

  it('REFUSES an id that can never be published, before writing anything', () => {
    // The subject must be one with a tree behind it (`gate:subjects`). A typo produces a directory that
    // can never be registered, and the cheapest place to catch that is before the files exist.
    for (const bad of [
      'maths.projectile_motion',
      'nonexistent.thing',
      'projectile-motion',
      'Maths.thing',
    ]) {
      const { status, out } = runNew([bad]);
      expect(status, bad).toBe(1);
      expect(out, bad).toMatch(/not subject\.slug|is not a subject/u);
      expect(existsSync(join(SIMS, bad)), bad).toBe(false);
    }
  });

  it('will not overwrite an existing sim without --force', () => {
    scaffold('maths.projectile-motion-2');
    const again = runNew(['maths.projectile-motion-2']);
    expect(again.status).toBe(1);
    expect(again.out).toMatch(/already exists/);
    // `--force` is deliberate and says so, because clobbering an authored sim is unrecoverable.
    expect(runNew(['maths.projectile-motion-2', '--force']).status).toBe(0);
    expect(statSync(join(SIMS, 'maths.projectile-motion-2/sim.manifest.json')).isFile()).toBe(true);
  });

  it('with no arguments it prints the usage and exits non-zero', () => {
    const { status, out } = runNew([]);
    expect(status).toBe(1);
    expect(out).toMatch(/usage: pnpm sim:new/u);
  });
});

describe('the template itself', () => {
  it('has a spec card with all TWELVE sections, because the card is the review artefact', () => {
    const card = readFileSync(join(TEMPLATE, 'sim.spec.md'), 'utf8');
    // `plans/10` §7. An agent can be handed this card and a template and produce a reviewable
    // simulation; that is what makes six parallel author lanes tractable.
    for (const heading of [
      '## 1. Subject, topic, level, age range',
      '## 2. Learning objective',
      '## 3. Interaction model',
      '## 4. Model',
      '## 5. Answer semantics',
      '## 6. Grading strategy',
      '## 7. Parameters and variants',
      '## 8. Misconceptions targeted',
      '## 9. Accessibility plan',
      '## 10. Fallback',
      '## 11. Licence and provenance',
      '## 12. Conformance script and expected grade',
    ]) {
      expect(card, `the card is missing "${heading}"`).toContain(heading);
    }
  });

  it('the card says the two things a review must not skip', () => {
    const card = readFileSync(join(TEMPLATE, 'sim.spec.md'), 'utf8');
    // "If we cannot write it, we do not build the sim" and "a sim targeting no misconception is a
    // toy" are the two sentences that stop a card from being a form.
    expect(card).toMatch(/we do not build the sim/u);
    expect(card).toMatch(/misconception is a toy/u);
    // And the invertible-generator rule, which is the one that quietly breaks reproducibility.
    expect(card).toMatch(/MUST be invertible/u);
  });

  it('the template grader imports the DOM-FREE half of the SDK', () => {
    // `@orrery/sim-sdk/grader`, not `@orrery/sim-sdk`. The barrel pulls in `a11y.ts`, so importing it
    // in a grader file is exactly the mistake `tsconfig.grader.json` exists to catch.
    const grader = readFileSync(join(TEMPLATE, 'src/grader.ts'), 'utf8');
    expect(grader).toContain("from '@orrery/sim-sdk/grader'");
    expect(grader).not.toMatch(/from '@orrery\/sim-sdk'/u);
  });

  it('the template browser imports the FULL half, because it is the only one that may', () => {
    expect(readFileSync(join(TEMPLATE, 'src/browser.ts'), 'utf8')).toContain(
      "from '@orrery/sim-sdk'",
    );
  });

  it('the template model is PURE: no DOM, no clock, no randomness', () => {
    const model = readFileSync(join(TEMPLATE, 'src/model.ts'), 'utf8');
    // Comments are stripped, because a model file is allowed to DISCUSS the clock while explaining why
    // it must not read it.
    const code = model.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/[^\n]*/gu, '');
    expect(code).not.toMatch(/\bdocument\b/u);
    expect(code).not.toMatch(/\bwindow\b/u);
    expect(code).not.toMatch(/Date\.now|Math\.random/u);
  });

  it('the template stylesheet is committed, so a new sim is never unstyled', () => {
    // The CSP finding (`B6`) made `default-src 'none'` block the sim's own stylesheet, and every
    // manifest declares `styles`. A template without one would make that failure look like a bug in
    // every sim at once.
    const manifest = JSON.parse(readFileSync(join(TEMPLATE, 'sim.manifest.json'), 'utf8')) as {
      styles?: string;
    };
    expect(manifest.styles).toBe('./style.css');
    expect(existsSync(join(TEMPLATE, 'style.css'))).toBe(true);
  });

  it('the template declares a grading strategy consistent with its capabilities', () => {
    const manifest = JSON.parse(readFileSync(join(TEMPLATE, 'sim.manifest.json'), 'utf8')) as {
      capabilities: { grading: boolean };
      grading?: { strategy: string; tolerance?: Record<string, number> };
    };
    // Both directions. The finding was `grading: true` with no block; the mirror is a block with
    // `grading: false`, which would mean the host never asks for an answer.
    expect(manifest.capabilities.grading).toBe(manifest.grading !== undefined);
    // And TOLERANCE with no bound is refused, so the template must carry one.
    expect(manifest.grading?.tolerance).toBeDefined();
  });

  it('the template declares a stepper with a range, or no stepper at all', () => {
    const manifest = JSON.parse(readFileSync(join(TEMPLATE, 'sim.manifest.json'), 'utf8')) as {
      capabilities: { stepper: boolean };
      lifecycle: { defaultHeight: number };
    };
    if (manifest.capabilities.stepper) expect(manifest.lifecycle.defaultHeight).toBeGreaterThan(0);
    expect(manifest.capabilities.stepper).toBe(false);
  });
});

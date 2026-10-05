/**
 * THE AXE HARNESS ITSELF, WHICH IS THE ONLY PART OF `P13-T1` THAT NEEDS TESTING.
 *
 * ## WHY THIS FILE EXISTS
 *
 * **`jest-axe` was declared in three `package.json` files and used nowhere.** An accessibility check that has never failed
 * is indistinguishable from one that cannot fail, and `P13-T1` was created because `ci.yml` called `pnpm a11y`, which did
 * not exist, so the `policy` job died before running anything.
 *
 * **So the first test here deliberately renders an image with no alt text and asserts that axe CATCHES IT.** A harness
 * proven only by clean runs is proven not at all — the same argument that made me require a positive control in
 * `audit-payloads`, and the one that made me flip `release.ts` to prove the freeze test could fail.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render } from '@testing-library/react';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { axeCheck } from './axe';

describe('THE HARNESS CATCHES A REAL VIOLATION, WHICH IS THE ONLY TEST THAT MATTERS HERE', () => {
  it('fails on an image with no alt text', async () => {
    /**
     * THE POSITIVE CONTROL. If this passes, the harness is not running, or `axe-core` is finding nothing, and every other
     * test in this file is reporting a green tick that means nothing.
     */
    const { container } = render(
      /**
       * `alt` DELIBERATELY ABSENT, and biome's OWN `useAltText` rule flags this line -- which is two independent checks
       * agreeing, and worth keeping in mind rather than working around.
       *
       * This is the most common image defect in the wild, and it is here because **the harness's job is to be shown
       * catching something.** A fixture that violates a lint rule on purpose needs the suppression to say WHY, or the
       * next reader either deletes the violation to make lint pass -- which silently disarms the positive control -- or
       * deletes the test and with it the only evidence the harness works.
       */
      // biome-ignore lint/a11y/useAltText: a deliberate violation; this test asserts axe catches it.
      <img src="/x.png" />,
    );
    const results = await axeCheck(container);
    const ids = results.violations.map((v) => v.id);
    expect(ids).toContain('image-alt');
    await expect(results).not.toHaveNoViolations();
  });

  it('fails on a control with no accessible name', async () => {
    const { container } = render(<button type="button" />);
    const results = await axeCheck(container);
    expect(results.violations.map((v) => v.id)).toContain('button-name');
  });

  it('passes a component with an image that HAS alt text', async () => {
    /** The other half: a harness that fails on everything is as useless as one that fails on nothing. */
    const { container } = render(<img src="/x.png" alt="a chart of results" />);
    const results = await axeCheck(container);
    expect(results.violations.map((v) => v.id)).not.toContain('image-alt');
  });
});

describe('THE EXCLUSIONS ARE EXPLICIT, AND THIS IS THE FILE THAT PROVES IT', () => {
  it('disables exactly one rule, and that one is `color-contrast`', () => {
    /**
     * **THE EXCLUSION IS ASSERTED SO IT CANNOT GROW QUIETLY.** `color-contrast` is off because jsdom has no layout engine
     * and no font stack — a contrast check here can only produce a false answer, and a green tick that means nothing is
     * worse than no check.
     *
     * If someone disables a second rule, this test fails and the reason has to be written down. That is the whole
     * mechanism: **an exclusion is a decision, and a decision should cost something to make.**
     */
    const source = readSource();
    const disabled = [...source.matchAll(/^\s*'([a-z-]+)':\s*\{\s*enabled:\s*false\s*\}/gmu)].map(
      (m) => m[1],
    );
    expect(disabled).toEqual(['color-contrast']);
  });

  it('and `color-contrast` really is unavailable in this environment rather than merely switched off', async () => {
    /**
     * A verification that the rule cannot pass here, so a future change to jsdom or to the config would be visible. If
     * axe ever DOES report contrast violations in this environment, the exclusion can be reconsidered on evidence.
     */
    const { container } = render(
      <p style={{ color: '#eee', background: '#fff' }}>white on white</p>,
    );
    /**
     * THE DEFAULT OPTIONS, NOT `withRulesDisabled` — and the TYPE said so first.
     *
     * `SuppressedRule` is the three STRUCTURAL rules axe fires on a fragment (`region`, `page-has-heading-one`,
     * `html-has-lang`). `color-contrast` is not one of them: it is off in the harness's own `RUN_OPTIONS`, so passing it
     * to the escape hatch was asking for a rule the harness had already disabled. **The compiler caught the confusion,
     * which is the escape hatch's type doing exactly its job.**
     */
    const results = await axeCheck(container);
    expect(results.violations.map((v) => v.id)).not.toContain('color-contrast');
  });
});

describe('WHAT THIS FILE SAYS IT DOES NOT COVER', () => {
  it('component-level axe cannot see focus order, live regions, or traps — and says so', () => {
    /**
     * **A HARNESS THAT OVERSTATES ITSELF IS WORSE THAN NONE.** Component-level axe catches roughly a third of WCAG
     * issues, and none of the ones most likely to strand a student during an exam: focus order across a route, a live
     * region that announces too much, a sticky element covering a focused control, a keyboard trap that only exists
     * after a state change.
     *
     * Asserted against the harness's own documentation because the claim is about what the tool is — and the fix is
     * that the words have to be true before they are believable.
     */
    const source = readSourceRaw();
    expect(source).toMatch(/P13-T9/);
    expect(source).toMatch(/focus order/);
    expect(source).toMatch(/keyboard trap/);
    expect(source).toMatch(/floor, not the standard/);
  });

  it('the harness does NOT import `@axe-core/vitest`, so there is one rule vocabulary', () => {
    const source = readSource();
    expect(source).not.toContain('@axe-core/vitest');
    /** Rule ids are what a suppression and a CI log both speak; two libraries would mean two vocabularies. */
    expect(source).toContain('jest-axe');
  });
});

/** The RAW source, for claims about what the documentation itself says. */
const readSourceRaw = (): string => readFileSync(join(process.cwd(), 'src/test/axe.ts'), 'utf8');

/**
 * THE HARNESS'S OWN SOURCE, COMMENTS STRIPPED.
 *
 * Two of these claims are about the file rather than about behaviour, and reading the file is the only way to check them.
 *
 * **COMMENTS ARE REMOVED HERE, ONCE, AND THAT IS THE FOURTH TIME THIS SESSION A SOURCE ASSERTION HAS MATCHED PROSE.**
 * `expect(source).not.toContain('@axe-core/vitest')` failed against the harness's own comment explaining *why* it does not
 * use that package. The earlier three were the CSP fallback, `receipt.ts`'s `===` rule, and `verdict-decision.ts`'s
 * mention of `prisma.update` -- each fixed at the assertion, each time by hand.
 *
 * **So the fix belongs HERE rather than in each assertion.** Stripping once means a future assertion in this file cannot
 * fail for a reason that has nothing to do with the code, and it means nobody is tempted to delete the explanation to make
 * a test pass -- **an assertion a reviewer can satisfy by rewording a comment is not checking the code, and the
 * explanation is worth more than the assertion.**
 */
function readSource(): string {
  const raw = readFileSync(join(process.cwd(), 'src/test/axe.ts'), 'utf8');
  return raw
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

/** `axe-core` is imported for its side-effect-free type surface; this line keeps the import honest about being used. */
export const AXE_VERSION: string = axe.version;

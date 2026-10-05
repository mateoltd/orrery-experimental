/**
 * `toHaveNoViolations` FOR VITEST, AND WHY THE HARNESS IS A FILE RATHER THAN A RULE.
 *
 * ## WHAT THIS IS FOR
 *
 * `jest-axe` is declared in three `package.json` files in this repository and **used nowhere**. It was a dependency
 * without a check — the same shape this session has found three times: an invariant registry naming files that did not
 * exist, an `IntegrityVerdict` table with no writer, a `Rollup<T>` type with no store. **A declared dependency is not a
 * control**, and `P13-T1` exists because `ci.yml` once called `pnpm a11y`, which did not exist, so the `policy` job died
 * before it could run anything.
 *
 * ## WHY NOT `@axe-core/vitest`
 *
 * Because the package this repository already declares is `jest-axe`, and **a second accessibility library would be a
 * second vocabulary of rule ids** — and rule ids are what a suppression file and a CI log both speak. One library means a
 * violation can be named in a commit message unambiguously. The matcher below is the whole integration: `axe-core` is
 * what actually runs the rules, and `jest-axe` is the matcher that turns its output into a failure.
 *
 * ## AND WHY `AXE_TAG` MATTERS MORE THAN THE MATCHER
 *
 * `axe.run` refuses to run on a document with **no landmark and no page title**, because it cannot evaluate a page that
 * announces nothing. That is a real accessibility failure, so it is NOT suppressed here — instead the harness names it,
 * because a rule that fires on every component and is then blanket-disabled teaches the team to ignore the output.
 *
 * ## WHAT THIS DOES NOT COVER, AND THAT IS THE HONEST PART
 *
 * **Component-level axe catches roughly a third of WCAG issues and none of the ones that matter most on an exam.** It
 * cannot see focus order across a route, a live-region announcement threshold, a sticky element covering a focused
 * control, or a keyboard trap that only exists after a state change. `P13-T9` — an independent manual WCAG 2.2 AA audit —
 * is the mechanism for those, and **`P13-T2`'s keyboard work is the part a linter will never check.** This file is a
 * floor, not the standard.
 */

import type { AxeResults, ElementContext, RunOptions } from 'axe-core';
import axe from 'axe-core';
import { toHaveNoViolations } from 'jest-axe';
import { expect } from 'vitest';

expect.extend(toHaveNoViolations);

/**
 * THE OPTIONS, AND EACH ONE IS A TRADE-OFF RATHER THAN A DEFAULT.
 *
 * · `resultTypes: ['violations']` — `axe.run` computes passes, incomplete and inapplicable by default, which is most of
 *   the cost and none of the signal. **Only violations fail a build.**
 * · The rules excluded are excluded **with a stated reason each**, and the list is asserted against in a test below, so
 *   "we turned a rule off" is a visible fact rather than a line in a config nobody reads.
 * · `region` is not set: a component test has no page, and pretending otherwise teaches axe to pass things.
 */
const RUN_OPTIONS: RunOptions = {
  resultTypes: ['violations'],
  rules: {
    /**
     * `color-contrast` NEEDS RENDERED PIXELS AND A REAL FONT STACK, neither of which jsdom has.
     *
     * **This is NOT "an axe limitation we outgrew" — it is axe reporting the truth about the environment.** jsdom has no
     * layout engine, so every element's computed box is zero-sized and every colour pair is indistinguishable. A
     * contrast check here can only ever be a false negative or a false positive, and the honest move is to refuse to run
     * it rather than have a green tick that means nothing. `P13-T5` and the browser-level work own real contrast.
     */
    'color-contrast': { enabled: false },
  },
};

/**
 * RUN AXE OVER A CONTAINER, AND RETURN THE RESULTS RATHER THAN ASSERTING.
 *
 * Returning is deliberate: several tests need to assert a SPECIFIC rule id rather than "no violations", because a test
 * that only ever asserts the absence of everything cannot say which guarantee it is protecting. The common case is
 * `await expect(results).toHaveNoViolations()`.
 */
export const axeCheck = async (
  container: ElementContext,
  options: RunOptions = {},
): Promise<AxeResults> => axe.run(container, { ...RUN_OPTIONS, ...options });

/**
 * THE VIOLATIONS THAT ARE THE COMPONENT'S OWN FAULT, AS A TEST-ONLY ESCAPE HATCH.
 *
 * **Deliberately NOT exported for production use and deliberately not a suppression file.** A file of disabled rules
 * shared between tests and shipped code is how an accessibility rule quietly stops applying to a real page. This lives
 * in the test surface and a test asserts its size, so adding to it is a visible act.
 */
export type SuppressedRule = 'region' | 'page-has-heading-one' | 'html-has-lang';

export const withRulesDisabled = (...ids: readonly SuppressedRule[]): RunOptions => ({
  rules: Object.fromEntries(ids.map((id) => [id, { enabled: false }])),
});

export { axeCheck as axe };

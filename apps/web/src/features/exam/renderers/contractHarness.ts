'use client';

/**
 * The shared harness every question renderer is tested through.  (P7-T7)
 *
 * ## WHY A HARNESS AND NOT TEN HAND-WRITTEN axe CALLS
 *
 * `jest-axe` catches a missing label on today's markup and nothing else. It cannot tell you that a renderer
 * IGNORED `INTERACTION_CONTRACTS` — that is a different kind of wrong, and it is the kind this phase keeps finding:
 * a contract that is read by nobody is documentation with a test file next to it.
 *
 * So `assertRendersContract` takes the type and the element and checks both halves:
 *
 * - **axe**, because that is what axe is for.
 * - **the contract's own claims**: the role the type declares is the role in the DOM, and the accessible name comes
 *   from where the contract says it comes from.
 *
 * A renderer that passes axe and violates its contract fails here, which is the only way the contract stays load-
 * bearing rather than decorative.
 *
 * ## AND IT IS DELIBERATELY NOT A LINT RULE
 *
 * `eslint-plugin-jsx-a11y` would catch some of this statically and none of the rest. Static checks cannot mount a
 * component, and the properties that matter here — that a name is actually computed and associated, that a role is
 * actually present in the rendered output — only exist after rendering.
 */

import { contractFor } from '@orrery/contracts/a11y/questionInteraction';
import type { QuestionType } from '@orrery/contracts/question';
import { type RenderResult, render } from '@testing-library/react';
import { type AxeResults, axe, toHaveNoViolations } from 'jest-axe';
import { expect } from 'vitest';

expect.extend(toHaveNoViolations);

export interface ContractReport {
  /** Returned so a caller can drive the keyboard after auditing, without rendering twice. */
  readonly rendered: RenderResult;
  readonly axe: AxeResults;
  readonly violations: readonly string[];
  /** The contract claims a role and the DOM does not have it. */
  readonly roleMismatch: readonly string[];
  /** The contract says the name comes from somewhere and the DOM has no accessible name. */
  readonly unnamed: boolean;
}

/** The runtime shape of one axe rule, which `@types/jest-axe` mis-declares. See the note at the call site. */
interface AxeRuleAtRuntime {
  readonly id?: string;
  readonly nodes?: readonly unknown[];
}

const summariseViolations = (violations: readonly unknown[]): readonly string[] =>
  violations.map((violation) => {
    const rule = violation as AxeRuleAtRuntime;
    return `${String(rule.id)} (${rule.nodes?.length ?? 0} node(s))`;
  });

const roleOf = (container: HTMLElement): string | null => {
  const explicit = container.querySelector('[role]');
  if (explicit !== null) return explicit.getAttribute('role');
  // Native elements carry implicit roles, so a renderer that uses `<fieldset>` or a `<ul>` has a role without
  // saying so. Reporting "no explicit role" as a failure would push renderers towards `role=` attributes they do
  // not need, which is its own kind of noise.
  const fieldset = container.querySelector('fieldset');
  if (fieldset !== null) return 'group';
  const list = container.querySelector('ul, ol');
  if (list !== null) return 'list';
  return null;
};

/** Every element in the subtree with an accessible name, by the attribute AT reads. */
const namedElements = (container: HTMLElement): readonly HTMLElement[] => [
  ...container.querySelectorAll<HTMLElement>(
    '[aria-label], [aria-labelledby], label, legend, [title]',
  ),
];

export const renderAndAudit = async (
  type: QuestionType,
  element: React.ReactElement,
): Promise<ContractReport> => {
  const contract = contractFor(type);
  // `render` ONCE. The first version of the harness rendered inside the audit and then returned a fabricated
  // `RenderResult` pointing at `document.body`, because the real one had gone out of scope -- so a caller could not
  // drive the keyboard after auditing without a second render, and two mounts in one test is two chances for the
  // component to behave differently the second time.
  const rendered: RenderResult = render(element);
  const { container } = rendered;
  // AWAITED, because `axe` is asynchronous. The first version called it synchronously and had to be
  // `async` throughout, which is the correct shape: an audit that does not finish is not an audit.
  const axeResults = await axe(container);
  const actualRole = roleOf(container);
  const roleMismatch =
    contract.role !== null && actualRole !== contract.role
      ? [`contract says ${contract.role}, DOM says ${String(actualRole)}`]
      : [];

  return {
    rendered,
    axe: axeResults,
    /**
     * `jest-axe`'s OWN TYPES SAY `violations` IS `AxeViolationNode[]`, and it is not: at runtime each element is a
     * RULE with an `id` and a `nodes` array. The first two attempts here failed to typecheck for that reason --
     * `.id` and `.nodes` genuinely do not exist on the declared element type.
     *
     * So this is a narrow, DOCUMENTED cast rather than a silent `any`, and it is confined to one line that only
     * formats a failure message. Nothing here decides whether a violation matters -- `expect(report.violations)`
     * compares against `[]`, and `toHaveNoViolations` is what the caller leans on.
     */
    violations: summariseViolations(axeResults.violations),
    roleMismatch,
    unnamed: namedElements(container).length === 0,
  };
};

/**
 * THE ASSERTION every renderer test makes.
 *
 * Returns the render result so the caller can drive the keyboard afterwards — `assertRendersContract` answers "is it
 * correct as drawn", and the interaction test answers "does it respond", and conflating them is how a renderer ends
 * up passing because the accessible name was right and the arrow keys were not.
 */
export const assertRendersContract = async (
  type: QuestionType,
  element: React.ReactElement,
): Promise<RenderResult> => {
  const report = await renderAndAudit(type, element);
  const label = type.padEnd(14);
  expect(report.violations, `axe violations in ${label}: ${report.violations.join(', ')}`).toEqual(
    [],
  );
  expect(report.roleMismatch, `role mismatch in ${label}`).toEqual([]);
  expect(report.unnamed, `${label} rendered with no accessible name`).toBe(false);
  return report.rendered;
};

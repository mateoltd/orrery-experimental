'use client';

/**
 * The harness the grading components are tested through.  (P9-T2)
 *
 * `features/exam/renderers/contractHarness.ts` established the pattern and this follows it: `axe` on its own catches a
 * missing label on today's markup and nothing else, so the audit is paired with a check of what the component
 * DECLARES about itself. There the declaration is `INTERACTION_CONTRACTS`, keyed by question type. A marking screen
 * is not a question type, so the declaration here is `WORKSPACE_PANES` -- the regions the workspace promises, by
 * accessible name -- and `assertPanes` checks each one is in the DOM as a named region, in the promised order.
 *
 * Names are computed by Testing Library's `getByRole`, not read off an attribute. An `aria-labelledby` that points
 * at an id nobody rendered has the attribute and no name, and that is the failure an attribute scan cannot see.
 */

import { type RenderResult, render, within } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';
import { expect } from 'vitest';

expect.extend(toHaveNoViolations);

/** The runtime shape of one axe rule. `@types/jest-axe` mis-declares it; see `contractHarness.ts`. */
interface AxeRuleAtRuntime {
  readonly id?: string;
  readonly nodes?: readonly unknown[];
}

/** RENDER ONCE, audit, and hand the result back so the caller can drive the keyboard on the same mount. */
export const renderAudited = async (element: React.ReactElement): Promise<RenderResult> => {
  const rendered = render(element);
  await assertAccessible(rendered.container);
  return rendered;
};

/** Run axe on what is there NOW. Called again after an interaction, because a state can be reachable only by one. */
export const assertAccessible = async (container: HTMLElement): Promise<void> => {
  const results = await axe(container);
  const violations = (results.violations as readonly unknown[]).map((violation) => {
    const rule = violation as AxeRuleAtRuntime;
    return `${String(rule.id)} (${String(rule.nodes?.length ?? 0)} node(s))`;
  });
  expect(violations, `axe violations: ${violations.join(', ')}`).toEqual([]);
};

/**
 * EVERY PROMISED PANE IS A NAMED REGION, IN THE PROMISED ORDER.
 *
 * Returns the regions, in order, so a test can look inside one without a second query that might match a different
 * element.
 */
export const assertPanes = (
  container: HTMLElement,
  names: readonly string[],
): readonly HTMLElement[] => {
  const regions = names.map((name) => within(container).getByRole('region', { name }));
  for (let index = 1; index < regions.length; index += 1) {
    const before = regions[index - 1];
    const after = regions[index];
    if (before === undefined || after === undefined) continue;
    // `DOCUMENT_POSITION_FOLLOWING`: `after` comes later in the document than `before`.
    const following = before.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING;
    expect(
      following,
      `"${String(names[index])}" must follow "${String(names[index - 1])}"`,
    ).not.toBe(0);
  }
  return regions;
};

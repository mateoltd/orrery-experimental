/**
 * Small accessors for the exhaustive matrix test.  (P4-T8)
 *
 * These exist so that `plan-12-matrix.test.ts` can ASSERT that the action and subject in each
 * transcribed cell are real, rather than trusting that they are. A cell naming an action that
 * does not exist would otherwise pass — `can()` would throw in development and deny quietly in
 * production, and a cell that denies because the action is a typo is indistinguishable from a
 * cell that denies correctly.
 *
 * That is the whole reason this file is separate: it is the only place in the package that knows
 * the internal shape of `MATRIX`, and a test that reaches into a private structure to check a
 * claim about a public table is a test coupled to an implementation.
 */

import { MATRIX } from '../matrix.js';
import { ACTIONS, type Action, ALL_RESOURCE_TYPES, type ResourceType } from '../types.js';

/** Every action, as a runtime array, so a test can iterate rather than enumerate. */
export const ALL_ACTIONS: readonly Action[] = ACTIONS;

/** Whether a resource type has rules written for it. */
export function isImplemented(type: ResourceType): boolean {
  return Object.hasOwn(MATRIX, type);
}

/** Whether a specific (action, type) cell exists in the matrix at all. */
export function matrixHas(action: Action, type: ResourceType): boolean {
  const rules = MATRIX[type] as Record<string, unknown> | undefined;
  if (rules === undefined) return false;
  return Object.hasOwn(rules, action);
}

export { ALL_RESOURCE_TYPES };

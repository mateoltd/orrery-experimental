/**
 * The completeness check, as a pure function.  (P1-T6 do-1, D-14, D-35)
 *
 * ## Why this is a module and not a test body
 *
 * D-14 says the totality test "must fail before and pass after" when a phase adds its types.
 * That is a claim about the CHECK, and a check that only ever runs against a complete matrix
 * has never demonstrated it can detect an incomplete one. To prove the check works it has to be
 * runnable against a deliberately broken matrix — which means it cannot live inside a `it()`.
 *
 * It also means both test files import ONE implementation. Two completeness checks, one strict
 * and one loose, is the shape that lets the strict one rot while the loose one keeps passing.
 *
 * ## It returns PAIRS, not a count
 *
 * `['Classroom/importRoster']` tells a developer which cell to write. `21` does not, and the
 * difference is the difference between a two-minute fix and an afternoon of hunting.
 */

import type { Action, ResourceType } from './types.js';

export type MatrixShape = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

/**
 * Every `(type, action)` pair with no usable rule, as `Type/action` strings.
 *
 * A cell holding something that is not a function — `null`, `{}`, a comment string — counts as
 * MISSING. A truthiness check would pass those, and a placeholder is exactly what a half-finished
 * matrix extension looks like.
 */
export function totalityGaps(
  matrix: MatrixShape,
  types: readonly ResourceType[],
  actions: readonly Action[],
): string[] {
  const gaps: string[] = [];
  for (const type of types) {
    const rules = matrix[type];
    for (const action of actions) {
      if (typeof rules?.[action] !== 'function') gaps.push(`${type}/${action}`);
    }
  }
  return gaps;
}

/**
 * Whether the claim list and the matrix agree with each other, in BOTH directions.
 *
 * Two different mistakes, so two different reports:
 *   · a type claimed but unimplemented  -> `missing`
 *   · a type implemented but unclaimed   -> `unclaimed`, which would never be audited
 */
export function claimGaps(
  matrix: MatrixShape,
  claimed: readonly ResourceType[],
): { missing: string[]; unclaimed: string[] } {
  const missing = claimed.filter((t) => matrix[t] === undefined);
  const claimedSet = new Set<string>(claimed);
  const unclaimed = Object.keys(matrix).filter((t) => !claimedSet.has(t));
  return { missing, unclaimed };
}

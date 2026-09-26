/**
 * `jest-axe` ships no types and `@types/jest-axe` is not worth a dependency for a package
 * this small. This file is AMBIENT — it has no top-level `import` on purpose.
 *
 * That is not a style preference. A `.d.ts` containing a top-level import is a MODULE, and
 * `declare module 'x'` inside a module is an AUGMENTATION of an existing module rather than a
 * declaration of a missing one, so the file silently does nothing and tsc reports the original
 * "Could not find a declaration file" error as if the declaration had never been written.
 *
 * `AxeResults` is referenced structurally rather than imported, for the same reason.
 */
/// <reference types="vitest/globals" />
/// <reference types="chai" />

declare module 'jest-axe' {
  export interface AxeViolationNode {
    html: string;
    target: string[];
    failureSummary: string;
  }
  export interface AxeResults {
    violations: AxeViolationNode[];
    passes: unknown[];
    incomplete: unknown[];
    inapplicable: unknown[];
    testEngine: { name: string; version: string };
    url: string;
    timestamp: string;
  }
  export function axe(
    html: Element | string,
    options?: Record<string, unknown>,
  ): Promise<AxeResults>;
  /**
   * The matchers OBJECT passed to `expect.extend`, not a bare function.
   *
   * Typed as `MatchFunction<unknown>` — vitest's own matcher type — because that is what
   * `expect.extend` structurally requires and guessing at it in a hand-written shape produced
   * three rounds of "Index signature for type 'string' is missing".
   *
   * `unknown` as the assertion type, not `any`: the point of the declaration is to make the
   * MATCHER usable, not to re-type-check the library. What we do check is the `AxeResults`
   * we hand it, which is typed at the call site in AuthPanel.test.tsx.
   */
  export const toHaveNoViolations: Record<string, MatchFunction<unknown>>;
}

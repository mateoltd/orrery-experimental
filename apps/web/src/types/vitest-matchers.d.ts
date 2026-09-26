/**
 * Custom matcher registration for vitest.
 *
 * This file is a MODULE — the top-level `import` is load-bearing, and is the opposite of the
 * rule that applies to `jest-axe.d.ts` beside it. Augmenting an existing module's exports
 * requires being a module; declaring a module that does not exist requires being ambient.
 * Getting either backwards produces a confusing error rather than an obvious one:
 *
 *   · ambient, augmenting `vitest`  -> the real exports are SHADOWED, so `describe`, `it` and
 *     `expect` all stop existing.
 *   · module, declaring `jest-axe` -> the declaration does nothing, and tsc still reports
 *     "Could not find a declaration file".
 *
 * vitest type-checks custom matchers by augmenting its own `Assertion`. Without this, every
 * `expect(await axe(...)).toHaveNoViolations()` is a type error, and the tempting fix is a
 * cast — which would discard type checking on every future accessibility assertion.
 */
import type { AxeResults } from 'axe-core';
import 'vitest';

declare module 'vitest' {
  interface Assertion<T = unknown> {
    /**
     * Passes when an axe result contains no violations.
     *
     * Typed against `AxeResults` rather than `any`, so passing the wrong thing is a compile
     * error. A matcher that accepts `any` will happily accept a string and then fail at
     * runtime with a message that says nothing about which call was wrong.
     */
    toHaveNoViolations(): void;
    toHaveNoViolations(expected: AxeResults): void;
  }
  interface AsymmetricMatchersContaining {
    toHaveNoViolations(): void;
  }
}

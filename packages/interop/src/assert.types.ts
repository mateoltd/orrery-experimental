/**
 * The compiler assertions behind `D-25`'s claim that a route leak is a compile error.  (P5-T13)
 *
 * ## WHY THIS IS A `.ts` FILE AND NOT A VITEST TEST
 *
 * There is no runtime behaviour here to observe, and a test that "checks a type" does so by
 * asserting the absence of a compile error, which needs a type-error library, which would be a new
 * dependency for one assertion. `@ts-expect-error` does the same job with no dependency and a
 * better failure mode: if the compiler ever STOPS objecting, the directive becomes unused and
 * `tsc` reports it as `TS2578`.
 *
 * So this file is deliberately not `*.test.ts`. The package's `tsconfig` excludes test files, and
 * this file has to be in the build for `tsc` to have an opinion. `pnpm run typecheck` is what runs
 * it, and `pnpm run gates` runs that. Verified on this commit: all four directives are USED, which
 * is the only evidence that the guarantee still holds — an unused one would be a red build.
 *
 * ## WHY EVERY STATEMENT IS INSIDE A NEVER-CALLED FUNCTION
 *
 * The first version probed with bare expressions (`sealed.score;`) at module scope, and ESLint
 * correctly refused them: an expression statement with no effect is not code, and a file of them is
 * a file nobody can review. Every assertion is now a `use(...)` call — an expression with an effect
 * — inside a function that is never called, because the effect we want from it is the COMPILE
 * ERROR, which happens whether or not anything runs.
 */

import type { ExportContext, Grade, ReleasedGrade, SealedGrade } from './index.js';

declare const sealed: SealedGrade;
declare const anyGrade: Grade;

/** A sink. Calling it is the point: it makes each probe a statement rather than a stray token. */
declare function _use(value: unknown): void;

/** Never called. If this ever returns, the boundary has a hole in it. */
function _theCompilerStillRefuses(): unknown[] {
  // 1. THE HEADLINE. The sealed arm has no score field to omit, so there is nothing to forget to
  //    remove. A reviewer looking for a leak here is looking for a field that does not exist.
  // @ts-expect-error Property 'score' does not exist on type 'SealedGrade'.
  _use(sealed.score);

  // 2. Reading a score without narrowing is an error, because the union discriminates on `state`.
  //    This is what stops a formatter doing `grade.score ?? null` and shipping a `null` that tells
  //    a student "there is a score and it happens to be zero".
  // @ts-expect-error Property 'score' does not exist on type 'Grade'.
  _use(anyGrade.score);

  // 3. `SEALED` cannot be constructed with a score, even in one object literal.
  // @ts-expect-error Object literal may only specify known properties, and 'score' does not exist in type 'SealedGrade'.
  const forgedSealed: Grade = { state: 'SEALED', receipt: sealed.receipt, score: 0 };

  // 4. `ExportContext.grade` takes a `ReleasedGrade`, so a sealed one cannot be passed by
  //    accident — the argument type has no sealed arm to fall into. The directive sits on the
  //    PROPERTY, not the declaration: the error is reported where the bad value is, and a
  //    directive above `const` reads as unused.
  const exportContext: ExportContext = {
    kind: 'LTI_PLATFORM',
    binding: { externalId: 'e', localType: 'User', localId: 'u', tenantId: null },
    items: [],
    // @ts-expect-error Type 'Grade' is not assignable to type 'ReleasedGrade | undefined'.
    grade: anyGrade,
  };

  // 5. The honest path is a CHECK, not a cast, and it is worth being explicit that the obvious
  //    ternary does not work:
  //
  //        anyGrade.state === 'RELEASED' ? anyGrade : sealed   // ReleasedGrade | SealedGrade
  //
  //    The discriminator narrows the true branch, and the else branch then widens the whole
  //    expression back to the union. So this compiles only with an `if`, and that is the reason
  //    `assertGradeIsExportable` exists as a function rather than as a type guard callers have to
  //    get right — a `as ReleasedGrade` would have compiled happily and been the actual leak.
  const narrowed: unknown[] = [];
  if (anyGrade.state === 'RELEASED') {
    const released: ReleasedGrade = anyGrade;
    narrowed.push(released);
  } else {
    const stillSealed: SealedGrade = anyGrade;
    narrowed.push(stillSealed);
  }

  return [forgedSealed, exportContext, ...narrowed];
}

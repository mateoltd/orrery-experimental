/**
 * The DOM-FREE entry point.  (`INV-SIM-2`)
 *
 * ## THIS FILE EXISTS SO THE BOUNDARY IS A MODULE AND NOT A CONVENTION
 *
 * `B14`: the esbuild metafile asserts that a grader bundle imports only `@orrery/sim-sdk` and ZERO
 * Node builtins. A metafile assertion catches a *build*, not an author, and only after the author has
 * already written the DOM call.
 *
 * So the split is a module boundary: a sim's grader imports THIS, and this file's transitive
 * closure cannot reach `document`, `window` or a Node builtin, because none of its imports have
 * them. `grader-half.test.ts` asserts the closure, by reading this file's own import graph rather
 * than by trusting the comment.
 *
 * Nothing here touches the DOM, reads a clock, or uses unseeded randomness. `defineSim` validates a
 * declaration when it is called, which is a pure check.
 */

export type {
  BrowserHalf,
  GraderHalf,
  RenderContext,
  SimAccessibility,
  SimControls,
  SimDefinition,
  SimMeta,
  SimModule,
} from './define.js';
export { createRng, defineSim, gradeStoredState } from './define.js';
export * from './grading.js';
export * from './params.js';
export * from './protocol.js';
export * from './state.js';

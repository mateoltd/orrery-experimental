/**
 * `@orrery/sim-sdk` — what a simulation author imports.
 *
 * Deliberately small, and readable in ten minutes. The pure half is re-exported from `./grader`, and
 * an author writing a grader imports THAT rather than this — see the note there for why the boundary
 * is a module and not a convention.
 *
 * `RN-07`: zero runtime dependencies, because a decade-old bundled jQuery becomes a strategic liability
 * and there is no per-sim install to upgrade it. The one dependency is a WORKSPACE package that itself
 * has none, and `sdk.test.ts` asserts the transitive closure of third-party code is empty.
 */

export * from './a11y.js';
export * from './bridge.js';
export * from './define.js';
export * from './grading.js';
export * from './params.js';
export * from './protocol.js';
export * from './state.js';
export * from './stepper.js';

/**
 * `@orrery/sim-sdk` — what a simulation author imports.
 *
 * Deliberately small, and readable in ten minutes. The pure half is re-exported from `./grader`, and
 * an author writing a grader imports THAT rather than this — see the note there for why the boundary
 * is a module and not a convention.
 */

export { announce, createFocusTrap, describeControl, prefersReducedMotion } from './a11y.js';
export { createHostBridge } from './bridge.js';
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
export { createStepper } from './stepper.js';

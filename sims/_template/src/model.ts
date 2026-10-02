/**
 * The model. Pure. No DOM, no clock, no unseeded randomness.
 *
 * ## THIS FILE IS WHERE THE SUBSTANCE IS
 *
 * `plans/10` §4.1: `INV-SIM-2` is what makes a simulation an exam question graded by a server with no
 * browser involved. It only works if the physics is here and nowhere else, because both the browser
 * bundle and the grader bundle import it, and the build refuses a grader that reaches a DOM global.
 *
 * So: if you are about to write `document` or `window` in this file, the code belongs in `browser.ts`.
 */

/** The parameters, as the host delivers them after clamping. */
export interface ModelParams {
  readonly value: number;
}

/** The state. JSON-serialisable, and checked by `validateState`. */
export interface ModelState {
  readonly t: number;
}

export interface ModelPoint {
  readonly x: number;
  readonly y: number;
}

export const initialState = (): ModelState => ({ t: 0 });

export const MAX_TIME = 10;

/** The whole model, as a function of time. Pure, so the canvas and the server agree exactly. */
export function simulate(params: ModelParams, _state: ModelState, t: number): ModelPoint {
  // REPLACE THIS. Whatever the simulation IS.
  return { x: params.value * t, y: params.value * t * 0.5 };
}

/** The expected answer, derived from the parameters rather than hard-coded. */
export function expected(params: ModelParams): number {
  return simulate(params, initialState(), MAX_TIME).x;
}

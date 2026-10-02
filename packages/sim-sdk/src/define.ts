/**
 * `defineSim`, and the split that makes dual-target grading possible.  (P6-T3)
 *
 * ## THE TYPE SPLIT IS THE WHOLE OF `INV-SIM-2`
 *
 * `defineSim` returns TWO things, and the type system makes it impossible to put a DOM call in the
 * wrong one:
 *
 *  - `grader` — takes `(state, params, answer)` and returns a `Grade`. Its parameter types contain
 *    no DOM type, so a `document` reference inside it is a compile error rather than something the
 *    bundle metafile catches after it is built.
 *  - `browser` — the render layer, `void` of DOM types on purpose so it cannot accidentally be
 *    imported into a grader bundle.
 *
 * The first version had one `SimDefinition` with an optional `render`, which meant "pure" was a
 * promise in a comment and a `render` was a legal argument to the function the grader host calls.
 *
 * ## `simulate` IS DECLARED PURE BY HAVING NO WAY TO OBSERVE
 *
 * It receives `(params, state, t)` and returns a value. There is no handle, no clock, no rng. A sim
 * that needs randomness gets it from `seeded(seed)` in its browser layer, where the seed is visible,
 * rather than from a source that would make the same state produce two different papers.
 */

import { createRng, type Rng } from '@orrery/rng';
import type { Grade } from './grading.js';
import { clampParams, type ParamSpec, type ParamValues, validateParamSpecs } from './params.js';

export interface SimControls {
  /** A play/pause/step/scrub stepper. Implemented by the SDK so every one is keyboard-reachable. */
  readonly stepper: boolean;
  /** Step size in the sim's own time unit, for the stepper's step button. */
  readonly stepSize?: number;
  /** Named scenarios, which the host offers as a menu. */
  readonly scenarios: readonly string[];
  /** Continuous time from 0 to 1 by default. */
  readonly maxTime?: number;
}

export interface SimAccessibility {
  /** One sentence, in the student's terms. The host reads it aloud and shows it in print. */
  readonly textAlternative: string;
  /** A shorter description for the catalogue. */
  readonly summary: string;
  /** What a screen reader should announce when the sim is ready. */
  readonly readyAnnouncement?: string;
}

export interface SimMeta {
  readonly id: string;
  readonly title: string;
  readonly version: string;
  readonly subjects: readonly string[];
}

/** The PURE half. Every parameter here is JSON-serialisable. */
export interface GraderHalf<P extends ParamValues = ParamValues, S = unknown> {
  readonly meta: SimMeta;
  readonly params: Readonly<Record<string, ParamSpec>>;
  readonly controls: SimControls;
  readonly accessibility: SimAccessibility;
  /**
   * State -> model. Pure, so the same `(params, state, t)` gives the same answer in a browser, in
   * Node and in a conformance run three years from now.
   */
  readonly simulate: (params: P, state: S, t: number) => unknown;
  /** State + answer -> grade. The server's authority; a sim's own `gradePreview` is decorative. */
  readonly grade: (state: S, params: P, answer: unknown) => Grade;
  /** Validate a serialised state. Return `null` when it is fine. */
  readonly validateState?: (state: unknown) => string | null;
}

/** The BROWSER half. Nothing here may be imported into a grader bundle. */
export interface RenderContext<S = unknown> {
  readonly params: ParamValues;
  readonly state: S;
  readonly t: number;
  readonly rng: Rng;
  /** Emit an answer. The host records it; it is not an answer until the server has scored it. */
  reportAnswer(
    answer: unknown,
    meta?: { readonly confidence?: number; readonly explanation?: string },
  ): void;
  /** Announce something to a screen reader. Routed through a live region, never spoken directly. */
  announce(message: string): void;
  /** Push an unsolicited state checkpoint, debounced by the HOST. */
  checkpoint(state: S): void;
  /** Set the sim's intrinsic size, so the frame can resize without a `ResizeObserver` fight. */
  requestHeight(height: number): void;
}

/**
 * The browser half. `P` was a parameter of this interface and was never used by it, which is a lie
 * about the relationship: the render layer receives params through `RenderContext`, not as a type
 * parameter. A type parameter nobody reads is one more thing to keep in step.
 */
export interface BrowserHalf<S = unknown> {
  readonly render: (ctx: RenderContext<S>) => void;
  /** Called once with the `sim:init` params and seed. */
  readonly mount?: (ctx: RenderContext<S>) => void;
  readonly unmount?: () => void;
}

export interface SimDefinition<P extends ParamValues = ParamValues, S = unknown>
  extends GraderHalf<P, S>,
    BrowserHalf<S> {}

export interface SimModule<P extends ParamValues = ParamValues, S = unknown> {
  /** The pure half, safe to import in Node with no DOM present. */
  readonly grader: GraderHalf<P, S>;
  /** The browser half. Importing THIS in Node is a mistake, and the type system says so. */
  readonly browser: BrowserHalf<S>;
}

/**
 * Declare a simulation.
 *
 * ## THE CHECKS RUN HERE RATHER THAN IN A TEST
 *
 * `defineSim` is called at module load, so a malformed declaration fails on the FIRST import — in the
 * conformance run, in the validator, in a student's browser — rather than when somebody notices the
 * slider does nothing. The alternative is a `validate()` call that an author can forget, and a
 * forgotten validation is the same as no validation.
 *
 * ## `params` DEFAULTS ARE NOT TRUSTED EITHER
 *
 * A declared default outside its own range is a bug in the declaration, so it throws here rather than
 * being clamped later: a sim that starts in a state the author never wrote is a support ticket.
 */
export function defineSim<P extends ParamValues = ParamValues, S = unknown>(
  definition: SimDefinition<P, S>,
): SimModule<P, S> {
  const problems = validateParamSpecs(definition.params);
  if (problems.length > 0) {
    throw new Error(
      `INVALID_PARAM_DECLARATION in ${definition.meta.id}: ${problems
        .map((p) => `${p.name} — ${p.message}`)
        .join('; ')}`,
    );
  }
  if (definition.accessibility.textAlternative.trim().length < 20) {
    throw new Error(
      `WEAK_TEXT_ALTERNATIVE in ${definition.meta.id}: the text alternative is shorter than 20 ` +
        'characters. A student with the sim blocked by a school firewall, or printed to a worksheet, ' +
        'gets nothing else.',
    );
  }
  if (definition.accessibility.summary.trim().length < 20) {
    throw new Error(
      `WEAK_SUMMARY in ${definition.meta.id}: the summary is shorter than 20 characters`,
    );
  }
  if (!Number.isInteger(definition.meta.id.length) || definition.meta.id.trim() === '') {
    throw new Error(`MISSING_SIM_ID: every sim needs an id`);
  }
  const maxTime = definition.controls.maxTime;
  if (maxTime !== undefined && (!Number.isFinite(maxTime) || maxTime <= 0)) {
    throw new Error(
      `BAD_MAX_TIME in ${definition.meta.id}: maxTime must be a positive finite number`,
    );
  }
  // A stepper needs a RANGE, which is `maxTime` -- and nothing about `scenarios`. The first version
  // tested `scenarios.length === 0 && stepper` while the message talked about `maxTime`, so every
  // stepper sim with no scenarios was refused and every stepper sim WITH scenarios and no maxTime was
  // accepted. A condition and its message disagreeing is the signature of a check nobody ran.
  if (definition.controls.stepper && maxTime === undefined) {
    throw new Error(
      `STEP_WITHOUT_TIME in ${definition.meta.id}: the stepper is enabled but maxTime is not set, ` +
        'so the scrubber has no range to scrub. Scenarios are unrelated and may be empty.',
    );
  }
  if (definition.controls.stepSize !== undefined && definition.controls.stepSize <= 0) {
    throw new Error(`BAD_STEP_SIZE in ${definition.meta.id}: stepSize must be positive`);
  }

  const grader: GraderHalf<P, S> = {
    meta: definition.meta,
    params: definition.params,
    controls: definition.controls,
    accessibility: definition.accessibility,
    simulate: definition.simulate,
    grade: definition.grade,
    ...(definition.validateState === undefined ? {} : { validateState: definition.validateState }),
  };
  const browser: BrowserHalf<S> = {
    render: definition.render,
    ...(definition.mount === undefined ? {} : { mount: definition.mount }),
    ...(definition.unmount === undefined ? {} : { unmount: definition.unmount }),
  };
  return { grader, browser };
}

/**
 * The one entry point a Node grader host is allowed to call.
 *
 * Exists so `B14`'s grader host has a single documented surface, and so the param clamping that the
 * browser does at the trust boundary also happens when the worker re-grades stored state. A grader
 * called directly with attacker-shaped params would otherwise be the one path that skips the
 * boundary.
 */
export function gradeStoredState<P extends ParamValues, S>(
  module: GraderHalf<P, S>,
  input: {
    readonly state: unknown;
    readonly params: Partial<P> | undefined;
    readonly answer: unknown;
  },
): Grade {
  const { values } = clampParams(module.params, input.params as Partial<ParamValues> | undefined);
  const declared = input.state;
  if (module.validateState !== undefined) {
    const problem = module.validateState(declared);
    if (problem !== null) {
      throw new Error(`STATE_INVALID: ${problem}`);
    }
  }
  return module.grade(declared as S, values as P, input.answer);
}

export { createRng, type Rng };
